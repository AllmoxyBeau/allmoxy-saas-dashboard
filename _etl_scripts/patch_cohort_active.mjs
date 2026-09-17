#!/usr/bin/env node
// Reconcile cohort_retention.json's "active today" flags with the canonical
// definition used by Overview/Segments: current_subscription_mrr > 0 in the
// latest complete month (read from customer_profiles.json after dedup +
// transaction overrides + annual amortization have all been applied).
//
// build_full_cohort.mjs runs early in the pipeline and uses a looser rule
// ("any 2026 charge"), which over-counts customers who paid in Jan/Feb and
// then cancelled. This patcher fixes that drift so all three pages report
// the same active-customer count.

import fs from 'node:fs';
import path from 'node:path';

const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';
const profilesPath = path.join(SNAP, 'customer_profiles.json');
const cohortPath = path.join(SNAP, 'cohort_retention.json');

const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
const cohort = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));

const norm = (s) => (s || '').toLowerCase().trim();

// CANONICAL ACTIVE SET = customer_base.json, the single logo count (Beau, 2026-09-17:
// "Active today on the Cohort Retention should match the logo counts").
//
// This used to key off current_subscription_mrr > 0, which was the canonical rule
// before customer_base existed. It is now a DIFFERENT definition — cash in one month,
// versus the invoiced basis plus annual amortisation that every other page reports —
// so the cohort page drifted to 189 against a canonical 197. Reading the base directly
// means there is nothing left to drift.
const base = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_base.json'), 'utf8')); }
  catch { return null; }
})();
const activeNames = new Set();
const activeIds = new Set();
const mergedAlias = new Map(); // merged-from id → canonical id (for legacy IDs)
const profById = new Map((profiles.rows ?? []).map((p) => [p.allmoxy_customer_id, p]));
if (base?.members?.length) {
  for (const m of base.members) {
    activeIds.add(m.allmoxy_customer_id);
    if (m.name) activeNames.add(norm(m.name));
    const p = profById.get(m.allmoxy_customer_id);
    if (p?.name) activeNames.add(norm(p.name));
    for (const merged of p?.merged_from_ids ?? []) {
      activeIds.add(merged);
      mergedAlias.set(merged, m.allmoxy_customer_id);
    }
  }
  console.error(`[patch-cohort] canonical base: ${base.members.length} customers (${base.as_of})`);
} else {
  // Fall back to the old rule only if the base has not been built yet, and say so —
  // a silent fallback is how the two counts diverged in the first place.
  console.error('[patch-cohort] customer_base.json missing — falling back to current_subscription_mrr > 0');
  for (const p of profiles.rows ?? []) {
    if ((p.current_subscription_mrr ?? 0) <= 0) continue;
    if (p.name) activeNames.add(norm(p.name));
    if (p.allmoxy_customer_id != null) activeIds.add(p.allmoxy_customer_id);
    for (const merged of p.merged_from_ids ?? []) { activeIds.add(merged); mergedAlias.set(merged, p.allmoxy_customer_id); }
  }
}

// Set of merged-from IDs (for any cohort row pointing to an old ID we removed).
const mergedFromAny = new Set();
for (const p of profiles.rows ?? []) {
  for (const m of p.merged_from_ids ?? []) mergedFromAny.add(m);
}

// A PAYING CUSTOMER MUST APPEAR IN A COHORT. Three canonical customers (Fox Creek,
// Criscott, Mekotech Canada — all 2026 signups) were in no cohort at all, because
// build_full_cohort keys cohorts off first_payment_date and two of them have none
// recorded. That is a gap in the cohort, not a reason to under-count active customers,
// so they are placed in the cohort for their signup year rather than dropped.
if (base?.members?.length) {
  const placed = new Set();
  for (const g of Object.values(cohort.cohortTriangle ?? {})) {
    for (const m of (g.members ?? [])) if (m.allmoxy_customer_id != null) placed.add(m.allmoxy_customer_id);
  }
  let added = 0;
  for (const m of base.members) {
    if (placed.has(m.allmoxy_customer_id)) continue;
    const p = profById.get(m.allmoxy_customer_id);
    const anchorDate = p?.first_payment_date || p?.effective_start_date || p?.sign_up_date;
    if (!anchorDate) continue;
    const year = String(anchorDate).slice(0, 4);
    const group = cohort.cohortTriangle?.[year];
    if (!group || !Array.isArray(group.members)) continue;   // no cohort for that year
    group.members.push({
      allmoxy_customer_id: m.allmoxy_customer_id,
      name: p?.name || m.name,
      first_payment: p?.first_payment_date ?? null,
      last_payment: p?.last_payment_date ?? null,
      streams: ['subscription'],
      lifetime_revenue: Math.round((p?.lifetime_subscription || 0) * 100) / 100,
      active_today: true,
    });
    added++;
  }
  if (added) console.error(`[patch-cohort] placed ${added} paying customer(s) that had no cohort membership`);
}

let totalActiveAfter = 0;
let totalCustomersAfter = 0;
const newCohortByYear = new Map();

for (const [year, group] of Object.entries(cohort.cohortTriangle ?? {})) {
  if (!Array.isArray(group.members)) continue;
  // Drop any member whose Allmoxy Customer ID was merged INTO another (those
  // duplicates should no longer be counted as separate logos).
  const filtered = group.members.filter((m) => !mergedFromAny.has(m.allmoxy_customer_id));
  for (const m of filtered) {
    const isActive = (m.allmoxy_customer_id != null && activeIds.has(m.allmoxy_customer_id))
      || activeNames.has(norm(m.name));
    m.active_today = !!isActive;
  }
  group.members = filtered;
  group.initialLogos = filtered.length;

  const active = filtered.filter((m) => m.active_today).length;
  const churned = filtered.length - active;
  newCohortByYear.set(Number(year), { initial: filtered.length, active, churned });
  totalActiveAfter += active;
  totalCustomersAfter += filtered.length;
}

// Patch the cohortSummary array to match the recomputed counts.
for (const row of cohort.cohortSummary ?? []) {
  const updated = newCohortByYear.get(row.year);
  if (!updated) continue;
  row.initial = updated.initial;
  row.active = updated.active;
  row.churned = updated.churned;
  row.retentionPct = updated.initial > 0
    ? Math.round((100 * updated.active) / updated.initial * 10) / 10
    : null;
}

const beforeActive = cohort.activeToday;
const beforeTotal = cohort.totalCustomers;
cohort.activeToday = totalActiveAfter;
cohort.totalCustomers = totalCustomersAfter;
cohort.fetchedAt = new Date().toISOString();
cohort.notes = (cohort.notes || '') +
  ` Active-today reconciled with customer_profiles (subscription MRR > 0 in latest complete month): ${beforeActive} → ${totalActiveAfter}.`;

fs.writeFileSync(cohortPath, JSON.stringify(cohort));
console.log(`  patched cohort_retention.json: activeToday ${beforeActive} → ${totalActiveAfter}, totalCustomers ${beforeTotal} → ${totalCustomersAfter}`);
