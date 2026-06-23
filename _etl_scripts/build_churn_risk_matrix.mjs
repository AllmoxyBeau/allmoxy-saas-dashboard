#!/usr/bin/env node
/**
 * Churn Risk Matrix builder — applies the 5-signal health scoring model from the
 * allmoxy-monthly-dashboard skill to every active paying customer (status='active'
 * + current_subscription_mrr > 0, NOT excluded_from_logo_count).
 *
 * Signal weights (skill reference):
 *   1. Order Volume         — up to 35 pts (from orders_verified.json)
 *   2. Launch Status        — up to 25 pts (from at_risk_hubspot_signals.json)
 *   3. Engagement Recency   — up to 20 pts (notes_last_contacted)
 *   4. Explicit Risk Signals — up to -20 pts penalty (note keyword scan)
 *   5. Tenure × Launch Traj — up to -15 pts penalty (gym-member detection)
 *
 * Tier thresholds:
 *   With order data (100pt max):  red <40, yellow 40-69, green 70+
 *   Without order data (65pt max): red <25, yellow 25-44, green 45+
 *
 * Hard overrides:
 *   - hard_override_red=true → always red
 *   - never_launched + 18+ months tenure → never green
 *   - confirmed launched + active contact + no risk signals → never red
 *
 * Output: public/snapshots/churn_risk_matrix.json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
function round2(n) { return Math.round((n || 0) * 100) / 100; }

const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));
const orders = readJson(path.join(SNAP, 'orders_verified.json'));
const hubspotSignals = readJson(path.join(ROOT, '_etl_scripts/cache/at_risk_hubspot_signals.json'));
const owners = readJson(path.join(ROOT, '_etl_scripts/cache/hubspot_owners.json'));
const bidOnly = readJson(path.join(ROOT, '_etl_scripts/bid_only_customers.json'));
const bidOnlyIds = new Set(bidOnly?.bid_only_allmoxy_customer_ids || []);

function lookupOwner(profile) {
  // Prefer the Hubspot Sync Sheet's "First name" (col R) — that's the day-to-day
  // rep label the CS team uses. Fall back to the Company-level hubspot_owner_id
  // when the sync sheet has no value.
  const instance = profile?.instance_owner_first_name || profile?.instance_owner;
  if (instance && String(instance).trim()) {
    return { id: null, name: String(instance).trim(), source: 'instance_sync' };
  }
  const hubspotCompanyId = profile?.hubspot_company_id;
  if (!hubspotCompanyId || !owners) return { id: null, name: null, source: null };
  const id = owners.owner_by_hubspot_company_id?.[String(hubspotCompanyId)];
  if (!id) return { id: null, name: null, source: null };
  return { id, name: owners.owner_names?.[id] || `(owner ${id})`, source: 'hubspot_company' };
}

// All paying customers — not just status='active' with positive current MRR.
// Includes status='at_risk' (failed charges, still our customer) and customers
// between billing cycles (paid recently but $0 in latest month). Filter to
// non-churned + non-excluded + actually paid us at some point (lifetime > 0).
// Exclude:
//   - pay_status='Cancelled' (Playbook completed; decision already made)
//   - pay_status='Active - Pause Granted' (legitimate pause we agreed to;
//     not a retention target — they're in a known hold pattern)
const PAUSE_GRANTED_STATUSES = new Set(['Active - Pause Granted']);
const cohort = (profiles?.rows || []).filter((r) =>
  r.status !== 'churned' &&
  r.status !== 'never_paid' &&
  !r.excluded_from_logo_count &&
  (r.lifetime_subscription || 0) > 0 &&
  r.pay_status !== 'Cancelled' &&
  !PAUSE_GRANTED_STATUSES.has(r.pay_status)
);

console.log(`Paying customer cohort (non-churned, lifetime > 0, not playbook-cancelled, not on agreed pause): ${cohort.length} customers`);

const ordersByCustomer = new Map();
for (const [k, v] of Object.entries(orders?.by_customer || {})) ordersByCustomer.set(Number(k), v);
console.log(`Order data for ${ordersByCustomer.size} customers`);

const signalsByCustomer = new Map();
for (const [k, v] of Object.entries(hubspotSignals?.by_customer_id || {})) signalsByCustomer.set(Number(k), v);
console.log(`HubSpot signals for ${signalsByCustomer.size} customers${signalsByCustomer.size === 0 ? ' — Signals 2-5 will be zeroed' : ''}`);

// ============================================================================
// CS Health Pulse (Signal 6) — HubSpot Company-level property
// `customer_health_cs_pulse`. Values are "Green(...)" / "Yellow(...)" / "Red(...)"
// long-form strings; we extract the leading color word.
// ============================================================================
const hubspotCompanies = readJson(path.join(ROOT, '_etl_scripts/cache/hubspot_companies.json'));
const pulseByCompanyId = new Map(); // hubspot_company_id (string) → 'green'|'yellow'|'red'
for (const c of hubspotCompanies?.companies || []) {
  const raw = String(c.customer_health_cs_pulse || '');
  if (raw.startsWith('Green')) pulseByCompanyId.set(String(c.id), 'green');
  else if (raw.startsWith('Yellow')) pulseByCompanyId.set(String(c.id), 'yellow');
  else if (raw.startsWith('Red')) pulseByCompanyId.set(String(c.id), 'red');
}
console.log(`CS Health Pulse populated for ${pulseByCompanyId.size} HubSpot companies`);

const today = new Date();
const currentYear = String(today.getFullYear());
const priorYear = String(today.getFullYear() - 1);

// ============================================================================
// Signal 1: Order Volume (35 pts max)
// Uses MONTHLY AVERAGE revenue (from the Monthly Average sheet) so 2026 YTD is
// compared apples-to-apples with prior years (the xlsx prorates by months
// active in each year).
// ============================================================================
function scoreSignal1(c) {
  const o = ordersByCustomer.get(c.allmoxy_customer_id);
  if (!o) return { score: 0, label: 'no_order_data', detail: 'No verified order data on file' };

  // 5-month signup grace period: don't penalize new customers for not having
  // orders yet. Launch typically takes a few months; flagging a 2-month-old
  // customer as "gym member" is a false positive. The penalty kicks in when
  // they cross into month 5 since sign-up.
  const signUpDate = c.sign_up_date ? new Date(c.sign_up_date) : null;
  const monthsSinceSignup = signUpDate && !isNaN(signUpDate.getTime())
    ? (today.getFullYear() - signUpDate.getFullYear()) * 12 + (today.getMonth() - signUpDate.getMonth())
    : Infinity;
  const inGracePeriod = monthsSinceSignup < 5;

  // Prefer Monthly Average (apples-to-apples partial-year normalization). When
  // missing (some customers are only in the Raw Data sheet), fall back to
  // year-level order_count from Raw Data so we don't false-flag heavy users
  // as "dormant". 2026 order_count is null (source xlsx has $ only) — treat
  // as unavailable, force MA path.
  const curMA = o.monthly_avg_current_year || 0;
  const prevMA = o.monthly_avg_prior_year || 0;
  const curCountRaw = o.years?.[currentYear]?.order_count;
  const curCountAvailable = curCountRaw != null;
  const curCount = curCountRaw || 0;
  const prevCount = o.years?.[priorYear]?.order_count || 0;
  const totalLifetime = o.total_lifetime_orders || 0;

  // Use Monthly Average when BOTH years have it (apples-to-apples in $/mo).
  // If EITHER year is missing from the MA sheet (common when the MA tab hasn't
  // been refreshed for the current year — e.g. Mountain States 2026), fall back
  // to raw order counts for BOTH years so the units stay consistent. Annualize
  // the current year's partial YTD count (×12/months_elapsed) so a customer
  // doing the same orders/month as last year doesn't look like a decline.
  //
  // BUT: when current-year order_count is unavailable (2026), don't use the
  // count fallback for curVal — that would falsely zero everyone. Use MA when
  // we have it; otherwise treat as unknown (use prev-year as proxy).
  const hasBothMA = curMA > 0 && prevMA > 0;
  const monthsElapsed = today.getMonth() + 1; // 1-12, current calendar month
  const curVal = hasBothMA
    ? curMA
    : (curCountAvailable ? (curCount * 12 / monthsElapsed) : (curMA || prevMA));
  const prevVal = hasBothMA ? prevMA : prevCount;
  const usingMA = hasBothMA || !curCountAvailable;
  const fmt = usingMA
    ? (n) => '$' + Math.round(n).toLocaleString() + '/mo avg'
    : (n) => Math.round(n).toLocaleString() + ' orders';
  const fmtCur = usingMA
    ? (n) => '$' + Math.round(n).toLocaleString() + '/mo avg'
    : (n) => `${curCount.toLocaleString()} YTD (annualized ${Math.round(n).toLocaleString()})`;

  // "Never ran an order" must be dollar-aware, not count-only: 2026 order_count
  // is null (source xlsx has $ only), so a customer actively invoicing verified
  // orders has total_lifetime_orders === 0 yet clearly HAS run orders. Treat any
  // order dollars (monthly avg either year, or lifetime $) as having run — mirrors
  // Signal 2's isRunningCurrentYear. Without this, 2026-launched customers get
  // false-flagged as "gym member" and dragged to red. See orders-counts caveat.
  const hasOrderDollars = curMA > 0 || prevMA > 0 || (o.total_lifetime_usd || 0) > 0;
  const neverRanOrder = totalLifetime === 0 && !hasOrderDollars;
  if (neverRanOrder && inGracePeriod) {
    return {
      score: 0,
      label: 'grace_period',
      detail: `Signed up ${signUpDate.toISOString().slice(0, 10)} · ${monthsSinceSignup} mo since signup (within 5-mo grace — no penalty)`,
    };
  }
  if (neverRanOrder) {
    return { score: -10, label: 'gym_member', detail: 'Never ran a verified order (gym member pattern)' };
  }
  if (curVal === 0 && prevVal > 0) {
    return { score: 0, label: 'dropped_off', detail: `${fmt(prevVal)} in ${priorYear} but ZERO in ${currentYear} YTD — dropped off` };
  }
  if (curVal === 0 && prevVal === 0) {
    return { score: 0, label: 'dormant', detail: `No orders in ${priorYear} or ${currentYear} (lifetime ${totalLifetime} orders)` };
  }
  if (prevVal > 0 && curVal / prevVal < 0.5) {
    const pctDrop = Math.round((1 - curVal / prevVal) * 100);
    return { score: 15, label: 'declining', detail: `${fmtCur(curVal)} in ${currentYear} vs ${fmt(prevVal)} in ${priorYear} (-${pctDrop}%)` };
  }
  if (prevVal > 0) {
    const pctChange = Math.round((curVal / prevVal - 1) * 100);
    const signed = pctChange >= 0 ? `+${pctChange}` : `${pctChange}`;
    return { score: 35, label: 'running', detail: `${fmtCur(curVal)} in ${currentYear} (${signed}% vs ${priorYear})` };
  }
  // New-this-year customer (no prior-year baseline). Credit as fully "running"
  // only if the run-rate is non-trivial. A few $/mo of verified orders means they
  // technically ran an order (so not gym-member) but aren't a meaningfully active
  // account — score it neutral rather than green. Only in $/mo (MA) mode, where
  // the threshold is interpretable; in order-count mode the scale differs.
  const MINIMAL_ORDERS_MO = 100;
  if (usingMA && curVal > 0 && curVal < MINIMAL_ORDERS_MO) {
    return { score: 0, label: 'minimal_orders', detail: `Only ${fmt(curVal)} in ${currentYear} — minimal verified-order activity` };
  }
  return { score: 35, label: 'running', detail: `${fmtCur(curVal)} in ${currentYear}${curCountAvailable ? ` (new this year, ${curCount} orders so far)` : ' (new this year)'}` };
}

// ============================================================================
// Signal 2: Launch Status — derived from Live Date in orders xlsx (cleaner
// than the HubSpot note-scan in the original skill since Live Date is a hard
// data field).
// ============================================================================
function scoreSignal2(c) {
  const o = ordersByCustomer.get(c.allmoxy_customer_id);
  if (!o) return { score: 0, label: 'unknown', detail: 'No order data — launch status unknown' };
  // Launched = Live Date is populated. If they're also running orders today,
  // that's the strongest possible launch signal.
  const totalLifetime = o.total_lifetime_orders || 0;
  const curMA = o.monthly_avg_current_year || 0;
  const curCountRaw = o.years?.[currentYear]?.order_count;
  const curCount = curCountRaw || 0;
  const curUsd = o.years?.[currentYear]?.total_usd || 0;
  // "Running orders" check uses Monthly Average when available, then year-level
  // count, then year-level $ (since 2026 order_count is null — only $ is reliable).
  const isRunningCurrentYear = curMA > 0 || curCount > 0 || curUsd > 0;
  if (o.is_launched && isRunningCurrentYear) {
    const detail = curMA > 0
      ? `Live ${o.live_date} · actively running orders (${'$' + Math.round(curMA).toLocaleString()}/mo avg in ${currentYear})`
      : curCountRaw != null && curCount > 0
        ? `Live ${o.live_date} · actively running orders (${curCount} in ${currentYear} YTD)`
        : `Live ${o.live_date} · actively running orders ($${Math.round(curUsd).toLocaleString()} invoiced in ${currentYear})`;
    return { score: 25, label: 'launched_active', detail };
  }
  if (o.is_launched && totalLifetime > 0) {
    return { score: 18, label: 'launched_unclear', detail: `Live ${o.live_date} · ${totalLifetime} lifetime orders, current state unclear` };
  }
  if (totalLifetime > 0 && !o.is_launched) {
    return { score: 12, label: 'partial', detail: `${totalLifetime} lifetime orders but no Live Date marked — partial launch?` };
  }
  // No Live Date, no orders → not launched
  return { score: 0, label: 'not_launched', detail: 'No Live Date on file and no verified orders' };
}

// ============================================================================
// Signals 2-5: From HubSpot signals snapshot (already scored by agent)
// ============================================================================
function scoreSignals2to5(c) {
  const s = signalsByCustomer.get(c.allmoxy_customer_id);
  if (!s) return null;
  return {
    signal_2_launch: s.scores?.signal_2_launch ?? 0,
    signal_3_recency: s.scores?.signal_3_recency ?? 0,
    signal_4_risk: s.scores?.signal_4_risk ?? 0,
    signal_5_tenure: s.scores?.signal_5_tenure ?? 0,
    launch_status: s.launch_status ?? 'unknown',
    launch_evidence: s.launch_evidence ?? null,
    days_since_last_contact: s.days_since_last_contact ?? null,
    risk_signals: s.risk_signals ?? [],
    tier_override_reason: s.tier_override_reason ?? null,
    gym_member_cliff: s.gym_member_cliff ?? false,
    key_signal: s.key_signal ?? null,
  };
}

// ============================================================================
// Signal 6: CS Health Pulse (HubSpot customer_health_cs_pulse on Company)
// Heavy weight by design — this is human judgment from the CS rep that
// aggregates relationship signals the automated scoring can't see (escalations,
// executive sponsor changes, recent QBR sentiment). Not a full override —
// red Pulse alone (-25) can't single-handedly tank a healthy customer; green
// Pulse alone can't lift a struggling one. Unset = no signal (0).
// ============================================================================
function scoreSignal6(c) {
  const hsId = c.hubspot_company_id ? String(c.hubspot_company_id) : null;
  const color = hsId ? pulseByCompanyId.get(hsId) : null;
  if (!color) return { score: 0, label: 'unset', color: null, detail: 'CS Health Pulse not set in HubSpot' };
  if (color === 'green') return { score: 25, label: 'green', color: 'green', detail: 'CS Pulse: Green — in good standing, would advocate' };
  if (color === 'yellow') return { score: 0, label: 'yellow', color: 'yellow', detail: 'CS Pulse: Yellow — fair/neutral standing, likely to renew' };
  return { score: -25, label: 'red', color: 'red', detail: 'CS Pulse: Red — at risk per CS rep' };
}

// ============================================================================
// Compute per-customer score + tier
// ============================================================================
function scoreCustomer(c) {
  let s1 = scoreSignal1(c);
  // Signal 2 now comes from orders xlsx (Live Date) — was HubSpot note scan in
  // the skill but the order data has it as a hard field
  let s2FromOrders = scoreSignal2(c);
  const s2to5 = scoreSignals2to5(c);
  const isBidOnly = bidOnlyIds.has(c.allmoxy_customer_id);

  // Bid-only override: customers who use Allmoxy for bids/quotes that never
  // convert to verified orders. The order-volume signal doesn't apply — force
  // Signal 1 and Signal 2 to MAX so they're scored on engagement/tenure only.
  if (isBidOnly) {
    s1 = { score: 35, label: 'bid_only', detail: 'Marked as bid-only customer — uses Allmoxy primarily for quotes/bids; order-volume signal not applicable' };
    s2FromOrders = { score: 25, label: 'bid_only_launched', detail: 'Marked as bid-only customer — assumed launched via bid workflow' };
  }

  const hasOrderData = s1.label !== 'no_order_data';
  const hasHubspotData = !!s2to5;

  const signal_1_orders = s1.score;
  // Prefer orders-derived launch signal (hard data); fall back to HubSpot scan
  const signal_2_launch = s2FromOrders.score !== 0 || !s2to5 ? s2FromOrders.score : s2to5.signal_2_launch;
  // Signal 3 recency: silence is bad for sales pipeline / pre-launch customers,
  // but for customers who are ACTIVELY processing (orders OR bids/quotes),
  // silence = autonomous power user = health. Override to max (+20) when
  // orders are running OR when marked bid-only (they're producing bid activity
  // we don't measure in the orders xlsx but still get product value).
  let signal_3_recency = s2to5?.signal_3_recency ?? 0;
  let signal_3_override_applied = false;
  if ((s1.label === 'running' || isBidOnly) && s2to5) {
    signal_3_recency = 20;
    signal_3_override_applied = true;
  }
  const signal_4_risk = s2to5?.signal_4_risk ?? 0;
  // Signal 5 (Tenure × Launch): the signals cache scores this with launchStatus
  // hardcoded to 'unknown' because it doesn't have order data yet. Recompute
  // here using the orders-derived launch status — a customer who has launched
  // and is running orders shouldn't carry the "gym member" penalty regardless
  // of how long they've been with us. Bid-only customers also count as launched
  // (via bid workflow) since S1 and S2 are already maxed for them upstream.
  let signal_5_tenure = s2to5?.signal_5_tenure ?? 0;
  let signal_5_override_applied = false;
  const ordersInfo = ordersByCustomer.get(c.allmoxy_customer_id);
  const trulyLaunched = !!ordersInfo?.is_launched;
  if ((trulyLaunched || isBidOnly) && signal_5_tenure < 0) {
    signal_5_tenure = 0;
    signal_5_override_applied = true;
  }

  // Signal 6: CS Health Pulse (HubSpot rep judgment) — weighted heavily but
  // not as a full override. +25 / 0 / -25 for green / yellow / red.
  const s6 = scoreSignal6(c);
  const signal_6_pulse = s6.score;

  const total = signal_1_orders + signal_2_launch + signal_3_recency + signal_4_risk + signal_5_tenure + signal_6_pulse;

  // Determine tier + scoring-data status. We ALWAYS assign a tier — never
  // 'unscored' — because the page needs every cohort customer in one of the
  // three buckets. When no signal data is available, default to yellow
  // (insufficient evidence either way — not red because we have no negative
  // signals; not green because we have no positive signals).
  let tier;
  let scoring_data_status;
  if (hasOrderData && hasHubspotData) {
    scoring_data_status = 'full';
    if (total >= 70) tier = 'green';
    else if (total >= 40) tier = 'yellow';
    else tier = 'red';
  } else if (hasOrderData && !hasHubspotData) {
    scoring_data_status = 'orders_only';
    // Signal 1 (35 pts max) + Signal 2 from orders (25 pts) + tenure penalty.
    // Effective range: -25 to +60.
    if (total >= 45) tier = 'green';
    else if (total >= 20) tier = 'yellow';
    else tier = 'red';
  } else if (!hasOrderData && hasHubspotData) {
    scoring_data_status = 'hubspot_only';
    // Signals 2-5 only — 0-65 max
    if (total >= 45) tier = 'green';
    else if (total >= 25) tier = 'yellow';
    else tier = 'red';
  } else {
    // No data at all — default to yellow with a flag so the UI can show "limited data"
    scoring_data_status = 'no_data';
    tier = 'yellow';
  }

  // Hard overrides
  if (s2to5?.tier_override_reason === 'hard_override_red') tier = 'red';
  if (s2to5?.gym_member_cliff) tier = 'red';
  if (s2to5?.launch_status === 'cancelled') tier = 'red';
  // Active payer who's running orders + recent contact + no risk signals → never red.
  // BUT: don't soften when CS rep explicitly set Pulse=red — that signal beats
  // the heuristic.
  if (s1.label === 'running' && (s2to5?.days_since_last_contact ?? 999) <= 30 && signal_4_risk === 0 && s2to5?.launch_status === 'launched' && signal_6_pulse >= 0) {
    if (tier === 'red') tier = 'yellow'; // soften it
  }

  // Grace-period override: brand-new customers (signed up <5 mo ago, no orders
  // yet) shouldn't show as red just because they haven't had time to launch.
  // Without this, grace_period customers stay at score 0 and fall below every
  // red threshold. Force green so they're treated as "healthy — onboarding"
  // unless there are concrete negative signals (risk keywords, failed charges,
  // hard override red).
  const isGracePeriod = s1.label === 'grace_period';
  const hasNegativeSignals = signal_4_risk < 0
    || (c.failed_3mo_count || 0) > 0
    || s2to5?.tier_override_reason === 'hard_override_red'
    || s2to5?.gym_member_cliff
    || s2to5?.launch_status === 'cancelled'
    || signal_6_pulse < 0; // CS rep explicitly set Pulse=red — trust them over grace
  if (isGracePeriod && !hasNegativeSignals) {
    tier = 'green';
  }

  // ARR at risk: current MRR × (1 - normalized score). The lower the score, the more ARR at risk.
  // Max positive: S1 (35) + S2 (25) + S3 (20) when hubspot data present, plus
  // S6 (25) when CS Pulse is set. Used to normalize ARR at risk.
  const hasPulse = s6.color != null;
  const maxScore = (hasOrderData ? 35 : 0) + (hasHubspotData ? 45 : 0) + (hasPulse ? 25 : 0);
  const arrAtRisk = maxScore > 0 ? (c.current_subscription_mrr * 12) * Math.max(0, 1 - total / maxScore) : 0;

  // Compose a short narrative
  const narrative = [];
  if (s1.score !== 0) narrative.push(s1.detail);
  if (s2to5?.launch_status && s2to5.launch_status !== 'unknown') narrative.push(`launch: ${s2to5.launch_status}`);
  if (s2to5?.days_since_last_contact != null) {
    const days = s2to5.days_since_last_contact;
    narrative.push(
      signal_3_override_applied && days > 30
        ? `${days}d since contact (autonomous — orders running)`
        : `${days}d since contact`
    );
  }
  if ((c.failed_3mo_count || 0) > 0) narrative.push(`${c.failed_3mo_count} failed charges (3mo)`);
  if ((s2to5?.risk_signals || []).length) narrative.push(`${s2to5.risk_signals.length} risk signal(s)`);
  if (s6.color) narrative.push(`CS Pulse: ${s6.color}`);

  const owner = lookupOwner(c);
  return {
    allmoxy_customer_id: c.allmoxy_customer_id,
    name: c.name,
    hubspot_company_id: c.hubspot_company_id ? String(c.hubspot_company_id) : null,
    owner_id: owner.id,
    owner_name: owner.name,
    current_subscription_mrr: round2(c.current_subscription_mrr),
    lifetime_subscription: round2(c.lifetime_subscription || 0),
    years_with_us: c.years_with_us,
    primary_segment: c.primary_segment,
    sub_segment: c.sub_segment,
    sign_up_date: c.sign_up_date,
    failed_3mo_count: c.failed_3mo_count || 0,
    failed_3mo_amount: round2(c.failed_3mo_amount || 0),
    // Signal 1
    signal_1_orders,
    orders_label: s1.label,
    orders_detail: s1.detail,
    // Pass null through for current year — 2026 source data has $ only, no counts.
    orders_current_year: ordersByCustomer.get(c.allmoxy_customer_id)?.years?.[currentYear]?.order_count ?? null,
    orders_prior_year: ordersByCustomer.get(c.allmoxy_customer_id)?.years?.[priorYear]?.order_count || 0,
    orders_lifetime: ordersByCustomer.get(c.allmoxy_customer_id)?.total_lifetime_orders || 0,
    orders_monthly_avg_current: ordersByCustomer.get(c.allmoxy_customer_id)?.monthly_avg_current_year || 0,
    orders_monthly_avg_prior: ordersByCustomer.get(c.allmoxy_customer_id)?.monthly_avg_prior_year || 0,
    orders_yoy_pct: ordersByCustomer.get(c.allmoxy_customer_id)?.monthly_avg_yoy_pct ?? null,
    live_date: ordersByCustomer.get(c.allmoxy_customer_id)?.live_date ?? null,
    is_launched: ordersByCustomer.get(c.allmoxy_customer_id)?.is_launched ?? false,
    months_to_launch: ordersByCustomer.get(c.allmoxy_customer_id)?.months_to_launch ?? null,
    // Signals 2-5
    signal_2_launch,
    signal_2_detail: s2FromOrders.detail,
    signal_3_recency,
    signal_3_override_applied,
    signal_4_risk,
    signal_5_tenure,
    signal_5_override_applied,
    // Signal 6: CS Health Pulse (HubSpot rep judgment, +25 / 0 / -25)
    signal_6_pulse,
    pulse_color: s6.color,
    pulse_label: s6.label,
    pulse_detail: s6.detail,
    launch_status: s2FromOrders.label !== 'unknown' ? s2FromOrders.label : (s2to5?.launch_status ?? 'unknown'),
    launch_evidence: s2FromOrders.detail !== 'No order data — launch status unknown' ? s2FromOrders.detail : (s2to5?.launch_evidence ?? null),
    days_since_last_contact: s2to5?.days_since_last_contact ?? null,
    risk_signals: s2to5?.risk_signals ?? [],
    gym_member_cliff: s2to5?.gym_member_cliff ?? false,
    // Aggregate
    total_score: total,
    tier,
    arr_at_risk: round2(arrAtRisk),
    has_order_data: hasOrderData,
    has_hubspot_data: hasHubspotData,
    scoring_data_status,
    is_bid_only: isBidOnly,
    narrative: narrative.join(' · '),
  };
}

// ============================================================================
// Score the cohort + assemble the matrix
// ============================================================================
const scored = cohort.map(scoreCustomer);

// Sort by ARR at risk descending (attack list default order)
scored.sort((a, b) => b.arr_at_risk - a.arr_at_risk);

// The 3×3 matrix: tier (red/yellow/green) × MRR band (small/medium/large)
// Small: <$500/mo, Medium: $500-$1500/mo, Large: >$1500/mo
function mrrBand(mrr) {
  if (mrr < 500) return 'small';
  if (mrr < 1500) return 'medium';
  return 'large';
}

const matrix = {};
for (const tier of ['red', 'yellow', 'green', 'unscored']) {
  for (const band of ['small', 'medium', 'large']) {
    matrix[`${tier}_${band}`] = { tier, band, count: 0, mrr_sum: 0, arr_at_risk_sum: 0, customer_ids: [] };
  }
}
for (const c of scored) {
  const key = `${c.tier}_${mrrBand(c.current_subscription_mrr)}`;
  if (!matrix[key]) continue;
  matrix[key].count++;
  matrix[key].mrr_sum += c.current_subscription_mrr;
  matrix[key].arr_at_risk_sum += c.arr_at_risk;
  matrix[key].customer_ids.push(c.allmoxy_customer_id);
}
for (const k of Object.keys(matrix)) {
  matrix[k].mrr_sum = round2(matrix[k].mrr_sum);
  matrix[k].arr_at_risk_sum = round2(matrix[k].arr_at_risk_sum);
}

// Summary stats
const totals = {
  cohort_size: scored.length,
  total_mrr: round2(scored.reduce((s, c) => s + c.current_subscription_mrr, 0)),
  total_arr_at_risk: round2(scored.reduce((s, c) => s + c.arr_at_risk, 0)),
  red_count: scored.filter((c) => c.tier === 'red').length,
  yellow_count: scored.filter((c) => c.tier === 'yellow').length,
  green_count: scored.filter((c) => c.tier === 'green').length,
  unscored_count: scored.filter((c) => c.tier === 'unscored').length,
  red_mrr: round2(scored.filter((c) => c.tier === 'red').reduce((s, c) => s + c.current_subscription_mrr, 0)),
  yellow_mrr: round2(scored.filter((c) => c.tier === 'yellow').reduce((s, c) => s + c.current_subscription_mrr, 0)),
  green_mrr: round2(scored.filter((c) => c.tier === 'green').reduce((s, c) => s + c.current_subscription_mrr, 0)),
  hubspot_signals_loaded: signalsByCustomer.size > 0,
  order_data_loaded: ordersByCustomer.size > 0,
};

const out = {
  fetched_at: new Date().toISOString(),
  comment:
    '5-signal health scoring model (per allmoxy-monthly-dashboard skill) applied to all active paying customers. Signal 1 = order volume YoY (orders_verified.json). Signals 2-5 = launch, recency, risk keywords, tenure (at_risk_hubspot_signals.json). Tier thresholds adapt to which data is loaded. Matrix is 3×3 (tier × MRR band). Attack list sorted by ARR at risk descending.',
  scoring_mode: signalsByCustomer.size > 0 && ordersByCustomer.size > 0 ? 'full' : (ordersByCustomer.size > 0 ? 'orders_only' : signalsByCustomer.size > 0 ? 'hubspot_only' : 'minimal'),
  totals,
  matrix,
  customers: scored,
};

const outPath = path.join(SNAP, 'churn_risk_matrix.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  cohort: ${totals.cohort_size} · red: ${totals.red_count} · yellow: ${totals.yellow_count} · green: ${totals.green_count} · unscored: ${totals.unscored_count}`);
console.log(`  total MRR: $${totals.total_mrr.toLocaleString()} · total ARR at risk: $${totals.total_arr_at_risk.toLocaleString()}`);
console.log(`  scoring mode: ${out.scoring_mode}`);
