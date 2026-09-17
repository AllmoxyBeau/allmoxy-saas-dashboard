#!/usr/bin/env node
/**
 * CHURN TIMELINE — every churned customer in the order they left, with the evidence
 * needed to tell the story of why.
 *
 * Beau, 2026-09-17: "a dashboard under customer success for churns in the order they
 * churn that show a summary of the relevant data to tell the story of why they churned."
 *
 * This assembles rather than re-derives. The reason machinery already exists in three
 * layers and they disagree, so the point of this file is to RANK them and say which one
 * it used, instead of quietly picking one:
 *
 *   1. churn_research_classifications — human/LLM review of HubSpot notes, with dated
 *      quotes. Highest authority: someone actually read the account.
 *   2. churn_inferences — inferred from signals plus an evidence quote.
 *   3. customer_profiles.churn_reason — the HubSpot dropdown. Only 116 of 288 churned
 *      customers have one at all, and it is a category, not an explanation.
 *
 * The narrative signals are the other half. A reason label says "Features"; the story is
 * that they shrank for nine months, stopped ordering, and raised twelve tickets first.
 * So each row carries the run-up: MRR decline from peak, months of decline before they
 * left, order volume in the final year against the prior one, support load and payment
 * failures in the last six months.
 *
 * ORDERING is by last payment, which is the defensible churn date: it is the last month
 * they actually paid for. HubSpot's cancellation date reflects when someone closed the
 * record, which is often months later and sometimes never.
 *
 * Output: public/snapshots/churn_timeline.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const PROF = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];
const INFER = read(path.join(SNAP, 'churn_inferences.json'), { customers: [] }).customers || [];
const RESEARCH = read(path.join(SNAP, 'churn_research_classifications.json'), {}).classifications_by_customer_id || {};
const SUBPAT = read(path.join(SNAP, 'churn_subpatterns.json'), {});
const ORDERS = read(path.join(SNAP, 'orders_verified.json'), { by_customer: {} }).by_customer || {};
const TICKETS = read(path.join(SNAP, 'service_tickets.json'), { customers: [] });
const RISK = read(path.join(SNAP, 'churn_risk_matrix.json'), { customers: [] }).customers || [];

const inferBy = new Map(INFER.map((c) => [c.allmoxy_customer_id, c]));
const riskBy = new Map(RISK.map((c) => [c.allmoxy_customer_id, c]));
const subpatDefs = SUBPAT.subpattern_definitions || {};
const subpatBy = SUBPAT.customer_subpatterns || {};
const ticketBy = new Map((TICKETS.customers || []).map((c) => [c.allmoxy_customer_id, c]));

const monthOf = (iso) => (iso ? String(iso).slice(0, 7) : null);
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

const rows = [];
for (const p of PROF) {
  if (p.status !== 'churned') continue;
  if (p.excluded_from_logo_count) continue;      // duplicate/rebrand records, counted once elsewhere

  const hist = p.monthly_history || {};
  const paying = Object.keys(hist).filter((m) => (hist[m]?.subscription || 0) > 0).sort();
  if (!paying.length) continue;
  const lastMonth = paying[paying.length - 1];
  const churnMonth = addMonths(lastMonth, 1);    // first month they did not pay for

  // ── MRR run-up: what they were worth at their best, and what was left at the end ──
  const amounts = paying.map((m) => hist[m].subscription);
  const peak = Math.max(...amounts);
  const peakMonth = paying[amounts.indexOf(peak)];
  const finalMrr = hist[lastMonth].subscription;
  // How many consecutive months were they shrinking before they left? A long decline is
  // a different story from a customer who left at full price.
  let declineMonths = 0;
  for (let i = paying.length - 1; i > 0; i--) {
    const cur = hist[paying[i]].subscription, prev = hist[paying[i - 1]].subscription;
    if (cur < prev - 0.01) declineMonths++;
    else if (cur > prev + 0.01) break;
  }

  // ── reason, ranked by authority ──────────────────────────────────────────────
  // A placeholder is not a reason. "(needs manual review)" and friends are the reason
  // machinery admitting it does not know, and counting them as explained would report
  // 0 unexplained churns when 9 customers ($4,166 of MRR) have never been diagnosed.
  const isPlaceholder = (v) => !v || /needs manual review|unknown|unclassified|tbd|n\/a|^-+$/i.test(String(v).trim());
  const res = RESEARCH[String(p.allmoxy_customer_id)];
  const inf = inferBy.get(p.allmoxy_customer_id);
  const hub = (p.churn_reason || '').trim();
  let reason = null, reasonSource = null, confidence = null, evidence = null, evidenceDate = null;
  if (!isPlaceholder(res?.proposed_churn_reason)) {
    reason = res.proposed_churn_reason; reasonSource = 'research'; confidence = res.confidence || null;
    const q = (res.evidence_quotes || [])[0];
    evidence = q?.quote || null; evidenceDate = q?.date || null;
  } else if (!isPlaceholder(inf?.suggested_reason)) {
    reason = inf.suggested_reason; reasonSource = 'inferred'; confidence = inf.confidence || null;
    evidence = inf.evidence_quote || null; evidenceDate = inf.evidence_date || null;
  } else if (!isPlaceholder(hub)) {
    reason = hub; reasonSource = 'hubspot'; confidence = 'stated';
  } else {
    reason = null; reasonSource = 'none';
    // Carry whatever the machinery did say, so the row shows it was looked at and
    // abandoned rather than never touched.
    evidence = inf?.evidence_quote || null;
    evidenceDate = inf?.evidence_date || null;
  }

  const sp = subpatBy[String(p.allmoxy_customer_id)];
  const spKey = typeof sp === 'string' ? sp : sp?.subpattern;
  const spDef = spKey ? subpatDefs[spKey] : null;

  // ── did they stop USING it before they stopped paying? The most telling signal. ──
  const ov = ORDERS[String(p.allmoxy_customer_id)];
  const churnYear = Number(lastMonth.slice(0, 4));
  const finalYearOrders = ov?.years?.[String(churnYear)] || null;
  const priorYearOrders = ov?.years?.[String(churnYear - 1)] || null;
  // Two corrections, both needed or this metric produces nonsense:
  //   • The churn year is PARTIAL — someone who left in April has four months of
  //     orders against a full prior year, which reads as a collapse whatever happened.
  //     Annualise by the months they were actually live that year.
  //   • The prior year must be a FULL year of trading. Comparing against an onboarding
  //     year gives absurd growth: Big Valley showed "+55,003%" because 2024 was $4,885
  //     (they had just started) against $2.7M in 2025.
  const monthsInChurnYear = Number(lastMonth.slice(5, 7));
  const startYear = Number(String(p.effective_start_date || p.sign_up_date || '').slice(0, 4)) || null;
  const priorYearIsFull = startYear != null && startYear < churnYear - 1;
  const priorUsd = priorYearOrders?.total_usd || 0;
  const finalAnnualised = finalYearOrders ? (finalYearOrders.total_usd || 0) * 12 / Math.max(1, monthsInChurnYear) : null;
  const rawOrdersPct = finalAnnualised != null && priorYearIsFull && priorUsd >= 1000
    ? r2((finalAnnualised - priorUsd) / priorUsd)
    : null;
  // A 5x+ year-over-year swing is a data artifact, not usage. Big Valley reads
  // "+60,012%" from $4,885 in 2024 against $2.69M in 2025 — the orders source has
  // documented corruption of exactly this shape (see orders_value_overrides.json,
  // where Rehau's 2018 total was 33x its real value). Better to say nothing.
  const ordersImplausible = rawOrdersPct != null && rawOrdersPct > 5;
  const ordersDeclinePct = ordersImplausible ? null : rawOrdersPct;

  // ── support load in the final six months ──────────────────────────────────────
  const tk = ticketBy.get(p.allmoxy_customer_id);

  // ── payment trouble before the end ───────────────────────────────────────────
  const sixBefore = addMonths(lastMonth, -6);
  const failedNear = (p.failed || []).filter((f) => (monthOf(f.d || f.created) || '') >= sixBefore).length;

  const risk = riskBy.get(p.allmoxy_customer_id);

  rows.push({
    allmoxy_customer_id: p.allmoxy_customer_id,
    name: p.customer_name || p.name,
    hubspot_company_id: p.hubspot_company_id ?? null,
    churn_month: churnMonth,
    last_paid_month: lastMonth,
    last_payment_date: p.last_payment_date ?? null,
    sign_up_date: p.effective_start_date || p.sign_up_date || null,
    // TENURE AT CHURN, computed here rather than taken from profiles.
    // customer_profiles.years_with_us is (today − signup), which for a churned customer
    // keeps growing after they leave: ClosetParts reads 5.4y there but actually churned
    // after 1.5y. Using it made "Failed Implementation" show a 5-year median tenure,
    // which is impossible as a literal reason and would have sent the whole analysis
    // in the wrong direction.
    tenure_years: (() => {
      const su = p.effective_start_date || p.sign_up_date;
      const end = p.last_payment_date || (lastMonth ? `${lastMonth}-28` : null);
      if (!su || !end) return null;
      const y = (Date.parse(end) - Date.parse(su)) / (365.25 * 864e5);
      return Number.isFinite(y) && y >= 0 ? r2(y) : null;
    })(),
    tenure_years_as_of_today: p.years_with_us ?? null,
    mrr_at_churn: r2(finalMrr),
    peak_mrr: r2(peak),
    peak_month: peakMonth,
    decline_from_peak_pct: peak > 0 ? r2((finalMrr - peak) / peak) : null,
    months_declining_before_churn: declineMonths,
    months_paying: paying.length,
    lifetime_subscription: r2(p.lifetime_subscription || 0),
    reason, reason_source: reasonSource, confidence,
    evidence_quote: evidence ? String(evidence).slice(0, 600) : null,
    evidence_date: evidenceDate,
    subpattern: spKey || null,
    subpattern_label: spDef?.label || null,
    subpattern_parent: spDef?.parent || null,
    subpattern_description: spDef?.description || null,
    pay_status: p.pay_status ?? null,
    owner: p.instance_owner || null,
    segment: risk?.primary_segment ?? null,
    sub_segment: risk?.sub_segment ?? null,
    final_year_orders_usd: finalYearOrders ? r2(finalYearOrders.total_usd || 0) : null,
    final_year_orders_annualised: finalAnnualised != null ? r2(finalAnnualised) : null,
    orders_comparable: ordersDeclinePct != null,
    orders_suppressed_reason: ordersDeclinePct != null ? null
      : ordersImplausible ? 'implausible swing — likely corrupt order data'
      : !priorYearIsFull ? 'no full prior year to compare'
      : priorUsd < 1000 ? 'prior year volume too small to compare'
      : 'no order data',
    prior_year_orders_usd: priorYearOrders ? r2(priorYearOrders.total_usd || 0) : null,
    orders_decline_pct: ordersDeclinePct,
    tickets_lifetime: tk?.tickets ?? null,
    failed_payments_final_6mo: failedNear,
    hubspot_url: p.hubspot_company_id ? `https://app.hubspot.com/contacts/4910812/record/0-2/${p.hubspot_company_id}` : null,
  });
}

// Most recent first — the ones worth acting on are the ones that just happened.
rows.sort((a, b) => b.churn_month.localeCompare(a.churn_month) || b.mrr_at_churn - a.mrr_at_churn);

// ── monthly roll-up for the trend strip ──────────────────────────────────────
const byMonth = new Map();
for (const r of rows) {
  if (!byMonth.has(r.churn_month)) byMonth.set(r.churn_month, { month: r.churn_month, customers: 0, mrr_lost: 0, lifetime_lost: 0 });
  const e = byMonth.get(r.churn_month);
  e.customers++; e.mrr_lost = r2(e.mrr_lost + r.mrr_at_churn); e.lifetime_lost = r2(e.lifetime_lost + r.lifetime_subscription);
}
const monthly = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

const tally = (key) => {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] || '(unclassified)';
    if (!m.has(k)) m.set(k, { key: k, customers: 0, mrr_lost: 0 });
    const e = m.get(k); e.customers++; e.mrr_lost = r2(e.mrr_lost + r.mrr_at_churn);
  }
  return [...m.values()].sort((a, b) => b.mrr_lost - a.mrr_lost);
};

const ttmStart = addMonths(new Date().toISOString().slice(0, 7), -12);
const ttm = rows.filter((r) => r.churn_month >= ttmStart);

const out = {
  tab: 'churn_timeline',
  fetchedAt: new Date().toISOString(),
  totals: {
    churned_customers: rows.length,
    mrr_lost: r2(rows.reduce((s, r) => s + r.mrr_at_churn, 0)),
    lifetime_lost: r2(rows.reduce((s, r) => s + r.lifetime_subscription, 0)),
    with_reason: rows.filter((r) => r.reason).length,
    researched: rows.filter((r) => r.reason_source === 'research').length,
    unexplained: rows.filter((r) => !r.reason).length,
  },
  ttm: {
    window_start: ttmStart,
    churned_customers: ttm.length,
    mrr_lost: r2(ttm.reduce((s, r) => s + r.mrr_at_churn, 0)),
    avg_tenure_years: ttm.length ? r2(ttm.reduce((s, r) => s + (r.tenure_years || 0), 0) / ttm.length) : null,
    left_at_full_price: ttm.filter((r) => (r.months_declining_before_churn || 0) === 0).length,
    declined_first: ttm.filter((r) => (r.months_declining_before_churn || 0) > 0).length,
  },
  monthly,
  by_reason: tally('reason'),
  by_subpattern: tally('subpattern_label'),
  by_segment: tally('segment'),
  customers: rows,
  notes: 'Churned customers in the order they left, newest first. Churn month = the first month they did not pay for, derived from the last month with subscription revenue — a defensible date, unlike a HubSpot cancellation stamp which records when someone closed the record. Reason is ranked: researched (someone read the account) > inferred (signals + a quote) > the HubSpot dropdown. The run-up fields (decline from peak, months declining, order volume final year vs prior, support load, failed payments) are what turn a one-word reason into a story.',
};

fs.writeFileSync(path.join(SNAP, 'churn_timeline.json'), JSON.stringify(out));
console.error(`[churn_timeline] ${rows.length} churned · $${Math.round(out.totals.mrr_lost).toLocaleString()} MRR lost · ${out.totals.researched} researched, ${out.totals.unexplained} unexplained · TTM ${ttm.length} churns ($${Math.round(out.ttm.mrr_lost).toLocaleString()})`);
