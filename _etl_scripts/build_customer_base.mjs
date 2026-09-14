#!/usr/bin/env node
/**
 * CANONICAL CUSTOMER BASE — the single logo count and the MRR it ties to.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard was publishing three different customer counts (184 / 191 / 195) and
 * four different MRR figures, because each page derived its own. All were defensible
 * and none agreed, which is fatal in diligence: if a QoE team cannot reproduce the
 * customer count, every ratio built on it (ARPA, CAC, LTV, cohort retention) becomes
 * unusable. Beau, 2026-09-14: "I do not want to have 3 logo counts, I want to have 1."
 *
 * THE DEFINITION (chosen for a PE-audited SaaS business)
 * -----------------------------------------------------
 *   An ACTIVE CUSTOMER is one with a live subscription generating recognized
 *   recurring revenue in the period, measured on the INVOICED (accrual) basis.
 *
 * Why the invoiced basis and not the alternatives:
 *   • REPRODUCIBLE FROM SOURCE. A third party can rebuild this number from Stripe
 *     invoices alone. `status === 'active'` cannot be rebuilt — it blends a HubSpot
 *     flag, churn heuristics and override files, so it is not auditable.
 *   • TIES TO REPORTED MRR. Logo count and MRR come from ONE population, so ARPA
 *     reconciles. Pairing a status-based count with an invoice-based MRR (what the
 *     pages did before) is the exact inconsistency diligence finds first.
 *   • IMMUNE TO PAYMENT TIMING. A failed card is a collections event, not a lost
 *     customer. Counting cash-cleared customers makes the base flicker on dunning
 *     noise — the same defect that inflated the waterfall before 2026-09-10, and the
 *     reason Lewis Cabinet Specialties briefly read as churned.
 *   • IT IS WHAT THE BUYER IS BUYING — the contracted recurring stream.
 *
 * Two adjustments, both required for the number to be honest:
 *   1. ANNUAL PAYERS ARE INCLUDED. They bill yearly so they appear in no monthly
 *      invoice series, but they are real customers and their amortized revenue is
 *      already on the books (4100). Excluding them would delete customers while
 *      keeping their revenue.
 *   2. DUPLICATES ARE EXCLUDED via `excluded_from_logo_count` (e.g. the Wildwood /
 *      Modern Fronts rebrand pair) so one business counts once.
 *
 * `status` is NOT deleted — it remains an ATTRIBUTE for CS work (at_risk drives the
 * risk matrix and collections). It simply stops being a count.
 *
 * Output: public/snapshots/customer_base.json — counts, MRR, ARPA, a full per-customer
 * membership list for traceability, and the monthly series.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const PROF = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];
const RR = read(path.join(SNAP, 'revenue_recognition.json'));
const ANNUAL = new Set((read(path.join(ROOT, 'src/data/annual_payers.json'), {}).annual_payer_ids || []).map(Number));

if (!RR?.accrual_series?.length) {
  console.error('[customer_base] revenue_recognition.json has no accrual_series — cannot build');
  process.exit(1);
}

const byAid = new Map(PROF.map((p) => [p.allmoxy_customer_id, p]));
const nameOf = (aid) => {
  const p = byAid.get(aid);
  return p?.customer_name || p?.name || p?.hubspot_instance_name || `#${aid}`;
};

// The accrual window. Before ACCRUAL_RELIABLE_FROM, Stripe invoice coverage is too thin
// (4–28% of actual revenue) for an invoiced-basis count to mean anything.
const FROM = RR.accrual_reliable_from || '2025-08';
const nowMonth = new Date().toISOString().slice(0, 7);
const months = [...new Set(RR.accrual_series.flatMap((r) => Object.keys(r.months || {})))]
  .filter((m) => m >= FROM && m < nowMonth)   // exclude the current, partial month
  .sort();

const excludedLog = [];

function membersFor(m) {
  const out = [];
  // 1. Invoiced basis — recognized recurring revenue in the month.
  for (const r of RR.accrual_series) {
    const mrr = (r.months || {})[m] || 0;
    if (mrr <= 0) continue;
    const p = byAid.get(r.allmoxy_customer_id);
    if (p?.excluded_from_logo_count) {
      if (m === months[months.length - 1]) {
        excludedLog.push({ allmoxy_customer_id: r.allmoxy_customer_id, name: nameOf(r.allmoxy_customer_id), mrr: r2(mrr), reason: 'duplicate / excluded_from_logo_count' });
      }
      continue;
    }
    out.push({ allmoxy_customer_id: r.allmoxy_customer_id, name: nameOf(r.allmoxy_customer_id), mrr: r2(mrr), source: 'invoiced', status: p?.status ?? null });
  }
  // 2. Annual payers — amortized monthly revenue from their profile history. They are
  // deliberately routed out of accrual_series (booked separately on 4100), so they must
  // be added back here or two real customers vanish while their revenue stays.
  for (const aid of ANNUAL) {
    const p = byAid.get(aid);
    if (!p || p.excluded_from_logo_count) continue;
    const mrr = p.monthly_history?.[m]?.subscription || 0;
    if (mrr <= 0) continue;
    out.push({ allmoxy_customer_id: aid, name: nameOf(aid), mrr: r2(mrr), source: 'annual_amortized', status: p.status ?? null });
  }
  // A customer must never be counted twice, whatever the sources say.
  const seen = new Set();
  return out.filter((x) => (seen.has(x.allmoxy_customer_id) ? false : seen.add(x.allmoxy_customer_id)));
}

const by_month = months.map((m) => {
  const mem = membersFor(m);
  const mrr = r2(mem.reduce((s, x) => s + x.mrr, 0));
  return { month: m, customers: mem.length, mrr, arpa: mem.length ? r2(mrr / mem.length) : 0 };
});

const asOf = months[months.length - 1];
const members = membersFor(asOf).sort((a, b) => b.mrr - a.mrr);
const mrr = r2(members.reduce((s, x) => s + x.mrr, 0));
const bySource = members.reduce((a, x) => { a[x.source] = (a[x.source] || 0) + 1; return a; }, {});
// Status breakdown — kept as an ATTRIBUTE of the counted base, never as an alternative count.
const byStatus = members.reduce((a, x) => { a[x.status || 'unknown'] = (a[x.status || 'unknown'] || 0) + 1; return a; }, {});

const out = {
  tab: 'customer_base',
  fetchedAt: new Date().toISOString(),
  as_of: asOf,
  definition: 'Active customer = a customer with a live subscription generating recognized recurring revenue in the period, on the INVOICED (accrual) basis. Includes annual payers at their amortized monthly revenue; excludes duplicate records (excluded_from_logo_count). Reproducible from Stripe invoices alone.',
  basis: 'invoiced (accrual)',
  reliable_from: FROM,
  customers: members.length,
  mrr,
  arpa: members.length ? r2(mrr / members.length) : 0,
  arr: r2(mrr * 12),
  by_source: bySource,
  by_status: byStatus,
  members,
  excluded: excludedLog,
  by_month,
  notes: 'THE canonical logo count and MRR. Every page showing "customers" or "MRR" should read this, not derive its own — three separate counts (184/191/195) and four MRR figures were being published before 2026-09-14. `status` remains an attribute (see by_status) for CS workflows; it is not a count. Annual payers appear with source=annual_amortized because they bill yearly and so are absent from the monthly invoice series.',
};

fs.writeFileSync(path.join(SNAP, 'customer_base.json'), JSON.stringify(out));
console.error(`[customer_base] ${asOf}: ${out.customers} customers · $${Math.round(out.mrr).toLocaleString()} MRR · ARPA $${Math.round(out.arpa).toLocaleString()} · ${Object.entries(bySource).map(([k, v]) => `${v} ${k}`).join(', ')}${excludedLog.length ? ` · ${excludedLog.length} excluded` : ''}`);
