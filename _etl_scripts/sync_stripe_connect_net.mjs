#!/usr/bin/env node
/**
 * Pull NET-SETTLED Connect revenue — i.e. "what actually hits the bank" — from
 * Stripe's balance_transactions, which are denominated in the platform's
 * settlement currency (USD) AFTER Stripe converts foreign-currency (CAD/AUD)
 * application fees. This is the real-revenue counterpart to sync_stripe_connect.mjs,
 * which reports GROSS application fees in each charge's own currency (so it sums
 * USD + CAD at face value and overstates the USD that lands in the account).
 *
 * We bucket two balance-transaction types by month:
 *   - application_fee         (our Connect take, USD-settled, FX already applied)
 *   - application_fee_refund  (negative — refunded take)
 * net_usd = application_fee net + application_fee_refund net.
 *
 * Aggregates monthly on the fly (no firehose persisted). Incremental by default:
 * stores the max `created` seen and only pulls newer transactions on later runs
 * (pass --full to force a full backfill). Writes cache/stripe_connect_net.json.
 *
 * Usage:
 *   node sync_stripe_connect_net.mjs            # incremental (or full first run)
 *   node sync_stripe_connect_net.mjs --full     # force full backfill
 *   node sync_stripe_connect_net.mjs --months=13
 *   node sync_stripe_connect_net.mjs --since=2025-06-01
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const OUT = path.join(ROOT, '_etl_scripts/cache/stripe_connect_net.json');
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
else if (argMonths) { const d = new Date(); d.setMonth(d.getMonth() - Number(argMonths)); createdGte = Math.floor(d.getTime() / 1000); }
else if (!FULL && prev?.max_created) { createdGte = prev.max_created + 1; incremental = true; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(startingAfter) {
  const qs = new URLSearchParams({ limit: '100' });
  if (startingAfter) qs.set('starting_after', startingAfter);
  if (createdGte) qs.set('created[gte]', String(createdGte));
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch('https://api.stripe.com/v1/balance_transactions?' + qs.toString(), { headers: { Authorization: AUTH } });
      if (res.status === 429 || res.status >= 500) { await sleep(1000 * (attempt + 1)); continue; }
      const body = await res.json();
      if (res.status !== 200) throw new Error(`Stripe ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 200)}`);
      return body;
    } catch (e) {
      lastErr = e;
      if (/^Stripe 4/.test(String(e.message || ''))) throw e;
      await sleep(1000 * (attempt + 1)); // network/transient — retry
    }
  }
  throw new Error(`Stripe: retries exhausted${lastErr ? ` (${lastErr.message})` : ''}`);
}

// --- aggregate -------------------------------------------------------------
const monthly = new Map();   // 'YYYY-MM' -> { fee, refund, count }
const currencies = new Map();
let maxCreated = 0;

if (incremental && prev) {
  for (const r of prev.monthly || []) monthly.set(r.month, { fee: r.fee_net_usd, refund: r.refund_net_usd, count: r.count });
  for (const [c, n] of Object.entries(prev.currencies || {})) currencies.set(c, n);
  maxCreated = prev.max_created || 0;
}

const KEEP = new Set(['application_fee', 'application_fee_refund']);
let cursor = null, pages = 0, kept = 0;
const t0 = Date.now();
for (;;) {
  const page = await getPage(cursor);
  for (const t of page.data) {
    if (t.created > maxCreated) maxCreated = t.created;
    if (!KEEP.has(t.type)) continue;
    const cur = (t.currency || 'usd').toUpperCase();
    currencies.set(cur, (currencies.get(cur) || 0) + 1);
    const month = new Date(t.created * 1000).toISOString().slice(0, 7);
    const mm = monthly.get(month) || { fee: 0, refund: 0, count: 0 };
    if (t.type === 'application_fee') { mm.fee += (t.net || 0) / 100; mm.count += 1; }
    else { mm.refund += (t.net || 0) / 100; } // already negative
    monthly.set(month, mm);
    kept += 1;
  }
  pages += 1;
  if (pages % 10 === 0) process.stderr.write(`  …${pages} pages, ${kept} connect-net rows\n`);
  if (!page.has_more || page.data.length === 0) break;
  cursor = page.data[page.data.length - 1].id;
}

const r2 = (v) => Math.round(v * 100) / 100;
const monthlyRows = [...monthly.entries()].sort().map(([month, v]) => ({
  month,
  fee_net_usd: r2(v.fee),
  refund_net_usd: r2(v.refund),
  net_usd: r2(v.fee + v.refund),
  count: v.count,
}));
const totalNet = r2(monthlyRows.reduce((s, r) => s + r.net_usd, 0));

const out = {
  source: 'stripe_api:balance_transactions',
  basis: 'net settled in USD (what hits the bank — Stripe FX already applied, net of refunds)',
  fetchedAt: new Date().toISOString(),
  max_created: maxCreated,
  window: argSince || (argMonths ? `trailing ${argMonths}mo` : incremental ? 'incremental' : 'all-time'),
  currencies: Object.fromEntries(currencies), // settlement ccy of each bt (expect USD)
  totals: { net_usd: totalNet, months: monthlyRows.length },
  monthly: monthlyRows,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
process.stderr.write(`✓ stripe_connect_net.json: ${kept} rows · net $${Math.round(totalNet).toLocaleString()} USD settled · ${monthlyRows.length} months · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
if (currencies.size > 1) process.stderr.write(`⚠ balance-txn settlement currencies: ${[...currencies.keys()].join(', ')} (expected USD only)\n`);
