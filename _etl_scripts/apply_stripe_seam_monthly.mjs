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

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
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
    if (m < SEAM) continue;
    const t = monthTot[m] || { sub: 0, svc: 0, connect: 0, logos: 0 };
    t.sub += v.subscription || 0; t.svc += v.services || 0; t.connect += v.connect || 0;
    if ((v.subscription || 0) > 0) t.logos += 1;
    monthTot[m] = t;
    const nm = nameMonth.get(p.name) || {}; nm[m] = { sub: v.subscription || 0, svc: v.services || 0 }; nameMonth.set(p.name, nm);
  }
}

// 1) mrr_by_month — overlay totals for seamed months.
const mrr = read('mrr_by_month.json');
let mrrTouched = 0;
for (const row of mrr.rows) {
  const t = monthTot[row.month];
  if (row.month >= SEAM && t) {
    row.mrr_subscription = r2(t.sub);
    row.mrr_services = r2(t.svc);
    // Connect for seamed months: prefer the net-settled USD figure (real revenue
    // that hits the bank — Stripe FX applied, net of refunds). Fall back to the
    // attribution-populated profiles sum if the net cache isn't present.
    const connect = netConnectByMonth[row.month] != null ? netConnectByMonth[row.month] : t.connect;
    row.mrr_connect = r2(connect);
    row.logo_qty = t.logos;
    row.mrr_blended = r2(t.sub + t.svc + connect);
    row.avg_mrr_blended = t.logos ? Math.round(row.mrr_blended / t.logos) : row.avg_mrr_blended;
    mrrTouched++;
  }
}
fs.writeFileSync(path.join(SNAP, 'mrr_by_month.json'), JSON.stringify(mrr, null, 2));

// 2) + 3) per-customer monthly snapshots — overlay seamed month columns.
function seamPerCustomer(file, field) {
  const snap = read(file);
  const totals = snap.monthlyTotals || {};
  for (const row of snap.rows || []) {
    const nm = nameMonth.get(row.customer_name);
    for (const k of Object.keys(row)) {
      if (isMonth(k) && k >= SEAM) row[k] = nm && nm[k] ? r2(nm[k][field]) : 0;
    }
  }
  // recompute monthlyTotals for seamed months
  for (const k of Object.keys(totals)) if (isMonth(k) && k >= SEAM) totals[k] = monthTot[k] ? r2(monthTot[k][field === 'sub' ? 'sub' : 'svc']) : 0;
  fs.writeFileSync(path.join(SNAP, file), JSON.stringify(snap, null, 2));
}
seamPerCustomer('subscription_by_month.json', 'sub');
seamPerCustomer('services_by_month.json', 'svc');

console.error(`[seam-monthly] overlaid Stripe (>=${SEAM}) on mrr_by_month (${mrrTouched} mo) + subscription_by_month + services_by_month`);
