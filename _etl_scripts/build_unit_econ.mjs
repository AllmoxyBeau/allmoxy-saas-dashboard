#!/usr/bin/env node
// Build unit economics snapshot from the local xlsx.
// Combines:
//   - QuickBooks P&L (QuickBooks CAC Info tab) for costs + margin math
//   - mrr_by_month.json for subscription MRR per month + logo qty
//   - services_by_month.json for services attach rate + per-customer services
//   - allmoxy_core_customer.json for cohort baseline

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const SNAPSHOTS = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// ---------- parse QuickBooks P&L ----------
const qb = XLSX.utils.sheet_to_json(wb.Sheets['QuickBooks CAC Info'], { header: 1, defval: null, raw: false });
// Row 0: metadata, Row 1: "Account | Jan 2018 | Feb 2018 | ..."
const qbHeader = qb[1];
const qbMonthCols = [];
for (let i = 1; i < qbHeader.length; i++) {
  const label = qbHeader[i];
  if (!label) continue;
  // "Jan 2018" → "2018-01"
  const m = String(label).match(/^(\w{3})\s+(\d{4})$/);
  if (!m) continue;
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  const iso = `${m[2]}-${MONTHS[m[1]]}`;
  qbMonthCols.push({ colIdx: i, month: iso });
}

function parseQbAmount(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Find specific P&L rows by account name match.
function findAccountRow(needle) {
  for (let i = 2; i < qb.length; i++) {
    const a = qb[i]?.[0];
    if (a && String(a).trim() === needle) return i;
  }
  return -1;
}

const ROWS = {
  subRev: findAccountRow('4000 Monthly Subscription'),
  servicesRev: findAccountRow('4300 Services Income'),
  affiliateRev: findAccountRow('4600 Affiliate Referral Income'),
  totalIncome: findAccountRow('Total Income'),
  ccFees: findAccountRow('5000 Credit Card Acceptance Fees'),
  salesCommission: findAccountRow('5200 Sales Commission'),
  servicesCommission: findAccountRow('5300 Services Commissions'),
  affiliateCommission: findAccountRow('5400 Affilliate Commissions'),
  totalCOGS: findAccountRow('Total Cost of Goods Sold'),
  grossProfit: findAccountRow('Gross Profit'),
  marketingPayroll: findAccountRow('Total 6050 Marketing Payroll Expenses'),
  marketingAdvertising: findAccountRow('Total 6300 Marketing and Advertising'),
  salesExpenses: findAccountRow('Total 6500 Sales Expenses'),
  totalExpenses: findAccountRow('Total Expenses'),
  netOp: findAccountRow('Net Operating Income'),
};

// Series: monthly time series for each metric.
const pnl = {};
for (const [key, rowIdx] of Object.entries(ROWS)) {
  if (rowIdx < 0) {
    pnl[key] = {};
    continue;
  }
  const series = {};
  for (const { colIdx, month } of qbMonthCols) {
    series[month] = parseQbAmount(qb[rowIdx][colIdx]);
  }
  pnl[key] = series;
}

// ---------- monthly unit economics time series ----------
const mrr = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'mrr_by_month.json'), 'utf8'));
const services = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'services_by_month.json'), 'utf8'));
const core = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'allmoxy_core_customer.json'), 'utf8'));

const mrrByMonth = Object.fromEntries(mrr.rows.map((r) => [r.month, r]));

// Count new signups per month from core_customer.
const newSignupsByMonth = {};
for (const r of core.rows) {
  if (!r.sign_up_date) continue;
  const m = r.sign_up_date.slice(0, 7); // YYYY-MM
  newSignupsByMonth[m] = (newSignupsByMonth[m] ?? 0) + 1;
}

// Months to compute over: QuickBooks range intersected with MRR range.
const qbMonths = qbMonthCols.map((x) => x.month);
const mrrMonths = mrr.rows.map((r) => r.month);
const months = qbMonths.filter((m) => mrrMonths.includes(m));

// Helper: val or 0
function v(obj, m) { return obj?.[m] ?? 0; }

