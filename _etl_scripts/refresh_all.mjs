#!/usr/bin/env node
// Full snapshot refresh driven from local xlsx files. Replaces the old
// markdown-stdin pipeline (which depended on Claude Drive-MCP exports).
//
// Produces all 13 snapshots in public/snapshots/. Fills gaps that the
// generation-A scripts can't cover (mrr_by_month, services_by_month,
// classification_master, connect_by_customer_month, connect_by_month)
// with inline xlsx-direct parsers, and delegates the rest to the existing
// generation-B scripts via dynamic import.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const SOURCE_DIR = '/Users/beaulewis/projects/2 - Allmoxy - CFO/';
const PRIMARY_XLSX = path.join(SOURCE_DIR, 'Allmoxy - Meta Data Reconcile Tool.xlsx');
const SNAPSHOTS = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';
const SCRIPTS = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/_etl_scripts';
const OVERRIDES = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/connect_customer_overrides.json';

const PRIMARY_SHEET_ID = '18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30';

const CONNECT_FILES = [
  { year: '2018-2019', path: 'Stripe Connect Revenue 2018-2019.xlsx', id: '13lM8xxyEi0z8JbyGnB9bM6c7GCPyDNV9DQInNKgOJbc' },
  { year: '2020-2021', path: 'Stripe Connect Revenue 2020-2021.xlsx', id: '1ccaPs6fvAvHH64DJfmyBNpntNlt-TZMePalrkgucGFY' },
  { year: '2022-23',   path: 'Stripe Connect Revenue 2022-23.xlsx',   id: '1wXKDKLfYf9fkV5zN_CnO0cyERVDYlozI-nCoIr0-3RI' },
  { year: '2024',      path: 'Stripe Connect Revenue 2024.xlsx',      id: '1PUVgothQMpbj6QcHZQ0nuQIGIuDbYdb4eXgMrWTpXeE' },
  { year: '2025',      path: 'Stripe Connect Revenue 2025.xlsx',      id: '1fWkT8fpM7V8FqRwAubZWUlcCIEsdtHT4OZXoK15KW1k' },
  { year: '2026',      path: 'Stripe Connect Revenue 2026.xlsx',      id: '1IZz8yoeJ1CiSmHa_pKw1LsI3jsONVw94ZMzn-JSoMok' },
];

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

const now = () => new Date();
const nowMeta = () => {
  const n = now();
  return { fetchedAt: n.toISOString(), cachedUntil: new Date(n.getTime() + 5 * 60 * 1000).toISOString() };
};

