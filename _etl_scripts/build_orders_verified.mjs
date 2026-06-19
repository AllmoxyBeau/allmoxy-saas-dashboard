#!/usr/bin/env node
/**
 * Parse "Orders Verified Data.xlsx" and emit per-customer order volume + launch
 * status data.
 *
 * Three sheets in scope:
 *   1. Raw Data — per (customer, year) order_count + USD totals
 *   2. Monthly Average — year's total / months active = monthly-avg revenue
 *      (key signal: compares 2026 YTD apples-to-apples with prior years' average)
 *   3. Month to Month Veified Raw Data — also carries Live Date (year customer
 *      went live) and Months to Launch. Live Date populated → launched.
 *
 * Join key: installation_id → customer_profiles.installer_id → allmoxy_customer_id.
 *
 * Output: public/snapshots/orders_verified.json
 */

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const SOURCE = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Orders Verified Data.xlsx';
// Multi-month 2026 supplement — one tab per month (Jan, Feb, March, April,
// May, ...). Each tab: { subdomain, total invoices }. When present, this
// REPLACES the Raw Data tab's 2026 totals (which lag behind) and populates
// per-month values in monthly_supplement so the dashboard can render true
// monthly trends. Single-month "Verified Orders May 2026.xlsx" is the legacy
// fallback if the multi-month file isn't there.
const VERIFIED_2026_MONTHLY = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Verified Orders 2026.xlsx';
const VERIFIED_2026_MAY_FALLBACK = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Verified Orders May 2026.xlsx';
const VERIFIED_2026_YEAR = '2026';
// Map a sheet name (e.g. "Jan", "May", "April") to its month-of-year number.
const MONTH_NAME_TO_NUM = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};
const OUT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots/orders_verified.json';
const PROFILES = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots/customer_profiles.json';

function parseNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Load profiles for the join
const profiles = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
const allmoxyIdByInstaller = new Map();
const allmoxyIdByName = new Map();
// Subdomain fallback: when an xlsx row's installation_id doesn't line up with
// any profile's installer_id (different ID spaces between the Allmoxy orders DB
// and Stripe customer profiles), join by subdomain → installer_directory.
const allmoxyIdBySubdomain = new Map();
const nameById = new Map();

// Some installer_ids / subdomains map to MULTIPLE profiles (e.g. an active
// paying customer + a "never_paid" duplicate Allmoxy account that shares the
// same installation). Verified orders flow into the shared installation, so
// they should attribute to the actively-paying profile. Break collisions by
// priority — paying > active/at_risk > churned > never_paid.
const profilesById = new Map((profiles.rows || []).map((p) => [p.allmoxy_customer_id, p]));
function profilePriority(p) {
  if (!p) return -1;
  if ((p.lifetime_total || 0) > 0) return 3;
  if (p.status === 'active' || p.status === 'at_risk') return 2;
  if (p.status === 'churned' || p.status === 'paused') return 1;
  return 0;
}
function setBestAid(map, key, p) {
  const existingAid = map.get(key);
  if (existingAid == null) { map.set(key, p.allmoxy_customer_id); return; }
  if (profilePriority(p) > profilePriority(profilesById.get(existingAid))) {
    map.set(key, p.allmoxy_customer_id);
  }
}

for (const p of profiles.rows || []) {
  if (p.installer_id != null && p.installer_id !== '') {
    setBestAid(allmoxyIdByInstaller, String(p.installer_id), p);
  }
  if (p.installer_directory) {
    setBestAid(allmoxyIdBySubdomain, String(p.installer_directory).toLowerCase(), p);
  }
  if (p.name) setBestAid(allmoxyIdByName, normName(p.name), p);
  nameById.set(p.allmoxy_customer_id, p.name);
}

const wb = XLSX.read(fs.readFileSync(SOURCE), { type: 'buffer' });

// ============================================================================
// Pass 1: Raw Data (year-level order counts + USD totals + installer_id)
// ============================================================================
const rawRows = XLSX.utils.sheet_to_json(wb.Sheets['Raw Data'], { defval: null, raw: false });
const byCustomer = new Map(); // allmoxy_customer_id → record
const installerByName = new Map();
// Built during Pass 1 — maps normalized xlsx name → aid for customers that
// joined (by installer_id OR subdomain fallback). Used by Pass 2/3 so they
// pick up the subdomain-fallback joins.
const aidByXlsxName = new Map();
const unmatchedInstallers = new Set();
let skippedNoMatch = 0;

