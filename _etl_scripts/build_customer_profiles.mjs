#!/usr/bin/env node
// Build a comprehensive per-customer profile snapshot for the Customer Detail page.
// One row per allmoxy_customer_id with:
//   - identity (name, stripe ids, hubspot id, installer directory, signup date)
//   - lifetime totals by stream (subscription / services / connect)
//   - current MRR + active flag + dunning counts
//   - monthly_history: { month → {subscription, services, connect} }
//   - transactions: [{created, amount, type, status, description}]  (all Stripe charges)
//   - cohort_year + milestones (first_payment_date, last_payment_date, peak_month)

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const SNAPSHOTS = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// ---------- allmoxy_core_customer → roster ----------
const coreRaw = XLSX.utils.sheet_to_json(wb.Sheets['allmoxy_core_customer'], { range: 1, defval: null, raw: false });
const coreById = new Map();
for (const r of coreRaw) {
  const id = Number(r.allmoxy_customer_id);
  if (!Number.isFinite(id)) continue;
  const stripeIds = [r.stripe_customer_id_fromhubspot, r.stripe_customer_id_1, r.stripe_customer_id_2, r.stripe_customer_id_3]
    .filter((x) => x && String(x).startsWith('cus_'));
  coreById.set(id, {
    allmoxy_customer_id: id,
    name: String(r.name ?? '').trim(),
    sign_up_date: r.sign_up_date ?? null,
    hubspot_company_id: r.hubspot_company_id ? String(r.hubspot_company_id) : null,
    installer_id: r.installer_id ? String(r.installer_id) : null,
    installer_directory: r.installer_directory ?? null,
    stripe_customer_ids: stripeIds,
    harvest_id: r.harvest_id ? String(r.harvest_id) : null,
  });
}

// ---------- Stripe Sync → per-customer transactions + classification fields ----------
const stripe = XLSX.utils.sheet_to_json(wb.Sheets['Stripe Sync'], { header: 1, defval: null, raw: false });
const hdr = stripe[1];
const H = {};
hdr.forEach((c, i) => { if (c) H[String(c).trim()] = i; });
const SI = {
  created: H['Created'],
  amount: H['Amount'],
  status: H['Status'],
  description: H['Description'],
  amountRefunded: H['Amount Refunded'],
  netAmount: H['Net amount'],
  allmoxy_id: H['allmoxy_customer_id'],
  master_name: H['Master Classification Name'],
  transaction_type: H['transaction_type'],
  signup_date: H['signup_date'],
  first_payment: H['First Payment Date'] ?? H['First Payment Date '],
  last_payment: H['Last Payment Date'],
  pay_status: H['pay_status'],
};

function numClean(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Collect per-customer transactions + metadata.
const byCust = new Map(); // id → { txns: [], streamLifetime: {sub, svc, connect}, meta: {...} }

for (let i = 2; i < stripe.length; i++) {
  const row = stripe[i];
  if (!row) continue;
  const id = Number(row[SI.allmoxy_id]);
  if (!Number.isFinite(id)) continue;
  const created = row[SI.created];
  const amount = numClean(row[SI.amount]);
  const status = row[SI.status];
  const desc = row[SI.description] ? String(row[SI.description]).trim() : '';
  const type = row[SI.transaction_type] ? String(row[SI.transaction_type]).toLowerCase() : null;

  if (!byCust.has(id)) {
    byCust.set(id, {
      id,
      txns: [],
      lifetime_subscription: 0,
      lifetime_services: 0,
      lifetime_other: 0,
      meta_master_name: row[SI.master_name] ?? null,
      meta_signup_date: row[SI.signup_date] ?? null,
      meta_first_payment: row[SI.first_payment] ?? null,
      meta_last_payment: row[SI.last_payment] ?? null,
      meta_pay_status: row[SI.pay_status] ?? null,
    });
  }
  const rec = byCust.get(id);

  rec.txns.push({
    created: created ? String(created) : null,
    amount: Math.round(amount * 100) / 100,
    type,
    status,
    description: desc,
  });

  if (status === 'succeeded') {
    if (type === 'subscription') rec.lifetime_subscription += amount;
    else if (type === 'services') rec.lifetime_services += amount;
    else rec.lifetime_other += amount;
  }
}

// Sort each customer's transactions by date descending (newest first).
for (const rec of byCust.values()) {
  rec.txns.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
}

// ---------- Connect per-customer monthly (from snapshot built earlier) ----------
const connectSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'connect_by_customer_month.json'), 'utf8'));
// Connect rows keyed by customer_name only (not allmoxy_id), so we'll match by name.
const connectByName = new Map();
for (const r of connectSnap.rows) {
  if (!r.customer_name) continue;
  const monthly = {};
  let lifetime = 0;
  for (const [k, v] of Object.entries(r)) {
    if (k === 'customer_name') continue;
    if (typeof v === 'number' && v > 0) {
      monthly[k] = v;
      lifetime += v;
    }
  }
  connectByName.set(r.customer_name.trim().toLowerCase(), { monthly, lifetime: Math.round(lifetime * 100) / 100 });
}

