#!/usr/bin/env node
/**
 * Pull live HubSpot Company + Owner data via the Service Key in .env.local.
 *
 * The xlsx "Hubspot Instance Sync Sheet" tab is actually a JOINED report
 * combining HubSpot + Stripe + the Allmoxy core DB. This script handles only
 * the HubSpot-native subset — the fields that change most frequently and
 * benefit from live refreshes. Installer ID / Directory / Allmoxy Customer ID
 * / Realm continue to come from the xlsx (`allmoxy_core_customer` tab)
 * because those fields aren't stored in HubSpot. Pay Status / Subscription
 * IDs / Churn Reason currently stay xlsx-sourced too — we can add a Stripe
 * API path later if we want them live.
 *
 * Outputs:
 *   _etl_scripts/cache/hubspot_companies.json
 *   _etl_scripts/cache/hubspot_owners.json
 *
 * `build_customer_profiles.mjs` reads these (when present) as an enrichment
 * overlay — fields available here win over the xlsx values for the same key.
 *
 * Usage:
 *   node _etl_scripts/sync_hubspot.mjs           # pull all companies
 *   node _etl_scripts/sync_hubspot.mjs --quick   # skip lifecyclestage filter, fastest
 *   node _etl_scripts/sync_hubspot.mjs --verbose # log per-batch progress
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const CACHE_DIR = path.join(ROOT, '_etl_scripts/cache');
const COMPANIES_OUT = path.join(CACHE_DIR, 'hubspot_companies.json');
const OWNERS_OUT = path.join(CACHE_DIR, 'hubspot_owners.json');
const INSTANCES_OUT = path.join(CACHE_DIR, 'hubspot_instances.json');
const QUOTES_OUT = path.join(CACHE_DIR, 'hubspot_quotes.json');

// Allmoxy Instance custom object type (per the HubSpot URL we discovered in
// the property settings page). Internal HubSpot name is `accounts` (plural
// confirmed via /crm/v3/schemas). Carries the per-instance fields the Renewal
// Management page needs — calculated_renewal_date, contract_status, monthly
// flat fee, renewal expansion history, etc. — none of which live on Company.
const INSTANCE_OBJECT_TYPE = '2-39181518';

const args = new Set(process.argv.slice(2));
const QUICK = args.has('--quick');
const VERBOSE = args.has('--verbose');

// --- Token load ------------------------------------------------------------
function loadToken() {
  if (process.env.HUBSPOT_TOKEN) return process.env.HUBSPOT_TOKEN;
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`No HUBSPOT_TOKEN env var and no ${ENV_PATH} file found.`);
  }
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  const m = content.match(/^HUBSPOT_TOKEN=(.+)$/m);
  if (!m) throw new Error(`HUBSPOT_TOKEN= line not found in ${ENV_PATH}`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const TOKEN = loadToken();
if (!TOKEN) throw new Error('HUBSPOT_TOKEN is empty.');

// --- HubSpot API helper with retry + rate-limit handling -------------------
const HUB_BASE = 'https://api.hubapi.com';

async function hub(path, init = {}) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${HUB_BASE}${path}`, { ...init, headers });
    if (res.status === 429) {
      // Rate-limited: HubSpot says wait Retry-After seconds
      const retryAfter = Number(res.headers.get('Retry-After') || 10);
      if (VERBOSE) process.stderr.write(`  rate-limited, sleeping ${retryAfter}s...\n`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HubSpot ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  }
  throw new Error(`HubSpot request failed after retries: ${path}`);
}

// --- The fields we want from each Company ----------------------------------
// All confirmed to exist via /crm/v3/properties/companies. The xlsx Sync Sheet
// has additional columns (Installer ID, Directory, Realm, Allmoxy Customer ID,
// Pay Status, Subscription IDs, Churn Reason) that DON'T live in HubSpot —
// they come from the Allmoxy core DB and Stripe joins.
const COMPANY_PROPS = [
  'name',
  'stripe_company_id',
  'hubspot_owner_id',
  'primary_segment_framework',
  'sub_segment_framework',
  'secondary_segment_framework',
  'contract_status',
  'notes_last_contacted',
  'lifecyclestage',
  'is_this_customer_launched_',
  'actual_launch_date',
  'goal_launch_date',
  'cs_start_date',
  'customer_health_cs_pulse',
  'instance_connected_to_stripe',
  'instance_processed_a_payment',
  'jira_customer_label',
  'vip_legacy_customer',
  'allmoxy_main_poc',
  'custom_domain',
  'createdate',
  'hs_lastmodifieddate',
  // Merge tracking — when HubSpot merges Company A into Company B, B's record
  // gains `hs_merged_object_ids` containing A's id. We use this to redirect
  // stale ids (from the source xlsx Sync Sheet) to the current surviving
  // company. Without it, ~60 customers map to ghost ids and miss recency /
  // pulse / owner enrichment.
  'hs_merged_object_ids',
];

// --- Pull all companies (paginated) ----------------------------------------
async function pullCompanies() {
  const companies = [];
  let after = undefined;
  let page = 0;
  const limit = 100;
  const propsParam = COMPANY_PROPS.join(',');
  while (true) {
    page++;
    const url = `/crm/v3/objects/companies?limit=${limit}&properties=${encodeURIComponent(propsParam)}${after ? `&after=${after}` : ''}`;
    const data = await hub(url);
    const batch = data.results || [];
    for (const c of batch) {
      companies.push({
        id: c.id,
        ...c.properties,
      });
    }
    process.stderr.write(`  page ${page}: ${batch.length} companies (total so far: ${companies.length})\n`);
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return companies;
}

// --- The fields we want from each Instance (custom object 2-39181518) ------
// Discovered via _etl_scripts/discover_instance_schema.mjs against the live
// schema (120 total properties on the object). This subset covers the renewal
// pipeline, contract details, ROI-relevant payment lifecycle, health signals,
// engagement, and churn context. Joined to customer_profiles via
// `allmoxy_customer_id` directly on the Instance (no association traversal).
const INSTANCE_PROPS = [
  // Identity / joins
  'account_name',
  'allmoxy_customer_id',
  'installer_id',
  'installer_url',
  'stripe_company_id',
  'stripe_subscription_id',
  'stripe_connect_id',
  'custom_domain_stripe_subscription_id',
  // Renewal / contract
  'calculated_renewal_date',
  'renewal_date',
  'contract_status',
  'contract_length_months_',
  'monthly_flat_fee',
  'renewal_expansion_revenue',
  'reason_s__for_no_renewal_expansion_revenue',
  // Lifecycle dates
  'instance_creation',
  'payment_start_date',
  'payment_pause_date',
  'last_payment_date',
  'merchant_connect_date',
  'goal_launch_date__cloned_',
  // Status / health
  'status',
  'is_this_customer_launched___cloned_',
  'customer_health_cs_pulse__cloned_',
  'health_score',
  'health_score_status',
  'vip_legacy_customer__cloned_',
  'hs_current_customer',
  // Ownership / journey
  'hubspot_owner_id',
  'hubspot_team_id',
  'implementation_status',
  'customer_s_purpose_of_adopting_allmoxy',
  // Engagement signal
  'customer_entered_orders___prev__billing_period',
  // Churn context
  'customer_closed_lost__cloned_',
  'reason_why_customer_is_in_the_churn_assessment_meeting',
  // Audit
  'hs_createdate',
  'hs_lastmodifieddate',
];

// --- Pull all Instances (paginated) ----------------------------------------
async function pullInstances() {
  const instances = [];
  let after = undefined;
  let page = 0;
  const limit = 100;
  const propsParam = INSTANCE_PROPS.join(',');
  while (true) {
    page++;
    const url = `/crm/v3/objects/${INSTANCE_OBJECT_TYPE}?limit=${limit}&properties=${encodeURIComponent(propsParam)}${after ? `&after=${after}` : ''}`;
    const data = await hub(url);
    const batch = data.results || [];
    for (const inst of batch) {
      instances.push({
        id: inst.id,
        ...inst.properties,
        createdAt: inst.createdAt,
        updatedAt: inst.updatedAt,
      });
    }
    process.stderr.write(`  page ${page}: ${batch.length} instances (total so far: ${instances.length})\n`);
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return instances;
}

// --- Quotes ----------------------------------------------------------------
// Per-quote properties that matter for the Renewal Management view: title,
// status (DRAFT/PENDING_APPROVAL/APPROVAL_NOT_NEEDED/REJECTED/etc.), amount,
// currency, creation + expiration dates, and the owner. The HubSpot UI URL
// is reconstructable from the id but we capture it from the API response too.
const QUOTE_PROPS = [
  'hs_title',
  'hs_status',
  'hs_quote_amount',
  'hs_currency',
  'hs_createdate',
  'hs_expiration_date',
  'hs_lastmodifieddate',
  'hubspot_owner_id',
  'hs_quote_number',
  'hs_quote_link',
  'hs_payment_status',
];

// Pull all quotes paginated. Includes the `associations=companies` query so
// the response also carries each quote's company association IDs — that's
// how we tie a quote back to a customer (Company → allmoxy_customer_id).
async function pullQuotes() {
  const quotes = [];
  let after = undefined;
  let page = 0;
  const limit = 100;
  const propsParam = QUOTE_PROPS.join(',');
  while (true) {
    page++;
    const url = `/crm/v3/objects/quotes?limit=${limit}&properties=${encodeURIComponent(propsParam)}&associations=companies${after ? `&after=${after}` : ''}`;
    const data = await hub(url);
    const batch = data.results || [];
    for (const q of batch) {
      const companyIds = (q.associations?.companies?.results ?? []).map((r) => String(r.id));
      quotes.push({
        id: String(q.id),
        ...q.properties,
        associated_company_ids: companyIds,
        hubspot_url: `https://app.hubspot.com/quotes/4910812/details/${q.id}`,
      });
    }
    process.stderr.write(`  page ${page}: ${batch.length} quotes (total so far: ${quotes.length})\n`);
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return quotes;
}

// --- Pull all owners --------------------------------------------------------
async function pullOwners() {
  const owners = [];
  let after = undefined;
  let page = 0;
  while (true) {
    page++;
    const url = `/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`;
    const data = await hub(url);
    const batch = data.results || [];
    for (const o of batch) owners.push(o);
    if (VERBOSE) process.stderr.write(`  owners page ${page}: ${batch.length}\n`);
    after = data.paging?.next?.after;
    if (!after) break;
  }
  return owners;
}

// --- Main -------------------------------------------------------------------
async function main() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  process.stderr.write('Pulling HubSpot owners...\n');
  const ownersRaw = await pullOwners();
  const ownersById = {};
  for (const o of ownersRaw) {
    ownersById[String(o.id)] = {
      id: String(o.id),
      first_name: o.firstName || null,
      last_name: o.lastName || null,
      email: o.email || null,
      full_name: [o.firstName, o.lastName].filter(Boolean).join(' ') || null,
      user_id: o.userId != null ? String(o.userId) : null,
    };
  }
  fs.writeFileSync(OWNERS_OUT, JSON.stringify({
    fetched_at: new Date().toISOString(),
    owner_count: Object.keys(ownersById).length,
    owners_by_id: ownersById,
  }, null, 2));
  process.stderr.write(`  → ${Object.keys(ownersById).length} owners → ${path.relative(ROOT, OWNERS_OUT)}\n\n`);

  process.stderr.write('Pulling HubSpot companies (paginated)...\n');
  const companies = await pullCompanies();

  // Enrich each company with the resolved owner first/full name so downstream
  // doesn't need to do the lookup.
  for (const c of companies) {
    const ownerId = c.hubspot_owner_id ? String(c.hubspot_owner_id) : null;
    const owner = ownerId ? ownersById[ownerId] : null;
    c.owner_first_name = owner?.first_name || null;
    c.owner_full_name = owner?.full_name || null;
    c.owner_email = owner?.email || null;
  }

  // Summary stats: how many of each interesting status
  const lifeCounts = {};
  let withStripe = 0, withSegment = 0, withOwner = 0, withRecency = 0;
  for (const c of companies) {
    const stage = c.lifecyclestage || '(none)';
    lifeCounts[stage] = (lifeCounts[stage] || 0) + 1;
    if (c.stripe_company_id) withStripe++;
    if (c.primary_segment_framework) withSegment++;
    if (c.hubspot_owner_id) withOwner++;
    if (c.notes_last_contacted) withRecency++;
  }

  fs.writeFileSync(COMPANIES_OUT, JSON.stringify({
    fetched_at: new Date().toISOString(),
    source: 'HubSpot CRM API /crm/v3/objects/companies',
    portal_id: '4910812',
    company_count: companies.length,
    properties_fetched: COMPANY_PROPS,
    stats: {
      with_stripe_company_id: withStripe,
      with_primary_segment: withSegment,
      with_owner: withOwner,
      with_last_contacted: withRecency,
      by_lifecyclestage: lifeCounts,
    },
    companies,
  }, null, 2));

  process.stderr.write(`\n  → ${companies.length} companies → ${path.relative(ROOT, COMPANIES_OUT)}\n`);
  process.stderr.write('\nLifecycle stages:\n');
  for (const [k, v] of Object.entries(lifeCounts).sort((a, b) => b[1] - a[1])) {
    process.stderr.write(`  ${String(v).padStart(4)} ${k}\n`);
  }
  process.stderr.write('\nField coverage:\n');
  process.stderr.write(`  ${withStripe}/${companies.length} have stripe_company_id (the join key to our Stripe data)\n`);
  process.stderr.write(`  ${withSegment}/${companies.length} have primary_segment\n`);
  process.stderr.write(`  ${withOwner}/${companies.length} have an owner\n`);
  process.stderr.write(`  ${withRecency}/${companies.length} have notes_last_contacted\n`);
  process.stderr.write('\nNot pulled from HubSpot (these stay xlsx-sourced):\n');
  process.stderr.write('  - Installer ID, Directory, Allmoxy Customer ID, Realm  → allmoxy_core_customer tab\n');
  process.stderr.write('  - Pay Status, Stripe Subscription IDs, Churn Reason     → would need Stripe API\n');

  // ─── Instance custom object sync ─────────────────────────────────────────
  // Powers the Renewal Management page. Carries calculated_renewal_date,
  // contract terms, monthly_flat_fee, renewal-expansion history, and the
  // Instance-level Pulse — none of which live on the Company object.
  process.stderr.write('\nPulling HubSpot Instances (paginated)...\n');
  const instances = await pullInstances();
  let withRenewal = 0, withContract = 0, withCustId = 0, withMonthlyFee = 0;
  const byPayStatus = {};
  const byContractStatus = {};
  for (const i of instances) {
    if (i.calculated_renewal_date || i.renewal_date) withRenewal++;
    if (i.contract_status && i.contract_status !== 'No') withContract++;
    if (i.allmoxy_customer_id) withCustId++;
    if (i.monthly_flat_fee) withMonthlyFee++;
    const ps = i.status || '(none)';
    byPayStatus[ps] = (byPayStatus[ps] || 0) + 1;
    const cs = i.contract_status || '(none)';
    byContractStatus[cs] = (byContractStatus[cs] || 0) + 1;
  }
  fs.writeFileSync(INSTANCES_OUT, JSON.stringify({
    fetched_at: new Date().toISOString(),
    source: `HubSpot CRM API /crm/v3/objects/${INSTANCE_OBJECT_TYPE}`,
    portal_id: '4910812',
    object_type: INSTANCE_OBJECT_TYPE,
    object_label: 'Instance',
    instance_count: instances.length,
    properties_fetched: INSTANCE_PROPS,
    stats: {
      with_allmoxy_customer_id: withCustId,
      with_renewal_date: withRenewal,
      with_active_contract: withContract,
      with_monthly_flat_fee: withMonthlyFee,
      by_pay_status: byPayStatus,
      by_contract_status: byContractStatus,
    },
    instances,
  }, null, 2));
  process.stderr.write(`  → ${instances.length} instances → ${path.relative(ROOT, INSTANCES_OUT)}\n`);
  process.stderr.write('\n  Field coverage:\n');
  process.stderr.write(`    ${withCustId}/${instances.length} have allmoxy_customer_id (join key)\n`);
  process.stderr.write(`    ${withRenewal}/${instances.length} have a renewal date\n`);
  process.stderr.write(`    ${withContract}/${instances.length} have an active contract\n`);
  process.stderr.write(`    ${withMonthlyFee}/${instances.length} have monthly_flat_fee set\n`);
  process.stderr.write('  Pay status distribution:\n');
  for (const [k, v] of Object.entries(byPayStatus).sort((a, b) => b[1] - a[1])) {
    process.stderr.write(`    ${String(v).padStart(4)} ${k}\n`);
  }
  process.stderr.write('  Contract status distribution:\n');
  for (const [k, v] of Object.entries(byContractStatus).sort((a, b) => b[1] - a[1])) {
    process.stderr.write(`    ${String(v).padStart(4)} ${k}\n`);
  }

  // ─── Quotes sync ─────────────────────────────────────────────────────────
  // Powers the Renewal Management "renewals with quote" KPI + the per-row
  // and per-customer quote links. Pulls company associations so each quote
  // can be tied back to an allmoxy_customer_id downstream.
  process.stderr.write('\nPulling HubSpot Quotes (paginated)...\n');
  const quotes = await pullQuotes();
  const byStatus = {};
  let withCompany = 0, totalAmount = 0;
  for (const q of quotes) {
    const st = q.hs_status || '(none)';
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (q.associated_company_ids.length > 0) withCompany++;
    totalAmount += Number(q.hs_quote_amount) || 0;
  }
  fs.writeFileSync(QUOTES_OUT, JSON.stringify({
    fetched_at: new Date().toISOString(),
    source: 'HubSpot CRM API /crm/v3/objects/quotes?associations=companies',
    portal_id: '4910812',
    quote_count: quotes.length,
    properties_fetched: QUOTE_PROPS,
    stats: {
      with_company_assoc: withCompany,
      total_amount_all_statuses: Math.round(totalAmount * 100) / 100,
      by_status: byStatus,
    },
    quotes,
  }, null, 2));
  process.stderr.write(`  → ${quotes.length} quotes → ${path.relative(ROOT, QUOTES_OUT)}\n`);
  process.stderr.write(`    ${withCompany}/${quotes.length} have a company association\n`);
  process.stderr.write('  Status distribution:\n');
  for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    process.stderr.write(`    ${String(v).padStart(4)} ${k}\n`);
  }

  process.stderr.write('\nDone.\n');
}

main().catch((err) => {
  process.stderr.write(`\nERROR: ${err.message}\n`);
  process.exit(1);
});
