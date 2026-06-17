#!/usr/bin/env node
/**
 * Annual Amortization Evidence builder (QoE-4).
 *
 * Consolidates everything a QoE reviewer needs to validate annual-payer
 * amortization into one snapshot:
 *
 *   - WHO is amortized (from src/data/annual_payers.json)
 *   - HOW the default window is shaped, and any per-payment override
 *     (from _etl_scripts/annual_amortization_overrides.json)
 *   - WHAT the actual amortization landed at — every annualized monthly
 *     entry on the customer's monthly_history is enumerated with its
 *     $-per-month value (from public/snapshots/customer_profiles.json)
 *   - WHY we believe the lump-sum is real — source payment trace:
 *         Stripe transaction (id, amount, date) OR
 *         synthetic transaction (check #, deposit date, ACH ref) OR
 *         contract clause + invoice link
 *   - QB treatment — how QuickBooks defers and recognizes the same dollars
 *     (4100 Annual Deferred Monthly → 4000 Subscription Revenue)
 *   - VERIFIED-BY trail (who signed off, when)
 *
 * Output: public/snapshots/annual_amortization_evidence.json — drilldown
 * surface for the dashboard's Adjustments Register page.
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

const annualPayers = readJson(path.join(ROOT, 'src/data/annual_payers.json'));
const amortOverrides = readJson(path.join(ROOT, '_etl_scripts/annual_amortization_overrides.json'));
const syntheticTxns = readJson(path.join(ROOT, '_etl_scripts/synthetic_transactions.json'));
const profiles = readJson(path.join(SNAP, 'customer_profiles.json'));

const profileById = new Map();
for (const r of profiles?.rows || []) profileById.set(r.allmoxy_customer_id, r);

// Per-customer overrides, keyed by allmoxy_customer_id
const overridesByCustomer = new Map();
for (const o of amortOverrides?.overrides || []) {
  if (!overridesByCustomer.has(o.allmoxy_customer_id)) overridesByCustomer.set(o.allmoxy_customer_id, []);
  overridesByCustomer.get(o.allmoxy_customer_id).push(o);
}

// Per-customer synthetic transactions (off-Stripe payments)
const syntheticByCustomer = new Map();
for (const t of syntheticTxns?.transactions || []) {
  if (!syntheticByCustomer.has(t.allmoxy_customer_id)) syntheticByCustomer.set(t.allmoxy_customer_id, []);
  syntheticByCustomer.get(t.allmoxy_customer_id).push(t);
}

const entries = [];

for (const id of annualPayers?.annual_payer_ids || []) {
  const profile = profileById.get(id);
  const details = annualPayers.payer_details?.[String(id)] ?? {};
  const overrides = overridesByCustomer.get(id) || [];
  const synthTxns = syntheticByCustomer.get(id) || [];

  // Annualized monthly entries from the profile — gives the actual realized
  // amortization landing, regardless of whether default 12-mo or override
  // logic produced it.
  const annualizedMonths = [];
  let totalAmortizedDollars = 0;
  if (profile?.monthly_history) {
    for (const [m, cell] of Object.entries(profile.monthly_history)) {
      if (!cell?.annualized) continue;
      annualizedMonths.push({ month: m, subscription: round2(cell.subscription || 0) });
      totalAmortizedDollars += cell.subscription || 0;
    }
  }
  annualizedMonths.sort((a, b) => a.month.localeCompare(b.month));

  // Source payments: Stripe subscription transactions with amount > $3K
  // (the amortization threshold), plus any synthetic transactions on file.
  const stripeAnnualPayments = [];
  for (const t of profile?.transactions || []) {
    if (t.type !== 'subscription') continue;
    if (t.status !== 'succeeded') continue;
    if ((t.amount || 0) < 3000) continue;
    stripeAnnualPayments.push({
      created: t.created,
      amount: round2(t.amount),
      stripe_id: t.id ?? null,
      description: (t.description || '').slice(0, 120),
    });
  }
  stripeAnnualPayments.sort((a, b) => (a.created || '').localeCompare(b.created || ''));

  entries.push({
    allmoxy_customer_id: id,
    customer_name: profile?.name ?? details.customer_name ?? `(allmoxy_customer_id ${id})`,
    status: profile?.status ?? null,
    current_subscription_mrr: profile?.current_subscription_mrr ?? null,
    hubspot_company_id: profile?.hubspot_company_id ?? null,

    // Customer-level metadata (from payer_details)
    billing_cadence: details.billing_cadence ?? 'annual',
    typical_annual_amount: details.typical_annual_amount ?? null,
    typical_months: details.typical_months ?? 12,
    default_amortization_window: details.default_amortization_window ?? '12 months forward from payment date (default)',
    contract_signed_date: details.contract_signed_date ?? null,
    contract_link: details.contract_link ?? null,
    evidence_files: details.evidence_files ?? [],
    qb_treatment: details.qb_treatment ?? null,
    notes: details.notes ?? null,

    // Realized amortization
    annualized_months: annualizedMonths,
    annualized_month_count: annualizedMonths.length,
    total_amortized_dollars: round2(totalAmortizedDollars),

    // Source payments
    stripe_payments: stripeAnnualPayments,
    stripe_payment_count: stripeAnnualPayments.length,
    synthetic_payments: synthTxns.map((t) => ({
      created: t.created,
      amount: round2(t.amount),
      payment_method: t.payment_method,
      evidence: t.evidence ?? null,
      description: t.description,
      reason: t.reason,
      added_by: t.added_by ?? null,
    })),
    synthetic_payment_count: synthTxns.length,

    // Per-payment overrides (custom amortization windows)
    overrides: overrides.map((o) => ({
      origin_month: o.origin_month,
      start_month: o.start_month,
      months: o.months,
      amount_match_min: o.amount_match_min,
      amount_match_max: o.amount_match_max,
      monthly_amortized: round2(((o.amount_match_min + o.amount_match_max) / 2) / o.months),
      reason: o.reason,
    })),
    override_count: overrides.length,

    // Sign-off
    verified_by: details.verified_by ?? null,
    verified_at: details.verified_at ?? null,
  });
}

entries.sort((a, b) => (b.total_amortized_dollars || 0) - (a.total_amortized_dollars || 0));

const out = {
  fetched_at: new Date().toISOString(),
  comment:
    'Annual-amortization evidence registry (QoE-4). Per annual-payer, captures: source payment trace (Stripe / check / wire), the actual realized amortization on monthly_history, any custom override window, QB deferred-revenue treatment, and sign-off. A QoE reviewer should be able to answer "show me every annualized dollar in the MRR series and prove it" from this file alone. Built by _etl_scripts/build_annual_amortization_evidence.mjs.',
  summary: {
    annual_payer_count: entries.length,
    total_amortized_dollars: round2(entries.reduce((s, e) => s + (e.total_amortized_dollars || 0), 0)),
    total_annualized_months: entries.reduce((s, e) => s + (e.annualized_month_count || 0), 0),
    payers_with_overrides: entries.filter((e) => e.override_count > 0).length,
    payers_with_synthetic_payments: entries.filter((e) => e.synthetic_payment_count > 0).length,
    payers_with_contract_link: entries.filter((e) => e.contract_link).length,
    payers_verified: entries.filter((e) => e.verified_by).length,
  },
  entries,
};

const outPath = path.join(SNAP, 'annual_amortization_evidence.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  ${entries.length} annual payer(s) · $${out.summary.total_amortized_dollars.toLocaleString()} amortized · ${out.summary.total_annualized_months} annualized month-cells`);
console.log(`  ${out.summary.payers_with_overrides} with custom amortization windows · ${out.summary.payers_with_synthetic_payments} with off-Stripe payments`);
console.log(`  ${out.summary.payers_verified} verified · ${out.summary.payers_with_contract_link} with contract on file`);
