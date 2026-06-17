#!/usr/bin/env node
/**
 * Adjusted EBITDA Bridge builder (QoE-5).
 *
 * Produces the canonical bridge a banker / QoE reviewer expects:
 *
 *   GAAP Net Income
 *   + Interest expense (7011)
 *   + Tax expense (7300)
 *   + Depreciation (7400)
 *   + Amortization (7405)
 *   = GAAP EBITDA
 *   + QoE add-backs (owner-comp normalization, one-time costs, discretionary perks, ...)
 *   = Adjusted EBITDA
 *
 * Time windows: YTD-current, latest-month, and TTM (when 12+ months are
 * available in pnl_by_month). Add-backs and signed amounts come from
 * _etl_scripts/ebitda_adjustments.json which the user maintains as the
 * authoritative QoE adjustment register.
 *
 * Output: public/snapshots/ebitda_bridge.json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function round2(n) { return Math.round(n * 100) / 100; }

const pnl = readJson(path.join(SNAP, 'pnl_by_month.json'));
const adjConfig = readJson(path.join(ROOT, '_etl_scripts/ebitda_adjustments.json'));

if (!pnl?.months?.length) {
  console.error('No P&L months available — cannot build EBITDA bridge. Run build_pnl.mjs first.');
  process.exit(1);
}

const months = pnl.months;
const data = pnl.data || {};

// Sum a line item across a window of months (inclusive).
function sumWindow(key, monthList) {
  const series = data[key] || {};
  let total = 0;
  for (const m of monthList) total += Number(series[m] || 0);
  return total;
}

// Identify the EBITDA bridge components from the P&L line items.
// Standard NI → EBITDA additions:
const NI_KEY = 'net_income';
const INTEREST_KEY = 'a_7011_loan_interest';  // 7011 Loan Interest
const TAX_KEY = 'tax_penalties';                // 7300 Tax & Penalties
const DEPRECIATION_KEY = 'depreciation';        // 7400 Depreciation
const AMORTIZATION_KEY = 'amortization';        // 7405 Amortization

// Compose the EBITDA bridge for a given time window.
function buildBridge(windowName, windowMonths) {
  if (!windowMonths.length) return null;

  const monthsInWindow = windowMonths.length;
  const start = windowMonths[0];
  const end = windowMonths[windowMonths.length - 1];

  const net_income = sumWindow(NI_KEY, windowMonths);
  const interest = sumWindow(INTEREST_KEY, windowMonths);
  const tax = sumWindow(TAX_KEY, windowMonths);
  const depreciation = sumWindow(DEPRECIATION_KEY, windowMonths);
  const amortization = sumWindow(AMORTIZATION_KEY, windowMonths);
  const gaap_ebitda = net_income + interest + tax + depreciation + amortization;

  // QoE adjustments — only those targeting this window.
  const qoeAddBacks = (adjConfig?.adjustments || [])
    .filter((a) => (a.applies_to_windows || []).includes(windowName))
    .map((a) => {
      let amount;
      if (typeof a.ytd_total === 'number' && a.ytd_total !== 0) {
        // If a YTD lump is specified, scale only if we're computing a TTM or
        // YTD window. For latest_month, allocate proportionally.
        if (windowName === 'latest_month') {
          amount = a.ytd_total / monthsInWindow > 0 ? a.ytd_total / 12 : 0;
        } else {
          amount = a.ytd_total * (monthsInWindow / 12);
        }
      } else {
        amount = (a.per_month || 0) * monthsInWindow;
      }
      return {
        id: a.id,
        label: a.label,
        category: a.category,
        amount: round2(amount),
        reason: a.reason,
        evidence: a.evidence,
        verified_by: a.verified_by,
        verified_at: a.verified_at,
        is_placeholder: a.is_placeholder === true,
      };
    });

  const qoeAddBackTotal = qoeAddBacks.reduce((s, a) => s + (a.amount || 0), 0);
  const adjusted_ebitda = gaap_ebitda + qoeAddBackTotal;

  const totalRevenue = sumWindow('total_income', windowMonths);
  const ebitdaMargin = totalRevenue > 0 ? gaap_ebitda / totalRevenue : null;
  const adjEbitdaMargin = totalRevenue > 0 ? adjusted_ebitda / totalRevenue : null;

  return {
    window: windowName,
    start,
    end,
    months_in_window: monthsInWindow,
    total_revenue: round2(totalRevenue),
    net_income: round2(net_income),
    add_backs_to_ebitda: [
      { key: 'interest', label: 'Interest expense (7011 Loan Interest)', amount: round2(interest) },
      { key: 'tax', label: 'Taxes (7300 Tax & Penalties)', amount: round2(tax) },
      { key: 'depreciation', label: 'Depreciation (7400)', amount: round2(depreciation) },
      { key: 'amortization', label: 'Amortization (7405)', amount: round2(amortization) },
    ],
    gaap_ebitda: round2(gaap_ebitda),
    gaap_ebitda_margin: ebitdaMargin != null ? round2(ebitdaMargin) : null,
    qoe_adjustments: qoeAddBacks,
    qoe_adjustment_total: round2(qoeAddBackTotal),
    adjusted_ebitda: round2(adjusted_ebitda),
    adjusted_ebitda_margin: adjEbitdaMargin != null ? round2(adjEbitdaMargin) : null,
    placeholder_adjustment_count: qoeAddBacks.filter((a) => a.is_placeholder).length,
  };
}

// Build each requested window
const bridges = {};
const latestMonth = months[months.length - 1];

// YTD current — calendar year of latest month
const ytdYear = latestMonth.slice(0, 4);
const ytdMonths = months.filter((m) => m.startsWith(ytdYear));
bridges.ytd_current = buildBridge('ytd_current', ytdMonths);
bridges.ytd_current.label = `YTD ${ytdYear}`;

// Latest month
bridges.latest_month = buildBridge('latest_month', [latestMonth]);
bridges.latest_month.label = `Latest month (${latestMonth})`;

// TTM — only if we have 12 months available
if (months.length >= 12) {
  const ttmMonths = months.slice(-12);
  bridges.ttm = buildBridge('ttm', ttmMonths);
  bridges.ttm.label = `TTM (${ttmMonths[0]} – ${ttmMonths[ttmMonths.length - 1]})`;
} else {
  bridges.ttm = {
    window: 'ttm',
    label: 'TTM (unavailable)',
    unavailable: true,
    reason: `Only ${months.length} month(s) of P&L data available (${months[0]} – ${latestMonth}). TTM bridge will activate automatically once the QB P&L export covers 12+ months. Upload an extended Profit and Loss xlsx to /Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy+LLC_Profit+and+Loss.xlsx and re-run refresh_all.`,
  };
}

const out = {
  fetched_at: new Date().toISOString(),
  comment:
    'Adjusted EBITDA bridge (QoE-5). GAAP Net Income → standard EBITDA add-backs (interest, tax, D&A) → GAAP EBITDA → QoE adjustments (owner-comp normalization, one-time costs, discretionary perks) → Adjusted EBITDA. Three time windows: YTD, latest month, TTM. QoE add-backs are user-maintained in _etl_scripts/ebitda_adjustments.json. Built by _etl_scripts/build_ebitda_bridge.mjs.',
  source: {
    pnl_months: pnl.months.length,
    pnl_window: `${months[0]} – ${latestMonth}`,
    qoe_adjustment_count: adjConfig?.adjustments?.length ?? 0,
    qoe_adjustments_placeholder_count: (adjConfig?.adjustments || []).filter((a) => a.is_placeholder).length,
  },
  bridges,
};

const outPath = path.join(SNAP, 'ebitda_bridge.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
for (const [name, b] of Object.entries(bridges)) {
  if (b.unavailable) {
    console.log(`  ${name}: unavailable (${months.length} months on file)`);
    continue;
  }
  console.log(`  ${name} (${b.label}):`);
  console.log(`    NI $${b.net_income.toLocaleString()} → GAAP EBITDA $${b.gaap_ebitda.toLocaleString()} (${b.gaap_ebitda_margin != null ? (b.gaap_ebitda_margin * 100).toFixed(1) + '%' : 'n/a'} margin)`);
  console.log(`    QoE adj $${b.qoe_adjustment_total.toLocaleString()} (${b.placeholder_adjustment_count} placeholders) → Adjusted EBITDA $${b.adjusted_ebitda.toLocaleString()} (${b.adjusted_ebitda_margin != null ? (b.adjusted_ebitda_margin * 100).toFixed(1) + '%' : 'n/a'} margin)`);
}
