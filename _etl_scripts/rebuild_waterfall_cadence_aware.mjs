#!/usr/bin/env node
/**
 * Rebuild mrr_waterfall.json with cadence-aware classification.
 *
 * Old logic: any prev>0 → cur=0 transition = churn event.
 * Problem: semi-annual / annual / irregular payers get counted multiple times.
 *
 * New logic: for each customer, determine their active range
 *   [first_paying_month, last_paying_month].
 *   - Before first_paying_month: no events.
 *   - At first_paying_month: New Logo.
 *   - Between first and last (inclusive of all months): gaps are Contraction to $0,
 *     rebounds are Expansion from $0.
 *   - At last_paying_month (transition to month after): Churn.
 *   - After last_paying_month: no events.
 */

import fs from 'node:fs';
import path from 'node:path';

const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';
const subByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'subscription_by_month.json'), 'utf8'));
const waterfall = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_waterfall.json'), 'utf8'));

const round2 = (n) => Math.round(n * 100) / 100;

// Build customer → sorted list of paying months with MRR.
const customers = new Map(); // name → { firstMonth, lastMonth, mrrByMonth }
for (const row of subByMonth.rows) {
  const name = row.customer_name;
  if (!name) continue;
  const m = {};
  let first = null;
  let last = null;
  for (const [k, v] of Object.entries(row)) {
    if (/^\d{4}-\d{2}$/.test(k) && typeof v === 'number' && v > 0) {
      m[k] = v;
      if (!first || k < first) first = k;
      if (!last || k > last) last = k;
    }
  }
  if (!first) continue;
  customers.set(name, { firstMonth: first, lastMonth: last, mrrByMonth: m });
}

// Gather all month keys present.
const monthSet = new Set();
for (const c of customers.values()) {
  for (const k of Object.keys(c.mrrByMonth)) monthSet.add(k);
}
const months = [...monthSet].sort();

const today = new Date();
const currentYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

function addMonths(iso, delta) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const newMonthly = [];
for (let i = 1; i < months.length; i++) {
  const prev = months[i - 1];
  const cur = months[i];
  if (cur >= currentYM) break;

  let newMrr = 0, expansion = 0, contraction = 0, churn = 0, starting = 0, ending = 0;
  let newLogos = 0, churnedLogos = 0;
  const details = { new: [], expansion: [], contraction: [], churn: [] };

  for (const [name, c] of customers.entries()) {
    const p = c.mrrByMonth[prev] ?? 0;
    const n = c.mrrByMonth[cur] ?? 0;
    starting += p;
    ending += n;

    const isFirstPayment = cur === c.firstMonth; // their debut month
    const isChurnTransition = prev === c.lastMonth && cur > c.lastMonth; // first month after last payment
    // Is this customer within their active window around this transition?
    const inActiveRange = prev >= c.firstMonth && cur <= c.lastMonth;

    if (isFirstPayment && p === 0 && n > 0) {
      // True new logo.
      newMrr += n;
      newLogos++;
      details.new.push({ name, mrr: round2(n) });
      continue;
    }

    if (isChurnTransition && p > 0 && n === 0) {
      // True churn.
      churn += p;
      churnedLogos++;
      details.churn.push({ name, mrr: round2(p) });
      continue;
    }

    // Skip customers entirely outside their active range (no event).
    if (!inActiveRange && !isFirstPayment && !isChurnTransition) continue;

    // Intra-active-range: classify gaps as contraction/expansion, not churn/new.
    if (p === 0 && n > 0) {
      // Rebound: treat as expansion from 0 (not new logo).
      expansion += n;
      details.expansion.push({ name, mrr: round2(n), prev: round2(p), cur: round2(n) });
    } else if (p > 0 && n === 0) {
      // Gap: treat as contraction to 0 (not churn).
      contraction += p;
      details.contraction.push({ name, mrr: round2(p), prev: round2(p), cur: round2(n) });
    } else if (n > p) {
      const delta = n - p;
      expansion += delta;
      details.expansion.push({ name, mrr: round2(delta), prev: round2(p), cur: round2(n) });
    } else if (n < p) {
      const delta = p - n;
      contraction += delta;
      details.contraction.push({ name, mrr: round2(delta), prev: round2(p), cur: round2(n) });
    }
  }

  const net = newMrr + expansion - contraction - churn;
  const grr = starting > 0 ? (starting - churn - contraction) / starting : 1;
  const nrr = starting > 0 ? (starting - churn - contraction + expansion) / starting : 1;
  const qr = (churn + contraction) > 0 ? (newMrr + expansion) / (churn + contraction) : null;
  const grossChurn = starting > 0 ? (churn + contraction) / starting : 0;
  const netChurn = starting > 0 ? (churn + contraction - expansion) / starting : 0;
  const expRate = starting > 0 ? expansion / starting : 0;

  newMonthly.push({
    month: cur,
    starting_mrr: round2(starting),
    new_mrr: round2(newMrr),
    expansion_mrr: round2(expansion),
    contraction_mrr: round2(contraction),
    churn_mrr: round2(churn),
    ending_mrr: round2(ending),
    net_new_mrr: round2(net),
    new_logos: newLogos,
    churned_logos: churnedLogos,
    gross_churn_rate_monthly: round2(grossChurn * 10000) / 10000,
    net_churn_rate_monthly: round2(netChurn * 10000) / 10000,
    expansion_rate_monthly: round2(expRate * 10000) / 10000,
    grr_monthly: round2(grr * 10000) / 10000,
    nrr_monthly: round2(nrr * 10000) / 10000,
    quick_ratio: qr != null ? Math.round(qr * 10) / 10 : null,
    details: {
      new: details.new.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      expansion: details.expansion.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      contraction: details.contraction.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
      churn: details.churn.sort((a, b) => b.mrr - a.mrr).slice(0, 25),
    },
  });
}
waterfall.monthly = newMonthly;

