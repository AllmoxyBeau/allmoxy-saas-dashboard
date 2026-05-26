#!/usr/bin/env node
/**
 * Rebuild stripe_connect_account_ids_by_id from scratch, using the
 * TRANSACTION TABLE as the authoritative source (each row: acct_ | Company Name | $ | Date).
 *
 * Falls back to the Company Info table for acct_s that have no transaction rows.
 *
 * Joins company names to Allmoxy customers via the connect_customer_overrides.mapping
 * (which the user has verified as correct) plus name-normalization fallbacks.
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
function normName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|llp|lp|plc)\b\.?/gi, ' ')
    .replace(/\bdba.*$/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function compress(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// 1. Parse all rows; two shapes matter:
//    Transaction rows: | acct_XXX | Company Name | $ | Date |
//    Company Info rows: | Name | Status | ... | Stripe Customer ID | Stripe Connect ID | ... | Installer Directory | ...
const acctTxCounts = new Map();          // acct_id → Map<companyName, count>
const acctFromInfoTable = new Map();     // acct_id → companyName (from Info table)

for (const f of FILES) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  // Find the Info table header
  let infoHeaderIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const cells = cellsOf(lines[i]);
    if (cells.some((c) => c === 'Stripe Connect ID') && cells[0] === 'Company Name') {
      infoHeaderIdx = i;
      break;
    }
  }

  // For each row, check pattern 1 then pattern 2.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith('|')) continue;
    const cells = cellsOf(l);
    // Transaction row: first cell acct_, second cell non-empty name
    if (cells[0]?.startsWith('acct_') && cells[1] && cells[1] !== 'NO_HEADER' && !cells[1].startsWith('#')) {
      const acct = cells[0];
      const name = cells[1].trim();
      if (!acctTxCounts.has(acct)) acctTxCounts.set(acct, new Map());
      const bag = acctTxCounts.get(acct);
      bag.set(name, (bag.get(name) ?? 0) + 1);
    }
  }

  // Info table — use Company Name (cells[0]) if it has an acct_ in cells[10] (Stripe Connect ID)
  if (infoHeaderIdx >= 0) {
    for (let i = infoHeaderIdx + 2; i < lines.length; i++) {
      if (!lines[i].startsWith('|')) continue;
      const cells = cellsOf(lines[i]);
      if (cells.length < 11) continue;
      const name = cells[0]?.trim();
      const acct = cells[10]?.trim();
      if (!name || !acct || !acct.startsWith('acct_') || name === 'NO_HEADER') continue;
      if (!acctFromInfoTable.has(acct)) acctFromInfoTable.set(acct, name);
    }
  }
}

// For each acct, pick the most common transaction-table name. Fallback to Info-table name.
function primaryName(acct) {
  const tx = acctTxCounts.get(acct);
  if (tx && tx.size > 0) {
    return [...tx.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return acctFromInfoTable.get(acct) ?? null;
}

// Build the universe of all acct_s seen.
const allAccts = new Set([...acctTxCounts.keys(), ...acctFromInfoTable.keys()]);
console.log(`Total unique acct_ IDs in source: ${allAccts.size}`);
console.log(`  With transaction rows: ${acctTxCounts.size}`);
console.log(`  With only Info-table row: ${[...allAccts].filter((a) => !acctTxCounts.has(a)).length}`);

// 2. Prepare name → allmoxy_id resolver.
const overrideMap = new Map(Object.entries(overrides.mapping || {}).map(([n, id]) => [n.toLowerCase().trim(), id]));
const byExactName = new Map(profiles.rows.map((p) => [p.name.toLowerCase().trim(), p]));
const byNormName = new Map();
for (const p of profiles.rows) {
  const nn = normName(p.name);
  if (!byNormName.has(nn)) byNormName.set(nn, []);
  byNormName.get(nn).push(p);
}
const byId = new Map(profiles.rows.map((p) => [p.allmoxy_customer_id, p]));

// Fee-earner canonical ids (the ones the user verified).
const feeEarnerIds = new Set(Object.values(overrides.mapping || {}));

function resolve(name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  // 1. User-verified override mapping — highest trust
  if (overrideMap.has(key)) {
    const id = overrideMap.get(key);
    if (byId.has(id)) return { p: byId.get(id), via: 'override_mapping' };
  }
  // 2. Exact profile name
  if (byExactName.has(key)) return { p: byExactName.get(key), via: 'exact_name' };
  // 3. Normalized name — prefer fee-earner if multiple candidates
  const nn = normName(name);
  const hits = byNormName.get(nn) || [];
  if (hits.length === 1) return { p: hits[0], via: 'normalized_name' };
  if (hits.length > 1) {
    const feeEarner = hits.find((p) => feeEarnerIds.has(p.allmoxy_customer_id));
    if (feeEarner) return { p: feeEarner, via: 'normalized_name (fee-earner pref)' };
    return { p: hits[0], via: 'normalized_name (ambiguous)' };
  }
  return null;
}

// 3. Build fresh map + collect stats.
const newMap = { _comment: overrides.stripe_connect_account_ids_by_id?._comment || 'Map from allmoxy_customer_id → Stripe Connect acct_... ID.' };
const alternates = {};
const unmapped = [];
const conflicts = [];

// Sort acct_s by transaction count desc so higher-evidence ones resolve first.
const acctsSorted = [...allAccts].sort((a, b) => {
  const ca = [...(acctTxCounts.get(a)?.values() ?? [0])].reduce((s, v) => s + v, 0);
  const cb = [...(acctTxCounts.get(b)?.values() ?? [0])].reduce((s, v) => s + v, 0);
  return cb - ca;
});

for (const acct of acctsSorted) {
  const name = primaryName(acct);
  if (!name) continue;
  const resolved = resolve(name);
  if (!resolved) {
    unmapped.push({ acct, name });
    continue;
  }
  const id = resolved.p.allmoxy_customer_id;
  const key = String(id);
  if (newMap[key]) {
    // Customer already has an acct_ — this one becomes an alternate.
    alternates[key] = alternates[key] || { name: resolved.p.name, primary_acct: newMap[key], alternates: [] };
    alternates[key].alternates.push({ acct, source_name: name, via: resolved.via });
  } else {
    newMap[key] = acct;
  }
}

// 4. Preserve the M2M / #N/A unmapped section (written earlier).
const keepUnmapped = overrides.unmapped || {};

// Write.
overrides.stripe_connect_account_ids_by_id = newMap;
overrides.alternate_stripe_connect_account_ids = {
  _comment: 'Additional acct_ IDs found in source data that belong to customers who already have a primary acct_ (legacy/migrated accounts).',
  ...Object.fromEntries(Object.entries(alternates).map(([id, v]) => [id, v])),
};
overrides.unmapped = keepUnmapped;
overrides.updated_at = new Date().toISOString().slice(0, 10);
fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + '\n');

const primaryCount = Object.keys(newMap).filter((k) => !k.startsWith('_')).length;
const altCount = Object.keys(alternates).length;

console.log(`\nResult after rebuild:`);
console.log(`  Primary acct_ mappings:  ${primaryCount}`);
console.log(`  Customers with alternate acct_s: ${altCount}`);
console.log(`  Unmapped acct_s (no Allmoxy customer): ${unmapped.length}`);
if (unmapped.length > 0) {
  for (const u of unmapped) console.log(`    ${u.acct}  (${u.name})`);
}

// 5. Cross-check against fee-earner list — how many fee-earners still need acct_?
const feeEarnerNoAcct = [...feeEarnerIds].filter((id) => !newMap[String(id)]);
console.log(`\nFee-earning customers still missing acct_: ${feeEarnerNoAcct.length}`);
feeEarnerNoAcct
  .map((id) => ({ id, p: byId.get(id) }))
  .filter((x) => x.p)
  .sort((a, b) => (b.p.lifetime_connect ?? 0) - (a.p.lifetime_connect ?? 0))
  .forEach((x) => console.log(`  #${String(x.id).padStart(4)}  ${x.p.name.padEnd(42)} dir=${(x.p.installer_directory || '—').padEnd(25)} $${x.p.lifetime_connect}`));
