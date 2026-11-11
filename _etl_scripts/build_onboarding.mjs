#!/usr/bin/env node
/**
 * ONBOARDING — reverse-engineer where every customer is in the onboarding program
 * (Beau, 2026-11-11), from the sources the dashboard already pulls, until Jake's
 * instance-level Onboarding tab records it directly.
 *
 * Program: _etl_scripts/onboarding/catalog.json (6 phases, 26 steps, as on the tab).
 * Tables:  _etl_scripts/onboarding/schema.sql (Aurora MySQL, schema allmoxy_onboarding).
 *
 * Outputs
 *   public/snapshots/onboarding.json        the dashboard page's data
 *   _etl_scripts/onboarding/seed.sql        INSERTs for the Aurora tables; a seeded row never
 *                                           overwrites one the instance tab (or a person) wrote
 *
 * Evidence, per step. Every step carries a confidence:
 *   confirmed  a source records the step itself
 *   inferred   implied by a later milestone (live with steady orders => settings were done)
 *   unknown    no source can tell yet; the instance tab will
 *
 *   connect_payment_gateway  HubSpot merchant_connect_date / stripe_connect_id, Stripe Connect volume
 *   set_up_custom_domain     custom-domain Stripe subscription (HubSpot instance / profile)
 *   webhooks_api             API & sandbox add-on on a Stripe invoice
 *   upload_documents         Jira implementation epic past Discovery (the build needs the documents)
 *   validation_orders        Jira epic in "Stage 4: Testing & Iteration" (in progress), Done / HubSpot
 *                            "Build Complete" (done)
 *   train_your_team          HubSpot implementation_status "Active Training / Work"
 *   run_10_live_orders       verified orders in the warehouse (progress n of 10)
 *   invite_all_customers     orders in 3+ of the last 6 months (the customer base is ordering)
 *   go-live date             HubSpot actual launch date, else first warehouse month with verified orders
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAP = path.join(ROOT, 'public/snapshots');
const CACHE = path.join(__dirname, 'cache');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

const CAT = read(path.join(__dirname, 'onboarding/catalog.json'));
const PROFILES = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows;
const IMPL = read(path.join(SNAP, 'implementation.json'), { rows: [] }).rows || [];
const ORDERS = read(path.join(SNAP, 'orders_verified.json'), { by_customer: {} }).by_customer || {};
// aurora_orders.json by_customer is a LIST of instances; index it by customer id.
const AURORA = {};
for (const r of (read(path.join(SNAP, 'aurora_orders.json'), { by_customer: [] }).by_customer || [])) {
  const k = String(r.allmoxy_customer_id); const prev = AURORA[k];
  AURORA[k] = prev ? { ...prev, total_orders: (prev.total_orders || 0) + (r.total_orders || 0) } : r;
}
// Verified orders per customer per month (orders count and $), the same file the churn score's usage signal reads.
const MONTHLY = read(path.join(CACHE, 'aurora_orders_verified_monthly.json'), { by_customer: {} }).by_customer || {};
const HS_INST_RAW = read(path.join(CACHE, 'hubspot_instances.json'), []);
const HS_INST = Array.isArray(HS_INST_RAW) ? HS_INST_RAW : (HS_INST_RAW.instances || HS_INST_RAW.results || Object.values(HS_INST_RAW));
const CONNECT = read(path.join(CACHE, 'stripe_connect_volume.json'), { by_account: {} });
const INVOICES = read(path.join(CACHE, 'stripe_invoices.json'), { by_customer: {} });
const PRODUCTS = read(path.join(__dirname, 'product_revenue_types.json'), { products: {} }).products;

const TODAY = new Date().toISOString().slice(0, 10);
const NOW_MONTH = TODAY.slice(0, 7);
const addMonths = (m, k) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + k, 1)); return d.toISOString().slice(0, 7); };
const day = (v) => (v ? String(v).slice(0, 10) : null);
const minDate = (...v) => v.filter(Boolean).map(day).sort()[0] || null;

// ── indexes ───────────────────────────────────────────────────────────────────
const instByAid = new Map();
for (const i of HS_INST) {
  const aid = Number(i.allmoxy_customer_id); if (!aid) continue;
  const prev = instByAid.get(aid);
  // several instance records can share an id: keep the most recently modified
  if (!prev || String(i.hs_lastmodifieddate || '') > String(prev.hs_lastmodifieddate || '')) instByAid.set(aid, i);
}
const implByAid = new Map(IMPL.map((r) => [Number(r.allmoxy_customer_id), r]));
const connectByAcct = new Map(Object.values(CONNECT.by_account || {}).map((a) => [a.account, a]));
const API_PRODUCTS = new Set(Object.entries(PRODUCTS).filter(([, v]) => /api|sandbox/i.test(v.name || '')).map(([id]) => id));
const apiFirstByCus = new Map();
for (const [cus, e] of Object.entries(INVOICES.by_customer || {})) {
  for (const inv of (e.invoices || [])) {
    if (inv.status !== 'paid' && inv.status !== 'open') continue;
    if ((inv.lines || []).some((l) => l.prod && API_PRODUCTS.has(l.prod))) {
      const d = inv.d; if (!apiFirstByCus.has(cus) || d < apiFirstByCus.get(cus)) apiFirstByCus.set(cus, d);
    }
  }
}

const STEPS = CAT.steps.map((s, i) => ({ ...s, sort_order: i + 1 }));
const STEP = new Map(STEPS.map((s) => [s.step_key, s]));
const PHASES = CAT.phases;

// Jira IPA epic stage -> where the build is
const JIRA_PHASE = {
  'Stage 1: Discovery': 1,
  'Stage 2: Prototyping': 2,
  'Stage 3: Catalog Expansion': 2,
  'Stage 4: Testing & Iteration': 3,
  Done: 4,
};

// ── cohort: everyone on a live subscription, plus pre-paying customers already in a build ──
const LIVE_STATUS = new Set(['active', 'at_risk', 'paused', 'non_payment']);
const cohort = PROFILES.filter((p) => {
  if (LIVE_STATUS.has(p.status)) return true;
  if (p.status !== 'never_paid') return false;
  const impl = implByAid.get(p.allmoxy_customer_id);
  const inst = instByAid.get(p.allmoxy_customer_id);
  const openEpic = impl?.has_jira && !['Done', 'On Hold / Abandoned'].includes(impl.stage);
  return openEpic || ['Pre-Sale', 'Active'].includes(inst?.status);
});

// ── per customer ──────────────────────────────────────────────────────────────
const customers = [];
for (const p of cohort) {
  const aid = p.allmoxy_customer_id;
  const inst = instByAid.get(aid) || {};
  const impl = implByAid.get(aid) || null;
  const ov = ORDERS[String(aid)] || null;
  const au = AURORA[String(aid)] || null;
  const stripeIds = p.stripe_customer_ids || [];

  // orders
  const yearCounts = Object.entries(ov?.years || {}).map(([y, v]) => [Number(y), Number(v.order_count) || 0]).filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]);
  // VERIFIED orders only: the warehouse's cumulative total counts every order (bids and the
  // test orders placed during a build), so it cannot say a customer is live.
  const lifetimeOrders = yearCounts.reduce((s, [, n]) => s + n, 0);
  const firstOrderYear = yearCounts[0]?.[0] ?? null;
  const months = Object.entries(MONTHLY[String(aid)] || {}).filter(([, v]) => (v?.orders || 0) > 0 || (v?.usd || 0) > 0).map(([m]) => m).sort();
  const last6 = new Set(Array.from({ length: 6 }, (_, k) => addMonths(NOW_MONTH, -1 - k)));
  const activeMonths6 = months.filter((m) => last6.has(m)).length;
  const curYearOrders = (ov?.years?.[String(new Date().getUTCFullYear())]?.order_count) || 0;
  const hsLaunched = p.is_launched_per_hubspot === 'Yes' || inst.is_this_customer_launched___cloned_ === 'Yes';
  const live = lifetimeOrders > 0 || hsLaunched;
  const steady = activeMonths6 >= 3 || (activeMonths6 === 0 && curYearOrders >= 6);
  // first month with verified orders, when the monthly record reaches back that far (it starts 2022)
  const goLive = day(p.actual_launch_date) || (months[0] && months[0] > '2022-01' ? `${months[0]}-01` : null);

  // build signals
  const stage = impl?.has_jira ? impl.stage : null;
  const implStatus = inst.implementation_status || null;
  const plan = implStatus === 'Self Build' ? 'self' : (impl?.has_harvest || impl?.has_jira || (p.lifetime_services || 0) > 0) ? 'full' : 'unknown';
  const kickoff = minDate(impl?.first_entry, impl?.tasks?.map((t) => t.start || t.created).sort()[0], inst.instance_creation, p.first_payment_date, inst.payment_start_date);
  const targetLaunch = day(p.goal_launch_date || inst.goal_launch_date__cloned_);
  const csm = p.instance_owner || null;

  // where they are
  let programStatus = 'onboarding';
  let currentPhase;
  // Ten verified orders = through Go-Live, whatever happened since. A live customer who stopped
  // ordering is a churn-risk question (Churn Risk Matrix), not an onboarding one.
  const buildPhase = stage && JIRA_PHASE[stage] && JIRA_PHASE[stage] <= 3 ? JIRA_PHASE[stage] : null;
  if (lifetimeOrders >= 10) { currentPhase = 6; programStatus = 'live'; }
  else if (live && buildPhase) currentPhase = buildPhase;   // a few orders while the catalog is still being built = test orders
  else if (live) { currentPhase = 5; }
  else if (stage === 'On Hold / Abandoned') { currentPhase = 1; programStatus = 'on_hold'; }
  else if (stage && JIRA_PHASE[stage]) currentPhase = JIRA_PHASE[stage];
  else if (stage === 'Waiting on Customer') currentPhase = implStatus === 'Build Complete' ? 4 : 2;
  else if (implStatus === 'Build Complete') currentPhase = 4;
  else if (implStatus === 'Active Training / Work') currentPhase = 4;
  else if (implStatus === 'Self Build') currentPhase = 2;
  else currentPhase = 1;
  if (plan === 'self' && currentPhase === 3) currentPhase = 4;

  // steps
  const steps = {};
  const set = (key, status, confidence, evidence_source = null, evidence_detail = null, extra = {}) => {
    steps[key] = { step_key: key, status, confidence, evidence_source, evidence_detail, owner: STEP.get(key).owner, ...extra };
  };
  for (const s of STEPS) {
    if (s.phase_id === 3 && plan === 'self') { set(s.step_key, 'not_applicable', 'confirmed', 'hubspot', 'Self-build plan: no validation phase'); continue; }
    if (s.phase_id < currentPhase) {
      if (s.optional) set(s.step_key, 'unknown', 'unknown');
      else set(s.step_key, 'done', 'inferred', live ? 'orders' : 'jira', live ? 'Live with verified orders, so this was in place' : `Build is past this phase (Jira: ${stage || implStatus})`);
    } else if (s.phase_id === currentPhase) set(s.step_key, s.phase_id === 6 ? 'unknown' : 'unknown', 'unknown');
    else set(s.step_key, 'not_started', 'inferred');
  }

  // direct evidence overrides the phase default
  const acct = inst.stripe_connect_id || null;
  const cv = acct ? connectByAcct.get(acct) : null;
  if (inst.merchant_connect_date || acct || cv) {
    set('connect_payment_gateway', 'done', 'confirmed', cv ? 'stripe' : 'hubspot',
      cv ? `Stripe Connect account ${acct}, payments since ${cv.first_seen}` : `HubSpot: merchant connected ${day(inst.merchant_connect_date) || ''}`.trim(),
      { completed_date: day(inst.merchant_connect_date) || cv?.first_seen || null });
  }
  if (p.custom_domain_stripe_subscription_id || inst.custom_domain_stripe_subscription_id) {
    set('set_up_custom_domain', 'done', 'confirmed', 'stripe', 'Custom-domain subscription on Stripe');
  } else if (currentPhase > 2) set('set_up_custom_domain', 'not_started', 'confirmed', 'stripe', 'No custom-domain subscription (optional)');
  const apiFirst = stripeIds.map((c) => apiFirstByCus.get(c)).filter(Boolean).sort()[0];
  if (apiFirst) set('webhooks_api', 'done', 'confirmed', 'stripe', 'API & sandbox add-on billed', { completed_date: apiFirst });
  if (stage && stage !== 'Stage 1: Discovery' && stage !== 'On Hold / Abandoned' && steps.upload_documents.status !== 'done') {
    set('upload_documents', 'done', 'inferred', 'jira', `Catalog build under way (Jira ${impl.jira_key}: ${stage})`);
  }
  if (stage === 'Stage 1: Discovery') set('upload_documents', 'in_progress', 'inferred', 'jira', `Jira ${impl.jira_key}: Discovery`);
  if (plan !== 'self') {
    if (stage === 'Stage 4: Testing & Iteration') set('validation_orders', 'in_progress', 'confirmed', 'jira', `Jira ${impl.jira_key}: Testing & Iteration`);
    if ((stage === 'Done' || implStatus === 'Build Complete') && !live) set('validation_orders', 'done', 'inferred', stage === 'Done' ? 'jira' : 'hubspot', stage === 'Done' ? `Jira ${impl.jira_key}: Done` : 'HubSpot: Build Complete');
  }
  if (implStatus === 'Active Training / Work' && currentPhase <= 4) set('train_your_team', 'in_progress', 'confirmed', 'hubspot', 'HubSpot: Active Training / Work');
  set('run_10_live_orders', lifetimeOrders >= 10 ? 'done' : lifetimeOrders > 0 ? 'in_progress' : 'not_started', lifetimeOrders > 0 ? 'confirmed' : 'inferred', 'orders',
    lifetimeOrders > 0 ? `${lifetimeOrders.toLocaleString('en-US')} verified orders${firstOrderYear ? ` since ${firstOrderYear}` : ''}` : 'No verified orders yet',
    { progress_count: Math.min(10, lifetimeOrders), target_count: 10 });
  if (live && steady) set('invite_all_customers', 'done', 'inferred', 'orders', `Orders in ${activeMonths6} of the last 6 months`);
  else if (live) set('invite_all_customers', 'in_progress', 'inferred', 'orders', `Orders in ${activeMonths6} of the last 6 months`);
  if (live && currentPhase >= 5) {
    for (const k of ['pick_soft_launch_customers', 'train_soft_launch_customers']) set(k, 'done', 'inferred', 'orders', 'Live with verified orders');
  }

  // phases
  const phases = PHASES.map((ph) => {
    const own = STEPS.filter((s) => s.phase_id === ph.phase_id);
    const req = own.filter((s) => !s.optional);
    const applicable = req.filter((s) => steps[s.step_key].status !== 'not_applicable');
    const done = applicable.filter((s) => steps[s.step_key].status === 'done').length;
    let status;
    if (ph.phase_id === 3 && plan === 'self') status = 'not_applicable';
    else if (ph.phase_id < currentPhase) status = 'complete';
    else if (ph.phase_id === currentPhase) status = programStatus === 'on_hold' ? 'in_progress' : 'in_progress';
    else status = 'not_started';
    return {
      phase_id: ph.phase_id, status, steps_done: done, steps_total: applicable.length,
      target_date: ph.phase_id === 5 ? targetLaunch : null,
      completed_date: ph.phase_id === 5 && status === 'complete' ? goLive : null,
    };
  });

  // next step and who it waits on
  const nextStep = STEPS.find((s) => s.phase_id === currentPhase && !s.optional && !['done', 'not_applicable'].includes(steps[s.step_key].status)) || null;
  let waitingOn = 'unknown';
  if (stage === 'Waiting on Customer') waitingOn = 'customer';
  else if (['Stage 1: Discovery', 'Stage 2: Prototyping', 'Stage 3: Catalog Expansion'].includes(stage)) waitingOn = 'allmoxy';
  else if (stage === 'Stage 4: Testing & Iteration') waitingOn = 'customer';
  else if (currentPhase === 6) waitingOn = 'nobody';
  else if (nextStep) waitingOn = nextStep.owner === 'allmoxy' ? 'allmoxy' : 'customer';

  // What happens next, in words. The catalog build is Allmoxy's work between Kick-Off and
  // Validate; it is not a step on the customer's tab, so Jira says when it is the holdup.
  const BUILD_TEXT = { 'Stage 1: Discovery': 'scoping the catalog (Discovery)', 'Stage 2: Prototyping': 'building the catalog (Prototyping)',
    'Stage 3: Catalog Expansion': 'expanding the catalog', 'Stage 4: Testing & Iteration': 'fixing what the test orders turned up' };
  let nextAction;
  if (programStatus === 'live') nextAction = 'Live: add-ons and quarterly reviews';
  else if (programStatus === 'on_hold') nextAction = 'On hold: decide whether to restart or close';
  else if (stage === 'Waiting on Customer') nextAction = `Customer: ${nextStep ? nextStep.name : 'reply to Allmoxy'} (build is waiting on them)`;
  else if (BUILD_TEXT[stage] && currentPhase <= 3) nextAction = currentPhase === 3 ? `Customer: approve the 10 test orders · Allmoxy: ${BUILD_TEXT[stage]}` : `Allmoxy: ${BUILD_TEXT[stage]} · Customer: ${nextStep ? nextStep.name : '—'}`;
  else nextAction = nextStep ? `${nextStep.owner === 'allmoxy' ? 'Allmoxy' : 'Customer'}: ${nextStep.name}${nextStep.step_key === 'run_10_live_orders' ? ` (${Math.min(10, lifetimeOrders)} of 10)` : ''}` : '—';

  const blockers = [];
  if (programStatus === 'on_hold') blockers.push(`Jira ${impl?.jira_key}: On Hold / Abandoned`);
  if (stage === 'Waiting on Customer') {
    const since = impl?.jira_updated ? Math.round((Date.parse(TODAY) - Date.parse(impl.jira_updated)) / 864e5) : null;
    blockers.push(`Waiting on the customer${since != null ? ` (Jira last moved ${since} days ago)` : ''}`);
  }
  if (targetLaunch && !live && targetLaunch < TODAY) blockers.push(`Target launch ${targetLaunch} has passed`);
  if (currentPhase === 5 && lifetimeOrders === 0 && hsLaunched) blockers.push('Marked launched in HubSpot but no verified orders');
  if (currentPhase === 6 && activeMonths6 === 0) blockers.push('No verified orders in the last 6 months');

  const stepRows = STEPS.map((s) => steps[s.step_key]);
  customers.push({
    allmoxy_customer_id: aid,
    name: p.name,
    customer_status: p.status,
    mrr: Math.round(p.current_subscription_mrr || 0),
    plan,
    program_status: programStatus,
    current_phase_id: currentPhase,
    kickoff_date: kickoff,
    target_launch_date: targetLaunch,
    go_live_date: goLive,
    live_year: firstOrderYear,
    lifetime_orders: lifetimeOrders,
    active_months_last6: activeMonths6,
    days_since_kickoff: kickoff ? Math.round((Date.parse(TODAY) - Date.parse(kickoff)) / 864e5) : null,
    csm_name: csm,
    waiting_on: waitingOn,
    next_step_key: nextStep?.step_key || null,
    next_action: nextAction,
    blocker: blockers.join(' · ') || null,
    jira_epic_key: impl?.jira_key || null,
    jira_stage: stage,
    hubspot_implementation_status: implStatus,
    implementation_hours: impl?.hours ?? null,
    phases,
    steps: stepRows,
    evidence_counts: {
      confirmed: stepRows.filter((s) => s.confidence === 'confirmed').length,
      inferred: stepRows.filter((s) => s.confidence === 'inferred').length,
      unknown: stepRows.filter((s) => s.confidence === 'unknown').length,
    },
  });
}
customers.sort((a, b) => (a.current_phase_id - b.current_phase_id) || (b.mrr - a.mrr));

// ── aggregates ─────────────────────────────────────────────────────────────────
const by_phase = PHASES.map((ph) => {
  const list = customers.filter((c) => c.current_phase_id === ph.phase_id);
  return { phase_id: ph.phase_id, name: ph.name, customers: list.length, mrr: list.reduce((s, c) => s + c.mrr, 0),
    waiting_on_customer: list.filter((c) => c.waiting_on === 'customer').length, waiting_on_allmoxy: list.filter((c) => c.waiting_on === 'allmoxy').length };
});
const out = {
  tab: 'onboarding',
  fetchedAt: new Date().toISOString(),
  source: 'Reverse-engineered from HubSpot instances, Jira IPA, Harvest, Stripe and the order warehouse until the instance Onboarding tab records it (allmoxy_onboarding schema).',
  catalog: { phases: PHASES, steps: STEPS, roles: CAT.roles, documents: CAT.documents, training_sessions: CAT.training_sessions },
  totals: {
    customers: customers.length,
    onboarding: customers.filter((c) => c.program_status === 'onboarding').length,
    onboarding_mrr: customers.filter((c) => c.program_status === 'onboarding').reduce((s, c) => s + c.mrr, 0),
    live: customers.filter((c) => c.program_status === 'live').length,
    on_hold: customers.filter((c) => c.program_status === 'on_hold').length,
    waiting_on_customer: customers.filter((c) => c.program_status !== 'live' && c.waiting_on === 'customer').length,
    waiting_on_allmoxy: customers.filter((c) => c.program_status !== 'live' && c.waiting_on === 'allmoxy').length,
    with_blocker: customers.filter((c) => c.blocker).length,
    steps_confirmed: customers.reduce((s, c) => s + c.evidence_counts.confirmed, 0),
    steps_inferred: customers.reduce((s, c) => s + c.evidence_counts.inferred, 0),
    steps_unknown: customers.reduce((s, c) => s + c.evidence_counts.unknown, 0),
  },
  by_phase,
  customers,
};
fs.writeFileSync(path.join(SNAP, 'onboarding.json'), JSON.stringify(out));

// ── seed.sql ────────────────────────────────────────────────────────────────────
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
const insert = (table, cols, rows, guarded) => {
  if (!rows.length) return '';
  const head = `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n`;
  const body = rows.map((r) => `  (${cols.map((c) => q(r[c])).join(', ')})`).join(',\n');
  const upd = cols.filter((c) => !guarded.key.includes(c))
    .map((c) => (guarded.seedOnly ? `${c} = IF(source = 'seed', VALUES(${c}), ${c})` : `${c} = VALUES(${c})`)).join(', ');
  return `${head}${body}\nON DUPLICATE KEY UPDATE ${upd};\n\n`;
};
const seededAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
let sql = `-- Generated by _etl_scripts/build_onboarding.mjs on ${seededAt} UTC. Load after schema.sql.\n-- Catalog rows are upserted; customer rows only replace rows that are still source = 'seed'.\nUSE allmoxy_onboarding;\n\n`;
sql += insert('ob_phase', ['phase_id', 'phase_key', 'name', 'sort_order', 'plans', 'description'], PHASES.map((p) => ({ ...p, sort_order: p.phase_id })), { key: ['phase_id'] });
sql += insert('ob_step', ['step_key', 'phase_id', 'name', 'sort_order', 'is_optional', 'default_owner', 'settings_area', 'target_count'],
  STEPS.map((s) => ({ ...s, is_optional: !!s.optional, default_owner: s.owner, settings_area: s.settings_area || null, target_count: s.target_count || null })), { key: ['step_key'] });
sql += insert('ob_role', ['role_key', 'name', 'description', 'sort_order'], CAT.roles.map((r, i) => ({ ...r, sort_order: i + 1 })), { key: ['role_key'] });
sql += insert('ob_document_type', ['doc_key', 'name', 'description', 'sort_order'], CAT.documents.map((r, i) => ({ ...r, sort_order: i + 1 })), { key: ['doc_key'] });
sql += insert('ob_training_session', ['session_key', 'phase_id', 'name', 'covers', 'audience', 'sort_order'], CAT.training_sessions.map((r, i) => ({ ...r, sort_order: i + 1 })), { key: ['session_key'] });
sql += insert('ob_customer', ['allmoxy_customer_id', 'plan', 'program_status', 'current_phase_id', 'kickoff_date', 'target_launch_date', 'go_live_date', 'csm_name', 'waiting_on', 'next_step_key', 'blocker', 'jira_epic_key', 'source', 'seeded_at'],
  customers.map((c) => ({ ...c, source: 'seed', seeded_at: seededAt })), { key: ['allmoxy_customer_id'], seedOnly: true });
sql += insert('ob_customer_phase', ['allmoxy_customer_id', 'phase_id', 'status', 'completed_date', 'target_date', 'steps_done', 'steps_total', 'source'],
  customers.flatMap((c) => c.phases.map((ph) => ({ ...ph, allmoxy_customer_id: c.allmoxy_customer_id, source: 'seed' }))), { key: ['allmoxy_customer_id', 'phase_id'], seedOnly: true });
sql += insert('ob_customer_step', ['allmoxy_customer_id', 'step_key', 'status', 'progress_count', 'completed_date', 'owner', 'confidence', 'evidence_source', 'evidence_detail', 'source'],
  customers.flatMap((c) => c.steps.map((s) => ({ ...s, allmoxy_customer_id: c.allmoxy_customer_id, progress_count: s.progress_count ?? null, completed_date: s.completed_date ?? null, source: 'seed' }))),
  { key: ['allmoxy_customer_id', 'step_key'], seedOnly: true });
fs.writeFileSync(path.join(__dirname, 'onboarding/seed.sql'), sql);

const t = out.totals;
console.error(`[onboarding] ${t.customers} customers · ${t.onboarding} onboarding ($${t.onboarding_mrr.toLocaleString('en-US')}/mo) · ${t.live} live · ${t.on_hold} on hold · waiting on customer ${t.waiting_on_customer} / Allmoxy ${t.waiting_on_allmoxy} · steps ${t.steps_confirmed} confirmed, ${t.steps_inferred} inferred, ${t.steps_unknown} unknown`);
console.error('[onboarding] by phase: ' + by_phase.map((b) => `${b.phase_id}:${b.customers}`).join(' '));
