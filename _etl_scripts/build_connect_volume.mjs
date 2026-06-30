#!/usr/bin/env node
/**
 * Build the Connect "payments opportunity" snapshot from the live Stripe pull.
 *
 * Input:  _etl_scripts/cache/stripe_connect_volume.json  (sync_stripe_connect.mjs)
 *         public/snapshots/customer_profiles.json          (attach denominator)
 *         _source_xlsx/Stripe Connect Revenue 20xx.xlsx     (acct_id → company name)
 *
 * Output: public/snapshots/connect_volume.json
 *
 * Frames the embedded-payments opportunity a PE buyer underwrites: real GMV
 * flowing through Connect, the (flat ~0.5%) take-rate, attach vs the active book,
 * and take-rate / attach expansion scenarios.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'public/snapshots');
const cache = JSON.parse(fs.readFileSync(path.join(__dirname, 'cache/stripe_connect_volume.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8')).rows;
// Per-customer monthly Connect FEE (for "actively processing" recency) and
// per-customer order volume (the attach-potential proxy — what they run through
// Allmoxy that could flow through Connect).
const ccm = JSON.parse(fs.readFileSync(path.join(SNAP, 'connect_by_customer_month.json'), 'utf8'));
const ordersV = (() => { try { return JSON.parse(fs.readFileSync(path.join(SNAP, 'orders_verified.json'), 'utf8')); } catch { return { by_customer: {} }; } })();
const orderMoByAid = new Map();
for (const [aid, o] of Object.entries(ordersV.by_customer || {})) {
  const mo = o.monthly_avg_current_year || o.monthly_avg?.[Object.keys(o.monthly_avg || {}).slice(-1)[0]] || 0;
  if (mo > 0) orderMoByAid.set(Number(aid), mo);
}

// --- acct_id → company name, from the Connect Revenue "Data for Pivot" sheets ---
const acctName = new Map();
for (const year of ['2025', '2026', '2024']) { // later years first so recent names win on first-write
  const f = path.join(ROOT, `_source_xlsx/Stripe Connect Revenue ${year}.xlsx`);
  if (!fs.existsSync(f)) continue;
  try {
    const wb = XLSX.read(fs.readFileSync(f));
    const ws = wb.Sheets['Data for Pivot'];
    if (!ws) continue;
    for (const r of XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })) {
      const acct = String(r[0] || '').trim();
      const name = String(r[1] || '').trim();
      if (acct.startsWith('acct_') && name && !acctName.has(acct)) acctName.set(acct, name);
    }
  } catch { /* ignore */ }
}

// --- name → customer profile (normalized) for AID/MRR attribution ---
const norm = (s) => String(s || '').toLowerCase().replace(/\b(llc|inc|incorporated|ltd|co|company|corp|the|and)\b/g, ' ').replace(/[^a-z0-9]/g, '');
const profByName = new Map();
for (const p of profiles) { const n = norm(p.name); if (n && !profByName.has(n)) profByName.set(n, p); }

const byAccount = cache.by_account.map((a) => {
  const name = acctName.get(a.account) || null;
  const prof = name ? profByName.get(norm(name)) : null;
  return {
    ...a,
    customer_name: name,
    allmoxy_customer_id: prof?.allmoxy_customer_id ?? null,
    customer_status: prof?.status ?? null,
    subscription_mrr: prof?.current_subscription_mrr ?? null,
  };
});

