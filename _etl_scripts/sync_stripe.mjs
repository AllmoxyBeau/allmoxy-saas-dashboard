#!/usr/bin/env node
/**
 * Pull platform charges (subscription + services revenue) directly from the
 * Stripe API — the API-direct replacement for the xlsx "Stripe Sync" tab.
 *
 * The platform's /v1/charges are its own charges (subscription invoices + one-off
 * services); Connect charges live on connected accounts and are handled by
 * sync_stripe_connect.mjs. Classification: a charge with an `invoice` is
 * subscription; otherwise services (mirrors the sheet's transaction_type split).
 *
 * Aggregates per Stripe customer (and per month) so we never persist the 22k-row
 * firehose. Incremental: stores the max `created` seen and only pulls newer
 * charges on subsequent runs (pass --full to force a full backfill).
 *
 * Output: _etl_scripts/cache/stripe_charges.json
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
const AUTH = 'Basic ' + Buffer.from(ENV.STRIPE_SECRET_KEY + ':').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Always a full pull for now (we capture nested per-transaction detail, so
// incremental array-merge isn't worth it yet). ~12 min for ~22k charges.
const createdGte = null;

async function getPage(startingAfter) {
  const qs = new URLSearchParams({ limit: '100' });
  if (startingAfter) qs.set('starting_after', startingAfter);
  if (createdGte) qs.set('created[gte]', String(createdGte));
  for (let a = 0; a < 6; a++) {
    const res = await fetch('https://api.stripe.com/v1/charges?' + qs, { headers: { Authorization: AUTH } });
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (a + 1)); continue; }
    const body = await res.json();
    if (res.status !== 200) throw new Error(`Stripe ${res.status}: ${body?.error?.message || ''}`);
    return body;
  }
  throw new Error('Stripe: retries exhausted');
}

// Full re-pull each time here (we capture per-transaction detail, so incremental
// merge of nested arrays isn't worth the complexity yet — the pull is ~12 min).
const byCust = new Map();
const currencies = new Map();
const noCustomer = []; // paid charges with no Stripe customer — to attribute (the $187K legacy bucket)
let maxCreated = 0;

const r2 = (v) => Math.round(v * 100) / 100;
const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
let cursor = null, pages = 0, scanned = 0, counted = 0, failedCount = 0;
const t0 = Date.now();
for (;;) {
  const page = await getPage(cursor);
  for (const c of page.data) {
    scanned++;
    if (c.created > maxCreated) maxCreated = c.created;
    currencies.set((c.currency || 'usd').toUpperCase(), (currencies.get((c.currency || 'usd').toUpperCase()) || 0) + 1);
    const cus = c.customer || null;
    const type = c.invoice ? 'subscription' : 'services';
    const month = new Date(c.created * 1000).toISOString().slice(0, 7);

    // Failed charges (paid=false) — kept for the at-risk/dunning signal.
    if (!c.paid || !c.captured) {
      if (c.status === 'failed' && cus) {
        const e = byCust.get(cus) || { subscription: 0, services: 0, refunded: 0, count: 0, first_ts: c.created, last_ts: c.created, by_month: {}, transactions: [], failed: [] };
        e.failed.push({ d: iso(c.created), a: r2(c.amount / 100) });
        byCust.set(cus, e);
        failedCount++;
      }
      continue;
    }

    // Successful, captured revenue (GROSS — net of refunds only, NOT Stripe fees).
    const gross = (c.amount - (c.amount_refunded || 0)) / 100;
    if (!cus) { noCustomer.push({ d: iso(c.created), a: r2(gross), type, desc: (c.description || '').slice(0, 80) }); counted++; continue; }
    const e = byCust.get(cus) || { subscription: 0, services: 0, refunded: 0, count: 0, first_ts: c.created, last_ts: c.created, by_month: {}, transactions: [], failed: [] };
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
  pages++;
  if (pages % 10 === 0) process.stderr.write(`  …${pages} pages, ${scanned} scanned\n`);
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
  source: 'stripe_api:charges',
  fetchedAt: new Date().toISOString(),
  basis: 'gross (amount − refunds; Stripe processing fees NOT deducted)',
  max_created: maxCreated,
  currencies: Object.fromEntries(currencies),
  totals: {
    lifetime_subscription: totSub, lifetime_services: totSvc, distinct_customers: byCust.size,
    failed_charges: failedCount, no_customer_total: noCustTotal, no_customer_count: noCustomer.length,
  },
  no_customer: noCustomer.sort((a, b) => b.a - a.a),
  by_customer,
}, null, 2));
process.stderr.write(`✓ stripe_charges.json: ${scanned} charges, ${counted} counted · ${byCust.size} customers · sub $${Math.round(totSub).toLocaleString()} + svc $${Math.round(totSvc).toLocaleString()} GROSS · ${failedCount} failed · no-customer $${Math.round(noCustTotal).toLocaleString()} (${noCustomer.length}) · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
if (currencies.size > 1) process.stderr.write(`⚠ currencies: ${[...currencies.keys()].join(', ')} (sums assume USD)\n`);
