#!/usr/bin/env node
/**
 * One-shot discovery: enumerate every property on the Allmoxy Instance custom
 * object (HubSpot object type 2-39181518) so we know what's available before
 * extending sync_hubspot.mjs.
 *
 * Output:
 *   - _etl_scripts/cache/hubspot_instance_schema.json (full schema dump)
 *   - stdout: filtered list of renewal/contract/value-related properties
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '_etl_scripts/cache');
const OUT = path.join(CACHE_DIR, 'hubspot_instance_schema.json');
const OBJECT_TYPE = '2-39181518';

// Load HUBSPOT_TOKEN from .env.local (same pattern as sync_hubspot.mjs).
const envPath = path.join(ROOT, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z_0-9]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('HUBSPOT_TOKEN missing from .env.local');
  process.exit(1);
}

async function hub(p) {
  const res = await fetch(`https://api.hubapi.com${p}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HubSpot ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

console.log(`Fetching properties for object type ${OBJECT_TYPE}...`);
const props = await hub(`/crm/v3/properties/${OBJECT_TYPE}`);
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(props, null, 2));
console.log(`\n→ Full schema: ${path.relative(ROOT, OUT)} (${props.results?.length || 0} properties)`);

// Also fetch the object schema itself (gives us label, primary display property, associations).
console.log('\nFetching object schema (associations, labels)...');
const schema = await hub(`/crm/v3/schemas/${OBJECT_TYPE}`);
fs.writeFileSync(path.join(CACHE_DIR, 'hubspot_instance_object_schema.json'), JSON.stringify(schema, null, 2));
console.log(`  Object label: ${schema.labels?.singular} / ${schema.labels?.plural}`);
console.log(`  Primary display property: ${schema.primaryDisplayProperty}`);
console.log(`  Associations:`);
for (const a of schema.associations || []) {
  console.log(`    → ${a.toObjectTypeId} (${a.name || ''})`);
}

// Print a filtered, human-readable view of renewal/contract/value-related properties.
const RENEWAL_PATTERNS = /renewal|contract|term|arr|mrr|amount|value|expir|end_date|start_date|launch|live|date|status|owner|customer|allmoxy|stripe|installer|pulse|health|cs_/i;
const filtered = (props.results || [])
  .filter((p) => RENEWAL_PATTERNS.test(p.name) || RENEWAL_PATTERNS.test(p.label || ''))
  .sort((a, b) => a.name.localeCompare(b.name));

console.log(`\n=== Renewal/contract/value-relevant properties (${filtered.length} of ${props.results?.length}) ===`);
for (const p of filtered) {
  const calc = p.calculated ? ' [calculated]' : '';
  const ro = p.modificationMetadata?.readOnlyValue ? ' [read-only]' : '';
  console.log(`\n  ${p.name}${calc}${ro}`);
  console.log(`    label: ${p.label}`);
  console.log(`    type: ${p.type} (${p.fieldType})`);
  if (p.description) console.log(`    description: ${p.description.slice(0, 140)}`);
  if (p.options && p.options.length > 0 && p.options.length < 10) {
    console.log(`    options: ${p.options.map((o) => o.label).join(', ')}`);
  }
}

console.log('\n=== Done. Full schema written to cache/hubspot_instance_schema.json. ===');
