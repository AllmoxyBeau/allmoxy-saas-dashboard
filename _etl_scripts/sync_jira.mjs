#!/usr/bin/env node
/**
 * Pull implementation Epics from JIRA Cloud → _etl_scripts/cache/jira_implementation.json.
 *
 * Implementation work is tracked as Epics in the IPA ("IMP Pooled Async")
 * project: the epic SUMMARY is the customer name and the epic STATUS is the
 * implementation stage (Stage 1: Discovery, Stage 2: Prototyping, Waiting on
 * Customer, On Hold / Abandoned, Done). The structured "Customer Name" field
 * (customfield_10171) is NOT used for these, so build_implementation.mjs joins
 * by epic-summary name-match to the customer roster.
 *
 * Auth: classic UNSCOPED Atlassian API token via HTTP Basic (email:token).
 * Scoped tokens 401 with "scope does not match" on the site URL — don't use one.
 * The old /rest/api/3/search is 410 Gone; we use /rest/api/3/search/jql
 * (cursor pagination via nextPageToken; it does not return a total count).
 *
 * Usage: node _etl_scripts/sync_jira.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env.local');
const CACHE_DIR = path.join(ROOT, '_etl_scripts/cache');
const OUT = path.join(CACHE_DIR, 'jira_implementation.json');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const VERBOSE = process.argv.includes('--verbose');

// Projects whose Epics represent customer implementation projects. Per the
// discovery pass this is IPA only; widen here if Plan 314 draws from more.
const PROJECTS = ['IPA'];

// Epic fields we keep. Target start/end are usually empty on these epics
// (schedule comes from Harvest) but we capture them in case the team backfills.
const FIELDS = [
  'summary', 'status', 'issuetype', 'assignee', 'created', 'updated',
  'duedate', 'labels', 'customfield_10173', 'customfield_10174',
].join(',');

// Task (child issue) fields — the work items under each epic. Their dates drive
// the schedule: start = earliest created, end = latest due (or last update).
const TASK_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'created', 'updated', 'duedate', 'parent'].join(',');

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
for (const k of ['JIRA_BASE', 'JIRA_EMAIL', 'JIRA_API_TOKEN']) {
  if (!ENV[k]) throw new Error(`Missing ${k} in .env.local`);
}
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

async function epicsForProject(proj) {
  const out = [];
  let token = null;
  for (let i = 0; i < 50; i++) {
    const jql = encodeURIComponent(`project = ${proj} AND issuetype = Epic ORDER BY created DESC`);
    let url = `${BASE}/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${FIELDS}`;
    if (token) url += `&nextPageToken=${token}`;
    const d = await getJSON(url, `search ${proj}`);
    for (const issue of (d.issues || [])) {
      const f = issue.fields || {};
      out.push({
        key: issue.key,
        project: proj,
        summary: (f.summary || '').trim(),
        stage: f.status?.name ?? null,
        stage_category: f.status?.statusCategory?.name ?? null, // To Do | In Progress | Done
        issue_type: f.issuetype?.name ?? null,
        assignee: f.assignee?.displayName ?? null,
        labels: f.labels ?? [],
        target_start: f.customfield_10173 ?? null,
        target_end: f.customfield_10174 ?? null,
        due_date: f.duedate ?? null,
        created: f.created ?? null,
        updated: f.updated ?? null,
        url: `${BASE}/browse/${issue.key}`,
      });
    }
    if (VERBOSE) console.log(`  ${proj}: +${d.issues?.length || 0} (running ${out.length})`);
    if (d.isLast || !d.nextPageToken) break;
    token = d.nextPageToken;
  }
  return out;
}

// All non-epic issues (the tasks) for a project, grouped by parent epic key.
async function tasksByParentForProject(proj) {
  const byParent = {};
  let token = null;
  for (let i = 0; i < 50; i++) {
    const jql = encodeURIComponent(`project = ${proj} AND issuetype != Epic ORDER BY created ASC`);
    let url = `${BASE}/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=${TASK_FIELDS}`;
    if (token) url += `&nextPageToken=${token}`;
    const d = await getJSON(url, `tasks ${proj}`);
    for (const issue of (d.issues || [])) {
      const f = issue.fields || {};
      const parentKey = f.parent?.key;
      if (!parentKey) continue; // only tasks linked to an epic drive that epic's span
      (byParent[parentKey] = byParent[parentKey] || []).push({
        key: issue.key,
        summary: (f.summary || '').trim(),
        status: f.status?.name ?? null,
        stage_category: f.status?.statusCategory?.name ?? null,
        assignee: f.assignee?.displayName ?? null,
        created: f.created ? f.created.slice(0, 10) : null,
        updated: f.updated ? f.updated.slice(0, 10) : null,
        due: f.duedate || null,
        url: `${BASE}/browse/${issue.key}`,
      });
    }
    if (d.isLast || !d.nextPageToken) break;
    token = d.nextPageToken;
  }
  return byParent;
}

(async () => {
  const me = await getJSON(`${BASE}/rest/api/3/myself`, 'myself');
  console.log(`✓ JIRA auth ok as ${me.displayName}`);
  let epics = [];
  for (const p of PROJECTS) epics = epics.concat(await epicsForProject(p));

  // Attach child tasks + a task-derived schedule span to each epic.
  const minOf = (arr) => arr.filter(Boolean).sort()[0] ?? null;
  const maxOf = (arr) => arr.filter(Boolean).sort().slice(-1)[0] ?? null;
  for (const p of PROJECTS) {
    const byParent = await tasksByParentForProject(p);
    for (const e of epics.filter((x) => x.project === p)) {
      const tasks = byParent[e.key] || [];
      e.tasks = tasks;
      e.task_count = tasks.length;
      e.tasks_done = tasks.filter((t) => t.stage_category === 'Done').length;
      // start = earliest task created; end = latest due, else latest update.
      e.task_start = minOf(tasks.map((t) => t.created));
      e.task_end = maxOf(tasks.map((t) => t.due || t.updated));
    }
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: 'jira:/rest/api/3/search/jql',
    projects: PROJECTS,
    epics,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  const byStage = {};
  epics.forEach((e) => { byStage[e.stage] = (byStage[e.stage] || 0) + 1; });
  const totalTasks = epics.reduce((s, e) => s + (e.task_count || 0), 0);
  console.log(`✓ ${epics.length} epics (${totalTasks} linked tasks) from ${PROJECTS.join(', ')} → ${path.relative(ROOT, OUT)}`);
  console.log('  by stage:', JSON.stringify(byStage));
})().catch((e) => { console.error('✗ sync_jira failed:', e.message); process.exit(1); });
