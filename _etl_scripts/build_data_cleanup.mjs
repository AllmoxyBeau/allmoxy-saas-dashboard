#!/usr/bin/env node
/**
 * Build the Data Cleanup snapshot — a single page-friendly list of every data
 * hygiene issue we know how to detect, so CS / admin can chip away at them.
 *
 * Categories surfaced (each row tagged with category + severity + action):
 *   - hubspot_instance_missing_aid: active Instance with no allmoxy_customer_id.
 *     The xlsx Sync Sheet column B is our source of truth for HubSpot ↔ Allmoxy
 *     joins, but the Instance object's own allmoxy_customer_id field is barely
 *     maintained (322 cancelled have it, only 28 active do). We resolve via
 *     installer_id today, but setting it correctly here would simplify all
 *     downstream joins.
 *   - hubspot_company_id_ghost: customer_profiles has a hubspot_company_id that
 *     doesn't exist in HubSpot at all (not a merge target, not in the live
 *     companies set). Surfaced post-resolve (after merge redirect + name
 *     fallback) so this list is only the truly broken ids.
 *   - connect_mapping_orphan: entry in src/data/connect_customer_overrides.json
 *     mapping → an Allmoxy aid that no longer has a row in
 *     connect_by_customer_month.json. The Stripe Connect xlsx no longer carries
 *     that account — either the customer churned or the Connect account moved.
 *   - hubspot_pay_status_drift: Instance.status differs from customer_profile.
 *     pay_status — one of HubSpot or the xlsx Sync Sheet has gone stale.
 *
 * Output: public/snapshots/data_cleanup.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '_etl_scripts/cache');
const SNAP = path.join(ROOT, 'public/snapshots');
const OUT = path.join(SNAP, 'data_cleanup.json');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8')).rows || [];
const hsCompanies = JSON.parse(fs.readFileSync(path.join(CACHE, 'hubspot_companies.json'), 'utf8')).companies || [];
const hsInstances = JSON.parse(fs.readFileSync(path.join(CACHE, 'hubspot_instances.json'), 'utf8')).instances || [];
const connectOverridesPath = path.join(ROOT, 'src/data/connect_customer_overrides.json');
const connectOverrides = fs.existsSync(connectOverridesPath)
  ? JSON.parse(fs.readFileSync(connectOverridesPath, 'utf8'))
  : { mapping: {}, unmapped: {} };
const cbcm = JSON.parse(fs.readFileSync(path.join(SNAP, 'connect_by_customer_month.json'), 'utf8'));

// ---------- indexes -------------------------------------------------------
const profByAid = new Map(profiles.map((p) => [p.allmoxy_customer_id, p]));
const profByInstallerId = new Map();
for (const p of profiles) if (p.installer_id) profByInstallerId.set(String(p.installer_id), p);

const hsCompanyById = new Map(hsCompanies.map((c) => [String(c.id), c]));
const hsCompanyMergeRedirect = new Map();
for (const c of hsCompanies) {
  if (c.hs_merged_object_ids) {
    for (const oldId of String(c.hs_merged_object_ids).split(';').map((s) => s.trim()).filter(Boolean)) {
      hsCompanyMergeRedirect.set(oldId, String(c.id));
    }
  }
}
const cbcmByName = new Set((cbcm.rows || []).map((r) => r.customer_name));

const ACTIVE = new Set(['Active', 'Active - Card Failure', 'Active - Pause Granted', 'Active - Partnership Free']);
const issues = [];

// ===== 1. Instance.allmoxy_customer_id hygiene ===========================
// Active production Instances that don't have allmoxy_customer_id populated.
// We resolve via installer_id so the dashboard still works, but the Instance
// itself should carry the aid for any direct HubSpot reporting.
for (const i of hsInstances) {
  if (!ACTIVE.has(i.status)) continue;
  if (/sandbox|\bdev\b|\btest\b/i.test(i.account_name || '')) continue;
  if (i.allmoxy_customer_id) continue;
  // Can we resolve it via installer_id so CS has a value to put in?
  const resolved = i.installer_id ? profByInstallerId.get(String(i.installer_id)) : null;
  issues.push({
    category: 'hubspot_instance_missing_aid',
    category_label: 'HubSpot Instance missing Allmoxy Customer ID',
    severity: resolved ? 'low' : 'medium',
    instance_id: i.id,
    account_name: i.account_name,
    installer_id: i.installer_id || null,
    pay_status: i.status,
    suggested_aid: resolved?.allmoxy_customer_id ?? null,
    suggested_customer_name: resolved?.name ?? null,
    action: resolved
      ? `Open HubSpot Instance "${i.account_name}", set Allmoxy Customer ID = ${resolved.allmoxy_customer_id}`
      : `Open HubSpot Instance "${i.account_name}" — no installer_id match, requires manual lookup`,
  });
}

// ===== 2. customer_profiles HubSpot Company ID ghosts =====================
// After resolveHubspotCompanyId() runs in build_customer_profiles, the
// resolved id is what lives on the profile. We can detect remaining ghosts by
// checking whether that resolved id exists in our live HubSpot Companies set.
for (const p of profiles) {
  if (!p.hubspot_company_id) continue;
  if (p.status === 'churned' || p.status === 'never_paid') continue;
  const id = String(p.hubspot_company_id);
  if (hsCompanyById.has(id)) continue;
  // Could be in the merge redirect map (handled by build_customer_profiles)
  // but the resolved value didn't land in the live set — meaning truly broken.
  issues.push({
    category: 'hubspot_company_id_ghost',
    category_label: 'Customer profile points at a non-existent HubSpot Company ID',
    severity: 'medium',
    allmoxy_customer_id: p.allmoxy_customer_id,
    customer_name: p.name,
    hubspot_company_id: id,
    pay_status: p.pay_status || null,
    action: `In the xlsx Sync Sheet, find the row for "${p.name}" and update Column B (Company ID) — it currently references a HubSpot Company that doesn't exist`,
  });
}

// ===== 3. Connect mapping orphans =========================================
// Entries in connect_customer_overrides.json whose customer name no longer
// appears in connect_by_customer_month — the Stripe Connect xlsx no longer
// carries that account.
for (const [connectName, aid] of Object.entries(connectOverrides.mapping || {})) {
  if (cbcmByName.has(connectName)) continue;
  const p = profByAid.get(aid);
  issues.push({
    category: 'connect_mapping_orphan',
    category_label: 'Connect customer in mapping but no longer in source xlsx',
    severity: 'low',
    allmoxy_customer_id: aid,
    customer_name: p?.name ?? '(unknown)',
    connect_name: connectName,
    pay_status: p?.pay_status ?? null,
    action: `Either the customer churned (remove from src/data/connect_customer_overrides.json mapping) or their Connect account changed — check Stripe Connect dashboard for "${connectName}"`,
  });
}

// ===== 4. Pay status drift: HubSpot Instance vs customer_profiles ==========
// When HubSpot Instance.status disagrees with our xlsx-derived pay_status,
// one of them is stale.
function normalizePayStatus(s) {
  if (!s) return null;
  const v = String(s).trim();
  if (v === 'Active' || v.startsWith('Active -')) return 'active';
  if (v === 'Cancelled') return 'cancelled';
  if (v === 'Pre-Sale') return 'pre_sale';
  return v.toLowerCase().replace(/\s+/g, '_');
}
for (const i of hsInstances) {
  if (/sandbox|\bdev\b|\btest\b/i.test(i.account_name || '')) continue;
  if (!i.installer_id) continue;
  const p = profByInstallerId.get(String(i.installer_id));
  if (!p) continue;
  const hsStatus = normalizePayStatus(i.status);
  const xlsxStatus = normalizePayStatus(p.pay_status);
  if (hsStatus && xlsxStatus && hsStatus !== xlsxStatus) {
    issues.push({
      category: 'hubspot_pay_status_drift',
      category_label: 'Pay Status disagrees between HubSpot Instance and xlsx Sync Sheet',
      severity: 'low',
      allmoxy_customer_id: p.allmoxy_customer_id,
      customer_name: p.name,
      hubspot_pay_status: i.status,
      xlsx_pay_status: p.pay_status,
      installer_id: i.installer_id,
      action: `Check which source is right: HubSpot says "${i.status}", xlsx says "${p.pay_status}". Update the stale one.`,
    });
  }
}

// ---------- accepted resolutions (from the Data Cleanup page) -------------
// Suppress any issue the team has accepted in the UI and committed to
// data_cleanup_resolutions.json. Keyed '<category>:<identifier>'.
const resolutionsPath = path.join(ROOT, '_etl_scripts/data_cleanup_resolutions.json');
const resolved = fs.existsSync(resolutionsPath)
  ? (JSON.parse(fs.readFileSync(resolutionsPath, 'utf8')).resolved || {})
  : {};
function issueKey(it) {
  if (it.category === 'hubspot_instance_missing_aid') return `${it.category}:${it.instance_id}`;
  if (it.category === 'connect_mapping_orphan') return `${it.category}:${it.connect_name}`;
  return `${it.category}:${it.allmoxy_customer_id}`; // pay_status_drift, company_id_ghost
}
const activeIssues = issues.filter((it) => !resolved[issueKey(it)]);
const resolvedCount = issues.length - activeIssues.length;
issues.length = 0;
issues.push(...activeIssues);

// ---------- aggregates ----------------------------------------------------
const byCategory = {};
for (const it of issues) {
  if (!byCategory[it.category]) {
    byCategory[it.category] = { count: 0, label: it.category_label, severity_counts: { low: 0, medium: 0, high: 0 } };
  }
  byCategory[it.category].count++;
  byCategory[it.category].severity_counts[it.severity]++;
}

const aggregates = {
  total_issues: issues.length,
  resolved_count: resolvedCount,
  by_category: byCategory,
  by_severity: {
    high: issues.filter((i) => i.severity === 'high').length,
    medium: issues.filter((i) => i.severity === 'medium').length,
    low: issues.filter((i) => i.severity === 'low').length,
  },
};

const out = {
  tab: 'data_cleanup',
  fetchedAt: new Date().toISOString(),
  cachedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
  source:
    'Derived from hubspot_instances.json + hubspot_companies.json + customer_profiles.json + connect_customer_overrides.json + connect_by_customer_month.json. ' +
    'Detects: missing Instance allmoxy_customer_id (active customers), ghost HubSpot Company IDs in customer profiles, Connect mapping orphans (no longer in source xlsx), and pay-status drift between HubSpot and xlsx Sync Sheet.',
  aggregates,
  issues,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`  ${issues.length} issues across ${Object.keys(byCategory).length} categories${resolvedCount ? ` (${resolvedCount} suppressed via accepted resolutions)` : ''}`);
for (const [cat, agg] of Object.entries(byCategory)) {
  console.log(`    ${cat}: ${agg.count} (high:${agg.severity_counts.high}, med:${agg.severity_counts.medium}, low:${agg.severity_counts.low})`);
}