// Recompute TTM from new monthly.
if (Array.isArray(waterfall.ttm) || typeof waterfall.ttm === 'object') {
  // Use last 12 months.
  const ttmWindow = newMonthly.slice(-12);
  if (ttmWindow.length > 0) {
    const starting = ttmWindow[0].starting_mrr;
    const ending = ttmWindow[ttmWindow.length - 1].ending_mrr;
    const sum = (k) => ttmWindow.reduce((s, r) => s + (r[k] ?? 0), 0);
    const new_mrr = sum('new_mrr');
    const expansion = sum('expansion_mrr');
    const contraction = sum('contraction_mrr');
    const churn = sum('churn_mrr');
    const grr = starting > 0 ? (starting - churn - contraction) / starting : 1;
    const nrr = starting > 0 ? (starting - churn - contraction + expansion) / starting : 1;
    const qr = (churn + contraction) > 0 ? (new_mrr + expansion) / (churn + contraction) : null;
    const gross_churn_rate = starting > 0 ? churn / starting : 0;
    waterfall.ttm = {
      windowStart: ttmWindow[0].month,
      windowEnd: ttmWindow[ttmWindow.length - 1].month,
      starting_mrr: round2(starting),
      ending_mrr: round2(ending),
      new_mrr: round2(new_mrr),
      expansion_mrr: round2(expansion),
      contraction_mrr: round2(contraction),
      churn_mrr: round2(churn),
      net_new_mrr: round2(new_mrr + expansion - contraction - churn),
      annual_gross_churn_rate: round2(gross_churn_rate * 10000) / 10000,
      annual_grr: round2(grr * 10000) / 10000,
      annual_nrr: round2(nrr * 10000) / 10000,
      quick_ratio: qr != null ? Math.round(qr * 10) / 10 : null,
    };
  }
}

waterfall.fetchedAt = new Date().toISOString();
fs.writeFileSync(path.join(SNAP, 'mrr_waterfall.json'), JSON.stringify(waterfall));

// Report: how many multi-churn customers remain?
const churnCounts = new Map();
for (const m of newMonthly) {
  for (const c of m.details.churn) {
    churnCounts.set(c.name, (churnCounts.get(c.name) ?? 0) + 1);
  }
}
const multi = [...churnCounts.entries()].filter(([, n]) => n > 1);
console.log(`Rebuilt ${newMonthly.length} monthly rows + TTM.`);
console.log(`Customers appearing in churn more than once: ${multi.length} (was 112)`);
if (multi.length > 0) console.log('Remaining multi-churn sample:', multi.slice(0, 5));
