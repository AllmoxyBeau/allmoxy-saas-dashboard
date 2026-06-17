#!/usr/bin/env node
/**
 * Apply customer-status overrides defined in customer_status_overrides.json.
 *
 * Some Allmoxy customers' status from the payment-recency heuristic is wrong
 * because of a business arrangement invisible to their own Stripe activity:
 *
 *   - sub_instance_of_parent: a secondary instance billed under a parent's
 *     subscription. No standalone MRR; instance is active because the parent
 *     pays. Counting them as churned mis-states retention; counting their MRR
 *     as their old standalone amount would double-count the parent.
 *
 *   - comp: a comp / free arrangement. Instance is live with $0 MRR by
 *     sales/owner decision.
 *
 *   - duplicate_of: same business as another Allmoxy record — usually a
 *     pre-rebrand or renamed account that never carried the actual payment
 *     stream. The canonical record holds the dollars; this one should
 *     resolve to active/$0 so it doesn't show up as a false churn.
 *
 * This script runs AFTER apply_annual_amortization so it has the final say on
 * status. It also stamps a parent_allmoxy_customer_id reference when the
 * override declares one, which downstream consumers (dashboard, banker package)
 * can use to render the sub-instance relationship.
 *
 * Idempotent — re-runs safely.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const overridesFile = readJson(path.join(ROOT, '_etl_scripts/customer_status_overrides.json'));
if (!overridesFile?.overrides?.length) {
  console.log('No customer status overrides defined — skipping.');
  process.exit(0);
}

const profilesPath = path.join(SNAP, 'customer_profiles.json');
const profiles = readJson(profilesPath);

let applied = 0;
let missing = 0;

const profileById = new Map(profiles.rows.map((r) => [r.allmoxy_customer_id, r]));

for (const o of overridesFile.overrides) {
  const profile = profileById.get(o.allmoxy_customer_id);
  if (!profile) {
    console.warn(`  override miss: no profile found for #${o.allmoxy_customer_id} (${o.customer_name})`);
    missing++;
    continue;
  }
  const beforeStatus = profile.status;

  // For duplicate_of, the override MIRRORS the parent's current status — both
  // records represent the same business, so they should always agree.
  // force_status in the JSON is treated as a hint/default; the parent's status
  // wins if it exists.
  let forcedStatus = o.force_status;
  if (o.arrangement_type === 'duplicate_of' && o.parent_allmoxy_customer_id) {
    const parent = profileById.get(o.parent_allmoxy_customer_id);
    if (parent?.status) forcedStatus = parent.status;
  }

  profile.status = forcedStatus;
  profile.status_override = {
    arrangement_type: o.arrangement_type,
    parent_allmoxy_customer_id: o.parent_allmoxy_customer_id ?? null,
    parent_customer_name: o.parent_customer_name ?? null,
    reason: o.reason,
    added_by: o.added_by ?? null,
  };
  // Arrangement types that don't carry standalone dollars get MRR zeroed.
  const noDollarArrangements = new Set([
    'sub_instance_of_parent',
    'comp',
    'duplicate_of',
    'test_artifact',
    'affiliate_not_customer',
    'false_positive_needs_review',
  ]);
  if (noDollarArrangements.has(o.arrangement_type)) {
    profile.current_subscription_mrr = o.standalone_mrr ?? 0;
  }
  // Arrangement types that should NOT count as their own logo. Comp arrangements
  // DO count (they're a real live instance); everything else (sub-instance,
  // duplicate, test artifact, affiliate, false positive needing review) is
  // excluded so it doesn't double-count or pollute headline customer counts.
  const excludedArrangements = new Set([
    'sub_instance_of_parent',
    'duplicate_of',
    'test_artifact',
    'affiliate_not_customer',
    'false_positive_needs_review',
  ]);
  if (excludedArrangements.has(o.arrangement_type)) {
    profile.excluded_from_logo_count = true;
  }
  console.log(`  applied: #${o.allmoxy_customer_id} (${o.customer_name}) · status ${beforeStatus} → ${forcedStatus} · ${o.arrangement_type}${profile.excluded_from_logo_count ? ' · excluded from logo count' : ''}`);
  applied++;
}

fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
console.log(`\nApplied ${applied} customer status override(s)${missing ? ` (${missing} missing)` : ''}.`);
