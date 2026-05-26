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

// Canonical active set: customer name → has subscription MRR > 0 right now.
// We also key by allmoxy_customer_id for any cohort member that carries one,
// since names occasionally drift (case, suffix, etc.) between the two snapshots.
const activeNames = new Set();
const activeIds = new Set();
const mergedAlias = new Map(); // merged-from id → canonical id (for legacy IDs)
for (const p of profiles.rows ?? []) {
  if ((p.current_subscription_mrr ?? 0) <= 0) continue;
  if (p.name) activeNames.add(norm(p.name));
  if (p.allmoxy_customer_id != null) activeIds.add(p.allmoxy_customer_id);
  for (const merged of p.merged_from_ids ?? []) {
    activeIds.add(merged);
    mergedAlias.set(merged, p.allmoxy_customer_id);
  }
}

// Set of merged-from IDs (for any cohort row pointing to an old ID we removed).
const mergedFromAny = new Set();
for (const p of profiles.rows ?? []) {
  for (const m of p.merged_from_ids ?? []) mergedFromAny.add(m);
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
