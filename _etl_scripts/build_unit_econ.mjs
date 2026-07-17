#!/usr/bin/env node
// Build unit economics snapshot from the local xlsx.
// Combines:
//   - QuickBooks P&L (QuickBooks CAC Info tab) for costs + margin math
//   - mrr_by_month.json for subscription MRR per month + logo qty
//   - services_by_month.json for services attach rate + per-customer services
//   - allmoxy_core_customer.json for cohort baseline

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const SNAPSHOTS = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';

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

// ---------- standalone QuickBooks P&L export overlay ----------
// The "QuickBooks CAC Info" tab (above) is manually maintained and lags. When a
// fresh QBO "Profit and Loss" export is dropped in the repo root, overlay its
// months on top of the tab so recent months get real profitability numbers
// without waiting for the tab to be updated.
//
// QUIRK: QBO writes every amount cell as a *formula* (a numeric literal, or a
// SUM of other cells) with a CACHED VALUE OF 0. Excel recomputes on open, so the
// file looks populated — but SheetJS reads the zero cache. So we evaluate the
// formulas ourselves. Same account labels as findAccountRow() above, so the
// overlay keys map 1:1 onto pnl[].
const PNL_EXPORT = path.join(path.dirname(XLSX_PATH), 'Allmoxy+LLC_Profit+and+Loss.xlsx');
if (fs.existsSync(PNL_EXPORT)) {
  const ewb = XLSX.read(fs.readFileSync(PNL_EXPORT), { cellFormula: true });
  const esh = ewb.Sheets[ewb.SheetNames[0]];
  const erows = XLSX.utils.sheet_to_json(esh, { header: 1, defval: null, raw: true });
  const memo = {};
  const evalCell = (addr) => {
    if (addr in memo) return memo[addr];
    memo[addr] = 0; // cycle guard
    const c = esh[addr];
    if (!c) return (memo[addr] = 0);
    if (c.f == null) return (memo[addr] = typeof c.v === 'number' ? c.v : 0);
    const raw = String(c.f).trim();
    const noCommas = raw.replace(/,/g, '');
    if (/^-?\d+(\.\d+)?$/.test(noCommas)) return (memo[addr] = parseFloat(noCommas));
    const sub = raw.replace(/[A-Z]+[0-9]+/g, (m) => '(' + evalCell(m) + ')');
    if (/^[-+*/(). 0-9]+$/.test(sub)) {
      try { return (memo[addr] = Function('return ' + sub)()); } catch { /* fall through */ }
    }
    return (memo[addr] = 0);
  };
  // Locate the month header row ("Jan 2026" ... "Jun 2026") and its columns.
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  let hdrIdx = -1;
  for (let i = 0; i < Math.min(erows.length, 12); i++) {
    if ((erows[i] || []).some((c) => /^\w{3}\s+\d{4}$/.test(String(c ?? '').trim()))) { hdrIdx = i; break; }
  }
  const overlayCols = [];
  if (hdrIdx >= 0) {
    const hdr = erows[hdrIdx];
    for (let ci = 1; ci < hdr.length; ci++) {
      const mm = String(hdr[ci] ?? '').trim().match(/^(\w{3})\s+(\d{4})$/);
      if (mm && MONTHS[mm[1]]) overlayCols.push({ colLetter: XLSX.utils.encode_col(ci), month: `${mm[2]}-${MONTHS[mm[1]]}` });
    }
  }
  // Map pnl[] keys → the export's exact account labels (same needles as ROWS).
  const OVERLAY_LABELS = {
    subRev: '4000 Monthly Subscription', servicesRev: '4300 Services Income',
    totalIncome: 'Total Income', ccFees: '5000 Credit Card Acceptance Fees',
    salesCommission: '5200 Sales Commission', servicesCommission: '5300 Services Commissions',
    affiliateCommission: '5400 Affilliate Commissions', affiliateRev: '4600 Affiliate Referral Income',
    totalCOGS: 'Total Cost of Goods Sold', grossProfit: 'Gross Profit',
    marketingPayroll: 'Total 6050 Marketing Payroll Expenses',
    marketingAdvertising: 'Total 6300 Marketing and Advertising',
    salesExpenses: 'Total 6500 Sales Expenses', totalExpenses: 'Total Expenses',
    netOp: 'Net Operating Income',
  };
  const rowByLabel = {};
  erows.forEach((r, i) => { const l = String(r?.[0] ?? '').trim(); if (l && !(l in rowByLabel)) rowByLabel[l] = i; });
  let overlaid = 0;
  for (const key of Object.keys(OVERLAY_LABELS)) {
    if (!pnl[key]) pnl[key] = {};
    const ri = rowByLabel[OVERLAY_LABELS[key]];
    for (const { colLetter, month } of overlayCols) {
      // Absent account (e.g. Services/Affiliate commissions no longer on the P&L)
      // → 0 for the overlaid month, which is the accurate current value.
      pnl[key][month] = ri == null ? 0 : Math.round(evalCell(colLetter + (ri + 1)) * 100) / 100;
    }
  }
  // Make sure the overlaid months are in qbMonthCols so they survive the
  // qbMonths ∩ mrrMonths intersection below even if the tab lacked the column.
  for (const { month } of overlayCols) {
    if (!qbMonthCols.some((x) => x.month === month)) qbMonthCols.push({ colIdx: -1, month });
    overlaid++;
  }
  console.error(`[unit_econ] overlaid QuickBooks P&L export: ${overlayCols.map((c) => c.month).join(', ')} (${overlaid} months) from ${path.basename(PNL_EXPORT)}`);
} else {
  console.error(`[unit_econ] no standalone P&L export at ${path.basename(PNL_EXPORT)} — using CAC Info tab only`);
}

