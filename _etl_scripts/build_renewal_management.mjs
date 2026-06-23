#!/usr/bin/env node
/**
 * Build the per-Instance renewal-management snapshot.
 *
 * Joins:
 *   hubspot_instances.json (the new sync target — HubSpot Instance custom
 *     object type 2-39181518, ~620 rows) ×
 *   customer_profiles.json (Stripe/QB-derived per-customer financials) ×
 *   orders_verified.json (yearly + monthly $ throughput) ×
 *   churn_risk_matrix.json (health tier + 6-signal score)
 *
 * For each ACTIVE-paying Instance with a renewal date:
 *   - Resolve to an Allmoxy customer via multi-key cascade (installer_id →
 *     allmoxy_customer_id → stripe_subscription_id → stripe_company_id →
 *     normalized name). HubSpot's allmoxy_customer_id field is barely
 *     maintained on the live records, so we lean on installer_id heavily.
 *   - Parse epoch-ms renewal dates ("1738368000000") into ISO ("2025-02-01").
 *   - Compute ROI multipliers (lifetime + annualized) and a 24-month monthly
 *     trend so drop-offs are visible at a glance.
 *   - Attach health tier from churn_risk_matrix + retrospective signals
 *     (renewal_expansion_revenue, reason_s__for_no_renewal_expansion_revenue).
 *   - Classify each row's renewal action tag: Expansion / Contraction / Stable
 *     / At Risk based on combined orders-trend + health-tier signals.
 *
 * Output: public/snapshots/renewal_management.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '_etl_scripts/cache');
const SNAP = path.join(ROOT, 'public/snapshots');
const OUT = path.join(SNAP, 'renewal_management.json');

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const instances = JSON.parse(fs.readFileSync(path.join(CACHE, 'hubspot_instances.json'), 'utf8')).instances || [];
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8')).rows || [];
const ordersByCustomer = JSON.parse(fs.readFileSync(path.join(SNAP, 'orders_verified.json'), 'utf8')).by_customer || {};
const matrix = JSON.parse(fs.readFileSync(path.join(SNAP, 'churn_risk_matrix.json'), 'utf8'));
const matrixRows = matrix.rows || matrix.customers || [];
// Quotes — keyed by allmoxy_customer_id via Company association. Built on
// first use below so we can still rebuild the page when the quotes cache
// hasn't been refreshed yet.
const quotesPath = path.join(CACHE, 'hubspot_quotes.json');
const quotesRaw = fs.existsSync(quotesPath)
  ? JSON.parse(fs.readFileSync(quotesPath, 'utf8')).quotes || []
  : [];

// ---------- profile index by every plausible join key ---------------------
const byAid = new Map();
const byInstallerId = new Map();
const byStripeCompanyId = new Map();
const bySubId = new Map();
const byInstallerDir = new Map();
const byNormName = new Map();
for (const p of profiles) {
  byAid.set(String(p.allmoxy_customer_id), p);
  if (p.installer_id) byInstallerId.set(String(p.installer_id), p);
  for (const cid of (p.stripe_customer_ids || [])) byStripeCompanyId.set(cid, p);
  if (p.stripe_subscription_id) bySubId.set(p.stripe_subscription_id, p);
  for (const s of (p.all_stripe_subscription_ids || [])) bySubId.set(s, p);
  if (p.installer_directory) byInstallerDir.set(String(p.installer_directory).toLowerCase(), p);
  if (p.name) {
    const k = norm(p.name);
    if (k && !byNormName.has(k)) byNormName.set(k, p);
  }
}

const matrixByAid = new Map(matrixRows.map((r) => [r.allmoxy_customer_id, r]));

// ---------- quotes-by-customer index --------------------------------------
// Quote → Company (one-to-many possible) → allmoxy_customer_id. We map
// company ids through customer_profiles.hubspot_company_id (which already
// went through resolveHubspotCompanyId's merge-redirect + name fallback in
// build_customer_profiles), so a quote pinned to a since-merged company id
// can still attribute back.
const aidByHubspotCompanyId = new Map();
for (const p of profiles) {
  if (p.hubspot_company_id) aidByHubspotCompanyId.set(String(p.hubspot_company_id), p.allmoxy_customer_id);
}
const quotesByAid = new Map();
for (const q of quotesRaw) {
  const seenAids = new Set();
  for (const companyId of (q.associated_company_ids || [])) {
    const aid = aidByHubspotCompanyId.get(String(companyId));
    if (aid != null && !seenAids.has(aid)) {
      seenAids.add(aid);
      if (!quotesByAid.has(aid)) quotesByAid.set(aid, []);
      quotesByAid.get(aid).push(q);
    }
  }
}
// Sort each customer's quotes newest-first by last-modified date so the most
// recent quote always lands first in the rendered list.
for (const list of quotesByAid.values()) {
  list.sort((a, b) => String(b.hs_lastmodifieddate || b.hs_createdate || '').localeCompare(String(a.hs_lastmodifieddate || a.hs_createdate || '')));
}

function joinInstance(i) {
  // Cascade: installer_id (most reliable on Instance) → aid → sub_id → stripe
  // customer → installer_url subdomain → normalized name.
  if (i.installer_id && byInstallerId.has(String(i.installer_id))) return { p: byInstallerId.get(String(i.installer_id)), via: 'installer_id' };
  if (i.allmoxy_customer_id && byAid.has(String(i.allmoxy_customer_id))) return { p: byAid.get(String(i.allmoxy_customer_id)), via: 'allmoxy_customer_id' };
  if (i.stripe_subscription_id && bySubId.has(i.stripe_subscription_id)) return { p: bySubId.get(i.stripe_subscription_id), via: 'stripe_subscription_id' };
  if (i.stripe_company_id && byStripeCompanyId.has(i.stripe_company_id)) return { p: byStripeCompanyId.get(i.stripe_company_id), via: 'stripe_company_id' };
  if (i.installer_url) {
    const m = String(i.installer_url).match(/https?:\/\/([^.]+)\./i);
    if (m && byInstallerDir.has(m[1].toLowerCase())) return { p: byInstallerDir.get(m[1].toLowerCase()), via: 'installer_url' };
  }
  if (i.account_name && byNormName.has(norm(i.account_name))) return { p: byNormName.get(norm(i.account_name)), via: 'account_name' };
  return null;
}

// ---------- date parsing -------------------------------------------------
function parseHubspotDate(raw) {
  if (raw == null || raw === '') return null;
  // Epoch-ms string (HubSpot calculated-equation type)
  if (/^\d{13}$/.test(String(raw))) return new Date(Number(raw)).toISOString().slice(0, 10);
  // Epoch-ms number
  if (typeof raw === 'number' && raw > 1e12) return new Date(raw).toISOString().slice(0, 10);
  // Already ISO-ish — trim to YYYY-MM-DD
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

// Most recent COMPLETE month, expressed as "YYYY-MM". The current calendar
// month is partial (today < last day of month), so it would mislead the
// cost-ratio trend chart — subscription stays flat while orders look like
// they fell, when really only a fraction of the month is in the data. We
// drop the current month from the trend and from the drop-off comparison.
const NOW = new Date();
const _lastCompleteDate = new Date(NOW.getFullYear(), NOW.getMonth(), 0); // day 0 of current month = last day of prior month
const LAST_COMPLETE_MONTH = `${_lastCompleteDate.getFullYear()}-${String(_lastCompleteDate.getMonth() + 1).padStart(2, '0')}`;

// ---------- monthly cost-ratio trend --------------------------------------
// For each (customer, month) compute subscription $ / orders verified $.
// Orders $ source priority: orders_verified.monthly_supplement[YYYY-MM] (true
// 2026 monthly), else yearly_total / 12 (approximation for older months).
// Only complete months are included — the current calendar month is dropped
// so partial-month data can't make a customer look like they're contracting.
function buildMonthlyTrend(ov, profile) {
  if (!profile) return [];
  const mh = profile.monthly_history || {};
  const supplement = ov?.monthly_supplement || {};
  const yearlyTotals = ov?.years || {};

  // Build per-year approximation: yearly_total / 12 = avg monthly orders $.
  const yearlyAvg = {};
  for (const [yr, v] of Object.entries(yearlyTotals)) {
    yearlyAvg[yr] = (Number(v.total_usd) || 0) / 12;
  }

  // Drop any month >= the current calendar month (partial month); only show
  // complete months in the trend.
  const completeMonths = Object.keys(mh)
    .filter((m) => m <= LAST_COMPLETE_MONTH)
    .sort();
  if (completeMonths.length === 0) return [];
  const sliceN = Math.min(24, completeMonths.length);
  const window = completeMonths.slice(-sliceN);

  return window.map((m) => {
    const sub = Number(mh[m]?.subscription) || 0;
    // Prefer supplement (true monthly); fall back to yearly avg.
    const ordersDollarRaw = supplement[m];
    const orders = ordersDollarRaw != null ? Number(ordersDollarRaw) : (yearlyAvg[m.slice(0, 4)] || 0);
    // Cost ratio = what % of their verified order $ they paid us. Lower is
    // better for the customer. Only meaningful when orders > 0; otherwise we
    // can't compute "cost / orders" without dividing by zero.
    const costRatioPct = orders > 0 ? (sub / orders) * 100 : null;
    return {
      month: m,
      subscription: round2(sub),
      orders_dollars: round2(orders),
      orders_source: ordersDollarRaw != null ? 'supplement' : 'yearly_avg',
      cost_ratio_pct: costRatioPct != null ? round2(costRatioPct) : null,
    };
  });
}

// ---------- action-tag classifier ----------------------------------------
// Combine orders YoY trend + churn matrix tier into one CS-friendly tag.
function classifyAction({ ov, riskTier, isInPause }) {
  if (isInPause) return { tag: 'Paused', reason: 'pay_status: Active - Pause Granted (excluded from health)' };
  const yoyPct = ov?.monthly_avg_yoy_pct ?? null;
  if (riskTier === 'red') {
    return { tag: 'Contraction Risk', reason: 'Health tier RED — focus on retention, not expansion' };
  }
  if (yoyPct != null && yoyPct >= 0.2) {
    return { tag: 'Expansion Opportunity', reason: `Orders monthly avg +${Math.round(yoyPct * 100)}% YoY` };
  }
  if (yoyPct != null && yoyPct <= -0.2) {
    return { tag: 'Contraction Risk', reason: `Orders monthly avg ${Math.round(yoyPct * 100)}% YoY` };
  }
  if (riskTier === 'yellow') {
    return { tag: 'Watch', reason: 'Health tier YELLOW — monitor through renewal' };
  }
  return { tag: 'Stable', reason: 'Orders + health both holding' };
}

// ---------- main loop ----------------------------------------------------
const ACTIVE = new Set(['Active', 'Active - Card Failure', 'Active - Pause Granted', 'Active - Partnership Free']);
const today = new Date();
const todayMs = today.getTime();

const rows = [];
const unjoined = [];
const skippedSandbox = [];
let withRenewalDate = 0;

for (const i of instances) {
  // Filter early to keep the snapshot focused on the live renewal pipeline.
  if (!ACTIVE.has(i.status)) continue;
  // Skip sandboxes — they share customers with production instances and would
  // double-count. account_name is the cleanest tell.
  if (/sandbox|\bdev\b|\btest\b/i.test(i.account_name || '')) {
    skippedSandbox.push({ id: i.id, account_name: i.account_name });
    continue;
  }

  const join = joinInstance(i);
  if (!join) {
    unjoined.push({ id: i.id, account_name: i.account_name, installer_id: i.installer_id, status: i.status });
    continue;
  }
  const profile = join.p;
  const aid = profile.allmoxy_customer_id;
  const ov = ordersByCustomer[String(aid)] || null;
  const riskRow = matrixByAid.get(aid) || null;
  const riskTier = riskRow?.tier ?? null;

  const calculatedRenewal = parseHubspotDate(i.calculated_renewal_date);
  const manualRenewal = parseHubspotDate(i.renewal_date);
  const renewalDate = calculatedRenewal || manualRenewal;
  if (renewalDate) withRenewalDate++;

  const daysToRenewal = renewalDate
    ? Math.round((new Date(renewalDate).getTime() - todayMs) / 86400000)
    : null;

  // Cost ratio (cost as % of orders verified). Lower is better — small %
  // means the customer is paying us only a tiny fraction of the order $
  // they push through Allmoxy. Compared to the legacy "X× multiplier"
  // framing this maps directly to CFO conversations: "you're paying ~1.5%
  // of your verified order revenue for the platform that processes it."
  const lifetimeOrders = Number(ov?.total_lifetime_usd) || 0;
  const lifetimeSub = Number(profile.lifetime_subscription) || 0;
  const costRatioLifetimePct = lifetimeOrders > 0 ? round2((lifetimeSub / lifetimeOrders) * 100) : null;

  // Annualized: current ARR / current-year annualized order $
  const monthlyAvgCY = Number(ov?.monthly_avg_current_year) || 0;
  const annualizedOrders = monthlyAvgCY * 12;
  const currentMrr = Number(profile.current_subscription_mrr) || 0;
  const currentArr = currentMrr * 12;
  const costRatioAnnualizedPct = annualizedOrders > 0 ? round2((currentArr / annualizedOrders) * 100) : null;

  // Monthly trend
  const monthlyTrend = buildMonthlyTrend(ov, profile);
  // Drop-off flag: a customer's cost ratio in the most recent 3 months is
  // 25%+ HIGHER (worse) than their trailing 9-month baseline. That means
  // orders are dropping faster than subscription, so the customer is
  // paying a bigger fraction of their throughput. Leading indicator of
  // contraction risk at renewal.
  let dropoffPct = null;
  const valid = monthlyTrend.filter((m) => m.cost_ratio_pct != null);
  if (valid.length >= 6) {
    const recent = valid.slice(-3);
    const baseline = valid.slice(-12, -3);
    if (recent.length && baseline.length) {
      const recentAvg = recent.reduce((s, m) => s + m.cost_ratio_pct, 0) / recent.length;
      const baselineAvg = baseline.reduce((s, m) => s + m.cost_ratio_pct, 0) / baseline.length;
      if (baselineAvg > 0) dropoffPct = round2(((recentAvg - baselineAvg) / baselineAvg) * 100) / 100;
    }
  }

  const isInPause = i.status === 'Active - Pause Granted';
  const action = classifyAction({ ov, riskTier, isInPause });

  rows.push({
    instance_id: i.id,
    account_name: i.account_name,
    allmoxy_customer_id: aid,
    join_via: join.via,
    customer_name: profile.name,

    // Renewal pipeline
    renewal_date: renewalDate,
    days_to_renewal: daysToRenewal,
    calculated_renewal_date: calculatedRenewal,
    renewal_date_manual: manualRenewal,
    contract_status: i.contract_status,
    contract_length_months: i.contract_length_months_ != null ? Number(i.contract_length_months_) : null,
    monthly_flat_fee_hubspot: i.monthly_flat_fee != null ? Number(i.monthly_flat_fee) : null,
    arr_up_for_renewal: round2((Number(i.monthly_flat_fee) || currentMrr) * 12),

    // Retrospective signals
    last_renewal_expansion: i.renewal_expansion_revenue || null,
    last_no_expansion_reason: i.reason_s__for_no_renewal_expansion_revenue || null,

    // Lifecycle dates
    payment_start_date: parseHubspotDate(i.payment_start_date),
    payment_pause_date: parseHubspotDate(i.payment_pause_date),
    instance_creation: parseHubspotDate(i.instance_creation),
    merchant_connect_date: parseHubspotDate(i.merchant_connect_date),
    last_payment_date_hubspot: parseHubspotDate(i.last_payment_date),
    goal_launch_date: parseHubspotDate(i.goal_launch_date__cloned_),
    is_launched: i.is_this_customer_launched___cloned_ || null,

    // Status + health
    pay_status: i.status,
    cs_pulse: i.customer_health_cs_pulse__cloned_ || null,
    health_score_status: i.health_score_status || null,
    health_score: i.health_score != null ? Number(i.health_score) : null,
    vip_legacy: i.vip_legacy_customer__cloned_ || null,
    implementation_status: i.implementation_status || null,

    // Ownership
    hubspot_owner_id: i.hubspot_owner_id || null,
    owner_name: riskRow?.owner_name || null,

    // Customer financials (joined)
    current_mrr: round2(currentMrr),
    current_arr: round2(currentArr),
    lifetime_subscription: round2(lifetimeSub),
    lifetime_orders_dollars: round2(lifetimeOrders),
    orders_monthly_avg_current_year: round2(monthlyAvgCY),
    orders_monthly_avg_prior_year: round2(Number(ov?.monthly_avg_prior_year) || 0),
    orders_yoy_pct: ov?.monthly_avg_yoy_pct ?? null,

    // Cost ratio (cost as % of orders verified). Lower = better deal for
    // the customer. Replaces the prior "ROI multiplier" framing — same math
    // inverted, but reads more naturally in renewal conversations.
    cost_ratio_lifetime_pct: costRatioLifetimePct,
    cost_ratio_annualized_pct: costRatioAnnualizedPct,
    monthly_trend: monthlyTrend,
    // dropoff_pct: positive = cost ratio increased in recent 3 mo vs trailing 9 mo
    // (customer's getting LESS value per dollar paid). Threshold for the
    // "ROI drop-off" tile is >= +0.25.
    dropoff_pct: dropoffPct,

    // Health tier from matrix
    risk_tier: riskTier,
    risk_score: riskRow?.total_score ?? null,
    is_bid_only: !!riskRow?.is_bid_only,

    // Action tag
    action_tag: action.tag,
    action_reason: action.reason,

    // Engagement signal from Instance
    customer_entered_orders_prev_billing_period:
      i.customer_entered_orders___prev__billing_period != null
        ? Number(i.customer_entered_orders___prev__billing_period)
        : null,

    // Churn context (for the few that are mid-conversation)
    customer_closed_lost: i.customer_closed_lost__cloned_ || null,

    // Quotes — all quotes attached to this customer via Company association,
    // newest first. Empty array when the customer has no quotes in HubSpot.
    // We expose a lean shape so the page doesn't have to know HubSpot's full
    // quote schema; full data is in cache/hubspot_quotes.json if needed.
    quotes: (quotesByAid.get(aid) || []).map((q) => ({
      id: q.id,
      title: q.hs_title || null,
      status: q.hs_status || null,
      amount: q.hs_quote_amount != null ? Number(q.hs_quote_amount) : null,
      currency: q.hs_currency || 'USD',
      created_date: q.hs_createdate || null,
      expiration_date: q.hs_expiration_date || null,
      last_modified_date: q.hs_lastmodifieddate || null,
      quote_number: q.hs_quote_number || null,
      payment_status: q.hs_payment_status || null,
      hubspot_url: q.hubspot_url || `https://app.hubspot.com/quotes/4910812/details/${q.id}`,
    })),
  });
}

// ---------- aggregates for KPI tiles -------------------------------------
const upcomingWindow = 90;
const aggregates = {
  total_instances: rows.length,
  with_renewal_date: withRenewalDate,
  unjoined_active_count: unjoined.length,
  skipped_sandbox_count: skippedSandbox.length,
  renewals_in_next_90d: 0,
  renewals_in_next_90d_arr: 0,
  renewals_in_next_180d: 0,
  renewals_in_next_180d_arr: 0,
  renewals_in_next_12mo: 0,
  renewals_in_next_12mo_arr: 0,
  expansion_opportunities: 0,
  contraction_risks: 0,
  watch: 0,
  stable: 0,
  paused: 0,
  median_cost_ratio_lifetime_pct: null,
  median_cost_ratio_annualized_pct: null,
  dropoff_count: 0, // Cost ratio increased >25% in recent 3mo vs trailing 9mo
  // Quote-coverage KPIs
  customers_with_quote: 0,
  upcoming_renewals_with_quote: 0, // renewal in next 12 mo AND has at least one quote
  upcoming_renewals_without_quote: 0,
  total_quote_count: 0,
};

for (const r of rows) {
  if (r.days_to_renewal != null && r.days_to_renewal >= 0) {
    const arr = r.arr_up_for_renewal;
    if (r.days_to_renewal <= 90) {
      aggregates.renewals_in_next_90d++;
      aggregates.renewals_in_next_90d_arr += arr;
    }
    if (r.days_to_renewal <= 180) {
      aggregates.renewals_in_next_180d++;
      aggregates.renewals_in_next_180d_arr += arr;
    }
    if (r.days_to_renewal <= 365) {
      aggregates.renewals_in_next_12mo++;
      aggregates.renewals_in_next_12mo_arr += arr;
    }
  }
  if (r.action_tag === 'Expansion Opportunity') aggregates.expansion_opportunities++;
  if (r.action_tag === 'Contraction Risk') aggregates.contraction_risks++;
  if (r.action_tag === 'Watch') aggregates.watch++;
  if (r.action_tag === 'Stable') aggregates.stable++;
  if (r.action_tag === 'Paused') aggregates.paused++;
  if (r.dropoff_pct != null && r.dropoff_pct >= 0.25) aggregates.dropoff_count++;
  // Quote coverage
  const hasQuote = (r.quotes || []).length > 0;
  if (hasQuote) {
    aggregates.customers_with_quote++;
    aggregates.total_quote_count += r.quotes.length;
  }
  const inUpcomingWindow = r.days_to_renewal != null && r.days_to_renewal >= 0 && r.days_to_renewal <= 365;
  if (inUpcomingWindow) {
    if (hasQuote) aggregates.upcoming_renewals_with_quote++;
    else aggregates.upcoming_renewals_without_quote++;
  }
}

function median(arr) {
  const a = arr.filter((v) => v != null).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : round2((a[mid - 1] + a[mid]) / 2);
}
aggregates.median_cost_ratio_lifetime_pct = median(rows.map((r) => r.cost_ratio_lifetime_pct));
aggregates.median_cost_ratio_annualized_pct = median(rows.map((r) => r.cost_ratio_annualized_pct));

// ---------- proposed expansion pricing -----------------------------------
// For Expansion Opportunity rows, suggest a new MRR/ARR so the rep doesn't have
// to math it. Anchor: realign the cost ratio (annual subscription ÷ annual
// verified orders) to the HIGHER of the customer's own lifetime ratio and the
// base median, applied to their current order run-rate. Then cap the per-
// renewal uplift (gentle, +15%), floor at current (expansion only), round to
// $25/mo. Self-corrects: customers already paying a fair ratio get no uplift.
const MAX_UPLIFT = 0.15;            // +15% cap per renewal
const CPI_BUMP = 0.03;             // suggested bump when already at/above value
const baseMedianRatio = aggregates.median_cost_ratio_lifetime_pct; // %
const roundTo = (v, step) => Math.round(v / step) * step;
for (const r of rows) {
  const isExpansion = r.action_tag === 'Expansion Opportunity';
  // Opportunistic pricing: a healthy, in-contract customer that ISN'T tagged for
  // expansion (orders flat/down) but sits below the value-based target ratio is
  // still underpriced — surface a suggestion on the customer panel without
  // changing its action_tag (so Renewal Management page counts stay growth-only).
  // proposed_basis distinguishes the two so the UI can gate where each shows.
  const healthyForPricing = r.risk_tier !== 'red' && r.action_tag !== 'Contraction Risk' && r.action_tag !== 'Paused';
  const eligibleOpportunistic = !isExpansion && healthyForPricing && r.contract_status === 'Yes';
  if (!isExpansion && !eligibleOpportunistic) continue;

  const annualizedOrders = (r.orders_monthly_avg_current_year || 0) * 12;
  const ownRatio = r.cost_ratio_lifetime_pct; // % or null
  const hasOrderValue = annualizedOrders > 0 && ownRatio != null && baseMedianRatio != null;
  const cap = round2(r.current_arr * (1 + MAX_UPLIFT));

  if (hasOrderValue) {
    const targetRatio = Math.max(ownRatio, baseMedianRatio); // % — "higher of the two"
    const rawArr = round2((targetRatio / 100) * annualizedOrders);
    const hasRoom = rawArr > r.current_arr;
    // Opportunistic suggestions only exist when there's genuine room to realign.
    if (eligibleOpportunistic && !hasRoom) continue;
    if (!hasRoom) {
      // Expansion-tagged but already at a fair rate vs value — don't push volume price.
      r.proposed_arr = round2(r.current_arr * (1 + CPI_BUMP));
      r.proposed_mrr = roundTo(r.proposed_arr / 12, 25);
      r.expansion_confidence = 'high';
      r.proposed_basis = 'growth';
      r.expansion_rationale = `Already at value (cost ratio ${r.cost_ratio_annualized_pct ?? ownRatio}% vs target ${round2(targetRatio)}%). Suggest CPI +${Math.round(CPI_BUMP * 100)}% only.`;
    } else {
      const cappedArr = Math.min(rawArr, cap);
      r.proposed_arr = round2(cappedArr);
      r.proposed_mrr = roundTo(r.proposed_arr / 12, 25);
      r.expansion_confidence = 'high';
      const beyondCap = rawArr > cap;
      const tail = beyondCap
        ? `capped at +${Math.round(MAX_UPLIFT * 100)}% this renewal — phase remaining over future renewals.`
        : `proposing the full realignment.`;
      const yoyStr = r.orders_yoy_pct != null ? (r.orders_yoy_pct >= 0 ? '+' : '') + Math.round(r.orders_yoy_pct * 100) + '% YoY' : '—';
      if (isExpansion) {
        r.proposed_basis = 'growth';
        r.expansion_rationale =
          `Orders ${r.orders_yoy_pct != null ? yoyStr : 'growing'}; ` +
          `cost ratio ${r.cost_ratio_annualized_pct ?? '—'}% vs target ${round2(targetRatio)}%. ` +
          `Value supports ~$${Math.round(rawArr).toLocaleString()} ARR; ${tail}`;
      } else {
        r.proposed_basis = 'underpriced';
        r.expansion_rationale =
          `Underpriced vs peers — cost ratio ${r.cost_ratio_annualized_pct ?? ownRatio}% vs ${round2(targetRatio)}% target (orders ${yoyStr}). ` +
          `Value supports ~$${Math.round(rawArr).toLocaleString()} ARR; ${tail}`;
      }
    }
  } else if (isExpansion) {
    // Expansion-tagged with no usable order data — capped growth pass-through.
    // (Opportunistic underpricing can't be assessed without order value, so skip.)
    const yoy = r.orders_yoy_pct != null ? Math.max(0, Math.min(r.orders_yoy_pct, MAX_UPLIFT)) : MAX_UPLIFT;
    r.proposed_arr = round2(r.current_arr * (1 + yoy));
    r.proposed_mrr = roundTo(r.proposed_arr / 12, 25);
    r.expansion_confidence = 'low';
    r.proposed_basis = 'growth';
    r.expansion_rationale = `No verified-order value to price against — growth pass-through (+${Math.round(yoy * 100)}%). Confirm manually.`;
  } else {
    continue;
  }
  r.proposed_uplift_pct = r.current_arr > 0 ? round2((r.proposed_arr / r.current_arr - 1) * 100) : null;
}

aggregates.renewals_in_next_90d_arr = round2(aggregates.renewals_in_next_90d_arr);
aggregates.renewals_in_next_180d_arr = round2(aggregates.renewals_in_next_180d_arr);
aggregates.renewals_in_next_12mo_arr = round2(aggregates.renewals_in_next_12mo_arr);

const out = {
  tab: 'renewal_management',
  fetchedAt: new Date().toISOString(),
  cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
  source:
    'HubSpot Instance custom object (2-39181518) joined to customer_profiles + orders_verified + churn_risk_matrix. ' +
    'Multi-key join cascade: installer_id → allmoxy_customer_id → stripe_subscription_id → stripe_company_id → installer_url subdomain → normalized name. ' +
    'Filtered to active (non-Cancelled, non-Pre-Sale, non-sandbox) instances.',
  aggregates,
  rows,
  // Surface unjoined for the Data Cleanup page
  unjoined_active_instances: unjoined,
  skipped_sandbox_count: skippedSandbox.length,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`  ${rows.length} active production instances, ${withRenewalDate} with a renewal date`);
console.log(`  Next 90d: ${aggregates.renewals_in_next_90d} renewals · $${Math.round(aggregates.renewals_in_next_90d_arr).toLocaleString()} ARR`);
console.log(`  Next 180d: ${aggregates.renewals_in_next_180d} renewals · $${Math.round(aggregates.renewals_in_next_180d_arr).toLocaleString()} ARR`);
console.log(`  Next 12mo: ${aggregates.renewals_in_next_12mo} renewals · $${Math.round(aggregates.renewals_in_next_12mo_arr).toLocaleString()} ARR`);
console.log(`  Expansion opps: ${aggregates.expansion_opportunities} · Contraction risks: ${aggregates.contraction_risks} · Watch: ${aggregates.watch} · Stable: ${aggregates.stable} · Paused: ${aggregates.paused}`);
console.log(`  Median cost ratio — lifetime: ${aggregates.median_cost_ratio_lifetime_pct}% · annualized: ${aggregates.median_cost_ratio_annualized_pct}%`);
console.log(`  Cost-ratio drop-off flags (recent 3mo +25% vs trailing 9mo): ${aggregates.dropoff_count}`);
console.log(`  Quote coverage: ${aggregates.customers_with_quote} customers have ${aggregates.total_quote_count} quote(s) · upcoming renewals w/ quote: ${aggregates.upcoming_renewals_with_quote} (vs ${aggregates.upcoming_renewals_without_quote} without)`);
console.log(`  Unjoined active: ${unjoined.length} · Skipped sandboxes: ${skippedSandbox.length}`);
