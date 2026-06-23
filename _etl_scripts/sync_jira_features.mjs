#!/usr/bin/env node
/**
 * Pull DEV-board feature tickets that are tagged with customers, for the
 * Customer Success → Features page. Each DEV ticket carries a "Customer" labels
 * field (customfield_10242) listing the customers who want / are affected by it.
 * The Features page joins those to customer revenue so CS can show Dev the
 * revenue weight behind each ticket.
 *
 * Output: _etl_scripts/cache/jira_features.json
 *
 * Auth: classic UNSCOPED Atlassian API token (HTTP Basic). Uses the new
 * /rest/api/3/search/jql endpoint (cursor pagination; no total).
 *
 * Usage: node _etl_scripts/sync_jira_features.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const OUT = path.join(ROOT, '_etl_scripts/cache/jira_features.json');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const VERBOSE = process.argv.includes('--verbose');

const PROJECT = 'DEV';
const CUSTOMER_FIELD = 'customfield_10242'; // "Customer" (labels)
const SCORE_FIELD = 'customfield_10073';    // "Issue Score" (Dev-side priority score)
const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'created', 'updated', 'resolutiondate', CUSTOMER_FIELD, SCORE_FIELD].join(',');

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
for (const k of ['JIRA_BASE', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) if (!ENV[k]) throw new Error(`Missing ${k} in .env.local`);
const BASE = ENV.JIRA_BASE.replace(/\/$/, '');
const AUTH = Buffer.from(`${ENV.JIRA_EMAIL}:${ENV.JIRA_API_TOKEN}`).toString('base64');
const HEADERS = { Authorization: `Basic ${AUTH}`, Accept: 'application/json' };

async function getJSON(url, label) {
  for (let attempt = 0; attempt < 4; attempt++) {
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

(async () => {
  const me = await getJSON(`${BASE}/rest/api/3/myself`, 'myself');
  console.log(`✓ JIRA auth ok as ${me.displayName}`);

  const jql = encodeURIComponent(`project = ${PROJECT} AND cf[10242] IS NOT EMPTY ORDER BY updated DESC`);
  const tickets = [];
  let token = null;
  for (let i = 0; i < 100; i++) {
    let url = `${BASE}/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${FIELDS}`;
    if (token) url += `&nextPageToken=${token}`;
    const d = await getJSON(url, 'search DEV features');
    for (const issue of (d.issues || [])) {
      const f = issue.fields || {};
      tickets.push({
        key: issue.key,
        summary: (f.summary || '').trim(),
        status: f.status?.name ?? null,
        stage_category: f.status?.statusCategory?.name ?? null, // To Do | In Progress | Done
        issue_type: f.issuetype?.name ?? null,
        priority: f.priority?.name ?? null,
        issue_score: f[SCORE_FIELD] != null ? Number(f[SCORE_FIELD]) : null,
        customers: Array.isArray(f[CUSTOMER_FIELD]) ? f[CUSTOMER_FIELD] : [],
        created: f.created ? f.created.slice(0, 10) : null,
        updated: f.updated ? f.updated.slice(0, 10) : null,
        resolved: f.resolutiondate ? f.resolutiondate.slice(0, 10) : null,
        url: `${BASE}/browse/${issue.key}`,
      });
    }
    if (VERBOSE) console.log(`  +${d.issues?.length || 0} (running ${tickets.length})`);
    if (d.isLast || !d.nextPageToken) break;
    token = d.nextPageToken;
  }

  fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), source: 'jira:DEV cf[10242]', project: PROJECT, tickets }, null, 2));
  const byStatus = {};
  tickets.forEach((t) => { byStatus[t.stage_category] = (byStatus[t.stage_category] || 0) + 1; });
  const tagged = new Set(tickets.flatMap((t) => t.customers)).size;
  console.log(`✓ ${tickets.length} DEV feature tickets (${tagged} distinct customer tags) → ${path.relative(ROOT, OUT)}`);
  console.log('  by category:', JSON.stringify(byStatus));
})().catch((e) => { console.error('✗ sync_jira_features failed:', e.message); process.exit(1); });
