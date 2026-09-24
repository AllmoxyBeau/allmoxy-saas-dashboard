#!/usr/bin/env node
/**
 * BUG REPORT — every Bug on the JIRA DEV board, with the revenue behind it.
 *
 * Beau, 2026-09-17: "a report of all bug tickets filed in Jira" under Customer Success.
 *
 * Source is the DEV board cache the Features page already pulls (jira_features.json,
 * 4,355 tickets of which 1,338 are Bugs) — no new sync, so this stays current with the
 * same nightly JIRA pull.
 *
 * WHY REVENUE-WEIGHTED. A bug list sorted by priority tells you what engineering thinks
 * is urgent. Sorted by the MRR of the customers who reported it, it tells you what the
 * business is losing while it waits. Both are here; the default is revenue, because
 * that is the view Customer Success needs and the one JIRA cannot give them.
 *
 * Customer labels are concatenated ("LewisCabinetSpecialties"), so matching reuses the
 * exact two-tier normaliser build_features.mjs uses — plain, then legal-suffix-stripped.
 * Reimplementing it differently would silently attribute a different set of bugs.
 *
 * AGE IS MEASURED TO RESOLUTION, OR TO TODAY IF STILL OPEN. A bug that has been open
 * 300 days and one closed in 2 days must never average together, so open and resolved
 * ages are reported separately.
 *
 * Output: public/snapshots/bug_report.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

// DEDICATED DEFECT PULL, not the Features cache. The Features sync filters on
// `cf[10242] IS NOT EMPTY` because it ranks by tagged-customer revenue — and that
// filter silently hid every untagged defect. 8 of the 24 currently-open ones carry no
// customer tag, DEV-13221 among them, which is why this page reported 8 open when Beau
// could see 17 in HubSpot. Falls back to the Features cache if the defect pull has not
// run yet.
const JIRA = (() => {
  const bugs = read(path.join(ROOT, '_etl_scripts/cache/jira_bugs.json'));
  if (bugs?.tickets?.length) return bugs;
  return read(path.join(ROOT, '_etl_scripts/cache/jira_features.json'), { tickets: [] });
})();
const PROF = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];

// Same matcher as build_features.mjs — see the note above.
const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const stripSuffix = (s) => plain(s).replace(/(llc|incorporated|inc|ltd|corp|company|group)/g, '');
const byPlain = new Map(), byStrip = new Map();
for (const p of PROF) {
  const pl = plain(p.name); if (pl && !byPlain.has(pl)) byPlain.set(pl, p);
  const st = stripSuffix(p.name); if (st && !byStrip.has(st)) byStrip.set(st, p);
}
const matchCustomer = (label) => byPlain.get(plain(label)) || byStrip.get(stripSuffix(label)) || null;

const today = new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// The defect pull is already scoped to Bug + Investigate. Both are "something is
// wrong" — Investigate is triage for a reported problem, not new work — and excluding
// it undercounted. The page carries a type filter so either can be isolated.
const DEFECT_TYPES = new Set(['Bug', 'Investigate']);
const bugs = (JIRA.tickets || []).filter((t) => DEFECT_TYPES.has(t.issue_type));
const unmatchedLabels = new Map();

const rows = bugs.map((t) => {
  const matched = [];
  for (const label of (t.customers || [])) {
    const p = matchCustomer(label);
    if (p) matched.push({ allmoxy_customer_id: p.allmoxy_customer_id, name: p.name, mrr: r2(p.current_subscription_mrr || 0), status: p.status });
    else unmatchedLabels.set(label, (unmatchedLabels.get(label) || 0) + 1);
  }
  const seen = new Set();
  const customers = matched.filter((m) => (seen.has(m.allmoxy_customer_id) ? false : seen.add(m.allmoxy_customer_id)));
  // OPEN IS DECIDED BY STAGE, NOT BY THE RESOLVED TIMESTAMP. 33 Bug tickets sit in
  // stage category Done — status Resolved, Closed or In Production — with no resolved
  // date recorded. Trusting the timestamp reported 39 open bugs with a 1,242-day median
  // age when only 6 are genuinely open; those 33 are just closures JIRA never stamped.
  const isOpen = t.stage_category !== 'Done';
  // For a closed ticket with no resolution stamp, `updated` is the best available
  // proxy for when work stopped.
  const closedAt = t.resolved || (isOpen ? null : t.updated || null);
  return {
    key: t.key,
    issue_type: t.issue_type,
    summary: t.summary,
    status: t.status,
    stage_category: t.stage_category,
    priority: t.priority || 'None',
    issue_score: t.issue_score ?? null,
    created: t.created,
    updated: t.updated,
    resolved: t.resolved || null,
    closed_at: closedAt,
    resolution_date_missing: !isOpen && !t.resolved,
    is_open: isOpen,
    age_days: t.created && (isOpen || closedAt) ? daysBetween(t.created, isOpen ? today : closedAt) : null,
    customers,
    customer_count: customers.length,
    // What the open bug is costing attention-wise: the MRR of the accounts waiting on it.
    mrr_affected: r2(customers.reduce((s, c) => s + c.mrr, 0)),
    active_customers_affected: customers.filter((c) => c.status === 'active').length,
    url: t.url,
  };
});

const open = rows.filter((r) => r.is_open);
const resolved = rows.filter((r) => !r.is_open);

// ── monthly: filed vs resolved, and the resulting open backlog ───────────────
const months = new Set();
for (const r of rows) { if (r.created) months.add(r.created.slice(0, 7)); if (r.closed_at) months.add(r.closed_at.slice(0, 7)); }
const sorted = [...months].sort();
let running = 0;
const monthly = sorted.map((m) => {
  const filed = rows.filter((r) => (r.created || '').slice(0, 7) === m).length;
  const closed = rows.filter((r) => (r.closed_at || '').slice(0, 7) === m).length;
  running += filed - closed;
  const closedAges = rows.filter((r) => (r.closed_at || '').slice(0, 7) === m && r.age_days != null).map((r) => r.age_days).sort((a, b) => a - b);
  return {
    month: m, filed, resolved: closed, net: filed - closed,
    open_at_month_end: Math.max(0, running),
    median_days_to_resolve: closedAges.length ? closedAges[Math.floor(closedAges.length / 2)] : null,
    partial: m >= today.slice(0, 7),
  };
});

// ── weekly filings (Beau, 2026-09-24: track filed volume by month AND by week) ──
// Keyed by the MONDAY of each week rather than an ISO week number: "2026-09-21" is
// readable on an axis and sorts correctly, where "2026-W39" does neither.
// Weeks with no bugs are emitted as zeros — a gap in a volume series reads as missing
// data, and a quiet week is a real observation worth seeing.
const mondayOf = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;            // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
};
const weekly = (() => {
  const filedBy = new Map();
  for (const r of rows) {
    if (!r.created) continue;
    const w = mondayOf(r.created);
    filedBy.set(w, (filedBy.get(w) || 0) + 1);
  }
  if (!filedBy.size) return [];
  const keys = [...filedBy.keys()].sort();
  const out = [];
  const cur = new Date(`${keys[0]}T00:00:00Z`);
  const end = new Date(`${keys[keys.length - 1]}T00:00:00Z`);
  const thisWeek = mondayOf(today);
  while (cur <= end) {
    const w = cur.toISOString().slice(0, 10);
    out.push({ week: w, filed: filedBy.get(w) || 0, partial: w === thisWeek });
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return out;
})();

const tally = (list, keyFn) => {
  const m = new Map();
  for (const r of list) {
    const k = keyFn(r) || 'None';
    if (!m.has(k)) m.set(k, { key: k, bugs: 0, mrr_affected: 0, open: 0 });
    const e = m.get(k); e.bugs++; e.mrr_affected = r2(e.mrr_affected + r.mrr_affected); if (r.is_open) e.open++;
  }
  return [...m.values()].sort((a, b) => b.bugs - a.bugs);
};

// Customers by how many open bugs they are waiting on — the CS-facing view.
const byCustomer = new Map();
for (const r of open) {
  for (const c of r.customers) {
    if (!byCustomer.has(c.allmoxy_customer_id)) byCustomer.set(c.allmoxy_customer_id, { ...c, open_bugs: 0, highest_priority: null, oldest_days: 0 });
    const e = byCustomer.get(c.allmoxy_customer_id);
    e.open_bugs++;
    if (r.age_days != null && r.age_days > e.oldest_days) e.oldest_days = r.age_days;
    const rank = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
    if ((rank[r.priority] || 0) > (rank[e.highest_priority] || 0)) e.highest_priority = r.priority;
  }
}
const customers = [...byCustomer.values()].sort((a, b) => b.mrr - a.mrr || b.open_bugs - a.open_bugs);

const openAges = open.filter((r) => r.age_days != null).map((r) => r.age_days).sort((a, b) => a - b);
const resAges = resolved.filter((r) => r.age_days != null).map((r) => r.age_days).sort((a, b) => a - b);
const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);

const out = {
  tab: 'bug_report',
  fetchedAt: new Date().toISOString(),
  source: `${JIRA.source || 'jira:DEV'} · pulled ${JIRA.fetchedAt || '?'}`,
  totals: {
    bugs: rows.length,
    open: open.length,
    resolved: resolved.length,
    open_mrr_affected: r2(open.reduce((s, r) => s + r.mrr_affected, 0)),
    customers_waiting: customers.length,
    unattributed_open: open.filter((r) => r.customer_count === 0).length,
    source_scope: JIRA.source || null,
    closed_without_resolution_date: rows.filter((r) => r.resolution_date_missing).length,
  },
  age: {
    median_open_days: med(openAges),
    p90_open_days: openAges.length ? openAges[Math.floor(openAges.length * 0.9)] : null,
    median_days_to_resolve: med(resAges),
    note: 'Open bugs are aged to today, resolved bugs to their resolution date. Never averaged together — a bug open 300 days and one closed in 2 describe different things.',
  },
  monthly,
  weekly,
  by_priority: tally(rows, (r) => r.priority),
  by_type: tally(rows, (r) => r.issue_type),
  by_status: tally(open, (r) => r.status),
  customers,
  bugs: rows.sort((a, b) => Number(b.is_open) - Number(a.is_open) || b.mrr_affected - a.mrr_affected || (b.age_days || 0) - (a.age_days || 0)),
  unmatched_labels: [...unmatchedLabels.entries()].map(([label, n]) => ({ label, tickets: n })).sort((a, b) => b.tickets - a.tickets),
  notes: 'All Bug-type tickets on the JIRA DEV board. MRR affected is the sum of current subscription MRR across the customers tagged on the ticket, so a bug can be ranked by the revenue waiting on it rather than only by engineering priority. Customer labels are concatenated in JIRA and matched with the same two-tier normaliser the Features page uses; labels that match no roster customer are listed under unmatched_labels for hygiene.',
};

fs.writeFileSync(path.join(SNAP, 'bug_report.json'), JSON.stringify(out));
console.error(`[bug_report] ${rows.length} bugs · ${weekly.length} weeks of filings · ${open.length} open ($${Math.round(out.totals.open_mrr_affected).toLocaleString()} MRR affected, ${customers.length} customers waiting) · median open ${out.age.median_open_days}d, median resolve ${out.age.median_days_to_resolve}d · ${out.unmatched_labels.length} unmatched labels`);
