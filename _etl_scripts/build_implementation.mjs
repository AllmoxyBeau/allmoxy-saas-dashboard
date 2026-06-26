#!/usr/bin/env node
/**
 * Join JIRA implementation epics + Harvest implementation projects to the
 * customer roster → public/snapshots/implementation.json (one row per customer).
 *
 * Inputs (run sync_jira.mjs + sync_harvest.mjs first):
 *   _etl_scripts/cache/jira_implementation.json     (IPA epics: summary=customer, status=stage)
 *   _etl_scripts/cache/harvest_implementation.json  (projects + per-project hours/$)
 *   public/snapshots/customer_profiles.json         (roster; harvest_id == Harvest client_id)
 *   _etl_scripts/jira_customer_overrides.json        (epic.key -> allmoxy_customer_id)
 *
 * Joins:
 *   Harvest project -> customer:  String(client_id) === harvest_id   (exact, 100%)
 *   JIRA epic       -> customer:  override by epic key, else normalized name-match
 *
 * Output row = a customer's implementation project: JIRA stage + Harvest hours/$.
 * All of this is SERVICES REVENUE.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, '_etl_scripts/cache');
const OUT = path.join(ROOT, 'public/snapshots/implementation.json');

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readOpt = (p) => (fs.existsSync(p) ? read(p) : null);
const jira = read(path.join(CACHE, 'jira_implementation.json'));
const harvest = read(path.join(CACHE, 'harvest_implementation.json'));
const profiles = read(path.join(ROOT, 'public/snapshots/customer_profiles.json'));
const overridesFile = read(path.join(ROOT, '_etl_scripts/jira_customer_overrides.json'));
const OVERRIDES = overridesFile.overrides || {};

// Time-to-first-order spine: Orders Verified gives is_launched + live_date (the
// first verified live order = "first value") keyed by customer in by_customer.
// Time to Value adds the onboarding-vs-stalled category (onboarding = fresh,
// gym_member = paying but never launched). Both optional so a missing snapshot
// degrades to "unknown launch status" rather than failing the build.
const orders = readOpt(path.join(ROOT, 'public/snapshots/orders_verified.json'));
const ttv = readOpt(path.join(ROOT, 'public/snapshots/time_to_value.json'));
// Weekly-meeting schedule decisions. customer_priority: id -> P1/P2/P3.
// tickets: JIRA ticket key -> { start, end } (the scheduling unit is the ticket).
const scheduleFile = readOpt(path.join(ROOT, '_etl_scripts/implementation_schedule_overrides.json'));
const PRIORITY = scheduleFile?.customer_priority || {};
const TICKETS = scheduleFile?.tickets || {};
const ordersByCustomer = new Map();
for (const [k, v] of Object.entries(orders?.by_customer || {})) ordersByCustomer.set(Number(k), v);
const ttvCatById = new Map();
for (const c of (ttv?.customers || [])) ttvCatById.set(c.allmoxy_customer_id, c.category);

const roster = profiles.rows || [];

// --- name normalization for the JIRA epic -> customer fuzzy match ------------
// Epic summaries are clean customer names but carry trailing noise: dates,
// "- Rebuild", "Project Scope", parentheticals. Strip those, then drop common
// business-suffix words and non-alphanumerics so "GW Eurocase - Rebuild" and
// "Slide-A-Shelf 5/1 Project Scope" land on their roster names.
const BIZ_WORDS = /\b(llc|inc|incorporated|ltd|co|company|corp|cabinets?|cabinetry|millwork|woodworks?|woodcrafts?|industries|kitchens?|closets?|design|designs|group|the|and)\b/g;
function cleanup(s) {
  return String(s || '')
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/\b(project scope|rebuild|ongoing|catalog build|scope)\b/gi, ' ');
}
const norm = (s) => cleanup(s).toLowerCase().replace(BIZ_WORDS, ' ').replace(/[^a-z0-9]/g, '').trim();

// Internal / non-customer epics to drop from the implementation view.
const INTERNAL = /^(strategy & innovation|team training|team meetings|catalog strategy|training|meetings)$/i;

// --- roster lookups ---------------------------------------------------------
const byHarvestId = new Map();      // String(harvest_id) -> customer
const byNorm = new Map();           // normalized name -> customer (first wins)
const byId = new Map();             // allmoxy_customer_id -> customer
for (const c of roster) {
  byId.set(c.allmoxy_customer_id, c);
  if (c.harvest_id) byHarvestId.set(String(c.harvest_id), c);
  const n = norm(c.name);
  if (n && !byNorm.has(n)) byNorm.set(n, c);
}

// --- billing method from a Harvest project ----------------------------------
function billingMethod(p) {
  if (!p.is_billable) return 'Non-billable';
  if (p.fee && p.fee > 0) return 'Fixed fee';
  return 'Hourly';
}

// --- accumulate per-customer rows -------------------------------------------
const rows = new Map(); // allmoxy_customer_id -> row
function rowFor(c) {
  if (!rows.has(c.allmoxy_customer_id)) {
    rows.set(c.allmoxy_customer_id, {
      allmoxy_customer_id: c.allmoxy_customer_id,
      name: c.name,
      customer_status: c.status ?? null,
      harvest_id: c.harvest_id ?? null,
      // Time-to-first-order context (filled in the enrichment pass below).
      sign_up_date: c.sign_up_date ?? null,
      first_payment_date: c.first_payment_date ?? null,
      // JIRA
      has_jira: false, jira_key: null, jira_url: null, jira_summary: null,
      stage: null, stage_category: null, assignee: null, jira_updated: null,
      // Harvest (aggregated across the customer's implementation projects)
      has_harvest: false, harvest_project_id: null, harvest_project_name: null,
      harvest_project_count: 0, billing_method: null, hourly_rate: null,
      hours: 0, billable_hours: 0, billable_amount: 0, entry_count: 0,
      first_entry: null, last_entry: null, harvest_active: false,
      match_method: null,
    });
  }
  return rows.get(c.allmoxy_customer_id);
}

// Harvest first (exact join).
const implProjects = harvest.projects.filter((p) => p.is_implementation && p.client_id != null);
let harvestUnmatched = 0;
for (const p of implProjects) {
  const c = byHarvestId.get(String(p.client_id));
  if (!c) { harvestUnmatched++; continue; }
  const r = rowFor(c);
  r.has_harvest = true;
  r.harvest_project_count += 1;
  r.hours += p.hours || 0;
  r.billable_hours += p.billable_hours || 0;
  r.billable_amount += p.billable_amount || 0;
  r.entry_count += p.entry_count || 0;
  if (p.first_entry && (!r.first_entry || p.first_entry < r.first_entry)) r.first_entry = p.first_entry;
  if (p.last_entry && (!r.last_entry || p.last_entry > r.last_entry)) r.last_entry = p.last_entry;
  // Primary project = the one with the most billable $ (fallback: first).
  if (r.harvest_project_id == null || (p.billable_amount || 0) > (r._primaryAmt || -1)) {
    r._primaryAmt = p.billable_amount || 0;
    r.harvest_project_id = p.id;
    r.harvest_project_name = p.name;
    r.billing_method = billingMethod(p);
    r.hourly_rate = p.hourly_rate ?? null;
  }
  r.match_method = r.match_method || 'harvest_id';
}

// Stage ranking: prefer an "active" epic when a customer has several.
const STAGE_RANK = (e) => {
  if (e.stage_category === 'In Progress') return 0;
  if (/waiting/i.test(e.stage || '')) return 1;
  if (e.stage_category === 'To Do') return 2;
  if (/hold|abandon/i.test(e.stage || '')) return 4;
  if (e.stage_category === 'Done') return 5;
  return 3;
};

// JIRA epics.
const unmatched = [];
const internalExcluded = [];
for (const e of jira.epics) {
  if (INTERNAL.test((e.summary || '').trim())) { internalExcluded.push(e.key + ': ' + e.summary); continue; }
  let c = null;
  if (OVERRIDES[e.key] != null) c = byId.get(OVERRIDES[e.key]) || null;
  if (!c) c = byNorm.get(norm(e.summary)) || null;
  if (!c) { unmatched.push({ key: e.key, summary: e.summary, stage: e.stage }); continue; }
  const r = rowFor(c);
  // Keep the most-active epic if multiple match the same customer.
  if (!r.has_jira || STAGE_RANK(e) < (r._stageRank ?? 9)) {
    r._stageRank = STAGE_RANK(e);
    r.has_jira = true;
    r.jira_key = e.key;
    r.jira_url = e.url;
    r.jira_summary = e.summary;
    r.stage = e.stage;
    r.stage_category = e.stage_category;
    r.assignee = e.assignee;
    r.jira_updated = e.updated;
    // Child tasks + task-derived span (drives the Schedule Gantt).
    r.tasks = e.tasks || [];
    r.task_count = e.task_count ?? 0;
    r.tasks_done = e.tasks_done ?? 0;
    r.task_start = e.task_start ?? null;
    r.task_end = e.task_end ?? null;
  }
  if (r.match_method == null) r.match_method = OVERRIDES[e.key] != null ? 'override' : 'name';
}

// --- derive is_active + round, drop temp fields -----------------------------
const now = harvest.fetchedAt ? new Date(harvest.fetchedAt) : new Date();
const ACTIVE_DAYS = 60;
const out = [...rows.values()].map((r) => {
  delete r._primaryAmt; delete r._stageRank;
  let active = false;
  if (r.has_jira) {
    active = r.stage_category !== 'Done' && !/hold|abandon/i.test(r.stage || '');
  }
  if (!active && r.last_entry) {
    const days = (now - new Date(r.last_entry)) / 86400000;
    if (days <= ACTIVE_DAYS) active = true;
  }
  r.harvest_active = r.last_entry ? ((now - new Date(r.last_entry)) / 86400000 <= ACTIVE_DAYS) : false;
  r.is_active = active;
  r.hours = Math.round(r.hours * 100) / 100;
  r.billable_hours = Math.round(r.billable_hours * 100) / 100;
  r.billable_amount = Math.round(r.billable_amount * 100) / 100;

  // --- time-to-first-order enrichment ---------------------------------------
  // First value = first verified live order (Orders Verified is_launched +
  // live_date). Launched customers doing implementation work are doing CATALOG
  // UPDATES; not-yet-launched customers are in INITIAL IMPLEMENTATION, racing
  // to their first order. live_date is year-granular, so time_to_first_order is
  // approximate; the sign-up clock (computed live in the UI) is exact.
  const o = ordersByCustomer.get(r.allmoxy_customer_id);
  if (o == null) {
    r.launch_status = 'unknown';
    r.is_launched = null;
    r.first_order_year = null;
    r.time_to_first_order_months = null;
    r.lifetime_orders = null;
  } else {
    r.is_launched = !!o.is_launched;
    r.launch_status = o.is_launched ? 'launched' : 'pre_launch';
    r.first_order_year = o.is_launched && o.live_date ? Number(o.live_date) : null;
    // Time to first order. Prefer a precomputed months_to_launch; else derive
    // coarsely from year-of-first-order minus year-of-signup (live_date is
    // year-granular, so this is approximate — surfaced as such in the UI).
    if (o.is_launched && typeof o.months_to_launch === 'number') {
      r.time_to_first_order_months = o.months_to_launch;
    } else if (r.first_order_year && r.sign_up_date) {
      r.time_to_first_order_months = Math.max(0, (r.first_order_year - Number(r.sign_up_date.slice(0, 4))) * 12);
    } else {
      r.time_to_first_order_months = null;
    }
    r.lifetime_orders = o.total_lifetime_orders ?? o.lifetime_orders ?? null;
  }
  r.implementation_type = r.launch_status === 'launched' ? 'Catalog update'
    : r.launch_status === 'pre_launch' ? 'Initial implementation'
    : 'Unknown';
  // Onboarding nuance from Time to Value: fresh onboarding vs stalled "gym
  // member" (paying, never launched) vs already-launched buckets.
  r.ttv_category = ttvCatById.get(r.allmoxy_customer_id) ?? null;
  // Build-time signup age + SLA (UI recomputes live; this is for static aggregates).
  if (r.sign_up_date) {
    r.days_since_signup = Math.round((now - new Date(r.sign_up_date)) / 86400000);
  } else {
    r.days_since_signup = null;
  }

  // --- weekly-meeting schedule (Gantt) --------------------------------------
  // The scheduling unit is the TICKET. Each ticket gets its own start/end:
  // start seeds from its created date, end from its due date (or last update),
  // and committed per-ticket overrides win. The customer-level span is just the
  // min/max across its tickets (used for sorting/grouping).
  if (!r.tasks) { r.tasks = []; r.task_count = 0; r.tasks_done = 0; }
  for (const tk of r.tasks) {
    const seedStart = tk.created || null;
    const seedEnd = tk.due || tk.updated || tk.created || null;
    const tov = TICKETS[tk.key] || null;
    tk.start = tov?.start || seedStart;
    tk.end = tov?.end || seedEnd;
    tk.schedule_committed = !!tov;
  }
  const tStarts = r.tasks.map((t) => t.start).filter(Boolean).sort();
  const tEnds = r.tasks.map((t) => t.end).filter(Boolean).sort();
  r.schedule_start = tStarts[0] ?? null;
  r.schedule_end = tEnds[tEnds.length - 1] ?? null;
  r.priority = PRIORITY[String(r.allmoxy_customer_id)] || null;  // P1 | P2 | P3 | null
  r.schedule_committed = !!PRIORITY[String(r.allmoxy_customer_id)] || r.tasks.some((t) => t.schedule_committed);
  return r;
});
out.sort((a, b) => (b.billable_amount - a.billable_amount) || a.name.localeCompare(b.name));

// Implementation Overview is a worklist of CURRENT customers only. Drop churned/
// cancelled and never-paid accounts — they're no longer being implemented and
// just clutter the list and skew the aggregates (e.g. a cancelled customer still
// showing a stale stage). at_risk customers are kept: they're active relationships
// (payment-risk flag only), often still mid-implementation. This filters rows AND
// every aggregate below, since both derive from `out`.
const EXCLUDED_STATUS = new Set(['churned', 'never_paid']);
const droppedInactive = out.filter((r) => EXCLUDED_STATUS.has(r.customer_status));
{
  const kept = out.filter((r) => !EXCLUDED_STATUS.has(r.customer_status));
  out.length = 0;
  out.push(...kept);
}

// --- aggregates -------------------------------------------------------------
const byStage = {};
for (const r of out) if (r.has_jira) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
const byBilling = {};
for (const r of out) if (r.has_harvest) byBilling[r.billing_method] = (byBilling[r.billing_method] || 0) + 1;

// Time-to-first-order rollups. SLA target = 90 days from sign-up (on-track <60,
// at-risk 60-90, overdue >90). Static buckets use build-time signup age.
const initial = out.filter((r) => r.launch_status === 'pre_launch');
const launched = out.filter((r) => r.launch_status === 'launched');
const ttfoMonths = launched.map((r) => r.time_to_first_order_months).filter((m) => typeof m === 'number').sort((a, b) => a - b);
const median = ttfoMonths.length ? ttfoMonths[Math.floor((ttfoMonths.length - 1) / 2)] : null;
const slaBucket = (r) => {
  if (r.days_since_signup == null) return 'unknown';
  if (r.days_since_signup > 90) return 'overdue';
  if (r.days_since_signup >= 60) return 'at_risk';
  return 'on_track';
};
const initialBuckets = { on_track: 0, at_risk: 0, overdue: 0, unknown: 0 };
for (const r of initial) initialBuckets[slaBucket(r)] += 1;

const aggregates = {
  total_customers: out.length,
  active: out.filter((r) => r.is_active).length,
  // Time-to-first-order framing — the implementation team's north star.
  initial_implementation: initial.length,          // pre-first-order (racing to first order)
  catalog_update: launched.length,                 // already launched (post-first-value)
  unknown_launch: out.filter((r) => r.launch_status === 'unknown').length,
  initial_overdue: initialBuckets.overdue,          // pre-launch >90d since signup
  initial_at_risk: initialBuckets.at_risk,
  initial_by_sla: initialBuckets,
  stalled_gym_members: out.filter((r) => r.ttv_category === 'gym_member').length, // paying, never launched
  median_months_to_first_order: median,             // year-approx
  with_jira: out.filter((r) => r.has_jira).length,
  with_harvest: out.filter((r) => r.has_harvest).length,
  with_both: out.filter((r) => r.has_jira && r.has_harvest).length,
  total_hours: Math.round(out.reduce((s, r) => s + r.hours, 0) * 10) / 10,
  total_billable_amount: Math.round(out.reduce((s, r) => s + r.billable_amount, 0)),
  by_stage: byStage,
  by_billing_method: byBilling,
  jira_epics_total: jira.epics.length,
  jira_matched: jira.epics.length - unmatched.length - internalExcluded.length,
  jira_unmatched_count: unmatched.length,
};

const payload = {
  fetchedAt: new Date().toISOString(),
  jira_fetchedAt: jira.fetchedAt,
  harvest_fetchedAt: harvest.fetchedAt,
  note: 'Implementation projects = services revenue. JIRA (IPA epics) supplies stage; Harvest supplies hours + billable $. Join: harvest_id==client_id (exact); JIRA by epic-summary name-match (+ overrides).',
  aggregates,
  rows: out,
  unmatched_jira_epics: unmatched,
  internal_epics_excluded: internalExcluded,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

console.log(`✓ implementation.json: ${out.length} customers (${aggregates.active} active) · dropped ${droppedInactive.length} churned/never-paid`);
console.log(`  Time-to-first-order: ${aggregates.initial_implementation} initial (pre-order) · ${aggregates.catalog_update} catalog-update (launched) · ${aggregates.unknown_launch} unknown`);
console.log(`  Initial SLA (90d): ${aggregates.initial_by_sla.on_track} on-track, ${aggregates.initial_at_risk} at-risk, ${aggregates.initial_overdue} overdue · ${aggregates.stalled_gym_members} stalled gym-members · median TTFO ${aggregates.median_months_to_first_order ?? '—'} mo`);
console.log(`  JIRA: ${aggregates.jira_matched}/${aggregates.jira_epics_total} epics matched, ${unmatched.length} unmatched, ${internalExcluded.length} internal excluded`);
console.log(`  Harvest: ${aggregates.with_harvest} customers, ${harvestUnmatched} impl projects had no roster match`);
console.log(`  Totals: ${aggregates.total_hours} hrs, $${aggregates.total_billable_amount.toLocaleString()} billable`);
if (unmatched.length) console.log('  Unmatched epics →', unmatched.map((u) => u.summary).join(' | '));
