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
// QuickBooks chart-of-accounts mapping + JE presentation flags (editable, no code change).
const QB = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/qb_accounts.json'), 'utf8'));
// Annual prepay customers (B&B Door, Mid Michigan): Beau books their amortization on
// 4100 Annual Deferred Monthly as a SEPARATE entry. They are routed OUT of the
// subscription line here so recognized/collected reflect monthly billing only.
const ANNUAL = new Set((JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/annual_payers.json'), 'utf8')).annual_payer_ids || []).map(Number));
// Stripe balance transactions by month (sync_stripe_balance_transactions) — the
// cash side of the JE. Optional: if not pulled yet, the JE block is skipped.
let BT = null; try { BT = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/cache/stripe_balance_transactions.json'), 'utf8')); } catch { /* not pulled yet */ }

// Accrual is the books basis from Jan 2026 (Beau, 2026-09-05 — moved up from 2027-01;
// he is truing up 2026 in QB manually). Same month the per-customer detail starts, so
// every month on the page is an operating month, not reference.
const BOOKS_GO_LIVE = '2026-01';
const RECONCILE_FROM = '2026-01';      // per-customer detail from here forward
// Allmoxy migrated to Stripe invoicing mid-2025: invoice coverage is 4–28% of actual
// revenue before Jul 2025, then 91% (Jul) → 94% (Aug) → 95%+ thereafter. The accrual
// basis is only meaningful once essentially every subscription bills via an invoice,
// so anything reading the accrual series for retention/waterfall math must start here.
// Deltas are therefore valid from 2025-09 (first month with a reliable prior month).
const ACCRUAL_RELIABLE_FROM = '2025-08';
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

// ── direct / legacy subscription charges billed OUTSIDE a Stripe invoice ──
// Sandbox instances, extra domains, AI-token top-ups and "Subscription
// xxx.allmoxy.com" legacy charges. They are real recurring revenue, but for a
// customer who otherwise bills by invoice the invoice series doesn't see them —
// which made the waterfall's accrual ending MRR sit ~$1.3–2.7K/mo BELOW the
// journal entry's recognized revenue. Folded in here so by_month, the accrual
// series, the waterfall and the JE all agree on one number.
const directByAidMonth = new Map();   // aid -> { month: $ }  (invoice-basis customers)
const directUnmapped = {};            // month -> $           (no profile; JE only)
if (BT?.months) {
  for (const [m, bm] of Object.entries(BT.months)) {
    for (const r of (bm.rows || [])) {
      if (r.cat !== 'charge' || r.tt !== 'subscription' || r.inv) continue; // invoice-backed handled by the invoice pass
      const prof = r.cust ? custToProf.get(r.cust) : null;
      const aid = prof?.allmoxy_customer_id;
      if (aid == null) { directUnmapped[m] = r2((directUnmapped[m] || 0) + r.amount); continue; }
      if (ANNUAL.has(aid)) continue;                 // annual prepay → 4100, booked separately
      if (!invCustomers.has(aid)) continue;          // charge-basis customer: already in monthly_history
      if (!directByAidMonth.has(aid)) directByAidMonth.set(aid, {});
      const o = directByAidMonth.get(aid); o[m] = r2((o[m] || 0) + r.amount);
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
  // Annual prepay → 4100 (booked separately); never in the subscription line.
  if (ANNUAL.has(aid)) {
    return { basis: 'annual', recognized: 0, collected_in_period: 0, collected_after_period: 0, still_open: 0, outstanding_at_period_end: 0, annual_deferred: r2(g(chgByAid, aid, m)) };
  }
  const hasInv = invCustomers.has(aid);
  if (hasInv) {
    // Direct/legacy charges (sandbox instances, extra domains, AI-token upgrades) ARE
    // part of MRR (Beau, 2026-09-05): they're recurring subscription revenue the
    // customer pays every month, just billed outside a Stripe invoice. Including them
    // keeps ONE number — the waterfall's accrual MRR equals the journal entry's
    // recognized revenue. They're cash-cleared on post, so they add to recognized AND
    // collected and never create a receivable.
    const direct = r2((directByAidMonth.get(aid) || {})[m] || 0);
    const recognized = r2(g(recFilled, aid, m) + direct);
    const collected_in_period = r2(g(collIn, aid, m) + direct);
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
// Cash comes from the profiles themselves (identical to mrr_by_month.mrr_subscription,
// which the monthly seam derives FROM these same profiles — verified equal to the cent).
// Using profiles removes the mrr_by_month dependency so this build can run BEFORE the
// waterfall, which now consumes the accrual series below.
const chgMonthTotal = (m) => r2(PROF.reduce((s, p) => s + (p.monthly_history?.[m]?.subscription || 0), 0));
const by_month = {};
for (const m of MONTHS) {
  let recognized = 0, collected_in_period = 0, collected_after_period = 0, still_open = 0, outstanding = 0, annual = 0;
  for (const aid of allAids) { const r = rowFor(aid, m); recognized += r.recognized; collected_in_period += r.collected_in_period; collected_after_period += r.collected_after_period; still_open += r.still_open; outstanding += r.outstanding_at_period_end; annual += r.annual_deferred || 0; }
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
    annual_deferred: r2(annual),                        // 4100 Annual Deferred Monthly — booked separately (memo)
  };
}

// ── AR write-off policy ──────────────────────────────────────────────────────
// An open invoice older than `ar_writeoff_after_days` is CLOSED / no longer
// collectible (Beau, 2026-09-05). It leaves the open-AR balance and is reported as
// written off. Revenue stays recognized — it was earned when billed; a write-off is
// a bad-debt expense, not a revenue reversal. The invoice is untouched in Stripe.
const WRITEOFF_DAYS = QB.ar_writeoff_after_days ?? null;
const addDaysMonth = (iso, days) => { const d = new Date(iso); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 7); };
for (const r of arRows) {
  r.collectible = WRITEOFF_DAYS == null ? true : r.age_days <= WRITEOFF_DAYS;
  // BOOKABLE (Beau, 2026-09-05): prior-year books were kept on a CASH basis, so those
  // invoices never created a receivable — there is nothing to write off and booking
  // one would expense against an asset that was never recorded. Only AR whose revenue
  // was recognized in the accrual period (books go-live onward) is bookable; older
  // balances are memo-only, shown so the aging is complete.
  r.bookable_writeoff = !r.collectible && r.service_month >= BOOKS_GO_LIVE;
  // Bad debt is recognized when collection became improbable — i.e. the month the
  // invoice crossed the threshold — not retroactively in the month it was billed
  // (which would restate a period already posted).
  r.writeoff_month = !r.collectible && WRITEOFF_DAYS != null ? addDaysMonth(r.invoice_date, WRITEOFF_DAYS) : null;
}
const arOpenRows = arRows.filter((r) => r.collectible);
const arWrittenOffRows = arRows.filter((r) => !r.collectible);
const arBookableRows = arRows.filter((r) => r.bookable_writeoff);
const sumAmt = (rows) => r2(rows.reduce((s, r) => s + r.amount, 0));
// Written-off totals by the month the revenue was originally recognized (for context).
const writtenOffByMonth = {};
for (const r of arWrittenOffRows) writtenOffByMonth[r.service_month] = r2((writtenOffByMonth[r.service_month] || 0) + r.amount);
// Bookable write-offs by the month they became uncollectible — these become the
// DR 4950 / CR 1200 lines on that month's entry.
const writeoffByMonth = {};
for (const r of arBookableRows) {
  const m = r.writeoff_month; if (!m || m > nowMonth) continue;
  writeoffByMonth[m] = r2((writeoffByMonth[m] || 0) + r.amount);
}


// ── QuickBooks journal entry per month ──────────────────────────────────────────
// Mirrors Beau's monthly Stripe entry line-for-line (every cash line ties to the
// balance-transactions API to the penny), then ADDS: sales tax by state
// (4050 → 2141/2142/2144), and the accrual adjustment (1200 AR ↔ 4000).
//
// Accrual math (append mode): after the entry, 4000 + 4050 must equal recognized
// subscription revenue (ex-tax) net of refunds issued this month. With 4050 on the
// invoice basis, that gives   Δ AR = R + T − cash_subscription_gross
// i.e. billed (incl. tax) − collected (incl. tax) — which naturally nets prior-
// period AR collected this month and includes the tax owed on unpaid invoices.
// R = invoice-basis recognized (ex-tax, excl. annual payers) + direct/legacy
// "Subscription …allmoxy.com" / add-on charges billed outside an invoice (real
// recurring revenue; also in the cash line, so they don't move Δ AR).
const journal_entries = {};
if (BT?.months) {
  const A = QB.accounts, TAXACCT = QB.sales_tax_payable_by_state || {};
  // Per-month net balance change (all categories incl. payouts) → mirrors Stripe's
  // Balance report frame: starting + activity − payouts = ending. Anchored on the
  // current balance captured by the sync; walks backwards month by month.
  const netChange = {}; for (const [k, v] of Object.entries(BT.months)) netChange[k] = r2((v.rows || []).reduce((s, r) => s + r.net, 0));
  const curBal = BT.current_balance?.total ?? null;
  for (const m of MONTHS.filter((x) => x >= RECONCILE_FROM)) {
    const bm = BT.months[m]; if (!bm) continue;
    const T = bm.totals;
    const rows = bm.rows || [];
    const S = (f) => r2(rows.filter(f).reduce((s, r) => s + r.amount, 0));
    const KNOWN = new Set(['charge', 'refund', 'platform_earning', 'platform_earning_refund', 'fee', 'payout']);
    const later = r2(Object.keys(netChange).filter((k) => k > m).reduce((s, k) => s + netChange[k], 0));
    const ending = curBal != null ? r2(curBal - later) : null;
    const balance_report = {
      period_tz: BT.timezone || 'America/Denver',
      starting_balance: ending != null ? r2(ending - netChange[m]) : null,
      charges_gross: S((r) => r.cat === 'charge'),
      refunds: S((r) => r.cat === 'refund'),                               // negative
      connect_earnings: S((r) => r.cat === 'platform_earning'),
      connect_refunds: S((r) => r.cat === 'platform_earning_refund'),      // negative
      stripe_fees: r2(-rows.reduce((s, r) => s + r.fee, 0) + S((r) => r.cat === 'fee')), // negative: fees on activity + separately-billed fees
      other_activity: S((r) => !KNOWN.has(r.cat)),
      net_activity: T.net_activity,
      payouts: T.payouts,
      ending_balance: ending,
      anchored: curBal != null,
      current_balance_as_of: BT.current_balance?.as_of || null,
    };
    // Direct (non-invoice) subscription charges → count in recognized for invoice-basis
    // and unmapped customers. Charge-basis customers are already in R via monthly_history.
    // Mapped direct charges are already inside by_month[m].recognized (folded into
    // rowFor), so the entry only adds back the UNMAPPED ones — charges from Stripe
    // customers with no roster record, which can't sit on a per-customer series.
    let direct = 0; const directRows = [];
    for (const r of bm.rows || []) {
      if (r.cat !== 'charge' || r.tt !== 'subscription' || r.inv) continue;
      const prof = r.cust ? custToProf.get(r.cust) : null; const aid = prof?.allmoxy_customer_id;
      if (aid != null && (ANNUAL.has(aid) || !invCustomers.has(aid))) continue;
      directRows.push({ name: prof?.customer_name || prof?.hubspot_instance_name || r.name || r.cust, amount: r.amount, desc: r.desc, mapped: aid != null });
      if (aid == null) direct = r2(direct + r.amount);
    }
    // Sales tax by state: invoice basis (billed in m) and cash basis (paid in m).
    const taxInv = {}, taxCash = {};
    for (const c of Object.values(INV.by_customer || {})) for (const i of (c.invoices || [])) {
      if (!RECOGNIZED_STATUS.has(i.status)) continue;
      const billed = monthOf(i.d) === m, paid = !!i.paid_at && monthOf(i.paid_at) === m;
      for (const t of (i.taxes || [])) { const s = t.state || '??'; if (billed) taxInv[s] = r2((taxInv[s] || 0) + t.a); if (paid) taxCash[s] = r2((taxCash[s] || 0) + t.a); }
    }
    const taxUsed = QB.sales_tax_basis === 'cash' ? taxCash : taxInv;
    const taxTotal = r2(Object.values(taxUsed).reduce((s, v) => s + v, 0));
    const R = r2((by_month[m]?.recognized || 0) + direct);
    const adj = r2(R + taxTotal - T.subscription_gross);
    const L = [];
    const line = (acct, debit, credit, description, group) => L.push({ account: `${acct.number} ${acct.name}`, debit: debit ? r2(debit) : null, credit: credit ? r2(credit) : null, description, group });
    const restate = QB.accrual_presentation === 'restate';
    // — cash lines (Beau's entry) —
    line(A.stripe_fee_income, T.payouts, 0, 'Stripe payouts to bank (gross deposits)', 'cash');
    if (T.stripe_balance_change >= 0) line(A.stripe_clearing, 0, T.stripe_balance_change, 'Stripe balance change (payouts exceeded activity)', 'cash');
    else line(A.stripe_clearing, -T.stripe_balance_change, 0, 'Stripe balance change (activity exceeded payouts)', 'cash');
    line(A.services, 0, T.services_gross, 'Services charges', 'cash');
    line(A.subscription, 0, restate ? r2(R + taxTotal) : T.subscription_gross, restate ? 'Subscription revenue recognized (invoice basis, incl. sales tax)' : 'Subscription charges (gross, incl. sales tax)', 'cash');
    if (T.services_refunds) line(A.services, T.services_refunds, 0, 'Services refunds', 'cash');
    if (T.subscription_refunds) line(A.subscription, T.subscription_refunds, 0, 'Subscription refunds', 'cash');
    if (T.connect_refunds) line(A.stripe_fee_income, T.connect_refunds, 0, 'Connect platform-fee refunds', 'cash');
    if (T.untagged_gross) line(A.misc_income, 0, T.untagged_gross, 'Untagged charges — classify', 'cash');
    if (T.other_refunds) line(A.misc_income, T.other_refunds, 0, 'Untagged refunds — classify', 'cash');
    line(A.cc_fees, T.charge_fees, 0, 'Stripe processing fees on charges', 'cash');
    line(A.cc_fees, T.other_fees, 0, 'Other Stripe fees (billing / Connect)', 'cash');
    line(A.stripe_fee_income, 0, T.connect_gross, 'Stripe Connect platform earnings', 'cash');
    // — sales tax by state —
    for (const [st, amt] of Object.entries(taxUsed).sort()) {
      if (!amt) continue; const pay = TAXACCT[st]; const d = pay?.description || `${st} Sales Tax`;
      line(A.subscription_tax, amt, 0, d, 'tax');
      line(pay || { number: '????', name: `Sales Tax Payable:${st} — MAP ACCOUNT` }, 0, amt, d, 'tax');
    }
    // — bad debt: AR that crossed the collectibility threshold this month —
    // Only balances whose revenue was recognized on the accrual books (go-live onward)
    // are booked: prior years ran on a cash basis, so no receivable was ever recorded
    // and there is nothing to relieve.
    const writeoff = r2(writeoffByMonth[m] || 0);
    if (writeoff > 0) {
      line(A.uncollectible, writeoff, 0, `Bad debt — AR past ${WRITEOFF_DAYS} days, no longer collectible`, 'writeoff');
      line(A.accounts_receivable, 0, writeoff, 'Relieve uncollectible receivables', 'writeoff');
    }
    // — accrual adjustment —
    if (restate) {
      if (adj > 0) line(A.accounts_receivable, adj, 0, 'Accrual: subscription billed not yet collected (Δ AR incl. tax on unpaid)', 'accrual');
      else if (adj < 0) line(A.accounts_receivable, 0, -adj, 'Accrual: prior-period AR collected this month', 'accrual');
    } else if (adj > 0) {
      line(A.accounts_receivable, adj, 0, 'Accrual: subscription billed not yet collected (Δ AR incl. tax on unpaid)', 'accrual');
      line(A.subscription, 0, adj, 'Accrual: recognize billed subscription revenue', 'accrual');
    } else if (adj < 0) {
      line(A.subscription, -adj, 0, 'Accrual: reverse cash-basis revenue for prior-period AR collected', 'accrual');
      line(A.accounts_receivable, 0, -adj, 'Accrual: relieve AR collected this month', 'accrual');
    }
    // ── AR detail: itemize Δ AR so the 1200 line is auditable ──
    // Δ AR = [invoices BILLED this month, unpaid at month-end (ex-tax + their tax)]
    //      − [invoices billed in PRIOR months, paid this month (incl. tax)]  + residual.
    // Residual absorbs fill-forward/orphan/partial-payment effects so the bridge always
    // ties to the posted line.
    const newArRows = [], priorArRows = [];
    for (const [cid, cust] of Object.entries(INV.by_customer || {})) {
      const prof = custToProf.get(cid); const aid = prof ? prof.allmoxy_customer_id : null;
      if (aid != null && ANNUAL.has(aid)) continue;
      const name = aid != null ? nameOf(aid) : cid;
      for (const i of (cust.invoices || [])) {
        if (!RECOGNIZED_STATUS.has(i.status) || !(i.sub > 0)) continue;
        const billedM = monthOf(i.d), paidM = i.paid_at ? monthOf(i.paid_at) : null;
        const paidByCutoff = paidM != null && paidM <= m;
        const rowBase = { allmoxy_customer_id: aid, name, invoice_id: i.id || null, invoice_date: i.d, amount: r2(i.sub), tax: r2(i.tax || 0), status: i.status, paid_at: i.paid_at || null };
        if (billedM === m && !paidByCutoff) newArRows.push({ ...rowBase, resolution: i.paid_at ? `paid ${i.paid_at}` : i.status === 'uncollectible' ? 'uncollectible' : 'still open' });
        if (billedM < m && paidM === m) priorArRows.push(rowBase);
      }
    }
    newArRows.sort((a, b) => (b.amount + b.tax) - (a.amount + a.tax)); priorArRows.sort((a, b) => (b.amount + b.tax) - (a.amount + a.tax));
    const newArExTax = r2(newArRows.reduce((s, r) => s + r.amount, 0)), newArTax = r2(newArRows.reduce((s, r) => s + r.tax, 0));
    const priorArCollectedInclTax = r2(priorArRows.reduce((s, r) => s + r.amount + r.tax, 0));
    const ar_detail = { new_ar_rows: newArRows, prior_ar_rows: priorArRows, new_ar_ex_tax: newArExTax, new_ar_tax: newArTax, prior_ar_collected: priorArCollectedInclTax, residual: r2(adj - (newArExTax + newArTax - priorArCollectedInclTax)), total: adj };

    const debits = r2(L.reduce((s, l) => s + (l.debit || 0), 0)), credits = r2(L.reduce((s, l) => s + (l.credit || 0), 0));
    journal_entries[m] = {
      ar_detail,
      lines: L, debits, credits, balanced: Math.abs(debits - credits) < 0.01,
      balance_report,
      inputs: {
        payouts: T.payouts, stripe_balance_change: T.stripe_balance_change,
        subscription_gross: T.subscription_gross, services_gross: T.services_gross, connect_gross: T.connect_gross,
        subscription_refunds: T.subscription_refunds, services_refunds: T.services_refunds, connect_refunds: T.connect_refunds,
        charge_fees: T.charge_fees, other_fees: T.other_fees, untagged_gross: T.untagged_gross,
        recognized_ex_tax: R, recognized_invoice_basis: by_month[m]?.recognized || 0, direct_subscription_charges: direct, direct_rows: directRows,
        tax_by_state_invoice: taxInv, tax_by_state_cash: taxCash, tax_basis_used: QB.sales_tax_basis, tax_total_used: taxTotal,
        accrual_adjustment: adj, annual_deferred_memo: by_month[m]?.annual_deferred || 0, balance_txn_rows: T.row_count,
      },
      memo: [
        `4100 Annual Deferred Monthly $${(by_month[m]?.annual_deferred || 0).toFixed(2)} (B&B Door, Mid Michigan) is booked separately — not part of this entry.`,
        `Sales tax shown on the ${QB.sales_tax_basis} basis; the other basis for reference: $${r2(Object.values(QB.sales_tax_basis === 'cash' ? taxInv : taxCash).reduce((s, v) => s + v, 0)).toFixed(2)}.`,
      ],
    };
  }
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

// ── per-customer accrual MRR series (for the accrual waterfall + retention metrics) ──
// Only months >= ACCRUAL_RELIABLE_FROM are emitted: before that the invoice data is too
// sparse and a customer who began invoicing in 2025 would read as $0 in 2021, producing
// fake churn. Annual payers are excluded (they're on 4100, booked separately).
const accrual_series = [];
for (const aid of allAids) {
  if (typeof aid !== 'number' || ANNUAL.has(aid)) continue;
  const months = {};
  for (const m of MONTHS) { if (m < ACCRUAL_RELIABLE_FROM) continue; const v = rowFor(aid, m).recognized; if (v > 0) months[m] = v; }
  if (Object.keys(months).length) accrual_series.push({ allmoxy_customer_id: aid, months });
}
// Coverage ratio per month — how much of cash MRR the accrual basis accounts for.
// Surfaced so any page using the accrual basis can prove the window is trustworthy.
const accrual_coverage = {};
for (const m of MONTHS.filter((x) => x >= '2025-01')) { const c = chgMonthTotal(m); accrual_coverage[m] = c > 0 ? Math.round((by_month[m].recognized / c) * 1000) / 10 : null; }

arRows.sort((a, b) => b.amount - a.amount);
const out = {
  ar_policy: {
    writeoff_after_days: WRITEOFF_DAYS,
    open_total: sumAmt(arOpenRows),
    open_count: arOpenRows.length,
    written_off_total: sumAmt(arWrittenOffRows),
    written_off_count: arWrittenOffRows.length,
    written_off_by_service_month: writtenOffByMonth,
    bookable_total: sumAmt(arBookableRows),
    bookable_count: arBookableRows.length,
    pre_accrual_total: r2(sumAmt(arWrittenOffRows) - sumAmt(arBookableRows)),
    pre_accrual_count: arWrittenOffRows.length - arBookableRows.length,
    writeoff_by_month: writeoffByMonth,
    books_go_live: BOOKS_GO_LIVE,
    note: WRITEOFF_DAYS == null
      ? 'No automatic write-off — every open invoice counts as collectible AR.'
      : `Open invoices older than ${WRITEOFF_DAYS} days are treated as closed / not collectible and excluded from the AR balance. They are NOT modified in Stripe — void or mark them uncollectible there to make it official. Revenue stays recognized; the write-off is a bad-debt expense.`,
  },
  accrual_reliable_from: ACCRUAL_RELIABLE_FROM,
  accrual_series,
  accrual_coverage,
  tab: 'revenue_recognition',
  fetchedAt: new Date().toISOString(),
  invoices_fetched_at: INV.fetchedAt || INV.fetched_at || null,
  basis: 'accrual — Stripe invoices (recurring lines) recognized in the month BILLED (invoice date; annual spread from period start); recognized = paid|open|uncollectible; MONTH-END CUTOFF on collection (paid_at <= last day of month); AR = open (uncollectible flagged); charge-fallback for direct-charge subs.',
  books_go_live: BOOKS_GO_LIVE,
  reconcile_from: RECONCILE_FROM,
  months: MONTHS,
  by_month,
  ar_aging: arRows,
  ar_total: sumAmt(arOpenRows),            // collectible only — see ar_policy
  ar_total_including_written_off: sumAmt(arRows),
  reconciliation_detail: detail,
  orphan_stripe_customers: orphans,
  journal_entries,
  qb_accounts: QB,
  balance_transactions_fetched_at: BT?.fetchedAt || null,
  data_quality: { invoices_missing_paid_at: missingPaidAt },
  notes: `Recognized subscription revenue on the accrual/invoice basis with a month-end collection cutoff, parallel to the cash pipeline. Books go live ${BOOKS_GO_LIVE}; ${RECONCILE_FROM}+ carries per-customer detail for manual QB true-up. ${arRows.length} open/uncollectible invoices in AR aging. ${orphans.length} orphan Stripe customers need roster mapping.`,
};
fs.writeFileSync(path.join(SNAP, 'revenue_recognition.json'), JSON.stringify(out));
console.error(`[revenue_recognition] ${MONTHS.length} months · AR $${Math.round(out.ar_total).toLocaleString()} (${arRows.length}) · ${detail.length} detail rows · ${orphans.length} orphans · ${missingPaidAt} paid invoices missing paid_at`);
