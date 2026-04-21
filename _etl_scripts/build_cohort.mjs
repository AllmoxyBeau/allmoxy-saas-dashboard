#!/usr/bin/env node
// Build cohort retention snapshot by MERGING two customer rosters:
//   - allmoxy_core_customer (historical, 2009-2020, complete for those years)
//   - classification_master (current, filtered to customers paying in 2026)
//
// A customer's cohort = year of their sign-up / first-payment date.
// A customer is "currently active" iff they appear in classification_master
// (which is filtered to 2026 payers).
// Logo retention per cohort = (active today) / (initial cohort size).
//
// We also compute a per-month dollar allocation for customers we can trace
// (i.e., those in classification_master), labeled clearly as approximate.

import fs from 'node:fs';
import path from 'node:path';

const SNAPSHOTS =
  process.argv[2] ||
  '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

const classification = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'classification_master.json'), 'utf8'));
const core = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'allmoxy_core_customer.json'), 'utf8'));
const mrr = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'mrr_by_month.json'), 'utf8'));
const services = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'services_by_month.json'), 'utf8'));

// ---------- date parsing ----------
function parseMDY(s) {
  if (!s || s === '#N/A') return null;
  const [m, d, y] = s.split('/').map((x) => Number(x.trim()));
  if (!y || !m) return null;
  return new Date(y, m - 1, d || 1);
}
function parseYMD(s) {
  if (!s) return null;
  const [y, m, d] = s.split('-').map((x) => Number(x.trim()));
  if (!y || !m) return null;
  return new Date(y, m - 1, d || 1);
}
function isoMonth(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function monthStart(iso) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
function monthEnd(iso) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m, 0, 23, 59, 59);
}
function addMonths(iso, delta) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return isoMonth(d);
}

// ---------- build merged roster ----------
// Each customer keyed by allmoxy_customer_id.
// Fields: {signup, firstPay, lastPay, streams, active, sourceCore, sourceClass}
const roster = new Map();

for (const r of core.rows) {
  const id = r.allmoxy_customer_id;
  if (id == null) continue;
  const signup = parseYMD(r.sign_up_date);
  if (!signup) continue;
  roster.set(id, {
    id,
    name: r.name,
    signup,
    firstPay: null,
    lastPay: null,
    streams: new Set(),
    sourceCore: true,
    sourceClass: false,
  });
}

for (const r of classification.rows) {
  const id = r.allmoxy_customer_id;
  if (id == null) continue;
  const fp = parseMDY(r['First Payment Date']);
  const lp = parseMDY(r['Last Payment Date']);
  const existing = roster.get(id);
  if (existing) {
    existing.sourceClass = true;
    existing.firstPay = existing.firstPay && fp ? (fp < existing.firstPay ? fp : existing.firstPay) : fp ?? existing.firstPay;
    existing.lastPay = existing.lastPay && lp ? (lp > existing.lastPay ? lp : existing.lastPay) : lp ?? existing.lastPay;
    if (r.transaction_type) existing.streams.add(r.transaction_type);
  } else {
    // No core_customer record — customer signed up after 2020. Use First Payment Date as signup proxy.
    if (!fp) continue;
    roster.set(id, {
      id,
      name: r['Master Classification Name'] ?? null,
      signup: fp,
      firstPay: fp,
      lastPay: lp,
      streams: new Set(r.transaction_type ? [r.transaction_type] : []),
      sourceCore: false,
      sourceClass: true,
    });
  }
}

// "Active today" = present in classification_master with a 2026 Last Payment Date.
for (const c of roster.values()) {
  c.active = c.sourceClass && c.lastPay && c.lastPay.getFullYear() === 2026;
}

const allCustomers = [...roster.values()];

