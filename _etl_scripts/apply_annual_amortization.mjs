#!/usr/bin/env node
/**
 * Apply annual-payer amortization to existing snapshots in-place.
 *
 * For every customer ID in src/data/annual_payers.json:
 *   - Subscription charges >= $3000  → amortized amount/12 over 12 months forward (incl. origin month)
 *   - Subscription charges < $3000  → credited full to origin month (likely historical monthly billing)
 *
 * Affects: customer_profiles.json, subscription_by_month.json, mrr_by_month.json, mrr_waterfall.json
 *
 * Services / Connect streams are NOT touched. payment_dates in subscription_by_month are overwritten
 * for amortized months to point at the origin transaction's date, so drill-downs narrate correctly.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'src/data/snapshots');

const ANNUAL_THRESHOLD = 3000;
const AMORTIZE_MONTHS = 12;

const annualCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/annual_payers.json'), 'utf8'));
const ANNUAL_IDS = new Set(annualCfg.annual_payer_ids);

const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));
const subByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'subscription_by_month.json'), 'utf8'));
const mrrByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_by_month.json'), 'utf8'));
const waterfall = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_waterfall.json'), 'utf8'));

function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymFromDate(iso) {
  return (iso || '').slice(0, 7);
}

function round2(n) { return Math.round(n * 100) / 100; }

function amortizeCustomer(profile) {
  // Build fresh per-month subscription from transactions.
  // Returns { monthlySub: { [ym]: number }, monthlyAnnualized: Set<ym>, monthlyPayDate: { [ym]: isoDate } }
  const monthlySub = {};
  const monthlyAnnualized = new Set();
  const monthlyPayDate = {};

  const subTx = (profile.transactions || []).filter((t) => t.type === 'subscription' && t.status === 'succeeded');
  for (const t of subTx) {
    const origin = ymFromDate(t.created);
    if (!origin) continue;
    const payDate = (t.created || '').slice(0, 10);
    if (t.amount >= ANNUAL_THRESHOLD) {
      const per = t.amount / AMORTIZE_MONTHS;
      for (let k = 0; k < AMORTIZE_MONTHS; k++) {
        const m = addMonths(origin, k);
        monthlySub[m] = round2((monthlySub[m] ?? 0) + per);
        monthlyAnnualized.add(m);
        if (!monthlyPayDate[m]) monthlyPayDate[m] = payDate;
      }
    } else {
      monthlySub[origin] = round2((monthlySub[origin] ?? 0) + t.amount);
      if (!monthlyPayDate[origin]) monthlyPayDate[origin] = payDate;
    }
  }

  return { monthlySub, monthlyAnnualized, monthlyPayDate };
}

let changed = 0;

for (const profile of profiles.rows) {
  if (!ANNUAL_IDS.has(profile.allmoxy_customer_id)) continue;
  const { monthlySub, monthlyAnnualized, monthlyPayDate } = amortizeCustomer(profile);

  // --- 1. Update customer_profiles monthly_history ---
  const allMonths = new Set([
    ...Object.keys(profile.monthly_history || {}),
    ...Object.keys(monthlySub),
  ]);
  const newHistory = {};
  for (const m of allMonths) {
    const old = profile.monthly_history?.[m] || { subscription: 0, services: 0, connect: 0, total: 0 };
    const sub = monthlySub[m] ?? 0;
    const services = old.services || 0;
    const connect = old.connect || 0;
    const total = round2(sub + services + connect);
    if (sub === 0 && services === 0 && connect === 0) continue; // drop empty months
    const cell = { subscription: sub, services, connect, total };
    if (monthlyAnnualized.has(m)) cell.annualized = true;
    newHistory[m] = cell;
  }
  profile.monthly_history = newHistory;

  // Recompute per-profile aggregates.
  let lifetimeSub = 0;
  let peakMonth = null;
  let peakTotal = 0;
  for (const [m, v] of Object.entries(newHistory)) {
    lifetimeSub += v.subscription;
    if (v.total > peakTotal) {
      peakTotal = v.total;
      peakMonth = m;
    }
  }
  profile.lifetime_subscription = round2(lifetimeSub);
  profile.lifetime_total = round2(profile.lifetime_subscription + profile.lifetime_services + profile.lifetime_connect + (profile.lifetime_other || 0));
  profile.peak_month = peakMonth;
  profile.peak_month_total = round2(peakTotal);
  profile.current_subscription_mrr = round2(newHistory[profile.latest_month]?.subscription ?? 0);

  // --- 2. Update subscription_by_month row for this customer ---
  const subRow = subByMonth.rows.find((r) => r.customer_name === profile.name);
  if (subRow) {
    // Wipe existing month cells.
    for (const k of Object.keys(subRow)) {
      if (/^\d{4}-\d{2}$/.test(k)) delete subRow[k];
    }
    const nextPayDates = {};
    for (const [m, v] of Object.entries(monthlySub)) {
      if (v > 0) subRow[m] = v;
      if (monthlyPayDate[m]) nextPayDates[m] = monthlyPayDate[m];
    }
    subRow.payment_dates = nextPayDates;
  }

  changed++;
}

console.log(`Amortized ${changed} annual-payer customer(s).`);

// --- 3. Recompute mrr_by_month totals from subscription_by_month ---
// Build month → {sumSub, logoQty} from subByMonth.
const totalsByMonth = {};
for (const row of subByMonth.rows) {
  for (const [k, v] of Object.entries(row)) {
    if (!/^\d{4}-\d{2}$/.test(k)) continue;
    if (typeof v !== 'number' || v <= 0) continue;
    if (!totalsByMonth[k]) totalsByMonth[k] = { sum: 0, logos: 0 };
    totalsByMonth[k].sum += v;
    totalsByMonth[k].logos += 1;
  }
}
for (const row of mrrByMonth.rows) {
  const t = totalsByMonth[row.month];
  if (!t) continue;
  row.logo_qty = t.logos;
  row.mrr_subscription = round2(t.sum);
  row.mrr_blended = round2(t.sum + (row.mrr_services || 0) + (row.mrr_connect || 0));
  row.avg_mrr_blended = t.logos > 0 ? Math.round(row.mrr_blended / t.logos) : 0;
}

// --- 4. Rebuild mrr_waterfall.monthly from subscription_by_month ---
const monthsSorted = Object.keys(totalsByMonth).sort();
const today = new Date();
const currentYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

// Build customer → month → sub map.
const custMrr = new Map();
for (const row of subByMonth.rows) {
  const m = {};
  for (const [k, v] of Object.entries(row)) {
    if (/^\d{4}-\d{2}$/.test(k) && typeof v === 'number' && v > 0) m[k] = v;
  }
  custMrr.set(row.customer_name, m);
}

const newMonthly = [];
for (let i = 1; i < monthsSorted.length; i++) {
  const prev = monthsSorted[i - 1];
  const cur = monthsSorted[i];
  if (cur >= currentYM) break;

  let newMrr = 0, expansion = 0, contraction = 0, churn = 0, starting = 0, ending = 0;
  let newLogos = 0, churnedLogos = 0;
  const details = { new: [], expansion: [], contraction: [], churn: [] };

  for (const [name, byMonth] of custMrr.entries()) {
    const p = byMonth[prev] ?? 0;
    const n = byMonth[cur] ?? 0;
    starting += p;
    ending += n;
    if (p === 0 && n > 0) {
      newMrr += n;
      newLogos++;
      details.new.push({ name, mrr: round2(n) });
    } else if (p > 0 && n === 0) {
      churn += p;
      churnedLogos++;
      details.churn.push({ name, mrr: round2(p) });
    } else if (n > p) {
      const delta = n - p;
      expansion += delta;
      details.expansion.push({ name, mrr: round2(delta), prev: round2(p), cur: round2(n) });
    } else if (n < p) {
      const delta = p - n;
      contraction += delta;
      details.contraction.push({ name, mrr: round2(delta), prev: round2(p), cur: round2(n) });
    }
  }

  const net = newMrr + expansion - contraction - churn;
  const grr = starting > 0 ? (starting - churn - contraction) / starting : 1;
  const nrr = starting > 0 ? (starting - churn - contraction + expansion) / starting : 1;
  const qr = (churn + contraction) > 0 ? (newMrr + expansion) / (churn + contraction) : null;
  const grossChurn = starting > 0 ? (churn + contraction) / starting : 0;
  const netChurn = starting > 0 ? (churn + contraction - expansion) / starting : 0;
  const expRate = starting > 0 ? expansion / starting : 0;

  newMonthly.push({
    month: cur,
    starting_mrr: round2(starting),
    new_mrr: round2(newMrr),
    expansion_mrr: round2(expansion),
    contraction_mrr: round2(contraction),
    churn_mrr: round2(churn),
    ending_mrr: round2(ending),
    net_new_mrr: round2(net),
    new_logos: newLogos,
    churned_logos: churnedLogos,
    gross_churn_rate_monthly: round2(grossChurn * 10000) / 10000,
    net_churn_rate_monthly: round2(netChurn * 10000) / 10000,
    expansion_rate_monthly: round2(expRate * 10000) / 10000,
    grr_monthly: round2(grr * 10000) / 10000,
    nrr_monthly: round2(nrr * 10000) / 10000,
    quick_ratio: qr != null ? Math.round(qr * 10) / 10 : null,
    details: {
      new: details.new.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      expansion: details.expansion.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      contraction: details.contraction.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      churn: details.churn.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
    },
  });
}
waterfall.monthly = newMonthly;

// Recompute TTM waterfall (12-month rolling sums of monthly deltas).
if (Array.isArray(waterfall.ttm)) {
  const ttm = [];
  for (let i = 11; i < newMonthly.length; i++) {
    const window = newMonthly.slice(i - 11, i + 1);
    const endRow = newMonthly[i];
    const startRow = newMonthly[i - 11];
    const sum = (key) => window.reduce((s, r) => s + (r[key] ?? 0), 0);
    const starting = startRow.starting_mrr;
    const ending = endRow.ending_mrr;
    const newMrr = sum('new_mrr');
    const expansion = sum('expansion_mrr');
    const contraction = sum('contraction_mrr');
    const churn = sum('churn_mrr');
    const netNew = newMrr + expansion - contraction - churn;
    const grr = starting > 0 ? (starting - churn - contraction) / starting : 1;
    const nrr = starting > 0 ? (starting - churn - contraction + expansion) / starting : 1;
    const qr = (churn + contraction) > 0 ? (newMrr + expansion) / (churn + contraction) : null;
    ttm.push({
      month: endRow.month,
      starting_mrr: round2(starting),
      new_mrr: round2(newMrr),
      expansion_mrr: round2(expansion),
      contraction_mrr: round2(contraction),
      churn_mrr: round2(churn),
      ending_mrr: round2(ending),
      net_new_mrr: round2(netNew),
      grr_ttm: round2(grr * 10000) / 10000,
      nrr_ttm: round2(nrr * 10000) / 10000,
      quick_ratio_ttm: qr != null ? Math.round(qr * 10) / 10 : null,
    });
  }
  waterfall.ttm = ttm;
}

// Also bump fetchedAt timestamps so UI knows data was refreshed.
const now = new Date().toISOString();
profiles.fetchedAt = now;
subByMonth.fetchedAt = now;
mrrByMonth.fetchedAt = now;
waterfall.fetchedAt = now;

// Write back.
fs.writeFileSync(path.join(SNAP, 'customer_profiles.json'), JSON.stringify(profiles));
fs.writeFileSync(path.join(SNAP, 'subscription_by_month.json'), JSON.stringify(subByMonth));
fs.writeFileSync(path.join(SNAP, 'mrr_by_month.json'), JSON.stringify(mrrByMonth));
fs.writeFileSync(path.join(SNAP, 'mrr_waterfall.json'), JSON.stringify(waterfall));

console.log('Wrote customer_profiles.json, subscription_by_month.json, mrr_by_month.json, mrr_waterfall.json.');

// Regenerate the lean roster that UI pages (Custom Report, etc.) read.
await import('./build_roster.mjs');
