#!/usr/bin/env node
/**
 * Backfill the Allmoxy Customer ID field on HubSpot Instance custom objects
 * that are missing it — the "hubspot_instance_missing_aid" Data Cleanup issues.
 *
 * For each ACTIVE, non-sandbox Instance with an empty allmoxy_customer_id, we
 * resolve the customer via installer_id (the same logic build_data_cleanup uses
 * to compute the Suggested AID) and PATCH the Instance with that aid.
 *
 * SAFE BY DEFAULT: runs a dry-run (no writes) unless --apply is passed.
 *   node _etl_scripts/update_hubspot_instance_aids.mjs            # dry-run preview
 *   node _etl_scripts/update_hubspot_instance_aids.mjs --apply    # write to HubSpot
 *   node _etl_scripts/update_hubspot_instance_aids.mjs --apply --limit 1   # write just the first (probe)
 *
 * Requires HUBSPOT_TOKEN in .env.local with crm.objects.custom.write scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '_etl_scripts/cache');
const SNAP = path.join(ROOT, 'public/snapshots');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

// HubSpot Instance custom object type (per sync_hubspot.mjs).
const INSTANCE_OBJECT_TYPE = '2-39181518';
const AID_PROP = 'allmoxy_customer_id';

function loadToken() {
  if (process.env.HUBSPOT_TOKEN) return process.env.HUBSPOT_TOKEN;
  const envPath = path.join(ROOT, '.env.local');
  const m = fs.existsSync(envPath) && fs.readFileSync(envPath, 'utf8').match(/^HUBSPOT_TOKEN=(.+)$/m);
  if (!m) throw new Error('HUBSPOT_TOKEN not found in env or .env.local');
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const TOKEN = loadToken();
const HUB = 'https://api.hubapi.com';

async function hub(p, init = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${HUB}${p}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') || 2) * 1000 * (attempt + 1)));
      continue;
    }
    return res;
  }
  throw new Error(`${p} — exhausted retries`);
}

// ---- build the work list (mirrors build_data_cleanup missing_aid logic) ----
const instances = JSON.parse(fs.readFileSync(path.join(CACHE, 'hubspot_instances.json'), 'utf8')).instances || [];
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8')).rows || [];
const profByInstaller = new Map(profiles.filter((p) => p.installer_id != null).map((p) => [String(p.installer_id), p]));
const ACTIVE = new Set(['Active', 'Active - Card Failure', 'Active - Pause Granted', 'Active - Partnership Free']);

const updates = [];
const skipped = [];
for (const i of instances) {
  if (!ACTIVE.has(i.status)) continue;
  if (/sandbox|\bdev\b|\btest\b/i.test(i.account_name || '')) continue;
  if (i.allmoxy_customer_id) continue; // already set
  const p = i.installer_id ? profByInstaller.get(String(i.installer_id)) : null;
  if (!p) { skipped.push({ id: i.id, account_name: i.account_name, reason: 'no installer_id match' }); continue; }
  updates.push({ id: i.id, account_name: i.account_name, installer_id: i.installer_id, aid: p.allmoxy_customer_id, customer: p.name });
}

const work = updates.slice(0, LIMIT);
console.log(`Instances missing Allmoxy Customer ID: ${updates.length} resolvable, ${skipped.length} need manual lookup`);
console.log(`Mode: ${APPLY ? `APPLY (writing ${work.length})` : 'DRY RUN (no writes)'}\n`);
for (const u of work.slice(0, 15)) console.log(`  ${u.id}  "${u.account_name}"  installer ${u.installer_id}  →  AID ${u.aid} (${u.customer})`);
if (work.length > 15) console.log(`  … +${work.length - 15} more`);
if (skipped.length) { console.log('\nNeeds manual lookup (no installer match):'); skipped.forEach((s) => console.log(`  ${s.id} "${s.account_name}"`)); }

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to write these to HubSpot.');
  process.exit(0);
}

// ---- apply via batch update (100 per request) ----
let ok = 0; const failures = [];
for (let b = 0; b < work.length; b += 100) {
  const batch = work.slice(b, b + 100);
  const res = await hub(`/crm/v3/objects/${INSTANCE_OBJECT_TYPE}/batch/update`, {
    method: 'POST',
    body: JSON.stringify({ inputs: batch.map((u) => ({ id: String(u.id), properties: { [AID_PROP]: String(u.aid) } })) }),
  });
  if (res.ok) {
    ok += batch.length;
    console.log(`  batch ${b / 100 + 1}: ✓ ${batch.length} updated`);
  } else {
    const body = await res.text().catch(() => '');
    console.log(`  batch ${b / 100 + 1}: ✗ ${res.status} ${body.slice(0, 300)}`);
    failures.push({ batch: b / 100 + 1, status: res.status, body: body.slice(0, 500) });
    if (res.status === 403) { console.log('\n✗ 403 — the HUBSPOT_TOKEN lacks crm.objects.custom.write. Add the write scope to the Private App and retry.'); break; }
  }
}
console.log(`\nDone. ${ok}/${work.length} instances updated.${failures.length ? ` ${failures.length} batch(es) failed.` : ''}`);