let subdomainFallbackJoins = 0;
for (const r of rawRows) {
  const installId = r['installation_id'] != null ? String(r['installation_id']) : '';
  if (!installId) { skippedNoMatch++; continue; }
  let aid = allmoxyIdByInstaller.get(installId);
  if (aid == null) {
    // Fall back to subdomain → installer_directory join.
    const subdomain = String(r['subdomain'] || '').toLowerCase();
    if (subdomain) {
      aid = allmoxyIdBySubdomain.get(subdomain);
      if (aid != null) subdomainFallbackJoins++;
    }
  }
  if (aid == null) {
    unmatchedInstallers.add(installId + ' (' + (r['name'] || '?') + ')');
    skippedNoMatch++;
    continue;
  }
  // Track installer_id → name for the Monthly Average / Live Date join
  if (r['name']) {
    installerByName.set(normName(r['name']), installId);
    aidByXlsxName.set(normName(r['name']), aid);
  }

  const year = String(r['year'] || '').trim();
  if (!/^\d{4}$/.test(year)) continue;

  if (!byCustomer.has(aid)) {
    byCustomer.set(aid, {
      allmoxy_customer_id: aid,
      name: nameById.get(aid) || r['name'] || null,
      orders_xlsx_name: r['name'] || null,
      installer_id: installId,
      subdomain: r['subdomain'] || null,
      years: {},
      monthly_avg: {},          // populated from Monthly Average sheet
      live_date: null,            // final resolved: xlsx value wins, falls back to inferred
      live_date_xlsx: null,       // year from M2M sheet (manually maintained)
      live_date_inferred: null,   // earliest year with verified orders > 0
      live_date_source: null,     // 'xlsx' | 'inferred' | null
      months_to_launch: null,
      is_launched: false,
      total_lifetime_orders: 0,
      total_lifetime_usd: 0,
    });
  }
  const c = byCustomer.get(aid);
  const orderCount = parseNum(r['order_count']);
  const totalUsd = parseNum(r['total_USD']);
  const subtotalUsd = parseNum(r['subtotal_USD']);
  const b2bUsd = parseNum(r['b2b_subtotal_USD']);

  if (!c.years[year]) c.years[year] = { order_count: 0, total_usd: 0, subtotal_usd: 0, b2b_subtotal_usd: 0 };
  c.years[year].order_count += orderCount;
  c.years[year].total_usd += totalUsd;
  c.years[year].subtotal_usd += subtotalUsd;
  c.years[year].b2b_subtotal_usd += b2bUsd;

  c.total_lifetime_orders += orderCount;
  c.total_lifetime_usd += totalUsd;
}

// ============================================================================
// Pass 2: Monthly Average (year's monthly avg revenue, joined by name)
// ============================================================================
const maRows = XLSX.utils.sheet_to_json(wb.Sheets['Monthly Average'], { header: 1, defval: null, raw: true });
const maHeader = maRows[0] || [];
const yearCols = {};
for (let i = 1; i < maHeader.length; i++) {
  if (typeof maHeader[i] === 'number' && maHeader[i] >= 2010 && maHeader[i] <= 2030) {
    yearCols[String(maHeader[i])] = i;
  }
}

let maJoined = 0;
for (let i = 1; i < maRows.length; i++) {
  const row = maRows[i];
  if (!row || !row[0]) continue;
  const nm = normName(row[0]);
  const installId = installerByName.get(nm);
  // Prefer the aid we already established in Pass 1 (handles subdomain-fallback
  // joins); fall back to xlsx-installation_id → profile or name → profile.
  const aid = aidByXlsxName.get(nm)
    ?? (installId ? allmoxyIdByInstaller.get(installId) : allmoxyIdByName.get(nm));
  if (aid == null) continue;
  const c = byCustomer.get(aid);
  if (!c) continue;
  for (const [year, col] of Object.entries(yearCols)) {
    const v = parseNum(row[col]);
    if (v > 0) c.monthly_avg[year] = Math.round(v * 100) / 100;
  }
  maJoined++;
}

// ============================================================================
// Pass 2b: 2026 monthly supplement — REPLACES 2026 totals from Raw Data
//
// The new "Verified Orders 2026.xlsx" file has one tab per month (Jan/Feb/Mar/
// Apr/May/etc.) with subdomain + total invoices for that month. We:
//   1) Sum per-customer to get fresh 2026 YTD total_usd
//   2) Populate monthly_supplement[YYYY-MM] for per-month dashboard charts
//   3) Recompute monthly_avg_current_year as sum / months_loaded
//   4) Overwrite years["2026"].total_usd with the authoritative value
//
// Falls back to the older single-tab "Verified Orders May 2026.xlsx" if the
// multi-month file isn't present. Both files are optional — without either,
// 2026 data comes from the Raw Data tab as before.
// ============================================================================
const currentYearStr = String(new Date().getFullYear());

