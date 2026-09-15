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
const OUT_ROSTER = path.join(ROOT, '_etl_scripts/cache/aurora_customers.json'); // roster spine (replaces xlsx allmoxy_core_customer)
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
// Full customer roster — the source-of-truth spine, replacing the xlsx
// allmoxy_core_customer tab. Same column shape so build_customer_profiles +
// refresh_all consume it unchanged. Excludes internal/own accounts.
const INTERNAL_AIDS = new Set([2080]); // "Allmoxy" — internal account, not a customer
const [custRows] = await conn.query(`SELECT allmoxy_customer_id, name, sign_up_date, hubspot_company_id,
  installer_id, installer_directory, stripe_customer_id_fromhubspot, stripe_customer_id_1,
  stripe_customer_id_2, stripe_customer_id_3, harvest_id, csm_user_id, website, jira_custom_label
  FROM customers WHERE allmoxy_customer_id IS NOT NULL`);
const toIsoDate = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));
const rosterRows = custRows
  .filter((r) => !INTERNAL_AIDS.has(Number(r.allmoxy_customer_id)))
  .map((r) => ({ ...r, allmoxy_customer_id: Number(r.allmoxy_customer_id), sign_up_date: toIsoDate(r.sign_up_date) }))
  .sort((a, b) => a.allmoxy_customer_id - b.allmoxy_customer_id);
fs.writeFileSync(OUT_ROSTER, JSON.stringify({
  source: 'aurora:allmoxy_core.customers',
  fetchedAt: new Date().toISOString(),
  excluded_internal: [...INTERNAL_AIDS],
  rowCount: rosterRows.length,
  rows: rosterRows,
}, null, 2));
console.error(`✓ aurora_customers.json: ${rosterRows.length} roster customers (excl ${INTERNAL_AIDS.size} internal)`);
// installation_id -> customer. Base map = customers.installer_id (1:1). But a
// company has MANY installations; the roster only carries one installer_id each,
// so extra/legacy/migrated installations (e.g. Closet City's original inst 168,
// 30k orders) are unmapped. installation_overrides.json supplies those
// installation_id -> allmoxy_customer_id mappings so every installation rolls up
// to its one Allmoxy ID. Overrides win over the roster.
const instToCust = new Map();
const nameByAid = new Map(rosterRows.map((r) => [r.allmoxy_customer_id, r.name]));
for (const r of rosterRows) if (r.installer_id != null) instToCust.set(Number(r.installer_id), { aid: r.allmoxy_customer_id, name: r.name });
const OVERRIDES_PATH = path.join(__dirname, 'installation_overrides.json');
let overrideCount = 0;
if (fs.existsSync(OVERRIDES_PATH)) {
  try {
    const ov = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8')).overrides || {};
    for (const [instId, o] of Object.entries(ov)) {
      if (o?.aid == null) continue;
      instToCust.set(Number(instId), { aid: Number(o.aid), name: nameByAid.get(Number(o.aid)) || o.name || null });
      overrideCount++;
    }
  } catch (e) { console.error(`[aurora] installation_overrides.json parse failed: ${e.message}`); }
}
console.error(`[aurora] installation map: ${instToCust.size} installations (${overrideCount} via overrides)`);

// Verified-order $ by month, per instance.
const [verRows] = await conn.query('SELECT installation_id, period_year, period_month, invoice_total FROM instance_verified_orders');
// Cumulative order counts — latest snapshot per instance.
const [cntRows] = await conn.query(`
  SELECT t.installation_id, t.value, t.snapshot_date
  FROM instance_total_orders t
  JOIN (SELECT installation_id, MAX(snapshot_date) AS d FROM instance_total_orders GROUP BY installation_id) m
    ON m.installation_id = t.installation_id AND m.d = t.snapshot_date`);

// ── GOLD: modelled verified orders by customer × month (Beau, 2026-09-15: make this
// the source of truth for orders verified, refreshed daily). The dbt table already
// resolves installation_id -> allmoxy_customer_id and carries ORDER COUNTS, which the
// xlsx never had for the current year. It also runs to the current month, where the
// spreadsheet had stalled at 2026-05.
//
// Aggregated per (customer, month) here because 29 customers bill across several
// installations — one has 28 — and leaving the rows split would double-count.
//
// DATA QUALITY IS CARRIED, NOT HIDDEN. Two known defects in the source, flagged per
// row so the build can decide rather than silently publishing them:
//   • order counts repeat verbatim across 2026-01..03 (a carry-forward, not real
//     monthly counts) and are absent for 2026-04..06
//   • the current month has order counts but no dollars yet
let goldRows = [];
try {
  [goldRows] = await conn.query(`
    SELECT allmoxy_customer_id AS aid,
           period_year  AS y,
           period_month AS m,
           SUM(invoice_total)  AS usd,
           SUM(monthly_orders) AS orders,
           COUNT(DISTINCT installation_id) AS installations,
           COUNT(monthly_orders) AS order_rows
    FROM gold_commercial.gold_orders_verified_monthly
    WHERE allmoxy_customer_id IS NOT NULL
    GROUP BY 1, 2, 3`);
} catch (e) {
  console.error(`[aurora] gold_orders_verified_monthly unavailable (${e.message}) — orders_verified will fall back to the xlsx`);
}
await conn.end();

