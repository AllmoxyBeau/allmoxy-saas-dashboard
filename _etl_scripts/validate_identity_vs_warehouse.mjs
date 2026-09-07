#!/usr/bin/env node
/**
 * Validate our customer identity against the Aurora medallion warehouse.
 *
 * READ-ONLY. Changes no behaviour and no other snapshot — it only reports drift.
 * This is the safe first slice of the warehouse migration: prove `silver_customers`
 * agrees with us before anything depends on it.
 *
 * WHY: the Stripe-customer → Allmoxy-customer mapping is currently maintained by hand
 * in stripe_id_overrides.json / customer_merge_overrides.json, and getting it wrong is
 * expensive but silent — a Stripe id on two profiles double-counts revenue, an
 * unmapped id drops revenue out of MRR entirely. Every such case we found in Sept 2026
 * (Fox Creek unmapped, Wizzwood #333/#330 and Elite #285/#360 duplicated) was ALREADY
 * correct in silver_customers. This catches the next one automatically.
 *
 * Checks, per Stripe customer id:
 *   1. MISMATCH   — warehouse maps it to a different allmoxy_customer_id than we do
 *   2. UNMAPPED   — we have revenue on an id no profile owns, and the warehouse knows who
 *   3. DUPLICATE  — one Stripe id sits on 2+ of our profiles (double-count risk)
 *   4. UNKNOWN    — neither we nor the warehouse can place it (needs a customer record)
 *   5. STALE_OVERRIDE — a hand-maintained override the warehouse now agrees with, i.e.
 *                       retireable once identity moves to the warehouse
 *
 * Output: public/snapshots/identity_validation.json
 * Skips cleanly (exit 0, marks unavailable) when Aurora is unreachable, so it can sit
 * in the nightly pipeline without ever breaking a refresh.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const OUT = path.join(SNAP, 'identity_validation.json');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const ENV = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);

const profiles = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];
const charges = read(path.join(ROOT, '_etl_scripts/cache/stripe_charges.json'), { by_customer: {} }).by_customer || {};
const overrides = read(path.join(ROOT, '_etl_scripts/stripe_id_overrides.json'), { overrides: [] }).overrides || [];
const merges = read(path.join(ROOT, '_etl_scripts/customer_merge_overrides.json'), { merges: {} }).merges || {};

function write(payload) { fs.writeFileSync(OUT, JSON.stringify(payload)); }

// ── our mapping: stripe customer id → [aid, ...] (2+ means a double-count risk) ──
const ours = new Map();
for (const p of profiles) {
  for (const cid of (p.stripe_customer_ids || [])) {
    if (!ours.has(cid)) ours.set(cid, []);
    ours.get(cid).push(p.allmoxy_customer_id);
  }
}
const nameByAid = new Map(profiles.map((p) => [p.allmoxy_customer_id, p.customer_name || p.hubspot_instance_name || p.name]));
// Lifetime revenue per Stripe id — how much is at stake if the mapping is wrong.
const revByCid = new Map();
for (const [cid, e] of Object.entries(charges)) revByCid.set(cid, r2((e.subscription || 0) + (e.services || 0)));

const overrideByCid = new Map();
for (const o of overrides) for (const cid of (o.stripe_customer_ids || [])) overrideByCid.set(cid, o.allmoxy_customer_id);

let conn;
try {
  const mysql = await import('mysql2/promise');
  conn = await mysql.default.createConnection({
    host: ENV.AURORA_HOST, port: Number(ENV.AURORA_PORT || 3306),
    user: ENV.AURORA_USER, password: ENV.AURORA_PASSWORD, connectTimeout: 20000,
  });
} catch (e) {
  console.error(`[identity] Aurora unreachable — skipped (${e.code || e.message})`);
  write({ tab: 'identity_validation', fetchedAt: new Date().toISOString(), available: false, reason: String(e.code || e.message), findings: [], totals: {} });
  process.exit(0);
}

// ── warehouse mapping. STRIPE_CUSTOMER_ID is a longtext that can hold several ids. ──
const wh = new Map(); // cid -> { aid, name }
try {
  const [rows] = await conn.query('SELECT allmoxy_customer_id, NAME, STRIPE_CUSTOMER_ID FROM silver.silver_customers');
  for (const r of rows) {
    const aid = r.allmoxy_customer_id; if (aid == null) continue;
    for (const cid of String(r.STRIPE_CUSTOMER_ID || '').match(/cus_[A-Za-z0-9]+/g) || []) {
      wh.set(cid, { aid, name: r.NAME });
    }
  }
} catch (e) {
  console.error(`[identity] silver_customers query failed — skipped (${e.message})`);
  await conn.end();
  write({ tab: 'identity_validation', fetchedAt: new Date().toISOString(), available: false, reason: e.message, findings: [], totals: {} });
  process.exit(0);
}
await conn.end();

// ── compare ──
const findings = [];
const allCids = new Set([...ours.keys(), ...wh.keys(), ...revByCid.keys()]);
for (const cid of allCids) {
  const mine = ours.get(cid) || [];
  const theirs = wh.get(cid) || null;
  const revenue = revByCid.get(cid) ?? 0;
  const base = { stripe_customer: cid, revenue, our_aids: mine, our_name: mine.length ? nameByAid.get(mine[0]) ?? null : null, warehouse_aid: theirs?.aid ?? null, warehouse_name: theirs?.name ?? null };

  if (mine.length > 1) {
    findings.push({ ...base, kind: 'DUPLICATE', severity: 'error', detail: `One Stripe customer sits on ${mine.length} profiles (${mine.join(', ')}) — its revenue is counted ${mine.length}×.${theirs ? ` The warehouse has a single row, #${theirs.aid}.` : ''}`, suggested_fix: theirs ? `Merge into #${theirs.aid} via customer_merge_overrides.json` : 'Merge the duplicate profiles' });
    continue;
  }
  if (mine.length === 1 && theirs && mine[0] !== theirs.aid) {
    findings.push({ ...base, kind: 'MISMATCH', severity: 'error', detail: `We map this to #${mine[0]} (${nameByAid.get(mine[0]) ?? '?'}); the warehouse says #${theirs.aid} (${theirs.name}).`, suggested_fix: `Confirm which is right — if the warehouse, remap to #${theirs.aid}` });
    continue;
  }
  if (mine.length === 0 && revenue > 0) {
    findings.push({
      ...base,
      kind: theirs ? 'UNMAPPED' : 'UNKNOWN',
      severity: revenue >= 1000 ? 'error' : 'warn',
      detail: theirs
        ? `$${Math.round(revenue).toLocaleString()} of revenue on a Stripe customer no profile owns. The warehouse knows it: #${theirs.aid} (${theirs.name}).`
        : `$${Math.round(revenue).toLocaleString()} of revenue on a Stripe customer neither we nor the warehouse can place — likely a new signup with no customer record yet.`,
      suggested_fix: theirs ? `Add to stripe_id_overrides.json → #${theirs.aid}` : 'Create the customer record (Aurora/HubSpot), then it maps itself',
    });
    continue;
  }
  // Agreement — flag hand-maintained overrides the warehouse now confirms.
  if (mine.length === 1 && theirs && mine[0] === theirs.aid && overrideByCid.get(cid) === mine[0]) {
    findings.push({ ...base, kind: 'STALE_OVERRIDE', severity: 'info', detail: `Our hand-written override matches the warehouse (#${theirs.aid}) — it would be redundant once identity comes from silver_customers.`, suggested_fix: 'Retire this override when migrating identity' });
  }
}

const sev = { error: 0, warn: 1, info: 2 };
findings.sort((a, b) => sev[a.severity] - sev[b.severity] || b.revenue - a.revenue);

// Do the hand-maintained merges agree with the warehouse?
const mergeCheck = [];
for (const [from, m] of Object.entries(merges)) {
  const fromAid = Number(from), intoAid = m.into;
  const stillSplit = profiles.some((p) => p.allmoxy_customer_id === fromAid);
  const whRows = [...wh.values()].filter((v) => v.aid === fromAid || v.aid === intoAid);
  const whAids = [...new Set(whRows.map((v) => v.aid))];
  mergeCheck.push({
    from: fromAid, into: intoAid, our_state: stillSplit ? 'NOT applied' : 'applied',
    warehouse_aids: whAids,
    agrees: whAids.length <= 1 && (whAids.length === 0 || whAids[0] === intoAid),
    note: m._note ? String(m._note).slice(0, 200) : null,
  });
}

const totals = {
  stripe_customers_compared: allCids.size,
  warehouse_rows: wh.size,
  errors: findings.filter((f) => f.severity === 'error').length,
  warnings: findings.filter((f) => f.severity === 'warn').length,
  retireable_overrides: findings.filter((f) => f.kind === 'STALE_OVERRIDE').length,
  revenue_at_risk: r2(findings.filter((f) => f.severity === 'error').reduce((s, f) => s + f.revenue, 0)),
  by_kind: findings.reduce((a, f) => { a[f.kind] = (a[f.kind] || 0) + 1; return a; }, {}),
};

write({
  tab: 'identity_validation',
  fetchedAt: new Date().toISOString(),
  available: true,
  source: 'silver.silver_customers (Aurora medallion warehouse)',
  totals, findings, merge_check: mergeCheck,
  notes: 'Read-only comparison of our Stripe→Allmoxy customer mapping against silver_customers. Nothing here changes behaviour; it reports drift so a mis-mapped Stripe customer (double-counted or dropped revenue) is caught the day it appears instead of during a reconciliation. Also lists hand-written overrides the warehouse now confirms — the retireable set if identity moves to the warehouse.',
});

console.error(`[identity] ${allCids.size} Stripe customers vs ${wh.size} warehouse rows · ${totals.errors} error(s), ${totals.warnings} warning(s) · $${Math.round(totals.revenue_at_risk).toLocaleString()} at risk · ${totals.retireable_overrides} retireable override(s)`);
