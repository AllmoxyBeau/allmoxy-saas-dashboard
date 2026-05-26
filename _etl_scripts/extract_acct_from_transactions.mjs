#!/usr/bin/env node
/**
 * Scan all 3 Connect markdown files for ANY line that starts with
 * `| acct_XXX | Company Name |` (the per-transaction table) and build a
 * map of acct_id → company_name (dedupe, pick most common spelling).
 *
 * Then merge into connect_customer_overrides.json by joining each acct_id's
 * company name to the Allmoxy roster via the same logic as before.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILES = ['/tmp/connect2024.md', '/tmp/connect2025.md', '/tmp/connect2026.md'];
const overridesPath = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/connect_customer_overrides.json';
const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';

const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));

function unescape(cell) {
  return cell.replace(/\\_/g, '_').replace(/\\#/g, '#').replace(/\\&/g, '&').replace(/\\!/g, '!').replace(/\\\|/g, '|').trim();
}
function cellsOf(line) {
  const parts = line.split('|');
  if (parts[0] === '') parts.shift();
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map(unescape);
}

// For every line matching `| acct_XXX | Name | ... |` record { acct, name, amount? }
const acctToNames = new Map(); // acct_id → Map<company_name, count>
for (const f of FILES) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (const l of lines) {
    if (!l.startsWith('|')) continue;
    const cells = cellsOf(l);
    // Pattern: first cell is acct_XXX, second is a non-empty company name
    if (!cells[0] || !cells[0].startsWith('acct_')) continue;
    const acct = cells[0];
    const name = cells[1]?.trim();
    if (!name || name.startsWith('#') || name === 'NO_HEADER') continue;
    if (!acctToNames.has(acct)) acctToNames.set(acct, new Map());
    const bag = acctToNames.get(acct);
    bag.set(name, (bag.get(name) ?? 0) + 1);
  }
}

// For each acct_id pick the most common company name.
const acctToName = new Map();
for (const [acct, nameBag] of acctToNames.entries()) {
  const best = [...nameBag.entries()].sort((a, b) => b[1] - a[1])[0][0];
  acctToName.set(acct, best);
}
console.log(`Transaction table: ${acctToName.size} unique acct_ IDs with company name attached.`);

// Build Allmoxy match helpers (same as before).
function compress(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|llp|lp|plc)\b\.?/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const byExactName = new Map(profiles.rows.map((p) => [p.name.toLowerCase().trim(), p]));
const byNormName = new Map();
const byDir = new Map();
for (const p of profiles.rows) {
  byNormName.set(normName(p.name), p);
  if (p.installer_directory) byDir.set(compress(p.installer_directory), p);
}
const overrideNameToId = new Map(Object.entries(overrides.mapping || {}).map(([n, id]) => [n.toLowerCase().trim(), id]));
const profileById = new Map(profiles.rows.map((p) => [p.allmoxy_customer_id, p]));

function findProfileByName(name) {
  const key = name.toLowerCase().trim();
  if (byExactName.has(key)) return { p: byExactName.get(key), via: 'name_exact' };
  const nn = normName(name);
  if (byNormName.has(nn)) return { p: byNormName.get(nn), via: 'name_normalized' };
  if (overrideNameToId.has(key)) {
    const id = overrideNameToId.get(key);
    if (profileById.has(id)) return { p: profileById.get(id), via: 'manual_override' };
  }
  // try compress on directory / name itself
  const c = compress(name);
  if (byDir.has(c)) return { p: byDir.get(c), via: 'compressed_match' };
  return null;
}

// Existing mapping first — don't overwrite acct_ IDs we already have.
const existingMap = overrides.stripe_connect_account_ids_by_id || {};
const existingIds = new Set(Object.entries(existingMap).filter(([k]) => !k.startsWith('_')).map(([, v]) => v));
const existingByAllmoxyId = new Map(Object.entries(existingMap).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [Number(k), v]));

let added = 0;
let skippedExistingAllmoxy = 0;
let skippedExistingAcct = 0;
let unmatchedCount = 0;
const unmatched = [];
const additions = [];

for (const [acct, name] of acctToName.entries()) {
  if (existingIds.has(acct)) { skippedExistingAcct++; continue; }
  const match = findProfileByName(name);
  if (!match) {
    unmatchedCount++;
    unmatched.push({ acct, name });
    continue;
  }
  const id = match.p.allmoxy_customer_id;
  if (existingByAllmoxyId.has(id)) {
    // Customer already has a primary acct_; store this as alternate.
    skippedExistingAllmoxy++;
    continue;
  }
  existingMap[String(id)] = acct;
  existingByAllmoxyId.set(id, acct);
  added++;
  additions.push({ allmoxy_id: id, allmoxy_name: match.p.name, sheet_name: name, acct, via: match.via });
}

overrides.stripe_connect_account_ids_by_id = existingMap;
overrides.updated_at = new Date().toISOString().slice(0, 10);
fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + '\n');

console.log(`\nResults:`);
console.log(`  Added ${added} new acct_ IDs to overrides.`);
console.log(`  Skipped ${skippedExistingAcct} (acct_ already present under some key).`);
console.log(`  Skipped ${skippedExistingAllmoxy} (customer already has a different acct_ mapped — treated as alternate, not written).`);
console.log(`  Unmatched: ${unmatchedCount} (acct_id exists but company name doesn't resolve to any Allmoxy customer).`);

console.log(`\nAdditions:`);
for (const a of additions) console.log(`  #${String(a.allmoxy_id).padStart(4)} ${a.allmoxy_name.padEnd(40)} ← ${a.sheet_name.padEnd(40)} ${a.acct}  (${a.via})`);

console.log(`\nUnmatched:`);
for (const u of unmatched) console.log(`  ${u.name.padEnd(45)} ${u.acct}`);

// Count total mapped after merge.
const finalMapped = Object.keys(existingMap).filter((k) => !k.startsWith('_')).length;
console.log(`\nTotal acct_ IDs in overrides now: ${finalMapped}`);