if (goldRows.length) {
  // QUALITY MODEL (measured 2026-09-15, not assumed):
  //   • ANNUAL totals are trustworthy. Summed by year they agree with the hand-kept
  //     xlsx within 0.3% on order counts and 2% on dollars — two independent sources
  //     converging, which is the point of moving to the warehouse.
  //   • MONTHLY detail is NOT real before 2026. 88% of customers carry the identical
  //     invoice_total in all 12 months of 2024 and 2025 — an annual figure spread
  //     evenly, so 12 × the monthly value reconstructs the year. Only 4% look like
  //     that in 2026, so from 2026 the monthly series is genuine.
  // Flagged per customer-year as `even_spread` so the build can total by year safely
  // while refusing to plot a synthetic flat line as a monthly trend.
  const byCustYear = new Map();
  for (const r of goldRows) {
    const k = `${r.aid}|${r.y}`;
    if (!byCustYear.has(k)) byCustYear.set(k, new Set());
    byCustYear.get(k).add(r.usd == null ? 'null' : String(r.usd));
  }
  const evenSpread = new Set();
  for (const [k, vals] of byCustYear) {
    // one distinct value across 12 months = an annual figure divided evenly
    if (vals.size === 1) evenSpread.add(k);
  }

  const out = {
    fetchedAt: new Date().toISOString(),
    source: 'gold_commercial.gold_orders_verified_monthly (Aurora, dbt)',
    note: 'Verified order volume by customer x month. ANNUAL totals are reliable. MONTHLY values before 2026 are an even spread of the annual figure (even_spread=true) and must not be read as a monthly trend. The current month often has order counts before dollars land, so $0 there means "not yet aggregated", not "no orders".',
    by_customer: {},
    months: [],
  };
  const monthSet = new Set();
  for (const r of goldRows) {
    const aid = Number(r.aid);
    const key = `${r.y}-${String(r.m).padStart(2, '0')}`;
    monthSet.add(key);
    if (!out.by_customer[aid]) out.by_customer[aid] = {};
    const prev = out.by_customer[aid][key];
    const usd = r.usd == null ? null : Math.round(Number(r.usd) * 100) / 100;
    const orders = r.orders == null ? null : Math.round(Number(r.orders));
    // A customer can appear on several installation rows for the same month; sum them.
    out.by_customer[aid][key] = {
      usd: prev ? Math.round(((prev.usd || 0) + (usd || 0)) * 100) / 100 : usd,
      orders: prev ? ((prev.orders || 0) + (orders || 0)) || null : orders,
      installations: (prev?.installations || 0) + Number(r.installations),
      even_spread: evenSpread.has(`${r.aid}|${r.y}`),
    };
  }
  out.months = [...monthSet].sort();
  // ORDER COUNTS can also be carried forward: 2026-01..03 repeat one value verbatim
  // while dollars move, so they are not real monthly counts. Flag (never null) the
  // months whose counts match the previous month across the board, so a chart can
  // refuse them while annual totals stay intact.
  const carried = new Set();
  for (let i = 1; i < out.months.length; i++) {
    const cur = out.months[i], prev = out.months[i - 1];
    const pairs = Object.values(out.by_customer)
      .filter((c) => c[cur]?.orders != null && c[prev]?.orders != null);
    if (pairs.length >= 10 && pairs.every((c) => c[cur].orders === c[prev].orders)) carried.add(cur);
  }
  for (const [, mm] of Object.entries(out.by_customer)) {
    for (const [mk, v] of Object.entries(mm)) if (carried.has(mk) && v.orders != null) v.orders_carried_forward = true;
  }
  out.order_counts_carried_forward = [...carried].sort();
  fs.writeFileSync(path.join(ROOT, '_etl_scripts/cache/aurora_orders_verified_monthly.json'), JSON.stringify(out));
  const usdTot = goldRows.reduce((s, r) => s + Number(r.usd || 0), 0);
  const ordTot = goldRows.reduce((s, r) => s + Number(r.orders || 0), 0);
  console.error(`[aurora] gold orders verified: ${Object.keys(out.by_customer).length} customers · ${out.months[0]}→${out.months[out.months.length - 1]} · $${Math.round(usdTot).toLocaleString()} · ${Math.round(ordTot).toLocaleString()} orders · ${evenSpread.size} customer-years are an even annual spread`);
}


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

// SUM across installations (a customer can have many): verified $ per month and
// cumulative order counts accumulate, not overwrite. (Overwriting silently
// dropped a customer's secondary installations, e.g. Closet City's inst 168.)
for (const v of verRows) {
  const m = `${v.period_year}-${String(v.period_month).padStart(2, '0')}`;
  monthsSeen.add(m);
  const e = bucket(v.installation_id);
  e.verified_by_month[m] = r2((e.verified_by_month[m] || 0) + Number(v.invoice_total || 0));
}
let countAsOf = null;
for (const c of cntRows) {
  const e = bucket(c.installation_id);
  e.total_orders = (e.total_orders || 0) + Number(c.value || 0);
  const d = c.snapshot_date instanceof Date ? c.snapshot_date.toISOString().slice(0, 10) : String(c.snapshot_date).slice(0, 10);
  if (!e.total_orders_asof || d > e.total_orders_asof) e.total_orders_asof = d;
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
