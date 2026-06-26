#!/usr/bin/env node
/**
 * Revenue seam: keep history from the xlsx/json, switch to the live Stripe API
 * for the cutover month forward. "Use what was there from the .xlsx/json for
 * history; use Stripe (metadata-classified) moving forward."
 *
 * For each customer the API has cutover-month+ data for, this replaces
 * monthly_history / transactions / lifetime / current MRR / failed / status for
 * months >= SEAM with the Stripe charges cache (sync_stripe.mjs). Earlier months
 * are untouched. Customers with NO API data >= SEAM are left entirely on the
 * xlsx (so an attribution gap never zeroes a customer's recent revenue).
 *
 * Runs in-place on customer_profiles.json, AFTER connect attribution and BEFORE
 * status overrides / never-paid (so those still win). No-op if the cache is absent.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SEAM = '2026-06';            // first month sourced from Stripe
const SEAM_DAY = `${SEAM}-01`;
const CACHE = path.join(ROOT, '_etl_scripts/cache/stripe_charges.json');
const PROFILES = path.join(ROOT, 'public/snapshots/customer_profiles.json');

const api = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')).by_customer || {} : null;
if (!api) { console.error('[seam] no stripe_charges cache — skipped (history unchanged)'); process.exit(0); }

const ANNUAL = (() => { try { return new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/annual_payers.json'), 'utf8')).annual_payer_ids || []); } catch { return new Set(); } })();
const snap = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
const r2 = (v) => Math.round(v * 100) / 100;
const today = new Date();
const latestCompleteMonth = (() => { const d = new Date(today.getFullYear(), today.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
const threeMoAgo = (() => { const d = new Date(today); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0, 10); })();

// Hybrid status rule — mirrors build_customer_profiles.mjs (kept in sync).
function recomputeStatus(p, lastPay, failed3mo) {
  if (p.status === 'never_paid') return 'never_paid';
  const hubChurn = /cancel/i.test(p.pay_status || '') || !!(p.churn_reason && String(p.churn_reason).trim());
  const legit = /pause|pre-?sale|partnership|free/i.test(p.pay_status || '');
  const monthsSince = lastPay ? (today.getTime() - new Date(lastPay).getTime()) / (30.44 * 864e5) : Infinity;
  const missed = !!(lastPay && lastPay < `${latestCompleteMonth}-01`);
  if (hubChurn) return 'churned';
  if (legit) return failed3mo > 0 ? 'at_risk' : 'active';
  if (monthsSince >= 12) return 'churned';
  if (missed && !ANNUAL.has(p.allmoxy_customer_id)) return 'non_payment';
  if (failed3mo > 0) return 'at_risk';
  return 'active';
}

let seamed = 0;
for (const p of snap.rows) {
  // Gather this customer's API data >= SEAM across all their Stripe customer IDs.
  const cusIds = new Set(p.stripe_customer_ids || []);
  const apiMonths = {}; const apiTxns = []; const apiFailed = []; let lastApi = null;
  for (const cid of cusIds) {
    const e = api[cid]; if (!e) continue;
    for (const [m, v] of Object.entries(e.by_month || {})) {
      if (m >= SEAM) { const a = apiMonths[m] || { subscription: 0, services: 0 }; a.subscription += v.subscription || 0; a.services += v.services || 0; apiMonths[m] = a; }
    }
    for (const t of e.transactions || []) if (t.d >= SEAM_DAY) { apiTxns.push(t); if (!lastApi || t.d > lastApi) lastApi = t.d; }
    for (const t of e.failed || []) if (t.d >= threeMoAgo) apiFailed.push(t);
  }
  if (Object.keys(apiMonths).length === 0 && apiTxns.length === 0) continue; // no API data >= SEAM → leave on xlsx

  // --- lifetime delta: swap the customer's own >= SEAM xlsx revenue for API ---
  let xlsxSubGE = 0, xlsxSvcGE = 0;
  for (const t of p.transactions || []) {
    if (t.status === 'succeeded' && String(t.created || '').slice(0, 10) >= SEAM_DAY) {
      const net = typeof t.net_amount === 'number' ? t.net_amount : t.amount;
      if (t.type === 'subscription') xlsxSubGE += net; else if (t.type === 'services') xlsxSvcGE += net;
    }
  }
  const apiSubGE = r2(Object.values(apiMonths).reduce((s, v) => s + v.subscription, 0));
  const apiSvcGE = r2(Object.values(apiMonths).reduce((s, v) => s + v.services, 0));
  p.lifetime_subscription = r2((p.lifetime_subscription || 0) - xlsxSubGE + apiSubGE);
  p.lifetime_services = r2((p.lifetime_services || 0) - xlsxSvcGE + apiSvcGE);
  p.lifetime_total = r2((p.lifetime_subscription || 0) + (p.lifetime_services || 0) + (p.lifetime_connect || 0) + (p.lifetime_other || 0));

  // --- monthly_history: drop xlsx >= SEAM, overlay API sub/svc, PRESERVE connect ---
  // Connect comes from apply_connect_attribution (which ran before this step) and is
  // NOT in the Stripe charges cache. It must be captured BEFORE deleting the month —
  // otherwise `mh[m]?.connect` reads the just-deleted entry as undefined and zeroes
  // every seamed month's connect for customers who also have June+ Stripe charges.
  const mh = p.monthly_history || {};
  const connectByMonth = {};
  for (const m of Object.keys(mh)) if (m >= SEAM) connectByMonth[m] = mh[m]?.connect ?? 0;
  for (const m of Object.keys(mh)) if (m >= SEAM) delete mh[m];
  for (const [m, v] of Object.entries(apiMonths)) {
    const connect = connectByMonth[m] ?? 0;
    mh[m] = { subscription: r2(v.subscription), services: r2(v.services), connect: r2(connect), total: r2(v.subscription + v.services + connect) };
  }
  // Restore seamed months that had connect but no Stripe sub/svc charges (so the
  // apiMonths overlay above didn't recreate them).
  for (const [m, connect] of Object.entries(connectByMonth)) {
    if (connect > 0 && !mh[m]) mh[m] = { subscription: 0, services: 0, connect: r2(connect), total: r2(connect) };
  }
  p.monthly_history = mh;

  // peak month over the merged history
  let pk = null, pkv = 0; for (const [m, v] of Object.entries(mh)) if ((v.total || 0) > pkv) { pkv = v.total; pk = m; }
  p.peak_month = pk; p.peak_month_total = r2(pkv);

  // --- transactions: xlsx < SEAM + API >= SEAM ---
  const kept = (p.transactions || []).filter((t) => String(t.created || '').slice(0, 10) < SEAM_DAY);
  const apiRows = apiTxns.map((t) => ({ created: t.d, amount: r2(t.a + (t.r || 0)), amount_refunded: r2(t.r || 0), net_amount: r2(t.a), type: t.t, status: 'succeeded', description: 'Stripe API' }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  p.transactions = [...apiRows, ...kept];
  p.transaction_count = p.transactions.length;

  // --- current MRR, last payment, failed, status ---
  p.current_subscription_mrr = r2(mh[latestCompleteMonth]?.subscription ?? 0);
  if (lastApi && (!p.last_payment_date || lastApi > p.last_payment_date)) p.last_payment_date = lastApi;
  p.failed_3mo_count = apiFailed.length;
  p.failed_3mo_amount = r2(apiFailed.reduce((s, t) => s + (t.a || 0), 0));
  p.status = recomputeStatus(p, p.last_payment_date, p.failed_3mo_count);
  seamed++;
}

snap.notes = (snap.notes || '') + ` | Stripe API seam applied from ${SEAM} (history from xlsx, ${SEAM}+ from live Stripe).`;
fs.writeFileSync(PROFILES, JSON.stringify(snap, null, 2));
console.error(`[seam] applied Stripe (>=${SEAM}) to ${seamed} customers · history < ${SEAM} unchanged`);
