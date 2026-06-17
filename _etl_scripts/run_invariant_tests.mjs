#!/usr/bin/env node
/**
 * QoE-6: Automated invariant tests on every refresh.
 *
 * Runs a battery of self-consistency checks across all snapshots after
 * refresh_all has finished. Each test verifies one specific invariant the
 * data must hold for the dashboard / banker package to be honest. Outputs:
 *
 *   public/snapshots/invariant_test_results.json
 *
 * Severities:
 *   - error: a hard QoE-blocking inconsistency. Must be resolved before any
 *     banker handoff. The script exits non-zero so refresh_all surfaces it.
 *   - warn:  a soft inconsistency worth investigating but not blocking.
 *     Logged loudly but does not fail the run.
 *   - info:  context / non-actionable. Counted in the summary only.
 *
 * The exit code is non-zero if any error-severity test fails so CI / hooks
 * can detect it. Warnings do not fail the build.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));
const inferences = readJson(path.join(SNAP, 'churn_inferences.json'));
const adjustments = readJson(path.join(SNAP, 'adjustments_register.json'));
const ebitda = readJson(path.join(SNAP, 'ebitda_bridge.json'));
const mrrByMonth = readJson(path.join(SNAP, 'mrr_by_month.json'));
const reconciliation = readJson(path.join(SNAP, 'stripe_qb_reconciliation.json'));
const amortEvidence = readJson(path.join(SNAP, 'annual_amortization_evidence.json'));
const annualPayers = readJson(path.join(ROOT, 'src/data/annual_payers.json'));
const statusOverrides = readJson(path.join(ROOT, '_etl_scripts/customer_status_overrides.json'));
const amortOverridesFile = readJson(path.join(ROOT, '_etl_scripts/annual_amortization_overrides.json'));
const syntheticTxns = readJson(path.join(ROOT, '_etl_scripts/synthetic_transactions.json'));

const profileById = new Map((profiles?.rows || []).map((r) => [r.allmoxy_customer_id, r]));

const tests = [];
function test(name, severity, fn) {
  tests.push({ name, severity, fn });
}

function approxEq(a, b, tol = 1) {
  return Math.abs((a || 0) - (b || 0)) <= tol;
}
function round2(n) { return Math.round((n || 0) * 100) / 100; }

// ============================================================================
// CHURN ATTRIBUTION INVARIANTS
// ============================================================================

test('every churn_inferences entry is currently status=churned', 'error', () => {
  const offending = (inferences?.customers || []).filter((c) => profileById.get(c.allmoxy_customer_id)?.status !== 'churned');
  return {
    passed: offending.length === 0,
    detail: offending.length === 0 ? 'OK' : `${offending.length} entries no longer churned`,
    examples: offending.slice(0, 5).map((c) => `#${c.allmoxy_customer_id} ${c.name} (now ${profileById.get(c.allmoxy_customer_id)?.status})`),
  };
});

test('no churn_inferences entry has a churn_reason in customer_profiles', 'error', () => {
  const offending = (inferences?.customers || []).filter((c) => {
    const p = profileById.get(c.allmoxy_customer_id);
    return p?.churn_reason && p.churn_reason.trim();
  });
  return {
    passed: offending.length === 0,
    detail: offending.length === 0 ? 'OK' : `${offending.length} entries have a HubSpot reason — should be purged from inferences`,
    examples: offending.slice(0, 5).map((c) => `#${c.allmoxy_customer_id} ${c.name} (${profileById.get(c.allmoxy_customer_id)?.churn_reason})`),
  };
});

test('no annual_payer appears in churn_inferences', 'error', () => {
  const annualIds = new Set(annualPayers?.annual_payer_ids || []);
  const offending = (inferences?.customers || []).filter((c) => annualIds.has(c.allmoxy_customer_id));
  return {
    passed: offending.length === 0,
    detail: offending.length === 0 ? 'OK' : `${offending.length} annual payers are in inferences — false positives`,
    examples: offending.slice(0, 5).map((c) => `#${c.allmoxy_customer_id} ${c.name}`),
  };
});

test('unattributed count (profiles, excluding duplicates) = churn_inferences count', 'error', () => {
  // Exclude annual payers AND excluded_from_logo_count records (duplicate_of /
  // sub_instance_of_parent) — they're not real churns from a logo standpoint.
  const annualIds = new Set(annualPayers?.annual_payer_ids || []);
  const churned = (profiles?.rows || []).filter((r) =>
    r.status === 'churned' && !annualIds.has(r.allmoxy_customer_id) && !r.excluded_from_logo_count
  );
  const withReason = churned.filter((r) => r.churn_reason && r.churn_reason.trim());
  const unattributed = churned.length - withReason.length;
  const inferenceCount = (inferences?.customers || []).length;
  return {
    passed: unattributed === inferenceCount,
    detail: `unattributed=${unattributed} · inferences=${inferenceCount}${unattributed === inferenceCount ? '' : ` (Δ=${inferenceCount - unattributed})`}`,
  };
});

// ============================================================================
// STATUS OVERRIDE INVARIANTS
// ============================================================================

test('every customer_status_override is applied to its profile', 'error', () => {
  const missing = [];
  for (const o of statusOverrides?.overrides || []) {
    const p = profileById.get(o.allmoxy_customer_id);
    if (!p) { missing.push(`#${o.allmoxy_customer_id} ${o.customer_name} — no profile`); continue; }
    // For duplicate_of, the expected status is the PARENT's status (the apply
    // script mirrors it) — not the JSON's force_status field, which is a
    // hint/fallback. For all other arrangement types, force_status is canonical.
    let expectedStatus = o.force_status;
    if (o.arrangement_type === 'duplicate_of' && o.parent_allmoxy_customer_id) {
      const parent = profileById.get(o.parent_allmoxy_customer_id);
      if (parent?.status) expectedStatus = parent.status;
    }
    if (p.status !== expectedStatus) { missing.push(`#${o.allmoxy_customer_id} status=${p.status}, expected ${expectedStatus}`); continue; }
    if ((o.arrangement_type === 'sub_instance_of_parent' || o.arrangement_type === 'comp' || o.arrangement_type === 'duplicate_of')
        && p.current_subscription_mrr !== (o.standalone_mrr ?? 0)) {
      missing.push(`#${o.allmoxy_customer_id} MRR=$${p.current_subscription_mrr}, expected $${o.standalone_mrr ?? 0}`);
    }
  }
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? `${(statusOverrides?.overrides || []).length} overrides applied cleanly` : `${missing.length} not applied`,
    examples: missing.slice(0, 5),
  };
});

test('every sub_instance_of_parent / duplicate_of override has an existing parent (and matching status for duplicates)', 'error', () => {
  const broken = [];
  for (const o of statusOverrides?.overrides || []) {
    if (o.arrangement_type !== 'sub_instance_of_parent' && o.arrangement_type !== 'duplicate_of') continue;
    // duplicate_of with no parent_allmoxy_customer_id is allowed IF parent_customer_name
    // is set — the canonical record exists externally (in HubSpot only, no separate
    // Allmoxy record). sub_instance_of_parent always requires a local parent.
    if (!o.parent_allmoxy_customer_id) {
      if (o.arrangement_type === 'duplicate_of' && o.parent_customer_name) continue;
      broken.push(`#${o.allmoxy_customer_id} has no parent_allmoxy_customer_id (arrangement_type=${o.arrangement_type} requires one${o.arrangement_type === 'duplicate_of' ? ' unless parent_customer_name is set' : ''})`);
      continue;
    }
    const parent = profileById.get(o.parent_allmoxy_customer_id);
    if (!parent) { broken.push(`#${o.allmoxy_customer_id} parent #${o.parent_allmoxy_customer_id} not found`); continue; }
    // For sub_instance_of_parent, the parent MUST be active (the sub is alive
    // because the parent pays — if the parent is churned the sub should be too,
    // and that's a different override). For duplicate_of, the duplicate mirrors
    // whatever the parent's status is.
    if (o.arrangement_type === 'sub_instance_of_parent' && parent.status !== 'active') {
      broken.push(`#${o.allmoxy_customer_id} parent #${o.parent_allmoxy_customer_id} (${parent.name}) is ${parent.status}, not active`);
    }
    if (o.arrangement_type === 'duplicate_of') {
      const child = profileById.get(o.allmoxy_customer_id);
      if (child && parent.status !== child.status) {
        broken.push(`#${o.allmoxy_customer_id} (${child.status}) does not mirror parent #${o.parent_allmoxy_customer_id} (${parent.status})`);
      }
    }
  }
  return {
    passed: broken.length === 0,
    detail: broken.length === 0 ? 'OK' : `${broken.length} broken parent references`,
    examples: broken.slice(0, 5),
  };
});

// ============================================================================
// AMORTIZATION INTEGRITY
// ============================================================================

test('every annual_payer has a payer_details entry', 'warn', () => {
  const details = annualPayers?.payer_details || {};
  const missing = (annualPayers?.annual_payer_ids || []).filter((id) => !details[String(id)]);
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? 'OK' : `${missing.length} payers missing payer_details (no QoE evidence metadata)`,
    examples: missing.slice(0, 5).map((id) => `#${id} ${profileById.get(id)?.name ?? '(unknown)'}`),
  };
});

test('every annual_amortization_override matches an annual_payer', 'error', () => {
  const annualIds = new Set(annualPayers?.annual_payer_ids || []);
  const orphan = (amortOverridesFile?.overrides || []).filter((o) => !annualIds.has(o.allmoxy_customer_id));
  return {
    passed: orphan.length === 0,
    detail: orphan.length === 0 ? 'OK' : `${orphan.length} amortization overrides for customers not in annual_payers.json`,
    examples: orphan.slice(0, 5).map((o) => `#${o.allmoxy_customer_id} ${o.customer_name}`),
  };
});

test('each annual_payer has annualized monthly_history within past 18 months', 'warn', () => {
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth() - 18, 1);
  const missing = [];
  for (const id of annualPayers?.annual_payer_ids || []) {
    const p = profileById.get(id);
    if (!p) continue;
    let hasAnnualized = false;
    for (const [m, cell] of Object.entries(p.monthly_history || {})) {
      if (!cell?.annualized) continue;
      const [y, mm] = m.split('-').map(Number);
      if (new Date(y, mm - 1, 1) >= cutoff) { hasAnnualized = true; break; }
    }
    if (!hasAnnualized) missing.push(`#${id} ${p.name} — no annualized months in past 18mo (amortization may not have applied)`);
  }
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? 'OK' : `${missing.length} annual payers missing recent amortization`,
    examples: missing.slice(0, 5),
  };
});

test('every synthetic_transaction has a matching profile', 'error', () => {
  const orphan = (syntheticTxns?.transactions || []).filter((t) => !profileById.has(t.allmoxy_customer_id));
  return {
    passed: orphan.length === 0,
    detail: orphan.length === 0 ? 'OK' : `${orphan.length} synthetic transactions for unknown customers`,
    examples: orphan.slice(0, 5).map((t) => `#${t.allmoxy_customer_id} ${t.customer_name} $${t.amount}`),
  };
});

// ============================================================================
// MRR / WATERFALL RECONCILIATION
// ============================================================================

// Tolerance: 0.5% of expected, with $5 floor (so tiny months don't trigger
// on rounding noise) and $500 ceiling (so big drift still flags). Tested on
// the last 24 months only — QoE diligence cares about recent state, not
// ancient drift from the xlsx's manually-curated MRR-by-Month tab.
test('mrr_by_month subscription ≈ sum of customer_profiles monthly_history (last 24 months, ±0.5%)', 'error', () => {
  const mrrRows = mrrByMonth?.rows || [];
  const profileSumByMonth = new Map();
  for (const p of profiles?.rows || []) {
    for (const [m, cell] of Object.entries(p.monthly_history || {})) {
      profileSumByMonth.set(m, (profileSumByMonth.get(m) || 0) + (cell.subscription || 0));
    }
  }
  const recent = mrrRows.slice(-24);
  const mismatches = [];
  for (const r of recent) {
    if (r.mrr_subscription == null) continue;
    const expected = profileSumByMonth.get(r.month) || 0;
    const tol = Math.min(500, Math.max(5, Math.abs(expected) * 0.005));
    if (Math.abs((r.mrr_subscription || 0) - expected) > tol) {
      mismatches.push(`${r.month}: mrr_by_month=$${round2(r.mrr_subscription)} vs profile-sum=$${round2(expected)} (Δ $${round2(r.mrr_subscription - expected)}, tol $${round2(tol)})`);
    }
  }
  return {
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? `${recent.length} recent months reconciled within 0.5%` : `${mismatches.length} months out of tolerance`,
    examples: mismatches.slice(0, 5),
  };
});

// Lifetime drift is a soft warning because documented transaction
// reclassifications (Panhandle Door's $7,658 service-charge move, etc.) and
// services/connect-only customers create expected drift. Tolerance: 1% with
// $5 floor.
test('customer_profiles lifetime_subscription ≈ sum of monthly_history.subscription (±1%)', 'warn', () => {
  const mismatches = [];
  for (const p of profiles?.rows || []) {
    let sum = 0;
    for (const cell of Object.values(p.monthly_history || {})) sum += cell.subscription || 0;
    const tol = Math.max(5, Math.abs(p.lifetime_subscription || 0) * 0.01);
    if (Math.abs((p.lifetime_subscription || 0) - sum) > tol) {
      mismatches.push(`#${p.allmoxy_customer_id} ${p.name}: lifetime=$${round2(p.lifetime_subscription)} vs sum=$${round2(sum)} (Δ $${round2(p.lifetime_subscription - sum)}, tol $${round2(tol)})`);
    }
  }
  return {
    passed: mismatches.length === 0,
    detail: mismatches.length === 0 ? `${profiles?.rows?.length || 0} customers reconciled within 1%` : `${mismatches.length} customers exceed 1% drift (often a transaction reclassification — cross-check Adjustments Register)`,
    examples: mismatches.slice(0, 5),
  };
});

// ============================================================================
// ADJUSTMENTS REGISTER COMPLETENESS
// ============================================================================

test('adjustments_register contains an entry for every annual_payer', 'error', () => {
  const expectedIds = new Set(annualPayers?.annual_payer_ids || []);
  const registered = new Set(
    (adjustments?.adjustments || [])
      .filter((a) => a.category === 'annual_payer_flag')
      .map((a) => a.customer_id)
  );
  const missing = [...expectedIds].filter((id) => !registered.has(id));
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? `${expectedIds.size} annual payers on register` : `${missing.length} missing`,
    examples: missing.map((id) => `#${id} ${profileById.get(id)?.name}`),
  };
});

test('adjustments_register contains an entry for every status_override', 'error', () => {
  const expectedIds = new Set((statusOverrides?.overrides || []).map((o) => o.allmoxy_customer_id));
  const registered = new Set(
    (adjustments?.adjustments || [])
      .filter((a) => a.category === 'status_override')
      .map((a) => a.customer_id)
  );
  const missing = [...expectedIds].filter((id) => !registered.has(id));
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? `${expectedIds.size} status overrides on register` : `${missing.length} missing`,
    examples: missing.map((id) => `#${id} ${profileById.get(id)?.name}`),
  };
});

test('adjustments_register contains an entry for every synthetic_transaction', 'error', () => {
  const expectedIds = (syntheticTxns?.transactions || []).map((t) => `${t.allmoxy_customer_id}-${t.created}`);
  const registered = new Set(
    (adjustments?.adjustments || [])
      .filter((a) => a.category === 'synthetic_transaction')
      .map((a) => `${a.customer_id}-${a.txn_date}`)
  );
  const missing = expectedIds.filter((k) => !registered.has(k));
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? `${expectedIds.length} synthetic transactions on register` : `${missing.length} missing`,
    examples: missing,
  };
});

// ============================================================================
// EBITDA BRIDGE INTEGRITY
// ============================================================================

test('GAAP EBITDA = Net Income + Interest + Tax + D&A (within rounding)', 'error', () => {
  const results = [];
  for (const [name, b] of Object.entries(ebitda?.bridges || {})) {
    if (b.unavailable) continue;
    const addBackSum = (b.add_backs_to_ebitda || []).reduce((s, ab) => s + (ab.amount || 0), 0);
    const expected = (b.net_income || 0) + addBackSum;
    if (!approxEq(b.gaap_ebitda || 0, expected, 1)) {
      results.push(`${name}: NI=$${round2(b.net_income)} + add-backs=$${round2(addBackSum)} = $${round2(expected)} but gaap_ebitda=$${round2(b.gaap_ebitda)} (Δ $${round2((b.gaap_ebitda || 0) - expected)})`);
    }
  }
  return {
    passed: results.length === 0,
    detail: results.length === 0 ? 'all bridges reconcile' : `${results.length} mismatched`,
    examples: results,
  };
});

test('Adjusted EBITDA = GAAP EBITDA + QoE adjustment total (within rounding)', 'error', () => {
  const results = [];
  for (const [name, b] of Object.entries(ebitda?.bridges || {})) {
    if (b.unavailable) continue;
    const expected = (b.gaap_ebitda || 0) + (b.qoe_adjustment_total || 0);
    if (!approxEq(b.adjusted_ebitda || 0, expected, 1)) {
      results.push(`${name}: GAAP=$${round2(b.gaap_ebitda)} + adj=$${round2(b.qoe_adjustment_total)} = $${round2(expected)} but adjusted=$${round2(b.adjusted_ebitda)} (Δ $${round2((b.adjusted_ebitda || 0) - expected)})`);
    }
  }
  return {
    passed: results.length === 0,
    detail: results.length === 0 ? 'all bridges reconcile' : `${results.length} mismatched`,
    examples: results,
  };
});

// ============================================================================
// QoE READINESS / SOFT CHECKS
// ============================================================================

test('no QoE adjustment is still a placeholder (banker-ready)', 'warn', () => {
  const placeholders = [];
  for (const [name, b] of Object.entries(ebitda?.bridges || {})) {
    if (b.unavailable) continue;
    for (const a of b.qoe_adjustments || []) {
      if (a.is_placeholder) placeholders.push(`${name}: ${a.id}`);
    }
  }
  return {
    passed: placeholders.length === 0,
    detail: placeholders.length === 0 ? 'all QoE add-backs have real amounts' : `${placeholders.length} placeholders still in bridge — owner sign-off needed`,
    examples: placeholders.slice(0, 10),
  };
});

test('every annual_payer is QoE-verified (payer_details.verified_by populated)', 'warn', () => {
  const details = annualPayers?.payer_details || {};
  const unverified = (annualPayers?.annual_payer_ids || []).filter((id) => !details[String(id)]?.verified_by);
  return {
    passed: unverified.length === 0,
    detail: unverified.length === 0 ? 'all verified' : `${unverified.length} payers need verified_by`,
    examples: unverified.map((id) => `#${id} ${profileById.get(id)?.name}`),
  };
});

test('every annual_payer has a contract_link', 'warn', () => {
  const details = annualPayers?.payer_details || {};
  const missing = (annualPayers?.annual_payer_ids || []).filter((id) => !details[String(id)]?.contract_link);
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? 'all contracts on file' : `${missing.length} payers without a contract_link`,
    examples: missing.map((id) => `#${id} ${profileById.get(id)?.name}`),
  };
});

test('stripe_qb_reconciliation: no month flagged status=investigate', 'warn', () => {
  const investigate = (reconciliation?.months || []).filter((m) => m.status === 'investigate');
  return {
    passed: investigate.length === 0,
    detail: investigate.length === 0 ? 'all months tight or acceptable' : `${investigate.length} months need investigation`,
    examples: investigate.map((m) => `${m.month}: variance ${m.variance_pct != null ? (m.variance_pct * 100).toFixed(1) + '%' : '—'}`),
  };
});

// ============================================================================
// SCHEMA / SNAPSHOT PRESENCE
// ============================================================================

test('all expected snapshots exist', 'error', () => {
  const expected = [
    'customer_profiles', 'mrr_by_month', 'mrr_waterfall', 'subscription_by_month',
    'pnl_by_month', 'churn_inferences', 'adjustments_register', 'stripe_qb_reconciliation',
    'annual_amortization_evidence', 'ebitda_bridge',
  ];
  const missing = expected.filter((name) => !fs.existsSync(path.join(SNAP, `${name}.json`)));
  return {
    passed: missing.length === 0,
    detail: missing.length === 0 ? `${expected.length} core snapshots present` : `${missing.length} missing`,
    examples: missing,
  };
});

// ============================================================================
// RUN
// ============================================================================

const results = [];
let errors = 0;
let warnings = 0;
let passed = 0;

for (const t of tests) {
  let result;
  try {
    result = t.fn();
  } catch (e) {
    result = { passed: false, detail: `THREW: ${e.message}`, examples: [] };
  }
  const entry = {
    name: t.name,
    severity: t.severity,
    passed: !!result.passed,
    detail: result.detail || '',
    examples: result.examples || [],
  };
  results.push(entry);
  if (entry.passed) passed++;
  else if (entry.severity === 'error') errors++;
  else if (entry.severity === 'warn') warnings++;
}

const summary = {
  fetched_at: new Date().toISOString(),
  total: tests.length,
  passed,
  errors,
  warnings,
  status: errors === 0 ? (warnings === 0 ? 'green' : 'yellow') : 'red',
};

const out = {
  ...summary,
  comment:
    'QoE-6 invariant test results. error-severity failures indicate hard QoE-blocking inconsistencies; warn-severity failures are soft issues worth investigating. Generated by _etl_scripts/run_invariant_tests.mjs as the final step of refresh_all.',
  results,
};

fs.writeFileSync(path.join(SNAP, 'invariant_test_results.json'), JSON.stringify(out, null, 2));

// Console summary
const COLOR = { red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', reset: '\x1b[0m', dim: '\x1b[2m' };
console.log(`\nInvariant tests: ${COLOR[summary.status === 'red' ? 'red' : summary.status === 'yellow' ? 'yellow' : 'green']}${summary.status.toUpperCase()}${COLOR.reset}`);
console.log(`  ${passed}/${tests.length} passed · ${errors} error(s) · ${warnings} warning(s)\n`);

for (const r of results) {
  if (r.passed) continue;
  const icon = r.severity === 'error' ? '✗' : '⚠';
  const color = r.severity === 'error' ? COLOR.red : COLOR.yellow;
  console.log(`${color}${icon} [${r.severity}] ${r.name}${COLOR.reset}`);
  console.log(`${COLOR.dim}    ${r.detail}${COLOR.reset}`);
  for (const ex of r.examples.slice(0, 3)) console.log(`${COLOR.dim}      · ${ex}${COLOR.reset}`);
}

if (passed === tests.length) {
  console.log(`${COLOR.green}✓ All invariants pass.${COLOR.reset}`);
}

process.exit(errors > 0 ? 1 : 0);
