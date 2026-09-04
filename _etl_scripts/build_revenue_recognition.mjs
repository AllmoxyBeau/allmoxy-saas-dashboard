#!/usr/bin/env node
/**
 * Revenue Recognition (accrual / invoice basis) — production build.
 *
 * Recognizes SUBSCRIPTION revenue by SERVICE PERIOD from Stripe invoices, in
 * parallel to the live cash/charge pipeline (which is untouched). The cash basis
 * answers "what cleared"; this answers "what we earned / were owed" — the basis
 * for a QuickBooks journal entry.
 *
 * Policy (locked with Beau, 2026-09):
 *   1. Source of truth = Stripe INVOICES (recurring lines), by service period.
 *   2. Recognized = invoices with status paid | open | uncollectible (billed = earned).
 *      VOID / DRAFT are NOT recognized (canceled / not finalized).
 *   3. AR = open invoices' remaining balance. `uncollectible` is flagged separately
 *      (doubtful) — no auto write-off; handled case-by-case in Stripe.
 *   4. Subscription only. Services + Connect stay cash.
 *   5. Annual invoices amortized across their service period (even spread).
 *   6. ~6% of subs bill by direct charge, not a Stripe recurring invoice — those
 *      customers fall back to the charge basis so recognized MRR isn't undercounted.
 *   7. Books go-live = 2027-01. Pre-2027 months are reconciliation/reference so
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
const RECONCILE_FROM = '2026-01';      // full per-customer detail from here forward
const r2 = (v) => Math.round(v * 100) / 100;
const monthOf = (iso) => (iso ? String(iso).slice(0, 7) : null);
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const midMonth = (ps, pe) => monthOf(new Date((new Date(ps).getTime() + new Date(pe).getTime()) / 2).toISOString());
const RECOGNIZED_STATUS = new Set(['paid', 'open', 'uncollectible']); // billed = earned; excludes void/draft
const nowMonth = new Date().toISOString().slice(0, 7);

// cus -> profile, and aid -> name
const custToProf = new Map();
for (const p of PROF) for (const cid of (p.stripe_customer_ids || [])) custToProf.set(cid, p);
const profByAid = new Map(PROF.map((p) => [p.allmoxy_customer_id, p]));
const nameOf = (aid) => profByAid.get(aid)?.customer_name || profByAid.get(aid)?.hubspot_instance_name || String(aid);

// ── invoice-driven recognition + collected + AR, per aid × service month ──
const recByAid = new Map();       // aid -> { month -> recognized $ (billed) }
const collByAid = new Map();      // aid -> { month -> collected $ (paid portion) }
const arRows = [];                // one row per open/uncollectible invoice (AR aging)
const invCustomers = new Set();

function add(map, aid, m, v) { if (!map.has(aid)) map.set(aid, {}); const o = map.get(aid); o[m] = r2((o[m] || 0) + v); }

for (const [cid, cust] of Object.entries(INV.by_customer || {})) {
  const prof = custToProf.get(cid);
  const aid = prof ? prof.allmoxy_customer_id : `stripe:${cid}`;
  for (const inv of cust.invoices || []) {
    if (!RECOGNIZED_STATUS.has(inv.status)) continue; // skip void / draft
    const paidFrac = inv.sub > 0 ? Math.min(1, (inv.paid || 0) / inv.sub) : (inv.status === 'paid' ? 1 : 0);
    for (const l of (inv.lines || [])) {
      if (!l.rec || !l.ps || !l.pe || l.ps === l.pe) continue; // recurring subscription lines only
      const days = (new Date(l.pe) - new Date(l.ps)) / 86400000;
      const months = Math.max(1, Math.round(days / 30.44));
      const spread = months <= 1
        ? [[midMonth(l.ps, l.pe), l.a]]
        : Array.from({ length: months }, (_, k) => [addMonths(monthOf(l.ps), k), l.a / months]);
      for (const [m, v] of spread) {
        add(recByAid, aid, m, v);               // recognized (billed = earned)
        add(collByAid, aid, m, v * paidFrac);   // collected (cash portion of this invoice)
      }
      invCustomers.add(aid);
    }
    // AR aging row — finalized-unpaid remaining, attributed to the invoice's service month.
    if ((inv.status === 'open' || inv.status === 'uncollectible') && (inv.remaining || 0) > 0) {
      const recLine = (inv.lines || []).find((l) => l.rec && l.ps && l.pe && l.ps !== l.pe);
      const svcMonth = recLine ? midMonth(recLine.ps, recLine.pe) : monthOf(inv.d);
      arRows.push({
        allmoxy_customer_id: typeof aid === 'number' ? aid : null,
        name: nameOf(aid),
        invoice_date: inv.d,
        service_month: svcMonth,
        amount: r2(inv.remaining),
        status: inv.status, // open | uncollectible
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

// ── month universe: every month present in either basis, up to the current month ──
const monthSet = new Set();
for (const o of recByAid.values()) for (const m of Object.keys(o)) if (m <= nowMonth) monthSet.add(m);
for (const o of chgByAid.values()) for (const m of Object.keys(o)) if (m <= nowMonth) monthSet.add(m);
const MONTHS = [...monthSet].filter((m) => m >= '2019-01').sort();

// ── fill-forward: a live subscription persists at its last-known invoiced rate
// between invoices (irregular cadence / midpoint drift) — a missed/late invoice
// never zeroes recognized MRR; only a true stop does (months after last invoice stay 0). ──
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
const recFilled = fillForward(recByAid);

// ── hybrid recognized series: invoice basis where the customer bills via invoices,
// else charge basis (direct-charge customers). This is THE recognized number. ──
const allAids = new Set([...recByAid.keys(), ...chgByAid.keys()]);
const recognizedByAid = new Map();
for (const aid of allAids) {
  const hasInv = invCustomers.has(aid);
  const src = hasInv ? (recFilled.get(aid) || {}) : (chgByAid.get(aid) || {});
  const o = {};
  for (const m of MONTHS) if ((src[m] || 0) > 0) o[m] = r2(src[m]);
  recognizedByAid.set(aid, o);
}

// ── monthly summary ──
const chgMonthTotal = (m) => (MRR.find((r) => r.month === m)?.mrr_subscription || 0);
const arByMonth = {}; for (const row of arRows) arByMonth[row.service_month] = r2((arByMonth[row.service_month] || 0) + row.amount);
const arOpenByMonth = {}; for (const row of arRows) if (row.status === 'open') arOpenByMonth[row.service_month] = r2((arOpenByMonth[row.service_month] || 0) + row.amount);

const by_month = {};
for (const m of MONTHS) {
  const recognized = r2([...recognizedByAid.values()].reduce((s, o) => s + (o[m] || 0), 0));
  const cash = r2(chgMonthTotal(m));
  const ar_open = r2(arOpenByMonth[m] || 0);
  const ar_uncollectible = r2((arByMonth[m] || 0) - (arOpenByMonth[m] || 0));
  by_month[m] = { recognized, cash, ar_open, ar_uncollectible, recognized_minus_cash: r2(recognized - cash) };
}

// ── per-(customer, month) reconciliation detail, RECONCILE_FROM forward ──
const reconMonths = MONTHS.filter((m) => m >= RECONCILE_FROM);
const detail = [];
for (const aid of allAids) {
  if (typeof aid !== 'number') continue; // skip unmatched stripe:cid orphans in the detail (surfaced separately)
  const rec = recognizedByAid.get(aid) || {}, coll = collByAid.get(aid) || {}, chg = chgByAid.get(aid) || {};
  for (const m of reconMonths) {
    const recognized = r2(rec[m] || 0);
    if (recognized === 0 && (chg[m] || 0) === 0) continue;
    const hasInv = invCustomers.has(aid);
    const collected = hasInv ? r2(coll[m] || 0) : r2(chg[m] || 0); // direct-charge: collected == charge
    detail.push({
      allmoxy_customer_id: aid, name: nameOf(aid), month: m,
      recognized, collected, outstanding: r2(Math.max(0, recognized - collected)),
      basis: hasInv ? 'invoice' : 'charge',
    });
  }
}

// orphan Stripe customers (invoices but no profile) — surface for mapping (like Fox Creek)
const orphans = [];
for (const aid of recByAid.keys()) if (typeof aid !== 'number') {
  const o = recByAid.get(aid); const recent = MONTHS.filter((m) => m >= RECONCILE_FROM && (o[m] || 0) > 0);
  if (recent.length) orphans.push({ stripe_customer: String(aid).replace('stripe:', ''), months: recent, latest_mrr: r2(o[recent[recent.length - 1]]) });
}

arRows.sort((a, b) => b.amount - a.amount);
const out = {
  tab: 'revenue_recognition',
  fetchedAt: new Date().toISOString(),
  invoices_fetched_at: INV.fetchedAt || INV.fetched_at || null,
  basis: 'accrual — Stripe invoices by service period (recurring lines); recognized = paid|open|uncollectible; AR = open (uncollectible flagged); charge-fallback for direct-charge subs; annual amortized.',
  books_go_live: BOOKS_GO_LIVE,
  reconcile_from: RECONCILE_FROM,
  months: MONTHS,
  by_month,
  ar_aging: arRows,
  ar_total: r2(arRows.reduce((s, r) => s + r.amount, 0)),
  reconciliation_detail: detail,
  orphan_stripe_customers: orphans,
  notes: `Recognized subscription revenue on the accrual/invoice basis, parallel to the cash pipeline. Books go live ${BOOKS_GO_LIVE}; ${RECONCILE_FROM}+ carries per-customer detail for manual QB true-up. ${arRows.length} open/uncollectible invoices in AR aging. ${orphans.length} orphan Stripe customers need roster mapping.`,
};
fs.writeFileSync(path.join(SNAP, 'revenue_recognition.json'), JSON.stringify(out));
console.error(`[revenue_recognition] ${MONTHS.length} months (${MONTHS[0]}..${MONTHS[MONTHS.length - 1]}) · AR $${Math.round(out.ar_total).toLocaleString()} (${arRows.length} invoices) · ${detail.length} detail rows · ${orphans.length} orphans`);
