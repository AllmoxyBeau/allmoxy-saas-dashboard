#!/usr/bin/env node
/**
 * Adjustments Register builder.
 *
 * Consolidates all six override / adjustment files into a single canonical
 * register that a QoE reviewer can audit in one place. Every adjustment we
 * make to raw source data (Stripe, HubSpot, QuickBooks, the meta xlsx) lands
 * here with a normalized schema:
 *
 *   { id, category, severity, customer_name, customer_id, period|txn_date,
 *     before, after, delta, reason, evidence, source_file, added_by }
 *
 * Sources (in repo today):
 *   - src/data/annual_payers.json                          (annual_payer_flag)
 *   - _etl_scripts/annual_amortization_overrides.json     (amortization)
 *   - _etl_scripts/variance_overrides.json                 (variance)
 *   - _etl_scripts/transaction_overrides.json             (reclassification)
 *   - _etl_scripts/stripe_id_overrides.json               (hygiene_stripe_id)
 *   - src/data/connect_customer_overrides.json             (hygiene_connect_mapping)
 *
 * Run as part of refresh_all (after customer_profiles + amortization so the
 * dollar-impact figures reflect the post-adjustment state) — or standalone:
 *   node _etl_scripts/build_adjustments_register.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function round2(n) { return Math.round(n * 100) / 100; }

const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));
const profileById = new Map();
if (profiles?.rows) for (const r of profiles.rows) profileById.set(r.allmoxy_customer_id, r);

const adjustments = [];

// ============================================================================
// 1. Annual payer flags → src/data/annual_payers.json
// ============================================================================
const annualPayers = readJson(path.join(ROOT, 'src/data/annual_payers.json'));
if (annualPayers?.annual_payer_ids) {
  for (const id of annualPayers.annual_payer_ids) {
    const profile = profileById.get(id);
    // Total $ amortized into the recent window for this customer (sum of
    // annualized monthly_history cells in the past 18 months).
    let annualizedDollars = 0;
    let annualizedMonths = 0;
    if (profile?.monthly_history) {
      const today = new Date();
      const cutoff = new Date(today.getFullYear(), today.getMonth() - 18, 1);
      for (const [m, cell] of Object.entries(profile.monthly_history)) {
        if (!cell?.annualized) continue;
        const [y, mm] = m.split('-').map(Number);
        const d = new Date(y, mm - 1, 1);
        if (d < cutoff) continue;
        annualizedDollars += cell.subscription ?? 0;
        annualizedMonths++;
      }
    }
    adjustments.push({
      id: `annual-payer-flag-${id}`,
      category: 'annual_payer_flag',
      severity: 'monetary',
      customer_name: profile?.name ?? `(allmoxy_customer_id ${id})`,
      customer_id: id,
      period: null,
      txn_date: null,
      before: null,
      after: round2(annualizedDollars),
      delta: null,
      reason: `Flagged as an annual payer — lump-sum charges ≥ $3,000 are amortized across coverage months (default 12, override-capable). Trailing-18-month amortized contribution to MRR: $${round2(annualizedDollars).toLocaleString()} across ${annualizedMonths} months.`,
      evidence: null,
      source_file: 'src/data/annual_payers.json',
      added_by: annualPayers.updated_at ? `updated_at ${annualPayers.updated_at}` : null,
    });
  }
}

// ============================================================================
// 2. Annual amortization overrides → _etl_scripts/annual_amortization_overrides.json
// ============================================================================
const amortOverrides = readJson(path.join(ROOT, '_etl_scripts/annual_amortization_overrides.json'));
if (amortOverrides?.overrides) {
  for (const o of amortOverrides.overrides) {
    const lumpSum = (o.amount_match_min + o.amount_match_max) / 2;
    const perMonth = lumpSum / o.months;
    adjustments.push({
      id: `amortization-${o.allmoxy_customer_id}-${o.origin_month}`,
      category: 'amortization',
      severity: 'monetary',
      customer_name: o.customer_name,
      customer_id: o.allmoxy_customer_id,
      period: `${o.start_month} → +${o.months} mo`,
      txn_date: o.origin_month,
      before: round2(lumpSum),
      after: round2(perMonth),
      delta: round2(perMonth - lumpSum),
      reason: o.reason,
      evidence: null,
      source_file: '_etl_scripts/annual_amortization_overrides.json',
      added_by: amortOverrides.updated_at ? `updated_at ${amortOverrides.updated_at}` : null,
    });
  }
}

// ============================================================================
// 3. Variance overrides (carry-forward for non-churn $0 months) →
//    _etl_scripts/variance_overrides.json
// ============================================================================
const varianceOverrides = readJson(path.join(ROOT, '_etl_scripts/variance_overrides.json'));
if (varianceOverrides?.overrides) {
  for (const o of varianceOverrides.overrides) {
    // Look up the carried-forward value from customer_profiles
    const profile = profiles?.rows?.find((r) => r.name === o.customer_name);
    const carried = profile?.monthly_history?.[o.month]?.subscription ?? null;
    adjustments.push({
      id: `variance-${o.customer_name.replace(/\W+/g, '_').toLowerCase()}-${o.month}`,
      category: 'variance',
      severity: 'monetary',
      customer_name: o.customer_name,
      customer_id: profile?.allmoxy_customer_id ?? null,
      period: o.month,
      txn_date: null,
      before: 0,
      after: carried,
      delta: carried,
      reason: o.reason,
      evidence: null,
      source_file: '_etl_scripts/variance_overrides.json',
      added_by: varianceOverrides.updated_at ? `updated_at ${varianceOverrides.updated_at}` : null,
    });
  }
}

// ============================================================================
// 4. Transaction overrides (per-transaction stream reclassifications) →
//    _etl_scripts/transaction_overrides.json
// ============================================================================
const txnOverrides = readJson(path.join(ROOT, '_etl_scripts/transaction_overrides.json'));
if (txnOverrides?.overrides) {
  for (const o of txnOverrides.overrides) {
    adjustments.push({
      id: `reclassification-${o.allmoxy_customer_id}-${o.month}-${o.txn_created_starts_with ?? 'na'}`,
      category: 'reclassification',
      severity: 'monetary',
      customer_name: o.customer_name,
      customer_id: o.allmoxy_customer_id,
      period: o.month,
      txn_date: o.txn_created_starts_with ?? null,
      before: round2(o.amount),
      after: round2(o.amount),
      delta: 0,
      reason: `Reclassified from ${o.from} → ${o.to}: ${o.reason}` + (o.source_allmoxy_customer_id ? ` (transaction also moved from source customer ${o.source_customer_name} #${o.source_allmoxy_customer_id})` : ''),
      evidence: null,
      source_file: '_etl_scripts/transaction_overrides.json',
      added_by: txnOverrides.updated_at ? `updated_at ${txnOverrides.updated_at}` : null,
    });
  }
}

// ============================================================================
// 5. Stripe ID overrides (inject missing IDs so orphan charges are attributed)
//    → _etl_scripts/stripe_id_overrides.json
// ============================================================================
const stripeIdOverrides = readJson(path.join(ROOT, '_etl_scripts/stripe_id_overrides.json'));
if (stripeIdOverrides?.overrides) {
  for (const o of stripeIdOverrides.overrides) {
    adjustments.push({
      id: `hygiene-stripe-${o.allmoxy_customer_id}`,
      category: 'hygiene_stripe_id',
      severity: 'hygiene',
      customer_name: o.name,
      customer_id: o.allmoxy_customer_id,
      period: null,
      txn_date: null,
      before: null,
      after: null,
      delta: null,
      reason: `Injected ${o.stripe_customer_ids.length} Stripe customer ID(s): ${o.stripe_customer_ids.join(', ')}. ${o.reason}`,
      evidence: null,
      source_file: '_etl_scripts/stripe_id_overrides.json',
      added_by: o.added_by ?? null,
    });
  }
}

// ============================================================================
// 6. Synthetic transactions (off-Stripe payments: checks, wires, ACH) →
//    _etl_scripts/synthetic_transactions.json
// ============================================================================
const syntheticTxns = readJson(path.join(ROOT, '_etl_scripts/synthetic_transactions.json'));
if (syntheticTxns?.transactions) {
  for (const t of syntheticTxns.transactions) {
    adjustments.push({
      id: `synthetic-${t.allmoxy_customer_id}-${t.created}`,
      category: 'synthetic_transaction',
      severity: 'monetary',
      customer_name: t.customer_name,
      customer_id: t.allmoxy_customer_id,
      period: (t.created || '').slice(0, 7),
      txn_date: (t.created || '').slice(0, 10),
      before: 0,
      after: round2(t.amount),
      delta: round2(t.amount),
      reason: `Off-Stripe ${t.payment_method ?? 'payment'} (${t.type}): ${t.description ?? ''} ${t.reason ?? ''}`.trim(),
      evidence: t.evidence ?? null,
      source_file: '_etl_scripts/synthetic_transactions.json',
      added_by: t.added_by ?? null,
    });
  }
}

// ============================================================================
// 7. Customer status overrides (sub-instance-of-parent, comp arrangements) →
//    _etl_scripts/customer_status_overrides.json
// ============================================================================
const statusOverrides = readJson(path.join(ROOT, '_etl_scripts/customer_status_overrides.json'));
if (statusOverrides?.overrides) {
  for (const o of statusOverrides.overrides) {
    const profile = profileById.get(o.allmoxy_customer_id);
    adjustments.push({
      id: `status-override-${o.allmoxy_customer_id}`,
      category: 'status_override',
      severity: 'monetary',
      customer_name: o.customer_name,
      customer_id: o.allmoxy_customer_id,
      period: null,
      txn_date: null,
      before: profile?.lifetime_subscription ? null : null,
      after: o.standalone_mrr ?? 0,
      delta: null,
      reason: `Forced status='${o.force_status}' (${o.arrangement_type}${o.parent_allmoxy_customer_id ? ` of #${o.parent_allmoxy_customer_id} ${o.parent_customer_name}` : ''}). ${o.reason} Evidence: ${o.evidence ?? '(none on file)'}`,
      evidence: o.evidence ?? null,
      source_file: '_etl_scripts/customer_status_overrides.json',
      added_by: o.added_by ?? null,
    });
  }
}

// ============================================================================
// 8. Connect customer mappings (acct_id → customer) → src/data/connect_customer_overrides.json
// ============================================================================
const connectOverrides = readJson(path.join(ROOT, 'src/data/connect_customer_overrides.json'));
if (connectOverrides?.mapping) {
  const mapping = connectOverrides.mapping;
  const mappingCount = Object.keys(mapping).length;
  // Rather than emit one row per mapping (could be hundreds), emit a single
  // summary entry with a sample of the mappings. A drilldown can show the
  // full list if needed.
  adjustments.push({
    id: 'hygiene-connect-mappings',
    category: 'hygiene_connect_mapping',
    severity: 'hygiene',
    customer_name: null,
    customer_id: null,
    period: null,
    txn_date: null,
    before: null,
    after: null,
    delta: null,
    reason: `${mappingCount} customer-name → allmoxy_customer_id mappings for Stripe Connect revenue attribution. Source: Stripe Connect Revenue sheets carry the customer NAME on each transaction; this file resolves names to canonical Allmoxy IDs so per-customer Connect rollups join correctly. Roughly ${connectOverrides.unmapped?.length ?? 0} names remain unmapped (acceptable — typically dormant or one-off accounts).`,
    evidence: null,
    source_file: 'src/data/connect_customer_overrides.json',
    added_by: connectOverrides.updated_at ? `updated_at ${connectOverrides.updated_at}` : null,
  });
}

// ============================================================================
// 9. Never-paid customer auto-classification (run by apply_never_paid_classification.mjs).
//    Surfaces as a single summary row on the register so a reviewer sees that
//    we filter out customers who signed up but never paid.
// ============================================================================
const neverPaidCustomers = (profiles?.rows || []).filter((r) => r.never_paid === true);
const zeroNetWithActivity = neverPaidCustomers.filter((r) => r.zero_net_revenue_with_activity);
if (neverPaidCustomers.length > 0) {
  adjustments.push({
    id: 'auto-never-paid-classification',
    category: 'never_paid_classification',
    severity: 'hygiene',
    customer_name: null,
    customer_id: null,
    period: null,
    txn_date: null,
    before: null,
    after: null,
    delta: null,
    reason: `${neverPaidCustomers.length} customer record(s) auto-classified status='never_paid' and excluded_from_logo_count=true (lifetime ≤ $0). Split: ${neverPaidCustomers.length - zeroNetWithActivity.length} pure never-paid (0 transactions) + ${zeroNetWithActivity.length} zero-net-revenue-with-activity (had transactions but they netted to $0 — refunds, chargebacks, reversed billing). Rationale: net economic contribution to Allmoxy was zero either way, so they should not appear in churn or logo counts. Sample: ${neverPaidCustomers.slice(0, 3).map((r) => `#${r.allmoxy_customer_id} ${r.name}`).join(', ')}${neverPaidCustomers.length > 3 ? ', …' : ''}.`,
    evidence: null,
    source_file: '_etl_scripts/apply_never_paid_classification.mjs',
    added_by: 'Auto-classifier (deterministic rule, not user-maintained)',
  });
}

// ============================================================================
// Write the consolidated register
// ============================================================================
const out = {
  fetched_at: new Date().toISOString(),
  comment:
    'Canonical Adjustments Register — every override / adjustment made to raw source data, consolidated from 6 underlying config files. Built by _etl_scripts/build_adjustments_register.mjs. A QoE reviewer should be able to answer "give me every adjustment you made to the raw data" from this single file. Drill into the source_file column to see the underlying config.',
  totals: {
    by_category: adjustments.reduce((acc, a) => {
      acc[a.category] = (acc[a.category] || 0) + 1;
      return acc;
    }, {}),
    by_severity: adjustments.reduce((acc, a) => {
      acc[a.severity] = (acc[a.severity] || 0) + 1;
      return acc;
    }, {}),
    total: adjustments.length,
  },
  adjustments,
};

const outPath = path.join(SNAP, 'adjustments_register.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath} — ${adjustments.length} adjustments (${out.totals.by_severity.monetary ?? 0} monetary, ${out.totals.by_severity.hygiene ?? 0} hygiene).`);
