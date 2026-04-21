#!/usr/bin/env node
/**
 * Rebuild stripe_connect_account_ids_by_id from the full xlsx (Stripe Connect Revenue 2026.xlsx).
 *   - Master Class Import tab: authoritative acct_ + installer_directory + ids
 *   - Data for Pivot tab: acct_ → Company Name frequency (cross-check)
 *
 * Joins to Allmoxy customer_profiles via installer_directory / name / override mapping.
 */

import fs from 'node:fs';
import path from 'node:path';

const XLSX_PATH = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/Stripe Connect Revenue 2026.xlsx';
const overridesPath = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/connect_customer_overrides.json';
const SNAP = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

const XLSX = await import('/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs');
const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer', cellDates: false });

// Master Class Import: header row at index 0.
const masterAoa = XLSX.utils.sheet_to_json(wb.Sheets['Master Class Import'], { header: 1, defval: null, raw: false });
const masterHdr = masterAoa[0];
const col = (name) => masterHdr.indexOf(name);
const IDX = {
  company: col('Company Name'),
  status: col('Status'),
  stripe_customer_id: col('Stripe Customer ID'),
  stripe_connect_id: col('Stripe Connect ID'),
  stripe_id_2: col('Stripe ID 2'),
  stripe_id_3: col('Stripe ID 3'),
  installer_directory: col('Installer Directory'),
  installer_id: col('Installer ID'),
  hubspot_id: col('Husbpot ID'),
};

// Data for Pivot: no header; cols = [acct_, Company Name, Amount, Date].
const pivotAoa = XLSX.utils.sheet_to_json(wb.Sheets['Data for Pivot'], { header: 1, defval: null, raw: false });

// Build acct_ → most common company name from pivot (authoritative).
const acctCompanyCounts = new Map();
for (const row of pivotAoa) {
  if (!row) continue;
  const acct = row[0];
  const name = row[1];
  if (!acct || !acct.startsWith || !acct.startsWith('acct_') || !name) continue;
  if (!acctCompanyCounts.has(acct)) acctCompanyCounts.set(acct, new Map());
  const bag = acctCompanyCounts.get(acct);
  bag.set(name, (bag.get(name) ?? 0) + 1);
}

// Build acct_ → { companyName, installer_dir, installer_id, stripe_customer_id, hubspot_id } from Master Class Import.
const acctInfo = new Map();
for (let i = 1; i < masterAoa.length; i++) {
  const r = masterAoa[i];
  if (!r) continue;
  const name = r[IDX.company];
  const acct = r[IDX.stripe_connect_id];
  if (!name || !acct || typeof acct !== 'string' || !acct.startsWith('acct_')) continue;
  if (!acctInfo.has(acct)) {
    acctInfo.set(acct, {
      name,
      installer_directory: r[IDX.installer_directory] || null,
      installer_id: r[IDX.installer_id] || null,
      stripe_customer_id: r[IDX.stripe_customer_id] || null,
      hubspot_id: r[IDX.hubspot_id] || null,
    });
  }
  // Also Stripe ID 2 / 3 — alternate acct_s for this company
  for (const idx of [IDX.stripe_id_2, IDX.stripe_id_3]) {
    if (idx >= 0) {
      const alt = r[idx];
      if (alt && typeof alt === 'string' && alt.startsWith('acct_') && !acctInfo.has(alt)) {
        acctInfo.set(alt, {
          name,
          installer_directory: r[IDX.installer_directory] || null,
          installer_id: r[IDX.installer_id] || null,
          stripe_customer_id: r[IDX.stripe_customer_id] || null,
          hubspot_id: r[IDX.hubspot_id] || null,
          note: 'secondary acct (Stripe ID 2/3)',
        });
      }
    }
  }
}

// Union: every unique acct_ we've ever seen.
const allAccts = new Set([...acctCompanyCounts.keys(), ...acctInfo.keys()]);
console.log(`acct_ IDs: pivot=${acctCompanyCounts.size} masterImport=${acctInfo.size} UNION=${allAccts.size}`);

// Load profiles + overrides for joining.
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));

