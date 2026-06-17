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
// May 2026 supplement — fills monthly_avg_current_year for customers whose
// 2026 column is blank in the main Monthly Average sheet. Single-month
// snapshot keyed by subdomain. Optional file — skipped if missing.
const MAY_2026_SUPPLEMENT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Verified Orders May 2026.xlsx';
const MAY_2026_MONTH = '2026-05';
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
for (const p of profiles.rows || []) {
  if (p.installer_id != null && p.installer_id !== '') {
    allmoxyIdByInstaller.set(String(p.installer_id), p.allmoxy_customer_id);
  }
  if (p.installer_directory) {
    allmoxyIdBySubdomain.set(String(p.installer_directory).toLowerCase(), p.allmoxy_customer_id);
  }
  if (p.name) allmoxyIdByName.set(normName(p.name), p.allmoxy_customer_id);
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
// Pass 2b: May 2026 supplement (optional file)
// The main Monthly Average sheet isn't always refreshed for the current year,
// leaving customers like Stolbek ($813K), Westwind ($438K), and Wurth LAC
// ($72K) with no 2026 MA — which makes Signal 1 fall back to annualized raw
// counts. The supplement file ("Verified Orders May 2026.xlsx") has actual
// May invoice totals by subdomain; we use these as the monthly_avg_current_year
// for customers whose MA sheet entry is missing for 2026. We also stamp the
// raw monthly cell into a separate `monthly_supplement` field for traceability.
// ============================================================================
const currentYearStr = String(new Date().getFullYear());
let supplementFilled = 0;
let supplementOverridden = 0;
let supplementUnmatched = 0;
const supplementUnmatchedExamples = [];
try {
  if (fs.existsSync(MAY_2026_SUPPLEMENT)) {
    const supWb = XLSX.read(fs.readFileSync(MAY_2026_SUPPLEMENT), { type: 'buffer' });
    const supSheetName = supWb.SheetNames[0];
    const supRows = XLSX.utils.sheet_to_json(supWb.Sheets[supSheetName], { defval: null });
    // Index existing byCustomer by subdomain for lookup
    const customerBySubdomain = new Map();
    for (const c of byCustomer.values()) {
      if (c.subdomain) customerBySubdomain.set(String(c.subdomain).toLowerCase(), c);
    }
    for (const row of supRows) {
      const subdomain = String(row['subdomain'] || '').toLowerCase().trim();
      const total = parseNum(row['total invoices']);
      if (!subdomain || total <= 0) continue;
      const c = customerBySubdomain.get(subdomain);
      if (!c) {
        supplementUnmatched++;
        if (supplementUnmatchedExamples.length < 5) supplementUnmatchedExamples.push(`${subdomain} ($${Math.round(total).toLocaleString()})`);
        continue;
      }
      // Record the per-month value for traceability
      if (!c.monthly_supplement) c.monthly_supplement = {};
      c.monthly_supplement[MAY_2026_MONTH] = Math.round(total * 100) / 100;
      // Only fill the MA cell when 2026 is missing — don't overwrite real MA data
      const existing = c.monthly_avg[currentYearStr] || 0;
      if (existing === 0) {
        c.monthly_avg[currentYearStr] = Math.round(total * 100) / 100;
        c.monthly_avg_source_current_year = 'may_2026_supplement';
        supplementFilled++;
      } else {
        supplementOverridden++; // already had MA data; supplement skipped
      }
    }
    console.log(`May 2026 supplement: ${supplementFilled} customers filled · ${supplementOverridden} skipped (already had MA) · ${supplementUnmatched} unmatched subdomains`);
    if (supplementUnmatchedExamples.length > 0) {
      console.log(`  Unmatched examples: ${supplementUnmatchedExamples.join(', ')}`);
    }
  }
} catch (err) {
  console.warn(`May 2026 supplement load failed: ${err.message}`);
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
    if ((c.years[year].order_count || 0) > 0) {
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
// Compute derived fields per customer
// ============================================================================
const today = new Date();
const currentYear = String(today.getFullYear());
const priorYear = String(today.getFullYear() - 1);
const monthOfYear = today.getMonth() + 1; // 1-12

for (const c of byCustomer.values()) {
  // Latest year with orders
  let latest = null;
  for (const y of Object.keys(c.years).sort().reverse()) {
    if ((c.years[y].order_count || 0) > 0) { latest = y; break; }
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
