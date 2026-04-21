#!/usr/bin/env node
// Rebuild services_by_month.json using Stripe Sync as the authoritative source.
// Aggregates per-customer monthly services revenue from every transaction with
// transaction_type = 'services' and status = 'succeeded'.

import fs from 'node:fs';
import * as XLSX from '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// Stripe Sync row 2 holds the headers; data starts row 3.
const stripe = XLSX.utils.sheet_to_json(wb.Sheets['Stripe Sync'], { header: 1, defval: null, raw: false });
const hdr = stripe[1];
const H = {};
hdr.forEach((c, i) => { if (c) H[String(c).trim()] = i; });
const I = {
  created: H['Created'],
  amount: H['Amount'],
  status: H['Status'],
  master: H['Master Classification Name'],
  type: H['transaction_type'],
};

function num(s) {
  if (s == null || s === '') return 0;
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// customerName → { months: {month → $}, last_payment: Date }
const byCust = new Map();
const monthlyTotals = {};
const monthSet = new Set();

for (let i = 2; i < stripe.length; i++) {
  const r = stripe[i];
  if (!r) continue;
  const type = r[I.type];
  if (type !== 'services') continue;
  if (r[I.status] !== 'succeeded') continue;
  const created = r[I.created];
  if (!created) continue;
  const m = String(created).slice(0, 7); // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(m)) continue;
  const name = r[I.master] ?? '(unclassified)';
  const amt = num(r[I.amount]);
  if (amt === 0) continue;

  if (!byCust.has(name)) byCust.set(name, { months: {}, last_payment: null, dates_by_month: {} });
  const rec = byCust.get(name);
  rec.months[m] = (rec.months[m] ?? 0) + amt;
  monthlyTotals[m] = (monthlyTotals[m] ?? 0) + amt;
  monthSet.add(m);

  const createdDate = String(created).slice(0, 10); // YYYY-MM-DD
  if (!rec.last_payment || createdDate > rec.last_payment) rec.last_payment = createdDate;
  if (!rec.dates_by_month[m] || createdDate > rec.dates_by_month[m]) rec.dates_by_month[m] = createdDate;
}

// Ordered month list, trimmed to earliest non-zero month forward.
const allMonths = [...monthSet].sort();
const firstMonth = allMonths[0];

// Build ordered month columns from firstMonth through last.
const lastMonth = allMonths[allMonths.length - 1];
function addMonths(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthCols = [];
{
  let cur = firstMonth;
  while (cur <= lastMonth) { monthCols.push(cur); cur = addMonths(cur, 1); }
}

const rows = [];
for (const [name, data] of byCust) {
  const row = { customer_name: name, last_services_payment: data.last_payment, payment_dates: data.dates_by_month };
  for (const m of monthCols) {
    row[m] = data.months[m] != null ? Math.round(data.months[m] * 100) / 100 : null;
  }
  rows.push(row);
}

// Sort rows by lifetime services revenue desc.
rows.sort((a, b) => {
  const aa = Object.entries(a).filter(([k]) => k !== 'customer_name').reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
  const bb = Object.entries(b).filter(([k]) => k !== 'customer_name').reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
  return bb - aa;
});

// Round monthly totals.
for (const m of Object.keys(monthlyTotals)) {
  monthlyTotals[m] = Math.round(monthlyTotals[m] * 100) / 100;
}

const now = new Date();
const out = {
  tab: 'services_by_month',
  sheetId: '18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: ['customer_name', 'last_services_payment', ...monthCols],
  rows,
  rowCount: rows.length,
  monthlyTotals,
  notes:
    `Per-customer services revenue derived from Stripe Sync (authoritative): every transaction with transaction_type='services' and status='succeeded', grouped by Master Classification Name × YYYY-MM of Created. ` +
    `Replaces the stale per-customer curated rows that were in the Meta sheet's Services by Month tab. Monthly totals here reconcile to the sum of the customer rows.`,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
