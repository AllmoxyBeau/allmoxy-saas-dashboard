#!/usr/bin/env node
/**
 * Pull Harvest clients, projects, and time entries → _etl_scripts/cache/harvest_implementation.json.
 *
 * Harvest is the time-tracking + services-revenue source. Join to customers is
 * exact: Harvest client_id == customer_profiles.harvest_id (501/501 match).
 * Per-customer implementation projects are named "{Customer} Implementation".
 *
 * We pull ALL time entries (per_page=2000 → ~9 pages) and aggregate hours +
 * billable $ per project, so build_implementation.mjs can attach effort/$ to
 * each customer without re-querying.
 *
 * Auth: Authorization: Bearer <HARVEST_TOKEN> + Harvest-Account-Id header.
 * Usage: node _etl_scripts/sync_harvest.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const CACHE_DIR = path.join(ROOT, '_etl_scripts/cache');
const OUT = path.join(CACHE_DIR, 'harvest_implementation.json');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const VERBOSE = process.argv.includes('--verbose');

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
for (const k of ['HARVEST_ACCOUNT_ID', 'HARVEST_TOKEN']) {
  if (!ENV[k]) throw new Error(`Missing ${k} in .env.local`);
}
const BASE = 'https://api.harvestapp.com/v2';
const HEADERS = {
  Authorization: `Bearer ${ENV.HARVEST_TOKEN}`,
  'Harvest-Account-Id': ENV.HARVEST_ACCOUNT_ID,
  'User-Agent': 'allmoxy-saas-dashboard (beau@allmoxy.com)',
  Accept: 'application/json',
};

async function getJSON(url, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get('retry-after') || 2) * 1000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${label} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`${label} → exhausted retries`);
}

// Walk Harvest's page links. `key` is the array property (clients/projects/time_entries).
async function pageAll(pathAndQuery, key) {
  const out = [];
  let url = `${BASE}${pathAndQuery}`;
  for (let i = 0; i < 200 && url; i++) {
    const d = await getJSON(url, key);
    out.push(...(d[key] || []));
    url = d.links?.next || null;
    if (VERBOSE) console.log(`  ${key}: ${out.length}/${d.total_entries ?? '?'}`);
  }
  return out;
}

const IMPL_RE = /implement/i; // "{Customer} Implementation" naming convention

(async () => {
  const me = await getJSON(`${BASE}/users/me`, 'users/me');
  console.log(`✓ Harvest auth ok as ${me.first_name} ${me.last_name}`);

  const clients = await pageAll('/clients?per_page=2000', 'clients');
  const projects = await pageAll('/projects?per_page=2000', 'projects');
  console.log(`✓ ${clients.length} clients, ${projects.length} projects`);

  // Aggregate hours + billable $ per project from ALL time entries.
  const entries = await pageAll('/time_entries?per_page=2000', 'time_entries');
  console.log(`✓ ${entries.length} time entries`);
  const agg = new Map(); // project_id -> aggregate
  for (const e of entries) {
    const pid = e.project?.id;
    if (pid == null) continue;
    if (!agg.has(pid)) agg.set(pid, { hours: 0, billable_hours: 0, billable_amount: 0, entry_count: 0, first_entry: null, last_entry: null });
    const a = agg.get(pid);
    const h = e.hours || 0;
    a.hours += h;
    a.entry_count += 1;
    if (e.billable) {
      a.billable_hours += h;
      // billable_rate can be null for fixed-fee; amount then stays 0 here and
      // the project-level fee is the revenue figure (handled in build).
      a.billable_amount += h * (e.billable_rate || 0);
    }
    const d = e.spent_date;
    if (d) {
      if (!a.first_entry || d < a.first_entry) a.first_entry = d;
      if (!a.last_entry || d > a.last_entry) a.last_entry = d;
    }
  }

  // Slim the projects to what build needs, flag implementation projects.
  const slimProjects = projects.map((p) => {
    const a = agg.get(p.id) || {};
    return {
      id: p.id,
      name: p.name,
      code: p.code ?? null,
      client_id: p.client?.id ?? null,
      client_name: p.client?.name ?? null,
      is_active: p.is_active,
      is_billable: p.is_billable,
      bill_by: p.bill_by, // Project | Tasks | People | none
      budget_by: p.budget_by, // project | project_cost | task | none ... (fixed-fee => *_fees)
      fee: p.fee ?? null, // fixed project fee (project-based billing)
      hourly_rate: p.hourly_rate ?? null,
      budget: p.budget ?? null,
      starts_on: p.starts_on ?? null,
      ends_on: p.ends_on ?? null,
      is_implementation: IMPL_RE.test(p.name || ''),
      hours: Math.round((a.hours || 0) * 100) / 100,
      billable_hours: Math.round((a.billable_hours || 0) * 100) / 100,
      billable_amount: Math.round((a.billable_amount || 0) * 100) / 100,
      entry_count: a.entry_count || 0,
      first_entry: a.first_entry || null,
      last_entry: a.last_entry || null,
    };
  });

  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'harvest:/v2',
    clients: clients.map((c) => ({ id: c.id, name: c.name, is_active: c.is_active })),
    projects: slimProjects,
    totals: {
      implementation_projects: slimProjects.filter((p) => p.is_implementation).length,
      time_entries: entries.length,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  const billBy = {};
  slimProjects.filter((p) => p.is_implementation).forEach((p) => { billBy[p.bill_by] = (billBy[p.bill_by] || 0) + 1; });
  console.log(`✓ ${payload.totals.implementation_projects} implementation projects → ${path.relative(ROOT, OUT)}`);
  console.log('  impl bill_by:', JSON.stringify(billBy));
})().catch((e) => { console.error('✗ sync_harvest failed:', e.message); process.exit(1); });
