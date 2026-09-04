#!/usr/bin/env node
/**
 * Pull Stripe INVOICES — the basis for subscription-state / accrual MRR.
 *
 * PRINCIPLE: cash timing (when a card clears) must never move MRR or recognized
 * revenue — it only moves the AR balance. So MRR is driven off what was BILLED
 * for a service period, not what was CAPTURED. An invoice carries exactly that:
 *   - line `period.start/end` → the service period (recognition window)
 *   - line amount               → the recurring value earned that period
 *   - status (paid/open/uncollectible/void) + amount_due/amount_paid → collections/AR
 *
 * A card failure = an `open` invoice: the revenue is still earned (subscription
 * unchanged), it just sits in AR until the card clears. It must NOT read as
 * contraction/churn.
 *
 * This is a PARALLEL, read-only data source for the invoice-driven MRR prototype.
 * It does not touch the live charge-based pipeline.
 *
 * Output: _etl_scripts/cache/stripe_invoices.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '_etl_scripts/cache/stripe_invoices.json');
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

// ALWAYS a full pull. An incremental pull keyed on `created` never re-fetches an
// existing invoice, so an invoice that was OPEN in one month and PAID the next
// would keep its stale status forever — which breaks the month-end reconciliation
// cutoff (Cabredo: billed 8/26, paid in Sept). A full pull of ~4K invoices is
// ~30s, so freshness wins. `--full` is accepted for compatibility (no-op).
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return null; } })();
const createdGt = null;

async function getPage(startingAfter) {
  const qs = new URLSearchParams({ limit: '100' });
  qs.append('expand[]', 'data.lines.data.price'); // need recurring flag on each line
  if (startingAfter) qs.set('starting_after', startingAfter);
  if (createdGt) qs.set('created[gt]', String(createdGt));
  for (let a = 0; a < 6; a++) {
    let res;
    try { res = await fetch('https://api.stripe.com/v1/invoices?' + qs, { headers: { Authorization: AUTH } }); }
    catch { await sleep(500 * (a + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(500 * (a + 1)); continue; }
    const body = await res.json();
    if (res.status !== 200) throw new Error(`Stripe ${res.status}: ${body?.error?.message || ''}`);
    return body;
  }
  throw new Error('Stripe: retries exhausted');
}

const r2 = (v) => Math.round(v * 100) / 100;
const iso = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null);

// Seed from previous cache for incremental appends.
const byCust = new Map();
if (createdGt && prev?.by_customer) for (const [cus, v] of Object.entries(prev.by_customer)) {
  byCust.set(cus, { invoices: [...(v.invoices || [])] });
}
let maxCreated = createdGt ? (prev?.max_created || 0) : 0;

let cursor = null, pages = 0, scanned = 0, kept = 0, draftSkipped = 0;
const t0 = Date.now();
for (;;) {
  const page = await getPage(cursor);
  for (const inv of page.data) {
    scanned++;
    if (inv.created > maxCreated) maxCreated = inv.created;
    if (inv.status === 'draft') { draftSkipped++; continue; } // not finalized → not billed yet
    const cus = inv.customer;
    if (!cus) continue;

    // Break each line into a compact record with its OWN service period + whether
    // it's a recurring (subscription) charge. A line's period.start === period.end
    // (zero span) marks a manual/one-off invoice item — flagged so the prototype
    // can apply a fallback for manual-billing customers.
    const lines = (inv.lines?.data || []).map((l) => ({
      a: r2((l.amount || 0) / 100),
      ps: iso(l.period?.start),
      pe: iso(l.period?.end),
      rec: !!(l.price?.recurring) || l.type === 'subscription',
      manual: !!(l.period && l.period.start === l.period.end),
    }));
    const sub = r2(lines.filter((l) => l.rec).reduce((s, l) => s + l.a, 0));
    const svc = r2(lines.filter((l) => !l.rec).reduce((s, l) => s + l.a, 0));

    const e = byCust.get(cus) || { invoices: [] };
    e.invoices.push({
      id: inv.id,
      d: iso(inv.created),
      status: inv.status,                 // open / paid / uncollectible / void
      // Status-transition dates — the month-end reconciliation cutoff depends on
      // WHEN an invoice was paid, not just whether it is paid today.
      paid_at: iso(inv.status_transitions?.paid_at),
      voided_at: iso(inv.status_transitions?.voided_at),
      uncollectible_at: iso(inv.status_transitions?.marked_uncollectible_at),
      finalized_at: iso(inv.status_transitions?.finalized_at),
      due: r2((inv.amount_due || 0) / 100),
      paid: r2((inv.amount_paid || 0) / 100),
      remaining: r2((inv.amount_remaining || 0) / 100),
      ps: iso(inv.period_start),
      pe: iso(inv.period_end),
      sub, svc,
      lines,
    });
    byCust.set(cus, e);
    kept++;
  }
  pages++;
  if (pages % 10 === 0) process.stderr.write(`  …${pages} pages, ${scanned} scanned\n`);
  if (!page.has_more || page.data.length === 0) break;
  cursor = page.data[page.data.length - 1].id;
}

const by_customer = Object.fromEntries([...byCust.entries()].map(([c, v]) => [c, {
  invoices: v.invoices.sort((a, b) => (a.d || '').localeCompare(b.d || '')),
}]));
// AR = finalized-but-unpaid (open/uncollectible) remaining balance.
let arTotal = 0, openCount = 0;
for (const v of Object.values(by_customer)) for (const inv of v.invoices) {
  if ((inv.status === 'open' || inv.status === 'uncollectible') && inv.remaining > 0) { arTotal += inv.remaining; openCount++; }
}

fs.writeFileSync(OUT, JSON.stringify({
  source: 'stripe_api:invoices',
  fetchedAt: new Date().toISOString(),
  basis: 'billed recurring value by service period (accrual); status carries collections/AR',
  max_created: maxCreated,
  totals: {
    invoices_kept: kept, customers: byCust.size, draft_skipped: draftSkipped,
    ar_open_total: r2(arTotal), ar_open_count: openCount,
  },
  by_customer,
}, null, 2));
process.stderr.write(`✓ stripe_invoices.json: ${scanned} invoices, ${kept} kept · ${byCust.size} customers · AR(open) $${Math.round(arTotal).toLocaleString()} (${openCount}) · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
