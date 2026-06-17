#!/usr/bin/env node
/**
 * Auto-classify "never paid" customers and exclude them from logo / churn counts.
 *
 * A customer record exists in our Allmoxy roster for every business that ever
 * signed up for an instance — including those that NEVER paid us OR those whose
 * transactions all net to zero (refunds, chargebacks, billing reversed before
 * close). The payment-recency heuristic in build_customer_profiles flags both
 * groups as status='churned' (no recent payments), but a buyer should NOT see
 * them as churn — net economic activity to Allmoxy was zero.
 *
 * Rule: lifetime_subscription <= 0 AND no manual status_override already in
 * place → mark status='never_paid' and excluded_from_logo_count=true. The
 * transaction_count is informational only (zero_net_revenue_with_activity
 * sub-flag set when txns > 0 — useful for distinguishing the two cohorts).
 *
 * Idempotent and runs AFTER amortization + manual status overrides so it
 * doesn't clobber explicit overrides. Logs a summary count rather than
 * listing every customer.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));

let classified = 0;
let classifiedWithActivity = 0;
const examples = [];
for (const profile of profiles.rows || []) {
  // Skip if a manual status_override has already been applied (those take
  // precedence — the user/owner knows the business reality).
  if (profile.status_override) continue;
  const lifetime = profile.lifetime_subscription || 0;
  if (lifetime > 0) continue;
  // Net zero or negative lifetime → flag as never_paid + exclude from logo counts.
  // (Includes both pure never-paid and zero-net-with-activity cohorts — net economic
  // contribution is zero either way.)
  const txnCount = profile.transaction_count || 0;
  profile.status = 'never_paid';
  profile.excluded_from_logo_count = true;
  profile.never_paid = true;
  if (txnCount > 0) {
    profile.zero_net_revenue_with_activity = true;
    classifiedWithActivity++;
  }
  classified++;
  if (examples.length < 5) examples.push(`#${profile.allmoxy_customer_id} ${profile.name} (signed up ${profile.sign_up_date ?? 'unknown'}, ${txnCount} txns)`);
}

fs.writeFileSync(path.join(SNAP, 'customer_profiles.json'), JSON.stringify(profiles, null, 2));

console.log(`Classified ${classified} customer(s) as never_paid (lifetime ≤ $0, no manual override):`);
console.log(`  ${classified - classifiedWithActivity} pure never-paid (0 transactions)`);
console.log(`  ${classifiedWithActivity} zero-net-revenue-with-activity (transactions netted to $0 — refunds, reversals, etc.)`);
for (const e of examples) console.log(`  · ${e}`);
if (classified > examples.length) console.log(`  · ... and ${classified - examples.length} more`);
