#!/usr/bin/env node
// Build MRR waterfall snapshot: per-month New / Expansion / Contraction / Churn deltas.
// Derived from per-customer × per-month subscription MRR in the MRR by Month tab.
//
// For each month M vs prior month M-1, for each customer:
//   prev == 0 && cur > 0  → New
//   prev > 0 && cur == 0  → Churned
//   cur > prev            → Expansion (cur - prev)
//   cur < prev            → Contraction (prev - cur)
//
// Ending MRR = Starting + New + Expansion - Contraction - Churned.

import fs from 'node:fs';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// Header at row index 5 (L6): [null, '2018-Jun', '2018-Jul', ...].
// Data rows start index 7 (L8).
const aoa = XLSX.utils.sheet_to_json(wb.Sheets['MRR by Month'], { header: 1, defval: null, raw: false });
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const monthHeader = aoa[5];
const monthCols = [];
for (let i = 1; i < monthHeader.length; i++) {
  const label = monthHeader[i];
  if (!label) continue;
  const m = String(label).match(/^(\d{4})-(\w{3})$/);
  if (!m) continue;
  monthCols.push({ colIdx: i, month: `${m[1]}-${MONTHS[m[2]]}` });
}

function parseNum(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// customer → month → mrr (only non-zero stored).
const customers = [];
for (let i = 7; i < aoa.length; i++) {
  const row = aoa[i];
  const name = row?.[0];
  if (!name || !String(name).trim()) continue;
  if (String(name).match(/Total|Logo Qty|Average|NO_HEADER|^\d+$/)) continue;
  const mrrByMonth = {};
  for (const { colIdx, month } of monthCols) {
    const v = parseNum(row[colIdx]);
    if (v > 0) mrrByMonth[month] = v;
  }
  customers.push({ name: String(name).trim(), mrrByMonth });
}

// Walk months; compute deltas vs prior month.
const today = new Date();
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

const monthly = [];
// Track each customer's first MRR month so we can distinguish a true new logo from
// a reactivated one (had MRR before, churned, returning now).
const firstMrrMonthByCustomer = new Map();
for (const c of customers) {
  const months = Object.keys(c.mrrByMonth).filter((m) => (c.mrrByMonth[m] ?? 0) > 0).sort();
  if (months.length > 0) firstMrrMonthByCustomer.set(c.name, months[0]);
}

for (let i = 1; i < monthCols.length; i++) {
  const prev = monthCols[i - 1].month;
  const cur = monthCols[i].month;
  if (cur >= currentMonth) break; // exclude current (partial) month

  let newMrr = 0;
  let reactivatedMrr = 0;
  let expansion = 0;
  let contraction = 0;
  let churn = 0;
  let startingMrr = 0;
  let endingMrr = 0;
  let churnedLogos = 0;
  let newLogos = 0;
  let reactivatedLogos = 0;
  const details = { new: [], reactivated: [], expansion: [], contraction: [], churn: [] };

  for (const c of customers) {
    const p = c.mrrByMonth[prev] ?? 0;
    const n = c.mrrByMonth[cur] ?? 0;
    startingMrr += p;
    endingMrr += n;
    if (p === 0 && n > 0) {
      // Either a brand-new logo (this is their first-ever MRR month) or a
      // reactivation (they billed before but not in `prev`).
      if (firstMrrMonthByCustomer.get(c.name) === cur) {
        newMrr += n;
        newLogos += 1;
        details.new.push({ name: c.name, mrr: Math.round(n * 100) / 100 });
      } else {
        reactivatedMrr += n;
        reactivatedLogos += 1;
        details.reactivated.push({ name: c.name, mrr: Math.round(n * 100) / 100 });
      }
    } else if (p > 0 && n === 0) {
      churn += p;
      churnedLogos += 1;
      details.churn.push({ name: c.name, mrr: Math.round(p * 100) / 100 });
    } else if (n > p) {
      expansion += n - p;
      details.expansion.push({
        name: c.name,
        prev_mrr: Math.round(p * 100) / 100,
        new_mrr: Math.round(n * 100) / 100,
        delta: Math.round((n - p) * 100) / 100,
      });
    } else if (n < p) {
      contraction += p - n;
      details.contraction.push({
        name: c.name,
        prev_mrr: Math.round(p * 100) / 100,
        new_mrr: Math.round(n * 100) / 100,
        delta: Math.round((p - n) * 100) / 100,
      });
    }
  }

  // Sort each detail list by absolute impact so the biggest movers appear first.
  details.new.sort((a, b) => b.mrr - a.mrr);
  details.reactivated.sort((a, b) => b.mrr - a.mrr);
  details.churn.sort((a, b) => b.mrr - a.mrr);
  details.expansion.sort((a, b) => b.delta - a.delta);
  details.contraction.sort((a, b) => b.delta - a.delta);

  const netNew = newMrr + reactivatedMrr + expansion - contraction - churn;
  const grossChurnRate = startingMrr > 0 ? churn / startingMrr : null;
  const netChurnRate = startingMrr > 0 ? (churn + contraction - expansion) / startingMrr : null;
  const expansionRate = startingMrr > 0 ? expansion / startingMrr : null;
  const grr = startingMrr > 0 ? (startingMrr - churn - contraction) / startingMrr : null; // Gross Retention Rate (monthly)
  const nrr = startingMrr > 0 ? (startingMrr - churn - contraction + expansion) / startingMrr : null; // Net Retention Rate (monthly)
  const quickRatio = churn + contraction > 0 ? (newMrr + expansion) / (churn + contraction) : null;

  monthly.push({
    month: cur,
    starting_mrr: Math.round(startingMrr * 100) / 100,
    new_mrr: Math.round(newMrr * 100) / 100,
    reactivated_mrr: Math.round(reactivatedMrr * 100) / 100,
    expansion_mrr: Math.round(expansion * 100) / 100,
    contraction_mrr: Math.round(contraction * 100) / 100,
    churn_mrr: Math.round(churn * 100) / 100,
    ending_mrr: Math.round(endingMrr * 100) / 100,
    net_new_mrr: Math.round(netNew * 100) / 100,
    new_logos: newLogos,
    reactivated_logos: reactivatedLogos,
    churned_logos: churnedLogos,
    gross_churn_rate_monthly: grossChurnRate != null ? Math.round(grossChurnRate * 10000) / 10000 : null,
    net_churn_rate_monthly: netChurnRate != null ? Math.round(netChurnRate * 10000) / 10000 : null,
    expansion_rate_monthly: expansionRate != null ? Math.round(expansionRate * 10000) / 10000 : null,
    grr_monthly: grr != null ? Math.round(grr * 10000) / 10000 : null,
    nrr_monthly: nrr != null ? Math.round(nrr * 10000) / 10000 : null,
    quick_ratio: quickRatio != null ? Math.round(quickRatio * 100) / 100 : null,
    details,
  });
}

// TTM summary ending at latest complete month.
const completeMonths = monthly.filter((r) => r.month < currentMonth);
const ttm = completeMonths.slice(-12);

function sum(arr, key) { return arr.reduce((s, r) => s + (r[key] ?? 0), 0); }
function mean(arr, key) {
  const vals = arr.map((r) => r[key]).filter((v) => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

const ttmNew = sum(ttm, 'new_mrr');
const ttmReactivated = sum(ttm, 'reactivated_mrr');
const ttmExpansion = sum(ttm, 'expansion_mrr');
const ttmContraction = sum(ttm, 'contraction_mrr');
const ttmChurn = sum(ttm, 'churn_mrr');
const ttmNetNew = ttmNew + ttmReactivated + ttmExpansion - ttmContraction - ttmChurn;
const ttmStartingMrr = ttm[0]?.starting_mrr ?? 0;
const ttmEndingMrr = ttm[ttm.length - 1]?.ending_mrr ?? 0;
const ttmGrossChurn = ttmStartingMrr > 0 ? ttmChurn / ttmStartingMrr : null;
const ttmAnnualGrossChurnRate = mean(ttm, 'gross_churn_rate_monthly') != null
  ? 1 - Math.pow(1 - mean(ttm, 'gross_churn_rate_monthly'), 12) : null;
// Annualized NRR: compound monthly NRR over 12 months.
const meanMonthlyNRR = mean(ttm, 'nrr_monthly');
const annualNRR = meanMonthlyNRR != null ? Math.pow(meanMonthlyNRR, 12) : null;
const meanMonthlyGRR = mean(ttm, 'grr_monthly');
const annualGRR = meanMonthlyGRR != null ? Math.pow(meanMonthlyGRR, 12) : null;

const ttmQuickRatio = ttmChurn + ttmContraction > 0 ? (ttmNew + ttmExpansion) / (ttmChurn + ttmContraction) : null;

const now = new Date();
const out = {
  tab: 'mrr_waterfall',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: [],
  rowCount: 0,
  monthly,
  ttm: {
    windowStart: ttm[0]?.month ?? null,
    windowEnd: ttm[ttm.length - 1]?.month ?? null,
    starting_mrr: Math.round(ttmStartingMrr * 100) / 100,
    ending_mrr: Math.round(ttmEndingMrr * 100) / 100,
    new_mrr: Math.round(ttmNew * 100) / 100,
    reactivated_mrr: Math.round(ttmReactivated * 100) / 100,
    expansion_mrr: Math.round(ttmExpansion * 100) / 100,
    contraction_mrr: Math.round(ttmContraction * 100) / 100,
    churn_mrr: Math.round(ttmChurn * 100) / 100,
    net_new_mrr: Math.round(ttmNetNew * 100) / 100,
    gross_mrr_churn_ttm: ttmGrossChurn != null ? Math.round(ttmGrossChurn * 10000) / 10000 : null,
    annual_gross_churn_rate: ttmAnnualGrossChurnRate != null ? Math.round(ttmAnnualGrossChurnRate * 10000) / 10000 : null,
    annual_grr: annualGRR != null ? Math.round(annualGRR * 10000) / 10000 : null,
    annual_nrr: annualNRR != null ? Math.round(annualNRR * 10000) / 10000 : null,
    quick_ratio: ttmQuickRatio != null ? Math.round(ttmQuickRatio * 100) / 100 : null,
  },
  notes:
    'MRR waterfall derived from per-customer × per-month subscription MRR in the MRR by Month tab. ' +
    'New = customer first appears with MRR > 0; Churn = customer had MRR > 0 last month and 0 this month. ' +
    'Expansion / Contraction are intra-customer month-over-month MRR changes. ' +
    'Services and Connect revenue are NOT included — subscription only.',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
