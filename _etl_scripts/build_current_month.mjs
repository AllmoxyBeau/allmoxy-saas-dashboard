#!/usr/bin/env node
/**
 * CURRENT MONTH — accrual view of how subscription MRR is moving this month.
 *
 * Beau, 2026-09-16: "The entire goal of the current month page is to understand the
 * impact of MRR on the month. How have MRR subscriptions changed up or down. It should
 * be accrual based and provide insight into upcoming vs. already billed successfully
 * or not invoices."
 *
 * Two questions, one basis:
 *
 *   1. HOW DID MRR MOVE?  Each customer's billing this month against last month,
 *      measured BILLING TO BILLING so payment timing cannot manufacture movement. A
 *      late payment is not contraction; a catch-up payment is not growth. That is the
 *      reason this file exists — the cash view reported $11,330 of fake September
 *      increases from customers whose August charges were missing from the charge cache.
 *
 *   2. WHERE IS THE MONTH UP TO?  Customers bill on their own day, so mid-month the
 *      book splits into: collected · awaiting payment · failing · written off ·
 *      not yet billed · nothing scheduled. The "not yet billed" bucket is invisible to
 *      a cash view and is usually the difference between "we are down badly" and
 *      "it is the 17th".
 *
 * THE COMPARISON MUST BE LIKE FOR LIKE. A customer's billing is not only invoices:
 * ~6% bill by direct charge, and many invoice customers also carry recurring
 * per-instance "Subscription <host>.allmoxy.com" fees outside the invoice. The prior
 * month comes from revenue_recognition.accrual_series, which includes both — so this
 * month must too, or every customer with an add-on reads as contraction and every
 * direct-charge customer reads as lost. (First cut of this file did exactly that:
 * Midwest Floor Coverings showed -$2,179 "lost" while billing normally.)
 *
 * Output: public/snapshots/current_month.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const INV = read(path.join(ROOT, '_etl_scripts/cache/stripe_invoices.json'), { by_customer: {} });
const CH = read(path.join(ROOT, '_etl_scripts/cache/stripe_charges.json'), { by_customer: {} });
const BT = read(path.join(ROOT, '_etl_scripts/cache/stripe_balance_transactions.json'), { months: {} });
const SUBS = read(path.join(ROOT, '_etl_scripts/cache/stripe_subscriptions.json'), { by_subscription: {} });
const RR = read(path.join(SNAP, 'revenue_recognition.json'));
const PROF = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];
const ANNUAL = new Set((read(path.join(ROOT, 'src/data/annual_payers.json'), {}).annual_payer_ids || []).map(Number));

const now = new Date();
const CM = now.toISOString().slice(0, 7);
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + k, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const PM = addMonths(CM, -1);
const today = now.toISOString().slice(0, 10);
const dayNow = now.getDate();
const daysInMonth = new Date(Number(CM.slice(0, 4)), Number(CM.slice(5, 7)), 0).getDate();

const custToProf = new Map();
for (const p of PROF) for (const cid of (p.stripe_customer_ids || [])) custToProf.set(cid, p);
const byAid = new Map(PROF.map((p) => [p.allmoxy_customer_id, p]));
const accrual = new Map((RR?.accrual_series || []).map((r) => [r.allmoxy_customer_id, r.months || {}]));

const RECOGNIZED = new Set(['paid', 'open', 'uncollectible']);   // void = never billed
// Same rule build_revenue_recognition uses: a direct charge counts as recurring only
// when it is a distinct recurring line item, never a one-off or a catch-up payment.
const RECURRING_DIRECT = /^\s*subscription\s+\S+\.|ai tokens|custom\s*dom/i;

const rows = new Map();
function rowFor(aid, name) {
  if (!rows.has(aid)) {
    rows.set(aid, {
      allmoxy_customer_id: aid, name,
      prior_billed: r2(accrual.get(aid)?.[PM] || 0),
      invoiced: 0, direct: 0, collected: 0, outstanding: 0, uncollectible: 0,
      invoices: [], failed_attempts: 0, failed_amount: 0,
      expected_billing_day: null, next_billing_date: null, has_upcoming: false,
    });
  }
  return rows.get(aid);
}

// ── 1. invoices dated this month ─────────────────────────────────────────────
for (const [cid, c] of Object.entries(INV.by_customer || {})) {
  const prof = custToProf.get(cid);
  const aid = prof?.allmoxy_customer_id;
  if (aid == null || ANNUAL.has(aid)) continue;
  for (const i of (c.invoices || [])) {
    if ((i.d || '').slice(0, 7) !== CM || !RECOGNIZED.has(i.status)) continue;
    const r = rowFor(aid, prof.customer_name || prof.name);
    const amt = i.sub || 0;
    r.invoiced = r2(r.invoiced + amt);
    if (i.status === 'paid') r.collected = r2(r.collected + amt);
    else if (i.status === 'uncollectible') r.uncollectible = r2(r.uncollectible + amt);
    else r.outstanding = r2(r.outstanding + amt);
    r.invoices.push({ id: i.id, date: i.d, amount: r2(amt), status: i.status, paid_at: i.paid_at || null });
  }
}

// ── 2. recurring direct charges this month (the like-for-like fix) ───────────
for (const r of (BT.months?.[CM]?.rows || [])) {
  if (r.cat !== 'charge' || r.tt !== 'subscription' || r.inv) continue;
  if (!RECURRING_DIRECT.test(String(r.desc || ''))) continue;
  const prof = r.cust ? custToProf.get(r.cust) : null;
  const aid = prof?.allmoxy_customer_id;
  if (aid == null || ANNUAL.has(aid)) continue;
  const row = rowFor(aid, prof.customer_name || prof.name);
  row.direct = r2(row.direct + r.amount);
  row.collected = r2(row.collected + r.amount);   // direct charges clear on post
}

// ── 3. failed attempts — an unpaid invoice with a failure behind it is dunning,
//       not merely "not paid yet", and belongs in a different queue.
for (const [cid, c] of Object.entries(CH.by_customer || {})) {
  const prof = custToProf.get(cid);
  const aid = prof?.allmoxy_customer_id;
  if (aid == null) continue;
  for (const f of (c.failed || [])) {
    if (String(f.d || '').slice(0, 7) !== CM) continue;
    const r = rowFor(aid, prof.customer_name || prof.name);
    r.failed_attempts += 1;
    r.failed_amount = r2(r.failed_amount + (f.a || 0));
  }
}

// ── 4. everyone who billed last month but has nothing here yet ───────────────
for (const [aid, months] of accrual) {
  if (ANNUAL.has(aid) || (months[PM] || 0) <= 0) continue;
  const p = byAid.get(aid);
  rowFor(aid, p?.customer_name || p?.name || `#${aid}`);
}

// ── 5. when does each customer bill? ─────────────────────────────────────────
// Stripe's current_period_end is the next invoice date, so a date later this month
// means the billing day is still ahead of us.
for (const [, s] of Object.entries(SUBS.by_subscription || {})) {
  if (s.status !== 'active') continue;
  const prof = custToProf.get(s.customer);
  const aid = prof?.allmoxy_customer_id;
  if (aid == null || ANNUAL.has(aid) || !rows.has(aid)) continue;
  const end = String(s.current_period_end || '');
  if (end.slice(0, 7) === CM && end >= today) {
    const r = rows.get(aid);
    r.has_upcoming = true;
    if (!r.next_billing_date || end < r.next_billing_date) r.next_billing_date = end;
  }
}
// Direct-charge customers have no Stripe subscription at all, so fall back to the day
// of the month they have historically billed on. Without this, every charge-basis
// customer whose billing day has not arrived reads as lost.
const priorDay = new Map();
for (const [cid, c] of Object.entries(INV.by_customer || {})) {
  const aid = custToProf.get(cid)?.allmoxy_customer_id; if (aid == null) continue;
  for (const i of (c.invoices || [])) if ((i.d || '').slice(0, 7) === PM) priorDay.set(aid, Number(String(i.d).slice(8, 10)));
}
for (const r of (BT.months?.[PM]?.rows || [])) {
  if (r.cat !== 'charge' || r.tt !== 'subscription' || r.inv) continue;
  if (!RECURRING_DIRECT.test(String(r.desc || ''))) continue;
  const aid = r.cust ? custToProf.get(r.cust)?.allmoxy_customer_id : null;
  if (aid != null && !priorDay.has(aid)) priorDay.set(aid, Number(String(r.created || '').slice(8, 10)));
}
for (const r of rows.values()) {
  const d = priorDay.get(r.allmoxy_customer_id);
  if (d) r.expected_billing_day = d;
  if (!r.has_upcoming && d && d > dayNow) r.has_upcoming = true;
}

// ── classify ─────────────────────────────────────────────────────────────────
for (const r of rows.values()) {
  const billedSoFar = r2(r.invoiced + r.direct);
  r.billed_so_far = billedSoFar;
  // A customer still to bill this month is expected to bill as they did last month.
  // Where they have already billed MORE than that, the actual wins — a mid-month
  // upgrade is real, and should not be capped by last month's figure.
  r.upcoming_expected = r.has_upcoming ? r2(Math.max(0, r.prior_billed - billedSoFar)) : 0;
  r.expected = r2(billedSoFar + r.upcoming_expected);
  r.delta = r2(r.expected - r.prior_billed);

  if (billedSoFar === 0 && r.has_upcoming) r.billing_state = 'not_yet_billed';
  else if (billedSoFar === 0) r.billing_state = 'nothing_scheduled';
  else if (r.has_upcoming && r.upcoming_expected > 0) r.billing_state = 'partially_billed';
  else if (r.uncollectible > 0) r.billing_state = 'written_off';
  else if (r.outstanding > 0 && r.failed_attempts > 0) r.billing_state = 'failing';
  else if (r.outstanding > 0) r.billing_state = 'awaiting_payment';
  else r.billing_state = 'collected';

  if (r.prior_billed === 0 && r.expected > 0) r.movement = 'new';
  else if (r.expected === 0 && r.prior_billed > 0) r.movement = 'lost';
  else if (r.delta > 0.01) r.movement = 'expansion';
  else if (r.delta < -0.01) r.movement = 'contraction';
  else r.movement = 'flat';
}

const all = [...rows.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
const sumBy = (f) => r2(all.filter(f).reduce((s, r) => s + r.delta, 0));
const amtBy = (f, k) => r2(all.filter(f).reduce((s, r) => s + (r[k] || 0), 0));
const cnt = (f) => all.filter(f).length;
const starting = r2(all.reduce((s, r) => s + r.prior_billed, 0));
const expected = r2(all.reduce((s, r) => s + r.expected, 0));

const out = {
  tab: 'current_month',
  fetchedAt: new Date().toISOString(),
  basis: 'accrual — Stripe invoices by invoice date plus recurring direct charges, subscription only, annual payers excluded (booked on 4100)',
  month: CM, prior_month: PM, as_of: today,
  day_of_month: dayNow, days_in_month: daysInMonth, elapsed_pct: r2(dayNow / daysInMonth),
  mrr: {
    starting, expected_ending: expected,
    net_change: r2(expected - starting),
    net_change_pct: starting > 0 ? r2((expected - starting) / starting) : null,
    billed_so_far: amtBy(() => true, 'billed_so_far'),
    still_to_bill: amtBy(() => true, 'upcoming_expected'),
  },
  movement: {
    new: { amount: sumBy((r) => r.movement === 'new'), customers: cnt((r) => r.movement === 'new') },
    expansion: { amount: sumBy((r) => r.movement === 'expansion'), customers: cnt((r) => r.movement === 'expansion') },
    contraction: { amount: sumBy((r) => r.movement === 'contraction'), customers: cnt((r) => r.movement === 'contraction') },
    lost: { amount: sumBy((r) => r.movement === 'lost'), customers: cnt((r) => r.movement === 'lost') },
    flat: { amount: 0, customers: cnt((r) => r.movement === 'flat') },
  },
  billing: {
    collected: { amount: amtBy((r) => r.billing_state === 'collected', 'billed_so_far'), customers: cnt((r) => r.billing_state === 'collected') },
    awaiting_payment: { amount: amtBy((r) => r.billing_state === 'awaiting_payment', 'outstanding'), customers: cnt((r) => r.billing_state === 'awaiting_payment') },
    failing: { amount: amtBy((r) => r.billing_state === 'failing', 'outstanding'), customers: cnt((r) => r.billing_state === 'failing') },
    written_off: { amount: amtBy((r) => r.billing_state === 'written_off', 'uncollectible'), customers: cnt((r) => r.billing_state === 'written_off') },
    partially_billed: { amount: amtBy((r) => r.billing_state === 'partially_billed', 'upcoming_expected'), customers: cnt((r) => r.billing_state === 'partially_billed') },
    not_yet_billed: { amount: amtBy((r) => r.billing_state === 'not_yet_billed', 'upcoming_expected'), customers: cnt((r) => r.billing_state === 'not_yet_billed') },
    nothing_scheduled: { amount: amtBy((r) => r.billing_state === 'nothing_scheduled', 'prior_billed'), customers: cnt((r) => r.billing_state === 'nothing_scheduled') },
  },
  customers: all,
  notes: 'Accrual view of the month in progress. Movement is measured BILLING TO BILLING (invoices + recurring direct charges) against the same measure last month, so payment timing cannot create false expansion or contraction. "Not yet billed" is valued at last month\'s billing — an expectation, not a fact. "Nothing scheduled" means they billed last month with nothing issued and no billing date ahead: the genuine risk set, and the number worth working.',
};

fs.writeFileSync(path.join(SNAP, 'current_month.json'), JSON.stringify(out));
console.error(`[current_month] ${CM} day ${dayNow}/${daysInMonth} · $${Math.round(starting).toLocaleString()} → $${Math.round(expected).toLocaleString()} (${out.mrr.net_change >= 0 ? '+' : ''}$${Math.round(out.mrr.net_change).toLocaleString()}) · billed $${Math.round(out.mrr.billed_so_far).toLocaleString()}, to bill $${Math.round(out.mrr.still_to_bill).toLocaleString()} · nothing scheduled: ${out.billing.nothing_scheduled.customers} ($${Math.round(out.billing.nothing_scheduled.amount).toLocaleString()})`);
