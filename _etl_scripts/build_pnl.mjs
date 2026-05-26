#!/usr/bin/env node
// Build a full monthly P&L snapshot from the standalone QuickBooks P&L export.
// Source: Allmoxy+LLC_Profit+and+Loss.xlsx (single sheet "Profit and Loss",
// header at row index 4, last column is "Total" which we ignore).
// Output: public/snapshots/pnl_by_month.json
//
// Schema:
//   {
//     tab, fetchedAt, cachedUntil, columns, rows, rowCount,
//     months: string[],                    // chronological YYYY-MM
//     lineItems: { key, label, section, isTotal?, parentKey?, depth? }[],
//     data: { [key]: { [month]: number } } // per-account per-month dollars
//   }
//
// Hierarchy: each line item has an optional `parentKey` pointing at another key.
// Items with `parentKey === undefined` are top-level (rendered always); items
// with a `parentKey` are children rendered only when their parent is expanded.
// Auto-discovery walks the QB sheet to populate leaf-level accounts under any
// "Total X" subtotal in LINE_ITEMS (e.g. Total 6010 Developer Payroll Expenses
// gains 6011-6014 children automatically).

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy+LLC_Profit+and+Loss.xlsx';
const SNAPSHOTS = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });
const ws = wb.Sheets['Profit and Loss'];
const range = XLSX.utils.decode_range(ws['!ref']);

