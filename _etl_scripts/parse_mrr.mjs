#!/usr/bin/env node
// Extract the 4 MRR-by-Month sections (Subscription / Services / Connect / Blended)
// from the Meta sheet's markdown export and fold them into a single time series.

import fs from 'node:fs';

const [, , src] = process.argv;
const lines = fs.readFileSync(src, 'utf8').split('\n');

function unescape(cell) {
  return cell
    .replace(/\\_/g, '_')
    .replace(/\\\*/g, '*')
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
  if (raw === '' || raw === '#DIV/0!' || raw === '#REF!' || raw === '#N/A') return null;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

// Find all rows whose first cell equals `label` (exact match).
function findAllRows(label) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('| ')) continue;
    const cells = cellsOf(l);
    if (cells[0] === label) out.push({ lineIdx: i, cells });
  }
  return out;
}

// Pull each stream's summary rows by section order in the sheet.
// Order matches the vertical layout: Subscription (0), Services (1), Connect (2), Blended (3).
const totalRows = findAllRows('Total MRR');
const logoRows = findAllRows('Logo Qty');
const avgRows = findAllRows('Average MRR Per Customer');

if (totalRows.length < 4 || logoRows.length < 4) {
  console.error(
    `Expected 4 stream sections, found Total=${totalRows.length}, Logo=${logoRows.length}. ` +
      `Sheet layout may have changed — re-verify section order.`
  );
  process.exit(1);
}

const vals = (row) => row.cells.slice(1).map(toNumberOrNull);
const sub = vals(totalRows[0]);
const svc = vals(totalRows[1]);
const conn = vals(totalRows[2]);
const blended = vals(totalRows[3]);
const logoBlended = vals(logoRows[3]);
const avgBlended = vals(avgRows[3] ?? avgRows[0]);

// Months start 2018-06 and walk forward; we trim trailing all-empty months below.
const len = Math.max(sub.length, svc.length, conn.length, blended.length, logoBlended.length);
const rows = [];
let year = 2018;
let month = 6;
for (let i = 0; i < len; i++) {
  const mm = String(month).padStart(2, '0');
  rows.push({
    month: `${year}-${mm}`,
    logo_qty: logoBlended[i] ?? null,
    mrr_subscription: sub[i] ?? null,
    mrr_services: svc[i] ?? null,
    mrr_connect: conn[i] ?? null,
    mrr_blended: blended[i] ?? null,
    avg_mrr_blended: avgBlended[i] ?? null,
  });
  month++;
  if (month > 12) { month = 1; year++; }
}

// Trim trailing months where every metric is null/zero (padding past current date).
while (rows.length > 0) {
  const last = rows[rows.length - 1];
  const empty = (v) => v === null || v === 0;
  if (empty(last.logo_qty) && empty(last.mrr_blended) && empty(last.mrr_subscription) && empty(last.mrr_services)) {
    rows.pop();
  } else break;
}

const now = new Date();
const out = {
  tab: 'mrr_by_month',
  sheetId: '18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [
    'month',
    'logo_qty',
    'mrr_subscription',
    'mrr_services',
    'mrr_connect',
    'mrr_blended',
    'avg_mrr_blended',
  ],
  rows,
  rowCount: rows.length,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
