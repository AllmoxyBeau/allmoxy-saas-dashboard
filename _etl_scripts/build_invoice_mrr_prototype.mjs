#!/usr/bin/env node
/**
 * PROTOTYPE (read-only): invoice-driven / accrual MRR, in parallel to the live
 * charge-driven pipeline. Nothing here is wired into refresh_all or the UI yet.
 *
 * Principle under test: MRR = billed recurring value by SERVICE PERIOD, regardless
 * of when (or whether) the card cleared. A failed capture is an `open` invoice =
 * AR, not contraction/churn.
 *
 * Attribution: each recurring invoice line's amount is placed in the month its
 * service period covers (midpoint for a ~monthly line; evenly spread for multi-
 * month / annual lines — which also amortizes annual payers naturally).
 *
 * Outputs a console comparison vs the current charge-based numbers + writes
 * public/snapshots/invoice_mrr_prototype.json for a future prototype view.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const INV = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/cache/stripe_invoices.json'), 'utf8'));
const PROF = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8')).rows;
const MRR = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_by_month.json'), 'utf8')).rows;

const r2 = (v) => Math.round(v * 100) / 100;
const monthOf = (iso) => (iso ? iso.slice(0, 7) : null);
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const midMonth = (ps, pe) => monthOf(new Date((new Date(ps).getTime() + new Date(pe).getTime()) / 2).toISOString());

// cus -> profile
const custToProf = new Map();
for (const p of PROF) for (const cid of (p.stripe_customer_ids || [])) custToProf.set(cid, p);

// --- invoice-driven recurring MRR by customer × month, + AR ---
const invMrr = new Map();   // aid -> { month -> mrr }
const arByMonth = {};        // month -> open AR
let arTotal = 0;
const invCustomers = new Set();

function addMrr(aid, m, v) {
  if (!invMrr.has(aid)) invMrr.set(aid, {});
  const o = invMrr.get(aid); o[m] = r2((o[m] || 0) + v);
}

for (const [cid, cust] of Object.entries(INV.by_customer)) {
  const prof = custToProf.get(cid);
  const aid = prof ? prof.allmoxy_customer_id : `stripe:${cid}`;
  for (const inv of cust.invoices) {
    for (const l of inv.lines) {
      if (!l.rec || !l.ps || !l.pe || l.ps === l.pe) continue; // recurring lines only
      const days = (new Date(l.pe) - new Date(l.ps)) / 86400000;
      const months = Math.max(1, Math.round(days / 30.44));
      if (months <= 1) {
        addMrr(aid, midMonth(l.ps, l.pe), l.a);
      } else {
        const per = l.a / months;
        for (let k = 0; k < months; k++) addMrr(aid, addMonths(monthOf(l.ps), k), per);
      }
      invCustomers.add(aid);
    }
    // AR: finalized-unpaid remaining, attributed to the invoice's service month.
    if ((inv.status === 'open' || inv.status === 'uncollectible') && inv.remaining > 0) {
      const m = inv.lines.find((l) => l.rec && l.ps && l.pe && l.ps !== l.pe)
        ? midMonth(inv.lines.find((l) => l.rec && l.ps !== l.pe).ps, inv.lines.find((l) => l.rec && l.ps !== l.pe).pe)
        : monthOf(inv.d);
      arByMonth[m] = r2((arByMonth[m] || 0) + inv.remaining);
      arTotal = r2(arTotal + inv.remaining);
    }
  }
}

// --- charge-based MRR by customer × month (current basis) from profiles ---
const chgMrr = new Map(); // aid -> { month -> sub }
for (const p of PROF) {
  const o = {};
  for (const [m, v] of Object.entries(p.monthly_history || {})) if (v.subscription > 0) o[m] = v.subscription;
  chgMrr.set(p.allmoxy_customer_id, o);
}
const profByAid = new Map(PROF.map((p) => [p.allmoxy_customer_id, p]));

// --- comparison for 2026 months ---
const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const sumInv = (m) => [...invMrr.values()].reduce((s, o) => s + (o[m] || 0), 0);
const chgMonthTotal = (m) => (MRR.find((r) => r.month === m)?.mrr_subscription || 0);

console.log('\n=== INVOICE (accrual, service-period) vs CHARGE (captured) — subscription MRR ===');
console.log('month      charge-MRR    invoice-MRR    Δ(inv-chg)');
for (const m of MONTHS) {
  const c = chgMonthTotal(m), i = sumInv(m);
  console.log(`${m}   $${Math.round(c).toLocaleString().padStart(9)}   $${Math.round(i).toLocaleString().padStart(9)}   ${i - c >= 0 ? '+' : ''}${Math.round(i - c).toLocaleString()}`);
}

// --- coverage: customers with June charge-MRR but NO invoice-MRR (fallback set) ---
const JUNE = '2026-06';
const chargeOnly = [];
let chargeOnlyTotal = 0;
for (const [aid, o] of chgMrr) {
  const cJun = o[JUNE] || 0;
  const iJun = (invMrr.get(aid) || {})[JUNE] || 0;
  if (cJun > 0 && iJun === 0) { chargeOnly.push({ aid, name: profByAid.get(aid)?.name, mrr: cJun }); chargeOnlyTotal += cJun; }
}
chargeOnly.sort((a, b) => b.mrr - a.mrr);
console.log(`\n=== COVERAGE (June): customers with charge-MRR but NO recurring invoices (need charge fallback) ===`);
console.log(`count ${chargeOnly.length} · total $${Math.round(chargeOnlyTotal).toLocaleString()} of $${Math.round(chgMonthTotal(JUNE)).toLocaleString()} (${(100 * chargeOnlyTotal / chgMonthTotal(JUNE)).toFixed(1)}% charge-only)`);
chargeOnly.slice(0, 12).forEach((c) => console.log(`   ${c.name} #${c.aid}: $${Math.round(c.mrr)}`));

// --- phantom cases: charge-MRR much LOWER than invoice-MRR in June (card-failure artifacts) ---
console.log(`\n=== PHANTOM contraction/churn (June): invoice-MRR > charge-MRR by >$100 (card-failure / timing) ===`);
const phantom = [];
for (const [aid, o] of invMrr) {
  const iJun = o[JUNE] || 0, cJun = (chgMrr.get(aid) || {})[JUNE] || 0;
  if (iJun - cJun > 100) phantom.push({ name: profByAid.get(aid)?.name || `#${aid}`, aid, inv: iJun, chg: cJun, status: profByAid.get(aid)?.pay_status });
}
phantom.sort((a, b) => (b.inv - b.chg) - (a.inv - a.chg));
console.log(`count ${phantom.length} · overstated churn/contraction $${Math.round(phantom.reduce((s, p) => s + (p.inv - p.chg), 0)).toLocaleString()}`);
phantom.slice(0, 12).forEach((p) => console.log(`   ${p.name}: invoice $${Math.round(p.inv)} vs charge $${Math.round(p.chg)} (+$${Math.round(p.inv - p.chg)}) [${p.status || '—'}]`));

// --- AR ---
console.log(`\n=== AR (open/uncollectible invoices) ===`);
console.log(`total $${Math.round(arTotal).toLocaleString()} · by recent month: ${MONTHS.map((m) => `${m.slice(5)}:$${Math.round(arByMonth[m] || 0).toLocaleString()}`).join('  ')}`);

// --- DOT spotlight ---
const dot = PROF.find((p) => /^Dot Custom/i.test(p.name));
if (dot) {
  const io = invMrr.get(dot.allmoxy_customer_id) || {}, co = chgMrr.get(dot.allmoxy_customer_id) || {};
  console.log(`\n=== DOT spotlight ===`);
  console.log('        ' + MONTHS.map((m) => m.slice(5)).join('     '));
  console.log('charge  ' + MONTHS.map((m) => '$' + Math.round(co[m] || 0)).join('   '));
  console.log('invoice ' + MONTHS.map((m) => '$' + Math.round(io[m] || 0)).join('   '));
}

// --- Forward-fill: a live subscription persists at its last-known recurring rate
// between invoices. Fill interior $0 gaps (irregular invoice cadence / midpoint
// drift) with the carried-forward value, from each customer's first active month
// through their LAST active month. Months after the last invoice stay $0 (real
// lapse/churn). This is the "subscription state" view — a missed/late invoice or
// a card failure never zeroes MRR; only a true stop does. ---
const ALLMONTHS = ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
function fillForward(seriesMap) {
  const out = new Map();
  for (const [aid, o] of seriesMap) {
    const active = ALLMONTHS.filter((m) => (o[m] || 0) > 0);
    if (!active.length) { out.set(aid, { ...o }); continue; }
    const first = active[0], last = active[active.length - 1];
    const f = {}; let carry = 0;
    for (const m of ALLMONTHS) {
      if (m < first || m > last) { f[m] = o[m] || 0; continue; }
      if ((o[m] || 0) > 0) carry = o[m];
      f[m] = carry; // interior gap → carry last-known rate
    }
    out.set(aid, f);
  }
  return out;
}
const invMrrFilled = fillForward(invMrr);

// --- HYBRID series: invoice-MRR where the customer has invoices, else charge-MRR
// (direct-charge customers like Midwest). This is the proposed production basis. ---
const allAids = new Set([...invMrr.keys(), ...chgMrr.keys()]);
const hybrid = new Map();
for (const aid of allAids) {
  const io = invMrrFilled.get(aid) || {}, co = chgMrr.get(aid) || {};
  const hasInv = invCustomers.has(aid);
  const o = {};
  for (const m of MONTHS) o[m] = hasInv ? (io[m] || 0) : (co[m] || 0);
  hybrid.set(aid, o);
}

// Monthly GRR/NRR for a given per-customer series map.
function retention(seriesMap, prev, cur) {
  let start = 0, churn = 0, contraction = 0, expansion = 0;
  for (const o of seriesMap.values()) {
    const p = o[prev] || 0, n = o[cur] || 0;
    start += p;
    if (p > 0 && n === 0) churn += p;
    else if (n < p) contraction += p - n;
    else if (n > p) expansion += n - p;
  }
  return { grr: start > 0 ? (start - churn - contraction) / start : null, nrr: start > 0 ? (start - churn - contraction + expansion) / start : null, churn, contraction, expansion };
}

console.log('\n=== MONTHLY GRR / NRR — charge basis (current) vs hybrid invoice basis ===');
console.log('month     GRR chg→inv        NRR chg→inv        churn chg→inv');
for (let k = 1; k < MONTHS.length; k++) {
  const prev = MONTHS[k - 1], cur = MONTHS[k];
  const c = retention(chgMrr, prev, cur), h = retention(hybrid, prev, cur);
  const pc = (v) => v == null ? '—' : (v * 100).toFixed(1) + '%';
  console.log(`${cur}  ${pc(c.grr).padStart(6)} → ${pc(h.grr).padStart(6)}    ${pc(c.nrr).padStart(6)} → ${pc(h.nrr).padStart(6)}    $${Math.round(c.churn).toLocaleString()} → $${Math.round(h.churn).toLocaleString()}`);
}
// Annualized (compound the mean monthly rate over the window).
function annualized(seriesMap) {
  const grrs = [], nrrs = [];
  for (let k = 1; k < MONTHS.length; k++) { const r = retention(seriesMap, MONTHS[k - 1], MONTHS[k]); if (r.grr != null) grrs.push(r.grr); if (r.nrr != null) nrrs.push(r.nrr); }
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return { grr: Math.pow(mean(grrs), 12), nrr: Math.pow(mean(nrrs), 12) };
}
const ac = annualized(chgMrr), ah = annualized(hybrid);
console.log(`\nAnnualized (5-mo mean, compounded):`);
console.log(`  GRR: charge ${(ac.grr * 100).toFixed(1)}%  →  hybrid ${(ah.grr * 100).toFixed(1)}%`);
console.log(`  NRR: charge ${(ac.nrr * 100).toFixed(1)}%  →  hybrid ${(ah.nrr * 100).toFixed(1)}%`);
const hybridJune = [...hybrid.values()].reduce((s, o) => s + (o[JUNE] || 0), 0);
console.log(`\nHybrid June MRR: $${Math.round(hybridJune).toLocaleString()}  (invoice $${Math.round(sumInv(JUNE)).toLocaleString()} + charge-fallback $${Math.round(chargeOnlyTotal).toLocaleString()})`);

// --- write prototype snapshot ---
const invByMonthAgg = {};
for (const m of MONTHS) invByMonthAgg[m] = r2(sumInv(m));
fs.writeFileSync(path.join(SNAP, 'invoice_mrr_prototype.json'), JSON.stringify({
  generatedAt: INV.fetchedAt,
  basis: 'invoice service-period accrual (recurring lines); AR = open/uncollectible',
  invoice_mrr_by_month: invByMonthAgg,
  ar_total: arTotal, ar_by_month: arByMonth,
  charge_only_customers: chargeOnly, charge_only_total: r2(chargeOnlyTotal),
  phantom_june: phantom,
}, null, 2));
console.log('\n✓ wrote public/snapshots/invoice_mrr_prototype.json');
