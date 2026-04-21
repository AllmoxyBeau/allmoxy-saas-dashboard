#!/usr/bin/env node
/**
 * Attribute Stripe Connect (affiliate) fee revenue to Allmoxy customers in
 * customer_profiles.json, using the explicit mapping in connect_customer_overrides.json
 * as the single source of truth.
 *
 * For every mapped Connect customer:
 *   - Read their monthly fees from connect_by_customer_month.json
 *   - Write those amounts into profile.monthly_history[m].connect
 *   - Recompute profile.monthly_history[m].total (sub + services + connect)
 *   - Recompute lifetime_connect, lifetime_total, current_connect, peak_month*
 *
 * Any profile NOT in the mapping keeps its subscription/services data but has
 * its connect data zeroed out (so stale manual edits don't linger).
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/Documents/Claude/Projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'src/data/snapshots');

const overrides = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/connect_customer_overrides.json'), 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));
const cbcm = JSON.parse(fs.readFileSync(path.join(SNAP, 'connect_by_customer_month.json'), 'utf8'));

const round2 = (n) => Math.round(n * 100) / 100;

// 1. Build id → Connect monthly schedule from the mapping.
const idToConnectMonthly = new Map(); // allmoxy_customer_id → { month → $ }
const idToConnectLifetime = new Map();
const nameToConnectRow = new Map();
for (const r of cbcm.rows) nameToConnectRow.set(r.customer_name, r);

const mapping = overrides.mapping || {};
const unmappedNames = new Set(Object.keys(overrides.unmapped || {}));
const mappedNames = new Set(Object.keys(mapping));

let attributed = 0;
let totalFees = 0;
for (const [connectName, allmoxyId] of Object.entries(mapping)) {
  const row = nameToConnectRow.get(connectName);
  if (!row) {
    console.warn(`WARN: mapping has "${connectName}" but no such row in connect_by_customer_month.json`);
    continue;
  }
  const monthly = {};
  let lifetime = 0;
  for (const [k, v] of Object.entries(row)) {
    if (/^\d{4}-\d{2}$/.test(k) && typeof v === 'number' && v > 0) {
      monthly[k] = round2(v);
      lifetime += v;
    }
  }
  idToConnectMonthly.set(allmoxyId, monthly);
  idToConnectLifetime.set(allmoxyId, round2(lifetime));
  totalFees += lifetime;
  attributed++;
}

// 2. Walk every profile. For those in mapping, overwrite connect data.
//    For those not in mapping, zero out connect data (sanitize any stale values).
let profilesTouched = 0;
for (const profile of profiles.rows) {
  const mapped = idToConnectMonthly.has(profile.allmoxy_customer_id);
  const newConnectByMonth = mapped ? idToConnectMonthly.get(profile.allmoxy_customer_id) : {};
  const newLifetimeConnect = mapped ? idToConnectLifetime.get(profile.allmoxy_customer_id) : 0;

  // Rebuild monthly_history: start from existing cells (preserve sub/services), rewrite connect.
  const allMonths = new Set([
    ...Object.keys(profile.monthly_history || {}),
    ...Object.keys(newConnectByMonth),
  ]);
  const newHistory = {};
  for (const m of allMonths) {
    const old = profile.monthly_history?.[m] || { subscription: 0, services: 0, connect: 0, total: 0 };
    const connect = newConnectByMonth[m] ?? 0;
    const subscription = old.subscription || 0;
    const services = old.services || 0;
    const total = round2(subscription + services + connect);
    if (subscription === 0 && services === 0 && connect === 0) continue;
    const cell = { subscription, services, connect, total };
    if (old.annualized) cell.annualized = true;
    newHistory[m] = cell;
  }

  // Track whether anything actually changed for this profile.
  const prevConnectMonthly = Object.fromEntries(
    Object.entries(profile.monthly_history || {}).map(([m, v]) => [m, v.connect || 0])
  );
  const changedConnect = Object.keys(newConnectByMonth).some((m) => (prevConnectMonthly[m] ?? 0) !== (newConnectByMonth[m] ?? 0))
    || Object.keys(prevConnectMonthly).some((m) => (prevConnectMonthly[m] ?? 0) > 0 && (newConnectByMonth[m] ?? 0) === 0);

  profile.monthly_history = newHistory;

  // Recompute aggregates.
  let lifetimeSub = 0, peakMonth = null, peakTotal = 0;
  for (const [m, v] of Object.entries(newHistory)) {
    lifetimeSub += v.subscription;
    if (v.total > peakTotal) {
      peakTotal = v.total;
      peakMonth = m;
    }
  }
  profile.lifetime_subscription = round2(lifetimeSub);
  profile.lifetime_connect = newLifetimeConnect;
  profile.lifetime_total = round2(
    profile.lifetime_subscription + profile.lifetime_services + profile.lifetime_connect + (profile.lifetime_other || 0)
  );
  profile.peak_month = peakMonth;
  profile.peak_month_total = round2(peakTotal);
  profile.current_connect = round2(newHistory[profile.latest_month]?.connect ?? 0);

  if (changedConnect) profilesTouched++;
}

profiles.fetchedAt = new Date().toISOString();
fs.writeFileSync(path.join(SNAP, 'customer_profiles.json'), JSON.stringify(profiles));

// 3. Also stamp allmoxy_customer_id onto connect_by_customer_month rows so drill-downs can join.
for (const row of cbcm.rows) {
  const id = mapping[row.customer_name];
  if (id != null) {
    row.allmoxy_customer_id = id;
  } else if (unmappedNames.has(row.customer_name)) {
    row.allmoxy_customer_id = null;
    row.unmapped_reason = overrides.unmapped[row.customer_name]?.note ?? 'unmapped';
  } else {
    row.allmoxy_customer_id = null;
    row.unmapped_reason = 'not in connect_customer_overrides.json';
  }
}
cbcm.fetchedAt = new Date().toISOString();
fs.writeFileSync(path.join(SNAP, 'connect_by_customer_month.json'), JSON.stringify(cbcm));

console.log(`Attributed ${attributed} Connect customers, $${Math.round(totalFees).toLocaleString()} lifetime fees.`);
console.log(`Profiles touched (connect values changed): ${profilesTouched}`);
console.log(`Unmapped Connect customers: ${Object.keys(overrides.unmapped || {}).length}`);

// Regenerate the lean roster for UI pages.
await import('./build_roster.mjs');