function parseNum(raw) {
  if (raw == null || raw === '' || raw === '#DIV/0!' || raw === '#REF!' || raw === '#N/A') return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function isoFromLabel(label) {
  const m = String(label).match(/^(\d{4})-(\w{3})$/);
  return m ? `${m[1]}-${MONTHS[m[2]]}` : null;
}
function readWb(filePath) {
  return XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
}

fs.mkdirSync(SNAPSHOTS, { recursive: true });

function writeSnap(name, obj) {
  const p = path.join(SNAPSHOTS, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  const size = fs.statSync(p).size;
  const sz = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${(size / 1024).toFixed(0)} KB`;
  console.log(`  wrote ${name}.json (${sz})`);
}

// ========= Batch 1: raw tab pulls =========

function buildCoreCustomer(wb) {
  const raw = XLSX.utils.sheet_to_json(wb.Sheets['allmoxy_core_customer'], { range: 1, defval: null, raw: false });
  const rows = raw
    .filter((r) => r.allmoxy_customer_id != null && String(r.allmoxy_customer_id).trim() !== '')
    .map((r) => {
      const stripeIds = [r.stripe_customer_id_fromhubspot, r.stripe_customer_id_1, r.stripe_customer_id_2, r.stripe_customer_id_3]
        .filter((x) => x && String(x).startsWith('cus_'));
      return {
        allmoxy_customer_id: Number(r.allmoxy_customer_id),
        name: String(r.name ?? '').trim(),
        sign_up_date: String(r.sign_up_date ?? '').trim() || null,
        hubspot_company_id: r.hubspot_company_id != null ? String(r.hubspot_company_id) : null,
        installer_id: r.installer_id != null ? String(r.installer_id) : null,
        installer_directory: r.installer_directory ? String(r.installer_directory).trim() : null,
        stripe_customer_ids: stripeIds,
        harvest_id: r.harvest_id != null ? String(r.harvest_id) : null,
      };
    });
  return {
    tab: 'allmoxy_core_customer',
    sheetId: PRIMARY_SHEET_ID,
    ...nowMeta(),
    columns: ['allmoxy_customer_id', 'name', 'sign_up_date', 'hubspot_company_id', 'installer_id', 'installer_directory', 'stripe_customer_ids', 'harvest_id'],
    rows,
    rowCount: rows.length,
    notes: 'Full customer roster from the allmoxy_core_customer tab of the local xlsx.',
  };
}

function buildClassificationMaster(wb) {
  // Tab is "Master Classification" (despite REFRESH_DATA.md calling it classification_master).
  // Row 0 is the header; data starts at row 1.
  const sheet = wb.Sheets['Master Classification'];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
  const header = (aoa[0] || []).map((h) => (h == null ? '' : String(h).trim()));
  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r) continue;
    const row = {};
    let hasAny = false;
    for (let j = 0; j < header.length; j++) {
      const key = header[j];
      if (!key) continue;
      const v = r[j];
      if (v != null && v !== '') hasAny = true;
      row[key] = v;
    }
    if (!hasAny) continue;
    // Coerce a couple of fields to numbers where it makes sense.
    if (row.allmoxy_customer_id != null && row.allmoxy_customer_id !== '') {
      const n = Number(row.allmoxy_customer_id);
      if (Number.isFinite(n)) row.allmoxy_customer_id = n;
    }
    rows.push(row);
  }
  return {
    tab: 'classification_master',
    sheetId: PRIMARY_SHEET_ID,
    ...nowMeta(),
    columns: header.filter(Boolean),
    rows,
    rowCount: rows.length,
    notes: 'Master Classification tab (per-customer latest attributes + First/Last Payment dates) from the local xlsx.',
  };
}

// ========= Connect-by-customer-month =========
//
// The original `build_connect_by_customer.mjs` reads pre-exported markdown of
// only 2024/2025/2026. We replace that by reading every `Data for Pivot` tab
// directly from the 6 annual Connect xlsx files and grouping transactions by
// (customer_name, YYYY-MM). The older files (2018-19, 2020-21, 2022-23) have
// `#N/A` customer names, so we build an acct_id → name index from the newer
// files (2024-26) and fall back to the overrides file.

function buildAcctNameIndex() {
  const idx = new Map();
  for (const f of CONNECT_FILES) {
    const wb = readWb(path.join(SOURCE_DIR, f.path));
    const sh = wb.Sheets['Data for Pivot'];
    if (!sh) continue;
    const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: null, raw: false });
    for (const row of aoa) {
      if (!row) continue;
      const acct = row[0];
      const name = row[1];
      if (!acct || !name || name === '#N/A') continue;
      const trimmed = String(name).trim();
      if (!trimmed) continue;
      if (!idx.has(acct)) idx.set(acct, trimmed);
    }
  }
  return idx;
}

function parseConnectDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // MM/DD/YYYY
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}`;
  // YYYY-MM-DD (with optional time)
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}`;
  return null;
}

