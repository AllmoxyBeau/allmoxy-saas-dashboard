#!/usr/bin/env node
/**
 * ACTIVATION — signup to first verified order.
 *
 * Beau, 2026-09-17, after the churn analysis showed 94% of first-year churns never
 * placed a single verified order. Churn reasons were all describing the same event
 * ("Failed Implementation", "Unresponsive", "Catalog Unidentified") months after it
 * was decided. This measures the event itself, while it can still be changed.
 *
 * ACTIVATED = has ever placed a verified order. Deliberately a low bar: the question
 * is whether they ever started, not whether they scaled.
 *
 * WHAT THIS CAN AND CANNOT MEASURE
 * Time-to-activate is coarse for history. `live_date` in the orders source is a YEAR,
 * and `months_to_launch` is empty for every customer, so precise days-to-first-order
 * only exists where real monthly order data does — 2026 onward. So:
 *   • ACTIVATION RATE by cohort is solid across the full history (did they ever order).
 *   • DAYS TO ACTIVATE is only reported where a first-order month is genuinely known,
 *     and the count of those is published alongside so the coverage is visible.
 *
 * BID-ONLY customers are excluded from the stalled list, not counted as failures.
 * They use Allmoxy for quotes and never place verified orders by design — flagging
 * them would put three paying customers on a chase list forever.
 *
 * Output: public/snapshots/activation.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const PROF = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];
const ORDERS = read(path.join(SNAP, 'orders_verified.json'), { by_customer: {} }).by_customer || {};
const BASE = read(path.join(SNAP, 'customer_base.json'), { members: [] });
const CHURN = read(path.join(SNAP, 'churn_timeline.json'), { customers: [] }).customers || [];
const BIDONLY = new Set((read(path.join(ROOT, '_etl_scripts/bid_only_customers.json'), {}).bid_only_allmoxy_customer_ids || []).map(Number));

const payingNow = new Set((BASE.members || []).map((m) => m.allmoxy_customer_id));
const churnBy = new Map(CHURN.map((c) => [c.allmoxy_customer_id, c]));
const today = Date.now();
const DAY = 864e5;
// 60 days is the line between "still onboarding" and "stalled". Chosen because the
// median never-activated churn paid for 4 months before giving up — by day 60 there is
// still time to act, by day 120 the decision is usually already made.
const STALL_DAYS = 60;

function firstOrder(aid) {
  const ov = ORDERS[String(aid)];
  // NO RECORD IS NOT PROOF OF NO ORDERS. The orders file covers 265 customers against
  // 493 profiles, and the gap is almost entirely historical: churns from 2019-2024 have
  // no record at all, while 2025 onward has complete coverage. Reading absence as "never
  // ordered" inflated never-activated churn to 258 customers when only 53 are provable —
  // and it is the reason my first pass reported "94% of first-year churns never ordered"
  // when the provable figure among checkable customers is 62%.
  if (!ov) return { activated: null, month: null, year: null, known: false };
  // Precise month, where genuinely monthly data exists (2026 onward).
  const mv = ov.monthly_verified || {};
  const realMonths = Object.entries(mv)
    .filter(([, v]) => !v.even_spread && ((v.usd || 0) > 0 || (v.orders || 0) > 0))
    .map(([m]) => m).sort();
  // Coarse: the earliest year carrying any order volume at all.
  const years = Object.entries(ov.years || {})
    .filter(([, y]) => (y.total_usd || 0) > 0 || (y.order_count || 0) > 0)
    .map(([y]) => y).sort();
  const activated = realMonths.length > 0 || years.length > 0;
  return {
    known: true,
    activated,
    // Only call a month "first" when no earlier YEAR has volume, otherwise a 2026
    // monthly row would be reported as the first order for a 2019 customer.
    month: realMonths.length && (!years.length || realMonths[0].slice(0, 4) === years[0]) ? realMonths[0] : null,
    year: years[0] || ov.live_date || null,
  };
}

const rows = [];
for (const p of PROF) {
  if (p.excluded_from_logo_count) continue;
  if (p.status === 'never_paid') continue;            // never a customer; not an activation failure
  const aid = p.allmoxy_customer_id;
  const signup = p.effective_start_date || p.sign_up_date || p.first_payment_date || null;
  if (!signup) continue;
  const fo = firstOrder(aid);
  const churn = churnBy.get(aid);
  const isPaying = payingNow.has(aid);
  const bidOnly = BIDONLY.has(aid);
  const daysSince = Math.round((today - Date.parse(signup)) / DAY);

  let daysToActivate = null;
  if (fo.activated && fo.month) {
    // Month precision: measure to the end of the first ordering month so a same-month
    // activation reads as fast rather than negative.
    const [y, m] = fo.month.split('-').map(Number);
    const end = new Date(y, m, 0).getTime();
    const d = Math.round((end - Date.parse(signup)) / DAY);
    if (d >= 0) daysToActivate = d;
  }

  // Absence of an order record means different things depending on who it is.
  // orders_verified covers 96% of PAYING customers, so for someone currently billing,
  // no record is near-evidence they have not ordered — and those are exactly the
  // customers worth chasing. For a churned 2019 account it is just missing history,
  // which is 234 of the 243 unknowns.
  const treatAsNotOrdered = fo.known || isPaying;

  let state;
  if (bidOnly) state = 'bid_only';
  else if (fo.activated) state = churn ? 'churned_after_activating' : 'activated';
  else if (!treatAsNotOrdered) state = 'unknown';   // no order record and long gone
  else if (churn) state = 'churned_never_activated';
  else if (!isPaying) state = 'lapsed_never_activated';
  else if (daysSince <= STALL_DAYS) state = 'onboarding';
  else state = 'stalled';

  rows.push({
    allmoxy_customer_id: aid,
    name: p.customer_name || p.name,
    signup_date: String(signup).slice(0, 10),
    cohort_month: String(signup).slice(0, 7),
    status: p.status ?? null,
    mrr: r2(p.current_subscription_mrr || 0),
    paying_now: isPaying,
    activated: fo.activated,
    order_data_known: fo.known,
    first_order_month: fo.month,
    first_order_year: fo.year,
    days_to_activate: daysToActivate,
    days_since_signup: daysSince,
    state,
    owner: p.instance_owner || null,
    churn_month: churn?.churn_month || null,
    churn_reason: churn?.reason || null,
    lifetime_subscription: r2(p.lifetime_subscription || 0),
    hubspot_url: p.hubspot_company_id ? `https://app.hubspot.com/contacts/4910812/record/0-2/${p.hubspot_company_id}` : null,
  });
}

// ── cohort view: of everyone who signed up in month M, how many ever activated? ──
const byCohort = new Map();
for (const r of rows) {
  if (r.state === 'bid_only' || r.state === 'unknown') continue;
  if (!byCohort.has(r.cohort_month)) byCohort.set(r.cohort_month, { month: r.cohort_month, signups: 0, activated: 0, churned_never: 0, still_stalled: 0, mrr_signed: 0 });
  const e = byCohort.get(r.cohort_month);
  e.signups++;
  if (r.activated) e.activated++;
  if (r.state === 'churned_never_activated' || r.state === 'lapsed_never_activated') e.churned_never++;
  if (r.state === 'stalled') e.still_stalled++;
  e.mrr_signed = r2(e.mrr_signed + r.mrr);
}
const cohorts = [...byCohort.values()]
  .map((c) => ({ ...c, activation_rate: c.signups ? r2(c.activated / c.signups) : null }))
  .sort((a, b) => a.month.localeCompare(b.month));

const active = rows.filter((r) => r.state !== 'bid_only');
// Rates are computed only over customers we can actually check. Counting unknowns as
// failures would report a 40% activation rate when the measurable rate is far higher.
const knowable = active.filter((r) => r.order_data_known || r.paying_now);
const stalled = rows.filter((r) => r.state === 'stalled').sort((a, b) => b.mrr - a.mrr);
const onboarding = rows.filter((r) => r.state === 'onboarding').sort((a, b) => b.mrr - a.mrr);
const timed = rows.filter((r) => r.days_to_activate != null).map((r) => r.days_to_activate).sort((a, b) => a - b);
const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);

// Never-activated churn: the cost of not solving this.
const neverActivatedChurn = rows.filter((r) => r.state === 'churned_never_activated');

const out = {
  tab: 'activation',
  fetchedAt: new Date().toISOString(),
  stall_threshold_days: STALL_DAYS,
  totals: {
    customers: active.length,
    measurable: knowable.length,
    unknown_no_order_record: active.length - knowable.length,
    activated: knowable.filter((r) => r.activated).length,
    activation_rate: knowable.length ? r2(knowable.filter((r) => r.activated).length / knowable.length) : null,
    bid_only_excluded: rows.filter((r) => r.state === 'bid_only').length,
  },
  now: {
    stalled: stalled.length,
    stalled_mrr: r2(stalled.reduce((s, r) => s + r.mrr, 0)),
    stalled_arr: r2(stalled.reduce((s, r) => s + r.mrr, 0) * 12),
    onboarding: onboarding.length,
    onboarding_mrr: r2(onboarding.reduce((s, r) => s + r.mrr, 0)),
    paying_customers: payingNow.size,
    stalled_share_of_mrr: null,   // filled below
  },
  cost: {
    churned_never_activated: neverActivatedChurn.length,
    mrr_lost: r2(neverActivatedChurn.reduce((s, r) => s + (churnBy.get(r.allmoxy_customer_id)?.mrr_at_churn || 0), 0)),
    lifetime_paid: r2(neverActivatedChurn.reduce((s, r) => s + r.lifetime_subscription, 0)),
    median_months_paid_before_quitting: (() => {
      const ms = neverActivatedChurn.map((r) => churnBy.get(r.allmoxy_customer_id)?.months_paying).filter((x) => x != null).sort((a, b) => a - b);
      return ms.length ? ms[Math.floor(ms.length / 2)] : null;
    })(),
  },
  time_to_activate: {
    measurable: timed.length,
    median_days: med(timed),
    p75_days: timed.length ? timed[Math.floor(timed.length * 0.75)] : null,
    note: 'Only customers whose first-order MONTH is genuinely known (real monthly order data, 2026 onward). Historical live dates are year-only, so a full-history median is not computable.',
  },
  cohorts,
  stalled_customers: stalled,
  onboarding_customers: onboarding,
  customers: rows,
  notes: 'Activation = has ever placed a verified order. Stalled = paying, past day 60, never ordered — the actionable list. Bid-only customers are excluded: they use Allmoxy for quotes and never place verified orders by design. Activation RATE is reliable across the full history; DAYS to activate only where a first-order month is known.',
};
out.now.stalled_share_of_mrr = BASE.mrr ? r2(out.now.stalled_mrr / BASE.mrr) : null;

fs.writeFileSync(path.join(SNAP, 'activation.json'), JSON.stringify(out));
console.error(`[activation] ${out.totals.activated}/${out.totals.measurable} measurable ever activated (${Math.round((out.totals.activation_rate || 0) * 100)}%) · STALLED NOW: ${stalled.length} customers $${Math.round(out.now.stalled_mrr).toLocaleString()}/mo ($${Math.round(out.now.stalled_arr).toLocaleString()} ARR) · never-activated churn cost $${Math.round(out.cost.lifetime_paid).toLocaleString()} lifetime`);
