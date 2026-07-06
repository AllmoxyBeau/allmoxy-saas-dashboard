#!/usr/bin/env node
/**
 * Pull platform payments (subscription + services revenue) directly from the
 * Stripe API — the API-direct replacement for the xlsx "Stripe Sync" tab.
 *
 * Enumerates TWO endpoints and merges them (deduped by charge id) because
 * neither is complete on its own:
 *
 *   • /v1/charges           — returns card + legacy charges (`ch_`), but the LIST
 *                             endpoint silently OMITS Stripe Link / bank charges
 *                             (`py_`). Those are real revenue (e.g. KOA Komponents
 *                             pays $250/mo via Link).
 *   • /v1/payment_intents   — returns every PI-based payment (card, Link, bank),
 *                             but MISSES legacy subscriptions that charge a card
 *                             Source directly with no PaymentIntent (e.g. Midwest
 *                             Floor's $2,780/mo, a customer since 2019).
 *
 * Pulling only one drops a whole class of customers into false churn the moment
 * the live seam takes over from the xlsx. The union of both, deduped by charge
 * id, is the complete set.
 *
 * The platform's payments are its own charges (subscription invoices + one-off
 * services); Connect charges live on connected accounts and are handled by
 * sync_stripe_connect.mjs. Classification: a charge with an `invoice` is
 * subscription; otherwise services (mirrors the sheet's transaction_type split).
 *
 * Aggregates per Stripe customer (and per month) so we never persist the full
 * firehose. Incremental: stores the max `created` seen and only pulls newer
 * charges/intents on subsequent runs (pass --full to force a full backfill).
 *
 * Output: _etl_scripts/cache/stripe_charges.json (schema unchanged).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_etl_scripts/cache/stripe_charges.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function loadEnv() {
  const env = { ...process.env };
  const p = path.join(ROOT, '.env.local');
  if (fs.existsSync(p)) for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && env[m[1]] == null) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const ENV = loadEnv();
if (!ENV.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY in .env.local');

// Transaction-type recognizer. Priority:
//   1. metadata.transaction_type — the source of truth set in Stripe (recent charges).
//   2. description / statement descriptor patterns ("Services" / "Subscription" / "Custom Domain").
//   3. presence of a Stripe Billing invoice id → recurring subscription.
//   4. default subscription (the bulk of revenue).
// Returns 'subscription' | 'services' | 'connect'. Tracks which signal was used.
const TYPE_SIGNAL = { metadata: 0, pattern: 0, invoice: 0, default: 0 };
function classifyType(c) {
  const mt = String(c.metadata?.transaction_type || '').toLowerCase().trim();
  if (mt) { TYPE_SIGNAL.metadata++; if (mt.includes('service')) return 'services'; if (mt.includes('connect')) return 'connect'; return 'subscription'; }
  const blob = (String(c.description || '') + ' ' + String(c.statement_descriptor || c.calculated_statement_descriptor || '')).toLowerCase();
  if (/\bservices?\b/.test(blob)) { TYPE_SIGNAL.pattern++; return 'services'; }
  if (/custom\s*dom|subscription/.test(blob)) { TYPE_SIGNAL.pattern++; return 'subscription'; }
  if (c.invoice) { TYPE_SIGNAL.invoice++; return 'subscription'; }
  TYPE_SIGNAL.default++; return 'subscription';
}
const AUTH = 'Basic ' + Buffer.from(ENV.STRIPE_SECRET_KEY + ':').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Incremental by default: seed from the previous cache and only fetch items
// created AFTER the last run's high-water mark. First run (no cache) or --full
// does the full backfill. NOTE: incremental fetches by created date, so a refund
// applied today to an OLDER charge won't be re-pulled — run --full weekly.
const FULL = process.argv.includes('--full');
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; } })();
const createdGt = (!FULL && prev?.max_created) ? prev.max_created : null;

// Generic pager with hardened retry (429 / 5xx / transient network errors).
async function getPage(url, params) {
  const qs = new URLSearchParams({ limit: '100', ...params });
  if (createdGt) qs.set('created[gt]', String(createdGt));
  for (let a = 0; a < 6; a++) {
    let res;
    try { res = await fetch(`${url}?${qs}`, { headers: { Authorization: AUTH } }); }
    catch { await sleep(500 * (a + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (a + 1)); continue; }
    const body = await res.json();
    if (res.status !== 200) throw new Error(`Stripe ${res.status}: ${body?.error?.message || ''}`);
    return body;
  }
  throw new Error('Stripe: retries exhausted');
}

// Seed aggregates from the previous cache so incremental runs append to history.
const byCust = new Map();
if (createdGt && prev?.by_customer) for (const [cus, v] of Object.entries(prev.by_customer)) {
  byCust.set(cus, { ...v, by_month: { ...(v.by_month || {}) }, transactions: [...(v.transactions || [])], failed: [...(v.failed || [])] });
}
const currencies = new Map(createdGt ? Object.entries(prev?.currencies || {}) : []);
const noCustomer = createdGt ? [...(prev?.no_customer || [])] : []; // paid charges with no Stripe customer
let maxCreated = createdGt ? (prev?.max_created || 0) : 0;

const r2 = (v) => Math.round(v * 100) / 100;
const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const newEntry = (ts) => ({ subscription: 0, services: 0, refunded: 0, count: 0, first_ts: ts, last_ts: ts, by_month: {}, transactions: [], failed: [] });

// Record a single charge object into the aggregates. Deduped by charge id across
// both endpoints (a `ch_` charge with a PI appears in both passes → count once).
const seen = new Set();
let scanned = 0, counted = 0, failedCount = 0;
function record(c) {
  if (!c || !c.id || seen.has(c.id)) return;
  seen.add(c.id);
  scanned++;
  if (c.created > maxCreated) maxCreated = c.created;
  const cus = c.customer || null;
  const currency = (c.currency || 'usd').toUpperCase();
  currencies.set(currency, (currencies.get(currency) || 0) + 1);
  const month = new Date(c.created * 1000).toISOString().slice(0, 7);

  // Failed charges (paid=false) — kept for the at-risk/dunning signal.
  if (!c.paid || !c.captured) {
    if (c.status === 'failed' && cus) {
      const e = byCust.get(cus) || newEntry(c.created);
      e.failed.push({ d: iso(c.created), a: r2(c.amount / 100) });
      byCust.set(cus, e);
      failedCount++;
    }
    return;
  }

  // Successful, captured revenue (GROSS — net of refunds only, NOT Stripe fees).
  const type = classifyType(c);
  const gross = (c.amount - (c.amount_refunded || 0)) / 100;
  if (!cus) { noCustomer.push({ d: iso(c.created), a: r2(gross), type, desc: (c.description || '').slice(0, 80) }); counted++; return; }
  const e = byCust.get(cus) || newEntry(c.created);
  e[type] = r2((e[type] || 0) + gross);
  e.refunded = r2(e.refunded + (c.amount_refunded || 0) / 100);
  e.count += 1;
  e.first_ts = Math.min(e.first_ts, c.created); e.last_ts = Math.max(e.last_ts, c.created);
  const mm = e.by_month[month] || { subscription: 0, services: 0 };
  mm[type] = r2(mm[type] + gross); e.by_month[month] = mm;
  e.transactions.push({ d: iso(c.created), a: r2(gross), t: type, r: r2((c.amount_refunded || 0) / 100) });
  byCust.set(cus, e);
  counted++;
}

const t0 = Date.now();

// Pass A — /v1/charges: card + legacy (`ch_`) charges.
let cursor = null, pagesA = 0;
for (;;) {
  const page = await getPage('https://api.stripe.com/v1/charges', cursor ? { starting_after: cursor } : {});
  for (const c of page.data) record(c);
  pagesA++;
  if (pagesA % 10 === 0) process.stderr.write(`  [charges] …${pagesA} pages, ${scanned} scanned\n`);
  if (!page.has_more || page.data.length === 0) break;
  cursor = page.data[page.data.length - 1].id;
}

// Pass B — /v1/payment_intents (expand latest_charge): adds Link / bank (`py_`)
// charges the /v1/charges list omits. Already-seen `ch_` charges are deduped.
cursor = null;
let pagesB = 0;
for (;;) {
  const page = await getPage('https://api.stripe.com/v1/payment_intents', { 'expand[]': 'data.latest_charge', ...(cursor ? { starting_after: cursor } : {}) });
  for (const pi of page.data) {
    const c = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    if (c) { if (!c.customer && pi.customer) c.customer = pi.customer; record(c); }
  }
  pagesB++;
  if (pagesB % 10 === 0) process.stderr.write(`  [intents] …${pagesB} pages, ${scanned} scanned\n`);
  if (!page.has_more || page.data.length === 0) break;
  cursor = page.data[page.data.length - 1].id;
}

const by_customer = Object.fromEntries([...byCust.entries()].map(([cus, v]) => [cus, {
  ...v,
  transactions: v.transactions.sort((a, b) => a.d.localeCompare(b.d)),
  first_seen: iso(v.first_ts),
  last_seen: iso(v.last_ts),
}]));
const totSub = r2([...byCust.values()].reduce((s, v) => s + (v.subscription || 0), 0));
const totSvc = r2([...byCust.values()].reduce((s, v) => s + (v.services || 0), 0));

const noCustTotal = r2(noCustomer.reduce((s, x) => s + x.a, 0));
fs.writeFileSync(OUT, JSON.stringify({
  source: 'stripe_api:charges+payment_intents',
  fetchedAt: new Date().toISOString(),
  basis: 'gross (amount − refunds; Stripe processing fees NOT deducted)',
  max_created: maxCreated,
  currencies: Object.fromEntries(currencies),
  totals: {
    lifetime_subscription: totSub, lifetime_services: totSvc, distinct_customers: byCust.size,
    failed_charges: failedCount, no_customer_total: noCustTotal, no_customer_count: noCustomer.length,
  },
  type_signal: TYPE_SIGNAL, // how each charge's type was determined (metadata = source of truth)
  no_customer: noCustomer.sort((a, b) => b.a - a.a),
  by_customer,
}, null, 2));
process.stderr.write(`✓ stripe_charges.json: ${scanned} charges (A:${pagesA}p + B:${pagesB}p), ${counted} counted · ${byCust.size} customers · sub $${Math.round(totSub).toLocaleString()} + svc $${Math.round(totSvc).toLocaleString()} GROSS · ${failedCount} failed · no-customer $${Math.round(noCustTotal).toLocaleString()} (${noCustomer.length}) · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
if (currencies.size > 1) process.stderr.write(`⚠ currencies: ${[...currencies.keys()].join(', ')} (sums assume USD)\n`);
