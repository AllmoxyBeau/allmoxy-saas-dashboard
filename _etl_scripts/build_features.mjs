#!/usr/bin/env node
/**
 * Build the Features snapshot — DEV-board tickets weighted by the revenue of
 * the customers tagged on them. A Customer Success → Dev prioritization signal:
 * "this ticket is wanted by N customers worth $X MRR."
 *
 * Inputs:
 *   _etl_scripts/cache/jira_features.json     (DEV tickets + customer label tags)
 *   public/snapshots/customer_profiles.json   (revenue per customer)
 *
 * Join: each ticket's "Customer" labels (e.g. "LewisCabinetSpecialties",
 * "ciminos") are normalized-name matched to the customer roster, then we sum
 * their MRR / ARR / lifetime. Unmatched labels are surfaced for hygiene.
 *
 * Output: public/snapshots/features.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const features = read(path.join(ROOT, '_etl_scripts/cache/jira_features.json'));
const profiles = read(path.join(ROOT, 'public/snapshots/customer_profiles.json')).rows || [];

// The "Customer" labels are concatenated (no spaces), e.g. "HartleyGroupCoatings",
// "LewisCabinetSpecialties", so word-boundary stripping can't fire on them. Match
// in two tiers, both on lowercase-alphanumeric-only strings:
//   1. plain:  "HartleyGroupCoatings" == "Hartley Group Coatings"
//   2. suffix-stripped: drop common legal/org suffix tokens so a label that
//      omits them still matches a roster name that includes them
//      ("LewisCabinetSpecialties" == "Lewis Cabinet Specialties Group LLC").
const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const stripSuffix = (s) => plain(s).replace(/(llc|incorporated|inc|ltd|corp|company|group)/g, '');

const byPlain = new Map();
const byStrip = new Map();
for (const p of profiles) {
  const pl = plain(p.name);
  if (pl && !byPlain.has(pl)) byPlain.set(pl, p);
  const st = stripSuffix(p.name);
  if (st && !byStrip.has(st)) byStrip.set(st, p);
}
const matchCustomer = (label) => byPlain.get(plain(label)) || byStrip.get(stripSuffix(label)) || null;

const round2 = (v) => Math.round(v * 100) / 100;

const rows = features.tickets.map((t) => {
  const matched = [];
  const unmatched = [];
  for (const label of t.customers) {
    const p = matchCustomer(label);
    if (p) {
      matched.push({
        allmoxy_customer_id: p.allmoxy_customer_id,
        name: p.name,
        mrr: round2(p.current_subscription_mrr || 0),
        lifetime: round2(p.lifetime_total || 0),
        status: p.status,
      });
    } else {
      unmatched.push(label);
    }
  }
  // Dedupe matched by customer id (a ticket could list the same customer twice).
  const seen = new Set();
  const customers = matched.filter((m) => (seen.has(m.allmoxy_customer_id) ? false : seen.add(m.allmoxy_customer_id)));
  const totalMrr = round2(customers.reduce((s, c) => s + c.mrr, 0));
  const activeCustomers = customers.filter((c) => c.status !== 'churned' && c.status !== 'never_paid');
  return {
    ...t,
    customers: customers.sort((a, b) => b.mrr - a.mrr),
    tag_count: t.customers.length,
    customer_count: customers.length,
    active_customer_count: activeCustomers.length,
    total_mrr: totalMrr,
    total_arr: round2(totalMrr * 12),
    total_lifetime: round2(customers.reduce((s, c) => s + c.lifetime, 0)),
    unmatched_labels: unmatched,
  };
});

// Default sort: highest revenue weight first.
rows.sort((a, b) => b.total_mrr - a.total_mrr || b.customer_count - a.customer_count);

const open = rows.filter((r) => r.stage_category !== 'Done');
const aggregates = {
  total_tickets: rows.length,
  open_tickets: open.length,
  done_tickets: rows.length - open.length,
  tickets_with_matched_customer: rows.filter((r) => r.customer_count > 0).length,
  open_mrr_at_stake: round2(open.reduce((s, r) => s + r.total_mrr, 0)),
  distinct_customers_tagged: new Set(rows.flatMap((r) => r.customers.map((c) => c.allmoxy_customer_id))).size,
  unmatched_labels: [...new Set(rows.flatMap((r) => r.unmatched_labels))].sort(),
};

const OUT = path.join(ROOT, 'public/snapshots/features.json');
fs.writeFileSync(OUT, JSON.stringify({
  tab: 'features',
  fetchedAt: new Date().toISOString(),
  jira_fetchedAt: features.fetchedAt,
  note: 'DEV-board tickets tagged with customers (Customer labels field), joined to customer revenue. Revenue weight = sum of tagged customers\' current MRR. A CS→Dev prioritization signal.',
  aggregates,
  rows,
}, null, 2));

console.log(`✓ features.json: ${rows.length} DEV tickets (${aggregates.open_tickets} open)`);
console.log(`  ${aggregates.tickets_with_matched_customer} tickets matched ≥1 customer · ${aggregates.distinct_customers_tagged} distinct customers`);
console.log(`  Open MRR at stake (sum across open tickets): $${aggregates.open_mrr_at_stake.toLocaleString()}`);
if (aggregates.unmatched_labels.length) console.log(`  ${aggregates.unmatched_labels.length} unmatched labels: ${aggregates.unmatched_labels.slice(0, 20).join(', ')}`);
