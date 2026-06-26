#!/usr/bin/env node
// Build a comprehensive per-customer profile snapshot for the Customer Detail page.
// One row per allmoxy_customer_id with:
//   - identity (name, stripe ids, hubspot id, installer directory, signup date)
//   - lifetime totals by stream (subscription / services / connect)
//   - current MRR + active flag + dunning counts
//   - monthly_history: { month → {subscription, services, connect} }
//   - transactions: [{created, amount, type, status, description}]  (all Stripe charges)
//   - cohort_year + milestones (first_payment_date, last_payment_date, peak_month)

import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/node_modules/xlsx/xlsx.mjs';

const XLSX_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/Allmoxy - Meta Data Reconcile Tool.xlsx';
const SNAPSHOTS = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';

const wb = XLSX.read(fs.readFileSync(XLSX_PATH), { type: 'buffer' });

// ---------- HubSpot segment cache ----------
// The Hubspot Instance Sync Sheet tab only carries primary_segment_framework, not
// sub_segment_framework. To surface sub-segment in the dashboard we cache the field
// from HubSpot via the Claude MCP connector (the local HUBSPOT_TOKEN is 401-ing).
// Cache schema: { byHubspotId: { "<hs_object_id>": { primary, sub, name } } }.
// Refresh by re-pulling via MCP, or replace this step with a direct fetch_hubspot_segments.mjs
// once the token is rotated.
const HUBSPOT_SEGMENTS_CACHE_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/_etl_scripts/cache/hubspot_segments.json';
const hubspotSegmentsCache = fs.existsSync(HUBSPOT_SEGMENTS_CACHE_PATH)
  ? JSON.parse(fs.readFileSync(HUBSPOT_SEGMENTS_CACHE_PATH, 'utf8'))?.byHubspotId ?? {}
  : {};

// ---------- Live HubSpot API cache (produced by sync_hubspot.mjs) ----------
// When present, overlays live HubSpot-native values onto the xlsx-derived
// profile fields. Joins primarily by stripe_company_id with fallbacks to
// HubSpot Company ID. Only the HubSpot-native subset is overlaid — Pay Status,
// Subscription IDs, Churn Reason stay xlsx-sourced (those columns live in
// Stripe and the Allmoxy core DB, not in HubSpot). Refresh by running:
//   node _etl_scripts/sync_hubspot.mjs
// HubSpot checkbox (multi-select) properties come back as ';'-separated
// strings; normalize to a clean array.
const hsMulti = (v) => (v ? String(v).split(';').map((s) => s.trim()).filter(Boolean) : []);

const HUBSPOT_API_CACHE_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/_etl_scripts/cache/hubspot_companies.json';
const HUBSPOT_OWNERS_CACHE_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/_etl_scripts/cache/hubspot_owners.json';

// Live Instance custom-object status, keyed by installer_id. This is the LIVE
// pay status HubSpot shows on the Instance (e.g. "Active") — the xlsx Sync
// Sheet's Pay Status column lags, so we prefer this. Skip sandbox instances and
// prefer a real (non-empty) status when a customer has multiple instances.
const HUBSPOT_INSTANCES_CACHE_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/_etl_scripts/cache/hubspot_instances.json';
const instanceStatusByInstaller = new Map();
if (fs.existsSync(HUBSPOT_INSTANCES_CACHE_PATH)) {
  try {
    const inst = JSON.parse(fs.readFileSync(HUBSPOT_INSTANCES_CACHE_PATH, 'utf8')).instances || [];
    for (const i of inst) {
      if (!i.installer_id) continue;
      if (/sandbox|\bdev\b|\btest\b/i.test(i.account_name || '')) continue;
      const key = String(i.installer_id);
      // Prefer the first non-empty status seen for an installer_id.
      if (i.status && !instanceStatusByInstaller.get(key)) instanceStatusByInstaller.set(key, i.status);
    }
  } catch { /* ignore */ }
}

const hubspotLiveByStripeId = new Map();
const hubspotLiveByCompanyId = new Map();
// Merge redirect: stale HubSpot Company ID → current surviving Company ID.
// When HubSpot merges A into B, B's hs_merged_object_ids field gains A. We
// use this to redirect xlsx-sourced IDs (which freeze at the time of entry)
// to the current company. Critical because ~40 customer xlsx IDs reference
// since-merged companies, including ones with recent CS activity.
const hubspotMergeRedirect = new Map();
// Name fallback: normalized name → array of { id, lifecyclestage }. Used as
// last-resort fallback when the xlsx-sourced HubSpot id is wrong AND not in
// the merge redirect (data-entry typo). Multi-candidate collisions prefer the
// customer-lifecycle one.
const hubspotByNormalizedName = new Map();
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
let hubspotLiveLoadedAt = null;
if (fs.existsSync(HUBSPOT_API_CACHE_PATH)) {
  try {
    const cache = JSON.parse(fs.readFileSync(HUBSPOT_API_CACHE_PATH, 'utf8'));
    hubspotLiveLoadedAt = cache.fetched_at;
    for (const c of cache.companies || []) {
      if (c.stripe_company_id) hubspotLiveByStripeId.set(c.stripe_company_id, c);
      if (c.hs_object_id) hubspotLiveByCompanyId.set(String(c.hs_object_id), c);
      if (c.id) hubspotLiveByCompanyId.set(String(c.id), c);
      // Populate merge redirects: each id listed in hs_merged_object_ids
      // points to this surviving company.
      if (c.hs_merged_object_ids) {
        for (const oldId of String(c.hs_merged_object_ids).split(';').map(s => s.trim()).filter(Boolean)) {
          hubspotMergeRedirect.set(oldId, String(c.id));
        }
      }
      if (c.name) {
        const k = normName(c.name);
        if (!hubspotByNormalizedName.has(k)) hubspotByNormalizedName.set(k, []);
        hubspotByNormalizedName.get(k).push({ id: String(c.id), lifecyclestage: c.lifecyclestage || null });
      }
    }
    process.stderr.write(`HubSpot API enrichment cache loaded (${cache.companies?.length || 0} companies, ${hubspotMergeRedirect.size} merge redirects, ${hubspotByNormalizedName.size} unique names, fetched_at=${hubspotLiveLoadedAt})\n`);
  } catch (err) {
    process.stderr.write(`Warning: failed to load HubSpot API cache: ${err.message}\n`);
  }
}

