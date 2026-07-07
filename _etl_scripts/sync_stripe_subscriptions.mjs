#!/usr/bin/env node
/**
 * Pull Stripe SUBSCRIPTIONS → the authoritative map of which Stripe *customer*
 * holds a company's live subscription.
 *
 * A company can have multiple Stripe Customer IDs (acquired over time); the one we
 * treat as MAIN/CURRENT is whichever customer owns the ACTIVE subscription
 * (active / past_due / trialing / unpaid — i.e. a live sub, incl. one that's just
 * failing a card). build_customer_profiles reads this to set
 * primary_stripe_customer_id.
 *
 * NOTE: the restricted key defaults to a pre-2016 API version that rejects
 * status=all, so we pin a modern Stripe-Version for this pull.
 *
 * Output: _etl_scripts/cache/stripe_subscriptions.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_etl_scripts/cache/stripe_subscriptions.json');
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
const API_VERSION = '2023-10-16';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rank of a subscription status for "which is the current account". A live sub
// (even past_due / unpaid — failing but not cancelled) outranks a cancelled one.
const STATUS_RANK = { active: 6, trialing: 5, past_due: 4, unpaid: 3, paused: 2, incomplete: 1, canceled: 0, incomplete_expired: 0 };

async function getPage(startingAfter) {
  const qs = new URLSearchParams({ limit: '100', status: 'all' });
  if (startingAfter) qs.set('starting_after', startingAfter);
  for (let a = 0; a < 6; a++) {
    let res;
    try { res = await fetch('https://api.stripe.com/v1/subscriptions?' + qs, { headers: { Authorization: AUTH, 'Stripe-Version': API_VERSION } }); }
    catch { await sleep(500 * (a + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (a + 1)); continue; }
    const body = await res.json();
    if (res.status !== 200) throw new Error(`Stripe ${res.status}: ${body?.error?.message || ''}`);
    return body;
  }
  throw new Error('Stripe: retries exhausted');
}

const iso = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);
const bySubscription = {};
const byCustomer = {};   // cus -> best (highest-ranked, latest) sub
const byStatus = {};
let cursor = null, total = 0, pages = 0;
const t0 = Date.now();
for (;;) {
  const page = await getPage(cursor);
  for (const s of page.data) {
    total++;
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    const rec = { customer: s.customer, status: s.status, current_period_end: iso(s.current_period_end) };
    bySubscription[s.id] = rec;
    const cur = byCustomer[s.customer];
    const better = !cur
      || (STATUS_RANK[s.status] ?? 0) > (STATUS_RANK[cur.status] ?? 0)
      || ((STATUS_RANK[s.status] ?? 0) === (STATUS_RANK[cur.status] ?? 0) && String(rec.current_period_end) > String(cur.current_period_end));
    if (better) byCustomer[s.customer] = { status: s.status, current_period_end: rec.current_period_end, subscription: s.id };
  }
  pages++;
  if (!page.has_more || page.data.length === 0) break;
  cursor = page.data[page.data.length - 1].id;
}

fs.writeFileSync(OUT, JSON.stringify({
  source: 'stripe_api:subscriptions',
  fetchedAt: new Date().toISOString(),
  apiVersion: API_VERSION,
  totals: { subscriptions: total, distinct_customers: Object.keys(byCustomer).length, by_status: byStatus },
  by_customer: byCustomer,
  by_subscription: bySubscription,
}, null, 2));
process.stderr.write(`✓ stripe_subscriptions.json: ${total} subs (${pages}p) · ${Object.keys(byCustomer).length} customers · ${JSON.stringify(byStatus)} · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
