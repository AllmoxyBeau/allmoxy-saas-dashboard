#!/usr/bin/env node
/**
 * Services revenue by HOW it was billed (Beau, 2026-11-10): on a Stripe SUBSCRIPTION
 * (recurring Support / Implementation lines on the customer's subscription invoice)
 * versus INDIVIDUAL invoices and charges (one-off service invoices, direct charges).
 *
 * Source: the services rows apply_invoice_line_split.mjs split out of subscription
 * charges (t: 'services', sp: 1). Each is weighed by its invoice's RECURRING services
 * lines over all its services lines, so a one-off "Services" line that happens to sit on
 * an invoice (Evolve Elements, Jan 2026) stays individual. Same cash month and customer
 * name as services_by_month, so the two parts always add up to the services total.
 *
 * Adds services_by_month.subscriptionBilled = { monthlyTotals, byCustomer }.
 * Runs after apply_stripe_seam_monthly.mjs (which writes services_by_month).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const r2 = (v) => Math.round(v * 100) / 100;

const SVC_PATH = path.join(SNAP, 'services_by_month.json');
const CH = read(path.join(__dirname, 'cache/stripe_charges.json'));
const INV = read(path.join(__dirname, 'cache/stripe_invoices.json'));
const PRODUCTS = read(path.join(__dirname, 'product_revenue_types.json')).products || {};
const profiles = read(path.join(SNAP, 'customer_profiles.json')).rows;
const svc = read(SVC_PATH);

const nameByCus = new Map();
for (const p of profiles) for (const c of (p.stripe_customer_ids || [])) nameByCus.set(c, p.name);
const invById = new Map();
for (const c of Object.values(INV.by_customer || {})) for (const i of (c.invoices || [])) if (i.id) invById.set(i.id, i);
const isService = (l) => !!l.prod && PRODUCTS[l.prod]?.revenue_type === 'services';

const monthlyTotals = {};
const byCustomer = {};
let rows = 0;
for (const [cus, e] of Object.entries(CH.by_customer || {})) {
  const name = nameByCus.get(cus);
  for (const t of (e.transactions || [])) {
    if (t.t !== 'services' || !t.sp || !t.inv) continue;
    const inv = invById.get(t.inv); if (!inv) continue;
    const svcLines = (inv.lines || []).filter((l) => l.a && isService(l));
    const all = svcLines.reduce((s, l) => s + l.a, 0);
    const recurring = svcLines.filter((l) => l.rec && l.ps && l.pe && l.ps !== l.pe).reduce((s, l) => s + l.a, 0);
    if (!(all > 0) || !(recurring > 0)) continue;
    const amt = r2(((t.a || 0) - (t.r || 0)) * (recurring / all));
    if (!amt) continue;
    const m = String(t.d || '').slice(0, 7);
    monthlyTotals[m] = r2((monthlyTotals[m] || 0) + amt);
    if (name) { const o = byCustomer[name] || (byCustomer[name] = {}); o[m] = r2((o[m] || 0) + amt); }
    rows++;
  }
}
svc.subscriptionBilled = {
  note: 'Services billed as recurring lines on a Stripe subscription (Support / Implementation on the subscription invoice). The rest of each month is individual service invoices and charges.',
  monthlyTotals, byCustomer,
};
fs.writeFileSync(SVC_PATH, JSON.stringify(svc, null, 2));
console.error(`[services-split] ${rows} subscription-billed services payments · ${JSON.stringify(monthlyTotals)}`);