const monthly = months.map((m) => {
  const row = mrrByMonth[m] ?? {};
  const subRev = v(pnl.subRev, m);
  const servicesRev = v(pnl.servicesRev, m);
  const affiliateRev = v(pnl.affiliateRev, m);
  const totalIncome = v(pnl.totalIncome, m);
  const ccFees = v(pnl.ccFees, m);
  const salesCommission = v(pnl.salesCommission, m);
  const servicesCommission = v(pnl.servicesCommission, m);
  const totalCOGS = v(pnl.totalCOGS, m);
  const grossProfit = v(pnl.grossProfit, m);
  const mktPayroll = v(pnl.marketingPayroll, m);
  const mktAdvertising = v(pnl.marketingAdvertising, m);
  const salesExpenses = v(pnl.salesExpenses, m);
  const netOp = v(pnl.netOp, m);

  const snm = mktPayroll + mktAdvertising + salesExpenses + salesCommission;
  const newLogos = newSignupsByMonth[m] ?? 0;
  const cac = newLogos > 0 ? snm / newLogos : null;
  const subGM = subRev > 0 ? (subRev - ccFees * (subRev / (totalIncome || 1))) / subRev : null;
  const overallGM = totalIncome > 0 ? grossProfit / totalIncome : null;
  const servicesGM = servicesRev > 0 ? (servicesRev - servicesCommission) / servicesRev : null;
  const logoQty = row.logo_qty ?? null;
  const avgMRR = row.mrr_subscription && logoQty ? row.mrr_subscription / logoQty : null;

  return {
    month: m,
    subscription_revenue: Math.round(subRev * 100) / 100,
    services_revenue: Math.round(servicesRev * 100) / 100,
    affiliate_revenue: Math.round(affiliateRev * 100) / 100,
    total_income: Math.round(totalIncome * 100) / 100,
    cogs: Math.round(totalCOGS * 100) / 100,
    gross_profit: Math.round(grossProfit * 100) / 100,
    gross_margin: overallGM != null ? Math.round(overallGM * 1000) / 1000 : null,
    subscription_gross_margin: subGM != null ? Math.round(subGM * 1000) / 1000 : null,
    services_gross_margin: servicesGM != null ? Math.round(servicesGM * 1000) / 1000 : null,
    snm_expense: Math.round(snm * 100) / 100,
    new_logos: newLogos,
    cac: cac != null ? Math.round(cac * 100) / 100 : null,
    logo_qty: logoQty,
    avg_mrr_per_customer: avgMRR != null ? Math.round(avgMRR * 100) / 100 : null,
    net_op_income: Math.round(netOp * 100) / 100,
  };
});

// ---------- trailing-12-month (TTM) summary ending at latest complete month ----------
const today = new Date();
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const completeMonths = monthly.filter((r) => r.month < currentMonth);
const ttm = completeMonths.slice(-12);

function sum(arr, key) { return arr.reduce((s, r) => s + (r[key] ?? 0), 0); }

const ttmSubRev = sum(ttm, 'subscription_revenue');
const ttmServicesRev = sum(ttm, 'services_revenue');
const ttmAffiliateRev = sum(ttm, 'affiliate_revenue');
const ttmTotalIncome = sum(ttm, 'total_income');
const ttmCOGS = sum(ttm, 'cogs');
const ttmGrossProfit = sum(ttm, 'gross_profit');
const ttmSNM = sum(ttm, 'snm_expense');
const ttmNewLogos = sum(ttm, 'new_logos');
const ttmNetOp = sum(ttm, 'net_op_income');
const ttmGM = ttmTotalIncome > 0 ? ttmGrossProfit / ttmTotalIncome : null;
const ttmSubGM = ttmSubRev > 0 ? (ttmSubRev - sum(ttm, 'cogs') * (ttmSubRev / (ttmTotalIncome || 1))) / ttmSubRev : null;

const ttmCAC = ttmNewLogos > 0 ? ttmSNM / ttmNewLogos : null;

// Current month stats (for LTV math)
const latest = completeMonths[completeMonths.length - 1];
const avgMRR = latest?.avg_mrr_per_customer ?? null;
const logoQtyNow = latest?.logo_qty ?? null;

// Derive monthly churn rate from Logo Qty deltas in trailing 12 months vs gross adds.
// monthly_net_change = logo_qty[m] - logo_qty[m-1]
// gross_adds = newSignupsByMonth[m]
// churn_logos = gross_adds - monthly_net_change
// Use trailing 12 months for a stable rate.
let totalChurn = 0;
let totalStartingLogos = 0;
for (let i = 1; i < ttm.length; i++) {
  const prev = ttm[i - 1];
  const cur = ttm[i];
  const netDelta = (cur.logo_qty ?? 0) - (prev.logo_qty ?? 0);
  const gross = cur.new_logos ?? 0;
  const churn = Math.max(gross - netDelta, 0);
  totalChurn += churn;
  totalStartingLogos += prev.logo_qty ?? 0;
}
const monthlyChurnRate = totalStartingLogos > 0 ? totalChurn / totalStartingLogos : null; // per-month
const annualChurnRate = monthlyChurnRate != null ? 1 - Math.pow(1 - monthlyChurnRate, 12) : null;