// ---------- per-cohort summary (primary view) ----------
const byCohort = new Map();
for (const c of allCustomers) {
  const y = c.signup.getFullYear();
  if (!byCohort.has(y)) byCohort.set(y, { year: y, initial: 0, active: 0, churned: 0, customers: [] });
  const b = byCohort.get(y);
  b.initial += 1;
  if (c.active) b.active += 1;
  else b.churned += 1;
  b.customers.push(c);
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

// ---------- monthly logos per cohort (line chart source) ----------
// Traceable customers (sourceClass) have firstPay/lastPay dates, so we can plot them.
// Non-traceable (sourceCore only) we count as active from signup month until we lose them:
// since we don't know their actual churn date, we conservatively mark them as active until
// the last month we have Logo Qty data where classification_master is known to be the
// authoritative source (i.e., until today's Logo Qty starts under-counting them).
// For the chart we stick to TRACEABLE customers so that the cohort line matches reality.

const firstDataMonth = mrr.rows[0]?.month ?? '2018-06';
const today = new Date();
const currentMonth = isoMonth(today);
const months = [];
{
  let cur = firstDataMonth;
  while (cur <= currentMonth) {
    months.push(cur);
    cur = addMonths(cur, 1);
  }
}

const cohortYears = [...byCohort.keys()].sort((a, b) => a - b);

const activeByCohort = {};
for (const m of months) {
  const mStart = monthStart(m);
  const mEnd = monthEnd(m);
  const bucket = {};
  for (const c of allCustomers) {
    // Only plot traceable customers; non-traceables we can't place on a month-by-month axis.
    if (!c.firstPay || !c.lastPay) continue;
    if (c.firstPay > mEnd) continue;
    if (c.lastPay < mStart) continue;
    const y = c.signup.getFullYear();
    if (!bucket[y]) bucket[y] = { subscription: 0, services: 0, unique: 0 };
    bucket[y].unique += 1;
    if (c.streams.has('subscription')) bucket[y].subscription += 1;
    if (c.streams.has('services')) bucket[y].services += 1;
  }
  activeByCohort[m] = bucket;
}

// ---------- dollar allocation (approximate, labeled as such) ----------
const svcTotals = services.monthlyTotals ?? {};
const mrrRowByMonth = Object.fromEntries(mrr.rows.map((r) => [r.month, r]));

const dollarByCohort = {};
for (const m of months) {
  const subTotal = mrrRowByMonth[m]?.mrr_subscription ?? 0;
  const svcTotal = svcTotals[m] ?? 0;
  const act = activeByCohort[m];
  let totalSub = 0;
  let totalSvc = 0;
  for (const y of cohortYears) {
    const a = act[y];
    if (!a) continue;
    totalSub += a.subscription;
    totalSvc += a.services;
  }
  const bucket = {};
  for (const y of cohortYears) {
    const a = act[y];
    if (!a) continue;
    const sub = totalSub > 0 ? (subTotal * a.subscription) / totalSub : 0;
    const svc = totalSvc > 0 ? (svcTotal * a.services) / totalSvc : 0;
    bucket[y] = {
      subscription: Math.round(sub * 100) / 100,
      services: Math.round(svc * 100) / 100,
      total: Math.round((sub + svc) * 100) / 100,
    };
  }
  dollarByCohort[m] = bucket;
}

// ---------- logos over time per cohort ----------
const cohortLogosOverTime = {};
for (const y of cohortYears) {
  cohortLogosOverTime[y] = months.map((m) => {
    const a = activeByCohort[m]?.[y] ?? { subscription: 0, services: 0, unique: 0 };
    return { month: m, logos: a.unique };
  });
}

const now = new Date();
const out = {
  tab: 'cohort_retention',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: [],
  rowCount: 0,
  notes:
    'Cohort signups merged from allmoxy_core_customer (2009-2020, ' +
    core.rowCount +
    ' customers) and classification_master (2021-2026 backfill + current status). ' +
    'Currently-active = present in classification_master with 2026 last-payment. ' +
    'Dollar allocation is a logo-weighted estimate across traceable customers only; Connect stream is excluded (no per-customer attribution).',
  totalCustomers: allCustomers.length,
  activeToday: allCustomers.filter((c) => c.active).length,
  cohortSummary,
  cohortYears,
  cohortLogosOverTime,
  dollarByCohort,
  activeByCohortMonth: activeByCohort,
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