function buildConnectByCustomerMonth(acctIndex) {
  // customer_name → { month → sum }
  const byCust = new Map();
  const monthSet = new Set();
  const unknownAccts = new Set();

  for (const f of CONNECT_FILES) {
    const wb = readWb(path.join(SOURCE_DIR, f.path));
    const sh = wb.Sheets['Data for Pivot'];
    if (!sh) continue;
    const aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: null, raw: false });
    for (const row of aoa) {
      if (!row) continue;
      const acct = row[0];
      let name = row[1];
      const amount = parseNum(row[2]);
      const month = parseConnectDate(row[3]);
      if (!amount || !month) continue;
      if (!name || name === '#N/A' || String(name).trim() === '') {
        name = acctIndex.get(acct) ?? null;
      }
      if (!name) {
        if (acct) unknownAccts.add(acct);
        continue;
      }
      const trimmed = String(name).trim();
      if (!byCust.has(trimmed)) byCust.set(trimmed, {});
      const rec = byCust.get(trimmed);
      rec[month] = (rec[month] ?? 0) + amount;
      monthSet.add(month);
    }
  }

  const monthCols = [...monthSet].sort();
  const rows = [];
  const monthlyTotals = Object.fromEntries(monthCols.map((m) => [m, 0]));

  for (const [name, months] of byCust) {
    const row = { customer_name: name };
    for (const m of monthCols) {
      const v = months[m];
      if (v != null && v > 0) {
        const rounded = Math.round(v * 100) / 100;
        row[m] = rounded;
        monthlyTotals[m] += v;
      } else {
        row[m] = null;
      }
    }
    rows.push(row);
  }
  for (const m of Object.keys(monthlyTotals)) monthlyTotals[m] = Math.round(monthlyTotals[m] * 100) / 100;

  rows.sort((a, b) => {
    const sum = (r) => Object.entries(r).filter(([k]) => k !== 'customer_name').reduce((s, [, v]) => s + (typeof v === 'number' ? v : 0), 0);
    return sum(b) - sum(a);
  });

  return {
    tab: 'connect_by_customer_month',
    sheetIds: CONNECT_FILES.map((f) => f.id),
    ...nowMeta(),
    columns: ['customer_name', ...monthCols],
    rows,
    rowCount: rows.length,
    monthlyTotals,
    unknownAccountsCount: unknownAccts.size,
    notes:
      `Per-customer Connect (affiliate) fee revenue unioned from all 6 Stripe Connect xlsx files' Data for Pivot tabs (${rows.length} unique customers × ${monthCols.length} months). ` +
      'Older files (2018-2019, 2020-2021, 2022-23) lack inline customer names; names resolved via acct_id index from newer files (2024-26). ' +
      (unknownAccts.size > 0 ? `${unknownAccts.size} Stripe Connect acct_ids could not be resolved to a customer and were skipped.` : ''),
  };
}

function buildConnectByMonth(connectByCust) {
  const monthCols = connectByCust.columns.slice(1); // drop customer_name
  const rows = monthCols.map((month) => ({
    month,
    mrr_connect: connectByCust.monthlyTotals[month] ?? 0,
  }));
  return {
    tab: 'connect_by_month',
    sheetIds: CONNECT_FILES.map((f) => f.id),
    ...nowMeta(),
    columns: ['month', 'mrr_connect'],
    rows,
    rowCount: rows.length,
    notes: 'Monthly Connect (affiliate) fee totals derived from connect_by_customer_month.',
  };
}