// --- per-account current vs prior month + per-customer MoM movers ---------
// From the live API's per-account-per-month aggregation (sync_stripe_connect).
// "Current" = the latest month present (today is month-end, so it's complete;
// mid-month it would be partial — the UI flags that). Drives the current-month
// column on the accounts table and the "what's driving the MoM trend" movers.
const round2 = (v) => Math.round(v * 100) / 100;
const acctMo = new Map(); // account -> { month -> { gross, fee } }
for (const r of cache.by_account_month || []) {
  if (!acctMo.has(r.account)) acctMo.set(r.account, {});
  acctMo.get(r.account)[r.month] = { gross: r.gross_volume, fee: r.fee_revenue };
}
const moMonths = [...new Set((cache.by_account_month || []).map((r) => r.month))].sort();
const curMonth = moMonths[moMonths.length - 1] || null;
const prevMonth = moMonths[moMonths.length - 2] || null;
for (const a of byAccount) {
  const m = acctMo.get(a.account) || {};
  a.this_month_fee = curMonth && m[curMonth] ? round2(m[curMonth].fee) : 0;
  a.this_month_gross = curMonth && m[curMonth] ? round2(m[curMonth].gross) : 0;
  a.last_month_fee = prevMonth && m[prevMonth] ? round2(m[prevMonth].fee) : 0;
  a.last_month_gross = prevMonth && m[prevMonth] ? round2(m[prevMonth].gross) : 0;
}
// Group accounts → customers and compute current vs prior month fee + gross.
const custMo = new Map();
for (const a of byAccount) {
  const key = a.allmoxy_customer_id != null ? `aid:${a.allmoxy_customer_id}` : `acct:${a.account}`;
  const e = custMo.get(key) || { customer_name: a.customer_name || a.account, allmoxy_customer_id: a.allmoxy_customer_id ?? null, curFee: 0, prevFee: 0, curGross: 0, prevGross: 0 };
  if (a.customer_name) e.customer_name = a.customer_name;
  e.curFee += a.this_month_fee; e.prevFee += a.last_month_fee;
  e.curGross += a.this_month_gross; e.prevGross += a.last_month_gross;
  custMo.set(key, e);
}
const momMovers = [...custMo.values()]
  .filter((e) => e.curFee > 0 || e.prevFee > 0)
  .map((e) => ({
    customer_name: e.customer_name,
    allmoxy_customer_id: e.allmoxy_customer_id,
    current_fee: round2(e.curFee),
    prior_fee: round2(e.prevFee),
    delta_fee: round2(e.curFee - e.prevFee),
    pct: e.prevFee > 0 ? Math.round(((e.curFee - e.prevFee) / e.prevFee) * 1000) / 10 : null,
    current_gross: round2(e.curGross),
    prior_gross: round2(e.prevGross),
  }))
  .sort((a, b) => b.delta_fee - a.delta_fee);
const momTotalCur = round2(momMovers.reduce((s, m) => s + m.current_fee, 0));
const momTotalPrev = round2(momMovers.reduce((s, m) => s + m.prior_fee, 0));
const mom = {
  current_month: curMonth,
  prior_month: prevMonth,
  total_current_fee: momTotalCur,
  total_prior_fee: momTotalPrev,
  total_delta_fee: round2(momTotalCur - momTotalPrev),
  pct: momTotalPrev > 0 ? Math.round(((momTotalCur - momTotalPrev) / momTotalPrev) * 1000) / 10 : null,
  movers: momMovers,
};

// --- annualized run-rate from the last 12 complete months ----------------
const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const complete = cache.monthly.filter((m) => m.month < currentMonth);
const last12 = complete.slice(-12);
const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
const annualGmv = sum(last12, 'gross_volume');
const annualFee = sum(last12, 'fee_revenue');
const annualTxns = sum(last12, 'txn_count');
const blendedTake = annualGmv > 0 ? annualFee / annualGmv : null;

// --- attach: Connect accounts vs the active book -------------------------
// Active customers only — exclude at_risk/churned/never_paid. The attach pipeline
// and penetration metrics target the currently-active book.
const activeProfiles = profiles.filter((p) => p.status === 'active');
const onConnectAids = new Set(byAccount.filter((a) => a.allmoxy_customer_id != null).map((a) => a.allmoxy_customer_id));
const activeOnConnect = activeProfiles.filter((p) => onConnectAids.has(p.allmoxy_customer_id)).length;

// --- penetration: who is actively processing vs the attach opportunity ----
// "Actively processing" = any Connect fee in the last 3 complete months.
const recent3 = [];
for (let i = 1; i <= 3; i++) { const x = new Date(now.getFullYear(), now.getMonth() - i, 1); recent3.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); }
const last12Months = last12.map((m) => m.month);
const processingAids = new Set();
const everConnectAids = new Set();
const connectAnnualByAid = new Map(); // aid → actual Connect fee, last 12 months
for (const r of ccm.rows) {
  const aid = r.allmoxy_customer_id; if (aid == null) continue;
  let recent = 0, ann = 0, ever = 0;
  for (const m of recent3) recent += typeof r[m] === 'number' ? r[m] : 0;
  for (const m of last12Months) ann += typeof r[m] === 'number' ? r[m] : 0;
  for (const [k, v] of Object.entries(r)) { if (/^\d{4}-\d{2}$/.test(k) && typeof v === 'number') ever += v; }
  if (recent > 0) processingAids.add(aid);
  if (ever > 0) everConnectAids.add(aid);
  if (ann > 0) connectAnnualByAid.set(aid, ann);
}

