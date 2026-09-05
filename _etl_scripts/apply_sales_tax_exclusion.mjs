#!/usr/bin/env node
/**
 * Remove collected SALES TAX from the per-customer MRR series.
 *
 * Sales tax is a pass-through liability, not revenue — Beau's P&L proves it: 4000
 * Monthly Subscription is booked GROSS and 4050 Monthly Subscription Tax (contra)
 * backs it out into 2141 UT / 2142 NY / 2144 CO-Denver. But Stripe CHARGE amounts
 * are invoice TOTALS, so `customer_profiles.monthly_history[m].subscription` — the
 * source every MRR metric derives from — carried ~1.5% of tax (~$3.4K/mo).
 *
 * That inflated MRR, ARR, unit economics and the Overview, and it disagreed with the
 * accrual basis (which sums pre-tax invoice LINE amounts and was already correct).
 * Stripping it here, at the single source, makes every downstream metric consistent.
 *
 * Attribution: tax is netted against the month the invoice was PAID, so it lands in
 * the same month the cash it rode in on.
 *
 * SCOPE — deliberately the MRR series only:
 *   • monthly_history[m].subscription   → ex-tax   (drives MRR / ARR / retention)
 *   • current_subscription_mrr          → ex-tax   (drives customer health, health KPIs)
 *   • transactions[] and lifetime_*     → LEFT GROSS. Those are the cash audit trail;
 *     they must keep tying to Stripe payouts and the bank. The JE handles the split.
 *
 * Runs after every apply_* step (profiles final) and BEFORE build_revenue_recognition
 * / build_waterfall / apply_stripe_seam_monthly, so the seam propagates ex-tax figures
 * into mrr_by_month and subscription_by_month.
 *
 * Idempotent: writes `sales_tax_excluded: true` on the snapshot and no-ops if set.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const PROFILES = path.join(SNAP, 'customer_profiles.json');
const r2 = (v) => Math.round(v * 100) / 100;

const snap = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
if (snap.sales_tax_excluded) {
  console.error('[sales-tax] already excluded — no-op');
  process.exit(0);
}

let INV = null;
try { INV = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/cache/stripe_invoices.json'), 'utf8')); }
catch { console.error('[sales-tax] no invoice cache — skipped (MRR still includes tax)'); process.exit(0); }

// aid -> { 'YYYY-MM': tax } keyed by the invoice's PAID month.
const custToAid = new Map();
for (const p of snap.rows) for (const c of (p.stripe_customer_ids || [])) custToAid.set(c, p.allmoxy_customer_id);
const taxByAid = new Map();
for (const [cid, cust] of Object.entries(INV.by_customer || {})) {
  const aid = custToAid.get(cid); if (aid == null) continue;
  for (const i of (cust.invoices || [])) {
    if (!(i.tax > 0) || !i.paid_at) continue;         // only tax actually collected sits in the cash series
    if (i.status === 'void') continue;
    const m = String(i.paid_at).slice(0, 7);
    if (!taxByAid.has(aid)) taxByAid.set(aid, {});
    const o = taxByAid.get(aid); o[m] = r2((o[m] || 0) + i.tax);
  }
}

let removed = 0, touchedCustomers = 0, touchedMonths = 0;
const byMonth = {};
for (const p of snap.rows) {
  const tx = taxByAid.get(p.allmoxy_customer_id);
  if (!tx) continue;
  let touched = false;
  for (const [m, t] of Object.entries(tx)) {
    const cell = p.monthly_history?.[m];
    if (!cell || !(cell.subscription > 0)) continue;
    const cut = Math.min(cell.subscription, t);       // never drive a month negative
    cell.subscription = r2(cell.subscription - cut);
    if (cell.total != null) cell.total = r2(Math.max(0, cell.total - cut));
    removed = r2(removed + cut); byMonth[m] = r2((byMonth[m] || 0) + cut);
    touchedMonths++; touched = true;
  }
  if (touched) touchedCustomers++;
}

// current_subscription_mrr must agree with the (now ex-tax) latest paying month.
const allMonths = new Set();
for (const p of snap.rows) for (const m of Object.keys(p.monthly_history || {})) allMonths.add(m);
const nowMonth = new Date().toISOString().slice(0, 7);
const complete = [...allMonths].filter((m) => m < nowMonth).sort();
const latest = complete[complete.length - 1];
if (latest) for (const p of snap.rows) {
  if (p.current_subscription_mrr == null) continue;
  p.current_subscription_mrr = r2(p.monthly_history?.[latest]?.subscription || 0);
}

snap.sales_tax_excluded = true;
snap.sales_tax_note = `Sales tax removed from monthly_history[].subscription and current_subscription_mrr (netted by invoice paid month) — it is a pass-through liability, not revenue, matching the 4050→2141/2142/2144 treatment in QuickBooks. transactions[] and lifetime_* stay GROSS as the cash audit trail. Removed $${Math.round(removed).toLocaleString()} across ${touchedMonths} customer-months.`;
fs.writeFileSync(PROFILES, JSON.stringify(snap));

const recent = Object.keys(byMonth).sort().slice(-4).map((m) => `${m}:$${Math.round(byMonth[m]).toLocaleString()}`).join(' ');
console.error(`[sales-tax] removed $${Math.round(removed).toLocaleString()} from ${touchedCustomers} customers / ${touchedMonths} customer-months · recent ${recent}`);
