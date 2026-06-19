#!/usr/bin/env node
/**
 * Apply per-transaction reclassifications to existing snapshots.
 *
 * Reads `_etl_scripts/transaction_overrides.json` and shifts amounts between
 * streams (subscription / services / connect) for the (customer, month) cells
 * specified there. Persists across xlsx re-uploads — the source xlsx's
 * transaction_type formula may misclassify the same row again, and this script
 * reapplies the correction at refresh time.
 *
 * Affects: customer_profiles.json, subscription_by_month.json, services_by_month.json,
 *          mrr_by_month.json, customer_health.json
 *
 * Must run AFTER build_customer_profiles and build_customer_health (so the snapshots
 * exist) and BEFORE apply_annual_amortization (the amortization step rebuilds
 * mrr_waterfall.monthly from subscription_by_month, which by then will be
 * override-corrected).
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard';
const SNAP = path.join(ROOT, 'public/snapshots');
const OVERRIDES_PATH = path.join(ROOT, '_etl_scripts/transaction_overrides.json');

const overridesCfg = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
const overrides = overridesCfg.overrides ?? [];
if (overrides.length === 0) {
  console.log('  no transaction overrides configured.');
  process.exit(0);
}

const profiles = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_profiles.json'), 'utf8'));
const subByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'subscription_by_month.json'), 'utf8'));
const svcByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'services_by_month.json'), 'utf8'));
const mrrByMonth = JSON.parse(fs.readFileSync(path.join(SNAP, 'mrr_by_month.json'), 'utf8'));
const customerHealth = JSON.parse(fs.readFileSync(path.join(SNAP, 'customer_health.json'), 'utf8'));

function round2(n) { return Math.round(n * 100) / 100; }

let applied = 0;
const skipped = [];

for (const ov of overrides) {
  const { allmoxy_customer_id, source_allmoxy_customer_id, month, amount, txn_created_starts_with, from, to, allocations } = ov;
  if (!allmoxy_customer_id || !month || !amount || !from || !to) {
    skipped.push({ ov, reason: 'missing required field' });
    continue;
  }

  const profile = profiles.rows.find((r) => r.allmoxy_customer_id === allmoxy_customer_id);
  if (!profile) {
    skipped.push({ ov, reason: `customer id ${allmoxy_customer_id} not found in customer_profiles` });
    continue;
  }

  // ─── Reallocation mode ───
  // When `allocations` is an array of { month, amount }, redistribute the
  // monthly_history credit for THIS transaction across multiple months WITHOUT
  // touching transactions[] (so cash-basis QB reconciliation stays clean —
  // Stripe still shows the lump payment on the original date). Use this for
  // catch-up payments where one Stripe receipt covers multiple billing
  // periods. Allocations must sum to `amount` exactly.
  if (Array.isArray(allocations) && allocations.length > 0) {
    if (from !== to) {
      skipped.push({ ov, reason: 'reallocation requires from === to (same type, different months)' });
      continue;
    }
    const allocSum = allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    if (Math.abs(allocSum - amount) > 0.5) {
      skipped.push({ ov, reason: `allocations sum ${allocSum} != amount ${amount}` });
      continue;
    }
    // Remove the lump from the receipt month
    if (!profile.monthly_history) profile.monthly_history = {};
    const receiptCell = profile.monthly_history[month];
    if (receiptCell) {
      receiptCell[from] = round2(Math.max(0, (receiptCell[from] ?? 0) - amount));
      receiptCell.total = round2((receiptCell.subscription ?? 0) + (receiptCell.services ?? 0) + (receiptCell.connect ?? 0));
    }
    // Credit each allocation month
    for (const alloc of allocations) {
      const allocMonth = alloc.month;
      const allocAmt = Number(alloc.amount) || 0;
      if (!profile.monthly_history[allocMonth]) {
        profile.monthly_history[allocMonth] = { subscription: 0, services: 0, connect: 0, total: 0 };
      }
      const cell = profile.monthly_history[allocMonth];
      cell[from] = round2((cell[from] ?? 0) + allocAmt);
      cell.total = round2((cell.subscription ?? 0) + (cell.services ?? 0) + (cell.connect ?? 0));
    }
    // Tag the source transaction so the Customer Detail page can surface the
    // reallocation visually. transactions[] amounts/dates are NEVER modified —
    // only metadata flags get added — so Stripe / QB cash-basis reconciliation
    // remains intact (the lump payment date and amount match the source row).
    if (Array.isArray(profile.transactions)) {
      for (const t of profile.transactions) {
        if (Math.abs(t.amount - amount) > 0.5) continue;
        if (txn_created_starts_with && !(t.created ?? '').startsWith(txn_created_starts_with)) continue;
        t.reallocated = {
          receipt_month: month,
          allocations,
          reason: ov.reason ?? null,
        };
        break;
      }
    }
    applied++;
    continue;
  }

  // from === to is a no-op for same-customer overrides, but for cross-customer
  // MOVES it just means "reattribute, keep the type" — that's legitimate
  // (e.g., a subscription charge wrongly tagged to customer A should still be a
  // subscription charge on customer B). Allow it when source is set.
  if (from === to && (source_allmoxy_customer_id == null || source_allmoxy_customer_id === allmoxy_customer_id)) {
    skipped.push({ ov, reason: 'from === to (no-op, same-customer)' });
    continue;
  }

  // Optional cross-customer move: when Stripe Sync attributes the charge to the
  // wrong allmoxy_customer_id, `source_allmoxy_customer_id` tells us where the
  // raw transaction now lives. We pull it out of the source customer's record
  // and graft it onto the target (with the corrected `to` type), so the
  // dashboard sees the charge attached to the right customer for cluster math,
  // lifetime totals, and the transaction list.
  const source = (source_allmoxy_customer_id != null && source_allmoxy_customer_id !== allmoxy_customer_id)
    ? profiles.rows.find((r) => r.allmoxy_customer_id === source_allmoxy_customer_id)
    : null;

  // Helper: retype a matching transaction in-place inside a customer's transactions[].
  function retypeIn(customerProfile, newType) {
    if (!Array.isArray(customerProfile?.transactions)) return false;
    for (const t of customerProfile.transactions) {
      if (Math.abs(t.amount - amount) > 0.5) continue;
      if (txn_created_starts_with && !(t.created ?? '').startsWith(txn_created_starts_with)) continue;
      if (t.type === newType) return true; // already corrected
      t.type = newType;
      return true;
    }
    return false;
  }

  if (source) {
    // Cross-customer move: try to pull the matching transaction out of source first.
    const txns = source.transactions || [];
    const idx = txns.findIndex((t) => {
      if (Math.abs(t.amount - amount) > 0.5) return false;
      if (txn_created_starts_with && !(t.created ?? '').startsWith(txn_created_starts_with)) return false;
      return true;
    });
    if (idx >= 0) {
      const [moved] = txns.splice(idx, 1);
      moved.type = to;
      // Reassign the subscription id to the target customer's primary sub so
      // the Current Month cluster matcher (which keys on stripe_subscription_id
      // first, amount second) groups this txn with their existing cluster.
      // Without this, the moved txn forms a stand-alone cluster on the target
      // and makes them look "reconnected" the following month. Preserve the
      // original id for audit trail.
      if (profile.stripe_subscription_id && moved.stripe_subscription_id && moved.stripe_subscription_id !== profile.stripe_subscription_id) {
        moved.stripe_subscription_id_original = moved.stripe_subscription_id;
        moved.stripe_subscription_id = profile.stripe_subscription_id;
      }
      profile.transactions = profile.transactions || [];
      profile.transactions.push(moved);
      profile.transactions.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));

      // Source's transaction-derived totals (lifetime_*, transaction_count) lose
      // the misattributed charge. Source's QB-derived aggregates (monthly_history,
      // current_subscription_mrr, current_services, etc.) come from "MRR by Month"
      // and "Services by Month" rollups in QB, which may NOT have the charge
      // credited to the source customer (QB and Stripe Sync can disagree on the
      // attribution — that's exactly the situation this override exists to handle).
      // We only adjust lifetime here; if QB also has the charge under the source,
      // a separate same-customer override would be needed to undo that.
      const sourceFromKey = `lifetime_${from}`;
      if (typeof source[sourceFromKey] === 'number') {
        source[sourceFromKey] = round2(source[sourceFromKey] - amount);
        if (source[sourceFromKey] < 0) source[sourceFromKey] = 0;
      }
      if (typeof source.lifetime_total === 'number') {
        source.lifetime_total = round2(source.lifetime_total - amount);
        if (source.lifetime_total < 0) source.lifetime_total = 0;
      }
      if (typeof source.transaction_count === 'number') {
        source.transaction_count = Math.max(0, source.transaction_count - 1);
      }
    } else {
      // Source was specified but the transaction isn't in source's record. The
      // upstream Stripe Sync attribution may have flipped back to the target
      // customer (we've seen this oscillate between uploads). Fall back to
      // retyping in target so at least the type classification is correct.
      retypeIn(profile, to);
    }
  } else {
    // Same-customer reclassification: just retype the transaction in place.
    if (Array.isArray(profile.transactions)) {
      for (const t of profile.transactions) {
        if (Math.abs(t.amount - amount) > 0.5) continue;
        if (txn_created_starts_with && !(t.created ?? '').startsWith(txn_created_starts_with)) continue;
        if (t.type === to) break; // already corrected, skip
        t.type = to;
        break;
      }
    }
  }

  // 2) Update customer_profiles.monthly_history[month] for TARGET. (For cross-
  //    customer moves, target's QB monthly rollup already credits target with
  //    the charge as `from`, so the existing shift logic still applies.)
  const cell = profile.monthly_history?.[month];
  if (cell) {
    cell[from] = round2((cell[from] ?? 0) - amount);
    if (cell[from] < 0) cell[from] = 0;
    cell[to] = round2((cell[to] ?? 0) + amount);
    cell.total = round2((cell.subscription ?? 0) + (cell.services ?? 0) + (cell.connect ?? 0));
  }

  // 3) Update lifetime aggregates and the "current_*" headline values on the profile
  //    when the override month matches the profile's latest_month.
  //    For cross-customer moves: the source's lifetime was already decremented above,
  //    and the target needs the `to` stream to gain the amount (target had it
  //    historically attributed as `from` via QB; the cross-customer move gives target
  //    a real transaction record so we add to lifetime_<to> here, but skip the
  //    target lifetime_<from> decrement because target never held the gross charge
  //    in its transactions.
  const fromKey = `lifetime_${from}`;
  const toKey = `lifetime_${to}`;
  if (!source && typeof profile[fromKey] === 'number') profile[fromKey] = round2(profile[fromKey] - amount);
  if (typeof profile[toKey] === 'number') profile[toKey] = round2(profile[toKey] + amount);
  if (source && typeof profile.lifetime_total === 'number') {
    profile.lifetime_total = round2(profile.lifetime_total + amount);
  }
  if (profile.latest_month === month) {
    if (from === 'subscription' && typeof profile.current_subscription_mrr === 'number') profile.current_subscription_mrr = round2(profile.current_subscription_mrr - amount);
    if (to === 'subscription' && typeof profile.current_subscription_mrr === 'number') profile.current_subscription_mrr = round2(profile.current_subscription_mrr + amount);
    if (from === 'services' && typeof profile.current_services === 'number') profile.current_services = round2(profile.current_services - amount);
    if (to === 'services' && typeof profile.current_services === 'number') profile.current_services = round2(profile.current_services + amount);
    if (from === 'connect' && typeof profile.current_connect === 'number') profile.current_connect = round2(profile.current_connect - amount);
    if (to === 'connect' && typeof profile.current_connect === 'number') profile.current_connect = round2(profile.current_connect + amount);
  }

  // 4) Update subscription_by_month and services_by_month per-customer cells.
  function adjustWideTab(tab, stream, sign) {
    if (stream !== 'subscription' && stream !== 'services') return; // connect comes from a different snapshot
    const tabRows = tab.rows ?? [];
    const row = tabRows.find((r) => r.customer_name === profile.name);
    if (!row) return;
    const cur = typeof row[month] === 'number' ? row[month] : 0;
    const next = round2(cur + sign * amount);
    row[month] = next > 0 ? next : null;
    // Maintain monthlyTotals where it exists.
    if (tab.monthlyTotals) {
      tab.monthlyTotals[month] = round2((tab.monthlyTotals[month] ?? 0) + sign * amount);
    }
  }
  adjustWideTab(subByMonth, from === 'subscription' ? 'subscription' : null, -1);
  adjustWideTab(subByMonth, to === 'subscription' ? 'subscription' : null, +1);
  adjustWideTab(svcByMonth, from === 'services' ? 'services' : null, -1);
  adjustWideTab(svcByMonth, to === 'services' ? 'services' : null, +1);

  // 5) Update mrr_by_month roll-up row for the affected month.
  const mrrRow = (mrrByMonth.rows ?? []).find((r) => r.month === month);
  if (mrrRow) {
    const mrrFromKey = `mrr_${from}`;
    const mrrToKey = `mrr_${to}`;
    if (typeof mrrRow[mrrFromKey] === 'number') mrrRow[mrrFromKey] = round2(mrrRow[mrrFromKey] - amount);
    if (typeof mrrRow[mrrToKey] === 'number') mrrRow[mrrToKey] = round2(mrrRow[mrrToKey] + amount);
    // mrr_blended doesn't change (just shifting between streams).
  }

  // 6) Update customer_health if the override touches the subscription stream and the
  //    override month matches health.latestMonth. customer_health is subscription-only.
  const isSubscriptionMove = from === 'subscription' || to === 'subscription';
  if (isSubscriptionMove && customerHealth.latestMonth === month) {
    const sign = to === 'subscription' ? +1 : -1; // +1 means we're adding to sub, -1 we're removing from sub
    const subDelta = sign * amount;
    // Update the affected customer's per-row current_mrr in any list that holds them.
    function patchCustomerList(list) {
      if (!Array.isArray(list)) return;
      const row = list.find((r) => r.allmoxy_customer_id === allmoxy_customer_id);
      if (!row) return;
      if (typeof row.current_mrr === 'number') row.current_mrr = round2(row.current_mrr + subDelta);
    }
    patchCustomerList(customerHealth.top_customers);
    patchCustomerList(customerHealth.all_active_customers);
    patchCustomerList(customerHealth.dunning_customers);
    if (Array.isArray(customerHealth.distribution)) {
      for (const bucket of customerHealth.distribution) {
        patchCustomerList(bucket.customers);
        if (typeof bucket.mrr === 'number') {
          // Only adjust the bucket total if the customer actually sits in this bucket.
          const inBucket = bucket.customers?.some((c) => c.allmoxy_customer_id === allmoxy_customer_id);
          if (inBucket) bucket.mrr = round2(bucket.mrr + subDelta);
        }
      }
    }
    // Concentration aggregates.
    if (customerHealth.concentration) {
      const c = customerHealth.concentration;
      if (typeof c.total_mrr === 'number') c.total_mrr = round2(c.total_mrr + subDelta);
      // Adjust top-N slice MRR if the customer sits in the slice.
      for (const sliceKey of ['top1', 'top5', 'top10', 'top20']) {
        const slice = c[sliceKey];
        if (!slice) continue;
        // Resort top_customers by current_mrr to determine membership after patch.
        // Cheap approximation: only adjust if customer was already in the top_customers
        // list and their position was within slice.n. Skip otherwise — safe because the
        // top of the list dwarfs any one $7K shift in MRR.
        const idx = (customerHealth.top_customers ?? []).findIndex((r) => r.allmoxy_customer_id === allmoxy_customer_id);
        if (idx >= 0 && idx < slice.n && typeof slice.mrr === 'number') {
          slice.mrr = round2(slice.mrr + subDelta);
          if (typeof slice.pct === 'number' && c.total_mrr > 0) slice.pct = Math.round((slice.mrr / c.total_mrr) * 10000) / 10000;
        }
      }
    }
  }

  applied++;
}

// Write everything back.
fs.writeFileSync(path.join(SNAP, 'customer_profiles.json'), JSON.stringify(profiles));
fs.writeFileSync(path.join(SNAP, 'subscription_by_month.json'), JSON.stringify(subByMonth));
fs.writeFileSync(path.join(SNAP, 'services_by_month.json'), JSON.stringify(svcByMonth));
fs.writeFileSync(path.join(SNAP, 'mrr_by_month.json'), JSON.stringify(mrrByMonth));
fs.writeFileSync(path.join(SNAP, 'customer_health.json'), JSON.stringify(customerHealth));

console.log(`  applied ${applied} transaction override(s).`);
if (skipped.length > 0) {
  console.log(`  skipped ${skipped.length}:`);
  for (const s of skipped) console.log('    -', s.reason, JSON.stringify(s.ov));
}