function compress(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|llp|lp|plc)\b\.?/gi, ' ')
    .replace(/\bdba.*$/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const overrideMap = new Map(Object.entries(overrides.mapping || {}).map(([n, id]) => [n.toLowerCase().trim(), id]));
const byExactName = new Map(profiles.rows.map((p) => [p.name.toLowerCase().trim(), p]));
const byNormName = new Map();
const byDir = new Map();
for (const p of profiles.rows) {
  const nn = normName(p.name);
  if (!byNormName.has(nn)) byNormName.set(nn, []);
  byNormName.get(nn).push(p);
  if (p.installer_directory) byDir.set(compress(p.installer_directory), p);
}
const byId = new Map(profiles.rows.map((p) => [p.allmoxy_customer_id, p]));
const feeEarnerIds = new Set(Object.values(overrides.mapping || {}));

function resolve({ name, installer_directory, hubspot_id, stripe_customer_id }) {
  // 1. Override mapping (user-verified) — HIGHEST trust
  if (name) {
    const key = name.toLowerCase().trim();
    if (overrideMap.has(key)) {
      const id = overrideMap.get(key);
      if (byId.has(id)) return { p: byId.get(id), via: 'override_mapping' };
    }
  }
  // 2. Installer directory
  if (installer_directory) {
    const p = byDir.get(compress(installer_directory));
    if (p) return { p, via: 'installer_directory' };
  }
  // 3. HubSpot id
  if (hubspot_id) {
    for (const p of profiles.rows) {
      if (String(p.hubspot_company_id ?? '') === String(hubspot_id).trim()) return { p, via: 'hubspot_id' };
    }
  }
  // 4. Stripe customer id intersection
  if (stripe_customer_id) {
    for (const p of profiles.rows) {
      if (Array.isArray(p.stripe_customer_ids) && p.stripe_customer_ids.includes(stripe_customer_id)) return { p, via: 'stripe_customer_id' };
    }
  }
  // 5. Exact profile name
  if (name) {
    const key = name.toLowerCase().trim();
    if (byExactName.has(key)) return { p: byExactName.get(key), via: 'exact_name' };
    const nn = normName(name);
    const hits = byNormName.get(nn) || [];
    if (hits.length === 1) return { p: hits[0], via: 'normalized_name' };
    if (hits.length > 1) {
      const fe = hits.find((p) => feeEarnerIds.has(p.allmoxy_customer_id));
      if (fe) return { p: fe, via: 'normalized_name (fee-earner preferred)' };
      return { p: hits[0], via: 'normalized_name (ambiguous)' };
    }
  }
  return null;
}

// For each acct_, derive the best company attribution.
// Priority: most-frequent pivot company name > Master Class Import name.
function bestCompanyName(acct) {
  const bag = acctCompanyCounts.get(acct);
  if (bag && bag.size > 0) {
    const [topName, topCount] = [...bag.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount >= 3) return topName;
    // Low-frequency: prefer master import name if available
    return acctInfo.get(acct)?.name || topName;
  }
  return acctInfo.get(acct)?.name || null;
}

// Build fresh map.
const newMap = { _comment: overrides.stripe_connect_account_ids_by_id?._comment || 'Map from allmoxy_customer_id → Stripe Connect acct_... ID.' };
const alternates = { _comment: 'Additional acct_ IDs found for customers who already have a primary acct_ (legacy/migrated or Stripe ID 2/3).' };
const unmapped = [];

// Sort accts by transaction volume desc so high-evidence wins any ties.
const acctsSorted = [...allAccts].sort((a, b) => {
  const ca = [...(acctCompanyCounts.get(a)?.values() ?? [0])].reduce((s, v) => s + v, 0);
  const cb = [...(acctCompanyCounts.get(b)?.values() ?? [0])].reduce((s, v) => s + v, 0);
  return cb - ca;
});

for (const acct of acctsSorted) {
  const info = acctInfo.get(acct) || {};
  const name = bestCompanyName(acct);
  const hint = { name, installer_directory: info.installer_directory, hubspot_id: info.hubspot_id, stripe_customer_id: info.stripe_customer_id };
  const resolved = resolve(hint);
  if (!resolved) {
    unmapped.push({ acct, name, info });
    continue;
  }
  const id = resolved.p.allmoxy_customer_id;
  const key = String(id);
  if (newMap[key]) {
    alternates[key] = alternates[key] || { name: resolved.p.name, primary_acct: newMap[key], alternates: [] };
    alternates[key].alternates.push({ acct, source_name: name, via: resolved.via });
  } else {
    newMap[key] = acct;
  }
}

// Preserve unmapped section.
const keepUnmapped = overrides.unmapped || {};
overrides.stripe_connect_account_ids_by_id = newMap;
overrides.alternate_stripe_connect_account_ids = alternates;
overrides.unmapped = keepUnmapped;
// Merge new unmatched into unmapped (so user can research)
for (const u of unmapped) {
  const label = u.name ? `${u.name} (unmapped-acct)` : `unmapped-acct-${u.acct.slice(-8)}`;
  if (!keepUnmapped[label]) {
    keepUnmapped[label] = { stripe_account_id: u.acct, note: u.name ? `Name "${u.name}" does not resolve to any Allmoxy customer.` : 'No name attached.' };
  }
}
overrides.updated_at = new Date().toISOString().slice(0, 10);
fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + '\n');

const primaryCount = Object.keys(newMap).filter((k) => !k.startsWith('_')).length;
const altCount = Object.keys(alternates).filter((k) => !k.startsWith('_')).length;

console.log(`\n=== Result ===`);
console.log(`Primary acct_ mappings:  ${primaryCount}`);
console.log(`Customers with alternate acct_s: ${altCount}`);
console.log(`Unmapped (no Allmoxy customer): ${unmapped.length}`);
if (unmapped.length > 0) {
  console.log('Unmapped details:');
  for (const u of unmapped) console.log(`  ${u.acct}  "${u.name ?? '—'}"  dir=${u.info.installer_directory ?? '—'}`);
}

// Fee-earner coverage.
const feeEarnerNoAcct = [...feeEarnerIds].filter((id) => !newMap[String(id)]);
console.log(`\nFee-earning customers still missing acct_: ${feeEarnerNoAcct.length}`);
for (const id of feeEarnerNoAcct) {
  const p = byId.get(id);
  if (p) console.log(`  #${String(id).padStart(4)} ${p.name.padEnd(42)} dir=${(p.installer_directory ?? '—').padEnd(25)} $${p.lifetime_connect}`);
}