// Resolve a (potentially stale) HubSpot Company ID to the current surviving
// one. Cascade:
//   1. xlsx id matches a current company → use as-is
//   2. xlsx id appears in another company's hs_merged_object_ids → redirect
//   3. customer name matches a HubSpot company name → use name match
//      (prefers lifecyclestage='customer' when multiple candidates).
// Step 3 catches data-entry typos in the xlsx where the HubSpot id was just
// wrong (not merged). Without it, ~14 customers including Ecodomo silently
// miss all HubSpot enrichment.
function resolveHubspotCompanyId(rawId, customerName) {
  if (rawId != null && rawId !== '') {
    const id = String(rawId).trim();
    if (hubspotLiveByCompanyId.has(id)) return id;
    const redirected = hubspotMergeRedirect.get(id);
    if (redirected) return redirected;
  }
  // Fall back to name match. Only triggers when the xlsx id is missing /
  // unknown to HubSpot (so we don't override a legitimately-set id).
  if (customerName) {
    const candidates = hubspotByNormalizedName.get(normName(customerName)) || [];
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length > 1) {
      const customer = candidates.find((c) => c.lifecyclestage === 'customer');
      return (customer || candidates[0]).id;
    }
  }
  return rawId != null && rawId !== '' ? String(rawId).trim() : null;
}
// Returns the live HubSpot row for a customer (by any of their stripe IDs, or
// their HubSpot Company ID). Returns null when no match. Picks the row with
// the freshest hs_lastmodifieddate when multiple match (multi-instance).
function hubspotLiveForCustomer(stripeIds, hubspotCompanyId) {
  const candidates = [];
  for (const id of stripeIds || []) {
    const hit = hubspotLiveByStripeId.get(id);
    if (hit) candidates.push(hit);
  }
  if (hubspotCompanyId) {
    const hit = hubspotLiveByCompanyId.get(String(hubspotCompanyId).trim());
    if (hit) candidates.push(hit);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // Multiple — prefer lifecycle=customer, then freshest modified date
  candidates.sort((a, b) => {
    const aIsCust = a.lifecyclestage === 'customer' ? 0 : 1;
    const bIsCust = b.lifecyclestage === 'customer' ? 0 : 1;
    if (aIsCust !== bIsCust) return aIsCust - bIsCust;
    const aDate = a.hs_lastmodifieddate || '';
    const bDate = b.hs_lastmodifieddate || '';
    return bDate.localeCompare(aDate);
  });
  return candidates[0];
}

// ---------- Synthetic transactions (off-Stripe payments: checks, wires, ACH) ----------
// Customers who pay via channels other than Stripe (mailed checks, bank wires,
// ACH transfers) have payments invisible to our raw Stripe ingest. This file
// injects them into the customer's transactions array so they flow through
// amortization, MRR, and waterfall just like Stripe charges. Keyed by
// allmoxy_customer_id; the injected transaction shape matches the Stripe
// transaction shape downstream code expects.
const SYNTHETIC_TXNS_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/_etl_scripts/synthetic_transactions.json';
const syntheticTxnsByCustomerId = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(SYNTHETIC_TXNS_PATH, 'utf8'));
  for (const t of raw.transactions ?? []) {
    const id = Number(t.allmoxy_customer_id);
    if (!Number.isFinite(id)) continue;
    if (!syntheticTxnsByCustomerId.has(id)) syntheticTxnsByCustomerId.set(id, []);
    syntheticTxnsByCustomerId.get(id).push({
      created: t.created,
      amount: t.amount,
      amount_refunded: t.amount_refunded ?? 0,
      net_amount: t.net_amount ?? t.amount,
      type: t.type,
      status: t.status ?? 'succeeded',
      description: t.description ?? '',
      // Mark synthetic so downstream code (and the Adjustments Register) can
      // distinguish off-Stripe payments from real Stripe charges.
      synthetic: true,
      payment_method: t.payment_method ?? 'unknown',
    });
  }
} catch (e) {
  console.warn('No synthetic_transactions.json found or unreadable:', e.message);
}

// ---------- Stripe ID overrides (manual injection for missing source IDs) ----------
// Used when allmoxy_core_customer's stripe_customer_id_* fields are empty for a
// customer who has charges in Stripe Sync — without this, the customer's
// transactions go orphan and they appear as a phantom "blank-named" row in the
// MRR by Month tab's totals.
const STRIPE_ID_OVERRIDES_PATH = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/_etl_scripts/stripe_id_overrides.json';
const stripeIdOverridesById = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(STRIPE_ID_OVERRIDES_PATH, 'utf8'));
  for (const o of raw.overrides ?? []) {
    if (Number.isFinite(Number(o.allmoxy_customer_id))) {
      stripeIdOverridesById.set(Number(o.allmoxy_customer_id), o.stripe_customer_ids ?? []);
    }
  }
} catch (e) {
  // No overrides file — that's fine, just skip.
}

// ---------- allmoxy_core_customer → roster ----------
const coreRaw = XLSX.utils.sheet_to_json(wb.Sheets['allmoxy_core_customer'], { range: 1, defval: null, raw: false });
const coreById = new Map();
for (const r of coreRaw) {
  const id = Number(r.allmoxy_customer_id);
  if (!Number.isFinite(id)) continue;
  const stripeIds = [r.stripe_customer_id_fromhubspot, r.stripe_customer_id_1, r.stripe_customer_id_2, r.stripe_customer_id_3]
    .filter((x) => x && String(x).startsWith('cus_'));
  // Merge in any manual overrides that aren't already in the source list.
  for (const ov of stripeIdOverridesById.get(id) ?? []) {
    if (ov && String(ov).startsWith('cus_') && !stripeIds.includes(ov)) stripeIds.push(ov);
  }
  coreById.set(id, {
    allmoxy_customer_id: id,
    name: String(r.name ?? '').trim(),
    sign_up_date: r.sign_up_date ?? null,
    hubspot_company_id: r.hubspot_company_id ? String(r.hubspot_company_id) : null,
    installer_id: r.installer_id ? String(r.installer_id) : null,
    installer_directory: r.installer_directory ?? null,
    stripe_customer_ids: stripeIds,
    harvest_id: r.harvest_id ? String(r.harvest_id) : null,
  });
}