// ---------- monthly unit economics time series ----------
const mrr = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'mrr_by_month.json'), 'utf8'));
const services = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'services_by_month.json'), 'utf8'));
const core = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'allmoxy_core_customer.json'), 'utf8'));
// Stripe Connect revenue is a distinct stream — Allmoxy's platform fee on
// customer payment processing. It lives in connect_by_month (month → mrr_connect),
// NOT in the QuickBooks P&L's near-zero "4600 Affiliate Referral Income" line.
const connect = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'connect_by_month.json'), 'utf8'));
const connectByCust = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'connect_by_customer_month.json'), 'utf8'));
const connectByMonth = Object.fromEntries(connect.rows.map((r) => [r.month, r.mrr_connect ?? 0]));

// MRR waterfall — the authoritative churn source (built before this script). It
// distinguishes CONFIRMED churn from delinquency/pause/annual gaps, which the
// old logo-count-delta method here could not. We use its per-month
// churned_logos for logo churn + LTV so the Scorecard/UE page agree.
const waterfall = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'mrr_waterfall.json'), 'utf8')); }
  catch { return null; }
})();
const churnedLogosByMonth = waterfall
  ? Object.fromEntries((waterfall.monthly || []).map((m) => [m.month, m.churned_logos ?? 0]))
  : {};

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

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const monthly = months.map((m) => {
  const row = mrrByMonth[m] ?? {};
  // --- QuickBooks P&L (may be empty for recent months) — profitability layer ---
  const qbSubRev = v(pnl.subRev, m);
  const qbServicesRev = v(pnl.servicesRev, m);
  const qbTotalIncome = v(pnl.totalIncome, m);
  const affiliateRev = v(pnl.affiliateRev, m);
  const ccFees = v(pnl.ccFees, m);
  const salesCommission = v(pnl.salesCommission, m);
  const servicesCommission = v(pnl.servicesCommission, m);
  const totalCOGS = v(pnl.totalCOGS, m);
  const grossProfit = v(pnl.grossProfit, m);
  const netOp = v(pnl.netOp, m);
  const snm = v(pnl.marketingPayroll, m) + v(pnl.marketingAdvertising, m) + v(pnl.salesExpenses, m) + salesCommission;
  // Is the P&L populated for this month? (recent months are blank until QB refresh)
  const pnlAvailable = qbTotalIncome !== 0 || grossProfit !== 0 || totalCOGS !== 0;

  // --- Revenue from the LIVE MRR basis (Stripe) — always current, so recent
  // months show real dollars instead of $0 from the stale P&L. ---
  const subRev = row.mrr_subscription ?? 0;
  const servicesRev = row.mrr_services ?? 0;
  const connectRev = connectByMonth[m] ?? 0;
  const totalIncome = subRev + servicesRev + connectRev + affiliateRev;

  const newLogos = newSignupsByMonth[m] ?? 0;
  // Profitability metrics are QuickBooks-derived — only meaningful when the P&L
  // has that month; otherwise null (UI shows "—") rather than a misleading 0/100%.
  const cac = pnlAvailable && newLogos > 0 ? snm / newLogos : null;
  const subGM = pnlAvailable && qbSubRev > 0 ? (qbSubRev - ccFees * (qbSubRev / (qbTotalIncome || 1))) / qbSubRev : null;
  const overallGM = pnlAvailable && qbTotalIncome > 0 ? grossProfit / qbTotalIncome : null;
  const servicesGM = pnlAvailable && qbServicesRev > 0 ? (qbServicesRev - servicesCommission) / qbServicesRev : null;
  const logoQty = row.logo_qty ?? null;
  const avgMRR = row.mrr_subscription && logoQty ? row.mrr_subscription / logoQty : null;

  return {
    month: m,
    // revenue = live MRR (complete)
    subscription_revenue: r2(subRev),
    services_revenue: r2(servicesRev),
    connect_revenue: r2(connectRev),
    affiliate_revenue: r2(affiliateRev),
    total_income: r2(totalIncome),
    revenue_source: 'live_mrr',
    // profitability = QuickBooks P&L (null when the month isn't in the P&L yet)
    pnl_available: pnlAvailable,
    cogs: pnlAvailable ? r2(totalCOGS) : null,
    gross_profit: pnlAvailable ? r2(grossProfit) : null,
    gross_margin: overallGM != null ? r3(overallGM) : null,
    subscription_gross_margin: subGM != null ? r3(subGM) : null,
    services_gross_margin: servicesGM != null ? r3(servicesGM) : null,
    snm_expense: pnlAvailable ? r2(snm) : null,
    new_logos: newLogos,
    cac: cac != null ? r2(cac) : null,
    logo_qty: logoQty,
    avg_mrr_per_customer: avgMRR != null ? r2(avgMRR) : null,
    net_op_income: pnlAvailable ? r2(netOp) : null,
  };
});

