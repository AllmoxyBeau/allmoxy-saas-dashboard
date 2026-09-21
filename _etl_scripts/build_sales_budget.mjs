#!/usr/bin/env node
/**
 * SALES BUDGET — what a growth target actually requires, month by month.
 *
 * Beau, 2026-09-21: "a new page for sales budget that shows a forward looking growth
 * metric. Target 20% growth for now."
 *
 * THE POINT OF THIS PAGE IS THE GROSS NUMBER, NOT THE NET ONE. A 20% target is easy to
 * state as "+$548K of ARR". It is not a sales number until you add back what the book
 * loses on its own: over the trailing year this business lost $41,628 of MRR to churn,
 * contraction, delinquency and voids while adding $39,646 — a NET of -$1,983. So the
 * plan is not "grow 20%", it is "reverse a small decline AND grow 20%", and the
 * required gross new business is roughly double the current run rate.
 *
 * Saying that plainly is the job. A budget built off net growth would understate the
 * target by the entire churn line and be missed every month for reasons nobody
 * could name.
 *
 * THREE LEVERS, priced separately, because they are different teams' work:
 *   win more   — new logos at today's ARPA
 *   expand more — upsell into the existing base
 *   lose less  — retention; modelled via churn_improvement in the config
 *
 * Targets live in sales_budget_config.json so the rate can change without code.
 *
 * Output: public/snapshots/sales_budget.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const CFG = read(path.join(ROOT, '_etl_scripts/sales_budget_config.json'), {});
const BASE = read(path.join(SNAP, 'customer_base.json'));
const WF = read(path.join(SNAP, 'mrr_waterfall.json'));
const MBM = read(path.join(SNAP, 'mrr_by_month.json'), { rows: [] }).rows || [];
const CONNECT = read(path.join(SNAP, 'connect_volume.json'));

if (!BASE?.mrr || !WF?.ttm_accrual) {
  console.error('[sales_budget] customer_base or mrr_waterfall missing — cannot build');
  process.exit(0);
}

const GROWTH = CFG.target_annual_growth ?? 0.20;
const MONTHS = CFG.plan_months ?? 12;
const CHURN_IMPROVEMENT = CFG.churn_improvement ?? 0;

const t = WF.ttm_accrual;
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

// ── trailing rates, as a share of the period's opening MRR ───────────────────
// Losses include delinquency and voids, not just confirmed churn: from a budget's
// point of view money that stops arriving has to be replaced whatever the label on it.
const openMrr = t.starting_mrr || BASE.mrr;
const lossesTtm = (t.churn_mrr || 0) + (t.contraction_mrr || 0) + (t.delinquent_mrr || 0) + (t.voided_mrr || 0);
const gainsTtm = (t.new_mrr || 0) + (t.expansion_mrr || 0) + (t.reactivated_mrr || 0);
const monthlyLossRate = openMrr > 0 ? lossesTtm / openMrr / 12 : 0;
const monthlyGainRate = openMrr > 0 ? gainsTtm / openMrr / 12 : 0;
const plannedLossRate = monthlyLossRate * (1 - CHURN_IMPROVEMENT);

// Compounding monthly rate that lands exactly on the annual target.
const monthlyGrowth = Math.pow(1 + GROWTH, 1 / MONTHS) - 1;

const startMonth = CFG.plan_start || addMonths(BASE.as_of, 1);
const arpa = BASE.arpa || (BASE.customers ? BASE.mrr / BASE.customers : 0);

// Actuals so the plan can be tracked, not just stated.
const actualByMonth = new Map((WF.monthly_accrual || []).map((r) => [r.month, r]));

const plan = [];
let mrr = BASE.mrr;
for (let i = 0; i < MONTHS; i++) {
  const month = addMonths(startMonth, i);
  const opening = mrr;
  const closing = r2(opening * (1 + monthlyGrowth));
  const netRequired = r2(closing - opening);
  // Expected losses on the opening base at the planned retention rate.
  const expectedLosses = r2(opening * plannedLossRate);
  // What sales and CS must actually produce.
  const grossRequired = r2(netRequired + expectedLosses);
  const a = actualByMonth.get(month);
  plan.push({
    month,
    opening_mrr: r2(opening),
    target_closing_mrr: closing,
    target_closing_arr: r2(closing * 12),
    net_required: netRequired,
    expected_losses: expectedLosses,
    gross_required: grossRequired,
    // If every dollar came from new logos. Expansion reduces this one-for-one.
    new_logos_required: arpa > 0 ? Math.round((grossRequired / arpa) * 10) / 10 : null,
    // Tracking: only months the waterfall has actually closed.
    actual_closing_mrr: a && !a.partial ? a.ending_mrr : null,
    actual_gross: a && !a.partial ? r2((a.new_mrr || 0) + (a.expansion_mrr || 0) + (a.reactivated_mrr || 0)) : null,
    actual_losses: a && !a.partial ? r2((a.churn_mrr || 0) + (a.contraction_mrr || 0) + (a.delinquent_mrr || 0) + (a.voided_mrr || 0)) : null,
    variance: a && !a.partial ? r2(a.ending_mrr - closing) : null,
  });
  mrr = closing;
}

// ── ALL THREE STREAMS ─────────────────────────────────────────────────────────
// Beau, 2026-09-21: "Are you considering the value of Stripe charges per customer on
// the sales budget at all?" It was not — the plan priced subscription only, which is
// 78% of the business. Services and Connect fees are another $763K a year.
//
// Connect matters disproportionately here: it is ~$475K of TTM revenue at roughly 99.6%
// gross margin (Stripe deducts about $0.01 per $8.88 of application fee), and only 58
// of 185 active customers process on it. The attach opportunity on the other 127 is
// worth more than two thirds of the entire growth target, sold into customers who
// already buy — which is a very different motion from finding six new logos a month.
//
// BASES ARE NOT MIXED SILENTLY. Subscription is the invoiced (accrual) basis; services
// and Connect are cash. They are labelled as such and reported per stream rather than
// fused into one number.
const ttmMonths = (WF.monthly_accrual || []).filter((r) => !r.partial).map((r) => r.month);
const winStart = ttmMonths[0], winEnd = ttmMonths[ttmMonths.length - 1];
const inWindow = MBM.filter((r) => r.month >= winStart && r.month <= winEnd);
const sumStream = (k) => r2(inWindow.reduce((s, r) => s + (r[k] || 0), 0));
const svcTtm = sumStream('mrr_services');
const conTtm = sumStream('mrr_connect');
const subTtmRunRate = r2(BASE.mrr * 12);   // canonical, invoiced

const streams = [
  { key: 'subscription', label: 'Subscription', basis: 'invoiced (accrual)', ttm: subTtmRunRate, monthly: r2(BASE.mrr) },
  { key: 'connect', label: 'Connect fees', basis: 'cash (application fees)', ttm: conTtm, monthly: r2(conTtm / 12) },
  { key: 'services', label: 'Services', basis: 'cash', ttm: svcTtm, monthly: r2(svcTtm / 12) },
];
const totalTtm = r2(streams.reduce((s, x) => s + x.ttm, 0));
for (const st of streams) st.share = totalTtm > 0 ? r2(st.ttm / totalTtm * 10000) / 10000 : null;

const pen = CONNECT?.penetration || null;
const connectOpportunity = pen ? {
  processing_now: pen.processing_now,
  active_customers: pen.active_customers,
  attach_rate: pen.attach_rate,
  not_processing: pen.not_processing,
  fee_potential_annual: r2(pen.attach_target_fee_potential || 0),
  current_fees_annual: r2(CONNECT?.annualized?.fee_revenue || conTtm),
  basis: pen.attach_potential_basis || null,
} : null;

const targetArr = r2(BASE.mrr * 12 * (1 + GROWTH));
const runRateGross = r2(gainsTtm / 12);
const requiredGrossAvg = r2(plan.reduce((s, p) => s + p.gross_required, 0) / plan.length);

const out = {
  tab: 'sales_budget',
  fetchedAt: new Date().toISOString(),
  config: { target_annual_growth: GROWTH, plan_months: MONTHS, churn_improvement: CHURN_IMPROVEMENT, editable_at: '_etl_scripts/sales_budget_config.json' },
  baseline: {
    as_of: BASE.as_of,
    mrr: r2(BASE.mrr),
    arr: r2(BASE.mrr * 12),
    customers: BASE.customers,
    arpa: r2(arpa),
  },
  target: {
    annual_growth: GROWTH,
    monthly_growth: r2(monthlyGrowth * 10000) / 10000,
    target_arr: targetArr,
    target_mrr: r2(BASE.mrr * (1 + GROWTH)),
    arr_gap: r2(targetArr - BASE.mrr * 12),
    end_month: plan[plan.length - 1]?.month ?? null,
  },
  trailing: {
    gains: r2(gainsTtm),
    losses: r2(lossesTtm),
    net: r2(gainsTtm - lossesTtm),
    monthly_gain_rate: r2(monthlyGainRate * 10000) / 10000,
    monthly_loss_rate: r2(monthlyLossRate * 10000) / 10000,
    grr: t.annual_grr ?? null,
    nrr: t.annual_nrr ?? null,
    new_logos_per_month: arpa > 0 ? Math.round(((t.new_mrr || 0) / 12 / arpa) * 10) / 10 : null,
  },
  // The headline honesty check: how much harder than today.
  effort: {
    run_rate_gross_per_month: runRateGross,
    required_gross_per_month: requiredGrossAvg,
    multiple: runRateGross > 0 ? Math.round((requiredGrossAvg / runRateGross) * 100) / 100 : null,
    net_today_per_month: r2((gainsTtm - lossesTtm) / 12),
  },
  streams,
  total_revenue: {
    ttm: totalTtm,
    monthly: r2(totalTtm / 12),
    target_annual: r2(totalTtm * (1 + GROWTH)),
    gap: r2(totalTtm * GROWTH),
    note: 'Subscription is the invoiced basis; services and Connect are cash. Reported per stream rather than fused, so the mixture is visible.',
  },
  connect_opportunity: connectOpportunity ? {
    ...connectOpportunity,
    // The comparison that reframes the plan: attach is sold into customers who already
    // buy, at near-100% margin, and covers most of the target on its own.
    covers_pct_of_subscription_gap: r2(connectOpportunity.fee_potential_annual / (BASE.mrr * 12 * GROWTH) * 10000) / 10000,
    covers_pct_of_total_gap: r2(connectOpportunity.fee_potential_annual / (totalTtm * GROWTH) * 10000) / 10000,
  } : null,
  plan,
  notes: 'Forward plan against a configurable growth target. The number to manage is GROSS required, not net: the book loses MRR on its own, so the target is what must be won on top of replacing those losses. Losses include delinquency and voids as well as confirmed churn — from a budget\'s point of view money that stops arriving must be replaced whatever it is called. new_logos_required assumes every dollar comes from new customers at current ARPA; expansion reduces it one for one. Actuals appear only for months the accrual waterfall has closed.',
};

fs.writeFileSync(path.join(SNAP, 'sales_budget.json'), JSON.stringify(out));
console.error(`[sales_budget] target ${Math.round(GROWTH * 100)}% → ARR $${Math.round(out.baseline.arr).toLocaleString()} to $${Math.round(targetArr).toLocaleString()} by ${out.target.end_month} · gross needed $${Math.round(requiredGrossAvg).toLocaleString()}/mo vs $${Math.round(runRateGross).toLocaleString()} run-rate (${out.effort.multiple}x) · ${plan[0]?.new_logos_required} logos/mo`);
