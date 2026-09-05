#!/usr/bin/env node
/**
 * Stripe balance transactions by month — the data behind Beau's monthly QuickBooks
 * Stripe journal entry. Reproduces Stripe's "Itemized balance change from
 * activity" export (US-Mountain month windows) so the Revenue Recognition page
 * can generate the ENTIRE entry, line for line:
 *
 *   DR 4200 (gross deposits)       = payouts
 *   CR 1003 Stripe Account         = payouts − net activity (Stripe balance change)
 *   CR 4000 Monthly Subscription   = charges tagged transaction_type=subscription
 *   CR 4300 Services Income        = charges tagged transaction_type=services
 *   DR 4000 / 4300 refunds         = refunds, classified by the refunded charge's type
 *   DR 4200 Connect refunds        = platform_earning_refund
 *   DR 5000 CC fees                = charge fees;  other fees = `fee` category + Connect fees
 *   CR 4200 Stripe Fee Income      = platform_earning gross (Connect)
 *
 * Verified against Beau's August 2026 entry: every line ties to the penny.
 * Sales tax by state comes from the invoices cache (sync_stripe_invoices), not here.
 *
 * Output: _etl_scripts/cache/stripe_balance_transactions.json
 *   { fetchedAt, months: { 'YYYY-MM': { window_utc, totals..., rows:[minimal] } } }
 *
 * Pulls RECONCILE_FROM (2026-01) → current month, always full (statuses/refunds
 * can post late). ~5K rows/month; a few minutes total.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const OUT = path.join(ROOT, '_etl_scripts/cache/stripe_balance_transactions.json');
const ENV = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
if (!ENV.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY in .env.local');
const AUTH = 'Basic ' + Buffer.from(ENV.STRIPE_SECRET_KEY + ':').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (v) => Math.round(v * 100) / 100;
// Must cover the whole accrual-reliable window (2025-08+), not just the JE months:
// build_revenue_recognition folds direct/legacy subscription charges from these rows
// into the per-customer accrual series. If the feed started later than the accrual
// window, those charges would appear out of nowhere in the first covered month and
// register as fake expansion (GRR read 4.6 pts low).
const FROM = '2025-08';

async function get(p) {
  for (let a = 0; a < 6; a++) {
    let res; try { res = await fetch('https://api.stripe.com/v1/' + p, { headers: { Authorization: AUTH } }); } catch { await sleep(500 * (a + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (a + 1)); continue; }
    const body = await res.json();
    if (res.status !== 200) throw new Error(`Stripe ${res.status}: ${body?.error?.message || ''}`);
    return body;
  }
  throw new Error('Stripe: retries exhausted');
}

// Local midnight in America/Denver → UTC unix seconds (handles MST/MDT).
function denverMidnightUTC(y, m, d) {
  for (const off of [6, 7]) { // MDT=UTC-6, MST=UTC-7
    const t = Date.UTC(y, m - 1, d, off, 0, 0);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', hour12: false, day: 'numeric' }).formatToParts(new Date(t));
    const hour = Number(parts.find((p) => p.type === 'hour').value) % 24, day = Number(parts.find((p) => p.type === 'day').value);
    if (hour === 0 && day === d) return Math.floor(t / 1000);
  }
  return Math.floor(Date.UTC(y, m - 1, d, 6) / 1000);
}
const addMonth = (y, m) => (m === 12 ? [y + 1, 1] : [y, m + 1]);

const now = new Date(); const curY = now.getFullYear(), curM = now.getMonth() + 1;
const months = []; { let [y, m] = FROM.split('-').map(Number); while (y < curY || (y === curY && m <= curM)) { months.push([y, m]); [y, m] = addMonth(y, m); } }

const chargeTypeCache = new Map(); // charge id -> transaction_type (for classifying refunds)
async function chargeType(id) {
  if (!id) return null; if (chargeTypeCache.has(id)) return chargeTypeCache.get(id);
  try {
    const c = await get('charges/' + id);
    // Fallback when the charge has no transaction_type metadata (older / dashboard-
    // issued charges, e.g. Brave Custom's refunded 7/30 invoice): an invoice-backed
    // charge is a subscription; an "Allmoxy Services Invoice" description is services.
    let t = c.metadata?.transaction_type || null;
    if (!t) { if (c.invoice) t = 'subscription'; else if (/services/i.test(c.description || '')) t = 'services'; }
    chargeTypeCache.set(id, t); return t;
  } catch { return null; }
}

const out = { fetchedAt: new Date().toISOString(), timezone: 'America/Denver', months: {} };
const t0 = Date.now();
for (const [y, m] of months) {
  const key = `${y}-${String(m).padStart(2, '0')}`;
  const [ny, nm] = addMonth(y, m);
  const gte = denverMidnightUTC(y, m, 1), lte = denverMidnightUTC(ny, nm, 1) - 1;
  const rows = []; let after = null;
  for (;;) {
    const q = new URLSearchParams({ limit: '100', 'created[gte]': String(gte), 'created[lte]': String(lte) });
    q.append('expand[]', 'data.source');
    if (after) q.set('starting_after', after);
    const pg = await get('balance_transactions?' + q);
    for (const t of pg.data) {
      const cat = t.reporting_category || t.type;
      let tt = null, cust = null, name = null, chargeId = null, inv = null;
      if (cat === 'charge') { tt = t.source?.metadata?.transaction_type || null; cust = t.source?.customer || null; name = t.source?.billing_details?.name || null; chargeId = t.source?.id || null; inv = (typeof t.source?.invoice === 'string' ? t.source.invoice : t.source?.invoice?.id) || null; }
      else if (cat === 'refund') {
        chargeId = typeof t.source?.charge === 'string' ? t.source.charge : t.source?.charge?.id || null;
        tt = await chargeType(chargeId);
        // Last-resort fallback from the balance-transaction description: Stripe writes
        // "REFUND FOR CHARGE (Invoice XXXX-0014)" for invoice-backed (subscription)
        // refunds and "…Allmoxy Services Invoice #NNNN" for services. Without this, an
        // unclassified subscription refund lands on 4700 Misc instead of 4000.
        if (!tt) { const d = t.description || ''; tt = /services invoice/i.test(d) ? 'services' : /invoice/i.test(d) ? 'subscription' : null; }
      }
      // `inv` null on a subscription-tagged charge = a direct/legacy "Subscription
      // xxx.allmoxy.com" or add-on charge billed OUTSIDE a Stripe invoice. These are
      // real recurring revenue and must be counted in recognized revenue, otherwise
      // the accrual adjustment (recognized − cash) is understated by their amount.
      rows.push({ id: t.id, created: new Date(t.created * 1000).toISOString(), cat, amount: r2(t.amount / 100), fee: r2(t.fee / 100), net: r2(t.net / 100), tt, cust, name, charge: chargeId, inv, desc: (t.description || '').split('\n')[0].slice(0, 60) });
    }
    if (!pg.has_more || pg.data.length === 0) break;
    after = pg.data[pg.data.length - 1].id;
  }
  // ── aggregate the JE inputs ──
  const S = (f) => r2(rows.filter(f).reduce((s, r) => s + r.amount, 0));
  const F = (f) => r2(rows.filter(f).reduce((s, r) => s + r.fee, 0));
  const payouts = -S((r) => r.cat === 'payout');
  const netActivity = r2(rows.filter((r) => r.cat !== 'payout').reduce((s, r) => s + r.net, 0));
  const tot = {
    payouts,                                                         // DR 4200 gross deposits
    stripe_balance_change: r2(payouts - netActivity),                // CR 1003 (payouts exceeded activity) — negative = DR
    subscription_gross: S((r) => r.cat === 'charge' && r.tt === 'subscription'),      // CR 4000 (incl. sales tax)
    services_gross: S((r) => r.cat === 'charge' && r.tt === 'services'),              // CR 4300
    untagged_gross: S((r) => r.cat === 'charge' && !['subscription', 'services'].includes(r.tt)),
    subscription_refunds: -S((r) => r.cat === 'refund' && r.tt === 'subscription'),   // DR 4000
    services_refunds: -S((r) => r.cat === 'refund' && r.tt === 'services'),           // DR 4300
    other_refunds: -S((r) => r.cat === 'refund' && !['subscription', 'services'].includes(r.tt)),
    connect_gross: S((r) => r.cat === 'platform_earning'),                            // CR 4200 Stripe Fee Income
    connect_refunds: -S((r) => r.cat === 'platform_earning_refund'),                  // DR 4200
    charge_fees: F((r) => r.cat === 'charge'),                                        // DR 5000 (line 1)
    other_fees: r2(-S((r) => r.cat === 'fee') + F((r) => r.cat === 'fee') + F((r) => r.cat === 'platform_earning')), // DR 5000 (line 2)
    net_activity: netActivity,
    row_count: rows.length,
  };
  out.months[key] = { window_utc: [new Date(gte * 1000).toISOString(), new Date((lte + 1) * 1000).toISOString()], totals: tot, rows };
  process.stderr.write(`  ${key}: ${rows.length} txns · payouts $${payouts.toLocaleString()} · sub $${tot.subscription_gross.toLocaleString()} · svc $${tot.services_gross.toLocaleString()} · connect $${tot.connect_gross.toLocaleString()}\n`);
}
// Current Stripe balance (available + pending, USD). Anchors the per-month
// starting/ending balances so the page can mirror Stripe's Balance report
// (dashboard → Reports → Balance, merchant template, US/Mountain):
//   ending(M) = current − Σ net change of months after M;  starting(M) = ending(M) − net change(M)
try {
  const bal = await get('balance');
  const sum = (arr) => r2((arr || []).filter((b) => b.currency === 'usd').reduce((s, b) => s + b.amount, 0) / 100);
  out.current_balance = { available: sum(bal.available), pending: sum(bal.pending), total: r2(sum(bal.available) + sum(bal.pending)), as_of: new Date().toISOString() };
} catch { out.current_balance = null; }
fs.writeFileSync(OUT, JSON.stringify(out));
console.error(`✓ stripe_balance_transactions.json: ${months.length} months · balance $${out.current_balance?.total ?? '?'} · ${Math.round((Date.now() - t0) / 1000)}s`);
