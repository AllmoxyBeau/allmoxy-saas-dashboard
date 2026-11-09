#!/usr/bin/env node
/**
 * Phase 2 of the revenue seam: apply the same "xlsx history, Stripe from June 2026
 * forward" cutover to the AGGREGATE monthly snapshots, so the MRR trend and the
 * per-customer profiles agree (and the mrr_by_month↔monthly_history invariant
 * reconciles for the seamed months).
 *
 * Overlays months >= SEAM from the Stripe charges cache onto:
 *   - mrr_by_month        (subscription/services totals, logo qty, blended, avg)
 *   - subscription_by_month (per-customer columns)
 *   - services_by_month     (per-customer columns)
 * Connect stays from its own (already-live) union; waterfall is untouched because
 * it excludes the current partial month. No-op if the cache is absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'public/snapshots');
const SEAM = '2026-06';
const CACHE = path.join(ROOT, '_etl_scripts/cache/stripe_charges.json');
if (!fs.existsSync(CACHE)) { console.error('[seam-monthly] no stripe cache — skipped'); process.exit(0); }

// Net-settled Connect revenue (USD, what hits the bank) by month, from
// sync_stripe_connect_net.mjs. Used to overlay mrr_connect for seamed months so
// the current-month Connect figure reflects real USD settlement (Stripe FX
// applied, net of refunds) instead of the gross/face-value or attribution-lossy
// per-customer sum. Falls back to the attributed profiles sum if absent.
const NET_CACHE = path.join(ROOT, '_etl_scripts/cache/stripe_connect_net.json');
const netConnectByMonth = (() => {
  try { const j = JSON.parse(fs.readFileSync(NET_CACHE, 'utf8')); const m = {}; for (const r of j.monthly || []) m[r.month] = r.net_usd; return m; }
  catch { return {}; }
})();

const r2 = (v) => Math.round(v * 100) / 100;
const isMonth = (k) => /^\d{4}-\d{2}$/.test(k);
const read = (f) => JSON.parse(fs.readFileSync(path.join(SNAP, f), 'utf8'));
const profiles = read('customer_profiles.json').rows;

// Source the seamed aggregates from customer_profiles.monthly_history — which is
// already seamed (June+ from Stripe) AND amortized/override-adjusted — so the
// totals reconcile EXACTLY with the per-customer profiles (and the invariant).
// (Sourcing from the raw Stripe cache would miss annual amortization and break it.)
const monthTot = {};            // m -> { sub, svc, connect, logos }
const nameMonth = new Map();     // name -> { m -> { sub, svc } }
for (const p of profiles) {
  for (const [m, v] of Object.entries(p.monthly_history || {})) {
    const t = monthTot[m] || { sub: 0, svc: 0, connect: 0, logos: 0 };
    t.sub += v.subscription || 0; t.svc += v.services || 0; t.connect += v.connect || 0;
    if ((v.subscription || 0) > 0) t.logos += 1;
    monthTot[m] = t;
    // Accumulate: two profiles can share a display name, and overwriting dropped one.
    const nm = nameMonth.get(p.name) || {}; const cur = nm[m] || { sub: 0, svc: 0 };
    nm[m] = { sub: cur.sub + (v.subscription || 0), svc: cur.svc + (v.services || 0) }; nameMonth.set(p.name, nm);
  }
}

// 1) mrr_by_month — overlay totals for seamed months, AND append any seamed month
// present in the live data but missing from the (xlsx-sourced) rows. Without the
// append, a new month only shows once the meta xlsx is re-uploaded — so the
// Current Month page stays stuck on the last xlsx month (e.g. June) even after
// July Stripe data lands. Connect for seamed months prefers the net-settled USD
// figure (real revenue to the bank), falling back to the attributed profiles sum.
const mrr = read('mrr_by_month.json');
// Services before the seam come from the sheet's summary row, which ties to QuickBooks
// (mean gap ~$1K/mo) — the per-customer rows miss services nobody attributed to a
// customer (~$4.7K/mo short, $175K over 2022-03…2025-08). Read before it is rewritten.
const svcSheetTotals = { ...(read('services_by_month.json').monthlyTotals || {}) };
const existingMrrMonths = new Set(mrr.rows.map((r) => r.month));
let mrrTouched = 0, mrrAdded = 0;
const buildMrrRow = (m, t) => {
  const connect = netConnectByMonth[m] != null ? netConnectByMonth[m] : t.connect;
  const blended = r2(t.sub + t.svc + connect);
  return {
    month: m,
    logo_qty: t.logos,
    mrr_subscription: r2(t.sub),
    mrr_services: r2(t.svc),
    mrr_connect: r2(connect),
    mrr_blended: blended,
    avg_mrr_blended: t.logos ? Math.round(blended / t.logos) : 0,
  };
};
for (const row of mrr.rows) {
  const t = monthTot[row.month];
  if (!t) continue;
  if (row.month >= SEAM) {
    // Seamed months: full overlay incl. net-USD Connect.
    Object.assign(row, buildMrrRow(row.month, t)); mrrTouched++;
  } else {
    // Historical (pre-seam) months: tie subscription + logos to the auditable
    // per-customer detail (was the xlsx "MRR by Month Total row", which drifted ~0.5%
    // from the summed Stripe-Sync detail). Services keep the sheet summary row (ties to
    // QB; the detail misses unattributed services) and Connect keeps the curated union
    // (the detail's connect is attribution-lossy). Recompute blended.
    const connect = row.mrr_connect || 0;
    row.mrr_subscription = r2(t.sub);
    row.mrr_services = r2(svcSheetTotals[row.month] ?? t.svc);
    row.logo_qty = t.logos;
    row.mrr_blended = r2(t.sub + row.mrr_services + connect);
    row.avg_mrr_blended = t.logos ? Math.round(row.mrr_blended / t.logos) : 0;
    mrrTouched++;
  }
}
// Cap appends at the current calendar month — annual-payer amortization populates
// monthly_history into FUTURE months (e.g. B&B Door's spread runs to 2027-05); we
// must not add those as real MRR rows or the "current month" would jump forward.
const NOW_MONTH = new Date().toISOString().slice(0, 7);
for (const m of Object.keys(monthTot).sort()) {
  if (m < SEAM || m > NOW_MONTH || existingMrrMonths.has(m)) continue;
  mrr.rows.push(buildMrrRow(m, monthTot[m]));
  mrrAdded++;
}
mrr.rows.sort((a, b) => String(a.month).localeCompare(String(b.month)));
fs.writeFileSync(path.join(SNAP, 'mrr_by_month.json'), JSON.stringify(mrr, null, 2));

// 2) subscription_by_month — rebuilt ENTIRELY from customer_profiles.monthly_history,
// the same detail mrr_by_month's subscription now sums, so the NRR page's cohort view
// and the Overview drill read the canonical series. (Previously: the xlsx rows overlaid
// by name, which dropped every customer the sheet didn't list and kept a totals row
// that included annual lump sums as cash — e.g. May 2026 $262,792 vs $229,613.)
{
  const snap = read('subscription_by_month.json');
  const months = [...new Set(Object.keys(monthTot))].filter((m) => isMonth(m) && m <= NOW_MONTH).sort();
  const rows = [];
  for (const [name, byM] of nameMonth) {
    const row = { customer_name: name };
    let any = false;
    for (const m of months) { const v = byM[m]?.sub || 0; row[m] = v ? r2(v) : null; if (v) any = true; }
    if (any) rows.push(row);
  }
  rows.sort((a, b) => String(a.customer_name).localeCompare(String(b.customer_name)));
  snap.columns = ['customer_name', ...months];
  snap.rows = rows;
  snap.rowCount = rows.length;
  snap.monthlyTotals = Object.fromEntries(months.map((m) => [m, r2(monthTot[m].sub)]));
  snap.notes = `Per-customer × per-month subscription MRR from customer_profiles.monthly_history (${rows.length} customers × ${months.length} months) — the same detail as mrr_by_month.mrr_subscription, so rows sum to the totals.`;
  fs.writeFileSync(path.join(SNAP, 'subscription_by_month.json'), JSON.stringify(snap, null, 2));
}

// 3) services_by_month — overlay AND append seamed month columns (adding customers the
// sheet never listed), then carry any remaining gap between the sheet's summary total
// and its customer rows in an explicit "Unattributed services" row, so the rows always
// sum to the totals the Services page, Overview and Unit Economics show.
const UNATTRIBUTED_SVC = 'Unattributed services';
function seamPerCustomer(file, field) {
  const snap = read(file);
  const totals = snap.monthlyTotals || (snap.monthlyTotals = {});
  // All seamed months present in the live per-customer data, capped at the
  // current calendar month (same bound as the mrr_by_month append above). This
  // must ADD new months (e.g. July once its Stripe data lands) — not only
  // overlay months the source xlsx already had — otherwise the newest month is
  // silently dropped from the per-customer snapshot + its monthlyTotals.
  const seamMonths = Object.keys(monthTot)
    .filter((m) => isMonth(m) && m >= SEAM && m <= NOW_MONTH)
    .sort();
  snap.rows = (snap.rows || []).filter((r) => r.customer_name !== UNATTRIBUTED_SVC);
  const have = new Set(snap.rows.map((r) => r.customer_name));
  for (const [name, nm] of nameMonth) {
    if (have.has(name) || !seamMonths.some((k) => nm[k]?.[field])) continue;
    const row = { customer_name: name };
    for (const c of snap.columns || []) if (c !== 'customer_name') row[c] = null;
    snap.rows.push(row);
  }
  for (const row of snap.rows) {
    const nm = nameMonth.get(row.customer_name);
    for (const k of seamMonths) row[k] = nm && nm[k] ? r2(nm[k][field]) : 0;
  }
  for (const k of seamMonths) totals[k] = monthTot[k] ? r2(monthTot[k][field === 'sub' ? 'sub' : 'svc']) : 0;
  const cols = [...new Set([...(snap.columns || []).filter((c) => c !== 'customer_name'), ...seamMonths])].sort();
  snap.columns = ['customer_name', ...cols];
  const gapRow = { customer_name: UNATTRIBUTED_SVC };
  let anyGap = false;
  for (const m of cols) {
    const rowSum = snap.rows.reduce((s, r) => s + (typeof r[m] === 'number' ? r[m] : 0), 0);
    const gap = r2((totals[m] ?? rowSum) - rowSum);
    gapRow[m] = Math.abs(gap) >= 0.01 ? gap : null;
    if (gapRow[m] != null) anyGap = true;
  }
  if (anyGap) snap.rows.push(gapRow);
  snap.rowCount = snap.rows.length;
  fs.writeFileSync(path.join(SNAP, file), JSON.stringify(snap, null, 2));
}
seamPerCustomer('services_by_month.json', 'svc');

console.error(`[seam-monthly] overlaid Stripe (>=${SEAM}) on mrr_by_month (${mrrTouched} mo overlaid, ${mrrAdded} appended) + subscription_by_month + services_by_month`);
