#!/usr/bin/env node
// Per-customer × per-month subscription MRR, mirroring services_by_month structure.
// Source: MRR by Month tab in the Meta xlsx (553 customer rows × 95 months).

import fs from 'node:fs';
import * as XLSX from '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// ---------- Stripe Sync → latest subscription charge date per (customer, month) ----------
const stripe = XLSX.utils.sheet_to_json(wb.Sheets['Stripe Sync'], { header: 1, defval: null, raw: false });
const sHdr = stripe[1];
const SH = {};
sHdr.forEach((c, i) => { if (c) SH[String(c).trim()] = i; });
const SI = {
  created: SH['Created'],
  status: SH['Status'],
  master: SH['Master Classification Name'],
  type: SH['transaction_type'],
};
const stripeDates = new Map(); // name → { month → latest YYYY-MM-DD }
for (let i = 2; i < stripe.length; i++) {
  const r = stripe[i];
  if (!r) continue;
  if (r[SI.type] !== 'subscription' || r[SI.status] !== 'succeeded') continue;
  const created = r[SI.created];
  if (!created) continue;
  const month = String(created).slice(0, 7);
  const date = String(created).slice(0, 10);
  if (!/^\d{4}-\d{2}$/.test(month)) continue;
  const name = r[SI.master];
  if (!name) continue;
  const trimmed = String(name).trim();
  if (!stripeDates.has(trimmed)) stripeDates.set(trimmed, {});
  const rec = stripeDates.get(trimmed);
  if (!rec[month] || date > rec[month]) rec[month] = date;
}

const aoa = XLSX.utils.sheet_to_json(wb.Sheets['MRR by Month'], { header: 1, defval: null, raw: false });
// Month header at row index 5 (L6): [null, '2018-Jun', ...]; data rows start at 7.
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
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const rows = [];
const monthlyTotals = {};
for (const { month } of monthCols) monthlyTotals[month] = 0;

for (let i = 7; i < aoa.length; i++) {
  const row = aoa[i];
  const name = row?.[0];
  if (!name || !String(name).trim()) continue;
  if (String(name).match(/^Total|Logo Qty|Average|NO_HEADER|^\d+$/)) continue;

  const out = { customer_name: String(name).trim() };
  let hasAny = false;
  let lastMonthWithMrr = null;
  for (const { colIdx, month } of monthCols) {
    const v = parseNum(row[colIdx]);
    if (v != null && v > 0) {
      out[month] = Math.round(v * 100) / 100;
      monthlyTotals[month] += v;
      hasAny = true;
      lastMonthWithMrr = month;
    } else {
      out[month] = null;
    }
  }
  if (hasAny) {
    out.last_mrr_month = lastMonthWithMrr;
    out.payment_dates = stripeDates.get(out.customer_name) ?? {};
    rows.push(out);
  }
}

for (const m of Object.keys(monthlyTotals)) {
  monthlyTotals[m] = Math.round(monthlyTotals[m] * 100) / 100;
}

// Sort by lifetime subscription revenue desc.
rows.sort((a, b) => {
  const aa = Object.entries(a).filter(([k]) => k !== 'customer_name').reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
  const bb = Object.entries(b).filter(([k]) => k !== 'customer_name').reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
  return bb - aa;
});

const now = new Date();
const out = {
  tab: 'subscription_by_month',
  sheetId: '18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: ['customer_name', 'last_mrr_month', ...monthCols.map((c) => c.month)],
  rows,
  rowCount: rows.length,
  monthlyTotals,
  notes: `Per-customer × per-month subscription MRR from the Meta sheet's MRR by Month tab (${rows.length} customers with any historical MRR × ${monthCols.length} months).`,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
