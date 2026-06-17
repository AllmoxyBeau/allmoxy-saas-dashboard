#!/usr/bin/env node
/**
 * Stripe ↔ QuickBooks reconciliation report.
 *
 * Per-month tie-out:
 *   Stripe side  → sum of customer_profiles.transactions (status=succeeded), by type
 *   QB side      → pnl_by_month line items (subscription_revenue, services_revenue,
 *                  affiliate_revenue, subscription_tax, annual_deferred, stripe_fee_income)
 *
 * Variance explanations (the meaningful reconciling items):
 *   • Annual lump-sum cash receipts in Stripe vs. GAAP-recognized monthly in QB
 *     (QB defers and recognizes via "4100 Annual Deferred Monthly")
 *   • Per-transaction stream reclassifications (transaction_overrides.json)
 *   • Sales tax — Stripe gross includes tax; QB books it separately as 4050 subscription_tax (negative)
 *   • Refunds timing
 *   • Stripe processing fees (income to Allmoxy, pass-through to merchants on Connect)
 *
 * Output: public/snapshots/stripe_qb_reconciliation.json
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function round2(n) { return Math.round(n * 100) / 100; }

const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));
const pnl = readJson(path.join(SNAP, 'pnl_by_month.json'));

// ============================================================================
// Stripe-side rollup — sum of customer_profiles.transactions by month × type
// ============================================================================
const stripeByMonth = {};
for (const p of (profiles.rows || [])) {
  for (const t of (p.transactions || [])) {
    if (t.status !== 'succeeded') continue;
    const ym = (t.created || '').slice(0, 7);
    if (!ym) continue;
    if (!stripeByMonth[ym]) stripeByMonth[ym] = { subscription: 0, services: 0, connect: 0, other: 0, total: 0, refunds: 0 };
    const net = (typeof t.net_amount === 'number' ? t.net_amount : t.amount) || 0;
    const refunded = t.amount_refunded || 0;
    const type = t.type || 'other';
    stripeByMonth[ym][type] = (stripeByMonth[ym][type] || 0) + net;
    stripeByMonth[ym].refunds += refunded;
    stripeByMonth[ym].total += net;
  }
}

// ============================================================================
// QuickBooks-side rollup — per-month line items
// ============================================================================
const months = (pnl.months || []).slice();
const qbByMonth = {};
const get = (key, m) => (pnl.data?.[key]?.[m] ?? 0);
for (const m of months) {
  qbByMonth[m] = {
    subscription_revenue: get('subscription_revenue', m),
    services_revenue: get('services_revenue', m),
    affiliate_revenue: get('affiliate_revenue', m),
    subscription_tax: get('subscription_tax', m),          // typically negative (collected but remitted)
    annual_deferred: get('annual_deferred', m),            // monthly recognition of previously-deferred annual contracts
    stripe_fee_income: get('stripe_fee_income', m),        // markup Allmoxy keeps on Stripe Connect fees
    events_income: get('events_income', m),
    billable_expense_income: get('billable_expense_income', m),
    misc_income: get('misc_income', m),
    total_income: get('total_income', m),
  };
}

// ============================================================================
// Per-month reconciliation rows
// ============================================================================
const rows = [];
for (const m of months) {
  const s = stripeByMonth[m] ?? { subscription: 0, services: 0, connect: 0, refunds: 0, total: 0 };
  const q = qbByMonth[m];
  // Stripe subscription gross + annual deferred recognition ≈ QB subscription_revenue + annual_deferred.
  // The cleanest like-for-like is: cash subscription receipts in Stripe vs (subscription_revenue + annual_deferred) recognized in QB.
  const stripeSub = s.subscription;
  const qbSubRecognized = q.subscription_revenue + q.annual_deferred;
  const subVariance = stripeSub - qbSubRecognized;
  const subVariancePct = qbSubRecognized > 0 ? subVariance / qbSubRecognized : null;

  const stripeSvc = s.services;
  const qbSvc = q.services_revenue;
  const svcVariance = stripeSvc - qbSvc;
  const svcVariancePct = qbSvc > 0 ? svcVariance / qbSvc : null;

  rows.push({
    month: m,
    stripe: {
      subscription: round2(stripeSub),
      services: round2(stripeSvc),
      connect: round2(s.connect),
      other: round2(s.other),
      refunds: round2(s.refunds),
      total: round2(s.total),
    },
    qb: {
      subscription_revenue: round2(q.subscription_revenue),
      annual_deferred: round2(q.annual_deferred),
      subscription_recognized: round2(qbSubRecognized),
      services_revenue: round2(q.services_revenue),
      affiliate_revenue: round2(q.affiliate_revenue),
      subscription_tax: round2(q.subscription_tax),
      stripe_fee_income: round2(q.stripe_fee_income),
      total_income: round2(q.total_income),
    },
    variance: {
      subscription_dollars: round2(subVariance),
      subscription_pct: subVariancePct,
      services_dollars: round2(svcVariance),
      services_pct: svcVariancePct,
    },
    tie_out_status: classifyTieOut(subVariance, qbSubRecognized, svcVariance, qbSvc),
  });
}

function classifyTieOut(subVar, qbSub, svcVar, qbSvc) {
  const subPct = qbSub > 0 ? Math.abs(subVar) / qbSub : 0;
  const svcPct = qbSvc > 0 ? Math.abs(svcVar) / qbSvc : 0;
  // Stricter for QoE: tight tie ≤1%, acceptable ≤5%, investigate >5%.
  if (subPct <= 0.01 && svcPct <= 0.01) return 'tight';
  if (subPct <= 0.05 && svcPct <= 0.05) return 'acceptable';
  return 'investigate';
}

// ============================================================================
// Known reconciling items — for the dashboard's explanatory footnotes
// ============================================================================
const reconcilingItems = [
  {
    label: 'Annual lump-sum cash receipts',
    description:
      'Stripe records the full lump-sum amount in the month it was charged (e.g., B&B Door\'s $32,002.50 in May 2026). QB defers and recognizes monthly via Line 4100 "Annual Deferred Monthly" (~$3,173/mo). Variance reconciles over the 12–15 month coverage window.',
    sign: 'Stripe > QB in receipt month; Stripe < QB in subsequent months.',
  },
  {
    label: 'Sales tax inclusion',
    description:
      'Stripe gross charges include sales tax collected; QB separately books Line 4050 "Monthly Subscription Tax" (negative) to remove the pass-through. The Stripe-side numbers in this reconciliation use net_amount (post-refund) but still include any sales tax collected.',
    sign: 'Small consistent positive variance in Stripe subscription line.',
  },
  {
    label: 'Per-transaction stream reclassifications',
    description:
      'Some transactions are reclassified by `transaction_overrides.json` (e.g., Panhandle\'s $7,658 March charge moved from subscription → services). Stripe still shows them under their original type until you apply the overrides; QB books them per the corrected classification.',
    sign: 'Lumpy variance in specific months matching override entries.',
  },
  {
    label: 'Refund timing',
    description:
      'Stripe net_amount nets refunds against the original charge in the original month. QB books refunds in the period the refund occurred. Variance possible when a refund occurs in a different month than the charge.',
    sign: 'Small; ad-hoc.',
  },
  {
    label: 'Stripe Connect fees',
    description:
      'Affiliate / Connect revenue is recorded in QB via Line 4200 "Stripe Fee Income" (Allmoxy\'s markup) and Line 4600 "Affiliate Referral Income". The Stripe-side `connect` column in `customer_profiles.transactions` is currently empty because Connect fees are tracked separately in the 6 Stripe Connect Revenue sheets, not in customer Stripe accounts. The Connect line in this report is informational only — Connect-side reconciliation lives in the Connect sheets.',
    sign: 'Connect column in Stripe is $0 by design; QB has the real number.',
  },
];

// ============================================================================
// Output
// ============================================================================
const out = {
  fetched_at: new Date().toISOString(),
  comment:
    'Stripe ↔ QuickBooks per-month reconciliation. Stripe side is sum of customer_profiles.transactions (status=succeeded) by type; QB side is the corresponding pnl_by_month line items. Variance = Stripe minus QB-recognized. Tie-out status: tight (≤1% variance), acceptable (≤5%), investigate (>5%). See `reconciling_items` for canonical reasons for residual variance.',
  rows,
  reconciling_items: reconcilingItems,
  summary: {
    n_months: rows.length,
    n_tight: rows.filter((r) => r.tie_out_status === 'tight').length,
    n_acceptable: rows.filter((r) => r.tie_out_status === 'acceptable').length,
    n_investigate: rows.filter((r) => r.tie_out_status === 'investigate').length,
  },
};

const outPath = path.join(SNAP, 'stripe_qb_reconciliation.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath} — ${rows.length} months reconciled (${out.summary.n_tight} tight, ${out.summary.n_acceptable} acceptable, ${out.summary.n_investigate} to investigate).`);