function readMonthlySupplement() {
  if (fs.existsSync(VERIFIED_2026_MONTHLY)) {
    const wb = XLSX.read(fs.readFileSync(VERIFIED_2026_MONTHLY), { type: 'buffer' });
    const monthData = {}; // { "2026-01": [{ subdomain, total }, ...], ... }
    for (const sheetName of wb.SheetNames) {
      const num = MONTH_NAME_TO_NUM[String(sheetName).trim().toLowerCase()];
      if (!num) {
        console.warn(`  ! 2026 supplement: unknown month tab "${sheetName}" — skipping`);
        continue;
      }
      const key = `${VERIFIED_2026_YEAR}-${num}`;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
      monthData[key] = rows
        .map((r) => ({
          subdomain: String(r['subdomain'] || '').toLowerCase().trim(),
          total: parseNum(r['total invoices']),
        }))
        .filter((r) => r.subdomain && r.total != null);
    }
    return { source: VERIFIED_2026_MONTHLY, monthData };
  }
  if (fs.existsSync(VERIFIED_2026_MAY_FALLBACK)) {
    // Legacy fallback — single-tab May-only file
    const wb = XLSX.read(fs.readFileSync(VERIFIED_2026_MAY_FALLBACK), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
    return {
      source: VERIFIED_2026_MAY_FALLBACK,
      monthData: {
        '2026-05': rows
          .map((r) => ({ subdomain: String(r['subdomain'] || '').toLowerCase().trim(), total: parseNum(r['total invoices']) }))
          .filter((r) => r.subdomain && r.total != null),
      },
    };
  }
  return null;
}

let supplementReplaced = 0;
let supplementUnmatched = 0;
const supplementUnmatchedExamples = [];
try {
  const sup = readMonthlySupplement();
  if (sup) {
    const monthKeys = Object.keys(sup.monthData).sort();
    console.log(`2026 monthly supplement: ${path.basename(sup.source)} (${monthKeys.length} months: ${monthKeys.join(', ')})`);
    const customerBySubdomain = new Map();
    for (const c of byCustomer.values()) {
      if (c.subdomain) customerBySubdomain.set(String(c.subdomain).toLowerCase(), c);
    }
    // For each customer that appears in ANY month tab, sum their values and
    // populate the monthly + yearly fields. Authoritative — replaces Raw Data.
    const perCustomer = new Map(); // subdomain → { months: {key: $}, total: sum }
    for (const monthKey of monthKeys) {
      for (const r of sup.monthData[monthKey]) {
        if (!perCustomer.has(r.subdomain)) perCustomer.set(r.subdomain, { months: {}, total: 0 });
        const entry = perCustomer.get(r.subdomain);
        entry.months[monthKey] = Math.round(r.total * 100) / 100;
        entry.total += r.total;
      }
    }
    for (const [subdomain, entry] of perCustomer) {
      let c = customerBySubdomain.get(subdomain);
      if (!c) {
        // Customer absent from Raw Data (e.g. signed up in 2026, no prior years
        // of history). Try to create a record on the fly via the profile-level
        // subdomain → installer_directory map.
        const aid = allmoxyIdBySubdomain.get(subdomain);
        if (aid != null && !byCustomer.has(aid)) {
          byCustomer.set(aid, {
            allmoxy_customer_id: aid,
            name: nameById.get(aid) || null,
            orders_xlsx_name: null,
            installer_id: profilesById.get(aid)?.installer_id ?? null,
            subdomain,
            years: {},
            monthly_avg: {},
            live_date: null,
            live_date_xlsx: null,
            live_date_inferred: null,
            live_date_source: null,
            months_to_launch: null,
            is_launched: false,
            total_lifetime_orders: 0,
            total_lifetime_usd: 0,
          });
          c = byCustomer.get(aid);
          customerBySubdomain.set(subdomain, c);
        }
      }
      if (!c) {
        supplementUnmatched++;
        if (supplementUnmatchedExamples.length < 5) supplementUnmatchedExamples.push(`${subdomain} ($${Math.round(entry.total).toLocaleString()})`);
        continue;
      }
      // Populate per-month traceability
      if (!c.monthly_supplement) c.monthly_supplement = {};
      Object.assign(c.monthly_supplement, entry.months);
      // Replace 2026 yearly total with supplement sum (authoritative)
      if (!c.years[VERIFIED_2026_YEAR]) c.years[VERIFIED_2026_YEAR] = { order_count: 0, total_usd: 0, subtotal_usd: 0, b2b_subtotal_usd: 0 };
      const prevTotal = c.years[VERIFIED_2026_YEAR].total_usd || 0;
      c.years[VERIFIED_2026_YEAR].total_usd = Math.round(entry.total * 100) / 100;
      c.years[VERIFIED_2026_YEAR].subtotal_usd = Math.round(entry.total * 100) / 100;
      c.total_lifetime_usd += (entry.total - prevTotal);
      // Set monthly_avg_current_year = sum / months_loaded
      const monthsLoaded = Object.keys(entry.months).length;
      c.monthly_avg[currentYearStr] = monthsLoaded > 0
        ? Math.round((entry.total / monthsLoaded) * 100) / 100
        : c.monthly_avg[currentYearStr] || 0;
      c.monthly_avg_source_current_year = 'verified_orders_2026_monthly';
      supplementReplaced++;
    }
    console.log(`  ${supplementReplaced} customers updated · ${supplementUnmatched} unmatched subdomains`);
    if (supplementUnmatchedExamples.length > 0) {
      console.log(`  Unmatched examples: ${supplementUnmatchedExamples.join(', ')}`);
    }
  } else {
    console.log('No 2026 monthly supplement file found — using Raw Data 2026 values as-is.');
  }
} catch (err) {
  console.warn(`2026 monthly supplement load failed: ${err.message}`);
}

// ============================================================================
// Pass 3: Month to Month Veified Raw Data (Live Date + Months to Launch)
// ============================================================================
const m2mRows = XLSX.utils.sheet_to_json(wb.Sheets['Month to Month Veified Raw Data'], { header: 1, defval: null, raw: true });
let liveJoined = 0;
for (let i = 1; i < m2mRows.length; i++) {
  const row = m2mRows[i];
  if (!row || !row[0]) continue;
  const nm = normName(row[0]);
  const installId = installerByName.get(nm);
  // Prefer the aid we already established in Pass 1 (handles subdomain-fallback
  // joins); fall back to xlsx-installation_id → profile or name → profile.
  const aid = aidByXlsxName.get(nm)
    ?? (installId ? allmoxyIdByInstaller.get(installId) : allmoxyIdByName.get(nm));
  if (aid == null) continue;
  const c = byCustomer.get(aid);
  if (!c) continue;

  const monthsToLaunch = row[1]; // can be number, "" or null
  const liveDate = row[3];       // year as number, or "#N/A" / null

  if (typeof liveDate === 'number' && liveDate >= 2010 && liveDate <= 2030) {
    c.live_date_xlsx = String(liveDate);
  }
  if (typeof monthsToLaunch === 'number' && monthsToLaunch > 0) {
    c.months_to_launch = monthsToLaunch;
  }
  liveJoined++;
}

// ============================================================================
// Pass 4: Auto-infer Live Date from earliest year with verified orders.
// Closes the "Hygiene Gap" (customers with orders flowing but Live Date cell
// empty in the xlsx). The xlsx-maintained value still wins when present.
// ============================================================================
let inferredCount = 0;
for (const c of byCustomer.values()) {
  for (const year of Object.keys(c.years).sort()) {
    // Detect activity by either count OR dollars — supplement-only customers
    // (e.g. signed up in 2026, no historical Raw Data) have $ but no count.
    const hasActivity = (c.years[year].order_count || 0) > 0 || (c.years[year].total_usd || 0) > 0;
    if (hasActivity) {
      c.live_date_inferred = year;
      break;
    }
  }
  // Resolve final live_date with provenance
  if (c.live_date_xlsx) {
    c.live_date = c.live_date_xlsx;
    c.live_date_source = 'xlsx';
    c.is_launched = true;
  } else if (c.live_date_inferred) {
    c.live_date = c.live_date_inferred;
    c.live_date_source = 'inferred';
    c.is_launched = true;
    inferredCount++;
  }
}
console.log(`Live Date inferred for ${inferredCount} customers (orders present but no xlsx Live Date)`);

// ============================================================================
// Pass 4b: Suppress 2026 order counts.
//
// The 2026 monthly source xlsx ("Verified Orders 2026.xlsx") carries $ invoiced
// per month but does NOT carry an order_count column. So `years["2026"].order_count`
// is unreliable — it either reflects stale Raw Data or 0, never the true count.
// Null it out everywhere and back the contribution out of total_lifetime_orders
// so downstream consumers (matrix Signal 1, charts) can detect null and skip
// the order-count signal for 2026. Revisit when the source xlsx adds a count
// column. See memory: 2026-order-counts-unavailable.
// ============================================================================
for (const c of byCustomer.values()) {
  if (c.years[VERIFIED_2026_YEAR]) {
    const stale = c.years[VERIFIED_2026_YEAR].order_count || 0;
    c.total_lifetime_orders = Math.max(0, c.total_lifetime_orders - stale);
    c.years[VERIFIED_2026_YEAR].order_count = null;
  }
}

// ============================================================================
// Compute derived fields per customer
// ============================================================================
const today = new Date();
const currentYear = String(today.getFullYear());
const priorYear = String(today.getFullYear() - 1);
const monthOfYear = today.getMonth() + 1; // 1-12

for (const c of byCustomer.values()) {
  // Latest year with orders. Use count OR dollars (since 2026 order_count is
  // suppressed, and supplement-only customers have $ but no count).
  let latest = null;
  for (const y of Object.keys(c.years).sort().reverse()) {
    if ((c.years[y].order_count || 0) > 0 || (c.years[y].total_usd || 0) > 0) { latest = y; break; }
  }
  c.latest_year_with_orders = latest;

  // Monthly-avg YoY: compare current year's monthly avg vs prior year's monthly avg.
  // The xlsx's Monthly Average sheet handles prorating across months active.
  const curMA = c.monthly_avg[currentYear] || 0;
  const prevMA = c.monthly_avg[priorYear] || 0;
  if (prevMA > 0) {
    c.monthly_avg_yoy_pct = Math.round(((curMA - prevMA) / prevMA) * 100) / 100;
  } else if (curMA > 0) {
    c.monthly_avg_yoy_pct = null; // new this year
  } else {
    c.monthly_avg_yoy_pct = -1; // no orders either year
  }
  c.monthly_avg_current_year = curMA;
  c.monthly_avg_prior_year = prevMA;

  // Round dollar sums
  c.total_lifetime_usd = Math.round(c.total_lifetime_usd * 100) / 100;
  for (const y of Object.keys(c.years)) {
    c.years[y].total_usd = Math.round(c.years[y].total_usd * 100) / 100;
    c.years[y].subtotal_usd = Math.round(c.years[y].subtotal_usd * 100) / 100;
    c.years[y].b2b_subtotal_usd = Math.round(c.years[y].b2b_subtotal_usd * 100) / 100;
  }
}

const out = {
  fetched_at: new Date().toISOString(),
  source: 'Orders Verified Data.xlsx · Raw Data + Monthly Average + Month to Month Veified Raw Data',
  comment:
    'Per-customer verified order data. Three signals captured: (1) per-year order counts + USD totals (from Raw Data), (2) MONTHLY AVERAGE revenue by year (from Monthly Average sheet — used for apples-to-apples YoY trend since 2026 is partial), (3) Live Date (year customer went live) + Months to Launch (from Month to Month Veified Raw Data sheet — answers Launch Status without HubSpot note scanning).',
  current_year: currentYear,
  prior_year: priorYear,
  customer_count: byCustomer.size,
  raw_data_rows_skipped: skippedNoMatch,
  monthly_average_rows_joined: maJoined,
  live_date_rows_joined: liveJoined,
  by_customer: Object.fromEntries([...byCustomer.entries()].map(([aid, c]) => [String(aid), c])),
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`  ${byCustomer.size} unique customers`);
console.log(`  Monthly Average rows joined: ${maJoined}`);
console.log(`  Live Date rows joined: ${liveJoined}`);
console.log(`  ${skippedNoMatch} Raw Data rows skipped (no installer_id or subdomain match)`);
console.log(`  ${subdomainFallbackJoins} Raw Data rows joined via subdomain → installer_directory fallback`);
// Summary
const launched = [...byCustomer.values()].filter((c) => c.is_launched).length;
const droppedOff = [...byCustomer.values()].filter((c) => c.monthly_avg_prior_year > 0 && c.monthly_avg_current_year === 0).length;
const declining50 = [...byCustomer.values()].filter((c) => c.monthly_avg_prior_year > 0 && c.monthly_avg_current_year > 0 && (c.monthly_avg_current_year / c.monthly_avg_prior_year) < 0.5).length;
console.log(`  ${launched} customers with Live Date (launched)`);
console.log(`  ${droppedOff} dropped off (had orders in ${priorYear}, zero in ${currentYear})`);
console.log(`  ${declining50} declining >50% YoY (monthly avg)`);
