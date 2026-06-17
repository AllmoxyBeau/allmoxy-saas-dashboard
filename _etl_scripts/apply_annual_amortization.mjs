#!/usr/bin/env node
/**
 * Apply annual-payer amortization to existing snapshots in-place.
 *
 * For every customer ID in src/data/annual_payers.json:
 *   - Subscription charges >= $3000  → amortized amount/12 over 12 months forward (incl. origin month),
 *     unless _etl_scripts/annual_amortization_overrides.json has a matching entry for this transaction
 *     (matched by customer ID + origin month + amount range), in which case the override's start_month
 *     and months count are used. This allows charges that span more than 12 months, or that back-date
 *     coverage to months before the charge.
 *   - Subscription charges < $3000  → credited full to origin month (likely historical monthly billing)
 *
 * Affects: customer_profiles.json, subscription_by_month.json, mrr_by_month.json, mrr_waterfall.json
 *
 * Services / Connect streams are NOT touched. payment_dates in subscription_by_month are overwritten
 * for amortized months to point at the origin transaction's date, so drill-downs narrate correctly.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');

const ANNUAL_THRESHOLD = 3000;
const AMORTIZE_MONTHS = 12;

const annualCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/annual_payers.json'), 'utf8'));
const ANNUAL_IDS = new Set(annualCfg.annual_payer_ids);

const OVERRIDES_PATH = path.join(ROOT, '_etl_scripts/annual_amortization_overrides.json');
const overridesCfg = fs.existsSync(OVERRIDES_PATH)
  ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'))
  : { overrides: [] };
const overridesByCustomerId = new Map();
for (const o of (overridesCfg.overrides || [])) {
  if (!overridesByCustomerId.has(o.allmoxy_customer_id)) overridesByCustomerId.set(o.allmoxy_customer_id, []);
  overridesByCustomerId.get(o.allmoxy_customer_id).push(o);
}

const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));
const subByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'subscription_by_month.json'), 'utf8'));
const mrrByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_by_month.json'), 'utf8'));
const waterfall = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_waterfall.json'), 'utf8'));

function addMonths(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymFromDate(iso) {
  return (iso || '').slice(0, 7);
}

function round2(n) { return Math.round(n * 100) / 100; }

function findOverride(customerId, origin, amount) {
  const list = overridesByCustomerId.get(customerId) ?? [];
  return list.find((o) =>
    o.origin_month === origin
    && amount >= (o.amount_match_min ?? 0)
    && amount <= (o.amount_match_max ?? Number.POSITIVE_INFINITY)
  );
}

function amortizeCustomer(profile) {
  // Build fresh per-month subscription from transactions.
  // Returns { monthlySub: { [ym]: number }, monthlyAnnualized: Set<ym>, monthlyPayDate: { [ym]: isoDate } }
  const monthlySub = {};
  const monthlyAnnualized = new Set();
  const monthlyPayDate = {};

  const subTx = (profile.transactions || []).filter((t) => t.type === 'subscription' && t.status === 'succeeded');
  for (const t of subTx) {
    const origin = ymFromDate(t.created);
    if (!origin) continue;
    const payDate = (t.created || '').slice(0, 10);
    if (t.amount >= ANNUAL_THRESHOLD) {
      const override = findOverride(profile.allmoxy_customer_id, origin, t.amount);
      const months = override?.months ?? AMORTIZE_MONTHS;
      const startMonth = override?.start_month ?? origin;
      if (override) {
        console.log(`  override hit: ${profile.name} · $${t.amount.toFixed(2)} on ${payDate} → ${months} months starting ${startMonth} (${override.reason ?? 'no reason given'})`);
      }
      const per = t.amount / months;
      for (let k = 0; k < months; k++) {
        const m = addMonths(startMonth, k);
        monthlySub[m] = round2((monthlySub[m] ?? 0) + per);
        monthlyAnnualized.add(m);
        if (!monthlyPayDate[m]) monthlyPayDate[m] = payDate;
      }
    } else {
      monthlySub[origin] = round2((monthlySub[origin] ?? 0) + t.amount);
      if (!monthlyPayDate[origin]) monthlyPayDate[origin] = payDate;
    }
  }

  return { monthlySub, monthlyAnnualized, monthlyPayDate };
}

let changed = 0;

for (const profile of profiles.rows) {
  if (!ANNUAL_IDS.has(profile.allmoxy_customer_id)) continue;
  const { monthlySub, monthlyAnnualized, monthlyPayDate } = amortizeCustomer(profile);

  // --- 1. Update customer_profiles monthly_history ---
  const allMonths = new Set([
    ...Object.keys(profile.monthly_history || {}),
    ...Object.keys(monthlySub),
  ]);
  const newHistory = {};
  for (const m of allMonths) {
    const old = profile.monthly_history?.[m] || { subscription: 0, services: 0, connect: 0, total: 0 };
    const sub = monthlySub[m] ?? 0;
    const services = old.services || 0;
    const connect = old.connect || 0;
    const total = round2(sub + services + connect);
    if (sub === 0 && services === 0 && connect === 0) continue; // drop empty months
    const cell = { subscription: sub, services, connect, total };
    if (monthlyAnnualized.has(m)) cell.annualized = true;
    newHistory[m] = cell;
  }
  profile.monthly_history = newHistory;

  // Recompute per-profile aggregates.
  let lifetimeSub = 0;
  let peakMonth = null;
  let peakTotal = 0;
  for (const [m, v] of Object.entries(newHistory)) {
    lifetimeSub += v.subscription;
    if (v.total > peakTotal) {
      peakTotal = v.total;
      peakMonth = m;
    }
  }
  profile.lifetime_subscription = round2(lifetimeSub);
  profile.lifetime_total = round2(profile.lifetime_subscription + profile.lifetime_services + profile.lifetime_connect + (profile.lifetime_other || 0));
  profile.peak_month = peakMonth;
  profile.peak_month_total = round2(peakTotal);
  profile.current_subscription_mrr = round2(newHistory[profile.latest_month]?.subscription ?? 0);
  // Status flag must reflect the POST-amortization reality. The upstream status
  // is computed from payment-activity recency in build_customer_profiles —
  // which incorrectly marks annual payers 'churned' if their last lump-sum
  // falls outside the current 12-month window. After amortization stamps
  // future months with the spread, recompute: a customer with positive MRR in
  // the latest complete month is 'active'.
  if (profile.current_subscription_mrr > 0 && profile.status === 'churned') {
    profile.status = 'active';
    profile.status_corrected_by_amortization = true;
  }

  // --- 2. Update subscription_by_month row for this customer ---
  const subRow = subByMonth.rows.find((r) => r.customer_name === profile.name);
  if (subRow) {
    // Wipe existing month cells.
    for (const k of Object.keys(subRow)) {
      if (/^\d{4}-\d{2}$/.test(k)) delete subRow[k];
    }
    const nextPayDates = {};
    for (const [m, v] of Object.entries(monthlySub)) {
      if (v > 0) subRow[m] = v;
      if (monthlyPayDate[m]) nextPayDates[m] = monthlyPayDate[m];
    }
    subRow.payment_dates = nextPayDates;
  }

  changed++;
}

console.log(`Amortized ${changed} annual-payer customer(s).`);

// --- 2.5. Apply variance overrides (carry-forward for non-churn $0 months) ---
// Stops the waterfall from classifying card-failure / tiered-billing / paused
// customers as churn. Synthesizes the prior month's MRR value into the current
// month so subscription_by_month, monthly_history, and the rebuilt waterfall
// all see the customer as stable. Must run BEFORE the totals/waterfall rebuild.
const VARIANCE_OVERRIDES_PATH = path.join(ROOT, '_etl_scripts/variance_overrides.json');
const varianceCfg = fs.existsSync(VARIANCE_OVERRIDES_PATH)
  ? JSON.parse(fs.readFileSync(VARIANCE_OVERRIDES_PATH, 'utf8'))
  : { overrides: [] };
for (const o of (varianceCfg.overrides || [])) {
  if (o.type !== 'carry_forward') continue;
  const subRow = subByMonth.rows.find((r) => r.customer_name === o.customer_name);
  if (!subRow) {
    console.warn(`  variance override: "${o.customer_name}" not found in subscription_by_month — skipping`);
    continue;
  }
  const prevMonth = addMonths(o.month, -1);
  const prevVal = subRow[prevMonth];
  if (typeof prevVal !== 'number' || prevVal <= 0) {
    console.warn(`  variance override: ${o.customer_name} ${prevMonth} has no positive MRR — can't carry forward to ${o.month}`);
    continue;
  }
  const existing = subRow[o.month];
  if (typeof existing === 'number' && existing > 0) {
    console.log(`  carry_forward (no-op): ${o.customer_name} already has $${existing} in ${o.month}`);
    continue;
  }
  subRow[o.month] = prevVal;
  if (subRow.payment_dates) {
    const prevDate = subRow.payment_dates[prevMonth];
    if (prevDate) subRow.payment_dates[o.month] = prevDate;
  }
  // Mirror into customer_profiles.monthly_history so per-customer views agree.
  const profile = profiles.rows.find((p) => p.name === o.customer_name);
  if (profile) {
    if (!profile.monthly_history) profile.monthly_history = {};
    const old = profile.monthly_history[o.month] || { subscription: 0, services: 0, connect: 0, total: 0 };
    profile.monthly_history[o.month] = {
      ...old,
      subscription: prevVal,
      total: round2(prevVal + (old.services || 0) + (old.connect || 0)),
      carried_forward: true,
      carry_forward_reason: o.reason ?? 'non-churn carry-forward',
    };
  }
  console.log(`  carry_forward: ${o.customer_name} ${o.month} ← $${prevVal} from ${prevMonth} (${o.reason ?? 'no reason given'})`);
}

// --- 3. Recompute mrr_by_month totals from subscription_by_month ---
// Build month → {sumSub, logoQty} from subByMonth.
const totalsByMonth = {};
for (const row of subByMonth.rows) {
  for (const [k, v] of Object.entries(row)) {
    if (!/^\d{4}-\d{2}$/.test(k)) continue;
    if (typeof v !== 'number' || v <= 0) continue;
    if (!totalsByMonth[k]) totalsByMonth[k] = { sum: 0, logos: 0 };
    totalsByMonth[k].sum += v;
    totalsByMonth[k].logos += 1;
  }
}
for (const row of mrrByMonth.rows) {
  const t = totalsByMonth[row.month];
  if (!t) continue;
  row.logo_qty = t.logos;
  row.mrr_subscription = round2(t.sum);
  row.mrr_blended = round2(t.sum + (row.mrr_services || 0) + (row.mrr_connect || 0));
  row.avg_mrr_blended = t.logos > 0 ? Math.round(row.mrr_blended / t.logos) : 0;
}

// --- 4. Rebuild mrr_waterfall.monthly from subscription_by_month ---
const monthsSorted = Object.keys(totalsByMonth).sort();
const today = new Date();
const currentYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

// Build customer → month → sub map AND first-MRR-month per customer (used to
// distinguish a brand-new logo from a reactivation).
const custMrr = new Map();
const firstMrrMonth = new Map();
for (const row of subByMonth.rows) {
  const m = {};
  for (const [k, v] of Object.entries(row)) {
    if (/^\d{4}-\d{2}$/.test(k) && typeof v === 'number' && v > 0) m[k] = v;
  }
  custMrr.set(row.customer_name, m);
  const months = Object.keys(m).sort();
  if (months.length > 0) firstMrrMonth.set(row.customer_name, months[0]);
}

const newMonthly = [];
for (let i = 1; i < monthsSorted.length; i++) {
  const prev = monthsSorted[i - 1];
  const cur = monthsSorted[i];
  if (cur >= currentYM) break;

  let newMrr = 0, reactivatedMrr = 0, expansion = 0, contraction = 0, churn = 0, starting = 0, ending = 0;
  let newLogos = 0, reactivatedLogos = 0, churnedLogos = 0;
  const details = { new: [], reactivated: [], expansion: [], contraction: [], churn: [] };

  for (const [name, byMonth] of custMrr.entries()) {
    const p = byMonth[prev] ?? 0;
    const n = byMonth[cur] ?? 0;
    starting += p;
    ending += n;
    if (p === 0 && n > 0) {
      // True new logo only if cur is their first-ever MRR month; otherwise reactivation.
      if (firstMrrMonth.get(name) === cur) {
        newMrr += n;
        newLogos++;
        details.new.push({ name, mrr: round2(n) });
      } else {
        reactivatedMrr += n;
        reactivatedLogos++;
        details.reactivated.push({ name, mrr: round2(n) });
      }
    } else if (p > 0 && n === 0) {
      churn += p;
      churnedLogos++;
      details.churn.push({ name, mrr: round2(p) });
    } else if (n > p) {
      const delta = n - p;
      expansion += delta;
      details.expansion.push({ name, prev_mrr: round2(p), new_mrr: round2(n), delta: round2(delta) });
    } else if (n < p) {
      const delta = p - n;
      contraction += delta;
      details.contraction.push({ name, prev_mrr: round2(p), new_mrr: round2(n), delta: round2(delta) });
    }
  }

  const net = newMrr + reactivatedMrr + expansion - contraction - churn;
  const grr = starting > 0 ? (starting - churn - contraction) / starting : 1;
  const nrr = starting > 0 ? (starting - churn - contraction + expansion) / starting : 1;
  const qr = (churn + contraction) > 0 ? (newMrr + reactivatedMrr + expansion) / (churn + contraction) : null;
  const grossChurn = starting > 0 ? (churn + contraction) / starting : 0;
  const netChurn = starting > 0 ? (churn + contraction - expansion) / starting : 0;
  const expRate = starting > 0 ? expansion / starting : 0;

  newMonthly.push({
    month: cur,
    starting_mrr: round2(starting),
    new_mrr: round2(newMrr),
    reactivated_mrr: round2(reactivatedMrr),
    expansion_mrr: round2(expansion),
    contraction_mrr: round2(contraction),
    churn_mrr: round2(churn),
    ending_mrr: round2(ending),
    net_new_mrr: round2(net),
    new_logos: newLogos,
    reactivated_logos: reactivatedLogos,
    churned_logos: churnedLogos,
    gross_churn_rate_monthly: round2(grossChurn * 10000) / 10000,
    net_churn_rate_monthly: round2(netChurn * 10000) / 10000,
    expansion_rate_monthly: round2(expRate * 10000) / 10000,
    grr_monthly: round2(grr * 10000) / 10000,
    nrr_monthly: round2(nrr * 10000) / 10000,
    quick_ratio: qr != null ? Math.round(qr * 10) / 10 : null,
    details: {
      new: details.new.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      reactivated: details.reactivated.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      expansion: details.expansion.sort((a, b) => b.delta - a.delta).slice(0, 25),
      contraction: details.contraction.sort((a, b) => b.delta - a.delta).slice(0, 25),
      churn: details.churn.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
    },
  });
}
waterfall.monthly = newMonthly;

// Recompute TTM waterfall (12-month rolling sums of monthly deltas).
if (Array.isArray(waterfall.ttm)) {
  const ttm = [];
  for (let i = 11; i < newMonthly.length; i++) {
    const window = newMonthly.slice(i - 11, i + 1);
    const endRow = newMonthly[i];
    const startRow = newMonthly[i - 11];
    const sum = (key) => window.reduce((s, r) => s + (r[key] ?? 0), 0);
    const starting = startRow.starting_mrr;
    const ending = endRow.ending_mrr;
    const newMrr = sum('new_mrr');
    const expansion = sum('expansion_mrr');
    const contraction = sum('contraction_mrr');
    const churn = sum('churn_mrr');
    const netNew = newMrr + expansion - contraction - churn;
    const grr = starting > 0 ? (starting - churn - contraction) / starting : 1;
    const nrr = starting > 0 ? (starting - churn - contraction + expansion) / starting : 1;
    const qr = (churn + contraction) > 0 ? (newMrr + expansion) / (churn + contraction) : null;
    ttm.push({
      month: endRow.month,
      starting_mrr: round2(starting),
      new_mrr: round2(newMrr),
      expansion_mrr: round2(expansion),
      contraction_mrr: round2(contraction),
      churn_mrr: round2(churn),
      ending_mrr: round2(ending),
      net_new_mrr: round2(netNew),
      grr_ttm: round2(grr * 10000) / 10000,
      nrr_ttm: round2(nrr * 10000) / 10000,
      quick_ratio_ttm: qr != null ? Math.round(qr * 10) / 10 : null,
    });
  }
  waterfall.ttm = ttm;
}

// Also bump fetchedAt timestamps so UI knows data was refreshed.
const now = new Date().toISOString();
profiles.fetchedAt = now;
subByMonth.fetchedAt = now;
mrrByMonth.fetchedAt = now;
waterfall.fetchedAt = now;

// Write back.
fs.writeFileSync(path.join(SNAP, 'customer_profiles.json'), JSON.stringify(profiles));
fs.writeFileSync(path.join(SNAP, 'subscription_by_month.json'), JSON.stringify(subByMonth));
fs.writeFileSync(path.join(SNAP, 'mrr_by_month.json'), JSON.stringify(mrrByMonth));
fs.writeFileSync(path.join(SNAP, 'mrr_waterfall.json'), JSON.stringify(waterfall));

console.log('Wrote customer_profiles.json, subscription_by_month.json, mrr_by_month.json, mrr_waterfall.json.');

// Regenerate the lean roster that UI pages (Custom Report, etc.) read.
await import('./build_roster.mjs');
