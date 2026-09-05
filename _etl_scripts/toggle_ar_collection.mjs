#!/usr/bin/env node
/**
 * Record a per-invoice collection decision in _etl_scripts/ar_collection_overrides.json.
 *
 * An explicit decision ALWAYS beats the automatic age rule
 * (qb_accounts.ar_writeoff_after_days), in both directions.
 *
 * Usage:
 *   node _etl_scripts/toggle_ar_collection.mjs uncollectible <invoice_id> [--note "why"]
 *   node _etl_scripts/toggle_ar_collection.mjs collectible   <invoice_id> [--note "why"]
 *   node _etl_scripts/toggle_ar_collection.mjs clear         <invoice_id>   # back to the age rule
 *   node _etl_scripts/toggle_ar_collection.mjs apply '<json>'               # bulk, from the Collections page export
 *   node _etl_scripts/toggle_ar_collection.mjs list
 *
 * The Collections page keeps decisions in localStorage until they're applied here;
 * "Copy pending decisions" there produces the JSON for `apply`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, '_etl_scripts/ar_collection_overrides.json');
const SNAP = path.join(ROOT, 'public/snapshots/revenue_recognition.json');
const VALID = new Set(['uncollectible', 'collectible']);

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
cfg.decisions = cfg.decisions || {};
const save = () => { cfg.updated_at = new Date().toISOString().slice(0, 10); fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n'); };
const arRows = (() => { try { return JSON.parse(fs.readFileSync(SNAP, 'utf8')).ar_aging || []; } catch { return []; } })();
const byId = new Map(arRows.filter((r) => r.invoice_id).map((r) => [r.invoice_id, r]));

const [action, ...rest] = process.argv.slice(2);
const noteIdx = rest.indexOf('--note');
const note = noteIdx >= 0 ? rest[noteIdx + 1] : null;
const args = noteIdx >= 0 ? rest.slice(0, noteIdx) : rest;
const today = new Date().toISOString().slice(0, 10);

if (action === 'list') {
  const ids = Object.keys(cfg.decisions);
  if (!ids.length) { console.log('No manual collection decisions — every invoice follows the age rule.'); process.exit(0); }
  console.log(`${ids.length} decision(s):`);
  for (const id of ids) {
    const d = cfg.decisions[id]; const r = byId.get(id);
    console.log(`  ${d.decision.padEnd(13)} ${id}  ${r ? `${r.name} $${Math.round(r.amount)} (${r.age_days}d)` : '(not in current AR)'}${d.note ? ` — ${d.note}` : ''}`);
  }
  process.exit(0);
}

if (action === 'apply') {
  let payload;
  try { payload = JSON.parse(args[0]); } catch { console.error('apply expects a JSON object of { invoiceId: {decision, note} }'); process.exit(1); }
  let n = 0;
  for (const [id, v] of Object.entries(payload)) {
    if (v == null) { delete cfg.decisions[id]; n++; continue; }
    const decision = typeof v === 'string' ? v : v.decision;
    if (!VALID.has(decision)) { console.error(`  ✗ ${id}: bad decision "${decision}"`); continue; }
    cfg.decisions[id] = { decision, note: (typeof v === 'object' && v.note) || null, decided_at: (typeof v === 'object' && v.decided_at) || today };
    n++;
  }
  save();
  console.log(`Applied ${n} decision(s). Re-run build_revenue_recognition.mjs to rebuild.`);
  process.exit(0);
}

if (!['uncollectible', 'collectible', 'clear'].includes(action) || !args.length) {
  console.error('Usage: toggle_ar_collection.mjs uncollectible|collectible|clear <invoice_id> [--note "why"] | apply <json> | list');
  process.exit(1);
}

let changed = 0;
for (const id of args) {
  const r = byId.get(id);
  if (action === 'clear') {
    if (!cfg.decisions[id]) { console.log(`  = ${id} had no decision`); continue; }
    delete cfg.decisions[id]; console.log(`  − ${id} cleared → follows the age rule again`); changed++; continue;
  }
  cfg.decisions[id] = { decision: action, note, decided_at: today };
  console.log(`  ✓ ${id} → ${action}${r ? `  (${r.name} $${Math.round(r.amount)}, ${r.age_days}d)` : ''}${note ? ` — ${note}` : ''}`);
  changed++;
}
if (changed) { save(); console.log(`\n${changed} change(s) written. Re-run build_revenue_recognition.mjs to rebuild.`); }
