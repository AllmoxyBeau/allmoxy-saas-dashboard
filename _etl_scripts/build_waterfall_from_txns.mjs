#!/usr/bin/env node
/**
 * Parallel waterfall built directly from customer_profiles.transactions[] —
 * the same Stripe Sync data that drives Current Month variance. Lets us
 * spot-check the QB-driven mrr_waterfall.json against the transaction-level
 * truth before flipping over to it as the canonical source.
 *
 * Output: public/snapshots/mrr_waterfall_txns.json (mirrors mrr_waterfall.json
 * schema: monthly[], ttm, plus details.new / reactivated / expansion /
 * contraction / churn).
 *
 * Method: per customer, sum each month's NET subscription revenue from
 * succeeded charges in the post-override transactions array. Walk months
 * chronologically and bucket each customer's prev→cur transition into
 * new / reactivated / expansion / contraction / churn (same definitions the
 * existing waterfall uses).
 *
 * Caveats vs the QB-driven waterfall:
 *   - No annual amortization. Annual prepayers spike in their billing month
 *     and "churn" the next 11 months in this view. Compare against
 *     mrr_waterfall.json to see the smoothing effect.
 *   - Per-customer (not per-subscription). Multi-sub customers (e.g. NYDD)
 *     aggregate their two subs into one customer-level MRR.
 *   - Transactions are post-override and post-cross-customer-move
 *     (apply_transaction_overrides has already run before this script).
 */

import fs from 'node:fs';
import path from 'node:path';

const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));

function round2(n) { return Math.round(n * 100) / 100; }
function netAmount(t) {
  if (typeof t.net_amount === 'number') return t.net_amount;
  return typeof t.amount === 'number' ? t.amount : 0;
}