// Human-authored notes on why a lapsed customer stopped processing (editable in
// the UI, persisted here). Keyed by allmoxy_customer_id.
const lapsedNotes = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'connect_lapsed_notes.json'), 'utf8')).notes || {}; } catch { return {}; } })();

const STD_RATE = 0.005; // standard 0.5% take, applied to captured GMV for the estimate

// Per-customer annualized Connect GMV, derived from their actual Connect fee ÷
// take rate. (Fee is reliably populated per customer from connect_by_customer_month;
// the raw Stripe per-account GMV has name-attribution gaps, so we back GMV out of
// fee — using the account's real take rate where it mapped, else the 0.5% standard.)
const aidTake = new Map();
for (const acc of byAccount) if (acc.allmoxy_customer_id != null && acc.take_rate) aidTake.set(acc.allmoxy_customer_id, acc.take_rate);
const connectGmvAnnual = (aid) => { const fee = connectAnnualByAid.get(aid) || 0; return fee > 0 ? fee / (aidTake.get(aid) || STD_RATE) : 0; };

// Empirical capture: of a processing customer's order volume, what share actually
// runs through Connect. Median across current processors — applied to attach
// targets so the estimate isn't the naive (and ~1.8x too high) assumption that
// 100% of order volume would card-process.
const captures = [];
for (const aid of processingAids) {
  const ord = (orderMoByAid.get(aid) || 0) * 12; const gmv = connectGmvAnnual(aid);
  if (ord > 0 && gmv > 0) captures.push(Math.min(gmv / ord, 1));
}
captures.sort((a, b) => a - b);
const CAPTURE = captures.length ? captures[Math.floor(captures.length / 2)] : 0.5;
// Unified per-customer list across the whole active book, each tagged with its
// Connect status so the UI can filter the one table by any KPI (processing /
// lapsed / never / attach-targets).
const customers = [];
let processingCount = 0, lapsedCount = 0, neverCount = 0;
for (const p of activeProfiles) {
  const aid = p.allmoxy_customer_id;
  const isProcessing = processingAids.has(aid);
  const everProcessed = everConnectAids.has(aid) || (p.lifetime_connect || 0) > 0;
  const connectStatus = isProcessing ? 'processing' : everProcessed ? 'lapsed' : 'never';
  if (isProcessing) processingCount++; else if (everProcessed) lapsedCount++; else neverCount++;
  const annualOrders = (orderMoByAid.get(aid) || 0) * 12;
  const gmv = connectGmvAnnual(aid);
  const attachRate = annualOrders > 0 ? Math.min(gmv / annualOrders, 1) : null; // share of orders flowing through Connect
  customers.push({
    allmoxy_customer_id: aid,
    name: p.name,
    status: p.status,
    primary_segment: p.primary_segment ?? null,
    subscription_mrr: p.current_subscription_mrr ?? 0,
    is_launched: p.is_launched_per_hubspot ?? null,
    connect_status: connectStatus,
    ever_processed: everProcessed,
    annual_order_volume: Math.round(annualOrders),
    connect_gmv_annual: Math.round(gmv),                                // annualized Connect GMV
    connect_attach_rate: attachRate != null ? Math.round(attachRate * 1000) / 1000 : null, // GMV ÷ orders
    annual_connect_fee: Math.round(connectAnnualByAid.get(aid) || 0),   // actual (processors)
    // Non-processors: order volume × empirical capture × 0.5% take (not the naive 100%).
    est_annual_connect_fee: isProcessing ? null : Math.round(annualOrders * CAPTURE * STD_RATE),
    lapsed_note: connectStatus === 'lapsed' ? (lapsedNotes[String(aid)] ?? null) : null,
  });
}
// Sort: processors by actual fee, non-processors by order volume — useful in any filter.
customers.sort((a, b) => (b.annual_connect_fee - a.annual_connect_fee) || (b.annual_order_volume - a.annual_order_volume));
const nonProcessors = customers.filter((c) => c.connect_status !== 'processing');
const attachTotalOrderVolume = nonProcessors.reduce((s, o) => s + o.annual_order_volume, 0);
const attachTotalFeePotential = nonProcessors.reduce((s, o) => s + (o.est_annual_connect_fee || 0), 0);

