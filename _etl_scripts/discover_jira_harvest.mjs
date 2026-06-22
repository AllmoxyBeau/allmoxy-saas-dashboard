#!/usr/bin/env node
/**
 * One-shot introspection of JIRA Cloud + Harvest so we can see the REAL schema
 * (custom-field names, project/client lists, billing methods, join keys) before
 * writing the production sync_jira.mjs / sync_harvest.mjs scripts.
 *
 * Reads creds from .env.local (same loader style as sync_hubspot.mjs):
 *   JIRA_BASE, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PLAN_ID
 *   HARVEST_ACCOUNT_ID, HARVEST_TOKEN
 *
 * Writes raw dumps to _etl_scripts/cache/discover_*.json and prints a concise
 * human summary to stdout. Read-only — makes no writes to JIRA or Harvest.
 *
 * Usage:
 *   node _etl_scripts/discover_jira_harvest.mjs
 *   node _etl_scripts/discover_jira_harvest.mjs --jira-only
 *   node _etl_scripts/discover_jira_harvest.mjs --harvest-only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const CACHE_DIR = path.join(ROOT, '_etl_scripts/cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const args = new Set(process.argv.slice(2));
const JIRA_ONLY = args.has('--jira-only');
const HARVEST_ONLY = args.has('--harvest-only');

// --- env loader (mirrors sync_hubspot.mjs) ---------------------------------
function loadEnv() {
  const env = { ...process.env };
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && env[m[1]] == null) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}
const ENV = loadEnv();

function need(keys) {
  const missing = keys.filter((k) => !ENV[k]);
  return missing;
}

async function getJSON(url, headers, label) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after') || 2) * 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${label} → ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`${label} → exhausted retries`);
}

const write = (name, data) => {
  const p = path.join(CACHE_DIR, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
};

// ===========================================================================
// JIRA
// ===========================================================================
async function discoverJira() {
  const missing = need(['JIRA_BASE', 'JIRA_EMAIL', 'JIRA_API_TOKEN']);
  if (missing.length) {
    console.log(`\n⏭  JIRA — skipped, missing in .env.local: ${missing.join(', ')}`);
    return;
  }
  const base = ENV.JIRA_BASE.replace(/\/$/, '');
  const auth = Buffer.from(`${ENV.JIRA_EMAIL}:${ENV.JIRA_API_TOKEN}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, Accept: 'application/json' };
  console.log('\n=== JIRA ===========================================================');

  // 1. Verify auth.
  const me = await getJSON(`${base}/rest/api/3/myself`, headers, 'myself');
  console.log(`✓ Authenticated as ${me.displayName} <${me.emailAddress || ENV.JIRA_EMAIL}>`);

  // 2. All fields — find custom fields that could carry the customer.
  const fields = await getJSON(`${base}/rest/api/3/field`, headers, 'fields');
  write('discover_jira_fields.json', fields);
  const custom = fields.filter((f) => f.custom);
  const customerish = fields.filter((f) =>
    /custom|account|company|client|customer|organi[sz]ation/i.test(`${f.name} ${f.id}`));
  console.log(`✓ ${fields.length} fields (${custom.length} custom). Customer-looking fields:`);
  customerish.forEach((f) => console.log(`    ${f.id}  —  "${f.name}"`));

  // 3. Projects.
  const projSearch = await getJSON(`${base}/rest/api/3/project/search?maxResults=100`, headers, 'projects');
  write('discover_jira_projects.json', projSearch);
  console.log(`✓ ${projSearch.total ?? projSearch.values?.length} projects:`);
  (projSearch.values || []).forEach((p) => console.log(`    ${p.key}  —  ${p.name} (${p.projectTypeKey})`));

  // 4. Plan issue sources — what feeds Plan 314. The Plans (Advanced Roadmaps)
  //    API is versioned oddly across instances, so we probe a couple of paths
  //    and keep whatever responds.
  if (ENV.JIRA_PLAN_ID) {
    for (const pth of [
      `/rest/plans/1.0/plans/${ENV.JIRA_PLAN_ID}`,
      `/rest/plans/1.0/plans/${ENV.JIRA_PLAN_ID}/issuesources`,
    ]) {
      try {
        const plan = await getJSON(`${base}${pth}`, headers, `plan ${pth}`);
        write(`discover_jira_plan_${pth.split('/').pop()}.json`, plan);
        console.log(`✓ Plan probe ok: ${pth}`);
      } catch (e) {
        console.log(`  · Plan probe ${pth} → ${String(e.message).split(':')[0]}`);
      }
    }
  }

  // 5. Sample issues per project (5 each, all fields) so we can SEE how the
  //    customer is referenced on real implementation issues.
  const samples = {};
  for (const p of (projSearch.values || []).slice(0, 25)) {
    try {
      const jql = encodeURIComponent(`project = ${p.key} ORDER BY updated DESC`);
      const res = await getJSON(`${base}/rest/api/3/search?jql=${jql}&maxResults=5&fields=*all`, headers, `search ${p.key}`);
      samples[p.key] = res.issues || [];
    } catch (e) {
      samples[p.key] = { error: String(e.message) };
    }
  }
  const sp = write('discover_jira_sample_issues.json', samples);
  console.log(`✓ Sample issues per project → ${sp}`);
}

// ===========================================================================
// Harvest
// ===========================================================================
async function discoverHarvest() {
  const missing = need(['HARVEST_ACCOUNT_ID', 'HARVEST_TOKEN']);
  if (missing.length) {
    console.log(`\n⏭  Harvest — skipped, missing in .env.local: ${missing.join(', ')}`);
    return;
  }
  const headers = {
    Authorization: `Bearer ${ENV.HARVEST_TOKEN}`,
    'Harvest-Account-Id': ENV.HARVEST_ACCOUNT_ID,
    'User-Agent': 'allmoxy-saas-dashboard (beau@allmoxy.com)',
    Accept: 'application/json',
  };
  const base = 'https://api.harvestapp.com/v2';
  console.log('\n=== Harvest ========================================================');

  const me = await getJSON(`${base}/users/me`, headers, 'users/me');
  console.log(`✓ Authenticated as ${me.first_name} ${me.last_name} <${me.email}>`);

  const clients = await getJSON(`${base}/clients?per_page=2000`, headers, 'clients');
  write('discover_harvest_clients.json', clients);
  console.log(`✓ ${clients.clients?.length} clients. First 10:`);
  (clients.clients || []).slice(0, 10).forEach((c) => console.log(`    ${c.id}  —  ${c.name}${c.is_active ? '' : ' (inactive)'}`));

  const projects = await getJSON(`${base}/projects?per_page=2000`, headers, 'projects');
  write('discover_harvest_projects.json', projects);
  const billBy = {};
  (projects.projects || []).forEach((p) => { billBy[p.bill_by] = (billBy[p.bill_by] || 0) + 1; });
  console.log(`✓ ${projects.projects?.length} projects. Billing methods (bill_by): ${JSON.stringify(billBy)}`);
  (projects.projects || []).slice(0, 8).forEach((p) =>
    console.log(`    proj ${p.id} "${p.name}" · client ${p.client?.id} "${p.client?.name}" · bill_by=${p.bill_by} · billable=${p.is_billable} · budget=${p.budget}`));

  const entries = await getJSON(`${base}/time_entries?per_page=5`, headers, 'time_entries');
  write('discover_harvest_time_entries.json', entries);
  console.log(`✓ Sample time entries: ${entries.time_entries?.length} (total available: ${entries.total_entries})`);

  // Cross-check the join: how many Harvest client ids line up with harvest_id
  // on the customer roster.
  try {
    const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/snapshots/customer_profiles.json'), 'utf8'));
    const rows = profiles.rows || profiles.customers || profiles;
    const harvestIds = new Set((Array.isArray(rows) ? rows : []).map((r) => r.harvest_id).filter(Boolean).map(String));
    const clientIds = new Set((clients.clients || []).map((c) => String(c.id)));
    const overlap = [...harvestIds].filter((id) => clientIds.has(id));
    console.log(`\n  Join check: ${harvestIds.size} customers carry a harvest_id; ${overlap.length} match a Harvest client id directly.`);
    if (overlap.length === 0 && harvestIds.size > 0) {
      console.log('  ⚠ No direct id overlap — harvest_id may map to project id or need name-matching. Inspect discover_harvest_clients.json.');
    }
  } catch (e) {
    console.log(`  (join check skipped: ${e.message})`);
  }
}

// ===========================================================================
(async () => {
  try {
    if (!HARVEST_ONLY) await discoverJira();
    if (!JIRA_ONLY) await discoverHarvest();
    console.log('\nDone. Raw dumps in _etl_scripts/cache/discover_*.json — share the stdout summary and I\'ll wire up the sync scripts.');
  } catch (e) {
    console.error('\n✗ Discovery failed:', e.message);
    process.exit(1);
  }
})();
