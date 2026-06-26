#!/usr/bin/env node
// Rebuild cohort snapshot from the local xlsx export.
// Uses:
//   - allmoxy_core_customer tab (full roster, 600 customers, signup dates)
//   - Stripe Sync tab's classification side-columns (20K+ classified transactions
//     → aggregate per customer for first/last payment dates)
//   - MRR by Month summary row (for subscription monthly totals, dollar allocation)
//   - services_by_month snapshot (already correct from earlier)

import fs from 'node:fs';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';
import path from 'node:path';

const XLSX_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const SNAPSHOTS = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// ---------- date parsing helpers ----------
function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str || str === '#N/A') return null;
  // YYYY-MM-DD HH:MM:SS or YYYY-MM-DD
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(str)) {
    const [y, m, d] = str.split(/[-\s:]/).slice(0, 3).map(Number);
    return new Date(y, m - 1, d || 1);
  }
  // M/D/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(str)) {
    const [m, d, y] = str.split('/').map(Number);
    return new Date(y, m - 1, d || 1);
  }
  return null;
}
function isoMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- parse allmoxy_core_customer (600 row roster) ----------
const coreRaw = XLSX.utils.sheet_to_json(wb.Sheets['allmoxy_core_customer'], { range: 1, defval: null, raw: false });
const customers = new Map(); // allmoxy_customer_id -> { id, name, signup, firstPay, lastPay, streams, charges, revenue }
for (const r of coreRaw) {
  const id = Number(r.allmoxy_customer_id);
  if (!Number.isFinite(id)) continue;
  customers.set(id, {
    id,
    name: String(r.name ?? '').trim(),
    signup: parseDate(r.sign_up_date),
    firstPay: null,
    lastPay: null,
    streams: new Set(),
    charges: 0,
    revenue: 0,
  });
}

// ---------- parse Stripe Sync tab's classification side-columns ----------
const stripe = XLSX.utils.sheet_to_json(wb.Sheets['Stripe Sync'], { header: 1, defval: null, raw: false });
const hdr = stripe[1];
const H = {};
hdr.forEach((c, i) => { if (c) H[String(c).trim()] = i; });
const IDX = {
  created: H['Created'],
  amount: H['Amount'],
  net: H['Net amount'],
  status: H['Status'],
  allmoxy_id: H['allmoxy_customer_id'],
  transaction_type: H['transaction_type'],
  first_pay: H['First Payment Date'] ?? H['First Payment Date '],
  last_pay: H['Last Payment Date'],
};

for (let i = 2; i < stripe.length; i++) {
  const row = stripe[i];
  if (!row) continue;
  const id = Number(row[IDX.allmoxy_id]);
  if (!Number.isFinite(id)) continue;
  let c = customers.get(id);
  if (!c) {
    // Customer exists in Stripe but not in allmoxy_core_customer — add a stub.
    c = { id, name: null, signup: null, firstPay: null, lastPay: null, streams: new Set(), charges: 0, revenue: 0 };
    customers.set(id, c);
  }
  const created = parseDate(row[IDX.created]);
  const amt = Number(String(row[IDX.amount] ?? '').replace(/[$,]/g, ''));
  const status = row[IDX.status];
  const tx = row[IDX.transaction_type];
  if (tx) c.streams.add(String(tx).toLowerCase());
  if (created) {
    if (!c.firstPay || created < c.firstPay) c.firstPay = created;
    if (!c.lastPay || created > c.lastPay) c.lastPay = created;
  }
  if (status === 'succeeded' && Number.isFinite(amt)) {
    c.charges += 1;
    c.revenue += amt;
  }
}

// If a customer has no signup date from core_customer, use their firstPay.
for (const c of customers.values()) {
  if (!c.signup && c.firstPay) c.signup = c.firstPay;
}

// "Active today" = last payment was in 2026 (current year).
const today = new Date();
for (const c of customers.values()) {
  c.active = !!(c.lastPay && c.lastPay.getFullYear() >= today.getFullYear());
}

// Cohort membership requires actually-processed revenue. A signup date alone
// isn't enough — never-paid signups (e.g. California Door Corporation, $0) are
// not customers and would inflate logo counts / depress retention. Keep anyone
// with a payment date or positive lifetime revenue (a fully-refunded customer
// still "processed revenue", so firstPay alone qualifies them).
const allCustomers = [...customers.values()].filter((c) => c.revenue > 0 || c.firstPay);

// ---------- cohort summary by signup year ----------
const byCohort = new Map();
for (const c of allCustomers) {
  const y = (c.signup ?? c.firstPay).getFullYear();
  if (!byCohort.has(y)) byCohort.set(y, { year: y, initial: 0, active: 0, churned: 0 });
  const b = byCohort.get(y);
  b.initial += 1;
  if (c.active) b.active += 1;
  else b.churned += 1;
}
const cohortSummary = [...byCohort.values()]
  .sort((a, b) => a.year - b.year)
  .map((b) => ({
    year: b.year,
    initial: b.initial,
    active: b.active,
    churned: b.churned,
    retentionPct: b.initial > 0 ? Math.round((100 * b.active) / b.initial * 10) / 10 : null,
  }));

// ---------- per-cohort active customer count per month ----------
const mrr = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'mrr_by_month.json'), 'utf8'));
const services = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'services_by_month.json'), 'utf8'));
const months = mrr.rows.map((r) => r.month);

