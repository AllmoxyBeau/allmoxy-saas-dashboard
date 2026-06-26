#!/usr/bin/env node
/**
 * Merge duplicate allmoxy_customer_id rows that are really one customer.
 *
 * Driven by customer_merge_overrides.json ({ merges: { "<fromAid>": { into } } }).
 * For each merge, the absorbed ("from") row's financials are folded into the
 * surviving ("into") row and the absorbed row is removed. Runs in-place on a
 * snapshot whose top-level `rows` array is keyed by allmoxy_customer_id.
 *
 * Usage: node apply_customer_merges.mjs <snapshotName>
 *   e.g. node apply_customer_merges.mjs customer_profiles
 *        node apply_customer_merges.mjs allmoxy_core_customer
 *
 * Idempotent and shape-tolerant: a snapshot missing the absorbed AID (e.g. one
 * that already excludes never-paid customers) is left unchanged; financial fold
 * steps only touch fields that exist, so a lean identity roster just drops the
 * row while a rich profile row gets the full fold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOTS = path.join(ROOT, 'public/snapshots');

const target = process.argv[2];
if (!target) {
  console.error('usage: apply_customer_merges.mjs <snapshotName>');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'customer_merge_overrides.json'), 'utf8'));
const mergeEntries = Object.entries(cfg.merges || {});
if (!mergeEntries.length) {
  console.error(`[merge] no merges configured — ${target} unchanged`);
  process.exit(0);
}

const file = path.join(SNAPSHOTS, `${target}.json`);
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(snap.rows)) {
  console.error(`[merge] ${target}.json has no rows[] — skipping`);
  process.exit(0);
}
const byId = new Map(snap.rows.map((r) => [String(r.allmoxy_customer_id), r]));

const SUM_FIELDS = [
  'lifetime_total', 'lifetime_subscription', 'lifetime_services', 'lifetime_connect', 'lifetime_other',
  'current_subscription_mrr', 'current_services', 'current_connect',
  'failed_3mo_count', 'failed_3mo_amount', 'transaction_count',
];
const ARRAY_UNION = ['stripe_customer_ids', 'all_stripe_subscription_ids', 'all_custom_domain_stripe_subscription_ids'];
const uniq = (a) => [...new Set(a)];
const minDate = (a, b) => [a, b].filter(Boolean).sort()[0] ?? null;
const maxDate = (a, b) => { const s = [a, b].filter(Boolean).sort(); return s.length ? s[s.length - 1] : null; };

const dropIds = new Set();
let applied = 0;

for (const [fromAid, spec] of mergeEntries) {
  const into = String(spec.into);
  const fromRow = byId.get(String(fromAid));
  const intoRow = byId.get(into);
  if (!fromRow) continue; // not present in this snapshot (already filtered, e.g. never-paid)
  if (!intoRow) {
    console.error(`[merge] ${target}: survivor #${into} not found for #${fromAid} — dropping #${fromAid} anyway`);
    dropIds.add(String(fromAid));
    applied++;
    continue;
  }

  // Sum numeric financial fields.
  for (const f of SUM_FIELDS) {
    if (typeof fromRow[f] === 'number' && typeof intoRow[f] === 'number') intoRow[f] += fromRow[f];
    else if (typeof fromRow[f] === 'number' && intoRow[f] == null) intoRow[f] = fromRow[f];
  }
  // Union id arrays.
  for (const f of ARRAY_UNION) {
    if (Array.isArray(fromRow[f]) || Array.isArray(intoRow[f])) intoRow[f] = uniq([...(intoRow[f] || []), ...(fromRow[f] || [])]);
  }
  // Concat + re-sort transactions; keep count in sync.
  if (Array.isArray(fromRow.transactions) || Array.isArray(intoRow.transactions)) {
    intoRow.transactions = [...(intoRow.transactions || []), ...(fromRow.transactions || [])]
      .sort((a, b) => String(a.created).localeCompare(String(b.created)));
    intoRow.transaction_count = intoRow.transactions.length;
  }
  // Merge monthly_history by month (sum numeric leaves).
  if (fromRow.monthly_history && typeof fromRow.monthly_history === 'object') {
    intoRow.monthly_history = intoRow.monthly_history || {};
    for (const [m, v] of Object.entries(fromRow.monthly_history)) {
      const cur = intoRow.monthly_history[m];
      if (cur && typeof cur === 'object' && v && typeof v === 'object') {
        for (const [kk, vv] of Object.entries(v)) cur[kk] = (typeof cur[kk] === 'number' ? cur[kk] : 0) + (typeof vv === 'number' ? vv : 0);
      } else if (typeof v === 'number') {
        intoRow.monthly_history[m] = (typeof cur === 'number' ? cur : 0) + v;
      } else if (cur == null) {
        intoRow.monthly_history[m] = v;
      }
    }
  }
  // Recompute peak month from merged history.
  if (intoRow.monthly_history && typeof intoRow.monthly_history === 'object' && 'peak_month' in intoRow) {
    let pk = null, pv = -Infinity;
    for (const [m, v] of Object.entries(intoRow.monthly_history)) {
      const t = v && typeof v === 'object' ? (v.total || 0) : (typeof v === 'number' ? v : 0);
      if (t > pv) { pv = t; pk = m; }
    }
    if (pk != null) { intoRow.peak_month = pk; intoRow.peak_month_total = pv; }
  }
  // Dates: earliest signup/first payment, latest last payment.
  if ('sign_up_date' in intoRow || 'sign_up_date' in fromRow) intoRow.sign_up_date = minDate(intoRow.sign_up_date, fromRow.sign_up_date);
  if ('first_payment_date' in intoRow || 'first_payment_date' in fromRow) intoRow.first_payment_date = minDate(intoRow.first_payment_date, fromRow.first_payment_date);
  if ('last_payment_date' in intoRow || 'last_payment_date' in fromRow) intoRow.last_payment_date = maxDate(intoRow.last_payment_date, fromRow.last_payment_date);

  // Backfill any identity field the survivor is missing (never overwrites).
  for (const [k, v] of Object.entries(fromRow)) {
    if (intoRow[k] == null && v != null) intoRow[k] = v;
  }

  dropIds.add(String(fromAid));
  applied++;
  console.error(`[merge] ${target}: folded #${fromAid} → #${into}`);
}

if (applied && dropIds.size) {
  snap.rows = snap.rows.filter((r) => !dropIds.has(String(r.allmoxy_customer_id)));
  if (typeof snap.rowCount === 'number') snap.rowCount = snap.rows.length;
  fs.writeFileSync(file, JSON.stringify(snap, null, 2));
  console.error(`[merge] ${target}: ${applied} merge(s) applied, ${dropIds.size} row(s) dropped → ${snap.rows.length} rows`);
} else {
  console.error(`[merge] ${target}: no applicable merges (absorbed AIDs not present)`);
}