// ---------- Hubspot Instance Sync Sheet → per-stripe-customer enrichment ----------
// Provides authoritative Stripe Subscription IDs, Pay Status (incl. "Cancelled"),
// Churn Reason, Primary Segment, Contract Status, plus the Custom Domain sub for
// the small set of customers who have a second sub. Joined to customer profiles
// via Stripe Company ID (cus_*) → match against allmoxy_core_customer's stripe ids.
//
// 22 customers have multiple Hubspot rows (Production + Sandbox / Pre-Sale pairs);
// Sandbox rows are typically marked Cancelled because the test instance was
// abandoned — they should NOT override the Production status. Resolution rules:
//   1) Realm priority: Production > Pre-Sale > Sandbox
//   2) Within same realm, prefer "active" pay statuses over Cancelled
const REALM_PRIORITY = { 'Production': 0, 'Pre-Sale': 1, 'Sandbox': 2, '(blank)': 3 };
const PAY_PRIORITY = {
  'Active': 0,
  'Active - Card Failure': 1,
  'Active - Pause Granted': 1,
  'Active - Partnership Free': 1,
  'Pre-Sale': 2,
  'Cancelled': 3,
  '(blank)': 4,
};
const hubspotByStripeId = new Map();
const hubspotByAllmoxyId = new Map();
const hubspotByHubspotCompanyId = new Map();
const hubspotByName = new Map();      // exact-match (normalized) → resolved entry
const hubspotNameAmbiguous = new Set(); // names that appear in 2+ rows (skip name-match)
{
  const hub = XLSX.utils.sheet_to_json(wb.Sheets['Hubspot Instance Sync Sheet'], { header: 1, defval: null, raw: false });
  const hubHdr = hub[1] || [];
  const HH = {};
  const HH_ALL = {}; // every column index per header name (for handling duplicates)
  hubHdr.forEach((c, i) => { if (c) {
    const k = String(c).trim();
    if (HH[k] == null) HH[k] = i;
    if (!HH_ALL[k]) HH_ALL[k] = [];
    HH_ALL[k].push(i);
  }});
  // The Sync Sheet has TWO "Pay Status" columns: the first is auto-fed from
  // Stripe events (lags reality — lingers as "Active - Card Failure" even
  // after the card is fixed), the second is the user-curated value in
  // HubSpot. We want the manually-curated one — override the index map for
  // Pay Status to the LAST occurrence so user edits take effect.
  if (HH_ALL['Pay Status'] && HH_ALL['Pay Status'].length > 1) {
    HH['Pay Status'] = HH_ALL['Pay Status'][HH_ALL['Pay Status'].length - 1];
  }
  // First pass: collect ALL rows, indexed by both Stripe Company ID and Allmoxy
  // Customer ID. Either key on a row is enough to join — many customers (e.g.,
  // Safina id 263) only have an Allmoxy Customer ID populated in HubSpot, no
  // Stripe Company ID, so a stripe-only join leaves them unsegmented.
  const rowsByStripeId = new Map();
  const rowsByAllmoxyId = new Map();
  const rowsByHubspotCompanyId = new Map();
  const rowsByName = new Map();
  function normName(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  for (let i = 2; i < hub.length; i++) {
    const row = hub[i];
    if (!row) continue;
    const get = (key) => {
      const idx = HH[key];
      if (idx == null) return null;
      const v = row[idx];
      if (v == null) return null;
      const s = String(v).trim();
      if (!s || s === '#N/A') return null;
      return s;
    };
    const stripeCustomerId = get('Stripe Company ID');
    const allmoxyIdRaw = get('Allmoxy Customer ID');
    const allmoxyId = allmoxyIdRaw != null ? Number(allmoxyIdRaw) : NaN;
    const hubspotCompanyId = get('Company ID');
    const instanceName = get('Instance Name');
    if (
      !(stripeCustomerId && stripeCustomerId.startsWith('cus_')) &&
      !Number.isFinite(allmoxyId) &&
      !hubspotCompanyId &&
      !instanceName
    ) continue;
    const realm = get('Realm') ?? '(blank)';
    const pay = get('Pay Status') ?? '(blank)';
    const entry = {
      instance_name: get('Instance Name'),
      stripe_subscription_id: get('Stripe Subscription ID'),
      custom_domain_stripe_subscription_id: get('Custom Domain Stripe Subscription ID'),
      pay_status: get('Pay Status'),
      contract_status: get('Contract Status'),
      churn_reason: get('Churn Reason'),
      primary_segment: get('Primary Segment'),
      hubspot_record_id: get('Record ID'),
      // HubSpot Company ID from Sync Sheet col B — used as fallback when the
      // core allmoxy_core_customer table doesn't have it (common for newer
      // customers added to HubSpot but not yet linked in core).
      hubspot_company_id_from_hub: hubspotCompanyId,
      // Instance owner from the Hubspot Sync Sheet: col Q = "Owner" (full name
      // or owner id), col R = "First name". Use First name as the display label
      // since that's what the CS team uses day-to-day.
      instance_owner: get('Owner'),
      instance_owner_first_name: get('First name'),
      // Production installer URL (subdomain). Authoritative when populated —
      // overrides the core record's installer_directory, which sometimes points
      // at the Sandbox subdomain (e.g. Dot Custom Cabinets: core says
      // "dotcabinetsusa2020", production is "dotcabinetsusa"). Resolution rules
      // (Production > Pre-Sale > Sandbox) ensure we pick the production row.
      directory: get('Directory'),
      installer_id_from_hub: get('Installer ID'),
      _realm: realm,
      _payRank: PAY_PRIORITY[pay] ?? 9,
      _realmRank: REALM_PRIORITY[realm] ?? 9,
    };
    if (stripeCustomerId && stripeCustomerId.startsWith('cus_')) {
      if (!rowsByStripeId.has(stripeCustomerId)) rowsByStripeId.set(stripeCustomerId, []);
      rowsByStripeId.get(stripeCustomerId).push(entry);
    }
    if (Number.isFinite(allmoxyId)) {
      if (!rowsByAllmoxyId.has(allmoxyId)) rowsByAllmoxyId.set(allmoxyId, []);
      rowsByAllmoxyId.get(allmoxyId).push(entry);
    }
    if (hubspotCompanyId) {
      const k = String(hubspotCompanyId).trim();
      if (!rowsByHubspotCompanyId.has(k)) rowsByHubspotCompanyId.set(k, []);
      rowsByHubspotCompanyId.get(k).push(entry);
    }
    if (instanceName) {
      const nk = normName(instanceName);
      if (nk) {
        if (!rowsByName.has(nk)) rowsByName.set(nk, []);
        rowsByName.get(nk).push(entry);
      }
    }
  }
  function resolveWinner(entries) {
    entries.sort((a, b) => a._realmRank - b._realmRank || a._payRank - b._payRank);
    const winner = entries[0];
    const allSubs = new Set();
    const allCustomDomainSubs = new Set();
    for (const e of entries) {
      if (e.stripe_subscription_id) allSubs.add(e.stripe_subscription_id);
      if (e.custom_domain_stripe_subscription_id) allCustomDomainSubs.add(e.custom_domain_stripe_subscription_id);
    }
    const { _realm, _realmRank, _payRank, ...clean } = winner;
    return {
      ...clean,
      all_stripe_subscription_ids: [...allSubs],
      all_custom_domain_stripe_subscription_ids: [...allCustomDomainSubs],
    };
  }
  for (const [key, entries] of rowsByStripeId) hubspotByStripeId.set(key, resolveWinner(entries));
  for (const [key, entries] of rowsByAllmoxyId) hubspotByAllmoxyId.set(key, resolveWinner(entries));
  for (const [key, entries] of rowsByHubspotCompanyId) hubspotByHubspotCompanyId.set(key, resolveWinner(entries));
  // Name-match index: only use when one HubSpot row uniquely owns a name. If the
  // same name appears in 2+ rows (after Production-vs-Sandbox dedup), we can't
  // safely route — record the name as ambiguous and skip name matching for it.
  for (const [key, entries] of rowsByName) {
    // Production-only-uniqueness check: if exactly one Production-realm row exists
    // for this name, that's safe to use. Sandbox-only or multiple-Production →
    // ambiguous.
    const prodRows = entries.filter((e) => e._realm === 'Production');
    if (prodRows.length === 1) {
      hubspotByName.set(key, resolveWinner(entries));
    } else if (prodRows.length === 0 && entries.length === 1) {
      hubspotByName.set(key, resolveWinner(entries));
    } else {
      hubspotNameAmbiguous.add(key);
    }
  }
}
// Cascading lookup: stripe_customer_id → allmoxy_customer_id → hubspot_company_id
// → exact instance name (only when uniquely owned). Each step is more lenient than
// the previous; first hit wins. This pulls in customers whose HubSpot row only has
// some join keys populated — Safina (allmoxy id only), NYDD (name only).
function hubspotForCustomer(stripeIds, allmoxyCustomerId, hubspotCompanyId, customerName) {
  for (const id of stripeIds) {
    const hit = hubspotByStripeId.get(id);
    if (hit) return hit;
  }
  if (Number.isFinite(allmoxyCustomerId)) {
    const hit = hubspotByAllmoxyId.get(allmoxyCustomerId);
    if (hit) return hit;
  }
  if (hubspotCompanyId) {
    const hit = hubspotByHubspotCompanyId.get(String(hubspotCompanyId).trim());
    if (hit) return hit;
  }
  if (customerName) {
    const nk = String(customerName).trim().toLowerCase().replace(/\s+/g, ' ');
    if (nk && !hubspotNameAmbiguous.has(nk)) {
      const hit = hubspotByName.get(nk);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------- Stripe Sync → per-customer transactions + classification fields ----------
const stripe = XLSX.utils.sheet_to_json(wb.Sheets['Stripe Sync'], { header: 1, defval: null, raw: false });
const hdr = stripe[1];
const H = {};
hdr.forEach((c, i) => { if (c) H[String(c).trim()] = i; });
const SI = {
  created: H['Created'],
  amount: H['Amount'],
  status: H['Status'],
  description: H['Description'],
  amountRefunded: H['Amount Refunded'],
  netAmount: H['Net amount'],
  allmoxy_id: H['allmoxy_customer_id'],
  customer: H['Customer'], // raw Stripe customer ID (cus_*) — fallback when allmoxy_id is #N/A
  master_name: H['Master Classification Name'],
  transaction_type: H['transaction_type'],
  signup_date: H['signup_date'],
  first_payment: H['First Payment Date'] ?? H['First Payment Date '],
  last_payment: H['Last Payment Date'],
  pay_status: H['pay_status'],
};

// Reverse map: stripe customer ID → allmoxy_customer_id, built from coreById
// (which already merged in stripe_id_overrides above). Used to recover orphan
// transactions whose allmoxy_customer_id formula returned #N/A in the source.
const stripeToAllmoxy = new Map();
for (const [aid, c] of coreById) {
  for (const sid of c.stripe_customer_ids ?? []) {
    if (sid) stripeToAllmoxy.set(sid, aid);
  }
}

function numClean(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Collect per-customer transactions + metadata.
const byCust = new Map(); // id → { txns: [], streamLifetime: {sub, svc, connect}, meta: {...} }

for (let i = 2; i < stripe.length; i++) {
  const row = stripe[i];
  if (!row) continue;
  let id = Number(row[SI.allmoxy_id]);
  // Fallback: when the source's stripe_id → allmoxy_id formula returned #N/A
  // (because the core_customer tab is missing the Stripe ID), look up by raw
  // Stripe customer ID against our overrides-augmented map.
  if (!Number.isFinite(id)) {
    const rawCus = row[SI.customer] ? String(row[SI.customer]).trim() : '';
    if (rawCus && stripeToAllmoxy.has(rawCus)) id = stripeToAllmoxy.get(rawCus);
  }
  if (!Number.isFinite(id)) continue;
  const created = row[SI.created];
  const amount = numClean(row[SI.amount]);
  const status = row[SI.status];
  const desc = row[SI.description] ? String(row[SI.description]).trim() : '';
  const type = row[SI.transaction_type] ? String(row[SI.transaction_type]).toLowerCase() : null;

  if (!byCust.has(id)) {
    byCust.set(id, {
      id,
      txns: [],
      lifetime_subscription: 0,
      lifetime_services: 0,
      lifetime_other: 0,
      meta_master_name: row[SI.master_name] ?? null,
      meta_signup_date: row[SI.signup_date] ?? null,
      meta_first_payment: row[SI.first_payment] ?? null,
      meta_last_payment: row[SI.last_payment] ?? null,
      meta_pay_status: row[SI.pay_status] ?? null,
    });
  }
  const rec = byCust.get(id);

  // Net out any refunds so downstream MRR / variance / lifetime totals reflect
  // actual revenue retained, not gross charges. Stripe's "Net amount" column is
  // amount - amount_refunded; if it's missing we compute it ourselves.
  const amountRefunded = numClean(row[SI.amountRefunded]);
  // Already GROSS: the sheet's "Net amount" column == Amount − Refunded exactly
  // (Stripe fees are NOT deducted; they're handled later as a COGS adjustment).
  const netCell = row[SI.netAmount];
  const netAmount = netCell != null && netCell !== '' ? numClean(netCell) : Math.max(amount - amountRefunded, 0);
  rec.txns.push({
    created: created ? String(created) : null,
    amount: Math.round(amount * 100) / 100,
    amount_refunded: Math.round(amountRefunded * 100) / 100,
    net_amount: Math.round(netAmount * 100) / 100,
    type,
    status,
    description: desc,
  });

  // Use net (post-refund) amounts for lifetime totals — a fully-refunded $266
  // charge contributes $0, not $266.
  if (status === 'succeeded') {
    if (type === 'subscription') rec.lifetime_subscription += netAmount;
    else if (type === 'services') rec.lifetime_services += netAmount;
    else rec.lifetime_other += netAmount;
  }
}

// Sort each customer's transactions by date descending (newest first).
for (const rec of byCust.values()) {
  rec.txns.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
}

// ---------- Connect per-customer monthly (from snapshot built earlier) ----------
const connectSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'connect_by_customer_month.json'), 'utf8'));
// Connect rows keyed by customer_name only (not allmoxy_id), so we'll match by name.
const connectByName = new Map();
for (const r of connectSnap.rows) {
  if (!r.customer_name) continue;
  const monthly = {};
  let lifetime = 0;
  for (const [k, v] of Object.entries(r)) {
    if (k === 'customer_name') continue;
    if (typeof v === 'number' && v > 0) {
      monthly[k] = v;
      lifetime += v;
    }
  }
  connectByName.set(r.customer_name.trim().toLowerCase(), { monthly, lifetime: Math.round(lifetime * 100) / 100 });
}

// ---------- subscription + services per-customer monthly ----------
const subSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'subscription_by_month.json'), 'utf8'));
const subByName = new Map();
for (const r of subSnap.rows) {
  if (!r.customer_name) continue;
  const monthly = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'customer_name' || k === 'last_mrr_month' || k === 'payment_dates') continue;
    if (typeof v === 'number' && v > 0) monthly[k] = v;
  }
  subByName.set(r.customer_name.trim().toLowerCase(), { monthly, last_mrr_month: r.last_mrr_month });
}

const svcSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'services_by_month.json'), 'utf8'));
const svcByName = new Map();
for (const r of svcSnap.rows) {
  if (!r.customer_name) continue;
  const monthly = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'customer_name' || k === 'last_services_payment' || k === 'payment_dates') continue;
    if (typeof v === 'number' && v > 0) monthly[k] = v;
  }
  svcByName.set(r.customer_name.trim().toLowerCase(), { monthly });
}

// ---------- customer_health → current_mrr + failed_3mo ----------
// Annual payers — exempt from the "missed a month" non-payment test (they pay
// once a year, so a monthly gap is normal). Same source apply_annual_amortization uses.
const ANNUAL_IDS = (() => {
  try { return new Set(JSON.parse(fs.readFileSync('/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/src/data/annual_payers.json', 'utf8')).annual_payer_ids || []); }
  catch { return new Set(); }
})();

const healthSnap = JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, 'customer_health.json'), 'utf8'));
const healthById = new Map();
for (const c of healthSnap.all_active_customers ?? []) {
  if (c.allmoxy_customer_id != null) healthById.set(c.allmoxy_customer_id, c);
}

// ---------- build unified roster ----------
const allIds = new Set([...coreById.keys(), ...byCust.keys()]);

function parseDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str || str === '#N/A') return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(str)) return str.slice(0, 10);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(str)) {
    const [m, d, y] = str.split('/').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

const today = new Date();
const latestCompleteMonth = (() => {
  const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
})();

const profiles = [];
for (const id of allIds) {
  const core = coreById.get(id);
  const sync = byCust.get(id);
  const health = healthById.get(id);

  const name = (core?.name || sync?.meta_master_name || '').trim();
  if (!name) continue;

  // Payment dates — prefer sync's Stripe-derived, fall back to Meta sheet's string fields.
  let firstPay = null, lastPay = null;
  if (sync && sync.txns.length > 0) {
    const succeeded = sync.txns.filter((t) => t.status === 'succeeded' && t.created);
    if (succeeded.length > 0) {
      const dates = succeeded.map((t) => String(t.created).slice(0, 10)).sort();
      firstPay = dates[0];
      lastPay = dates[dates.length - 1];
    }
  }
  if (!firstPay && sync?.meta_first_payment) firstPay = parseDate(sync.meta_first_payment);
  if (!lastPay && sync?.meta_last_payment) lastPay = parseDate(sync.meta_last_payment);

  const signup = parseDate(core?.sign_up_date) ?? firstPay;
  const activeToday = !!(lastPay && lastPay >= `${today.getFullYear()}-01-01`);

  // Build merged monthly history: {month → {subscription, services, connect}}
  const nameKey = name.toLowerCase();
  const sub = subByName.get(nameKey)?.monthly ?? {};
  const svc = svcByName.get(nameKey)?.monthly ?? {};
  const conn = connectByName.get(nameKey)?.monthly ?? {};
  const allMonths = new Set([...Object.keys(sub), ...Object.keys(svc), ...Object.keys(conn)]);
  const monthlyHistory = {};
  let peakMonth = null;
  let peakMonthTotal = 0;
  for (const m of [...allMonths].sort()) {
    const s = sub[m] ?? 0;
    const v = svc[m] ?? 0;
    const c = conn[m] ?? 0;
    const total = s + v + c;
    monthlyHistory[m] = {
      subscription: Math.round(s * 100) / 100,
      services: Math.round(v * 100) / 100,
      connect: Math.round(c * 100) / 100,
      total: Math.round(total * 100) / 100,
    };
    if (total > peakMonthTotal) { peakMonthTotal = total; peakMonth = m; }
  }

  // Fallback for orphan customers: when QB's MRR by Month tab couldn't resolve a
  // customer's Stripe ID and dropped their charges into the unnamed phantom row,
  // the per-customer rollup is empty for them. Backfill from the Stripe Sync
  // transaction stream so they show up as active.
  //
  // Only triggers when the customer is FULLY absent from all three QB rollups
  // (sub / svc / connect). If they're present but a specific month is null,
  // that's a deliberate QB exclusion (e.g., Pause Granted, one-off catch-up
  // payment) — we respect it.
  const fullyOrphan = !subByName.has(nameKey) && !svcByName.has(nameKey) && !connectByName.has(nameKey);
  if (fullyOrphan && sync?.txns?.length > 0) {
    for (const t of sync.txns) {
      if (t.status !== 'succeeded') continue;
      const m = String(t.created || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      const net = typeof t.net_amount === 'number' ? t.net_amount : t.amount;
      if (!(net > 0)) continue;
      const cell = monthlyHistory[m] || { subscription: 0, services: 0, connect: 0, total: 0 };
      let touched = false;
      if (t.type === 'subscription' && cell.subscription === 0) { cell.subscription = Math.round(net * 100) / 100; touched = true; }
      else if (t.type === 'services' && cell.services === 0) { cell.services = Math.round(net * 100) / 100; touched = true; }
      if (touched) {
        cell.total = Math.round((cell.subscription + cell.services + cell.connect) * 100) / 100;
        monthlyHistory[m] = cell;
        if (cell.total > peakMonthTotal) { peakMonthTotal = cell.total; peakMonth = m; }
      }
    }
  }

  const lifetimeSub = sync ? Math.round(sync.lifetime_subscription * 100) / 100 : 0;
  const lifetimeSvc = sync ? Math.round(sync.lifetime_services * 100) / 100 : 0;
  const lifetimeConnect = connectByName.get(nameKey)?.lifetime ?? 0;
  const lifetimeOther = sync ? Math.round(sync.lifetime_other * 100) / 100 : 0;
  const lifetimeTotal = Math.round((lifetimeSub + lifetimeSvc + lifetimeConnect + lifetimeOther) * 100) / 100;

  // Prefer monthlyHistory (which includes the orphan-customer txn fallback) over
  // raw sub/svc/conn so customers like Formations/Windsor whose QB lookup failed
  // still register a current MRR.
  const currentMrr = monthlyHistory[latestCompleteMonth]?.subscription ?? sub[latestCompleteMonth] ?? health?.current_mrr ?? 0;
  const currentServices = monthlyHistory[latestCompleteMonth]?.services ?? svc[latestCompleteMonth] ?? 0;
  const currentConnect = monthlyHistory[latestCompleteMonth]?.connect ?? conn[latestCompleteMonth] ?? 0;

  const cohortYear = firstPay ? Number(firstPay.slice(0, 4)) : (signup ? Number(signup.slice(0, 4)) : null);

  const yearsWithUs = firstPay
    ? Math.round(((today.getTime() - new Date(firstPay).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) * 10) / 10
    : null;

  // Failed charges in trailing 3 months
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const threeMoIso = threeMonthsAgo.toISOString().slice(0, 10);
  const recentFailed = (sync?.txns ?? []).filter(
    (t) => t.status === 'failed' && String(t.created ?? '').slice(0, 10) >= threeMoIso
  );
  const failed3mo = recentFailed.length;
  const failed3moAmount = Math.round(recentFailed.reduce((s, t) => s + t.amount, 0) * 100) / 100;

  // status is computed below (hybrid churn model) once HubSpot signals resolve.

  // HubSpot Instance Sync Sheet enrichment — joined via any of the customer's stripe ids.
  const hub = hubspotForCustomer(core?.stripe_customer_ids ?? [], id, core?.hubspot_company_id, name);

  // Attach Stripe Subscription ID to each subscription transaction only when we're
  // confident the single sub_id covers ALL the customer's subscription activity.
  // Required: HubSpot lists exactly ONE sub_id total for this customer (no
  // custom-domain sub, no secondary-instance sub_id from another row), AND their
  // recent subscription charges cluster around a single amount (catches the rarer
  // case where HubSpot has one sub_id but Stripe actually has two — DOT-style).
  const allSubIds = [
    ...(hub?.all_stripe_subscription_ids ?? []),
    ...(hub?.all_custom_domain_stripe_subscription_ids ?? []),
  ];
  const hasSinglePrimarySub = !!(hub?.stripe_subscription_id && allSubIds.length === 1);
  if (hasSinglePrimarySub && sync) {
    // sync.txns is sorted newest-first; take the first 12 successful subscription
    // charges as the "recent rate signature". A customer is treated as single-sub
    // if 80%+ of those recent charges cluster within ±25% of the median amount.
    // The 80% threshold tolerates one or two outlier charges (like Panhandle's
    // small $99 line item alongside the regular $5,925 sub) without classifying
    // the customer as multi-sub. DOT-style true multi-sub ($880 and $49 amounts
    // are nowhere near each other) still gets flagged correctly.
    const recentSubAmounts = sync.txns
      .filter((t) => t.type === 'subscription' && t.status === 'succeeded' && t.amount > 0)
      .slice(0, 12)
      .map((t) => t.amount);
    const clustersOk = (() => {
      if (recentSubAmounts.length <= 1) return true;
      const sorted = [...recentSubAmounts].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median <= 0) return false;
      const withinTolerance = recentSubAmounts.filter((a) => Math.abs(a - median) / median <= 0.25).length;
      return withinTolerance / recentSubAmounts.length >= 0.8;
    })();
    if (clustersOk) {
      for (const t of sync.txns) {
        if (t.type === 'subscription') t.stripe_subscription_id = hub.stripe_subscription_id;
      }
    }
  }

  // Prefer Hubspot Instance Sync Sheet's Directory/Installer ID columns when
  // present (production realm wins via resolveWinner). Falls back to the
  // allmoxy_core_customer values for customers without a Sync row. Fixes the
  // dotcabinetsusa-vs-dotcabinetsusa2020 split and similar Sandbox aliases.
  const installerDirectory = hub?.directory ?? core?.installer_directory ?? null;
  const installerId = (hub?.installer_id_from_hub != null && hub.installer_id_from_hub !== '')
    ? String(hub.installer_id_from_hub)
    : (core?.installer_id ?? null);
  // Live HubSpot overlay — when sync_hubspot.mjs has run recently, prefer its
  // values for HubSpot-native fields. Falls back silently to xlsx when no live
  // match. Stripe-sourced fields (pay_status, subscription IDs, churn_reason)
  // are intentionally NOT overlaid — those don't live in HubSpot.
  // HubSpot Company ID — source of truth is the Hubspot Instance Sync Sheet's
  // column B ("Company ID"). The Sync Sheet is HubSpot-managed and refreshes
  // when companies are merged/created; allmoxy_core_customer's value freezes
  // at row creation and silently rots. Read the Sync Sheet first, fall back to
  // core only when the Sync Sheet has nothing (e.g. customers in core but
  // missing from the sync export).
  //
  // Even after picking the right source, run through resolveHubspotCompanyId()
  // for the rare cases where the Sync Sheet itself is stale (merge that
  // happened between syncs, or a typo). Cascade: id → merge redirect → name
  // match (lifecyclestage=customer preferred on collisions).
  const hubspotCompanyIdRaw = (hub?.hubspot_company_id_from_hub != null && hub.hubspot_company_id_from_hub !== '')
    ? String(hub.hubspot_company_id_from_hub)
    : (core?.hubspot_company_id ?? null);
  const hubspotCompanyIdResolved = resolveHubspotCompanyId(hubspotCompanyIdRaw, name);

  // Live overlay AFTER redirect resolution so merged/renamed companies pick
  // up the surviving record's enrichment (recency, pulse, owner).
  const live = hubspotLiveForCustomer(core?.stripe_customer_ids ?? [], hubspotCompanyIdResolved);
  const liveOwnerFirstName = live?.owner_first_name ?? null;
  const liveOwnerFullName = live?.owner_full_name ?? null;

  // ---- Status (hybrid churn model) ----
  // Official churn requires a HubSpot signal — Cancelled pay status or a filled
  // churn-playbook reason — OR a long lapse (no successful payment for 12+ months).
  // A customer who has merely missed a recent month is 'non_payment': a highlighted
  // warning state, not yet churned. Annual payers are exempt from the monthly-miss test.
  const resolvedPayStatus = (installerId && instanceStatusByInstaller.get(String(installerId))) || hub?.pay_status || null;
  const resolvedChurnReason = hub?.churn_reason ?? null;
  const hubChurnConfirmed = /cancel/i.test(resolvedPayStatus || '') || !!(resolvedChurnReason && String(resolvedChurnReason).trim());
  const monthsSinceLastPay = lastPay ? (today.getTime() - new Date(lastPay).getTime()) / (30.44 * 864e5) : Infinity;
  // Missed at least the latest complete month (no payment that month or the current one).
  const missedAMonth = !!(lastPay && lastPay < `${latestCompleteMonth}-01`);
  const isAnnualPayer = ANNUAL_IDS.has(id);
  // Pay statuses where NOT billing is legitimate/expected — an agreed pause, a
  // pre-sale account, or a free partnership. A missed month here isn't non-payment,
  // and a long gap isn't churn. (Cancelled is handled above as hubChurnConfirmed.)
  const legitNonBilling = /pause|pre-?sale|partnership|free/i.test(resolvedPayStatus || '');
  let status;
  if (hubChurnConfirmed) status = 'churned';
  else if (legitNonBilling) status = failed3mo > 0 ? 'at_risk' : 'active';
  else if (monthsSinceLastPay >= 12) status = 'churned';
  else if (missedAMonth && !isAnnualPayer) status = 'non_payment';
  else if (failed3mo > 0) status = 'at_risk';
  else status = 'active';

  profiles.push({
    allmoxy_customer_id: id,
    name,
    hubspot_company_id: hubspotCompanyIdResolved,
    installer_id: installerId,
    installer_directory: installerDirectory,
    stripe_customer_ids: core?.stripe_customer_ids ?? [],
    harvest_id: core?.harvest_id ?? null,
    master_classification_name: sync?.meta_master_name ?? null,
    sign_up_date: signup,
    first_payment_date: firstPay,
    last_payment_date: lastPay,
    years_with_us: yearsWithUs,
    cohort_year: cohortYear,
    status,
    active_today: activeToday,
    // HubSpot fields. Values prefer LIVE API data (refreshed by sync_hubspot.mjs)
    // when available; fall back to xlsx Sync Sheet otherwise. Pay status,
    // subscription IDs, and churn reason stay xlsx-only — those columns live in
    // Stripe and the Allmoxy core DB, not in HubSpot.
    // Prefer the LIVE HubSpot Instance custom-object status over the lagging
    // xlsx Sync Sheet Pay Status (matches how the Renewal page reads status).
    pay_status: (installerId && instanceStatusByInstaller.get(String(installerId))) || hub?.pay_status || null,
    contract_status: live?.contract_status ?? hub?.contract_status ?? null,
    churn_reason: hub?.churn_reason ?? null,
    primary_segment: live?.primary_segment_framework ?? hub?.primary_segment ?? null,
    // Instance owner. Prefer the live HubSpot owner (refreshed nightly) over
    // the xlsx Sync Sheet's First-name column, which lags by however long
    // since the last manual xlsx export.
    instance_owner: liveOwnerFullName ?? hub?.instance_owner ?? null,
    instance_owner_first_name: liveOwnerFirstName ?? hub?.instance_owner_first_name ?? null,
    sub_segment: live?.sub_segment_framework ?? (() => {
      const hsId = core?.hubspot_company_id != null ? String(core.hubspot_company_id) : null;
      return hsId && hubspotSegmentsCache[hsId] ? (hubspotSegmentsCache[hsId].sub ?? null) : null;
    })(),
    // NEW live-only fields — only populated when sync_hubspot.mjs has run.
    // Stay null until the API cache is built; nothing breaks if absent.
    notes_last_contacted: live?.notes_last_contacted ?? null,
    customer_health_cs_pulse: live?.customer_health_cs_pulse ?? null,
    is_launched_per_hubspot: live?.is_this_customer_launched_ ?? null,
    actual_launch_date: live?.actual_launch_date ?? null,
    goal_launch_date: live?.goal_launch_date ?? null,
    cs_start_date: live?.cs_start_date ?? null,
    vip_legacy_customer: live?.vip_legacy_customer ?? null,
    allmoxy_main_poc: live?.allmoxy_main_poc ?? null,
    hubspot_lifecyclestage: live?.lifecyclestage ?? null,
    hubspot_owner_id: live?.hubspot_owner_id ?? null,
    hubspot_owner_email: live?.owner_email ?? null,
    hubspot_data_fetched_at: live ? hubspotLiveLoadedAt : null,
    // "Who They Are" firmographics / classification — all from the HubSpot
    // Company object (live-only; null/empty until sync_hubspot.mjs has run).
    // HubSpot checkbox (multi) props arrive as ';'-separated strings → arrays.
    firmographics: live ? {
      components_manufactured: hsMulti(live.components_manufactured),
      software: {
        accounting: hsMulti(live.accounting_software),
        cam: hsMulti(live.cam_softwares),
        design_3d: hsMulti(live.design_softwares),
        crm: hsMulti(live.crm_software),
        other: hsMulti(live.software),
      },
      revenue_band: live.revenue_band ?? null,
      annual_revenue: live.annualrevenue != null ? Number(live.annualrevenue) : null,
      employee_band: live.employee_band ?? null,
      headcount: live.numberofemployees != null ? Number(live.numberofemployees) : null,
      geographic_scope: live.geographical_reach ?? null,
      city: live.city ?? null,
      state: live.state ?? null,
      country: live.country ?? null,
      ownership_type: live.ownership_type ?? null,
      founded_year: live.founded_year ?? null,
      business_model: hsMulti(live.business_model),
      end_customer_type: hsMulti(live.end_customer_type),
      end_market: hsMulti(live.end_market),
      // Product offering — what they make, how it's built, how it arrives.
      product: {
        customization_tier: live.customization_tier ?? null,
        construction_methods: hsMulti(live.construction_methods),
        assembly_model: hsMulti(live.assembly_model),
        installation_model: hsMulti(live.installation_model),
        technology_profile: hsMulti(live.technology_profile),
      },
    } : null,
    stripe_subscription_id: hub?.stripe_subscription_id ?? null,
    custom_domain_stripe_subscription_id: hub?.custom_domain_stripe_subscription_id ?? null,
    all_stripe_subscription_ids: hub?.all_stripe_subscription_ids ?? [],
    all_custom_domain_stripe_subscription_ids: hub?.all_custom_domain_stripe_subscription_ids ?? [],
    hubspot_instance_name: hub?.instance_name ?? null,
    hubspot_record_id: hub?.hubspot_record_id ?? null,
    lifetime_total: lifetimeTotal,
    lifetime_subscription: lifetimeSub,
    lifetime_services: lifetimeSvc,
    lifetime_connect: Math.round(lifetimeConnect * 100) / 100,
    lifetime_other: lifetimeOther,
    current_subscription_mrr: Math.round(currentMrr * 100) / 100,
    current_services: Math.round(currentServices * 100) / 100,
    current_connect: Math.round(currentConnect * 100) / 100,
    latest_month: latestCompleteMonth,
    failed_3mo_count: failed3mo,
    failed_3mo_amount: failed3moAmount,
    peak_month: peakMonth,
    peak_month_total: Math.round(peakMonthTotal * 100) / 100,
    transaction_count: sync?.txns.length ?? 0,
    monthly_history: monthlyHistory,
    transactions: sync?.txns ?? [],
  });
}

// Merge duplicate profiles that represent the same business under multiple
// Allmoxy Customer IDs. Conservative rule: only merges rows that share BOTH a
// hubspot_record_id AND a normalized name. That hits Red Rock Milling LLC
// (id 396 + 2030) and New York Door & Drawer (id 198 + 2024) without touching
// rows that legitimately differ (e.g. Elite Cabinets / Mitchell Wood Worx,
// where HubSpot itself has merged two unrelated companies onto one record).
function mergeDuplicateProfiles(rows) {
  const normName = (s) => (s || '').toLowerCase().trim();
  const groups = new Map();
  for (const p of rows) {
    if (!p.hubspot_record_id || !p.name) continue;
    const k = String(p.hubspot_record_id) + '|' + normName(p.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const drop = new Set();
  for (const [, arr] of groups) {
    if (arr.length < 2) continue;
    // Canonical = row with the earliest first_payment_date (real billing
    // history). Fall back to lowest allmoxy_customer_id when payment dates
    // tie or are absent.
    const canonical = arr.slice().sort((a, b) => {
      const ad = a.first_payment_date || '9999-99-99';
      const bd = b.first_payment_date || '9999-99-99';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (a.allmoxy_customer_id ?? 0) - (b.allmoxy_customer_id ?? 0);
    })[0];
    const folded = arr.filter((p) => p !== canonical);

    const stripeSet = new Set(canonical.stripe_customer_ids || []);
    for (const p of folded) for (const s of p.stripe_customer_ids || []) stripeSet.add(s);
    canonical.stripe_customer_ids = [...stripeSet];

    // Sum lifetime values — each profile's lifetime is built from its own
    // installer/Stripe activity, so the totals are disjoint historical streams.
    const sumKey = (k) => arr.reduce((s, p) => s + (p[k] || 0), 0);
    canonical.lifetime_total = Math.round(sumKey('lifetime_total') * 100) / 100;
    canonical.lifetime_subscription = Math.round(sumKey('lifetime_subscription') * 100) / 100;
    canonical.lifetime_services = Math.round(sumKey('lifetime_services') * 100) / 100;
    canonical.lifetime_connect = Math.round(sumKey('lifetime_connect') * 100) / 100;
    canonical.lifetime_other = Math.round(sumKey('lifetime_other') * 100) / 100;

    // current_subscription_mrr / current_services / current_connect are
    // name-keyed (read from subscription_by_month etc.), so duplicates carry
    // identical values — keep canonical's; summing would double-count.

    const firsts = arr.map((p) => p.first_payment_date).filter(Boolean).sort();
    const lasts = arr.map((p) => p.last_payment_date).filter(Boolean).sort();
    canonical.first_payment_date = firsts[0] || canonical.first_payment_date;
    canonical.last_payment_date = lasts[lasts.length - 1] || canonical.last_payment_date;
    canonical.active_today = arr.some((p) => p.active_today);
    canonical.failed_3mo_count = arr.reduce((s, p) => s + (p.failed_3mo_count || 0), 0);
    canonical.failed_3mo_amount = Math.round(arr.reduce((s, p) => s + (p.failed_3mo_amount || 0), 0) * 100) / 100;
    canonical.transaction_count = arr.reduce((s, p) => s + (p.transaction_count || 0), 0);
    canonical.transactions = arr.flatMap((p) => p.transactions || []);

    // Merge monthly_history: sum subscription/services/connect/total per month.
    const mergedHistory = { ...(canonical.monthly_history || {}) };
    for (const p of folded) {
      for (const [m, v] of Object.entries(p.monthly_history || {})) {
        const cur = mergedHistory[m] || { subscription: 0, services: 0, connect: 0, total: 0 };
        mergedHistory[m] = {
          subscription: Math.round(((cur.subscription || 0) + (v.subscription || 0)) * 100) / 100,
          services: Math.round(((cur.services || 0) + (v.services || 0)) * 100) / 100,
          connect: Math.round(((cur.connect || 0) + (v.connect || 0)) * 100) / 100,
          total: Math.round(((cur.total || 0) + (v.total || 0)) * 100) / 100,
        };
      }
    }
    canonical.monthly_history = mergedHistory;
    canonical.merged_from_ids = folded.map((p) => p.allmoxy_customer_id);

    for (const p of folded) drop.add(p.allmoxy_customer_id);
  }
  return rows.filter((p) => !drop.has(p.allmoxy_customer_id));
}

const dedupedProfiles = mergeDuplicateProfiles(profiles);
const mergedCount = profiles.length - dedupedProfiles.length;
profiles.length = 0;
profiles.push(...dedupedProfiles);

// Inject synthetic (off-Stripe) transactions into every customer profile that
// has any in synthetic_transactions.json. These checks / wires / ACH payments
// don't flow through Stripe so they're invisible to our raw ingest; injecting
// them into customer_profiles.transactions makes them visible to downstream
// amortization, MRR rollups, and the waterfall. Also stamps them into
// monthly_history so non-annual-payer customers (who don't get re-amortized)
// still reflect the payment in subscription_by_month and mrr_by_month.
let syntheticInjected = 0;
for (const profile of profiles) {
  const synth = syntheticTxnsByCustomerId.get(profile.allmoxy_customer_id) || [];
  if (synth.length === 0) continue;
  profile.transactions = [...(profile.transactions || []), ...synth];
  profile.transaction_count = (profile.transaction_count || 0) + synth.length;
  // Stamp into monthly_history at the payment month. apply_annual_amortization
  // will rewrite monthly_history for annual_payers based on their full
  // transaction list, so this stamp gets refined there. For non-annual-payers,
  // this stamp is what surfaces the payment in monthly snapshots.
  if (!profile.monthly_history) profile.monthly_history = {};
  for (const t of synth) {
    const ym = (t.created || '').slice(0, 7);
    if (!ym) continue;
    const cur = profile.monthly_history[ym] || { subscription: 0, services: 0, connect: 0, total: 0 };
    const amt = t.net_amount ?? t.amount ?? 0;
    const stream = t.type === 'subscription' ? 'subscription' : t.type === 'services' ? 'services' : t.type === 'connect' ? 'connect' : 'subscription';
    cur[stream] = Math.round(((cur[stream] || 0) + amt) * 100) / 100;
    cur.total = Math.round(((cur.subscription || 0) + (cur.services || 0) + (cur.connect || 0)) * 100) / 100;
    profile.monthly_history[ym] = cur;
  }
  // Recompute lifetime + last_payment_date to include the synthetic.
  for (const t of synth) {
    const amt = t.net_amount ?? t.amount ?? 0;
    profile.lifetime_total = Math.round(((profile.lifetime_total || 0) + amt) * 100) / 100;
    if (t.type === 'subscription') profile.lifetime_subscription = Math.round(((profile.lifetime_subscription || 0) + amt) * 100) / 100;
    else if (t.type === 'services') profile.lifetime_services = Math.round(((profile.lifetime_services || 0) + amt) * 100) / 100;
    else if (t.type === 'connect') profile.lifetime_connect = Math.round(((profile.lifetime_connect || 0) + amt) * 100) / 100;
    const date = (t.created || '').slice(0, 10);
    if (date && (!profile.last_payment_date || date > profile.last_payment_date)) {
      profile.last_payment_date = date;
    }
  }
  syntheticInjected += synth.length;
}
if (syntheticInjected > 0) process.stderr.write(`injected ${syntheticInjected} synthetic (off-Stripe) transactions\n`);

// Sort by lifetime total desc for default ordering.
profiles.sort((a, b) => b.lifetime_total - a.lifetime_total);
if (mergedCount > 0) process.stderr.write(`merged ${mergedCount} duplicate Allmoxy Customer ID rows\n`);

const now = new Date();
const out = {
  tab: 'customer_profiles',
  fetchedAt: now.toISOString(),
  cachedUntil: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  columns: [],
  rows: profiles,
  rowCount: profiles.length,
  notes:
    `Per-customer comprehensive profile derived from allmoxy_core_customer, Stripe Sync (${stripe.length - 2} classified transactions), ` +
    'subscription_by_month, services_by_month, connect_by_customer_month, and customer_health snapshots. ' +
    'Each profile includes identity, lifetime totals by stream, monthly history, and all Stripe transactions for that customer.',
};

process.stdout.write(JSON.stringify(out) + '\n');
