#!/usr/bin/env node
// Extract the Services by Month tab: header row is months starting 2022-Mar,
// data rows are one per customer with their monthly services revenue.
// Range in the Meta sheet markdown export: L2129 (header) .. L2179 (last customer),
// followed by a totals row on L2180 that we ignore (we recompute totals).

import fs from 'node:fs';

const [, , src] = process.argv;
const HEADER_LINE = 2129;
const LAST_DATA_LINE = 2178;
const SUMMARY_LINE = 2180; // formula-driven monthly totals (authoritative)
const SUMMARY_NUMERIC_OFFSET = 2; // skip "NO_HEADER" + "4" label columns

const lines = fs.readFileSync(src, 'utf8').split('\n');

function unescape(cell) {
  return cell
    .replace(/\\_/g, '_')
    .replace(/\\\*/g, '*')
    .replace(/\\#/g, '#')
    .replace(/\\!/g, '!')
    .replace(/\\\|/g, '|')
    .replace(/\\&/g, '&')
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
  if (raw === '' || raw === '#DIV/0!' || raw === '#REF!' || raw === '#N/A') return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

// Convert "2022-Mar" → "2022-03" for sortable ISO-style month keys.
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function isoMonth(label) {
  const m = label.match(/^(\d{4})-(\w{3})$/);
  if (!m) return null;
  return `${m[1]}-${MONTHS[m[2]]}`;
}

const headerCells = cellsOf(lines[HEADER_LINE - 1]);
// First header cell is blank (customer name column); rest are months.
const monthCols = headerCells.slice(1).map(isoMonth).filter(Boolean);

const rows = [];
for (let i = HEADER_LINE + 1; i <= LAST_DATA_LINE; i++) {
  const line = lines[i - 1];
  if (!line || !line.startsWith('|')) continue;
  const cells = cellsOf(line);
  const name = cells[0];
  if (!name || name === 'NO_HEADER' || /^:-+:$/.test(name)) continue;
  const row = { customer_name: name };
  monthCols.forEach((month, idx) => {
    row[month] = toNumberOrNull(cells[idx + 1] ?? '');
  });
  rows.push(row);
}

// Monthly totals come from the sheet's formula-driven summary row (L2180), not from
// summing the per-customer rows above — those rows are manually curated and stale,
// while the summary row pulls straight from raw Stripe data. User confirmed
// 2026-03 = $34,301.80 (summary) vs ~$4K (per-customer sum).
const summaryCells = cellsOf(lines[SUMMARY_LINE - 1]);
const summaryValues = summaryCells.slice(SUMMARY_NUMERIC_OFFSET);
const monthlyTotals = {};
monthCols.forEach((month, idx) => {
  const v = toNumberOrNull(summaryValues[idx] ?? '');
  if (v !== null) monthlyTotals[month] = v;
});

const perCustomerTotals = {};
for (const month of monthCols) {
  let sum = 0;
  for (const r of rows) {
    const v = r[month];
    if (typeof v === 'number') sum += v;
  }
  perCustomerTotals[month] = Math.round(sum * 100) / 100;
}

const now = new Date();
const out = {
  tab: 'services_by_month',
  sheetId: '18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: ['customer_name', ...monthCols],
  rows,
  rowCount: rows.length,
  monthlyTotals,
  perCustomerTotals,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