// ========= mrr_by_month + services_by_month =========
// Services by Month tab layout (xlsx, 0-indexed):
//   r0      = [label_'4', monthlyTotal_col1, monthlyTotal_col2, ...]
//   r3      = [null, '2022-Mar', '2022-Apr', ...]              (month header)
//   r4      = blank-name subtotal row (skip)
//   r5..end = per-customer rows
function buildServicesByMonth(wb) {
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets['Services by Month'], { header: 1, defval: null, raw: false });
  const headerRow = aoa[3] || [];
  const monthCols = [];
  for (let i = 1; i < headerRow.length; i++) {
    const iso = isoFromLabel(headerRow[i]);
    if (iso) monthCols.push({ colIdx: i, month: iso });
  }
  // Summary row 0 — col j carries total for month at headerRow[j].
  const summaryRow = aoa[0] || [];
  const monthlyTotals = {};
  for (const { colIdx, month } of monthCols) {
    const v = parseNum(summaryRow[colIdx]);
    if (v != null) monthlyTotals[month] = v;
  }

  const rows = [];
  for (let i = 5; i < aoa.length; i++) {
    const row = aoa[i];
    if (!row) continue;
    const name = row[0];
    if (!name || !String(name).trim()) continue;
    if (/^NO_HEADER$/i.test(String(name))) continue;
    const out = { customer_name: String(name).trim() };
    for (const { colIdx, month } of monthCols) {
      out[month] = parseNum(row[colIdx]);
    }
    rows.push(out);
  }

  return {
    tab: 'services_by_month',
    sheetId: PRIMARY_SHEET_ID,
    ...nowMeta(),
    columns: ['customer_name', ...monthCols.map((c) => c.month)],
    rows,
    rowCount: rows.length,
    monthlyTotals,
    notes: `Per-customer services revenue from the Services by Month tab (${rows.length} customers × ${monthCols.length} months). Monthly totals taken from the sheet's formula-driven summary row, not customer sums.`,
  };
}

// MRR by Month tab layout (xlsx, 0-indexed):
//   r0  = ['Total MRR', total_subscription_per_month...]
//   r1  = ['Logo Qty', logos_per_month...]
//   r2  = ['Average MRR Per Customer', avg_per_month...]
//   r5  = [null, '2018-Jun', '2018-Jul', ...]    (month header)
//   r7+ = per-customer rows
function buildMrrByMonth(wb, servicesByMonth, connectByMonth) {
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets['MRR by Month'], { header: 1, defval: null, raw: false });
  const headerRow = aoa[5] || [];
  const monthCols = [];
  for (let i = 1; i < headerRow.length; i++) {
    const iso = isoFromLabel(headerRow[i]);
    if (iso) monthCols.push({ colIdx: i, month: iso });
  }
  const subRow = aoa[0] || [];
  const logoRow = aoa[1] || [];

  const svcTotals = servicesByMonth.monthlyTotals ?? {};
  const connectTotals = Object.fromEntries(connectByMonth.rows.map((r) => [r.month, r.mrr_connect]));

  const rows = [];
  for (const { colIdx, month } of monthCols) {
    const sub = parseNum(subRow[colIdx]);
    const logo = parseNum(logoRow[colIdx]);
    const svc = svcTotals[month] ?? null;
    const conn = connectTotals[month] ?? null;
    const subN = sub ?? 0;
    const svcN = svc ?? 0;
    const connN = conn ?? 0;
    const blended = sub == null && svc == null && conn == null ? null : subN + svcN + connN;
    const avg = blended != null && logo ? blended / logo : null;
    rows.push({
      month,
      logo_qty: logo,
      mrr_subscription: sub,
      mrr_services: svc,
      mrr_connect: conn,
      mrr_blended: blended != null ? Math.round(blended * 100) / 100 : null,
      avg_mrr_blended: avg != null ? Math.round(avg * 100) / 100 : null,
    });
  }

  // Trim trailing rows where every metric is null/zero.
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    const empty = (v) => v == null || v === 0;
    if (empty(last.logo_qty) && empty(last.mrr_blended) && empty(last.mrr_subscription) && empty(last.mrr_services) && empty(last.mrr_connect)) {
      rows.pop();
    } else break;
  }

  return {
    tab: 'mrr_by_month',
    sheetId: PRIMARY_SHEET_ID,
    ...nowMeta(),
    columns: ['month', 'logo_qty', 'mrr_subscription', 'mrr_services', 'mrr_connect', 'mrr_blended', 'avg_mrr_blended'],
    rows,
    rowCount: rows.length,
    notes:
      'Blended monthly MRR time series: subscription from MRR by Month Total row, services from Services by Month summary, connect from connect_by_month union. Logo Qty is the subscription-stream logo count from MRR by Month.',
  };
}

// ========= Main =========

console.log('Reading primary xlsx…');
const primary = readWb(PRIMARY_XLSX);

