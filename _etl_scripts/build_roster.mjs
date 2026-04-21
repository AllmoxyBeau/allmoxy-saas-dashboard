#!/usr/bin/env node
/**
 * Derive customer_profiles_roster.json from customer_profiles.json by stripping
 * the heavyweight `transactions` and `monthly_history` arrays. The roster is
 * used by Custom Report and any future roster-style pages; the full profile
 * stays reserved for Customer Detail, which is the only page that needs the
 * per-customer transaction + monthly-timeline data.
 *
 * Run this whenever customer_profiles.json is rewritten (amortization script,
 * connect attribution, etc. should call it at the end).
 */

import fs from 'node:fs';
import path from 'node:path';

const SNAP = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/snapshots';

const full = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));

const leanRows = full.rows.map((r) => {
  // Keep every field except transactions + monthly_history.
  const { transactions, monthly_history, ...rest } = r;
  return rest;
});

const roster = {
  tab: 'customer_profiles_roster',
  fetchedAt: new Date().toISOString(),
  cachedUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  columns: full.columns ?? [],
  rows: leanRows,
  rowCount: leanRows.length,
  notes: 'Roster view of customer_profiles.json — identity + lifetime + current-month aggregates only. For transaction-level detail, use customer_profiles.json (bigger, used by Customer Detail).',
};

fs.writeFileSync(path.join(SNAP, 'customer_profiles_roster.json'), JSON.stringify(roster));

const fullSize = fs.statSync(path.join(SNAP, 'customer_profiles.json')).size;
const rosterSize = fs.statSync(path.join(SNAP, 'customer_profiles_roster.json')).size;
console.log(`Full: ${(fullSize / 1024 / 1024).toFixed(2)} MB → Roster: ${(rosterSize / 1024).toFixed(0)} KB (${Math.round((rosterSize / fullSize) * 100)}% of full)`);