// Build customer → month → MRR (sum of net subscription charges, succeeded only).
const monthlyMrr = new Map(); // id → { name, months: Map<month, mrr> }
const allMonths = new Set();
for (const p of profiles.rows) {
  if (!p.transactions || p.transactions.length === 0) continue;
  const months = new Map();
  for (const t of p.transactions) {
    if (t.type !== 'subscription' || t.status !== 'succeeded') continue;
    const net = netAmount(t);
    if (!(net > 0.01)) continue; // ignore fully-refunded charges
    const m = String(t.created ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    months.set(m, round2((months.get(m) ?? 0) + net));
    allMonths.add(m);
  }
  if (months.size > 0) {
    monthlyMrr.set(p.allmoxy_customer_id, { name: p.name, months });
  }
}
const monthsSorted = [...allMonths].sort();

function shiftMonth(iso, delta) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Walk chronologically. For each customer, track whether they've EVER paid
// before the current month — drives new vs reactivated.
const everPaidBefore = new Map(); // id → boolean (paid in any month strictly before pm)

const monthly = [];
for (const M of monthsSorted) {
  const PM = shiftMonth(M, -1);
  let starting = 0, ending = 0;
  let newMrr = 0, reactivatedMrr = 0, expansionMrr = 0, contractionMrr = 0, churnMrr = 0;
  let newLogos = 0, reactivatedLogos = 0, churnedLogos = 0;
  const details = { new: [], reactivated: [], expansion: [], contraction: [], churn: [] };

  for (const [id, info] of monthlyMrr) {
    const cur = info.months.get(M) ?? 0;
    const prev = info.months.get(PM) ?? 0;
    starting += prev;
    ending += cur;

    if (cur > 0 && prev === 0) {
      const hasPrior = everPaidBefore.get(id) === true;
      if (hasPrior) {
        reactivatedMrr += cur;
        reactivatedLogos += 1;
        details.reactivated.push({ name: info.name, mrr: cur });
      } else {
        newMrr += cur;
        newLogos += 1;
        details.new.push({ name: info.name, mrr: cur });
      }
    } else if (cur > 0 && prev > 0) {
      if (cur > prev + 0.01) {
        const delta = round2(cur - prev);
        expansionMrr += delta;
        details.expansion.push({ name: info.name, prev_mrr: prev, new_mrr: cur, delta });
      } else if (cur < prev - 0.01) {
        const delta = round2(prev - cur);
        contractionMrr += delta;
        details.contraction.push({ name: info.name, prev_mrr: prev, new_mrr: cur, delta });
      }
    } else if (cur === 0 && prev > 0) {
      churnMrr += prev;
      churnedLogos += 1;
      details.churn.push({ name: info.name, mrr: prev });
    }
  }

  // After processing M, mark everyone who paid in M as "ever paid before"
  // for the next month's reactivated/new check.
  for (const [id, info] of monthlyMrr) {
    if ((info.months.get(M) ?? 0) > 0) everPaidBefore.set(id, true);
  }

  // Sort details by impact size for the drill panel.
  const byMrr = (a, b) => (b.mrr ?? 0) - (a.mrr ?? 0);
  const byDelta = (a, b) => (b.delta ?? 0) - (a.delta ?? 0);
  details.new.sort(byMrr);
  details.reactivated.sort(byMrr);
  details.expansion.sort(byDelta);
  details.contraction.sort(byDelta);
  details.churn.sort(byMrr);

  const netNew = round2(newMrr + reactivatedMrr + expansionMrr - contractionMrr - churnMrr);
  monthly.push({
    month: M,
    starting_mrr: round2(starting),
    new_mrr: round2(newMrr),
    reactivated_mrr: round2(reactivatedMrr),
    expansion_mrr: round2(expansionMrr),
    contraction_mrr: round2(contractionMrr),
    churn_mrr: round2(churnMrr),
    ending_mrr: round2(ending),
    net_new_mrr: netNew,
    new_logos: newLogos,
    reactivated_logos: reactivatedLogos,
    churned_logos: churnedLogos,
    gross_churn_rate_monthly: starting > 0 ? round2(churnMrr / starting * 1e6) / 1e6 : 0,
    net_churn_rate_monthly: starting > 0 ? round2((churnMrr - expansionMrr) / starting * 1e6) / 1e6 : 0,
    expansion_rate_monthly: starting > 0 ? round2(expansionMrr / starting * 1e6) / 1e6 : 0,
    grr_monthly: starting > 0 ? round2((1 - churnMrr / starting) * 1e6) / 1e6 : 1,
    nrr_monthly: starting > 0 ? round2((starting + expansionMrr - churnMrr - contractionMrr) / starting * 1e6) / 1e6 : 1,
    quick_ratio: round2(churnMrr + contractionMrr > 0 ? (newMrr + reactivatedMrr + expansionMrr) / (churnMrr + contractionMrr) : 0 * 10) / 10,
    details,
  });
}

// Trailing-12-month aggregates over the most recent complete window.
function buildTtm() {
  if (monthly.length < 2) return null;
  const last = monthly[monthly.length - 1].month;
  const startIdx = Math.max(0, monthly.length - 12);
  const window = monthly.slice(startIdx);
  if (window.length === 0) return null;
  const starting = window[0].starting_mrr;
  const ending = window[window.length - 1].ending_mrr;
  const sum = (k) => window.reduce((s, r) => s + (r[k] || 0), 0);
  const newM = sum('new_mrr');
  const reM = sum('reactivated_mrr');
  const expM = sum('expansion_mrr');
  const conM = sum('contraction_mrr');
  const churnM = sum('churn_mrr');
  return {
    windowStart: window[0].month,
    windowEnd: last,
    starting_mrr: round2(starting),
    ending_mrr: round2(ending),
    new_mrr: round2(newM),
    reactivated_mrr: round2(reM),
    expansion_mrr: round2(expM),
    contraction_mrr: round2(conM),
    churn_mrr: round2(churnM),
    net_new_mrr: round2(newM + reM + expM - conM - churnM),
    gross_mrr_churn_ttm: starting > 0 ? round2(churnM / starting * 1e4) / 1e4 : 0,
    annual_gross_churn_rate: starting > 0 ? round2(churnM / ((starting + ending) / 2) * 1e4) / 1e4 : 0,
    annual_grr: starting > 0 ? round2((1 - churnM / starting) * 1e4) / 1e4 : 1,
    annual_nrr: starting > 0 ? round2((starting + expM - churnM - conM) / starting * 1e4) / 1e4 : 1,
    quick_ratio: churnM + conM > 0 ? round2((newM + reM + expM) / (churnM + conM) * 100) / 100 : 0,
  };
}

const out = {
  tab: 'mrr_waterfall_txns',
  fetchedAt: new Date().toISOString(),
  cachedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: [],
  rowCount: monthly.length,
  monthly,
  ttm: buildTtm(),
  notes:
    `Parallel waterfall built from customer_profiles.transactions[] (post-override, post-cross-customer-move). ` +
    `${monthly.length} months covered. Mirrors mrr_waterfall.json schema. ` +
    'Caveats: no annual amortization (annual payers spike on billing month, churn next 11); ' +
    'customer-level aggregation (multi-sub customers sum their subs).',
};
fs.writeFileSync(path.join(SNAP, 'mrr_waterfall_txns.json'), JSON.stringify(out));
const sizeKb = Math.round(fs.statSync(path.join(SNAP, 'mrr_waterfall_txns.json')).size / 1024);
console.log(`  wrote mrr_waterfall_txns.json (${sizeKb} KB) — ${monthly.length} months`);
