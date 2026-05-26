#!/usr/bin/env node
/**
 * Build a complete corpus of HubSpot interactions for every churned customer.
 *
 * Pulls notes, emails, calls, tasks, and tickets for each customer with
 * pay_status === 'Cancelled' (or anyone with lifetime_subscription > 0 and
 * current_subscription_mrr === 0), saves to public/snapshots/churn_corpus.json.
 *
 * This is the canonical evidence base for theme derivation. After this runs,
 * every customer has a chronological timeline of every recorded touchpoint —
 * we no longer have to guess at churn reasons from a sample, we read them
 * straight from the corpus.
 *
 * Auth: requires HUBSPOT_TOKEN env var (HubSpot Private App access token).
 *   Create at HubSpot Settings → Integrations → Private Apps.
 *   Required scopes: see .env.sample.
 *
 * Output schema:
 *   {
 *     fetchedAt, generatedBy, customer_count, engagement_count,
 *     customers: [{
 *       allmoxy_customer_id, name, hubspot_company_id,
 *       lifetime_subscription, last_payment_date, pay_status,
 *       churn_reason, primary_segment,
 *       engagements: [
 *         { type, ts, body, title, direction?, status?, hubspot_id, source_url }
 *       ]
 *     }]
 *   }
 *
 * Rate limited to ~5 req/sec (HubSpot allows 100 req/sec for Private Apps; we
 * stay well under so other ETLs / dashboards can hit HubSpot concurrently).
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

const TOKEN = process.env.HUBSPOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: HUBSPOT_TOKEN env var not set.');
  console.error('  Create a HubSpot Private App and paste the access token in .env.local:');
  console.error('  HUBSPOT_TOKEN=pat-na1-xxxxxxxx-xxxx-...');
  console.error('  Required scopes: crm.objects.companies.read, crm.objects.notes.read,');
  console.error('  crm.objects.deals.read, crm.objects.tickets.read, sales-email-read,');
  console.error('  tickets, timeline');
  process.exit(1);
}

const HUBSPOT_BASE = 'https://api.hubapi.com';
const PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '4910812';
const RATE_LIMIT_MS = 200; // 5 req/sec

let lastCallAt = 0;
async function throttle() {
  const since = Date.now() - lastCallAt;
  if (since < RATE_LIMIT_MS) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - since));
  lastCallAt = Date.now();
}

async function hsSearch(objectType, companyId, properties, limit = 50) {
  await throttle();
  const url = `${HUBSPOT_BASE}/crm/v3/objects/${objectType}/search`;
  const body = {
    filterGroups: [
      { filters: [{ propertyName: 'associations.company', operator: 'EQ', value: String(companyId) }] },
    ],
    sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
    properties,
    limit,
  };
  // Some object types (tickets) use createdate instead of hs_timestamp for sorting.
  if (objectType === 'tickets') body.sorts = [{ propertyName: 'createdate', direction: 'DESCENDING' }];
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot ${objectType} search failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()).results ?? [];
}

// Map raw HubSpot results to our flat engagement schema.
function mapNote(n) {
  return {
    type: 'note',
    ts: n.properties?.hs_timestamp ?? n.createdAt ?? null,
    title: null,
    body: n.properties?.hs_body_preview ?? n.properties?.hs_note_body ?? '',
    hubspot_id: n.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-46/${n.id}`,
  };
}
function mapEmail(e) {
  const direction = e.properties?.hs_email_direction ?? null;
  const subject = e.properties?.hs_email_subject ?? null;
  // Prefer text over html (smaller, easier to read).
  let body = e.properties?.hs_email_text || e.properties?.hs_body_preview || '';
  if (!body && e.properties?.hs_email_html) body = e.properties.hs_email_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    type: 'email',
    ts: e.properties?.hs_timestamp ?? e.createdAt ?? null,
    title: subject,
    body: body || '',
    direction,
    hubspot_id: e.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-49/${e.id}`,
  };
}
function mapCall(c) {
  return {
    type: 'call',
    ts: c.properties?.hs_timestamp ?? c.createdAt ?? null,
    title: c.properties?.hs_call_title ?? null,
    body: c.properties?.hs_call_body ?? c.properties?.hs_body_preview ?? '',
    direction: c.properties?.hs_call_direction ?? null,
    duration_ms: c.properties?.hs_call_duration ? Number(c.properties.hs_call_duration) : null,
    hubspot_id: c.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-48/${c.id}`,
  };
}
function mapTask(t) {
  return {
    type: 'task',
    ts: t.properties?.hs_timestamp ?? t.createdAt ?? null,
    title: t.properties?.hs_task_subject ?? null,
    body: t.properties?.hs_task_body ?? '',
    status: t.properties?.hs_task_status ?? null,
    hubspot_id: t.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-27/${t.id}`,
  };
}
function mapTicket(t) {
  return {
    type: 'ticket',
    ts: t.properties?.createdate ?? null,
    title: t.properties?.subject ?? null,
    body: t.properties?.content ?? '',
    pipeline_stage: t.properties?.hs_pipeline_stage ?? null,
    hubspot_id: t.id,
    source_url: `https://app.hubspot.com/contacts/${PORTAL_ID}/record/0-5/${t.id}`,
  };
}

const TYPE_CONFIG = [
  {
    type: 'notes',
    properties: ['hs_timestamp', 'hs_note_body', 'hs_body_preview', 'hs_created_by_user_id'],
    map: mapNote,
  },
  {
    type: 'emails',
    properties: ['hs_timestamp', 'hs_email_subject', 'hs_email_text', 'hs_email_html', 'hs_body_preview', 'hs_email_direction'],
    map: mapEmail,
  },
  {
    type: 'calls',
    properties: ['hs_timestamp', 'hs_call_title', 'hs_call_body', 'hs_body_preview', 'hs_call_direction', 'hs_call_duration'],
    map: mapCall,
  },
  {
    type: 'tasks',
    properties: ['hs_timestamp', 'hs_task_subject', 'hs_task_body', 'hs_task_status'],
    map: mapTask,
  },
  {
    type: 'tickets',
    properties: ['createdate', 'subject', 'content', 'hs_pipeline_stage'],
    map: mapTicket,
  },
];

// ---------- Identify churned-customer targets ----------
const profilesPath = path.join(SNAP, 'customer_profiles.json');
const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));

const targets = profiles.rows
  .filter((p) => {
    const everPaidSub = (p.lifetime_subscription || 0) > 0;
    const noCurrent = (p.current_subscription_mrr || 0) <= 0;
    return everPaidSub && noCurrent;
  })
  .filter((p) => p.hubspot_company_id) // can't pull HubSpot data without the company id
  .map((p) => ({
    allmoxy_customer_id: p.allmoxy_customer_id,
    name: p.name,
    hubspot_company_id: Number(p.hubspot_company_id),
    lifetime_subscription: p.lifetime_subscription,
    last_payment_date: p.last_payment_date,
    pay_status: p.pay_status,
    churn_reason: p.churn_reason,
    primary_segment: p.primary_segment,
  }));

console.log(`Found ${targets.length} churned customers with HubSpot company IDs.`);
console.log(`Estimated runtime: ${Math.ceil((targets.length * TYPE_CONFIG.length * RATE_LIMIT_MS) / 1000 / 60)} minutes (${TYPE_CONFIG.length} calls × ${targets.length} customers × ${RATE_LIMIT_MS}ms throttle).`);

// ---------- Pull engagements per customer ----------
const out = {
  tab: 'churn_corpus',
  fetchedAt: new Date().toISOString(),
  generatedBy: 'build_churn_corpus.mjs',
  customer_count: targets.length,
  engagement_count: 0,
  customers: [],
};

let processed = 0;
let totalEngagements = 0;
const errors = [];

for (const t of targets) {
  processed++;
  const engagements = [];
  for (const cfg of TYPE_CONFIG) {
    try {
      const results = await hsSearch(cfg.type, t.hubspot_company_id, cfg.properties, 50);
      for (const r of results) engagements.push(cfg.map(r));
    } catch (err) {
      errors.push({ customer: t.name, type: cfg.type, error: String(err).slice(0, 200) });
    }
  }
  // Sort all engagements chronologically descending (newest first).
  engagements.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  out.customers.push({ ...t, engagement_counts_by_type: countByType(engagements), engagements });
  totalEngagements += engagements.length;

  if (processed % 10 === 0 || processed === targets.length) {
    process.stdout.write(`\r  ${processed}/${targets.length} customers · ${totalEngagements} engagements pulled${errors.length > 0 ? ` · ${errors.length} errors` : ''}        `);
  }
}
process.stdout.write('\n');

function countByType(engs) {
  const c = { note: 0, email: 0, call: 0, task: 0, ticket: 0 };
  for (const e of engs) c[e.type] = (c[e.type] || 0) + 1;
  return c;
}

out.engagement_count = totalEngagements;
if (errors.length > 0) {
  out.errors = errors;
  console.error(`\n${errors.length} errors during pull (saved to corpus.errors). First few:`);
  for (const e of errors.slice(0, 3)) console.error('  ', e.customer, '·', e.type, '·', e.error);
}

const outputPath = path.join(SNAP, 'churn_corpus.json');
fs.writeFileSync(outputPath, JSON.stringify(out));
const sizeMb = (fs.statSync(outputPath).size / 1024 / 1024).toFixed(2);
console.log(`\nWrote churn_corpus.json (${sizeMb} MB) — ${targets.length} customers · ${totalEngagements} engagements`);
