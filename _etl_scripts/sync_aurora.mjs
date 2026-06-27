#!/usr/bin/env node
/**
 * Pull verified-order $ and order COUNTS from the Aurora MySQL warehouse
 * (allmoxy_core), mapped to allmoxy_customer_id. This is the authoritative source
 * for order counts — the monthly meta xlsx carries $ only, no counts
 * (see the "2026 order counts unavailable" note this supersedes).
 *
 * Tables (allmoxy_core):
 *   - instance_verified_orders  per (installation_id, period_year, period_month):
 *                               invoice_total = $ of verified orders that month.
 *   - instance_total_orders     per (installation_id, snapshot_date): value =
 *                               CUMULATIVE order count (running counter snapshot).
 *   - customers                 installer_id -> allmoxy_customer_id (+ name). The
 *                               order tables key on installation_id == installer_id.
 *
 * Data volume is tiny (~353 instances), so we do a full pull each run (no
 * incremental needed). Read-only. Writes cache/aurora_orders.json AND the
 * committed snapshot public/snapshots/aurora_orders.json.
 *
 *   node _etl_scripts/sync_aurora.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_CACHE = path.join(ROOT, '_etl_scripts/cache/aurora_orders.json');
const OUT_SNAP = path.join(ROOT, 'public/snapshots/aurora_orders.json');
fs.mkdirSync(path.dirname(OUT_CACHE), { recursive: true });

const ENV = { ...process.env };
for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && ENV[m[1]] == null) ENV[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!ENV.AURORA_USER || !ENV.AURORA_PASSWORD) throw new Error('Missing AURORA_USER / AURORA_PASSWORD in .env.local');

const r2 = (v) => Math.round(Number(v) * 100) / 100;
const conn = await mysql.createConnection({
  host: ENV.AURORA_HOST,
  port: Number(ENV.AURORA_PORT || 3306),
  user: ENV.AURORA_USER,
  password: ENV.AURORA_PASSWORD,
  database: 'allmoxy_core',
  ssl: { rejectUnauthorized: false },
  connectTimeout: 15000,
});

// installer_id -> { aid, name }
const [custRows] = await conn.query('SELECT allmoxy_customer_id AS aid, name, installer_id FROM customers WHERE installer_id IS NOT NULL');
const instToCust = new Map();
for (const r of custRows) instToCust.set(Number(r.installer_id), { aid: Number(r.aid), name: r.name });

// Verified-order $ by month, per instance.
const [verRows] = await conn.query('SELECT installation_id, period_year, period_month, invoice_total FROM instance_verified_orders');
// Cumulative order counts — latest snapshot per instance.
const [cntRows] = await conn.query(`
  SELECT t.installation_id, t.value, t.snapshot_date
  FROM instance_total_orders t
  JOIN (SELECT installation_id, MAX(snapshot_date) AS d FROM instance_total_orders GROUP BY installation_id) m
    ON m.installation_id = t.installation_id AND m.d = t.snapshot_date`);
await conn.end();

// Aggregate per customer (mapped) + collect unmapped instances separately.
const byCust = new Map();   // aid -> { aid, name, installer_id, verified_by_month, total_orders, total_orders_asof }
const unmapped = new Map(); // installation_id -> { installation_id, verified_by_month, total_orders }
const monthsSeen = new Set();

function bucket(instId) {
  const c = instToCust.get(Number(instId));
  if (c) {
    if (!byCust.has(c.aid)) byCust.set(c.aid, { allmoxy_customer_id: c.aid, name: c.name, installer_id: Number(instId), verified_by_month: {}, total_orders: null, total_orders_asof: null });
    return byCust.get(c.aid);
  }
  if (!unmapped.has(Number(instId))) unmapped.set(Number(instId), { installation_id: Number(instId), verified_by_month: {}, total_orders: null });
  return unmapped.get(Number(instId));
}

for (const v of verRows) {
  const m = `${v.period_year}-${String(v.period_month).padStart(2, '0')}`;
  monthsSeen.add(m);
  const e = bucket(v.installation_id);
  e.verified_by_month[m] = r2(v.invoice_total);
}
let countAsOf = null;
for (const c of cntRows) {
  const e = bucket(c.installation_id);
  e.total_orders = Number(c.value);
  const d = c.snapshot_date instanceof Date ? c.snapshot_date.toISOString().slice(0, 10) : String(c.snapshot_date).slice(0, 10);
  e.total_orders_asof = d;
  if (!countAsOf || d > countAsOf) countAsOf = d;
}

const months = [...monthsSeen].sort();
const customers = [...byCust.values()].sort((a, b) => (b.total_orders || 0) - (a.total_orders || 0));
const unmappedArr = [...unmapped.values()];
const latestMonth = months[months.length - 1] || null;
const totals = {
  customers: customers.length,
  unmapped_instances: unmappedArr.length,
  total_orders_sum: customers.reduce((s, c) => s + (c.total_orders || 0), 0),
  verified_latest_month: latestMonth ? r2(customers.reduce((s, c) => s + (c.verified_by_month[latestMonth] || 0), 0)) : 0,
  verified_months: months.length,
  total_orders_asof: countAsOf,
};

const payload = {
  source: 'aurora:allmoxy_core',
  fetchedAt: new Date().toISOString(),
  note: 'Verified-order $ (monthly) + cumulative order counts per customer, from the Aurora warehouse. installation_id mapped to allmoxy_customer_id via customers.installer_id. Order counts are a running cumulative snapshot; monthly deltas accrue as more daily snapshots land.',
  verified_order_months: months,
  total_orders_asof: countAsOf,
  totals,
  by_customer: customers,
  unmapped_instances: unmappedArr,
};
const json = JSON.stringify(payload, null, 2);
fs.writeFileSync(OUT_CACHE, json);
fs.mkdirSync(path.dirname(OUT_SNAP), { recursive: true });
fs.writeFileSync(OUT_SNAP, json);
console.error(`✓ aurora_orders.json: ${customers.length} customers · ${totals.total_orders_sum.toLocaleString()} cumulative orders (asof ${countAsOf}) · verified months: ${months.join(', ') || 'none'} · ${unmappedArr.length} unmapped instances`);
