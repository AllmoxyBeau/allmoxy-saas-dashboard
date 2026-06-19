#!/usr/bin/env node
/**
 * Time to Value snapshot — for every active paying customer, captures the
 * "are they getting value?" question:
 *
 *   - never_launched: paying with no Live Date AND no lifetime orders (gym member)
 *   - launched_dormant: has Live Date but zero orders this year
 *   - declining: monthly avg orders this year < 50% of prior year
 *   - healthy: launched, running orders, not declining
 *
 * The headline number is "Wasted MRR" — sum of subscription dollars paid by
 * customers who aren't (yet) realizing value. For gym members that's their
 * full lifetime; for dormant customers it's the months since they stopped.
 *
 * Output: public/snapshots/time_to_value.json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; }
function round2(n) { return Math.round((n || 0) * 100) / 100; }

const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));
const orders = readJson(path.join(SNAP, 'orders_verified.json'));
const owners = readJson(path.join(ROOT, '_etl_scripts/cache/hubspot_owners.json'));
const bidOnly = readJson(path.join(ROOT, '_etl_scripts/bid_only_customers.json'));
const bidOnlyIds = new Set(bidOnly?.bid_only_allmoxy_customer_ids || []);

function lookupOwner(profile) {
  // Prefer the Hubspot Sync Sheet's "First name" (col R) — day-to-day rep label.
  // Fall back to Company-level hubspot_owner_id when the sync sheet has no value.
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

const ordersByCustomer = new Map();
for (const [k, v] of Object.entries(orders?.by_customer || {})) ordersByCustomer.set(Number(k), v);

// All paying customers — includes status='at_risk' and customers between cycles.
// Match the Churn Risk Matrix cohort exclusions: playbook-cancelled and
// agreed pauses are not retention targets.
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
console.log(`Order data for ${ordersByCustomer.size} customers`);

const today = new Date();
const currentYear = today.getFullYear();
const priorYear = currentYear - 1;

function monthsBetween(isoDate, ref = today) {
  if (!isoDate) return null;
  const start = new Date(isoDate);
  if (Number.isNaN(start.getTime())) return null;
  const years = ref.getFullYear() - start.getFullYear();
  const months = ref.getMonth() - start.getMonth();
  return Math.max(0, years * 12 + months);
}

const customers = [];
for (const p of cohort) {
  const o = ordersByCustomer.get(p.allmoxy_customer_id);
  const monthsPaying = monthsBetween(p.first_payment_date);
  const isLaunched = !!o?.is_launched;
  const liveDateYear = o?.live_date ? Number(o.live_date) : null;
  const lifetimeOrders = o?.total_lifetime_orders || 0;
  const curMA = o?.monthly_avg_current_year || 0;
  const prevMA = o?.monthly_avg_prior_year || 0;
  // Fallback to year-level order_count when Monthly Average sheet is empty for
  // this customer. Critical: annualize the current YTD count (multiply by
  // 12/months_elapsed) so the YoY comparison is apples-to-apples with prior
  // full year. Without this, mid-year customers look like they're declining 50%
  // even when their monthly run-rate is identical.
  const curCountRaw = o?.years?.[currentYear]?.order_count;
  const curCount = curCountRaw || 0;
  const prevCount = o?.years?.[priorYear]?.order_count || 0;
  const monthsElapsed = today.getMonth() + 1;
  // 2026 order_count is null (source xlsx has $ only). When MA is available
  // use it; otherwise fall back to prev MA as a proxy rather than treating
  // unavailable as zero.
  const curOrders = curMA > 0
    ? curMA
    : (curCountRaw != null ? (curCount * 12 / monthsElapsed) : prevMA);
  const prevOrders = prevMA > 0 ? prevMA : prevCount;

  // Months to launch — if Live Date is just a year, approximate as
  // (live_date_year - first_payment_year) × 12. If first payment was the
  // same year as launch, treat as 6 months (rough midpoint).
  let monthsToLaunch = null;
  if (isLaunched && p.first_payment_date && liveDateYear) {
    const firstPayYear = Number(p.first_payment_date.slice(0, 4));
    const diff = liveDateYear - firstPayYear;
    monthsToLaunch = diff === 0 ? 6 : diff * 12;
  }
  // If they have month-level value from the orders xlsx use that instead
  if (o?.months_to_launch && typeof o.months_to_launch === 'number') {
    monthsToLaunch = o.months_to_launch;
  }

  // 5-month signup grace period: new customers haven't had time to launch
  // yet, so don't flag them as gym_member / wasted. Mirrors the churn matrix
  // grace logic. See memory: 2026-order-counts-unavailable (related: same
  // pattern of "we don't have evidence yet" for brand-new signups).
  const signUpDate = p.sign_up_date ? new Date(p.sign_up_date) : null;
  const monthsSinceSignup = signUpDate && !isNaN(signUpDate.getTime())
    ? (today.getFullYear() - signUpDate.getFullYear()) * 12 + (today.getMonth() - signUpDate.getMonth())
    : Infinity;
  const inGracePeriod = monthsSinceSignup < 5;

  // Categorize
  let category;
  let waste_label;
  let wasted_to_date = 0;
  let current_burn_annualized = (p.current_subscription_mrr || 0) * 12;
  const isBidOnly = bidOnlyIds.has(p.allmoxy_customer_id);

  if (isBidOnly) {
    category = 'bid_only';
    waste_label = 'Bid-only customer — uses Allmoxy primarily for quotes/bids that never verify as orders. Real product value, just not visible in order data.';
  } else if (!o) {
    category = 'no_data';
    waste_label = 'No verified order data on file — needs join review';
  } else if (!isLaunched && lifetimeOrders === 0 && inGracePeriod) {
    category = 'onboarding';
    waste_label = `New signup (${monthsSinceSignup} mo) — within 5-mo grace period, launch not yet expected`;
    // No "wasted" framing during grace period — they're new, not lapsed.
  } else if (!isLaunched && lifetimeOrders === 0) {
    category = 'gym_member';
    waste_label = 'Never launched, never ran a verified order';
    wasted_to_date = p.lifetime_subscription || 0;
  } else if (!isLaunched && lifetimeOrders > 0) {
    category = 'never_launched_some_orders';
    waste_label = `${lifetimeOrders} lifetime orders but no Live Date — possible partial launch / hygiene gap`;
    // Treat as fully wasted until launch confirmed
    wasted_to_date = p.lifetime_subscription || 0;
  } else if (isLaunched && curOrders === 0 && prevOrders > 0) {
    category = 'launched_dormant';
    waste_label = `Live ${liveDateYear} but zero orders in ${currentYear} YTD`;
    // Months since dormancy — proxy as months from start of current year
    const monthsDormant = today.getMonth() + 1;
    wasted_to_date = (p.current_subscription_mrr || 0) * monthsDormant;
  } else if (isLaunched && curOrders === 0 && prevOrders === 0) {
    category = 'launched_dormant';
    waste_label = `Live ${liveDateYear} but no recent order activity`;
    wasted_to_date = (p.current_subscription_mrr || 0) * 12; // 12 months as proxy
  } else if (isLaunched && prevOrders > 0 && curOrders / prevOrders < 0.5) {
    category = 'declining';
    const drop = Math.round((1 - curOrders / prevOrders) * 100);
    const fmt = (n) => curMA > 0 ? '$' + Math.round(n).toLocaleString() + '/mo' : Math.round(n).toLocaleString() + ' orders';
    waste_label = `Launched but orders down ${drop}% YoY (${fmt(curOrders)} vs ${fmt(prevOrders)})`;
    wasted_to_date = 0; // not "wasted" — they ARE getting some value, just less
  } else if (isLaunched) {
    category = 'healthy';
    waste_label = 'Launched + running orders';
    wasted_to_date = 0;
  } else {
    category = 'unknown';
    waste_label = '—';
  }

  const owner = lookupOwner(p);
  customers.push({
    allmoxy_customer_id: p.allmoxy_customer_id,
    name: p.name,
    hubspot_company_id: p.hubspot_company_id ? String(p.hubspot_company_id) : null,
    owner_id: owner.id,
    owner_name: owner.name,
    primary_segment: p.primary_segment,
    sub_segment: p.sub_segment,
    first_payment_date: p.first_payment_date,
    months_paying: monthsPaying,
    years_with_us: p.years_with_us,
    current_subscription_mrr: round2(p.current_subscription_mrr),
    lifetime_subscription: round2(p.lifetime_subscription || 0),
    // Launch + orders
    is_launched: isLaunched,
    live_date: liveDateYear,
    months_to_launch: monthsToLaunch,
    lifetime_orders: lifetimeOrders,
    monthly_avg_current_year: round2(curMA),
    monthly_avg_prior_year: round2(prevMA),
    // Value framing
    category,
    waste_label,
    wasted_to_date: round2(wasted_to_date),
    current_burn_annualized: round2(current_burn_annualized),
    has_order_data: !!o,
    is_bid_only: isBidOnly,
  });
}

// Sort attack list by wasted_to_date desc, then current_burn desc
customers.sort((a, b) => (b.wasted_to_date - a.wasted_to_date) || (b.current_burn_annualized - a.current_burn_annualized));

// Categories summary
const categoryBuckets = {
  onboarding: { label: 'Onboarding (signed up <5 mo ago, grace period)', customers: [] },
  gym_member: { label: 'Never launched (gym member)', customers: [] },
  never_launched_some_orders: { label: 'Hygiene gap (orders but no Live Date)', customers: [] },
  launched_dormant: { label: 'Launched but dormant', customers: [] },
  declining: { label: 'Declining (orders down >50% YoY)', customers: [] },
  healthy: { label: 'Healthy', customers: [] },
  bid_only: { label: 'Bid-only (uses platform for quotes)', customers: [] },
  no_data: { label: 'No order data on file', customers: [] },
  unknown: { label: 'Unknown', customers: [] },
};
for (const c of customers) categoryBuckets[c.category]?.customers.push(c);

const summaryByCategory = Object.fromEntries(
  Object.entries(categoryBuckets).map(([key, b]) => [key, {
    label: b.label,
    count: b.customers.length,
    current_mrr_sum: round2(b.customers.reduce((s, c) => s + (c.current_subscription_mrr || 0), 0)),
    wasted_to_date_sum: round2(b.customers.reduce((s, c) => s + (c.wasted_to_date || 0), 0)),
    annualized_burn_sum: round2(b.customers.reduce((s, c) => s + (c.current_burn_annualized || 0), 0)),
  }])
);

// TTV histogram — months to launch for ALL launched customers
const launchedWithTTV = customers.filter((c) => c.is_launched && c.months_to_launch != null);
const ttvSorted = launchedWithTTV.map((c) => c.months_to_launch).sort((a, b) => a - b);
const median = ttvSorted.length > 0 ? ttvSorted[Math.floor(ttvSorted.length / 2)] : null;
const p90 = ttvSorted.length > 0 ? ttvSorted[Math.floor(ttvSorted.length * 0.9)] : null;
const ttvBuckets = { '0-6mo': 0, '7-12mo': 0, '13-18mo': 0, '19-24mo': 0, '25-36mo': 0, '37+mo': 0 };
for (const m of ttvSorted) {
  if (m <= 6) ttvBuckets['0-6mo']++;
  else if (m <= 12) ttvBuckets['7-12mo']++;
  else if (m <= 18) ttvBuckets['13-18mo']++;
  else if (m <= 24) ttvBuckets['19-24mo']++;
  else if (m <= 36) ttvBuckets['25-36mo']++;
  else ttvBuckets['37+mo']++;
}

// Headline
const totalWasted = customers.reduce((s, c) => s + c.wasted_to_date, 0);
const totalBurn = customers.filter((c) => c.category !== 'healthy').reduce((s, c) => s + c.current_burn_annualized, 0);
const gymMembers = categoryBuckets.gym_member.customers.length;
const dormant = categoryBuckets.launched_dormant.customers.length;
const declining = categoryBuckets.declining.customers.length;

const out = {
  fetched_at: new Date().toISOString(),
  comment:
    'Time to Value — for each active paying customer, classifies whether they are getting product value via verified order data. Categories: gym_member (never launched, no orders), never_launched_some_orders (orders but no Live Date — hygiene), launched_dormant (Live Date but no current-year orders), declining (orders down >50% YoY), healthy (launched + running orders). "Wasted to date" = subscription $ paid without realized value. "Annualized burn" = current MRR × 12 if they never realize value going forward.',
  as_of_year: currentYear,
  cohort_size: cohort.length,
  summary: {
    total_wasted_to_date: round2(totalWasted),
    total_annualized_burn_at_risk: round2(totalBurn),
    gym_member_count: gymMembers,
    launched_dormant_count: dormant,
    declining_count: declining,
    healthy_count: categoryBuckets.healthy.customers.length,
  },
  ttv_distribution: {
    sample_size: ttvSorted.length,
    median_months: median,
    p90_months: p90,
    buckets: ttvBuckets,
  },
  by_category: summaryByCategory,
  customers,
};

const outPath = path.join(SNAP, 'time_to_value.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  Total wasted to date: $${out.summary.total_wasted_to_date.toLocaleString()}`);
console.log(`  Annualized burn at risk (non-healthy): $${out.summary.total_annualized_burn_at_risk.toLocaleString()}`);
console.log(`  Gym members: ${gymMembers} · Dormant: ${dormant} · Declining: ${declining} · Healthy: ${categoryBuckets.healthy.customers.length}`);
console.log(`  TTV median: ${median} mo · p90: ${p90} mo (n=${ttvSorted.length})`);
