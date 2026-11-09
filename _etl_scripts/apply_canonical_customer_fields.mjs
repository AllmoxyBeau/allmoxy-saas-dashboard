#!/usr/bin/env node
/**
 * Write the canonical customer base (build_customer_base.mjs) back onto each profile,
 * so Customer Detail, the roster and Custom Report say the same thing as the Overview.
 *
 *   active_today              → member of customer_base (was "any payment this calendar
 *                               year", which flagged 28 churned/non-paying customers
 *                               active and missed 4 counted ones)
 *   current_subscription_mrr  → the member's canonical (invoiced, annual-amortized) MRR
 *                               for customer_base.as_of (was last month's CASH, which put
 *                               7 customers $4.3K off the base — e.g. Vlux $0 vs $1,500)
 *
 * The previous values are kept as paid_this_year / current_subscription_cash. Profiles
 * excluded from the base as duplicates keep their cash figure. Runs right after
 * build_customer_base and before build_roster.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SNAP = path.resolve(__dirname, '..', 'public/snapshots');
const PROFILES = path.join(SNAP, 'customer_profiles.json');
const base = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_base.json'), 'utf8'));
const snap = JSON.parse(fs.readFileSync(PROFILES, 'utf8'));
const members = new Map(base.members.map((m) => [m.allmoxy_customer_id, m]));

let changedActive = 0, changedMrr = 0;
for (const p of snap.rows) {
  const m = members.get(p.allmoxy_customer_id);
  if (!('paid_this_year' in p)) p.paid_this_year = !!p.active_today;
  if (!('current_subscription_cash' in p)) p.current_subscription_cash = p.current_subscription_mrr ?? 0;
  const active = !!m;
  if (p.active_today !== active) changedActive++;
  p.active_today = active;
  if (p.excluded_from_logo_count) continue;
  const mrr = m ? m.mrr : 0;
  if (Math.abs((p.current_subscription_mrr ?? 0) - mrr) > 0.005) changedMrr++;
  p.current_subscription_mrr = mrr;
  p.current_subscription_basis = `invoiced (canonical base, ${base.as_of})`;
}
fs.writeFileSync(PROFILES, JSON.stringify(snap));
console.error(`[canonical-fields] ${base.customers} base members · active_today changed on ${changedActive} profile(s) · current MRR aligned on ${changedMrr}`);
