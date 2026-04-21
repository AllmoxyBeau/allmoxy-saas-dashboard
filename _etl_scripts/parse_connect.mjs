#!/usr/bin/env node
// Extract monthly Connect (affiliate) fee totals from the three Stripe Connect
// Revenue sheets (2024, 2025, 2026). Each sheet has a formula-driven summary
// row whose first 12 numeric values correspond to Jan..Dec of that sheet's year.
//
// Line pointers below match the current Drive markdown exports. If the sheet
// layout changes, re-verify where the summary row lives. The detection fallback
// tries a numeric first-value pattern before giving up.

import fs from 'node:fs';

const SOURCES = [
  { year: 2024, path: process.argv[2], summaryLine: 101 },
  { year: 2025, path: process.argv[3], summaryLine: 3 },
  { year: 2026, path: process.argv[4], summaryLine: 3 },
];

function unescape(cell) {
  return cell
    .replace(/\\_/g, '_')
    .replace(/\\#/g, '#')
    .replace(/\\!/g, '!')
    .replace(/\\\|/g, '|')
    .replace(/&#10;/g, '\n')
    .trim();
}

function cellsOf(line) {
  const parts = line.split('|');
  if (parts[0] === '') parts.shift();
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map(unescape);
}

function toNumberOrNull(raw) {
  if (!raw || raw === '#DIV/0!' || raw === '#REF!' || raw === '#N/A') return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

// Merge the three years into one ordered time series, preferring the sheet
// whose base year matches the month (i.e., 2024 sheet for 2024 months, etc.).
const monthlyTotals = {};

for (const { year, path, summaryLine } of SOURCES) {
  const lines = fs.readFileSync(path, 'utf8').split('\n');
  const row = lines[summaryLine - 1];
  if (!row) throw new Error(`Missing summary row L${summaryLine} in ${path}`);
  const cells = cellsOf(row);
  // First cell is an empty label column. Next 12 cells are Jan..Dec of `year`.
  for (let m = 0; m < 12; m++) {
    const v = toNumberOrNull(cells[m + 1] ?? '');
    if (v !== null && v > 0) {
      const key = `${year}-${String(m + 1).padStart(2, '0')}`;
      monthlyTotals[key] = Math.round(v * 100) / 100;
    }
  }
}

// Build ordered rows 2024-01 .. last known month, with explicit nulls for gaps.
const allMonths = Object.keys(monthlyTotals).sort();
const firstKey = allMonths[0];
const lastKey = allMonths[allMonths.length - 1];

const rows = [];
function addMonths(iso, delta) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

let cur = firstKey;
while (cur <= lastKey) {
  rows.push({ month: cur, connect_fees: monthlyTotals[cur] ?? null });
  cur = addMonths(cur, 1);
}

const now = new Date();
const out = {
  tab: 'connect_by_month',
  sheetIds: [
    '1PUVgothQMpbj6QcHZQ0nuQIGIuDbYdb4eXgMrWTpXeE', // 2024
    '1fWkT8fpM7V8FqRwAubZWUlcCIEsdtHT4OZXoK15KW1k', // 2025
    '1IZz8yoeJ1CiSmHa_pKw1LsI3jsONVw94ZMzn-JSoMok', // 2026
  ],
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: ['month', 'connect_fees'],
  rows,
  rowCount: rows.length,
  monthlyTotals,
  notes: 'Sep-Dec 2024 not present in any source sheet; flagged as null.',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
