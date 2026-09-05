#!/usr/bin/env node
/**
 * Toggle a customer's PROJECT CANDIDATE flag in _etl_scripts/project_candidates.json.
 *
 * A project candidate is a customer CS thinks is a good fit for a paid project /
 * services engagement, collected into the Revenue → Project Candidates page so the
 * list can be handed to Sales. It's an opinion flag — it changes no metric.
 *
 * Usage:
 *   node _etl_scripts/toggle_project_candidate.mjs add <id-or-name> [--note "why"]
 *   node _etl_scripts/toggle_project_candidate.mjs remove <id-or-name>
 *   node _etl_scripts/toggle_project_candidate.mjs list
 *
 * Arguments can be numeric Allmoxy IDs OR (partial) customer names — the script
 * searches customer_profiles.json case-insensitively and requires a unique match.
 *
 * Mirrors toggle_bid_only.mjs so both flags behave the same way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_PATH = path.join(ROOT, 'public/snapshots/customer_profiles.json');
const CONFIG_PATH = path.join(ROOT, '_etl_scripts/project_candidates.json');

const loadProfiles = () => { const d = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); return d.rows || d; };
const loadConfig = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const saveConfig = (c) => fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
const pname = (p) => p.hubspot_instance_name || p.customer_name || p.name || `(aid ${p.allmoxy_customer_id})`;

function resolveCustomer(arg, profiles) {
  if (/^\d+$/.test(String(arg).trim())) {
    const n = Number(arg);
    const hit = profiles.find((p) => p.allmoxy_customer_id === n);
    return hit ? { match: hit } : { match: null, reason: `no customer with allmoxy_customer_id=${n}` };
  }
  const q = String(arg).trim().toLowerCase();
  if (!q) return { match: null, reason: 'empty argument' };
  const hay = (p) => `${p.hubspot_instance_name || ''} ${p.customer_name || ''} ${p.name || ''}`.toLowerCase();
  const exact = profiles.filter((p) => (p.hubspot_instance_name || '').trim().toLowerCase() === q || (p.customer_name || '').trim().toLowerCase() === q);
  const pool = exact.length ? exact : profiles.filter((p) => hay(p).includes(q));
  if (pool.length === 1) return { match: pool[0] };
  if (!pool.length) return { match: null, reason: `no customer matching "${arg}"` };
  return { match: null, reason: `"${arg}" matched ${pool.length}: ${pool.slice(0, 8).map((p) => `${p.allmoxy_customer_id}=${pname(p)}`).join(', ')}` };
}

const [action, ...rest] = process.argv.slice(2);
const noteIdx = rest.indexOf('--note');
const note = noteIdx >= 0 ? rest[noteIdx + 1] : null;
const args = noteIdx >= 0 ? rest.slice(0, noteIdx) : rest;
const cfg = loadConfig();
cfg.project_candidate_allmoxy_customer_ids = cfg.project_candidate_allmoxy_customer_ids || [];
cfg.notes = cfg.notes || {};

if (action === 'list') {
  const profiles = loadProfiles();
  const ids = cfg.project_candidate_allmoxy_customer_ids;
  if (!ids.length) { console.log('No project candidates flagged.'); process.exit(0); }
  console.log(`${ids.length} project candidate(s):`);
  for (const id of ids) {
    const p = profiles.find((x) => x.allmoxy_customer_id === id);
    console.log(`  ${String(id).padStart(5)}  ${p ? pname(p) : '(unknown)'}${cfg.notes[id] ? ` — ${cfg.notes[id]}` : ''}`);
  }
  process.exit(0);
}
if (!['add', 'remove'].includes(action) || !args.length) {
  console.error('Usage: toggle_project_candidate.mjs add|remove <id-or-name> [--note "why"] | list');
  process.exit(1);
}

const profiles = loadProfiles();
const set = new Set(cfg.project_candidate_allmoxy_customer_ids);
let changed = 0;
for (const arg of args) {
  const { match, reason } = resolveCustomer(arg, profiles);
  if (!match) { console.error(`  ✗ ${reason}`); process.exitCode = 1; continue; }
  const id = match.allmoxy_customer_id;
  if (action === 'add') {
    if (set.has(id)) { console.log(`  = ${id} ${pname(match)} already a candidate`); continue; }
    set.add(id); if (note) cfg.notes[id] = note;
    console.log(`  + ${id} ${pname(match)}${note ? ` — ${note}` : ''}`); changed++;
  } else {
    if (!set.has(id)) { console.log(`  = ${id} ${pname(match)} was not a candidate`); continue; }
    set.delete(id); delete cfg.notes[id];
    console.log(`  − ${id} ${pname(match)}`); changed++;
  }
}
if (changed) {
  cfg.project_candidate_allmoxy_customer_ids = [...set].sort((a, b) => a - b);
  cfg.updated_at = new Date().toISOString().slice(0, 10);
  saveConfig(cfg);
  console.log(`\n${changed} change(s) written. Re-run build_project_candidates.mjs (or refresh) to rebuild the page.`);
}