// ---------- trailing-12-month (TTM) summary ending at latest complete month ----------
const today = new Date();
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const completeMonths = monthly.filter((r) => r.month < currentMonth);
const ttm = completeMonths.slice(-12);

function sum(arr, key) { return arr.reduce((s, r) => s + (r[key] ?? 0), 0); }

// Revenue: full 12-month window (live MRR — complete).
const ttmSubRev = sum(ttm, 'subscription_revenue');
const ttmServicesRev = sum(ttm, 'services_revenue');
const ttmConnectRev = sum(ttm, 'connect_revenue');
const ttmAffiliateRev = sum(ttm, 'affiliate_revenue');
const ttmTotalIncome = sum(ttm, 'total_income');
// Profitability: ONLY the months the P&L actually covers — mixing complete revenue
// with a partial-P&L COGS would inflate margins. Scope + label the coverage.
const ttmPnl = ttm.filter((r) => r.pnl_available);
const pnlMonths = ttmPnl.map((r) => r.month);
const ttmCOGS = sum(ttmPnl, 'cogs');
const ttmGrossProfit = sum(ttmPnl, 'gross_profit');
const ttmSNM = sum(ttmPnl, 'snm_expense');
const ttmNewLogos = sum(ttmPnl, 'new_logos'); // logos over the P&L-covered months (matches S&M spend)
const ttmNetOp = sum(ttmPnl, 'net_op_income');
const ttmPnlTotalIncome = sum(ttmPnl, 'total_income');
const ttmPnlSubRev = sum(ttmPnl, 'subscription_revenue');
const ttmGM = ttmPnlTotalIncome > 0 ? ttmGrossProfit / ttmPnlTotalIncome : null;
const ttmSubGM = ttmPnlSubRev > 0 ? (ttmPnlSubRev - ttmCOGS * (ttmPnlSubRev / (ttmPnlTotalIncome || 1))) / ttmPnlSubRev : null;

const ttmCAC = ttmNewLogos > 0 ? ttmSNM / ttmNewLogos : null;

// Current month stats (for LTV math)
const latest = completeMonths[completeMonths.length - 1];
const avgMRR = latest?.avg_mrr_per_customer ?? null;
const logoQtyNow = latest?.logo_qty ?? null;

