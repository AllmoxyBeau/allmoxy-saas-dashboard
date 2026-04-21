#!/usr/bin/env node
/**
 * Parse the second table (the "Company info" table, starting ~line 164) of each
 * Stripe Connect Revenue markdown file and extract: company name, Stripe Connect
 * ID (acct_...), Stripe Customer ID, Installer Directory, HubSpot ID, Installer ID.
 *
 * Merge across 2024/2025/2026 files (dedupe by company name, prefer rows with
 * more fields populated). Output is a proposal JSON for review; then we join
 * against customer_profiles to map each acct_ ID to an allmoxy_customer_id.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILES = ['/tmp/connect2024.md', '/tmp/connect2025.md', '/tmp/connect2026.md'];
const SNAP = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

function unescapeMd(cell) {
  return cell
    .replace(/\\_/g, '_')
    .replace(/\\#/g, '#')
    .replace(/\\&/g, '&')
    .replace(/\\!/g, '!')
    .replace(/\\\|/g, '|')
    .trim();
}
function cellsOf(line) {
  const parts = line.split('|');
  if (parts[0] === '') parts.shift();
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map(unescapeMd);
}

// Find the header line for the per-company table: has "Stripe Connect ID" cell.
function parseFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let headerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const cells = cellsOf(lines[i]);
    if (cells.some((c) => c === 'Stripe Connect ID')) {
      headerLineIdx = i;
      break;
    }
  }
  if (headerLineIdx === -1) return [];
  const header = cellsOf(lines[headerLineIdx]);
  // Column indexes we care about (absolute index inside the cell array).
  const idx = (name) => header.indexOf(name);
  const IDX = {
    name: idx('Company Name'),
    status: idx('Status'),
    segment: idx('Current Industry Segment'),
    state: idx('State'),
    created: idx('Date Created'),
    cancelled: idx('Cancellation Date'),
    stripe_customer_id: idx('Stripe Customer ID'),
    stripe_connect_id: idx('Stripe Connect ID'),
    installer_directory: idx('Installer Directory'),
    hubspot: idx('Husbpot ID'), // note: typo in source
    installer_id: idx('Installer ID'),
    renewal_start: idx('Renewal Commission Start'),
    renewal_stop: idx('Renewal Commission Stop'),
    renewal_pct: idx('Renewal Commission %'),
    affiliate: idx('Affiliate'),
    affiliate_pct: idx('Affiliate %'),
    stripe_2: idx('Stripe ID 2'),
    stripe_3: idx('Stripe ID 3'),
  };
  // Data rows come after headerLineIdx + 1 (the delimiter row).
  const rows = [];
  for (let i = headerLineIdx + 2; i < lines.length; i++) {
    if (!lines[i].startsWith('|')) continue;
    const cells = cellsOf(lines[i]);
    if (cells.length < header.length - 2) continue; // skip malformed
    const name = cells[IDX.name]?.trim();
    if (!name || name === 'NO_HEADER') continue;
    const connectId = cells[IDX.stripe_connect_id]?.trim();
    rows.push({
      source: path.basename(filePath),
      name,
      status: cells[IDX.status] ?? null,
      segment: cells[IDX.segment] ?? null,
      state: cells[IDX.state] ?? null,
      date_created: cells[IDX.created] ?? null,
      cancellation_date: cells[IDX.cancelled] ?? null,
      stripe_customer_id: cells[IDX.stripe_customer_id]?.trim() || null,
      stripe_connect_id: connectId && connectId.startsWith('acct_') ? connectId : null,
      stripe_id_2: cells[IDX.stripe_2]?.trim() || null,
      stripe_id_3: cells[IDX.stripe_3]?.trim() || null,
      installer_directory: cells[IDX.installer_directory]?.trim() || null,
      installer_id: cells[IDX.installer_id]?.trim() || null,
      hubspot_id: cells[IDX.hubspot]?.trim() || null,
      renewal_commission_start: cells[IDX.renewal_start] ?? null,
      renewal_commission_stop: cells[IDX.renewal_stop] ?? null,
      renewal_commission_pct: cells[IDX.renewal_pct] ?? null,
      affiliate: cells[IDX.affiliate] ?? null,
      affiliate_pct: cells[IDX.affiliate_pct] ?? null,
    });
  }
  return rows;
}

// Merge per company name, preferring rows with more fields populated.
function fieldCount(row) {
  let c = 0;
  for (const v of Object.values(row)) if (v != null && v !== '' && v !== 'NO_HEADER') c++;
  return c;
}

const byName = new Map();
for (const f of FILES) {
  const rows = parseFile(f);
  for (const r of rows) {
    const key = r.name.toLowerCase().trim();
    const existing = byName.get(key);
    if (!existing || fieldCount(r) > fieldCount(existing)) byName.set(key, r);
  }
}

console.log(`Parsed ${byName.size} unique companies across 3 Connect sheets.`);
const withConnect = [...byName.values()].filter((r) => r.stripe_connect_id);
console.log(`  with Stripe Connect ID: ${withConnect.length}`);

// Join to allmoxy roster by multiple keys.
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));
const overridesPath = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/connect_customer_overrides.json';
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
const overrideNameToId = new Map(Object.entries(overrides.mapping || {}).map(([name, id]) => [name.toLowerCase().trim(), id]));

function n(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function normName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|llp|lp|plc)\b\.?/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const byProfileId = new Map(profiles.rows.map((p) => [p.allmoxy_customer_id, p]));
const profileByDir = new Map();
const profileByName = new Map();
const profileByNormName = new Map();
for (const p of profiles.rows) {
  if (p.installer_directory) profileByDir.set(n(p.installer_directory), p);
  if (p.name) {
    profileByName.set(p.name.toLowerCase().trim(), p);
    profileByNormName.set(normName(p.name), p);
  }
}

function findProfile(row) {
  // 1. installer_directory exact (compressed)
  if (row.installer_directory) {
    const p = profileByDir.get(n(row.installer_directory));
    if (p) return { p, via: 'installer_directory' };
  }
  // 2. installer_id exact (string compare)
  if (row.installer_id) {
    for (const p of profiles.rows) {
      if (String(p.installer_id || '') === String(row.installer_id || '').trim() && row.installer_id.toString().length > 0) {
        return { p, via: 'installer_id' };
      }
    }
  }
  // 3. hubspot_id exact
  if (row.hubspot_id) {
    for (const p of profiles.rows) {
      if (String(p.hubspot_company_id || '') === String(row.hubspot_id || '').trim() && row.hubspot_id.toString().length > 0) {
        return { p, via: 'hubspot_id' };
      }
    }
  }
  // 4. stripe_customer_id intersection
  if (row.stripe_customer_id) {
    for (const p of profiles.rows) {
      if (Array.isArray(p.stripe_customer_ids) && p.stripe_customer_ids.includes(row.stripe_customer_id)) {
        return { p, via: 'stripe_customer_id' };
      }
    }
  }
  // 5. exact name match
  const exact = profileByName.get(row.name.toLowerCase().trim());
  if (exact) return { p: exact, via: 'name_exact' };
  // 6. normalized name match
  const norm = profileByNormName.get(normName(row.name));
  if (norm) return { p: norm, via: 'name_normalized' };
  // 7. manual override lookup (from connect_customer_overrides.json mapping)
  const overrideId = overrideNameToId.get(row.name.toLowerCase().trim());
  if (overrideId && byProfileId.has(overrideId)) {
    return { p: byProfileId.get(overrideId), via: 'manual_override' };
  }
  return null;
}

const joinResults = [];
for (const r of byName.values()) {
  const match = findProfile(r);
  joinResults.push({ ...r, matched_allmoxy_id: match?.p.allmoxy_customer_id ?? null, matched_name: match?.p.name ?? null, join_method: match?.via ?? null });
}

const connectWithMatch = joinResults.filter((r) => r.stripe_connect_id && r.matched_allmoxy_id);
const connectWithoutMatch = joinResults.filter((r) => r.stripe_connect_id && !r.matched_allmoxy_id);
const matchNoConnect = joinResults.filter((r) => !r.stripe_connect_id && r.matched_allmoxy_id);

console.log(`\nMatch results:`);
console.log(`  Connect ID → matched Allmoxy customer: ${connectWithMatch.length}`);
console.log(`  Connect ID → NO match: ${connectWithoutMatch.length}`);
console.log(`  Matched companies with NO Connect ID: ${matchNoConnect.length}`);

// Group join methods
const byVia = {};
for (const r of connectWithMatch) byVia[r.join_method] = (byVia[r.join_method] ?? 0) + 1;
console.log('  Join methods used:', byVia);

// Build the acct_id map keyed by allmoxy_customer_id.
const byAllmoxyId = {};
for (const r of connectWithMatch) {
  byAllmoxyId[r.matched_allmoxy_id] = r.stripe_connect_id;
}

// Write the proposal JSON.
const proposal = {
  generated_at: new Date().toISOString(),
  sources: FILES.map((f) => path.basename(f)),
  summary: {
    unique_companies_in_sheets: byName.size,
    with_stripe_connect_id: withConnect.length,
    matched_to_allmoxy_customer: connectWithMatch.length,
    unmatched: connectWithoutMatch.length,
  },
  stripe_connect_account_ids_by_id: byAllmoxyId,
  unmatched_companies: connectWithoutMatch.map((r) => ({ name: r.name, stripe_connect_id: r.stripe_connect_id, stripe_customer_id: r.stripe_customer_id, installer_directory: r.installer_directory, installer_id: r.installer_id, hubspot_id: r.hubspot_id })),
  all_matched: connectWithMatch.map((r) => ({ allmoxy_id: r.matched_allmoxy_id, allmoxy_name: r.matched_name, sheet_name: r.name, stripe_connect_id: r.stripe_connect_id, join_method: r.join_method })),
};
fs.writeFileSync('/tmp/connect_acct_proposal.json', JSON.stringify(proposal, null, 2));
console.log(`\nProposal written: /tmp/connect_acct_proposal.json`);

// Update connect_customer_overrides.json — write the matched acct_ IDs into
// stripe_connect_account_ids_by_id so the Custom Report surfaces them.
const existing = overrides.stripe_connect_account_ids_by_id ?? {};
const keepComment = existing._comment;
const nextMap = {};
if (keepComment) nextMap._comment = keepComment;
for (const [allmoxyId, acctId] of Object.entries(byAllmoxyId)) {
  nextMap[allmoxyId] = acctId;
}
overrides.stripe_connect_account_ids_by_id = nextMap;
overrides.updated_at = new Date().toISOString().slice(0, 10);
fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + '\n');
console.log(`Wrote ${Object.keys(byAllmoxyId).length} acct_ IDs into connect_customer_overrides.json`);
console.log(`\n${connectWithoutMatch.length} unmatched acct_ IDs (sample):`);
connectWithoutMatch.slice(0, 10).forEach((r) => console.log(`   ${r.name.padEnd(45)} ${r.stripe_connect_id}  dir=${r.installer_directory ?? '—'}`));
