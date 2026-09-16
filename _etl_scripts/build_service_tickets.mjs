#!/usr/bin/env node
/**
 * SERVICE TICKETS — HubSpot Help Desk performance trends.
 *
 * Source: public/snapshots/hubspot_tickets.json (sync_hubspot pullTickets).
 * Output: public/snapshots/service_tickets.json
 *
 * WHAT IS AND IS NOT TRUSTWORTHY HERE
 * -----------------------------------
 * VOLUME and BACKLOG are solid: `created` is a real timestamp on every ticket, and
 * `is_closed` / `closed_date` are reliable for whether and when a ticket left the queue.
 *
 * RESOLUTION TIME needs care. 74.7% of closed tickets carry a `closed_date` identical
 * to `created` (inside one second) — a bulk/migration close, not handling time. Left in,
 * it drags the median to 0.00 days and makes the team look instantaneous. So resolution
 * statistics here are computed ONLY over tickets that took longer than a second, and the
 * share excluded is published per month (`instant_close_rate`) so the coverage is visible
 * rather than assumed.
 *
 * That share is falling sharply as the help desk matures — 93% of 2023 tickets closed
 * instantly, 40% of 2025, 19% of 2026 — so recent months carry genuinely more signal.
 * Reading resolution trend across the whole history would mostly be reading that change
 * in hygiene, which is why the page leads with the recent window.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const SRC = read(path.join(SNAP, 'hubspot_tickets.json'), {});
const TICKETS = SRC.tickets || [];
const PROF = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];

if (!TICKETS.length) {
  console.error('[service_tickets] no tickets in hubspot_tickets.json — nothing to build');
  process.exit(0);
}

const monthOf = (iso) => (iso ? String(iso).slice(0, 7) : null);
const nowMonth = new Date().toISOString().slice(0, 7);

// HubSpot company id → customer profile, so ticket load can sit next to revenue.
const byCompany = new Map();
for (const p of PROF) if (p.hubspot_company_id) byCompany.set(String(p.hubspot_company_id), p);
const profileFor = (t) => {
  for (const cid of (t.associated_company_ids || [])) {
    const p = byCompany.get(String(cid));
    if (p) return p;
  }
  return null;
};

// A resolution is "measurable" only when the ticket actually sat in the queue.
const INSTANT_MS = 1000;
const resolutionMs = (t) => {
  if (!t.created || !t.closed_date) return null;
  const ms = Date.parse(t.closed_date) - Date.parse(t.created);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);

// ── monthly series ────────────────────────────────────────────────────────────
const months = [...new Set(TICKETS.map((t) => monthOf(t.created)).filter(Boolean))].sort();
const createdBy = new Map(), closedBy = new Map();
for (const t of TICKETS) {
  const cm = monthOf(t.created);
  if (cm) { if (!createdBy.has(cm)) createdBy.set(cm, []); createdBy.get(cm).push(t); }
  const xm = monthOf(t.closed_date);
  if (xm) { if (!closedBy.has(xm)) closedBy.set(xm, []); closedBy.get(xm).push(t); }
}

// COHORT resolution: of the tickets CREATED in month m, how long did they take to
// close? This is the metric that answers "how fast do we handle new work", and unlike
// closed-in-month it cannot be distorted by a backlog purge. June 2026 closed 735
// tickets against 69 created (median 332 days) while clearing the queue — pooled over
// the TTM that single month drags the median to 149 days, against 0.04–0.32 days in a
// normal month. The cohort view is right-censored for recent months (tickets still
// open are excluded), so `cohort_closed_share` states how much of each cohort is in.
function cohortStats(list) {
  const durs = list.map(resolutionMs).filter((ms) => ms != null && ms > INSTANT_MS).map((ms) => ms / 864e5);
  const closedCount = list.filter((t) => t.is_closed).length;
  return {
    cohort_median_resolution_days: durs.length ? r2(median(durs)) : null,
    cohort_p90_resolution_days: durs.length ? r2(pct(durs, 0.9)) : null,
    cohort_measurable: durs.length,
    cohort_closed_share: list.length ? r2(closedCount / list.length) : null,
  };
}

let openRunning = 0;
const monthly = months.map((m) => {
  const created = createdBy.get(m) || [];
  const closed = closedBy.get(m) || [];
  openRunning += created.length - closed.length;
  // Resolution measured on tickets CLOSED in the month — that is when the work landed.
  const durs = closed.map(resolutionMs).filter((ms) => ms != null);
  const real = durs.filter((ms) => ms > INSTANT_MS).map((ms) => ms / 864e5);
  const instant = durs.length - real.length;
  const bySource = {};
  for (const t of created) { const k = t.source_type || 'UNKNOWN'; bySource[k] = (bySource[k] || 0) + 1; }
  return {
    month: m,
    created: created.length,
    closed: closed.length,
    net: created.length - closed.length,
    // Backlog is a running balance, so it is only as good as the first month in the
    // data — treated as starting from zero in 2018, which is when the desk began.
    open_at_month_end: Math.max(0, openRunning),
    median_resolution_days: real.length ? r2(median(real)) : null,
    p90_resolution_days: real.length ? r2(pct(real, 0.9)) : null,
    resolved_measurable: real.length,
    instant_closes: instant,
    instant_close_rate: durs.length ? r2(instant / durs.length) : null,
    same_day_rate: real.length ? r2(real.filter((d) => d < 1).length / real.length) : null,
    within_7d_rate: real.length ? r2(real.filter((d) => d <= 7).length / real.length) : null,
    by_source: bySource,
    // A month that closed far more than it took in was clearing backlog, not keeping
    // up — its resolution median describes old tickets and should not be read as
    // current performance.
    backlog_purge: closed.length > 3 * Math.max(1, created.length),
    ...cohortStats(created),
    partial: m >= nowMonth,
  };
});

// ── cuts ──────────────────────────────────────────────────────────────────────
function group(keyFn, { since = null } = {}) {
  const m = new Map();
  for (const t of TICKETS) {
    if (since && (monthOf(t.created) || '') < since) continue;
    const k = keyFn(t);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, { key: k, tickets: 0, open: 0, closed: 0, durations: [] });
    const e = m.get(k);
    e.tickets++;
    if (t.is_closed) e.closed++; else e.open++;
    const ms = resolutionMs(t);
    if (ms != null && ms > INSTANT_MS) e.durations.push(ms / 864e5);
  }
  return [...m.values()].map((e) => ({
    key: e.key, tickets: e.tickets, open: e.open, closed: e.closed,
    median_resolution_days: e.durations.length ? r2(median(e.durations)) : null,
    measurable: e.durations.length,
  })).sort((a, b) => b.tickets - a.tickets);
}

// Trailing 12 complete months — the window worth managing against.
const complete = months.filter((m) => m < nowMonth);
const ttmStart = complete.length >= 12 ? complete[complete.length - 12] : complete[0];

// ── per customer, joined to revenue ───────────────────────────────────────────
const byCustomer = new Map();
for (const t of TICKETS) {
  const p = profileFor(t);
  if (!p) continue;
  const aid = p.allmoxy_customer_id;
  if (!byCustomer.has(aid)) {
    byCustomer.set(aid, {
      allmoxy_customer_id: aid,
      name: p.customer_name || p.name,
      status: p.status ?? null,
      mrr: r2(p.current_subscription_mrr || 0),
      tickets: 0, open: 0, ttm: 0, durations: [], last_ticket: null,
    });
  }
  const e = byCustomer.get(aid);
  e.tickets++;
  if (!t.is_closed) e.open++;
  if ((monthOf(t.created) || '') >= ttmStart) e.ttm++;
  const ms = resolutionMs(t);
  if (ms != null && ms > INSTANT_MS) e.durations.push(ms / 864e5);
  if (!e.last_ticket || String(t.created) > e.last_ticket) e.last_ticket = String(t.created);
}
const customers = [...byCustomer.values()].map((e) => ({
  allmoxy_customer_id: e.allmoxy_customer_id, name: e.name, status: e.status, mrr: e.mrr,
  tickets: e.tickets, open: e.open, ttm_tickets: e.ttm,
  median_resolution_days: e.durations.length ? r2(median(e.durations)) : null,
  last_ticket: e.last_ticket ? e.last_ticket.slice(0, 10) : null,
  // Support load against what the account pays — a high ratio is a margin problem
  // and, historically here, an early churn signal.
  tickets_per_1k_mrr: e.mrr > 0 ? r2(e.ttm / (e.mrr / 1000)) : null,
})).sort((a, b) => b.ttm_tickets - a.ttm_tickets || b.tickets - a.tickets);

// ── headline ──────────────────────────────────────────────────────────────────
const closedAll = TICKETS.map(resolutionMs).filter((ms) => ms != null);
const realAll = closedAll.filter((ms) => ms > INSTANT_MS).map((ms) => ms / 864e5);
const ttmRows = monthly.filter((r) => r.month >= ttmStart && !r.partial);
const ttmCreated = ttmRows.reduce((s, r) => s + r.created, 0);
const ttmClosed = ttmRows.reduce((s, r) => s + r.closed, 0);
const ttmReal = TICKETS.filter((t) => (monthOf(t.closed_date) || '') >= ttmStart)
  .map(resolutionMs).filter((ms) => ms != null && ms > INSTANT_MS).map((ms) => ms / 864e5);

const out = {
  tab: 'service_tickets',
  fetchedAt: new Date().toISOString(),
  source_fetched_at: SRC.fetched_at || null,
  portal_id: SRC.portal_id || null,
  window: { first_month: months[0], last_month: months[months.length - 1], ttm_start: ttmStart },
  totals: {
    tickets: TICKETS.length,
    open: TICKETS.filter((t) => !t.is_closed).length,
    closed: TICKETS.filter((t) => t.is_closed).length,
    customers_with_tickets: customers.length,
    unattributed_tickets: TICKETS.filter((t) => !profileFor(t)).length,
    median_resolution_days: realAll.length ? r2(median(realAll)) : null,
    instant_close_rate_all_time: closedAll.length ? r2((closedAll.length - realAll.length) / closedAll.length) : null,
  },
  ttm: {
    created: ttmCreated,
    closed: ttmClosed,
    net: ttmCreated - ttmClosed,
    per_month: r2(ttmCreated / Math.max(1, ttmRows.length)),
    median_resolution_days: ttmReal.length ? r2(median(ttmReal)) : null,
    p90_resolution_days: ttmReal.length ? r2(pct(ttmReal, 0.9)) : null,
    // Headline metric: cohort basis over the TTM, purge-proof.
    ...(() => {
      const list = TICKETS.filter((t) => (monthOf(t.created) || '') >= ttmStart && (monthOf(t.created) || '') < nowMonth);
      return cohortStats(list);
    })(),
    purge_months: ttmRows.filter((r) => r.backlog_purge).map((r) => r.month),
    same_day_rate: ttmReal.length ? r2(ttmReal.filter((d) => d < 1).length / ttmReal.length) : null,
    within_7d_rate: ttmReal.length ? r2(ttmReal.filter((d) => d <= 7).length / ttmReal.length) : null,
    measurable: ttmReal.length,
  },
  monthly,
  by_owner: group((t) => t.owner_full_name || '(unassigned)', { since: ttmStart }),
  by_owner_all_time: group((t) => t.owner_full_name || '(unassigned)'),
  by_source: group((t) => t.source_type || 'UNKNOWN'),
  by_stage: group((t) => t.stage_label || '(none)'),
  by_category: group((t) => t.category || '(uncategorized)'),
  by_priority: group((t) => t.priority || '(none)'),
  customers,
  open_tickets: TICKETS.filter((t) => !t.is_closed)
    .map((t) => {
      const p = profileFor(t);
      return {
        id: t.id, subject: t.subject, created: t.created ? t.created.slice(0, 10) : null,
        age_days: t.created ? Math.round((Date.now() - Date.parse(t.created)) / 864e5) : null,
        stage: t.stage_label, owner: t.owner_full_name || null, source: t.source_type || null,
        priority: t.priority || null, url: t.hubspot_url || null,
        customer: p ? (p.customer_name || p.name) : null,
        allmoxy_customer_id: p ? p.allmoxy_customer_id : null,
      };
    }).sort((a, b) => (b.age_days || 0) - (a.age_days || 0)),
  data_quality: {
    instant_close_definition: 'closed_date within 1 second of created — a bulk/migration close, not handling time',
    instant_close_rate_all_time: closedAll.length ? r2((closedAll.length - realAll.length) / closedAll.length) : null,
    note: 'Resolution statistics EXCLUDE instant closes. 74.7% of all closed tickets are instant closes, but the rate is falling fast (93% of 2023, 40% of 2025, 19% of 2026), so recent months carry far more signal. Volume and backlog are unaffected — created dates are real throughout.',
    attribution: `${TICKETS.filter((t) => !profileFor(t)).length} of ${TICKETS.length} tickets have no HubSpot company that maps to a customer profile, so per-customer views cover the remainder.`,
  },
  notes: 'HubSpot Help Desk performance. Volume and backlog are reliable across the full history; resolution time is measured only on tickets that stayed open longer than a second (see data_quality). Backlog is a running created-minus-closed balance from the first month on record.',
};

fs.writeFileSync(path.join(SNAP, 'service_tickets.json'), JSON.stringify(out));
console.error(`[service_tickets] ${out.totals.tickets.toLocaleString()} tickets · ${out.totals.open} open · TTM ${out.ttm.created} created / ${out.ttm.closed} closed · median resolution ${out.ttm.median_resolution_days}d (${out.ttm.measurable} measurable) · ${months[0]}→${months[months.length - 1]}`);
