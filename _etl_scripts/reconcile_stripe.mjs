#!/usr/bin/env node
/**
 * Parity check: does the API-direct Stripe pull (sync_stripe.mjs) reproduce the
 * xlsx-derived numbers already in customer_profiles? Run this BEFORE switching the
 * core ETL's source. Maps each customer's Stripe customer IDs → API totals and
 * compares lifetime subscription + services against the snapshot.
 *
 * Read-only; writes nothing. Usage: node reconcile_stripe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const api = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/cache/stripe_charges.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/snapshots/customer_profiles.json'), 'utf8')).rows;

const apiByCus = api.by_customer || {};
const f = (v) => '$' + Math.round(v).toLocaleString();
const r2 = (v) => Math.round(v * 100) / 100;

// Map each profile (AID) → summed API totals across its Stripe customer IDs.
const usedCus = new Set();
const rows = profiles.map((p) => {
  let apiSub = 0, apiSvc = 0;
  for (const cus of new Set(p.stripe_customer_ids || [])) { // dedupe — some profiles list a cus_ twice
    const e = apiByCus[cus];
    if (e) { apiSub += e.subscription || 0; apiSvc += e.services || 0; usedCus.add(cus); }
  }
  const profSub = p.lifetime_subscription || 0;
  const profSvc = p.lifetime_services || 0;
  return {
    aid: p.allmoxy_customer_id, name: p.name,
    apiSubSvc: r2(apiSub + apiSvc), profSubSvc: r2(profSub + profSvc),
    diff: r2(apiSub + apiSvc - profSub - profSvc),
  };
});

const TOL = 1; // dollars
const apiTotal = r2(rows.reduce((s, r) => s + r.apiSubSvc, 0));
const profTotal = r2(rows.reduce((s, r) => s + r.profSubSvc, 0));
const matched = rows.filter((r) => Math.abs(r.diff) <= TOL).length;
const off = rows.filter((r) => Math.abs(r.diff) > TOL).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

// Stripe customers the API has but no profile claims (unattributed revenue).
const unmatched = Object.entries(apiByCus)
  .filter(([cus]) => !usedCus.has(cus))
  .map(([cus, v]) => ({ cus, total: r2((v.subscription || 0) + (v.services || 0)) }))
  .filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
const unmatchedTotal = r2(unmatched.reduce((s, x) => s + x.total, 0));

console.log('=== Stripe API vs snapshot — lifetime subscription + services ===');
console.log(`API total:      ${f(apiTotal)}`);
console.log(`Snapshot total: ${f(profTotal)}`);
console.log(`Delta:          ${f(apiTotal - profTotal)} (${profTotal ? ((apiTotal / profTotal - 1) * 100).toFixed(2) : '—'}%)`);
console.log(`\nPer-customer parity (±$${TOL}): ${matched}/${rows.length} match · ${off.length} differ`);
console.log('\nTop 12 per-customer discrepancies (API − snapshot):');
for (const r of off.slice(0, 12)) console.log(`  ${r.name.slice(0, 30).padEnd(30)} API ${f(r.apiSubSvc).padStart(12)}  snap ${f(r.profSubSvc).padStart(12)}  Δ ${f(r.diff)}`);
console.log(`\nUnattributed API customers (cus_ with revenue, no profile): ${unmatched.length} · ${f(unmatchedTotal)}`);
for (const x of unmatched.slice(0, 8)) console.log(`  ${x.cus}  ${f(x.total)}`);
