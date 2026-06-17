#!/usr/bin/env node
/**
 * Toggle a customer's bid-only flag in _etl_scripts/bid_only_customers.json.
 *
 * Usage:
 *   node _etl_scripts/toggle_bid_only.mjs add <id-or-name> [...more]
 *   node _etl_scripts/toggle_bid_only.mjs remove <id-or-name> [...more]
 *   node _etl_scripts/toggle_bid_only.mjs list
 *
 * Arguments can be numeric Allmoxy IDs OR (partial) customer names — the
 * script searches customer_profiles.json case-insensitively and asks for a
 * unique match. If multiple match, it lists them and exits without writing.
 *
 * After updating the JSON, the script tells you which downstream builds to
 * re-run (orders + matrix + TTV). Doesn't auto-run them so you can batch
 * multiple toggles before rebuilding.
 *
 * Examples:
 *   node _etl_scripts/toggle_bid_only.mjs add 529
 *   node _etl_scripts/toggle_bid_only.mjs add "NXT Cabinets"
 *   node _etl_scripts/toggle_bid_only.mjs add 529 164 "Cabredo"
 *   node _etl_scripts/toggle_bid_only.mjs remove 164
 *   node _etl_scripts/toggle_bid_only.mjs list
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_PATH = path.join(ROOT, 'public/snapshots/customer_profiles.json');
const CONFIG_PATH = path.join(ROOT, '_etl_scripts/bid_only_customers.json');

function loadProfiles() {
  const data = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
  return data.rows || data;
}
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}
function profileName(p) {
  return p.hubspot_instance_name || p.customer_name || p.name || `(aid ${p.allmoxy_customer_id})`;
}
function resolveCustomer(arg, profiles) {
  // Numeric → direct lookup by allmoxy_customer_id
  const asNum = Number(arg);
  if (Number.isFinite(asNum) && /^\d+$/.test(String(arg).trim())) {
    const hit = profiles.find((p) => p.allmoxy_customer_id === asNum);
    if (hit) return { match: hit, candidates: [hit] };
    return { match: null, candidates: [], reason: `no customer with allmoxy_customer_id=${asNum}` };
  }
  // String → fuzzy match by name (instance + customer name)
  const q = String(arg).trim().toLowerCase();
  if (!q) return { match: null, candidates: [], reason: 'empty argument' };
  const exact = profiles.filter((p) =>
    (p.hubspot_instance_name || '').trim().toLowerCase() === q
    || (p.customer_name || '').trim().toLowerCase() === q
  );
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  const partial = profiles.filter((p) =>
    (p.hubspot_instance_name || '').toLowerCase().includes(q)
    || (p.customer_name || '').toLowerCase().includes(q)
  );
  if (partial.length === 1) return { match: partial[0], candidates: partial };
  if (partial.length === 0) return { match: null, candidates: [], reason: `no customer name contains "${arg}"` };
  return { match: null, candidates: partial, reason: `"${arg}" is ambiguous (${partial.length} matches) — use the allmoxy_customer_id instead` };
}

function cmd(argv) {
  return (argv[0] || '').toLowerCase();
}

const argv = process.argv.slice(2);
const command = cmd(argv);
const args = argv.slice(1);

if (!command || command === '--help' || command === '-h' || command === 'help') {
  console.log(`
Usage:
  node _etl_scripts/toggle_bid_only.mjs add <id-or-name> [...more]
  node _etl_scripts/toggle_bid_only.mjs remove <id-or-name> [...more]
  node _etl_scripts/toggle_bid_only.mjs list

Examples:
  node _etl_scripts/toggle_bid_only.mjs add 529
  node _etl_scripts/toggle_bid_only.mjs add "NXT Cabinets"
  node _etl_scripts/toggle_bid_only.mjs add 529 164
  node _etl_scripts/toggle_bid_only.mjs remove 164
  node _etl_scripts/toggle_bid_only.mjs list
`);
  process.exit(0);
}

const cfg = loadConfig();
cfg.bid_only_allmoxy_customer_ids = Array.isArray(cfg.bid_only_allmoxy_customer_ids) ? cfg.bid_only_allmoxy_customer_ids : [];

if (command === 'list') {
  const profiles = loadProfiles();
  const profByAid = new Map(profiles.map((p) => [p.allmoxy_customer_id, p]));
  console.log(`Currently bid-only: ${cfg.bid_only_allmoxy_customer_ids.length} customer(s)`);
  if (cfg.bid_only_allmoxy_customer_ids.length === 0) {
    console.log('  (none)');
    process.exit(0);
  }
  for (const id of cfg.bid_only_allmoxy_customer_ids) {
    const p = profByAid.get(id);
    if (!p) {
      console.log(`  aid=${id}  (orphan — not in customer_profiles)`);
      continue;
    }
    const name = profileName(p);
    const mrr = p.current_subscription_mrr || 0;
    const owner = p.instance_owner_first_name || p.instance_owner || '—';
    console.log(`  aid=${id.toString().padEnd(5)} ${name.padEnd(36)} owner=${owner.padEnd(8)} MRR=$${mrr.toFixed(0).padStart(6)}/mo  status=${p.status}`);
  }
  process.exit(0);
}

if (command !== 'add' && command !== 'remove') {
  console.error(`Unknown command "${command}". Run with --help to see usage.`);
  process.exit(2);
}
if (args.length === 0) {
  console.error(`No customers provided. Usage: node _etl_scripts/toggle_bid_only.mjs ${command} <id-or-name>`);
  process.exit(2);
}

const profiles = loadProfiles();
const currentIds = new Set(cfg.bid_only_allmoxy_customer_ids);
const added = [];
const removed = [];
const skipped = []; // { arg, reason }

for (const arg of args) {
  const { match, candidates, reason } = resolveCustomer(arg, profiles);
  if (!match) {
    skipped.push({ arg, reason: reason || 'no match', candidates });
    continue;
  }
  const aid = match.allmoxy_customer_id;
  if (command === 'add') {
    if (currentIds.has(aid)) {
      skipped.push({ arg, reason: `already bid-only (aid ${aid} · ${profileName(match)})` });
      continue;
    }
    currentIds.add(aid);
    added.push({ aid, name: profileName(match) });
  } else {
    if (!currentIds.has(aid)) {
      skipped.push({ arg, reason: `not currently bid-only (aid ${aid} · ${profileName(match)})` });
      continue;
    }
    currentIds.delete(aid);
    removed.push({ aid, name: profileName(match) });
  }
}

cfg.bid_only_allmoxy_customer_ids = [...currentIds].sort((a, b) => a - b);
cfg.updated_at = new Date().toISOString().slice(0, 10);
saveConfig(cfg);

if (added.length > 0) {
  console.log(`\nAdded ${added.length} bid-only customer(s):`);
  for (const a of added) console.log(`  + aid=${a.aid} ${a.name}`);
}
if (removed.length > 0) {
  console.log(`\nRemoved ${removed.length} bid-only customer(s):`);
  for (const r of removed) console.log(`  − aid=${r.aid} ${r.name}`);
}
if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} argument(s):`);
  for (const s of skipped) {
    console.log(`  ? "${s.arg}" — ${s.reason}`);
    if (s.candidates && s.candidates.length > 1) {
      for (const c of s.candidates.slice(0, 6)) console.log(`      candidate: aid=${c.allmoxy_customer_id} ${profileName(c)}`);
      if (s.candidates.length > 6) console.log(`      ... and ${s.candidates.length - 6} more`);
    }
  }
}

console.log(`\nNow: ${currentIds.size} bid-only customer(s) in ${path.relative(ROOT, CONFIG_PATH)}`);
if (added.length > 0 || removed.length > 0) {
  console.log(`\nTo apply changes, re-run the downstream builds:`);
  console.log(`  node _etl_scripts/build_orders_verified.mjs`);
  console.log(`  node _etl_scripts/build_churn_risk_matrix.mjs`);
  console.log(`  node _etl_scripts/build_time_to_value.mjs`);
}