// QuickBooks export quirk: cached `v` values are 0 for every numeric cell.
// Leaf cells store the actual value in `f` as a bare literal (e.g. f:'14176.10').
// Subtotal cells store an additive formula referencing other cells (e.g. f:'(B18)-(B25)').
// We resolve cells by parsing the formula and recursively evaluating cell refs.
function cellByAddr(addr) {
  return ws[addr];
}
function evalFormula(f, depth = 0) {
  if (depth > 50 || typeof f !== 'string') return 0;
  // Strip a leading '=' if present.
  const expr = f.startsWith('=') ? f.slice(1) : f;
  // Pure numeric / arithmetic literal (no letters): e.g. "14176.10", "1.5+2".
  if (/^[\s\d.()+\-*/]+$/.test(expr)) {
    try { return new Function(`return (${expr})`)() || 0; } catch { return 0; }
  }
  // Substitute every cell reference with the resolved numeric value.
  const replaced = expr.replace(/[A-Z]+\d+/g, (ref) => {
    const cell = cellByAddr(ref);
    if (!cell) return '0';
    let v = 0;
    if (typeof cell.v === 'number' && cell.v !== 0) v = cell.v;
    else if (typeof cell.f === 'string') v = evalFormula(cell.f, depth + 1);
    else if (typeof cell.v === 'number') v = cell.v;
    return `(${v})`;
  });
  try { return new Function(`return (${replaced})`)() || 0; } catch { return 0; }
}
function cellNumber(r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return 0;
  if (typeof cell.v === 'number' && cell.v !== 0) return cell.v;
  if (typeof cell.f === 'string') return evalFormula(cell.f);
  if (typeof cell.v === 'number') return cell.v;
  if (typeof cell.v === 'string') {
    const n = Number(cell.v.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function cellString(r, c) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  if (!cell) return null;
  if (cell.v != null) return String(cell.v);
  return null;
}

// Header at row index 4: [null, 'Jan 2018', ..., 'Mar 2026', 'Total']
const HEADER_ROW = 4;
const FIRST_DATA_ROW = HEADER_ROW + 1;
const monthCols = [];
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
for (let c = 1; c <= range.e.c; c++) {
  const label = cellString(HEADER_ROW, c);
  if (!label) continue;
  const m = label.match(/^(\w{3})\s+(\d{4})$/);
  if (!m) continue;
  monthCols.push({ colIdx: c, month: `${m[2]}-${MONTHS[m[1]]}` });
}
const months = monthCols.map((c) => c.month);

function rowIndent(r) {
  const a = cellString(r, 0);
  if (!a) return 0;
  return Math.floor((a.length - a.trimStart().length) / 3);
}
function findRowByName(needle) {
  for (let r = FIRST_DATA_ROW; r <= range.e.r; r++) {
    const a = cellString(r, 0);
    if (a && a.trim() === needle) return r;
  }
  return -1;
}
function findRowAndIndent(needle) {
  for (let r = FIRST_DATA_ROW; r <= range.e.r; r++) {
    const a = cellString(r, 0);
    if (a && a.trim() === needle) return { row: r, indent: rowIndent(r) };
  }
  return { row: -1, indent: 0 };
}
function slugKey(account) {
  let key = account.toLowerCase()
    .replace(/^total /, 'total_')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (/^\d/.test(key)) key = 'a_' + key;
  return key;
}

// Each line item: key, label, exact account name in the QB tab, section, isTotal flag,
// optional parentKey (if it's a child of a category subtotal).
// Order here drives visual order on the page.
const LINE_ITEMS = [
  // ----- Income (children of total_income) -----
  { key: 'subscription_revenue', label: '4000 Monthly Subscription', account: '4000 Monthly Subscription', section: 'revenue', parentKey: 'total_income' },
  { key: 'subscription_tax', label: '4050 Monthly Subscription Tax', account: '4050 Monthly Subscription Tax', section: 'revenue', parentKey: 'total_income' },
  { key: 'annual_deferred', label: '4100 Annual Deferred Monthly', account: '4100 Annual Deferred Monthly', section: 'revenue', parentKey: 'total_income' },
  { key: 'stripe_fee_income', label: '4200 Stripe Fee Income', account: '4200 Stripe Fee Income', section: 'revenue', parentKey: 'total_income' },
  { key: 'services_revenue', label: '4300 Services Income', account: '4300 Services Income', section: 'revenue', parentKey: 'total_income' },
  { key: 'events_income', label: '4400 Events Income', account: '4400 Events Income', section: 'revenue', parentKey: 'total_income' },
  { key: 'billable_expense_income', label: '4500 Billable Expense Income', account: '4500 Billable Expense Income', section: 'revenue', parentKey: 'total_income' },
  { key: 'affiliate_revenue', label: '4600 Affiliate Referral Income', account: '4600 Affiliate Referral Income', section: 'revenue', parentKey: 'total_income' },
  { key: 'misc_income', label: '4700 Miscellaneous Income', account: 'Total 4700 Miscellaneous Income', section: 'revenue', parentKey: 'total_income' },
  { key: 'total_income', label: 'Total Income', account: 'Total Income', section: 'revenue_total', isTotal: true },

  // ----- Cost of Goods Sold (children of total_cogs) -----
  { key: 'cc_fees', label: '5000 Credit Card Acceptance Fees', account: '5000 Credit Card Acceptance Fees', section: 'cogs', parentKey: 'total_cogs' },
  { key: 'billable_expenses', label: '5100 Billable Expenses', account: '5100 Billable Expenses', section: 'cogs', parentKey: 'total_cogs' },
  { key: 'sales_commission', label: '5200 Sales Commission', account: '5200 Sales Commission', section: 'cogs', parentKey: 'total_cogs' },
  { key: 'services_commission', label: '5300 Services Commissions', account: '5300 Services Commissions', section: 'cogs', parentKey: 'total_cogs' },
  { key: 'affiliate_commission', label: '5400 Affilliate Commissions', account: '5400 Affilliate Commissions', section: 'cogs', parentKey: 'total_cogs' },
  { key: 'total_cogs', label: 'Total Cost of Goods Sold', account: 'Total Cost of Goods Sold', section: 'cogs_total', isTotal: true },

  // ----- Gross Profit (top-level subtotal) -----
  { key: 'gross_profit', label: 'Gross Profit', account: 'Gross Profit', section: 'gross_profit', isTotal: true },

  // ----- Operating Expenses (children of total_expenses) -----
  { key: 'developer_payroll', label: '6010 Developer Payroll', account: 'Total 6010 Developer Payroll Expenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'admin_payroll', label: '6020 Administrative Payroll', account: 'Total 6020 Administrative Payroll Expenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'cs_payroll', label: '6030 Customer Success Payroll', account: 'Total 6030 Customer Success Payroll Expenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'services_payroll', label: '6040 Services Payroll', account: 'Total 6040 Services Payroll Expenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'marketing_payroll', label: '6050 Marketing Payroll', account: 'Total 6050 Marketing Payroll Expenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'other_payroll', label: 'Other Payroll', account: 'Total 6000 Payroll Expenses', section: 'opex', parentKey: 'total_expenses', subtractKeys: ['developer_payroll', 'admin_payroll', 'cs_payroll', 'services_payroll', 'marketing_payroll'] },
  { key: 'erc_fees', label: '6075 ERC Fees', account: '6075 ERC Fees', section: 'opex', parentKey: 'total_expenses' },
  { key: 'office_utilities', label: '6100 Office & Utilities', account: 'Total 6100 Office and Utilities', section: 'opex', parentKey: 'total_expenses' },
  { key: 'software_subs', label: '6200 Software Subscriptions', account: '6200 Software Subscr. and Iternet', section: 'opex', parentKey: 'total_expenses' },
  { key: 'marketing_advertising', label: '6300 Marketing & Advertising', account: 'Total 6300 Marketing and Advertising', section: 'opex', parentKey: 'total_expenses' },
  { key: 'travel', label: '6400 Travel', account: 'Total 6400 Travel Expenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'hosting_fee', label: '6490 Hosting Fee', account: '6490 Hosting Fee', section: 'opex', parentKey: 'total_expenses' },
  { key: 'sales_expenses', label: '6500 Sales Expenses', account: 'Total 6500 Sales Expenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'office_supplies', label: '6600 Office Supplies', account: '6600 Office Supplies', section: 'opex', parentKey: 'total_expenses' },
  { key: 'insurance', label: '6700 Insurance & Licenses', account: 'Total 6700 Insurance and Licenses', section: 'opex', parentKey: 'total_expenses' },
  { key: 'professional_services', label: '6800 Professional Services', account: 'Total 6800 Professional Services', section: 'opex', parentKey: 'total_expenses' },
  { key: 'meals', label: '6900 Meals & Entertainment', account: '6900 Meals and Entertainment', section: 'opex', parentKey: 'total_expenses' },
  { key: 'banking', label: '7000 Banking & Interest', account: 'Total 7000 Banking and Interest', section: 'opex', parentKey: 'total_expenses' },
  { key: 'charitable', label: '7100 Charitable Contributions', account: '7100 Charitable Contributions', section: 'opex', parentKey: 'total_expenses' },
  { key: 'culture', label: '7200 Culture & Team Building', account: 'Total 7200 Culture & Team Building', section: 'opex', parentKey: 'total_expenses' },
  { key: 'tax_penalties', label: '7300 Tax & Penalties', account: '7300 Tax and Penalties', section: 'opex', parentKey: 'total_expenses' },
  { key: 'depreciation', label: '7400 Depreciation', account: '7400 Depreciation Expense', section: 'opex', parentKey: 'total_expenses' },
  { key: 'amortization', label: '7405 Amortization', account: '7405 Amortization Expense', section: 'opex', parentKey: 'total_expenses' },
  { key: 'total_expenses', label: 'Total Operating Expenses', account: 'Total Expenses', section: 'opex_total', isTotal: true },

  // ----- Net Op Income (top-level subtotal) -----
  { key: 'net_op_income', label: 'Net Operating Income', account: 'Net Operating Income', section: 'net_op_income', isTotal: true },

  // ----- Other Income / Expenses (top-level) -----
  { key: 'other_income_total', label: 'Other Income', account: 'Total Other Income', section: 'other_income' },
  { key: 'other_expenses_total', label: 'Other Expenses', account: 'Total Other Expenses', section: 'other_expenses' },
  { key: 'net_other_income', label: 'Net Other Income', account: 'Net Other Income', section: 'net_other_income', isTotal: true },

  // ----- Net Income (top-level) -----
  { key: 'net_income', label: 'Net Income', account: 'Net Income', section: 'net_income', isTotal: true },
];

// Resolve each line item's row index, then pull per-month values.
const data = {};
const missing = [];
const allItems = [...LINE_ITEMS]; // base items + auto-discovered children
const knownAccounts = new Set(LINE_ITEMS.map((li) => li.account));
const knownKeys = new Set(LINE_ITEMS.map((li) => li.key));

for (const item of LINE_ITEMS) {
  const rowIdx = findRowByName(item.account);
  data[item.key] = {};
  if (rowIdx < 0) {
    missing.push(item.account);
    for (const m of months) data[item.key][m] = 0;
    continue;
  }
  for (const { colIdx, month } of monthCols) {
    data[item.key][month] = Math.round(cellNumber(rowIdx, colIdx) * 100) / 100;
  }
}

// Post-process: derived line items that subtract other keys (e.g., "Other Payroll"
// = Total 6000 - sum of named payroll subcategories).
for (const item of LINE_ITEMS) {
  if (!item.subtractKeys) continue;
  for (const m of months) {
    let v = data[item.key][m] ?? 0;
    for (const sk of item.subtractKeys) v -= data[sk]?.[m] ?? 0;
    data[item.key][m] = Math.round(v * 100) / 100;
  }
}

// Auto-discovery: for each LINE_ITEM whose `account` is "Total X", walk the
// sheet to find the matching "X" header and pull every direct child between
// header+1 and the subtotal row. Recurse into nested subtotals.
function discoverChildrenOf(parent, parentRow, parentIndent, parentDepth) {
  const parentName = parent.account;
  if (!parentName.startsWith('Total ')) return;
  const headerName = parentName.slice('Total '.length);
  let headerRow = -1;
  for (let r = parentRow - 1; r >= FIRST_DATA_ROW; r--) {
    const a = cellString(r, 0); if (!a) continue;
    const indent = rowIndent(r);
    const trimmed = a.trim();
    if (indent === parentIndent && trimmed === headerName) { headerRow = r; break; }
    if (indent < parentIndent) break;
  }
  if (headerRow < 0) return;

  const childIndent = parentIndent + 1;
  // Identify any "Total Y" subtotals at child indent in this range — their
  // matching "Y" headers should be skipped (subtotal represents the group).
  const skipHeaders = new Set();
  for (let r = headerRow + 1; r < parentRow; r++) {
    const a = cellString(r, 0); if (!a) continue;
    if (rowIndent(r) === childIndent) {
      const trimmed = a.trim();
      if (trimmed.startsWith('Total ')) skipHeaders.add(trimmed.slice('Total '.length));
    }
  }

  for (let r = headerRow + 1; r < parentRow; r++) {
    const a = cellString(r, 0); if (!a) continue;
    if (rowIndent(r) !== childIndent) continue;
    const trimmed = a.trim();
    if (skipHeaders.has(trimmed)) continue; // header whose Total is included
    if (knownAccounts.has(trimmed)) continue; // already in canonical LINE_ITEMS

    const isTotal = trimmed.startsWith('Total ');
    let key = slugKey(trimmed);
    while (knownKeys.has(key)) key += '_x';
    knownKeys.add(key);
    knownAccounts.add(trimmed);

    const child = {
      key,
      label: trimmed.replace(/^Total /, ''),
      account: trimmed,
      section: parent.section,
      isTotal,
      parentKey: parent.key,
      depth: parentDepth + 1,
    };
    allItems.push(child);
    data[key] = {};
    for (const { colIdx, month } of monthCols) {
      data[key][month] = Math.round(cellNumber(r, colIdx) * 100) / 100;
    }
    if (isTotal) discoverChildrenOf(child, r, childIndent, parentDepth + 1);
  }
}

for (const li of LINE_ITEMS) {
  if (!li.account.startsWith('Total ')) continue;
  const { row, indent } = findRowAndIndent(li.account);
  if (row < 0) continue;
  discoverChildrenOf(li, row, indent, 0);
}

const now = new Date();
const out = {
  tab: 'pnl_by_month',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: ['key', 'label', 'section', ...months],
  rows: [],
  rowCount: allItems.length,
  months,
  lineItems: allItems.map(({ key, label, section, isTotal, parentKey, depth }) => ({
    key,
    label,
    section,
    isTotal: !!isTotal,
    ...(parentKey ? { parentKey } : {}),
    ...(depth ? { depth } : {}),
  })),
  data,
  notes: `Full P&L per month sourced from Allmoxy+LLC_Profit+and+Loss.xlsx (Profit and Loss tab). ${allItems.length} line items (${LINE_ITEMS.length} canonical + ${allItems.length - LINE_ITEMS.length} auto-discovered children) × ${months.length} months. ` +
    (missing.length > 0 ? `WARNING: ${missing.length} accounts not found in QB tab: ${missing.join(' | ')}` : 'All canonical accounts resolved.'),
};

const target = path.join(SNAPSHOTS, 'pnl_by_month.json');
fs.writeFileSync(target, JSON.stringify(out));
const sizeKb = Math.round(fs.statSync(target).size / 1024);
console.log(`  wrote pnl_by_month.json (${sizeKb} KB) — ${allItems.length} line items (${LINE_ITEMS.length} canonical + ${allItems.length - LINE_ITEMS.length} discovered) × ${months.length} months${missing.length > 0 ? ` (${missing.length} missing accounts: see notes)` : ''}`);
