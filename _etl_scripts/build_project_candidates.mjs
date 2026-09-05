#!/usr/bin/env node
/**
 * Build the Project Candidates snapshot — the CS → Sales hand-off list.
 *
 * Customers flagged (from the Customer Detail Company Profile toggle, or
 * toggle_project_candidate.mjs) as good fits for a paid project / services
 * engagement, enriched with the context Sales needs to work the list: current MRR,
 * tenure, account rep, health/risk tier, services history, and order volume.
 *
 * Purely an opinion flag — it feeds no revenue, churn or scored metric.
 *
 * Output: public/snapshots/project_candidates.json
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const r2 = (v) => Math.round(v * 100) / 100;

const cfg = read(path.join(ROOT, '_etl_scripts/project_candidates.json'), { project_candidate_allmoxy_customer_ids: [], notes: {} });
const ids = new Set(cfg.project_candidate_allmoxy_customer_ids || []);
const notes = cfg.notes || {};
const profiles = read(path.join(SNAP, 'customer_profiles.json'), { rows: [] }).rows || [];
const risk = read(path.join(SNAP, 'churn_risk_matrix.json'), null);
const orders = read(path.join(SNAP, 'orders_verified.json'), null);

const riskByAid = new Map((risk?.customers || []).map((c) => [c.allmoxy_customer_id, c]));
const ordersByAid = new Map((orders?.customers || []).map((c) => [c.allmoxy_customer_id, c]));

const monthsBetween = (iso) => {
  if (!iso) return null;
  const d = new Date(iso); if (Number.isNaN(+d)) return null;
  return Math.max(0, Math.round((Date.now() - +d) / (30.44 * 86400000)));
};

const rows = [];
for (const p of profiles) {
  if (!ids.has(p.allmoxy_customer_id)) continue;
  const rk = riskByAid.get(p.allmoxy_customer_id);
  const od = ordersByAid.get(p.allmoxy_customer_id);
  rows.push({
    allmoxy_customer_id: p.allmoxy_customer_id,
    name: p.customer_name || p.hubspot_instance_name || p.name,
    status: p.status ?? null,
    pay_status: p.pay_status ?? null,
    account_rep: p.account_rep ?? null,
    current_mrr: r2(p.current_subscription_mrr || 0),
    arr: r2((p.current_subscription_mrr || 0) * 12),
    lifetime_subscription: r2(p.lifetime_subscription || 0),
    lifetime_services: r2(p.lifetime_services || 0),
    has_bought_services: (p.lifetime_services || 0) > 0,
    sign_up_date: p.sign_up_date ?? null,
    tenure_months: monthsBetween(p.effective_start_date || p.sign_up_date),
    risk_tier: rk?.tier ?? null,
    risk_score: rk?.total_score ?? null,
    is_launched: rk?.is_launched ?? null,
    lifetime_orders: od?.total_orders ?? null,
    hubspot_company_id: p.hubspot_company_id ?? null,
    note: notes[p.allmoxy_customer_id] ?? null,
  });
}
// Biggest accounts first — that's the order Sales should work the list.
rows.sort((a, b) => b.current_mrr - a.current_mrr || String(a.name).localeCompare(String(b.name)));

const totals = {
  count: rows.length,
  total_mrr: r2(rows.reduce((s, r) => s + r.current_mrr, 0)),
  total_arr: r2(rows.reduce((s, r) => s + r.arr, 0)),
  already_bought_services: rows.filter((r) => r.has_bought_services).length,
  total_prior_services: r2(rows.reduce((s, r) => s + r.lifetime_services, 0)),
};

fs.writeFileSync(path.join(SNAP, 'project_candidates.json'), JSON.stringify({
  tab: 'project_candidates',
  fetchedAt: new Date().toISOString(),
  updated_at: cfg.updated_at ?? null,
  totals,
  customers: rows,
  notes: 'CS → Sales hand-off list. Flagged from the Company Profile toggle on Customer Detail or via toggle_project_candidate.mjs; stored in _etl_scripts/project_candidates.json. An opinion flag only — it feeds no revenue, churn or scored metric.',
}));
console.error(`[project_candidates] ${rows.length} candidate(s) · $${Math.round(totals.total_mrr).toLocaleString()} MRR · $${Math.round(totals.total_arr).toLocaleString()} ARR`);