function activeInMonth(c, iso) {
  if (!c.firstPay || !c.lastPay) return false;
  const [y, m] = iso.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd = new Date(y, m, 0, 23, 59, 59);
  return c.firstPay <= monthEnd && c.lastPay >= monthStart;
}

const cohortYears = [...byCohort.keys()].sort((a, b) => a - b);
const activeByCohort = {};
for (const mo of months) {
  const bucket = {};
  for (const c of allCustomers) {
    if (!activeInMonth(c, mo)) continue;
    const y = (c.signup ?? c.firstPay).getFullYear();
    if (!bucket[y]) bucket[y] = { subscription: 0, services: 0, unique: 0 };
    bucket[y].unique += 1;
    if (c.streams.has('subscription')) bucket[y].subscription += 1;
    if (c.streams.has('services')) bucket[y].services += 1;
  }
  activeByCohort[mo] = bucket;
}

// ---------- dollar allocation ----------
const svcTotals = services.monthlyTotals ?? {};
const mrrRowByMonth = Object.fromEntries(mrr.rows.map((r) => [r.month, r]));
const dollarByCohort = {};
for (const mo of months) {
  const subTotal = mrrRowByMonth[mo]?.mrr_subscription ?? 0;
  const svcTotal = svcTotals[mo] ?? 0;
  const act = activeByCohort[mo];
  let totalSub = 0, totalSvc = 0;
  for (const y of cohortYears) {
    const a = act[y]; if (!a) continue;
    totalSub += a.subscription;
    totalSvc += a.services;
  }
  const bucket = {};
  for (const y of cohortYears) {
    const a = act[y]; if (!a) continue;
    const sub = totalSub > 0 ? (subTotal * a.subscription) / totalSub : 0;
    const svc = totalSvc > 0 ? (svcTotal * a.services) / totalSvc : 0;
    bucket[y] = {
      subscription: Math.round(sub * 100) / 100,
      services: Math.round(svc * 100) / 100,
      total: Math.round((sub + svc) * 100) / 100,
    };
  }
  dollarByCohort[mo] = bucket;
}

// ---------- retention triangle (for heatmap UI) ----------
// Baseline = December of cohort year (cohort is fully formed by then).
// For the current year, use the latest complete month.
const currentMonth = isoMonth(today);
const lastComplete = months.filter((m) => m < currentMonth).slice(-1)[0];
function addYears(iso, n) {
  const [y, m] = iso.split('-').map(Number);
  return `${y + n}-${String(m).padStart(2, '0')}`;
}

function slimCustomer(c) {
  return {
    allmoxy_customer_id: c.id,
    name: c.name,
    first_payment: c.firstPay ? c.firstPay.toISOString().slice(0, 10) : null,
    last_payment: c.lastPay ? c.lastPay.toISOString().slice(0, 10) : null,
    streams: [...c.streams],
    lifetime_revenue: Math.round(c.revenue * 100) / 100,
    active_today: c.active,
  };
}

// Subscription-only retention (services excluded — it's project revenue, not recurring).
// Services is tracked separately for unit economics / LTV analysis on its own page.
const cohortTriangle = {};
for (const y of cohortYears) {
  const dec = `${y}-12`;
  const baseline = dec <= lastComplete ? dec : lastComplete;
  const baseLogos = activeByCohort[baseline]?.[y]?.unique ?? 0;
  const baseSubDollar = dollarByCohort[baseline]?.[y]?.subscription ?? 0;
  const series = [];
  let offset = 0;
  while (true) {
    const m = addYears(baseline, offset);
    if (m > lastComplete) break;
    const active = activeByCohort[m]?.[y] ?? { subscription: 0, services: 0, unique: 0 };
    const dollar = dollarByCohort[m]?.[y] ?? { subscription: 0, services: 0, total: 0 };
    series.push({
      yearsSince: offset,
      month: m,
      activeLogos: active.unique,
      subscription: dollar.subscription,
      services: dollar.services,
      logoRetentionPct: baseLogos > 0 ? Math.round((100 * active.unique) / baseLogos * 10) / 10 : null,
      dollarRetentionPct:
        baseSubDollar > 0 ? Math.round((100 * dollar.subscription) / baseSubDollar * 10) / 10 : null,
    });
    offset += 1;
  }
  const cohortMembers = allCustomers
    .filter((c) => (c.signup ?? c.firstPay).getFullYear() === y)
    .map(slimCustomer)
    .sort((a, b) => b.lifetime_revenue - a.lifetime_revenue);

  cohortTriangle[y] = {
    baselineMonth: baseline,
    baselineLogos: baseLogos,
    baselineDollar: baseSubDollar,
    initialLogos: byCohort.get(y).initial,
    series,
    members: cohortMembers,
  };
}

const now = new Date();
const out = {
  tab: 'cohort_retention',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: [],
  rowCount: 0,
  totalCustomers: allCustomers.length,
  activeToday: allCustomers.filter((c) => c.active).length,
  cohortSummary,
  cohortYears,
  cohortTriangle,
  dollarByCohort,
  activeByCohortMonth: activeByCohort,
  notes:
    `Built from full local xlsx: ${coreRaw.length} rows of allmoxy_core_customer + ${(stripe.length - 2).toLocaleString()} Stripe Sync transactions (classified). ` +
    'Currently-active = customer has a 2026 Stripe charge. Dollar retention is a logo-weighted estimate of SUBSCRIPTION MRR only — services (project-based, non-recurring) and Connect (no per-customer attribution) are both excluded so the recurring-revenue story isn\'t inflated by one-off invoices.',
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