// --- take-rate expansion scenarios (hold GMV constant) -------------------
const scenarios = [0.005, 0.0075, 0.01, 0.0125].map((rate) => ({
  take_rate: rate,
  annual_fee_revenue: Math.round(annualGmv * rate),
  delta_vs_current: Math.round(annualGmv * rate - annualFee),
  multiple_vs_current: annualFee > 0 ? Math.round((annualGmv * rate / annualFee) * 100) / 100 : null,
}));

// --- take-rate distribution across accounts ------------------------------
const bucket = (r) => r == null ? 'unknown' : r < 0.005 - 0.0003 ? 'below_0.5' : r <= 0.005 + 0.0003 ? 'at_0.5' : r < 0.01 - 0.0003 ? 'between' : r <= 0.01 + 0.0003 ? 'at_1.0' : 'above_1.0';
const dist = {};
for (const a of byAccount) { const b = bucket(a.take_rate); dist[b] = (dist[b] || 0) + 1; }

const out = {
  tab: 'connect_volume',
  fetchedAt: new Date().toISOString(),
  stripe_fetchedAt: cache.fetchedAt,
  window: cache.window,
  currencies: cache.currencies,
  currency_caveat: (cache.currencies?.CAD || cache.currencies?.AUD)
    ? 'GMV mixes USD with non-USD (CAD/AUD) summed as USD — GMV is modestly overstated; the take-rate ratio is exact (fee and gross are same-currency per transaction).'
    : null,
  annualized: {
    basis: last12.length ? `last 12 complete months (${last12[0].month}–${last12[last12.length - 1].month})` : 'insufficient history',
    gross_volume: Math.round(annualGmv),
    fee_revenue: Math.round(annualFee),
    txn_count: annualTxns,
    blended_take_rate: blendedTake != null ? Math.round(blendedTake * 100000) / 100000 : null,
  },
  attach: {
    connected_accounts: cache.totals.distinct_accounts,
    active_customers: activeProfiles.length,
    active_customers_on_connect: activeOnConnect,
    attach_rate: activeProfiles.length > 0 ? Math.round((activeOnConnect / activeProfiles.length) * 1000) / 1000 : null,
  },
  scenarios,
  mom,
  take_rate_distribution: dist,
  // Customer penetration of the active book + the attach opportunity list.
  penetration: {
    active_customers: activeProfiles.length,
    processing_now: processingCount,
    attach_rate: activeProfiles.length > 0 ? Math.round((processingCount / activeProfiles.length) * 1000) / 1000 : null,
    lapsed: lapsedCount,                                   // processed before, not in last 3 mo
    never: neverCount,
    not_processing: nonProcessors.length,
    attach_target_order_volume: attachTotalOrderVolume,   // addressable order $ not on Connect
    attach_target_fee_potential: attachTotalFeePotential, // capture-adjusted, at standard 0.5% take
    attach_capture_assumption: Math.round(CAPTURE * 1000) / 1000, // median GMV÷orders of current processors
    attach_potential_basis: `Annualized verified-order volume of active customers not processing on Connect × ${Math.round(CAPTURE * 100)}% capture (median share of order volume that current processors actually run through Connect) × 0.5% standard take. The capture factor avoids the naive assumption that 100% of order volume card-processes.`,
  },
  customers,
  monthly: cache.monthly,
  by_account: byAccount,
  notes: 'Stripe Connect processing volume + take-rate from the live application_fees API (charge expanded for gross). Annualized figures use the last 12 complete months. Scenarios hold GMV constant and vary take-rate — the embedded-payments expansion lever.',
};
fs.writeFileSync(path.join(SNAP, 'connect_volume.json'), JSON.stringify(out, null, 2));
console.error(`✓ connect_volume.json: annual GMV $${out.annualized.gross_volume.toLocaleString()} · fees $${out.annualized.fee_revenue.toLocaleString()} · take ${(out.annualized.blended_take_rate * 100).toFixed(2)}% · ${out.attach.active_customers_on_connect}/${out.attach.active_customers} active on Connect · ${byAccount.filter(a => a.customer_name).length}/${byAccount.length} accounts named`);
