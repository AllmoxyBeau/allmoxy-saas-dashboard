#!/usr/bin/env node
/**
 * Revenue Recognition (accrual / invoice basis) — production build.
 *
 * Recognizes SUBSCRIPTION revenue by SERVICE PERIOD from Stripe invoices, in
 * parallel to the live cash/charge pipeline (which is untouched). The cash basis
 * answers "what cleared"; this answers "what we earned / were owed" — the basis
 * for a QuickBooks journal entry that reconciles Stripe to the bank.
 *
 * Policy (locked with Beau, 2026-09):
 *   1. Source of truth = Stripe INVOICES (recurring lines), by service period.
 *   2. Recognized = invoices with status paid | open | uncollectible (billed = earned).
 *      VOID / DRAFT are NOT recognized (canceled / not finalized).
 *   3. MONTH-END CUTOFF ("the reconciliation line"): an invoice counts as collected
 *      IN a service month only if paid_at <= the last day of that month. Paid later
 *      = outstanding (AR) at period end, then "collected after period" — cash that
 *      lands in the LATER month's bank deposits and clears AR (never re-recognized).
 *   4. AR = open invoices' remaining. `uncollectible` flagged (doubtful) — no auto
 *      write-off; handled case-by-case in Stripe.
 *   5. Subscription only. Services + Connect stay cash.
 *   6. Annual invoices amortized across their service period (even spread).
 *   7. ~6% of subs bill by direct charge (no Stripe invoice) → charge-basis fallback
 *      (collected == cleared; nothing outstanding since there's no invoice to owe).
 *   8. Books go-live = 2027-01. Pre-2027 months are reconciliation/reference so
 *      Beau can manually true-up 2026 in QB.
 *
 * Output: public/snapshots/revenue_recognition.json (additive; nothing else changes).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const INV = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/cache/stripe_invoices.json'), 'utf8'));
const PROF = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8')).rows;
const MRR = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_by_month.json'), 'utf8')).rows;

const BOOKS_GO_LIVE = '2027-01';
const RECONCILE_FROM = '2026-01';      // per-customer detail from here forward
const r2 = (v) => Math.round(v * 100) / 100;
const monthOf = (iso) => (iso ? String(iso).slice(0, 7) : null);
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const RECOGNIZED_STATUS = new Set(['paid', 'open', 'uncollectible']); // billed = earned; excludes void/draft
const nowMonth = new Date().toISOString().slice(0, 7);

// cus -> profile, and aid -> name
const custToProf = new Map();
for (const p of PROF) for (const cid of (p.stripe_customer_ids || [])) custToProf.set(cid, p);
const profByAid = new Map(PROF.map((p) => [p.allmoxy_customer_id, p]));
const nameOf = (aid) => profByAid.get(aid)?.customer_name || profByAid.get(aid)?.hubspot_instance_name || String(aid);

// ── per aid × service month buckets ──
const rec = new Map();        // recognized (billed = earned)
const collIn = new Map();     // collected by month-end cutoff (paid_at <= end of service month)
const collAfter = new Map();  // recognized in M, paid AFTER M (clears AR later)
const stillOpen = new Map();  // open/uncollectible today (never collected yet)
const priorArCollected = {};  // paidMonth -> cash received in paidMonth for PRIOR service months (AR clearance)
const arRows = [];            // AR aging: one row per open/uncollectible invoice
const invCustomers = new Set();
let missingPaidAt = 0;

function add(map, aid, m, v) { if (!v) return; if (!map.has(aid)) map.set(aid, {}); const o = map.get(aid); o[m] = r2((o[m] || 0) + v); }

for (const [cid, cust] of Object.entries(INV.by_customer || {})) {
  const prof = custToProf.get(cid);
  const aid = prof ? prof.allmoxy_customer_id : `stripe:${cid}`;
  for (const inv of cust.invoices || []) {
    if (!RECOGNIZED_STATUS.has(inv.status)) continue; // skip void / draft
    const paidFrac = inv.sub > 0 ? Math.min(1, (inv.paid || 0) / inv.sub) : (inv.status === 'paid' ? 1 : 0);
    // Cutoff month = month the payment cleared (from Stripe status_transitions.paid_at).
    // Fallback for legacy cache rows lacking paid_at: treat as paid in the invoice month.
    let paidMonth = null;
    if (paidFrac > 0) { paidMonth = monthOf(inv.paid_at) || monthOf(inv.d); if (!inv.paid_at) missingPaidAt++; }

    for (const l of (inv.lines || [])) {
      if (!l.rec || !l.ps || !l.pe || l.ps === l.pe) continue; // recurring subscription lines only
      const days = (new Date(l.pe) - new Date(l.ps)) / 86400000;
      const months = Math.max(1, Math.round(days / 30.44));
      // INVOICE-DATE attribution (Beau, 2026-09): a monthly line recognizes in the
      // month it was BILLED (line period start = billing date), not the service-
      // period midpoint. This ties recognized revenue to Stripe's monthly invoice
      // totals so the bank reconciliation is a direct tie-out, and it makes a
      // late payment show as AR in the billing month (Cabredo: billed 8/26, paid
      // 9/04 → Aug AR, Sept collection). Multi-month / annual lines still spread
      // evenly from their period start.
      const spread = months <= 1
        ? [[monthOf(l.ps), l.a]]
        : Array.from({ length: months }, (_, k) => [addMonths(monthOf(l.ps), k), l.a / months]);
      for (const [m, v] of spread) {
        add(rec, aid, m, v);
        const paidPart = v * paidFrac, unpaidPart = v - paidPart;
        if (paidPart > 0) {
          if (paidMonth <= m) add(collIn, aid, m, paidPart);          // cleared by month-end → in-period cash
          else {                                                       // cleared later → AR at period end, cash later
            add(collAfter, aid, m, paidPart);
            priorArCollected[paidMonth] = r2((priorArCollected[paidMonth] || 0) + paidPart);
          }
        }
        if (unpaidPart > 0) add(stillOpen, aid, m, unpaidPart);      // never collected (open/uncollectible)
      }
      invCustomers.add(aid);
    }
    // AR aging row — finalized-unpaid remaining, attributed to the invoice's service month.
    if ((inv.status === 'open' || inv.status === 'uncollectible') && (inv.remaining || 0) > 0) {
      const recLine = (inv.lines || []).find((l) => l.rec && l.ps && l.pe && l.ps !== l.pe);
      arRows.push({
        allmoxy_customer_id: typeof aid === 'number' ? aid : null,
        name: nameOf(aid),
        invoice_id: inv.id || null,
        invoice_date: inv.d,
        service_month: recLine ? monthOf(recLine.ps) : monthOf(inv.d), // billing month (invoice-date basis)
        amount: r2(inv.remaining),
        status: inv.status,
        age_days: Math.max(0, Math.round((Date.now() - new Date(inv.d)) / 86400000)),
      });
    }
  }
}

// ── charge basis (current cash) per aid × month, from profiles ──
const chgByAid = new Map();
for (const p of PROF) {
  const o = {};
  for (const [m, v] of Object.entries(p.monthly_history || {})) if ((v.subscription || 0) > 0) o[m] = v.subscription;
  chgByAid.set(p.allmoxy_customer_id, o);
}

// ── month universe (2019+, through current month) ──
const monthSet = new Set();
for (const o of rec.values()) for (const m of Object.keys(o)) if (m <= nowMonth) monthSet.add(m);
for (const o of chgByAid.values()) for (const m of Object.keys(o)) if (m <= nowMonth) monthSet.add(m);
const MONTHS = [...monthSet].filter((m) => m >= '2019-01').sort();

// ── fill-forward recognized (subscription-state view): a live sub persists at its
// last-known invoiced rate between invoices; only a true stop zeroes it. Applied to
// RECOGNIZED only — collection/outstanding stay invoice-specific (cutoff-based). ──
function fillForward(seriesMap) {
  const out = new Map();
  for (const [aid, o] of seriesMap) {
    const active = MONTHS.filter((m) => (o[m] || 0) > 0);
    if (!active.length) { out.set(aid, { ...o }); continue; }
    const first = active[0], last = active[active.length - 1];
    const f = {}; let carry = 0;
    for (const m of MONTHS) { if (m < first || m > last) { f[m] = o[m] || 0; continue; } if ((o[m] || 0) > 0) carry = o[m]; f[m] = carry; }
    out.set(aid, f);
  }
  return out;
}
const recFilled = fillForward(rec);

// ── hybrid: invoice basis where the customer bills via invoices, else charge basis ──
const allAids = new Set([...rec.keys(), ...chgByAid.keys()]);
const g = (map, aid, m) => (map.get(aid) || {})[m] || 0;
function rowFor(aid, m) {
  const hasInv = invCustomers.has(aid);
  if (hasInv) {
    const recognized = r2(g(recFilled, aid, m));
    const collected_in_period = r2(g(collIn, aid, m));
    const collected_after_period = r2(g(collAfter, aid, m));
    const still_open = r2(g(stillOpen, aid, m));
    // Outstanding at the cutoff = everything not cleared by month-end (later-collected + still open).
    const outstanding_at_period_end = r2(Math.max(0, recognized - collected_in_period));
    return { basis: 'invoice', recognized, collected_in_period, collected_after_period, still_open, outstanding_at_period_end };
  }
  const chg = r2(g(chgByAid, aid, m)); // direct-charge: we only know what cleared
  return { basis: 'charge', recognized: chg, collected_in_period: chg, collected_after_period: 0, still_open: 0, outstanding_at_period_end: 0 };
}

// ── monthly summary ──
const chgMonthTotal = (m) => (MRR.find((r) => r.month === m)?.mrr_subscription || 0);
const by_month = {};
for (const m of MONTHS) {
  let recognized = 0, collected_in_period = 0, collected_after_period = 0, still_open = 0, outstanding = 0;
  for (const aid of allAids) { const r = rowFor(aid, m); recognized += r.recognized; collected_in_period += r.collected_in_period; collected_after_period += r.collected_after_period; still_open += r.still_open; outstanding += r.outstanding_at_period_end; }
  const prior_ar_collected = r2(priorArCollected[m] || 0);
  by_month[m] = {
    recognized: r2(recognized),
    cash: r2(chgMonthTotal(m)),                         // charge basis (reference)
    collected_in_period: r2(collected_in_period),       // cleared by month-end, this month's service
    outstanding_at_period_end: r2(outstanding),         // = accrual adjustment (DR AR / CR Revenue)
    collected_after_period: r2(collected_after_period), // of this month's billings, eventually collected later
    still_open: r2(still_open),                         // of this month's billings, never collected yet
    prior_ar_collected,                                 // cash received THIS month for prior months' AR
    cash_received: r2(collected_in_period + prior_ar_collected), // reconciles to bank deposits this month
  };
}

// ── per-(customer, month) reconciliation detail, RECONCILE_FROM forward ──
const detail = [];
for (const aid of allAids) {
  if (typeof aid !== 'number') continue; // orphans surfaced separately
  for (const m of MONTHS.filter((x) => x >= RECONCILE_FROM)) {
    const r = rowFor(aid, m);
    if (r.recognized === 0 && r.collected_in_period === 0) continue;
    detail.push({ allmoxy_customer_id: aid, name: nameOf(aid), month: m, ...r });
  }
}

// orphan Stripe customers (invoices but no profile) — need roster mapping
const orphans = [];
for (const aid of rec.keys()) if (typeof aid !== 'number') {
  const o = rec.get(aid); const recent = MONTHS.filter((m) => m >= RECONCILE_FROM && (o[m] || 0) > 0);
  if (recent.length) orphans.push({ stripe_customer: String(aid).replace('stripe:', ''), months: recent, latest_mrr: r2(o[recent[recent.length - 1]]) });
}

arRows.sort((a, b) => b.amount - a.amount);
const out = {
  tab: 'revenue_recognition',
  fetchedAt: new Date().toISOString(),
  invoices_fetched_at: INV.fetchedAt || INV.fetched_at || null,
  basis: 'accrual — Stripe invoices (recurring lines) recognized in the month BILLED (invoice date; annual spread from period start); recognized = paid|open|uncollectible; MONTH-END CUTOFF on collection (paid_at <= last day of month); AR = open (uncollectible flagged); charge-fallback for direct-charge subs.',
  books_go_live: BOOKS_GO_LIVE,
  reconcile_from: RECONCILE_FROM,
  months: MONTHS,
  by_month,
  ar_aging: arRows,
  ar_total: r2(arRows.reduce((s, r) => s + r.amount, 0)),
  reconciliation_detail: detail,
  orphan_stripe_customers: orphans,
  data_quality: { invoices_missing_paid_at: missingPaidAt },
  notes: `Recognized subscription revenue on the accrual/invoice basis with a month-end collection cutoff, parallel to the cash pipeline. Books go live ${BOOKS_GO_LIVE}; ${RECONCILE_FROM}+ carries per-customer detail for manual QB true-up. ${arRows.length} open/uncollectible invoices in AR aging. ${orphans.length} orphan Stripe customers need roster mapping.`,
};
fs.writeFileSync(path.join(SNAP, 'revenue_recognition.json'), JSON.stringify(out));
console.error(`[revenue_recognition] ${MONTHS.length} months · AR $${Math.round(out.ar_total).toLocaleString()} (${arRows.length}) · ${detail.length} detail rows · ${orphans.length} orphans · ${missingPaidAt} paid invoices missing paid_at`);
