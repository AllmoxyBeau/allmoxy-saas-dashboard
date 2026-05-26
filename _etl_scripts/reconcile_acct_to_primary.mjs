#!/usr/bin/env node
/**
 * Reconcile stripe_connect_account_ids_by_id → primary fee-earning allmoxy_ids.
 *
 * Issue: some customer names in the Allmoxy roster exist as near-duplicates
 * (e.g. "Panhandle Door Inc." id=38 with $429K lifetime vs "Panhandle Door"
 * id=2022 with $0 lifetime). Our acct_ matcher sometimes routes the acct_ to
 * the dupe. The `mapping` section of connect_customer_overrides.json already
 * knows which id is the canonical fee-earner — use that as ground truth.
 *
 * Strategy: for each (allmoxy_id → acct_id) currently in the overrides, look
 * at the matching profile's name. If there's another profile in the roster
 * with an equivalent normalized name AND that other profile is listed as a
 * value in `mapping` (i.e., it's the canonical fee-earner), move the acct_id.
 */

import fs from 'node:fs';
import path from 'node:path';

const overridesPath = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/connect_customer_overrides.json';
const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));

function normName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|incorporated|llc|l\.l\.c|ltd|limited|co|corp|corporation|company|llp|lp|plc)\b\.?/gi, ' ')
    .replace(/\bdba.*$/i, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

const byId = new Map(profiles.rows.map((p) => [p.allmoxy_customer_id, p]));

// Group profiles by normalized name.
const normGroup = new Map();
for (const p of profiles.rows) {
  const n = normName(p.name);
  if (!n) continue;
  if (!normGroup.has(n)) normGroup.set(n, []);
  normGroup.get(n).push(p);
}

// Canonical fee-earner set (values of overrides.mapping).
const canonicalFeeEarners = new Set(Object.values(overrides.mapping || {}));

const acctMap = overrides.stripe_connect_account_ids_by_id;
const moved = [];
const removed = [];
for (const [idStr, acct] of Object.entries(acctMap)) {
  if (idStr.startsWith('_')) continue;
  const id = Number(idStr);
  const profile = byId.get(id);
  if (!profile) continue;
  const n = normName(profile.name);
  const siblings = normGroup.get(n) || [];
  if (siblings.length <= 1) continue;
  // Is there a canonical fee-earner among siblings with NO acct_ yet?
  const canon = siblings.find((s) => canonicalFeeEarners.has(s.allmoxy_customer_id) && !acctMap[String(s.allmoxy_customer_id)]);
  if (!canon) continue;
  if (canonicalFeeEarners.has(id) && profile.allmoxy_customer_id === canon.allmoxy_customer_id) continue;
  // Move: write acct_ to canon's id, delete from current id.
  acctMap[String(canon.allmoxy_customer_id)] = acct;
  delete acctMap[idStr];
  moved.push({ from: { id, name: profile.name }, to: { id: canon.allmoxy_customer_id, name: canon.name }, acct });
  removed.push(idStr);
}

overrides.updated_at = new Date().toISOString().slice(0, 10);
fs.writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + '\n');

console.log(`Moved ${moved.length} acct_ IDs from dupe profiles to canonical fee-earners.`);
for (const m of moved) {
  console.log(`  ${m.acct}  #${m.from.id} "${m.from.name}" → #${m.to.id} "${m.to.name}"`);
}