// ---------- subscription + services per-customer monthly ----------
const subSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'subscription_by_month.json'), 'utf8'));
const subByName = new Map();
for (const r of subSnap.rows) {
  if (!r.customer_name) continue;
  const monthly = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'customer_name' || k === 'last_mrr_month' || k === 'payment_dates') continue;
    if (typeof v === 'number' && v > 0) monthly[k] = v;
  }
  subByName.set(r.customer_name.trim().toLowerCase(), { monthly, last_mrr_month: r.last_mrr_month });
}

const svcSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'services_by_month.json'), 'utf8'));
const svcByName = new Map();
for (const r of svcSnap.rows) {
  if (!r.customer_name) continue;
  const monthly = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'customer_name' || k === 'last_services_payment' || k === 'payment_dates') continue;
    if (typeof v === 'number' && v > 0) monthly[k] = v;
  }
  svcByName.set(r.customer_name.trim().toLowerCase(), { monthly });
}

// ---------- customer_health → current_mrr + failed_3mo ----------
const healthSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'customer_health.json'), 'utf8'));
const healthById = new Map();
for (const c of healthSnap.all_active_customers ?? []) {
  if (c.allmoxy_customer_id != null) healthById.set(c.allmoxy_customer_id, c);
}

// ---------- build unified roster ----------
const allIds = new Set([...coreById.keys(), ...byCust.keys()]);

