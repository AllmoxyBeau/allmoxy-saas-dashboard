#!/usr/bin/env node
/**
 * Push the CANONICAL customer count into every snapshot that carries one.
 *
 * customer_base.json is the single source (see build_customer_base.mjs), but a few
 * monthly aggregates carry their own `logo_qty` column inherited from the xlsx era.
 * mrr_by_month said 191 for 2026-08 while the canonical base said 197, and the CIM
 * Packet reads its headline logo count straight off that row — so a buyer-facing page
 * was showing a different customer count from the rest of the dashboard.
 *
 * Runs LATE (after apply_stripe_seam_monthly rewrites these files) so nothing
 * downstream can overwrite the canonical value.
 *
 * The CURRENT month is nulled rather than filled: it is partial by definition, and
 * mrr_by_month's own value for it was 117 mid-September against a real 197. A blank
 * is honest; a number that is wrong by construction is not.
 *
 * NOTE ON BASIS. `logo_qty` becomes the canonical (invoiced-basis) count, while
 * `mrr_subscription` on the same row stays CASH — they answer different questions and
 * both are correct. The blended average is recomputed from whatever pair the row
 * carries. Where a single reconciled pair is needed (count AND the MRR it ties to),
 * read customer_base.json, not this file.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const BASE = read(path.join(SNAP, 'customer_base.json'));
if (!BASE?.by_month?.length) {
  console.error('[canonical-logos] customer_base.json missing — skipped (no change)');
  process.exit(0);
}
const canon = new Map(BASE.by_month.map((r) => [r.month, r.customers]));
const nowMonth = new Date().toISOString().slice(0, 7);

let patched = 0, nulled = 0, files = 0;
for (const file of ['mrr_by_month.json', 'subscription_by_month.json']) {
  const p = path.join(SNAP, file);
  const snap = read(p);
  if (!snap?.rows?.length) continue;
  let touched = false;
  for (const row of snap.rows) {
    const m = row.month;
    if (!m || !Object.prototype.hasOwnProperty.call(row, 'logo_qty')) continue;
    const want = m >= nowMonth ? null : (canon.get(m) ?? row.logo_qty);
    if (row.logo_qty !== want) {
      row.logo_qty = want;
      touched = true;
      if (want == null) nulled++; else patched++;
    }
    // Keep any derived average consistent with the count actually shown.
    if (Object.prototype.hasOwnProperty.call(row, 'avg_mrr_blended')) {
      row.avg_mrr_blended = row.logo_qty ? r2((row.mrr_blended || 0) / row.logo_qty) : null;
    }
  }
  if (touched) { fs.writeFileSync(p, JSON.stringify(snap)); files++; }
}

console.error(`[canonical-logos] ${patched} month(s) set to the canonical count, ${nulled} partial month(s) nulled, across ${files} file(s)`);
