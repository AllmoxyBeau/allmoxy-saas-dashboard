#!/usr/bin/env node
/**
 * Extend churn_inferences.json to include EVERY unattributed churned customer,
 * not just the ones the original Claude MCP analysis session covered.
 *
 * Reads customer_profiles to find all churned customers without a recorded
 * churn_reason. For any not already in churn_inferences, appends a placeholder
 * entry with status='no_csm_notes_available' so the Churn Investigator page
 * surfaces them for manual review.
 *
 * Idempotent — re-runs safely. Run once after each refresh that adds new
 * churned customers, or pull a fresh churn_corpus pass via the MCP and merge.
 *
 * Output: rewrites public/snapshots/churn_inferences.json in place, preserving
 * existing entries.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

const HUBSPOT_PORTAL_ID = '4910812';
const HUBSPOT_COMPANY_URL = (id) => `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-2/${id}`;

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));
const inferences = readJson(path.join(SNAP, 'churn_inferences.json'));

// Annual payers are intentionally excluded from the unattributed-churn inference
// set even when their status flag reads 'churned' — that status is a false
// positive of the payment-activity heuristic (an annual payer whose last lump
// is outside the amortization window looks like churn but isn't). They're
// tracked in annual_payers.json and surfaced separately on the Adjustments
// Register.
const annualPayers = readJson(path.join(ROOT, 'src/data/annual_payers.json'));
const ANNUAL_PAYER_IDS = new Set(annualPayers?.annual_payer_ids ?? []);

const existingIds = new Set((inferences.customers || []).map((c) => c.allmoxy_customer_id));
const unattributedRaw = (profiles.rows || []).filter(
  (r) => r.status === 'churned' && !(r.churn_reason && r.churn_reason.trim())
);
// Filter out annual payers (false-positive churns) AND records excluded from the
// logo count (duplicate_of / sub_instance_of_parent — already represented by the
// canonical record).
const unattributedAfterAnnual = unattributedRaw.filter((r) => !ANNUAL_PAYER_IDS.has(r.allmoxy_customer_id));
const skippedAnnualPayers = unattributedRaw.length - unattributedAfterAnnual.length;
const unattributed = unattributedAfterAnnual.filter((r) => !r.excluded_from_logo_count);
const skippedDuplicates = unattributedAfterAnnual.length - unattributed.length;

// Also remove any annual payer that was previously placeholder-added by an
// earlier (buggy) run of this script. Annual payers never belong in inferences.
const beforeAnnualPurge = inferences.customers?.length ?? 0;
inferences.customers = (inferences.customers || []).filter((c) => !ANNUAL_PAYER_IDS.has(c.allmoxy_customer_id));
const purgedAnnualPayers = beforeAnnualPurge - inferences.customers.length;

// Purge any customer whose current status is not 'churned' — covers status
// overrides (sub-instance-of-parent, comp arrangements), late-arriving payments,
// reactivations, etc. The Churn Investigator should only ever show customers
// who are actually churned per the latest customer_profiles.
const profileByCustomerId = new Map((profiles.rows || []).map((r) => [r.allmoxy_customer_id, r]));
const beforeStatusPurge = inferences.customers.length;
inferences.customers = inferences.customers.filter((c) => profileByCustomerId.get(c.allmoxy_customer_id)?.status === 'churned');
const purgedNonChurned = beforeStatusPurge - inferences.customers.length;

// Purge any customer flagged excluded_from_logo_count (duplicate_of / sub_instance).
// They're already represented by the canonical/parent record — counting them
// separately would inflate the churn signal.
const beforeDupePurge = inferences.customers.length;
inferences.customers = inferences.customers.filter((c) => !profileByCustomerId.get(c.allmoxy_customer_id)?.excluded_from_logo_count);
const purgedDuplicates = beforeDupePurge - inferences.customers.length;

// Purge any customer who now has a churn_reason recorded in customer_profiles.
// They have authoritative HubSpot-recorded attribution — they no longer belong
// in the inferences set, which is for UN-attributed churns awaiting review.
const beforeReasonPurge = inferences.customers.length;
inferences.customers = inferences.customers.filter((c) => {
  const p = profileByCustomerId.get(c.allmoxy_customer_id);
  return !(p?.churn_reason && p.churn_reason.trim());
});
const purgedNowAttributed = beforeReasonPurge - inferences.customers.length;

let added = 0;
let skipped = 0;
const placeholders = [];

for (const p of unattributed) {
  if (existingIds.has(p.allmoxy_customer_id)) { skipped++; continue; }
  placeholders.push({
    allmoxy_customer_id: p.allmoxy_customer_id,
    name: p.name,
    hubspot_company_id: p.hubspot_company_id ? String(p.hubspot_company_id) : null,
    lifetime_subscription: p.lifetime_subscription ?? 0,
    years_with_us: p.years_with_us ?? null,
    current_status: 'no_csm_notes_available',
    suggested_reason: '(needs manual review)',
    confidence: 'low',
    evidence_quote: 'No CSM notes found in HubSpot or Churn Details.xlsx during the May 2026 inference pass — appended here so this churned customer is not invisible to QoE review.',
    evidence_date: null,
    signals: [],
    hubspot_url: p.hubspot_company_id ? HUBSPOT_COMPANY_URL(p.hubspot_company_id) : null,
    recommended_action:
      'Manually review: (a) HubSpot company notes/calls/emails, (b) Stripe payment history for cancellation pattern, (c) any CSM verbal handoff. Update HubSpot Churn Reason once classified.',
  });
  added++;
}

inferences.customers = [...(inferences.customers || []), ...placeholders];
inferences.customer_count = inferences.customers.length;
inferences.fetchedAt = new Date().toISOString();

// Update the notes to record the extension
const extensionNote = ` | Extended ${new Date().toISOString().slice(0, 10)}: appended ${added} placeholder entries (current_status='no_csm_notes_available') so every churned customer without a recorded reason is visible to QoE review.`;
inferences.notes = (inferences.notes || '') + extensionNote;
inferences.generatedBy = (inferences.generatedBy || '') + extensionNote;

fs.writeFileSync(path.join(SNAP, 'churn_inferences.json'), JSON.stringify(inferences, null, 2));

console.log(`Extended churn_inferences.json:`);
console.log(`  ${unattributedRaw.length} customers with status='churned' + no reason`);
console.log(`  ${skippedAnnualPayers} skipped (annual payers in annual_payers.json — false positives, not real churn)`);
console.log(`  ${skippedDuplicates} skipped (excluded_from_logo_count — duplicate_of / sub_instance_of_parent records)`);
if (purgedAnnualPayers > 0) console.log(`  ${purgedAnnualPayers} purged from prior runs (annual payers previously added in error)`);
if (purgedNonChurned > 0) console.log(`  ${purgedNonChurned} purged (no longer status='churned' — covers status overrides, reactivations)`);
if (purgedNowAttributed > 0) console.log(`  ${purgedNowAttributed} purged (now have a churn_reason in customer_profiles — authoritative attribution)`);
if (purgedDuplicates > 0) console.log(`  ${purgedDuplicates} purged (excluded_from_logo_count — duplicate/sub-instance dedupe)`);
console.log(`  ${unattributed.length} remaining unattributed (real churns)`);
console.log(`  ${skipped} already in inferences (skipped)`);
console.log(`  ${added} placeholders appended (current_status='no_csm_notes_available')`);
console.log(`  ${inferences.customer_count} customers in extended inferences file`);