function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str || str === '#N/A') return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(str)) return str.slice(0, 10);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(str)) {
    const [m, d, y] = str.split('/').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

const today = new Date();
const latestCompleteMonth = (() => {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

const profiles = [];
for (const id of allIds) {
  const core = coreById.get(id);
  const sync = byCust.get(id);
  const health = healthById.get(id);

  const name = (core?.name || sync?.meta_master_name || '').trim();
  if (!name) continue;

  // Payment dates — prefer sync's Stripe-derived, fall back to Meta sheet's string fields.
  let firstPay = null, lastPay = null;
  if (sync && sync.txns.length > 0) {
    const succeeded = sync.txns.filter((t) => t.status === 'succeeded' && t.created);
    if (succeeded.length > 0) {
      const dates = succeeded.map((t) => String(t.created).slice(0, 10)).sort();
      firstPay = dates[0];
      lastPay = dates[dates.length - 1];
    }
  }
  if (!firstPay && sync?.meta_first_payment) firstPay = parseDate(sync.meta_first_payment);
  if (!lastPay && sync?.meta_last_payment) lastPay = parseDate(sync.meta_last_payment);

  const signup = parseDate(core?.sign_up_date) ?? firstPay;
  const activeToday = !!(lastPay && lastPay >= `${today.getFullYear()}-01-01`);

  // Build merged monthly history: {month → {subscription, services, connect}}
  const nameKey = name.toLowerCase();
  const sub = subByName.get(nameKey)?.monthly ?? {};
  const svc = svcByName.get(nameKey)?.monthly ?? {};
  const conn = connectByName.get(nameKey)?.monthly ?? {};
  const allMonths = new Set([...Object.keys(sub), ...Object.keys(svc), ...Object.keys(conn)]);
  const monthlyHistory = {};
  let peakMonth = null;
  let peakMonthTotal = 0;
  for (const m of [...allMonths].sort()) {
    const s = sub[m] ?? 0;
    const v = svc[m] ?? 0;
    const c = conn[m] ?? 0;
    const total = s + v + c;
    monthlyHistory[m] = {
      subscription: Math.round(s * 100) / 100,
      services: Math.round(v * 100) / 100,
      connect: Math.round(c * 100) / 100,
      total: Math.round(total * 100) / 100,
    };
    if (total > peakMonthTotal) { peakMonthTotal = total; peakMonth = m; }
  }

  const lifetimeSub = sync ? Math.round(sync.lifetime_subscription * 100) / 100 : 0;
  const lifetimeSvc = sync ? Math.round(sync.lifetime_services * 100) / 100 : 0;
  const lifetimeConnect = connectByName.get(nameKey)?.lifetime ?? 0;
  const lifetimeOther = sync ? Math.round(sync.lifetime_other * 100) / 100 : 0;
  const lifetimeTotal = Math.round((lifetimeSub + lifetimeSvc + lifetimeConnect + lifetimeOther) * 100) / 100;

  const currentMrr = sub[latestCompleteMonth] ?? health?.current_mrr ?? 0;
  const currentServices = svc[latestCompleteMonth] ?? 0;
  const currentConnect = conn[latestCompleteMonth] ?? 0;

  const cohortYear = firstPay ? Number(firstPay.slice(0, 4)) : (signup ? Number(signup.slice(0, 4)) : null);

  const yearsWithUs = firstPay
    ? Math.round(((today.getTime() - new Date(firstPay).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) * 10) / 10
    : null;

  // Failed charges in trailing 3 months
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const threeMoIso = threeMonthsAgo.toISOString().slice(0, 10);
  const recentFailed = (sync?.txns ?? []).filter(
    (t) => t.status === 'failed' && String(t.created ?? '').slice(0, 10) >= threeMoIso
  );
  const failed3mo = recentFailed.length;
  const failed3moAmount = Math.round(recentFailed.reduce((s, t) => s + t.amount, 0) * 100) / 100;

  const status = activeToday ? (failed3mo > 0 ? 'at_risk' : 'active') : 'churned';

  profiles.push({
    allmoxy_customer_id: id,
    name,
    hubspot_company_id: core?.hubspot_company_id ?? null,
    installer_id: core?.installer_id ?? null,
    installer_directory: core?.installer_directory ?? null,
    stripe_customer_ids: core?.stripe_customer_ids ?? [],
    harvest_id: core?.harvest_id ?? null,
    master_classification_name: sync?.meta_master_name ?? null,
    sign_up_date: signup,
    first_payment_date: firstPay,
    last_payment_date: lastPay,
    years_with_us: yearsWithUs,
    cohort_year: cohortYear,
    status,
    active_today: activeToday,
    lifetime_total: lifetimeTotal,
    lifetime_subscription: lifetimeSub,
    lifetime_services: lifetimeSvc,
    lifetime_connect: Math.round(lifetimeConnect * 100) / 100,
    lifetime_other: lifetimeOther,
    current_subscription_mrr: Math.round(currentMrr * 100) / 100,
    current_services: Math.round(currentServices * 100) / 100,
    current_connect: Math.round(currentConnect * 100) / 100,
    latest_month: latestCompleteMonth,
    failed_3mo_count: failed3mo,
    failed_3mo_amount: failed3moAmount,
    peak_month: peakMonth,
    peak_month_total: Math.round(peakMonthTotal * 100) / 100,
    transaction_count: sync?.txns.length ?? 0,
    monthly_history: monthlyHistory,
    transactions: sync?.txns ?? [],
  });
}

// Sort by lifetime total desc for default ordering.
profiles.sort((a, b) => b.lifetime_total - a.lifetime_total);

const now = new Date();
const out = {
  tab: 'customer_profiles',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: profiles,
  rowCount: profiles.length,
  notes:
    `Per-customer comprehensive profile derived from allmoxy_core_customer, Stripe Sync (${stripe.length - 2} classified transactions), ` +
    'subscription_by_month, services_by_month, connect_by_customer_month, and customer_health snapshots. ' +
    'Each profile includes identity, lifetime totals by stream, monthly history, and all Stripe transactions for that customer.',
};

process.stdout.write(JSON.stringify(out) + '\n');
