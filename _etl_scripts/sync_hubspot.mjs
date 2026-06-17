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

  process.stderr.write('\nDone.\n');
}

main().catch((err) => {
  process.stderr.write(`\nERROR: ${err.message}\n`);
  process.exit(1);
});
