#!/usr/bin/env node
/**
 * Split invoice-paid charges by their invoice LINES before profiles are built.
 *
 * From Sep 2026 one Stripe subscription carries several products — Core, Support,
 * Implementation — and the whole charge lands as type "subscription" in the charges
 * cache (sync_stripe.mjs classifies the charge, not its lines). Beau's product map
 * (product_revenue_types.json) says Implementation and Support are SERVICES, not MRR
 * (decided 2026-11-09). This step moves the services share of each such charge to a
 * separate `t: 'services'` row so customer_profiles, mrr_by_month, the cash waterfall
 * and Overview all carry it as services — matching build_revenue_recognition, which
 * drops the same lines from the recognized subscription series.
 *
 * Charge → invoice: the charge's `inv` id when sync_stripe recorded it; otherwise the
 * paid invoice on the same Stripe customer with the same paid date and amount.
 * Only invoices with at least one line whose product maps to "services" are split.
 *
 * Idempotent: split rows carry `sp: 1` and are skipped on re-run. Rewrites
 * cache/stripe_charges.json in place and re-derives each touched customer's totals
 * and by_month exactly as sync_stripe.mjs does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const CH_PATH = path.join(ROOT, '_etl_scripts/cache/stripe_charges.json');
const INV_PATH = path.join(ROOT, '_etl_scripts/cache/stripe_invoices.json');
if (!fs.existsSync(CH_PATH) || !fs.existsSync(INV_PATH)) { console.error('[line-split] charges or invoices cache missing — skipped'); process.exit(0); }

const r2 = (v) => Math.round(v * 100) / 100;
const CH = JSON.parse(fs.readFileSync(CH_PATH, 'utf8'));
const INV = JSON.parse(fs.readFileSync(INV_PATH, 'utf8'));
const PRODUCTS = JSON.parse(fs.readFileSync(path.join(ROOT, '_etl_scripts/product_revenue_types.json'), 'utf8')).products || {};
const isService = (prod) => !!prod && PRODUCTS[prod]?.revenue_type === 'services';

// Services share of each invoice that has a services-product line.
function servicesShare(inv) {
  const lines = (inv.lines || []).filter((l) => l.a);
  if (!lines.some((l) => isService(l.prod))) return 0;
  const total = lines.reduce((s, l) => s + l.a, 0);
  if (total <= 0) return 0;
  return lines.filter((l) => isService(l.prod)).reduce((s, l) => s + l.a, 0) / total;
}

let split = 0, splitAmount = 0, unmatched = 0;
const touched = new Set();
for (const [cus, e] of Object.entries(CH.by_customer || {})) {
  const invs = (INV.by_customer?.[cus]?.invoices || []).filter((i) => i.status === 'paid');
  if (!invs.some((i) => servicesShare(i) > 0)) continue;
  const byId = new Map(invs.map((i) => [i.id, i]));
  const used = new Set();
  const out = [];
  for (const t of e.transactions || []) {
    out.push(t);
    if (t.sp || t.t !== 'subscription') continue;
    const gross = r2((t.a || 0) + (t.r || 0));
    let inv = t.inv ? byId.get(t.inv) : null;
    if (!inv) {
      inv = invs.find((i) => !used.has(i.id) && (i.paid_at || i.d) === t.d && Math.abs((i.paid || 0) - gross) < 0.01);
    }
    if (!inv) { if (invs.some((i) => (i.paid_at || i.d) === t.d && servicesShare(i) > 0)) unmatched++; continue; }
    used.add(inv.id);
    const share = servicesShare(inv);
    if (!share) continue;
    const svcAmt = r2((t.a || 0) * share);
    const svcRef = r2((t.r || 0) * share);
    t.a = r2((t.a || 0) - svcAmt);
    t.r = r2((t.r || 0) - svcRef);
    t.sp = 1;
    if (!t.inv) t.inv = inv.id;
    out.push({ d: t.d, a: svcAmt, t: 'services', r: svcRef, i: t.i, inv: inv.id, sp: 1 });
    split++; splitAmount += svcAmt; touched.add(cus);
  }
  e.transactions = out;
}

// Re-derive totals + by_month for touched customers (same rules as sync_stripe.mjs).
for (const cus of touched) {
  const e = CH.by_customer[cus];
  const by_month = {};
  let subscription = 0, services = 0, refunded = 0;
  for (const t of e.transactions) {
    const type = t.t === 'services' ? 'services' : 'subscription';
    const m = String(t.d).slice(0, 7);
    const mm = by_month[m] || { subscription: 0, services: 0 };
    mm[type] = r2(mm[type] + (t.a || 0));
    by_month[m] = mm;
    if (type === 'services') services = r2(services + (t.a || 0)); else subscription = r2(subscription + (t.a || 0));
    refunded = r2(refunded + (t.r || 0));
  }
  Object.assign(e, { subscription, services, refunded, count: e.transactions.length, by_month });
}
if (touched.size) {
  CH.line_split = { applied_at: new Date().toISOString(), rule: 'services-product invoice lines moved from subscription to services (product_revenue_types.json)' };
  fs.writeFileSync(CH_PATH, JSON.stringify(CH));
}
console.error(`[line-split] ${split} charge(s) split across ${touched.size} customer(s): $${r2(splitAmount)} moved subscription → services${unmatched ? ` · ⚠ ${unmatched} charge(s) on a services-line invoice date could not be matched` : ''}`);
