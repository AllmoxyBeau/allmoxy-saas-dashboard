#!/usr/bin/env node
/**
 * Apply THE CHURN RULE (churn_rules.mjs) to every customer profile.
 *
 * Replaces the old cash-recency ladder ("churned" only after 12 months without a
 * payment, or a HubSpot cancel) whose departures were labelled by TODAY's status —
 * so a month's churn kept changing after the fact. Now each customer gets:
 *
 *   status        active | at_risk | non_payment (provisional lapse) | paused | churned
 *   churn_month   first un-invoiced month, set once confirmed (backdated, frozen)
 *   churn_model   { state, last_billed_month, departure_month, months_unbilled,
 *                   churn_triggers, confirms_by, pause{...} } — the audit trail
 *
 * Billing basis: invoiced (accrual_series) from accrual_reliable_from onward, the
 * monthly_history subscription series before it, and annual payers' amortized history
 * throughout — the same basis as the canonical customer base.
 *
 * Runs after build_revenue_recognition and before build_waterfall / build_customer_base.
 * Leaves alone: never_paid, explicit status overrides, duplicates, and legitimate
 * non-billing arrangements (Pre-Sale, Partnership Free).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAPSE_MONTHS, PAUSE_REVIEW_MONTHS, shift, monthsBetween } from './churn_rules.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

const PROFILES = path.join(SNAP, 'customer_profiles.json');
const snap = read(PROFILES);
const RR = read(path.join(SNAP, 'revenue_recognition.json'), {});
const SUBS = read(path.join(__dirname, 'cache/stripe_subscriptions.json'), {});
const INST = read(path.join(__dirname, 'cache/hubspot_instances.json'), {}).instances || [];
const ANNUAL = new Set((read(path.join(ROOT, 'src/data/annual_payers.json'), {}).annual_payer_ids || []).map(Number));

const FROM = RR.accrual_reliable_from || '2025-08';
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const currentMonth = todayIso.slice(0, 7);
const latestComplete = shift(currentMonth, -1);

const accrualByAid = new Map((RR.accrual_series || []).map((r) => [r.allmoxy_customer_id, r.months || {}]));

// Stripe subscription state per Stripe customer id.
const LIVE_SUB = new Set(['active', 'past_due', 'unpaid', 'trialing', 'incomplete']);
const subsByCust = new Map();
for (const s of Object.values(SUBS.by_subscription || {})) {
  if (!subsByCust.has(s.customer)) subsByCust.set(s.customer, []);
  subsByCust.get(s.customer).push(s);
}

// HubSpot Instance pause fields, joined by installer_id (sandbox instances skipped,
// same rule build_customer_profiles uses for Pay Status).
const pauseByInstaller = new Map();
for (const i of INST) {
  if (!i.installer_id || /sandbox|\bdev\b|\btest\b/i.test(i.account_name || '')) continue;
  const k = String(i.installer_id);
  const cur = pauseByInstaller.get(k);
  if (!cur || (/pause/i.test(i.status || '') && !/pause/i.test(cur.status || ''))) {
    pauseByInstaller.set(k, { status: i.status || null, start: i.payment_pause_date || null, resume: i.pause_resume_date || null });
  }
}

function billedSeries(p) {
  const s = {};
  const aid = p.allmoxy_customer_id;
  for (const [m, v] of Object.entries(p.monthly_history || {})) {
    if (m > currentMonth) continue;
    const sub = v?.subscription || 0;
    if (sub > 0 && (m < FROM || ANNUAL.has(aid))) s[m] = sub;
  }
  for (const [m, v] of Object.entries(accrualByAid.get(aid) || {})) if (m >= FROM && m <= currentMonth && v > 0) s[m] = (s[m] || 0) + v;
  return s;
}

const before = {}, after = {};
const changed = [];
const pauseFlags = [];
for (const p of snap.rows) {
  before[p.status] = (before[p.status] || 0) + 1;
  const prevStatus = p.status;
  delete p.churn_month;
  const skip = p.excluded_from_logo_count || p.status_override || p.status === 'never_paid';
  const payStatus = p.pay_status || '';
  const isPaused = /pause/i.test(payStatus);
  const legitNonBilling = /pre-?sale|partnership|free/i.test(payStatus);
  const hp = p.installer_id ? pauseByInstaller.get(String(p.installer_id)) : null;

  const series = billedSeries(p);
  const months = Object.keys(series).sort();
  const last = months[months.length - 1] || null;
  const model = { state: null, last_billed_month: last, departure_month: null, months_unbilled: 0, churn_triggers: [], confirms_by: null, pause: null };

  if (isPaused) {
    const start = hp?.start || (last ? `${shift(last, 1)}-01` : null);
    const resume = hp?.resume || null;
    const ageMonths = start ? monthsBetween(start.slice(0, 7), currentMonth) : null;
    const overdue = resume ? resume < todayIso : (ageMonths != null && ageMonths > PAUSE_REVIEW_MONTHS);
    model.pause = {
      start_date: start, resume_date: resume, months_paused: ageMonths, review_needed: overdue,
      review_reason: overdue ? (resume ? `resume date ${resume} has passed` : `paused ${ageMonths} months with no Pause Resume Date`) : null,
    };
    if (overdue && !skip) pauseFlags.push(`${p.name} (#${p.allmoxy_customer_id}) — ${model.pause.review_reason}`);
  }

  if (skip || !last) {
    // Overridden / duplicate records keep their status; a churned one still reads as churn.
    model.state = p.status === 'churned' ? 'churned' : skip ? 'not_evaluated' : 'never_billed';
    p.churn_model = model;
    after[p.status] = (after[p.status] || 0) + 1;
    continue;
  }

  if (last >= latestComplete) {
    // Still invoicing. Payment trouble is a collections issue, not churn.
    model.state = 'billing';
    if (p.status === 'churned' || p.status === 'non_payment' || p.status === 'paused') p.status = (p.failed_3mo_count > 0 || p.status === 'non_payment') ? 'at_risk' : 'active';
    if (isPaused) model.pause.conflict = 'Pay Status is "Pause Granted" but the customer is still being invoiced — update HubSpot or stop billing.';
  } else {
    const dep = shift(last, 1);
    const unbilled = monthsBetween(dep, latestComplete) + 1;
    model.departure_month = dep;
    model.months_unbilled = unbilled;
    if (isPaused) {
      model.state = 'paused';
      p.status = 'paused';
    } else if (legitNonBilling) {
      model.state = 'non_billing_arrangement';
    } else {
      const custSubs = (p.stripe_customer_ids || []).flatMap((c) => subsByCust.get(c) || []);
      if (custSubs.length && !custSubs.some((s) => LIVE_SUB.has(s.status))) model.churn_triggers.push('stripe_subscription_canceled');
      if (/cancel/i.test(payStatus)) model.churn_triggers.push('hubspot_cancelled');
      if (p.churn_reason && String(p.churn_reason).trim()) model.churn_triggers.push('hubspot_churn_reason');
      if (unbilled >= LAPSE_MONTHS) model.churn_triggers.push(`${LAPSE_MONTHS}_months_unbilled`);
      if (model.churn_triggers.length) {
        model.state = 'churned';
        p.status = 'churned';
        p.churn_month = dep;
      } else {
        model.state = 'lapsed';
        model.confirms_by = shift(dep, LAPSE_MONTHS - 1);   // last month of the window
        p.status = 'non_payment';
      }
    }
  }
  p.churn_model = model;
  if (prevStatus !== p.status) changed.push(`${p.name} (#${p.allmoxy_customer_id}): ${prevStatus} → ${p.status}`);
  after[p.status] = (after[p.status] || 0) + 1;
}

// Duplicates mirror their parent. apply_customer_status_overrides mirrored them before
// the parent's status was re-derived above, so mirror again now.
const byAid = new Map(snap.rows.map((p) => [p.allmoxy_customer_id, p]));
for (const p of snap.rows) {
  const o = p.status_override;
  if (o?.arrangement_type !== 'duplicate_of') continue;
  const parent = byAid.get(o.parent_allmoxy_customer_id);
  if (parent && parent.status !== p.status) {
    after[p.status]--;
    p.status = parent.status;
    after[p.status] = (after[p.status] || 0) + 1;
  }
}

snap.churn_rule = {
  adopted: '2026-11-09',
  lapse_months: LAPSE_MONTHS,
  pause_review_months: PAUSE_REVIEW_MONTHS,
  summary: `Churn is dated to the first month without invoiced subscription revenue and confirmed by a canceled Stripe subscription, HubSpot Cancelled / churn reason, or ${LAPSE_MONTHS} months unbilled — whichever comes first. HubSpot Pay Status "Active - Pause Granted" supersedes it (paused, never churned).`,
  pause_review: pauseFlags,
};
fs.writeFileSync(PROFILES, JSON.stringify(snap));
console.error(`[churn-model] status before ${JSON.stringify(before)}`);
console.error(`[churn-model] status after  ${JSON.stringify(after)}`);
console.error(`[churn-model] ${changed.length} status change(s)${changed.length ? ':\n  ' + changed.slice(0, 60).join('\n  ') : ''}`);
if (pauseFlags.length) console.error(`[churn-model] ${pauseFlags.length} pause(s) need CS review:\n  ${pauseFlags.join('\n  ')}`);
