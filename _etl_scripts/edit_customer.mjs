#!/usr/bin/env node
/**
 * Manage per-customer field overrides in _etl_scripts/customer_overrides.json.
 *
 * Usage:
 *   node _etl_scripts/edit_customer.mjs set <aid|name> <field> <value> [--note "why"]
 *   node _etl_scripts/edit_customer.mjs unset <aid|name> <field>
 *   node _etl_scripts/edit_customer.mjs show <aid|name>
 *   node _etl_scripts/edit_customer.mjs list
 *   node _etl_scripts/edit_customer.mjs fields           # show allowed field names
 *
 * Examples:
 *   node _etl_scripts/edit_customer.mjs set 16 installer_id 155 --note "Door Company — sync had Cabinet Warehouse stale data"
 *   node _etl_scripts/edit_customer.mjs set "The Door Company" installer_directory thecabinetdoorco
 *   node _etl_scripts/edit_customer.mjs set 256 primary_segment "Closets"
 *   node _etl_scripts/edit_customer.mjs unset 16 installer_id
 *   node _etl_scripts/edit_customer.mjs show 16
 *
 * After editing overrides, re-run the pipeline:
 *   node _etl_scripts/build_customer_profiles.mjs > public/snapshots/customer_profiles.json
 *   node _etl_scripts/apply_annual_amortization.mjs
 *   node _etl_scripts/apply_customer_status_overrides.mjs
 *   node _etl_scripts/apply_customer_overrides.mjs       # this script's overrides
 *   node _etl_scripts/apply_never_paid_classification.mjs
 *   node _etl_scripts/build_orders_verified.mjs
 *   node _etl_scripts/build_churn_risk_matrix.mjs
 *   node _etl_scripts/build_time_to_value.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_PATH = path.join(ROOT, 'public/snapshots/customer_profiles.json');
const OVERRIDES_PATH = path.join(ROOT, '_etl_scripts/customer_overrides.json');

function loadProfiles() {
  return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')).rows || [];
}
function loadOverrides() {
  return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
}
function saveOverrides(doc) {
  doc.updated_at = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(doc, null, 2) + '\n');
}
function profileName(p) {
  return p.hubspot_instance_name || p.customer_name || p.name || `(aid ${p.allmoxy_customer_id})`;
}
function resolveCustomer(arg, profiles) {
  const asNum = Number(arg);
  if (Number.isFinite(asNum) && /^\d+$/.test(String(arg).trim())) {
    const hit = profiles.find((p) => p.allmoxy_customer_id === asNum);
    if (hit) return { match: hit, candidates: [hit] };
    return { match: null, candidates: [], reason: `no customer with allmoxy_customer_id=${asNum}` };
  }
  const q = String(arg).trim().toLowerCase();
  if (!q) return { match: null, candidates: [], reason: 'empty argument' };
  const exact = profiles.filter((p) =>
    (p.hubspot_instance_name || '').trim().toLowerCase() === q
    || (p.customer_name || '').trim().toLowerCase() === q
    || (p.name || '').trim().toLowerCase() === q
  );
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  const partial = profiles.filter((p) =>
    (p.hubspot_instance_name || '').toLowerCase().includes(q)
    || (p.customer_name || '').toLowerCase().includes(q)
    || (p.name || '').toLowerCase().includes(q)
  );
  if (partial.length === 1) return { match: partial[0], candidates: partial };
  if (partial.length === 0) return { match: null, candidates: [], reason: `no customer name contains "${arg}"` };
  return { match: null, candidates: partial, reason: `"${arg}" is ambiguous (${partial.length} matches) — use the allmoxy_customer_id instead` };
}

const argv = process.argv.slice(2);
const command = (argv[0] || '').toLowerCase();
const args = argv.slice(1);

if (!command || command === '--help' || command === '-h' || command === 'help') {
  console.log(`
Usage:
  node _etl_scripts/edit_customer.mjs set <aid|name> <field> <value> [--note "why"]
  node _etl_scripts/edit_customer.mjs unset <aid|name> <field>
  node _etl_scripts/edit_customer.mjs show <aid|name>
  node _etl_scripts/edit_customer.mjs list
  node _etl_scripts/edit_customer.mjs fields

Examples:
  node _etl_scripts/edit_customer.mjs set 16 installer_id 155 --note "Door Company"
  node _etl_scripts/edit_customer.mjs set "The Door Company" installer_directory thecabinetdoorco
  node _etl_scripts/edit_customer.mjs unset 16 installer_id
`);
  process.exit(0);
}

const overridesDoc = loadOverrides();
overridesDoc.overrides = overridesDoc.overrides || {};
const allowed = new Set(overridesDoc.allowed_fields || []);

if (command === 'fields') {
  console.log('Allowed field names:');
  for (const f of overridesDoc.allowed_fields || []) console.log('  ' + f);
  process.exit(0);
}

if (command === 'list') {
  const profiles = loadProfiles();
  const byAid = new Map(profiles.map((p) => [p.allmoxy_customer_id, p]));
  const entries = Object.entries(overridesDoc.overrides || {});
  console.log(`Currently overridden: ${entries.length} customer(s)`);
  for (const [aid, fields] of entries) {
    const p = byAid.get(Number(aid));
    const name = p ? profileName(p) : '(orphan)';
    const fieldSummary = Object.entries(fields)
      .filter(([k]) => !k.startsWith('_'))
      .map(([k, v]) => `${k}="${v}"`)
      .join('; ');
    const note = fields._note ? ` · ${fields._note}` : '';
    console.log(`  aid=${aid.padEnd(5)} ${name.padEnd(36)} ${fieldSummary}${note}`);
  }
  process.exit(0);
}

if (command !== 'set' && command !== 'unset' && command !== 'show') {
  console.error(`Unknown command "${command}". Run with --help to see usage.`);
  process.exit(2);
}

const profiles = loadProfiles();
const target = args[0];
if (!target) {
  console.error('Missing customer (aid or name).');
  process.exit(2);
}
const { match, candidates, reason } = resolveCustomer(target, profiles);
if (!match) {
  console.error(`Cannot resolve "${target}": ${reason}`);
  if (candidates && candidates.length > 1) {
    console.error('Candidates:');
    for (const c of candidates.slice(0, 8)) console.error(`  aid=${c.allmoxy_customer_id} ${profileName(c)}`);
    if (candidates.length > 8) console.error(`  ... and ${candidates.length - 8} more`);
  }
  process.exit(2);
}
const aid = match.allmoxy_customer_id;
const aidKey = String(aid);

if (command === 'show') {
  console.log(`aid=${aid} · ${profileName(match)}`);
  console.log(`  current snapshot value(s):`);
  for (const f of overridesDoc.allowed_fields || []) console.log(`    ${f}: ${JSON.stringify(match[f] ?? null)}`);
  const ov = overridesDoc.overrides[aidKey];
  console.log(`  active overrides: ${ov ? JSON.stringify(ov, null, 2) : '(none)'}`);
  process.exit(0);
}

if (command === 'unset') {
  const field = args[1];
  if (!field) { console.error('Missing field name for unset.'); process.exit(2); }
  const ov = overridesDoc.overrides[aidKey];
  if (!ov || !(field in ov)) {
    console.log(`No override for aid=${aid} field "${field}" — nothing to remove.`);
    process.exit(0);
  }
  delete ov[field];
  // If only metadata (_note) remains, drop the whole entry
  const remaining = Object.keys(ov).filter((k) => !k.startsWith('_'));
  if (remaining.length === 0) {
    delete overridesDoc.overrides[aidKey];
    console.log(`Removed override "${field}" from aid=${aid} · ${profileName(match)} (entry now empty, dropped)`);
  } else {
    console.log(`Removed override "${field}" from aid=${aid} · ${profileName(match)}`);
  }
  saveOverrides(overridesDoc);
  process.exit(0);
}

// command === 'set'
const field = args[1];
if (!field) { console.error('Missing field name.'); process.exit(2); }
if (!allowed.has(field)) {
  console.error(`Field "${field}" is not in allowed_fields. Run 'node _etl_scripts/edit_customer.mjs fields' to see the list.`);
  process.exit(2);
}
// Value handling: pull from remaining positional args; support --note "..."
let value = null;
let note = null;
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  if (a === '--note' || a === '-n') {
    note = args[i + 1] ?? null;
    i++;
  } else {
    if (value === null) value = a;
    else value += ' ' + a; // join multi-word unquoted values
  }
}
if (value === null) {
  console.error('Missing value.');
  process.exit(2);
}
const ov = overridesDoc.overrides[aidKey] || {};
const prev = ov[field];
ov[field] = value;
if (note) ov._note = note;
ov._set_at = new Date().toISOString().slice(0, 10);
overridesDoc.overrides[aidKey] = ov;
saveOverrides(overridesDoc);

const currentValue = match[field];
console.log(`Set override for aid=${aid} · ${profileName(match)}`);
console.log(`  field: ${field}`);
console.log(`  snapshot current: ${JSON.stringify(currentValue ?? null)}`);
console.log(`  override now    : "${value}"${prev !== undefined ? ` (was: "${prev}")` : ''}`);
if (note) console.log(`  note            : ${note}`);
console.log(`\nTo apply, re-run the pipeline (or just the apply step + downstream builds):`);
console.log(`  node _etl_scripts/apply_customer_overrides.mjs`);
console.log(`  node _etl_scripts/build_orders_verified.mjs`);
console.log(`  node _etl_scripts/build_churn_risk_matrix.mjs`);
console.log(`  node _etl_scripts/build_time_to_value.mjs`);