// Logo churn from the waterfall's CONFIRMED churned_logos (status=churned), not
// from Logo Qty count-deltas. The old delta method (gross adds − net change)
// mislabeled delinquency, pauses, and annual-payer gaps as churn, overstating
// it (~25% vs the true ~17%). monthly rate = churned logos ÷ starting active
// logos, summed over the window; annualized by compounding. Feeds LTV so the
// customer-lifetime math matches the Scorecard's logo-churn figure.
let totalChurn = 0;
let totalStartingLogos = 0;
for (let i = 1; i < ttm.length; i++) {
  const prev = ttm[i - 1];
  const cur = ttm[i];
  const churn = churnedLogosByMonth[cur.month] ?? 0;
  totalChurn += churn;
  totalStartingLogos += prev.logo_qty ?? 0;
}
const monthlyChurnRate = totalStartingLogos > 0 ? totalChurn / totalStartingLogos : null; // per-month
const annualChurnRate = monthlyChurnRate != null ? 1 - Math.pow(1 - monthlyChurnRate, 12) : null;
// Also carry the waterfall's REVENUE (MRR-dollar) gross churn so the snapshot
// exposes both lenses (small logos churn, big ones stay → revenue churn ≪ logo churn).
const annualRevenueChurnRate = waterfall?.ttm?.annual_gross_churn_rate ?? null;

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

// ---------- Stripe Connect attach (from connect_by_customer_month over TTM) ----------
// A customer "uses Connect" if they earned Allmoxy any Connect revenue in the TTM
// window. Attach rate is vs the active book (logo qty now), since Connect only
// applies to live, paying customers — not the all-time roster.
const ttmConnectMonths = new Set(ttm.map((r) => r.month));
let connectCustomersTtm = 0;
let connectRevTtmFromCust = 0;
for (const r of connectByCust.rows) {
  let total = 0;
  for (const [k, val] of Object.entries(r)) {
    if (ttmConnectMonths.has(k) && typeof val === 'number') total += val;
  }
  if (total > 0) { connectCustomersTtm += 1; connectRevTtmFromCust += total; }
}
const connectAttachRate = logoQtyNow > 0 ? connectCustomersTtm / logoQtyNow : null;
const avgConnectPerConnectCustomer = connectCustomersTtm > 0 ? connectRevTtmFromCust / connectCustomersTtm : null;

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
    // Revenue spans the full 12-month window (live MRR). Profitability (COGS,
    // margins, CAC, LTV) is scoped to the months the QuickBooks P&L actually
    // covers — the UI should caveat margins with this window.
    revenue_basis: 'live_mrr',
    pnl_coverage: { months: pnlMonths.length, start: pnlMonths[0] ?? null, end: pnlMonths[pnlMonths.length - 1] ?? null },
    subscription_revenue: Math.round(ttmSubRev * 100) / 100,
    services_revenue: Math.round(ttmServicesRev * 100) / 100,
    connect_revenue: Math.round(ttmConnectRev * 100) / 100,
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
    annual_logo_churn_rate: annualChurnRate != null ? Math.round(annualChurnRate * 10000) / 10000 : null,
    annual_revenue_churn_rate: annualRevenueChurnRate != null ? Math.round(annualRevenueChurnRate * 10000) / 10000 : null,
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
  connect: {
    customers_using_connect: connectCustomersTtm,
    active_logos: logoQtyNow,
    attach_rate: connectAttachRate != null ? Math.round(connectAttachRate * 10000) / 10000 : null,
    connect_revenue_ttm: Math.round(ttmConnectRev * 100) / 100,
    avg_connect_revenue_per_connect_customer:
      avgConnectPerConnectCustomer != null ? Math.round(avgConnectPerConnectCustomer * 100) / 100 : null,
    avg_monthly_connect_revenue: Math.round((ttmConnectRev / 12) * 100) / 100,
  },
  notes:
    'Revenue (subscription/services/connect) sourced from the LIVE MRR snapshots so every month is current; QuickBooks P&L drives profitability (COGS, margins, CAC, LTV) only for the months it covers (see ttm.pnl_coverage) — recent months show revenue with margins pending the P&L refresh. ' +
    'Unit economics derived from QuickBooks CAC Info P&L × allmoxy_core_customer signups × mrr_by_month logo counts. ' +
    'CAC = (Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission) / new logos. ' +
    'LTV = Avg MRR × Subscription Gross Margin / Monthly Logo Churn Rate. ' +
    'Churn rate derived from Logo Qty deltas and gross signups (aggregate, not per-cohort). ' +
    'All metrics are subscription-only unless stated; services revenue is tracked separately.',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