console.log('\n[1/5] Raw tab pulls');
writeSnap('allmoxy_core_customer', buildCoreCustomer(primary));
// Merge duplicate-AID customers in the core roster BEFORE the cohort/health
// builds consume it (see customer_merge_overrides.json). customer_profiles is
// merged separately after its enrichment below.
runScriptArgs('apply_customer_merges.mjs', ['allmoxy_core_customer']);
writeSnap('classification_master', buildClassificationMaster(primary));

console.log('\n[2/5] Connect union from 6 annual Connect xlsx files');
const acctIndex = buildAcctNameIndex();
console.log(`  built acct_id → name index: ${acctIndex.size} entries`);
const connectByCust = buildConnectByCustomerMonth(acctIndex);
const connectByMonth = buildConnectByMonth(connectByCust);
writeSnap('connect_by_customer_month', connectByCust);
writeSnap('connect_by_month', connectByMonth);

console.log('\n[3/5] MRR + Services by Month');
const servicesSnap = buildServicesByMonth(primary);
writeSnap('services_by_month', servicesSnap);
const mrrSnap = buildMrrByMonth(primary, servicesSnap, connectByMonth);
writeSnap('mrr_by_month', mrrSnap);

// ========= Delegate to existing xlsx-direct scripts =========

function runScript(scriptName, outSnap) {
  const scriptPath = path.join(SCRIPTS, scriptName);
  console.log(`  running ${scriptName}…`);
  const stdout = execFileSync('node', [scriptPath], { maxBuffer: 1024 * 1024 * 256 });
  if (outSnap) {
    const target = path.join(SNAPSHOTS, `${outSnap}.json`);
    fs.writeFileSync(target, stdout);
    const size = fs.statSync(target).size;
    const sz = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${(size / 1024).toFixed(0)} KB`;
    console.log(`  wrote ${outSnap}.json (${sz})`);
  }
}

// Like runScript but passes CLI args and lets the script edit snapshots in place
// (output is inherited, not captured). Used for apply_* steps that rewrite a
// named snapshot rather than emitting it on stdout.
function runScriptArgs(scriptName, scriptArgs) {
  const scriptPath = path.join(SCRIPTS, scriptName);
  console.log(`  running ${scriptName} ${scriptArgs.join(' ')}…`);
  execFileSync('node', [scriptPath, ...scriptArgs], { maxBuffer: 1024 * 1024 * 256, stdio: 'inherit' });
}

console.log('\n[4/5] Subscription + waterfall + cohort');
runScript('build_subscription_by_month.mjs', 'subscription_by_month');
runScript('build_waterfall.mjs', 'mrr_waterfall');
runScript('build_full_cohort.mjs', 'cohort_retention');

console.log('\n[5/5] Customer aggregates + unit economics');
runScript('build_customer_health.mjs', 'customer_health');
runScript('build_customer_profiles.mjs', 'customer_profiles');

// Reapply per-transaction reclassifications (e.g., Panhandle's misclassified $7,658
// services charge). Persists across xlsx re-uploads since the source xlsx's
// transaction_type formula may misclassify the same row again. Runs BEFORE annual
// amortization so the waterfall rebuild downstream sees corrected values.
console.log('  applying transaction overrides…');
runScript('apply_transaction_overrides.mjs', null);

// Apply annual-payer amortization in place. Customers in src/data/annual_payers.json
// who pay $3K+ at once get their charges spread as amount/12 over 12 forward months
// in customer_profiles, subscription_by_month, mrr_by_month, AND mrr_waterfall.monthly.
// Must run AFTER customer_profiles + overrides but BEFORE roster (which reads profiles)
// and unit_econ (which reads mrr_by_month).
console.log('  applying annual-payer amortization…');
runScript('apply_annual_amortization.mjs', null);

// Re-attribute Stripe Connect fees via the explicit mapping in
// connect_customer_overrides.json. build_customer_profiles joins by exact
// lowercase name and silently drops customers whose name in
// connect_by_customer_month differs from their profile name (e.g. "Fryburg
// Door, Inc." vs "Fryburg Door - Mullwood"). This step overlays the manual
// mapping so every mapped Connect customer gets monthly_history.connect +
// lifetime_connect populated. Must run AFTER annual amortization because it
// rewrites monthly_history totals using the amortized subscription value.
console.log('  applying Stripe Connect attribution…');
runScript('apply_connect_attribution.mjs', null);

// Apply customer-status overrides (sub-instance-of-parent, comp arrangements).
// Final say on status — must run AFTER amortization which already adjusts status
// for annual-coverage customers. These overrides cover the cases amortization
// can't (no Stripe activity but business-arrangement-active).
console.log('  applying customer status overrides…');
runScript('apply_customer_status_overrides.mjs', null);

// Auto-classify never-paid customers (lifetime=$0, 0 transactions, no manual
// override). They were never customers, so they should NOT be in churn/logo
// counts. Runs AFTER status overrides so it doesn't clobber them.
console.log('  classifying never-paid customers…');
runScript('apply_never_paid_classification.mjs', null);

// Merge duplicate-AID customers in customer_profiles (folds the absorbed row's
// financials into the survivor, drops the dupe). Runs after all enrichment so
// the survivor keeps the full picture, and before every downstream build that
// reads customer_profiles (roster, churn, renewal, data cleanup, features…).
console.log('  merging duplicate-AID customers…');
runScriptArgs('apply_customer_merges.mjs', ['customer_profiles']);

// Reconcile cohort_retention's "active today" with customer_profiles after all
// upstream adjustments. Must run AFTER apply_annual_amortization so the patch
// reads the final canonical MRR values.
runScript('patch_cohort_active.mjs', null);

// Parallel transaction-driven waterfall for spot-checking against the QB-driven
// mrr_waterfall.json. Same schema, different data path: built from
// customer_profiles.transactions (post-override) instead of subscription_by_month.
runScript('build_waterfall_from_txns.mjs', null);

runScript('build_roster.mjs', null); // writes its own output file
runScript('build_unit_econ.mjs', 'unit_economics');
runScript('build_pnl.mjs', null); // writes pnl_by_month.json itself

// Annual-amortization evidence registry (QoE-4). Joins annual_payers + overrides +
// synthetic transactions + realized monthly_history into one drilldown surface.
// Must run AFTER amortization + status overrides so realized monthly_history is final.
runScript('build_annual_amortization_evidence.mjs', null); // writes annual_amortization_evidence.json itself

// Adjusted EBITDA bridge (QoE-5). NI → standard EBITDA add-backs → GAAP EBITDA →
// QoE adjustments (owner-comp normalization, one-time costs, discretionary perks)
// → Adjusted EBITDA. Must run AFTER build_pnl since it reads pnl_by_month.
runScript('build_ebitda_bridge.mjs', null); // writes ebitda_bridge.json itself

// Adjustments Register — consolidates every override / data adjustment we make to raw
// source data into one auditable surface for QoE / diligence review. Runs LAST so it
// can compute dollar-impact figures from the final post-adjustment customer_profiles.
runScript('build_adjustments_register.mjs', null); // writes adjustments_register.json itself

// QoE-7 Metric definitions — publish from _etl_scripts/ to public/snapshots/.
runScript('build_metric_definitions.mjs', null);

// Orders Verified — parses Orders Verified Data.xlsx into per-customer per-year
// volume data. Feeds Signal 1 (Order Volume) of the Churn Risk Matrix.
runScript('build_orders_verified.mjs', null); // writes orders_verified.json itself

// Churn Risk Matrix — applies the 5-signal scoring model (skill: allmoxy-monthly-
// dashboard) to every active paying customer. Reads orders_verified.json + the
// optional at_risk_hubspot_signals.json cache. Adapts thresholds to data
// availability and emits the 3×3 risk-impact matrix + per-customer breakdown.
runScript('build_churn_risk_matrix.mjs', null); // writes churn_risk_matrix.json itself

// Time to Value — focused view on verified-order data. Categorizes every active
// paying customer as gym_member / hygiene_gap / dormant / declining / healthy
// and surfaces "$ paid without value" as the headline metric.
runScript('build_time_to_value.mjs', null); // writes time_to_value.json itself

// Renewal Management — joins HubSpot Instance object (renewal date, contract
// terms, monthly flat fee, last-renewal-expansion history) to customer
// financials + orders verified + churn matrix. Pre-computes ROI multipliers
// (lifetime + annualized) and 24-month monthly ROI trend so drop-offs are
// visible. Requires the new Instance sync in sync_hubspot.mjs to have run.
runScript('build_renewal_management.mjs', null); // writes renewal_management.json itself

// Data Cleanup — surfaces every detectable data-hygiene issue (Instance aid
// missing, ghost HubSpot Company IDs, Connect mapping orphans, pay-status
// drift). Drives the Maintenance → Data Cleanup page.
runScript('build_data_cleanup.mjs', null); // writes data_cleanup.json itself

// QoE-6 Invariant tests — run AFTER all snapshots are built so they can cross-check
// for consistency. Writes invariant_test_results.json. Exits non-zero on error-severity
// failures, but we capture that without halting refresh_all (warnings/errors are
// informational; the dashboard surfaces them so a reviewer can act).
try {
  runScript('run_invariant_tests.mjs', null);
} catch (e) {
  console.warn(`  invariant tests reported errors (exit ${e.status ?? '?'}) — see invariant_test_results.json`);
}

// Stripe ↔ QuickBooks reconciliation — per-month tie-out of Stripe transactions to
// QB revenue lines. Must run AFTER pnl + customer_profiles are written so both sides
// are available. This is the report a QoE reviewer asks for first.
runScript('build_stripe_qb_reconciliation.mjs', null); // writes stripe_qb_reconciliation.json itself

// Extend churn_inferences with placeholder entries for any unattributed churned
// customer not yet in the inference set, so QoE-3 (churn-reason backfill) tracks
// the full universe of unattributed churns, not just the inference snapshot.
runScript('extend_churn_inferences.mjs', null); // rewrites churn_inferences.json in place

// Consolidate the deep-research batch files into a single keyed snapshot the
// Churn Investigator can join onto each customer card. Each entry carries the
// agent-proposed reason + verbatim evidence quotes + alternative-reasons-ruled-out.
runScript('consolidate_churn_research.mjs', null); // writes churn_research_classifications.json itself

// Sub-pattern keyword detection (auto) + manual-override merge. The auto pass
// keyword-matches over churn notes + Churn Details xlsx. The override pass merges
// manual classifications from _etl_scripts/churn_subpattern_overrides.json on top
// (union semantics — manual tags add to, never overwrite, auto-detected tags).
runScript('build_churn_subpatterns.mjs', null); // writes churn_subpatterns.json itself
runScript('apply_churn_subpattern_overrides.mjs', null);

// Churn-corpus pull from HubSpot. Conditional on HUBSPOT_TOKEN being set in the
// environment — without it, the script aborts immediately, so we skip cleanly and
// leave any existing churn_corpus.json snapshot in place rather than blowing it away.
// The pull takes ~5-15 min depending on engagement volume (rate-limited at 5 req/sec).
console.log('\n[6/5] Churn corpus (HubSpot, optional)');
if (!process.env.HUBSPOT_TOKEN) {
  console.log('  skipped — HUBSPOT_TOKEN not set in environment.');
  console.log('  To enable: create a HubSpot Private App (Settings → Integrations → Private Apps)');
  console.log('  with the scopes listed in .env.sample, then export HUBSPOT_TOKEN before running this script.');
  console.log('  e.g. `set -a; source .env.local; set +a; node _etl_scripts/refresh_all.mjs`');
} else {
  runScript('build_churn_corpus.mjs', null); // writes churn_corpus.json itself
}

// Implementation (JIRA + Harvest, optional). Requires JIRA_* + HARVEST_* creds
// in .env.local. The sync scripts read .env.local themselves, so we just probe
// the file for the keys and skip cleanly if absent — leaving any existing
// implementation.json in place. Wrapped so a JIRA/Harvest outage can't abort
// the whole refresh.
console.log('\n[7/5] Implementation (JIRA + Harvest, optional)');
{
  const envLocal = (() => { try { return fs.readFileSync(path.join(SCRIPTS, '..', '.env.local'), 'utf8'); } catch { return ''; } })();
  const hasKey = (k) => process.env[k] || new RegExp(`^${k}=\\S`, 'm').test(envLocal);
  const ready = ['JIRA_EMAIL', 'JIRA_API_TOKEN', 'HARVEST_ACCOUNT_ID', 'HARVEST_TOKEN'].every(hasKey);
  if (!ready) {
    console.log('  skipped — JIRA_*/HARVEST_* not set in .env.local. See .env.sample.');
  } else {
    try {
      runScript('sync_jira.mjs', null);
      runScript('sync_harvest.mjs', null);
      runScript('build_implementation.mjs', null); // writes implementation.json itself
    } catch (e) {
      console.log('  ⚠ implementation refresh failed (kept previous snapshot):', e.message);
    }
  }
}

// Features (DEV board, optional). DEV tickets tagged with customers, weighted by
// each tagged customer's revenue — a CS→Dev prioritization signal. Needs only
// JIRA creds; build_features joins against the customer_profiles built above.
console.log('\n[8/5] Features (JIRA DEV board, optional)');
{
  const envLocal = (() => { try { return fs.readFileSync(path.join(SCRIPTS, '..', '.env.local'), 'utf8'); } catch { return ''; } })();
  const hasKey = (k) => process.env[k] || new RegExp(`^${k}=\\S`, 'm').test(envLocal);
  const ready = ['JIRA_EMAIL', 'JIRA_API_TOKEN'].every(hasKey);
  if (!ready) {
    console.log('  skipped — JIRA_* not set in .env.local. See .env.sample.');
  } else {
    try {
      runScript('sync_jira_features.mjs', null);
      runScript('build_features.mjs', 'features');
    } catch (e) {
      console.log('  ⚠ features refresh failed (kept previous snapshot):', e.message);
    }
  }
}

// Stripe Connect processing volume (optional, SLOW). The application_fees pull
// with charge expansion can take ~1h, so it's gated behind --stripe (and a key).
// build_connect_volume is fast and runs whenever the cache exists, so the
// snapshot stays fresh from the last pull even on a normal refresh.
console.log('\n[9/5] Stripe Connect volume (optional)');
{
  const envLocal = (() => { try { return fs.readFileSync(path.join(SCRIPTS, '..', '.env.local'), 'utf8'); } catch { return ''; } })();
  const hasKey = process.env.STRIPE_SECRET_KEY || /^STRIPE_SECRET_KEY=\S/m.test(envLocal);
  if (process.argv.includes('--stripe')) {
    if (!hasKey) {
      console.log('  --stripe set but STRIPE_SECRET_KEY missing in .env.local — skipped.');
    } else {
      try { runScriptArgs('sync_stripe_connect.mjs', []); } catch (e) { console.log('  ⚠ Stripe sync failed (kept previous cache):', e.message); }
    }
  } else {
    console.log('  Stripe API pull skipped (pass --stripe to refresh it; it is slow). Rebuilding snapshot from cache…');
  }
  if (fs.existsSync(path.join(SCRIPTS, 'cache', 'stripe_connect_volume.json'))) {
    try { runScript('build_connect_volume.mjs', null); } catch (e) { console.log('  ⚠ build_connect_volume failed:', e.message); }
  } else {
    console.log('  no Stripe cache yet — run with --stripe once to populate.');
  }
}

console.log('\nAll snapshots refreshed.');
