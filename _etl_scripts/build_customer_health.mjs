#!/usr/bin/env node
// Build customer_health snapshot: per-customer MRR, concentration, distribution, dunning.
// Sources:
//   - MRR by Month tab (553 customer rows × 95 months of subscription MRR)
//   - Stripe Sync (20K+ transactions: lifetime revenue, recent failed charges)
//   - allmoxy_core_customer (600-row roster with signup dates)

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const SNAPSHOTS = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// ---------- parse MRR by Month ----------
const mrrAoa = XLSX.utils.sheet_to_json(wb.Sheets['MRR by Month'], { header: 1, defval: null, raw: false });
// Row index 5 (L6) is month header: [null, '2018-Jun', '2018-Jul', ...]
// Data rows start at index 7 (L8).
const MONTHS_LUT = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const monthHeader = mrrAoa[5];
const monthCols = [];
for (let i = 1; i < monthHeader.length; i++) {
  const label = monthHeader[i];
  if (!label) continue;
  const m = String(label).match(/^(\d{4})-(\w{3})$/);
  if (!m) continue;
  monthCols.push({ colIdx: i, month: `${m[1]}-${MONTHS_LUT[m[2]]}` });
}

function parseNum(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Find the latest COMPLETE month column (today's month is partial).
const today = new Date();
const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const completeMonthCols = monthCols.filter((c) => c.month < currentMonth);
const latestComplete = completeMonthCols[completeMonthCols.length - 1]; // e.g. {colIdx: ..., month: '2026-03'}

// Build per-customer MRR map (by name → subscription MRR in latest complete month).
const byName = new Map(); // name → { currentMrr, monthlyMrr: {month: val}, everPaid: boolean }
for (let i = 7; i < mrrAoa.length; i++) {
  const row = mrrAoa[i];
  const name = row?.[0];
  if (!name || !String(name).trim()) continue;
  // Skip summary / outlier rows if any
  if (String(name).match(/Total|Logo Qty|Average|NO_HEADER|^\d+$/)) continue;

  const monthlyMrr = {};
  let everPaid = false;
  for (const { colIdx, month } of monthCols) {
    const v = parseNum(row[colIdx]);
    if (v != null && v > 0) {
      monthlyMrr[month] = v;
      everPaid = true;
    }
  }
  byName.set(String(name).trim(), {
    name: String(name).trim(),
    currentMrr: monthlyMrr[latestComplete.month] ?? 0,
    monthlyMrr,
    everPaid,
  });
}

// ---------- parse Stripe Sync for lifetime revenue + dunning ----------
const stripe = XLSX.utils.sheet_to_json(wb.Sheets['Stripe Sync'], { header: 1, defval: null, raw: false });
const stripeHeader = stripe[1];
const S = {};
stripeHeader.forEach((c, i) => { if (c) S[String(c).trim()] = i; });

// Columns we need
const SI = {
  created: S['Created'],
  amount: S['Amount'],
  status: S['Status'],
  desc: S['Description'],
  allmoxy_id: S['allmoxy_customer_id'],
  master_name: S['Master Classification Name'],
};

const lifetimeByCustomer = new Map(); // allmoxy_customer_id → { lifetime_revenue, failed_3mo, failed_3mo_amount, last_failed_at }
const threeMonthsAgo = new Date();
threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

for (let i = 2; i < stripe.length; i++) {
  const row = stripe[i];
  if (!row) continue;
  const id = Number(row[SI.allmoxy_id]);
  if (!Number.isFinite(id)) continue;
  const amt = Number(String(row[SI.amount] ?? '').replace(/[$,\s]/g, ''));
  const status = row[SI.status];
  const masterName = row[SI.master_name];
  const created = row[SI.created];
  const createdDate = created ? new Date(String(created).split(' ')[0]) : null;

  if (!lifetimeByCustomer.has(id)) {
    lifetimeByCustomer.set(id, {
      id,
      master_name: masterName ?? null,
      lifetime_revenue: 0,
      failed_3mo: 0,
      failed_3mo_amount: 0,
      last_failed_at: null,
    });
  }
  const rec = lifetimeByCustomer.get(id);
  if (status === 'succeeded' && Number.isFinite(amt)) rec.lifetime_revenue += amt;
  if (status === 'failed' && createdDate && createdDate >= threeMonthsAgo) {
    rec.failed_3mo += 1;
    rec.failed_3mo_amount += Number.isFinite(amt) ? amt : 0;
    if (!rec.last_failed_at || createdDate > rec.last_failed_at) rec.last_failed_at = createdDate;
  }
  if (masterName && !rec.master_name) rec.master_name = masterName;
}

// ---------- merge core_customer + byName + Stripe Sync ----------
const core = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'allmoxy_core_customer.json'), 'utf8'));

// Build id→name map from core
const coreByName = new Map();
for (const r of core.rows) {
  if (r.name) coreByName.set(r.name.trim().toLowerCase(), r);
}

