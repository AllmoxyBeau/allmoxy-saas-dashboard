#!/usr/bin/env node
/**
 * Build at_risk_hubspot_signals.json from a manual batch pull.
 *
 * Reads /tmp/hubspot_company_batch.json (which is the raw output of two
 * batched mcp__claude_ai_HubSpot__get_crm_objects calls covering the 166
 * active-paying cohort) and emits the scoring snapshot used by the Churn
 * Risk Matrix.
 *
 * Scores:
 *   - Signal 3 (Engagement Recency, 0-20 pts) from notes_last_contacted
 *   - Signal 5 (Tenure × Launch Trajectory, -15 to 0 pts) from years_with_us
 *     (with launch_status='unknown' since we haven't done the per-customer
 *     note scan yet).
 *   - Signal 2 (Launch Status, 0-25 pts) — set to 0 with launch_status='unknown'
 *   - Signal 4 (Risk Signals, -20 to 0 pts) — set to 0 (no note scan yet)
 *
 * Re-run after the note-scan pass populates Signals 2 + 4.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const COHORT = '/tmp/at_risk_cohort.json';
const BATCH = '/tmp/hubspot_company_batch.json';
const RISK = '/tmp/hubspot_risk_signals.json'; // Optional — populated by note-scan pass
const OUT = path.join(ROOT, '_etl_scripts/cache/at_risk_hubspot_signals.json');
const PROFILES = path.join(ROOT, 'public/snapshots/customer_profiles.json');
const HS_CACHE = path.join(ROOT, '_etl_scripts/cache/hubspot_companies.json');

// Cohort: derived from customer_profiles.json — that file is the source of
// truth and has merge-redirected HubSpot IDs after build_customer_profiles.mjs.
// The legacy /tmp file froze the cohort at a point in time; we no longer use
// it (was causing stale hubspot_company_id values to outlive HubSpot merges).
const profs = JSON.parse(fs.readFileSync(PROFILES, 'utf8')).rows || [];
const cohort = profs
  .filter((p) => p.status !== 'churned' && p.status !== 'never_paid'
    && !p.excluded_from_logo_count
    && (p.lifetime_subscription || 0) > 0
    && p.pay_status !== 'Cancelled'
    && p.pay_status !== 'Active - Pause Granted')
  .map((p) => ({
    allmoxy_customer_id: p.allmoxy_customer_id,
    name: p.name,
    hubspot_company_id: p.hubspot_company_id,
    current_subscription_mrr: p.current_subscription_mrr,
    years_with_us: p.years_with_us,
    failed_3mo_count: p.failed_3mo_count || 0,
    installer_id: p.installer_id,
  }));
process.stderr.write(`Cohort: derived from customer_profiles.json (${cohort.length} customers)\n`);

// HubSpot Company properties: prefer the manual /tmp batch when present, else
// use the live API cache (cache/hubspot_companies.json). The cache has every
// company; the batch was the cohort-sized subset from a manual MCP pull.
const byHsId = new Map();
if (fs.existsSync(BATCH)) {
  const batch = JSON.parse(fs.readFileSync(BATCH, 'utf8'));
  for (const obj of batch.objects || []) {
    byHsId.set(String(obj.id), obj.properties || {});
  }
  process.stderr.write(`Company batch: /tmp file (${byHsId.size} companies)\n`);
} else {
  const cache = JSON.parse(fs.readFileSync(HS_CACHE, 'utf8'));
  for (const c of cache.companies || []) {
    byHsId.set(String(c.id), c);
  }
  process.stderr.write(`Company batch: live cache (${byHsId.size} companies)\n`);
}

const riskScan = fs.existsSync(RISK) ? JSON.parse(fs.readFileSync(RISK, 'utf8')) : null;
const riskByHsId = new Map();
if (riskScan?.by_hubspot_company_id) {
  for (const [hsId, data] of Object.entries(riskScan.by_hubspot_company_id)) {
    riskByHsId.set(String(hsId), data);
  }
}

// Dynamic now — each rebuild scores recency relative to the current date.
// Previously frozen at a fixed date for reproducibility; switched to live so
// "days since last contact" actually reflects today.
const now = Date.now();

function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / (1000 * 60 * 60 * 24)));
}

function scoreSignal3(days) {
  if (days == null) return 0;
  if (days <= 14) return 20;
  if (days <= 30) return 15;
  if (days <= 60) return 8;
  if (days <= 90) return 3;
  return 0;
}

function scoreSignal5(yearsWithUs, launchStatus) {
  if (yearsWithUs == null) return 0;
  // launch_status='unknown' → treat as not-launched-yet for tenure penalty
  const months = yearsWithUs * 12;
  if (launchStatus === 'launched' || launchStatus === 'partial') return 0;
  if (months <= 6) return 0;
  if (months <= 12) return -5;
  if (months <= 18) return -10;
  return -15;
}

let scored = 0;
let unmapped = 0;
const byCustomerId = {};

for (const c of cohort) {
  const props = byHsId.get(String(c.hubspot_company_id));
  if (!props) {
    unmapped++;
    byCustomerId[String(c.allmoxy_customer_id)] = {
      name: c.name,
      hubspot_company_id: String(c.hubspot_company_id),
      days_since_last_contact: null,
      lifecyclestage: null,
      launch_status: 'unknown',
      launch_evidence: null,
      risk_signals: [],
      scores: { signal_2_launch: 0, signal_3_recency: 0, signal_4_risk: 0, signal_5_tenure: 0, total: 0 },
      tier_override_reason: null,
      gym_member_cliff: false,
      key_signal: 'HubSpot record not found in batch — needs investigation',
    };
    continue;
  }

  const days = daysSince(props.notes_last_contacted);
  const s3 = scoreSignal3(days);
  const launchStatus = 'unknown'; // pending per-customer note scan
  const s5 = scoreSignal5(c.years_with_us, launchStatus);
  const s2 = 0;
  // Signal 4 (Risk Signals) — merged from the optional /tmp/hubspot_risk_signals.json
  // pass. Capped at -20.
  const riskInfo = riskByHsId.get(String(c.hubspot_company_id)) || null;
  const s4 = riskInfo?.signal_4_risk != null ? Math.max(-20, Number(riskInfo.signal_4_risk)) : 0;
  const riskMatches = Array.isArray(riskInfo?.risk_signals) ? riskInfo.risk_signals : [];
  const total = s2 + s3 + s4 + s5;

  // Compose key signal narrative
  let keySignal = '';
  if (days == null) keySignal = 'No HubSpot last-contact date';
  else if (days >= 90) keySignal = `${days}d since last contact — high recency risk`;
  else if (days >= 60) keySignal = `${days}d since last contact — watch`;
  else if (days >= 30) keySignal = `${days}d since last contact`;
  else if (days >= 14) keySignal = `${days}d since last contact — recent`;
  else keySignal = `Active contact (${days}d)`;

  if ((c.years_with_us || 0) >= 2 && launchStatus === 'unknown') {
    keySignal += ` · ${c.years_with_us.toFixed(1)}y tenure, launch unconfirmed`;
  }

  byCustomerId[String(c.allmoxy_customer_id)] = {
    name: c.name,
    hubspot_company_id: String(c.hubspot_company_id),
    days_since_last_contact: days,
    lifecyclestage: props.lifecyclestage || null,
    launch_status: launchStatus,
    launch_evidence: riskInfo ? `Scanned ${riskInfo.notes_scanned ?? 0} notes from last ${riskInfo.scan_window_days ?? 180}d` : 'pending note scan',
    risk_signals: riskMatches,
    scores: { signal_2_launch: s2, signal_3_recency: s3, signal_4_risk: s4, signal_5_tenure: s5, total },
    tier_override_reason: null,
    gym_member_cliff: false,
    key_signal: keySignal,
  };
  scored++;
}

const riskScanLoaded = riskScan != null && riskByHsId.size > 0;
const out = {
  fetched_at: new Date().toISOString(),
  comment: riskScanLoaded
    ? 'Full signals snapshot — Signal 3 (recency) from notes_last_contacted, Signal 4 (risk keywords) from per-customer note scan, Signal 5 (tenure). Signal 2 (launch status) is computed downstream in build_churn_risk_matrix.mjs from Live Date in orders xlsx.'
    : 'Partial signals snapshot — Signal 3 (recency) + Signal 5 (tenure) only. Signal 4 (note-keyword risk) pending per-customer note scan; re-run after /tmp/hubspot_risk_signals.json is populated.',
  as_of_date: '2026-06-16',
  cohort_size: cohort.length,
  scored_count: scored,
  unmapped_count: unmapped,
  risk_scan_loaded: riskScanLoaded,
  risk_scan_fetched_at: riskScan?.fetched_at ?? null,
  scoring_mode: riskScanLoaded ? 'full_signals' : 'recency_and_tenure_only',
  signals_pending: riskScanLoaded ? [] : ['signal_4_risk'],
  by_customer_id: byCustomerId,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`  cohort: ${cohort.length} · scored: ${scored} · unmapped: ${unmapped}`);
const recencyBuckets = { '0-14d': 0, '15-30d': 0, '31-60d': 0, '61-90d': 0, '90+d': 0, 'unknown': 0 };
for (const v of Object.values(byCustomerId)) {
  const d = v.days_since_last_contact;
  if (d == null) recencyBuckets.unknown++;
  else if (d <= 14) recencyBuckets['0-14d']++;
  else if (d <= 30) recencyBuckets['15-30d']++;
  else if (d <= 60) recencyBuckets['31-60d']++;
  else if (d <= 90) recencyBuckets['61-90d']++;
  else recencyBuckets['90+d']++;
}
console.log('  Recency distribution:', recencyBuckets);
