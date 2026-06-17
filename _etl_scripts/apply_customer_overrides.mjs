#!/usr/bin/env node
/**
 * Apply per-customer field overrides to public/snapshots/customer_profiles.json.
 *
 * Reads _etl_scripts/customer_overrides.json (managed via edit_customer.mjs)
 * and overlays the listed field values onto matching profile rows. Runs IN
 * PLACE — modifies the snapshot file. Should run after build_customer_profiles
 * + apply_annual_amortization + apply_customer_status_overrides, but BEFORE
 * any downstream build that reads customer_profiles (orders_verified, matrix,
 * time_to_value, etc.).
 *
 * Only fields listed in the override file's `allowed_fields` are accepted.
 * Numeric/aggregate fields like current_subscription_mrr and
 * lifetime_subscription are intentionally NOT overrideable — those come from
 * Stripe and altering them would silently break invariants.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILES_PATH = path.join(ROOT, 'public/snapshots/customer_profiles.json');
const OVERRIDES_PATH = path.join(ROOT, '_etl_scripts/customer_overrides.json');

if (!fs.existsSync(OVERRIDES_PATH)) {
  console.log('No customer_overrides.json found — skipping.');
  process.exit(0);
}

const profilesDoc = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
const overridesDoc = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
const rows = profilesDoc.rows || profilesDoc;
const overrides = overridesDoc.overrides || {};
const ALLOWED = new Set(overridesDoc.allowed_fields || []);

const byAid = new Map(rows.map((r) => [r.allmoxy_customer_id, r]));
let applied = 0;
let orphan = 0;
let skippedFields = 0;
const appliedSummary = [];

for (const [aidStr, fields] of Object.entries(overrides)) {
  const aid = Number(aidStr);
  if (!Number.isFinite(aid)) continue;
  const row = byAid.get(aid);
  if (!row) {
    console.warn(`  ! aid=${aidStr} has overrides but no profile row — skipping`);
    orphan++;
    continue;
  }
  const changedFields = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('_')) continue; // _note, _set_by, etc. — metadata only
    if (!ALLOWED.has(key)) {
      console.warn(`  ! aid=${aidStr} override "${key}" not in allowed_fields — skipping`);
      skippedFields++;
      continue;
    }
    const prev = row[key];
    if (prev === value) continue;
    row[key] = value;
    changedFields.push({ key, prev, next: value });
  }
  if (changedFields.length > 0) {
    applied++;
    appliedSummary.push({ aid, name: row.hubspot_instance_name || row.customer_name || row.name || '(unnamed)', changes: changedFields });
  }
}

profilesDoc.rows = rows;
fs.writeFileSync(PROFILES_PATH, JSON.stringify(profilesDoc) + '\n');

console.log(`Applied ${applied} customer override(s).`);
if (appliedSummary.length > 0) {
  for (const a of appliedSummary) {
    const changeStr = a.changes.map((c) => `${c.key}: "${c.prev}" → "${c.next}"`).join('; ');
    console.log(`  aid=${a.aid} ${a.name} — ${changeStr}`);
  }
}
if (orphan > 0) console.log(`  ${orphan} override(s) skipped — no matching profile row`);
if (skippedFields > 0) console.log(`  ${skippedFields} field(s) skipped — not in allowed_fields`);