// Combine MRR data with core data. Match by name (lowercased). Some fuzzy misses expected.
const customers = [];
for (const m of byName.values()) {
  const coreMatch = coreByName.get(m.name.toLowerCase());
  customers.push({
    name: m.name,
    allmoxy_customer_id: coreMatch?.allmoxy_customer_id ?? null,
    sign_up_date: coreMatch?.sign_up_date ?? null,
    current_mrr: Math.round(m.currentMrr * 100) / 100,
    last_month: latestComplete.month,
    months_paying: Object.keys(m.monthlyMrr).length,
    ever_paid: m.everPaid,
  });
}

// Join lifetime revenue by allmoxy_customer_id when we have it.
for (const c of customers) {
  if (c.allmoxy_customer_id != null) {
    const l = lifetimeByCustomer.get(c.allmoxy_customer_id);
    if (l) {
      c.lifetime_revenue = Math.round(l.lifetime_revenue * 100) / 100;
      c.failed_3mo = l.failed_3mo;
      c.failed_3mo_amount = Math.round(l.failed_3mo_amount * 100) / 100;
    }
  }
  c.lifetime_revenue ??= 0;
  c.failed_3mo ??= 0;
  c.failed_3mo_amount ??= 0;
}

// Years as customer
for (const c of customers) {
  if (c.sign_up_date) {
    const d = new Date(c.sign_up_date);
    c.years_with_us = Math.round(((today.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000)) * 10) / 10;
  } else {
    c.years_with_us = null;
  }
}

// ---------- concentration ----------
const activeCustomers = customers.filter((c) => c.current_mrr > 0);
activeCustomers.sort((a, b) => b.current_mrr - a.current_mrr);

const totalMrr = activeCustomers.reduce((s, c) => s + c.current_mrr, 0);
function shareOfTopN(n) {
  const slice = activeCustomers.slice(0, n);
  const mrr = slice.reduce((s, c) => s + c.current_mrr, 0);
  return { n, customers: slice.length, mrr: Math.round(mrr * 100) / 100, pct: totalMrr > 0 ? Math.round((mrr / totalMrr) * 10000) / 10000 : null };
}

const concentration = {
  total_active_customers: activeCustomers.length,
  total_mrr: Math.round(totalMrr * 100) / 100,
  top1: shareOfTopN(1),
  top5: shareOfTopN(5),
  top10: shareOfTopN(10),
  top20: shareOfTopN(20),
};

// ---------- MRR distribution (buckets) ----------
const buckets = [
  { label: '< $100', min: 0, max: 100 },
  { label: '$100–$500', min: 100, max: 500 },
  { label: '$500–$1K', min: 500, max: 1000 },
  { label: '$1K–$2K', min: 1000, max: 2000 },
  { label: '$2K–$5K', min: 2000, max: 5000 },
  { label: '$5K+', min: 5000, max: Infinity },
];
const distribution = buckets.map((b) => {
  const matches = activeCustomers.filter((c) => c.current_mrr >= b.min && c.current_mrr < b.max);
  return {
    bucket: b.label,
    customers: matches.length,
    mrr: Math.round(matches.reduce((s, c) => s + c.current_mrr, 0) * 100) / 100,
  };
});

// ---------- dunning list (failed charges last 3 months) ----------
const dunning = customers
  .filter((c) => c.failed_3mo > 0)
  .sort((a, b) => b.failed_3mo_amount - a.failed_3mo_amount)
  .map((c) => ({
    name: c.name,
    allmoxy_customer_id: c.allmoxy_customer_id,
    current_mrr: c.current_mrr,
    failed_3mo: c.failed_3mo,
    failed_3mo_amount: c.failed_3mo_amount,
  }));

const now = new Date();
const slimCustomer = (c) => ({
  name: c.name,
  allmoxy_customer_id: c.allmoxy_customer_id,
  current_mrr: c.current_mrr,
  lifetime_revenue: c.lifetime_revenue,
  years_with_us: c.years_with_us,
  failed_3mo: c.failed_3mo,
});

const out = {
  tab: 'customer_health',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: [],
  rowCount: 0,
  latestMonth: latestComplete.month,
  concentration,
  distribution: distribution.map((b) => ({
    ...b,
    customers: activeCustomers
      .filter((c) => c.current_mrr >= buckets.find((bb) => bb.label === b.bucket).min && c.current_mrr < buckets.find((bb) => bb.label === b.bucket).max)
      .map(slimCustomer),
  })),
  top_customers: activeCustomers.slice(0, 25).map(slimCustomer),
  all_active_customers: activeCustomers.map(slimCustomer),
  dunning_customers: dunning.slice(0, 50),
  dunning_summary: {
    total_dunning_customers: dunning.length,
    total_at_risk_amount: Math.round(dunning.reduce((s, d) => s + d.failed_3mo_amount, 0) * 100) / 100,
  },
  notes:
    `Per-customer MRR drawn from MRR by Month tab (${activeCustomers.length} customers with MRR > $0 in ${latestComplete.month}). ` +
    'Concentration = top-N current MRR share of subscription MRR total. ' +
    'Lifetime revenue and dunning counts joined from Stripe Sync (20K+ classified transactions). ' +
    'Dunning = charge attempts with status=failed in trailing 3 months.',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
