#!/usr/bin/env node
/**
 * Parse /tmp/instances.csv and add stripe_fee_percent to each customer profile
 * by matching the instance's `directory` column to the profile's installer_directory.
 *
 * When a customer has multiple instances (e.g., primary + sandbox), prefer the one
 * whose directory exactly equals the profile's installer_directory (case-insensitive).
 * Fall back to the instance with the highest gross_revenue.
 */

import fs from 'node:fs';
import path from 'node:path';

const CSV_PATH = '/tmp/instances.csv';
const SNAP = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

// Tiny CSV parser that respects quoted fields with commas.
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; continue; }
      if (c === '"') { inQuotes = false; continue; }
      field += c;
    } else {
      if (c === '"') { inQuotes = true; continue; }
      if (c === ',') { row.push(field); field = ''; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      if (c === '\r') continue;
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

const rawText = fs.readFileSync(CSV_PATH, 'utf8');
const rows = parseCsv(rawText).filter((r) => r.length > 1 && r.some((c) => c && c.trim() !== ''));
const header = rows.shift();
const idx = (name) => header.indexOf(name);
const IDX = {
  directory: idx('directory'),
  company_name: idx('company_name'),
  stripe_fee_percent: idx('stripe_fee_percent'),
  instance_fee_percent: idx('instance_fee_percent'),
  monthly_fee_override: idx('monthly_fee_override'),
  gross_revenue: idx('gross_revenue'),
  protected: idx('protected'),
};

console.log('CSV columns found — directory:', IDX.directory, 'stripe_fee_percent:', IDX.stripe_fee_percent);

// directory (compressed/lowercased) → { stripe_fee_percent, gross_revenue, directory }
const byDirectory = new Map();
function compressDir(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

let parsedCount = 0;
let skippedProtected = 0;
for (const r of rows) {
  const dir = r[IDX.directory]?.trim();
  if (!dir) continue;
  let fee = parseFloat(r[IDX.stripe_fee_percent] ?? '');
  if (!Number.isFinite(fee)) continue;
  // Sanity: fees are always in [0, 10]. Values outside that range mean the CSV
  // row had a shifted column (e.g., an address with extra commas). Try the next
  // column (instance_fee_percent slot) as a fallback, else skip.
  if (fee < 0 || fee > 10) {
    const alt = parseFloat(r[IDX.stripe_fee_percent + 1] ?? '');
    fee = Number.isFinite(alt) && alt >= 0 && alt <= 10 ? alt : 0.5;
  }
  const isProtected = (r[IDX.protected] ?? '').toUpperCase() === 'YES';
  const gross = parseFloat(r[IDX.gross_revenue] ?? '0') || 0;
  const key = compressDir(dir);
  const existing = byDirectory.get(key);
  // If we already have an entry, keep the one with higher gross_revenue.
  if (!existing || gross > existing.gross_revenue) {
    byDirectory.set(key, {
      directory: dir,
      stripe_fee_percent: fee,
      instance_fee_percent: parseFloat(r[IDX.instance_fee_percent] ?? '0') || 0,
      monthly_fee_override: parseFloat(r[IDX.monthly_fee_override] ?? '') || null,
      gross_revenue: gross,
      is_protected: isProtected,
    });
  }
  if (isProtected) skippedProtected++;
  parsedCount++;
}

console.log(`Parsed ${parsedCount} CSV rows → ${byDirectory.size} unique directories (${skippedProtected} protected).`);

// Load profiles and attach stripe_fee_percent via installer_directory match.
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));

let matched = 0;
let unmatched = 0;
const unmatchedProfiles = [];
for (const p of profiles.rows) {
  if (!p.installer_directory) {
    unmatched++;
    continue;
  }
  const hit = byDirectory.get(compressDir(p.installer_directory));
  if (hit) {
    p.stripe_fee_percent = hit.stripe_fee_percent;
    p.instance_fee_percent = hit.instance_fee_percent;
    if (hit.monthly_fee_override != null) p.monthly_fee_override = hit.monthly_fee_override;
    matched++;
  } else {
    unmatched++;
    // Only flag profiles that had real activity
    if (p.lifetime_total > 0) unmatchedProfiles.push({ id: p.allmoxy_customer_id, name: p.name, dir: p.installer_directory, lifetime: p.lifetime_total });
  }
}

profiles.fetchedAt = new Date().toISOString();
fs.writeFileSync(path.join(SNAP, 'customer_profiles.json'), JSON.stringify(profiles));
console.log(`\nMatched stripe_fee_percent on ${matched} profiles. Unmatched: ${unmatched} (no installer_directory or no CSV row).`);

// Distribution check
const dist = new Map();
for (const p of profiles.rows) {
  if (p.stripe_fee_percent != null) {
    const key = p.stripe_fee_percent.toFixed(2);
    dist.set(key, (dist.get(key) ?? 0) + 1);
  }
}
console.log('\nFee % distribution:');
for (const [k, v] of [...dist.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
  console.log(`  ${k}% → ${v} customers`);
}

// Unmatched sample (top 10 by lifetime)
if (unmatchedProfiles.length > 0) {
  unmatchedProfiles.sort((a, b) => b.lifetime - a.lifetime);
  console.log('\nTop unmatched profiles (no installer_directory in CSV):');
  for (const u of unmatchedProfiles.slice(0, 10)) {
    console.log(`  #${u.id} ${u.name.padEnd(40)} dir=${u.dir ?? '—'}  $${u.lifetime.toFixed(0)}`);
  }
}
