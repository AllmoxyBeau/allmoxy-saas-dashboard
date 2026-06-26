#!/usr/bin/env node
/**
 * Pull Stripe Connect processing volume + take-rate from the live API.
 *
 * Uses the platform's `application_fees` list with the charge expanded, so each
 * record gives BOTH our fee (application_fee.amount) and the gross charge that
 * generated it (charge.amount) — i.e. the real GMV flowing through Connect and
 * our effective take-rate, per connected account, per month. This is the data
 * the QuickBooks/Drive exports lack (they carry only the fee, not the gross).
 *
 * Aggregates on the fly (monthly + per-account) so we never persist the full
 * ~50k/yr transaction firehose. Writes cache/stripe_connect_volume.json.
 *
 * Usage:
 *   node sync_stripe_connect.mjs               # all-time
 *   node sync_stripe_connect.mjs --since=2024-01-01
 *   node sync_stripe_connect.mjs --months=13   # trailing N months
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const OUT = path.join(ROOT, '_etl_scripts/cache/stripe_connect_volume.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

function loadEnv() {
  const env = { ...process.env };
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && env[m[1]] == null) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const ENV = loadEnv();
if (!ENV.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY in .env.local');
const AUTH = 'Basic ' + Buffer.from(ENV.STRIPE_SECRET_KEY + ':').toString('base64');

// --- args -----------------------------------------------------------------
const argSince = process.argv.find((a) => a.startsWith('--since='))?.split('=')[1];
const argMonths = process.argv.find((a) => a.startsWith('--months='))?.split('=')[1];
const FULL = process.argv.includes('--full');
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; } })();
let createdGte = null, incremental = false;
if (argSince) createdGte = Math.floor(new Date(argSince + 'T00:00:00Z').getTime() / 1000);
else if (argMonths) {
  const d = new Date();
  d.setMonth(d.getMonth() - Number(argMonths));
  createdGte = Math.floor(d.getTime() / 1000);
}
// Incremental: no explicit window + a prior cache → only fetch fees created after
// the last run. First run / --full does the (slow ~1h) full backfill.
else if (!FULL && prev?.max_created) { createdGte = prev.max_created + 1; incremental = true; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(startingAfter) {
  const qs = new URLSearchParams({ limit: '100', 'expand[]': 'data.charge' });
  if (startingAfter) qs.set('starting_after', startingAfter);
  if (createdGte) qs.set('created[gte]', String(createdGte));
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch('https://api.stripe.com/v1/application_fees?' + qs.toString(), { headers: { Authorization: AUTH } });
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
      const body = await res.json();
      if (res.status !== 200) throw new Error(`Stripe ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      lastErr = e;
      // Non-retryable API error (4xx other than 429 → auth/bad request): fail fast.
      if (/^Stripe 4/.test(String(e.message || ''))) throw e;
      // Network blip / timeout / transient: back off and retry (a single dropped
      // connection mustn't kill a ~1h, 50k-record backfill).
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Stripe: retries exhausted${lastErr ? ` (${lastErr.message})` : ''}`);
}

// --- aggregate -------------------------------------------------------------
const monthly = new Map();   // 'YYYY-MM' -> { gross, fee, count, refunded }
const byAccount = new Map(); // acct_id -> { gross, fee, count, firstTs, lastTs }
const currencies = new Map();
let total = { gross: 0, fee: 0, count: 0, refunded: 0 };
let maxCreated = 0;

// Seed aggregates from the previous cache on an incremental run.
if (incremental && prev) {
  for (const r of prev.monthly || []) monthly.set(r.month, { gross: r.gross_volume, fee: r.fee_revenue, count: r.txn_count, refunded: r.fee_refunded || 0 });
  for (const a of prev.by_account || []) byAccount.set(a.account, { gross: a.gross_volume, fee: a.fee_revenue, count: a.txn_count, firstTs: Math.floor(Date.parse(a.first_seen) / 1000) || 0, lastTs: Math.floor(Date.parse(a.last_seen) / 1000) || 0 });
  for (const [c, n] of Object.entries(prev.currencies || {})) currencies.set(c, n);
  total = { gross: prev.totals.gross_volume, fee: prev.totals.fee_revenue, count: prev.totals.txn_count, refunded: prev.totals.fee_refunded || 0 };
  maxCreated = prev.max_created || 0;
}

let cursor = null, pages = 0;
const t0 = Date.now();
for (;;) {
  const page = await getPage(cursor);
  for (const f of page.data) {
    if (f.created > maxCreated) maxCreated = f.created;
    const cur = (f.currency || 'usd').toUpperCase();
    currencies.set(cur, (currencies.get(cur) || 0) + 1);
    const feeAmt = (f.amount || 0) / 100;            // our take, dollars
    const feeRefund = (f.amount_refunded || 0) / 100;
    const gross = (f.charge?.amount ?? 0) / 100;      // GMV, dollars
    const month = new Date(f.created * 1000).toISOString().slice(0, 7);

    const mm = monthly.get(month) || { gross: 0, fee: 0, count: 0, refunded: 0 };
    mm.gross += gross; mm.fee += feeAmt; mm.count += 1; mm.refunded += feeRefund;
    monthly.set(month, mm);

    const acct = f.account || 'unknown';
    const aa = byAccount.get(acct) || { gross: 0, fee: 0, count: 0, firstTs: f.created, lastTs: f.created };
    aa.gross += gross; aa.fee += feeAmt; aa.count += 1;
    aa.firstTs = Math.min(aa.firstTs, f.created); aa.lastTs = Math.max(aa.lastTs, f.created);
    byAccount.set(acct, aa);

    total.gross += gross; total.fee += feeAmt; total.count += 1; total.refunded += feeRefund;
  }
  pages += 1;
  if (pages % 10 === 0) process.stderr.write(`  …${pages} pages, ${total.count.toLocaleString()} fees, $${Math.round(total.gross).toLocaleString()} GMV\n`);
  if (!page.has_more || page.data.length === 0) break;
  cursor = page.data[page.data.length - 1].id;
}

const r2 = (v) => Math.round(v * 100) / 100;
const monthlyRows = [...monthly.entries()].sort().map(([month, v]) => ({
  month,
  gross_volume: r2(v.gross),
  fee_revenue: r2(v.fee),
  fee_refunded: r2(v.refunded),
  txn_count: v.count,
  take_rate: v.gross > 0 ? Math.round((v.fee / v.gross) * 100000) / 100000 : null,
}));
const accountRows = [...byAccount.entries()].map(([account, v]) => ({
  account,
  gross_volume: r2(v.gross),
  fee_revenue: r2(v.fee),
  txn_count: v.count,
  take_rate: v.gross > 0 ? Math.round((v.fee / v.gross) * 100000) / 100000 : null,
  first_seen: new Date(v.firstTs * 1000).toISOString().slice(0, 10),
  last_seen: new Date(v.lastTs * 1000).toISOString().slice(0, 10),
})).sort((a, b) => b.gross_volume - a.gross_volume);

const out = {
  source: 'stripe_api:application_fees',
  fetchedAt: new Date().toISOString(),
  max_created: maxCreated,
  window: { since: argSince || (argMonths ? `trailing ${argMonths}mo` : incremental ? 'incremental' : 'all-time') },
  currencies: Object.fromEntries(currencies),
  totals: {
    gross_volume: r2(total.gross),
    fee_revenue: r2(total.fee),
    fee_refunded: r2(total.refunded),
    txn_count: total.count,
    take_rate: total.gross > 0 ? Math.round((total.fee / total.gross) * 100000) / 100000 : null,
    distinct_accounts: byAccount.size,
  },
  monthly: monthlyRows,
  by_account: accountRows,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
process.stderr.write(`✓ stripe_connect_volume.json: ${total.count.toLocaleString()} fees · $${Math.round(total.gross).toLocaleString()} GMV · ${(out.totals.take_rate * 100).toFixed(2)}% blended take · ${byAccount.size} accounts · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
if (currencies.size > 1) process.stderr.write(`⚠ multiple currencies present (${[...currencies.keys()].join(', ')}) — sums assume single-currency; revisit if material.\n`);