// LTV = (avg MRR * gross margin) / monthly churn rate  (subscription only)
const ltv = avgMRR != null && ttmSubGM != null && monthlyChurnRate && monthlyChurnRate > 0
  ? (avgMRR * ttmSubGM) / monthlyChurnRate
  : null;

const cacPayback = avgMRR != null && ttmSubGM != null && ttmCAC != null && avgMRR * ttmSubGM > 0
  ? ttmCAC / (avgMRR * ttmSubGM)
  : null;

const ltvCac = ltv != null && ttmCAC != null && ttmCAC > 0 ? ltv / ttmCAC : null;

// ---------- services attach rate (from services_by_month per-customer rows) ----------
const svcCustomersEver = new Set();
const svcCustomerRevenue = new Map(); // customer_name -> total services $
for (const r of services.rows) {
  let total = 0;
  for (const [k, val] of Object.entries(r)) {
    if (k === 'customer_name') continue;
    if (typeof val === 'number' && val > 0) total += val;
  }
  if (total > 0) {
    svcCustomersEver.add(r.customer_name);
    svcCustomerRevenue.set(r.customer_name, total);
  }
}
const totalCustomersEver = core.rowCount;
const attachRate = totalCustomersEver > 0 ? svcCustomersEver.size / totalCustomersEver : null;
const avgServicesPerAttachedCustomer =
  svcCustomersEver.size > 0
    ? [...svcCustomerRevenue.values()].reduce((a, b) => a + b, 0) / svcCustomersEver.size
    : null;

const now = new Date();
const out = {
  tab: 'unit_economics',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: [],
  rowCount: 0,
  monthly,
  ttm: {
    windowStart: ttm[0]?.month ?? null,
    windowEnd: ttm[ttm.length - 1]?.month ?? null,
    subscription_revenue: Math.round(ttmSubRev * 100) / 100,
    services_revenue: Math.round(ttmServicesRev * 100) / 100,
    affiliate_revenue: Math.round(ttmAffiliateRev * 100) / 100,
    total_income: Math.round(ttmTotalIncome * 100) / 100,
    cogs: Math.round(ttmCOGS * 100) / 100,
    gross_profit: Math.round(ttmGrossProfit * 100) / 100,
    gross_margin: ttmGM != null ? Math.round(ttmGM * 1000) / 1000 : null,
    subscription_gross_margin: ttmSubGM != null ? Math.round(ttmSubGM * 1000) / 1000 : null,
    snm_expense: Math.round(ttmSNM * 100) / 100,
    new_logos: ttmNewLogos,
    cac: ttmCAC != null ? Math.round(ttmCAC * 100) / 100 : null,
    net_op_income: Math.round(ttmNetOp * 100) / 100,
    monthly_churn_rate: monthlyChurnRate != null ? Math.round(monthlyChurnRate * 10000) / 10000 : null,
    annual_churn_rate: annualChurnRate != null ? Math.round(annualChurnRate * 10000) / 10000 : null,
    avg_mrr_per_customer: avgMRR != null ? Math.round(avgMRR * 100) / 100 : null,
    logo_qty_latest: logoQtyNow,
    ltv: ltv != null ? Math.round(ltv * 100) / 100 : null,
    cac_payback_months: cacPayback != null ? Math.round(cacPayback * 10) / 10 : null,
    ltv_cac_ratio: ltvCac != null ? Math.round(ltvCac * 100) / 100 : null,
  },
  services: {
    total_customers_ever: totalCustomersEver,
    customers_bought_services: svcCustomersEver.size,
    attach_rate: attachRate != null ? Math.round(attachRate * 10000) / 10000 : null,
    avg_services_revenue_per_attached_customer:
      avgServicesPerAttachedCustomer != null ? Math.round(avgServicesPerAttachedCustomer * 100) / 100 : null,
  },
  notes:
    'Unit economics derived from QuickBooks CAC Info P&L × allmoxy_core_customer signups × mrr_by_month logo counts. ' +
    'CAC = (Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission) / new logos. ' +
    'LTV = Avg MRR × Subscription Gross Margin / Monthly Logo Churn Rate. ' +
    'Churn rate derived from Logo Qty deltas and gross signups (aggregate, not per-cohort). ' +
    'All metrics are subscription-only unless stated; services revenue is tracked separately.',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
