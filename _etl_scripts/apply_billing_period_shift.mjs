#!/usr/bin/env node
/**
 * Boundary-slip correction for customer_profiles.monthly_history.
 *
 * An end-of-month biller whose subscription charge clears in the first few days of
 * the NEXT month lands (cash basis) in the wrong month: the cycle it actually
 * covers shows $0, and the month it cleared in shows a spike. Across MoM surfaces
 * this reads as false churn (the empty month) + false reactivation/expansion (the
 * spike month). This step re-attributes such a charge to the cycle it covers.
 *
 * Precise discriminator — a subscription charge is a slip iff ALL hold:
 *   • it cleared on day 1–3 of month M
 *   • monthly_history[M-1] has $0 subscription (the cycle it belongs to is empty)
 *   • monthly_history[M-2] has > $0 subscription (they WERE billing before)
 * i.e. a one-month gap bracketed by activity — the signature of a boundary slip,
 * not a real churn/reactivation. Verified to match only ~45 charges across ~7yr.
 *
 * Only monthly_history (the accrual view) is adjusted; transactions[] keep their
 * real clear dates so cash-basis reconciliation against Stripe/QuickBooks is intact.
 * Everything derived from monthly_history downstream — mrr_by_month (via
 * apply_stripe_seam_monthly), the MRR waterfall, churn/cohort surfaces — then agrees.
 *
 * Idempotent: once a slip is moved, its M-1 is no longer $0, so re-running is a no-op.
 * Must run AFTER all monthly_history enrichment (seam, amortization, connect, merges)
 * and BEFORE apply_stripe_seam_monthly + build_waterfall.
 */
import fs from 'node:fs';
import path from 'node:path';

const SNAP = '/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/public/snapshots';
const FILE = path.join(SNAP, 'customer_profiles.json');
const r2 = (v) => Math.round(v * 100) / 100;
const shift = (m, d) => { const [y, mo] = m.split('-').map(Number); const dt = new Date(y, mo - 1 + d, 1); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`; };

// latestCompleteMonth = prior calendar month (matches build_customer_profiles), so
// current_subscription_mrr can be recomputed after a slip lands in that month.
const today = new Date();
const latestCompleteMonth = (() => { const d = new Date(today.getFullYear(), today.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();

const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let movedCharges = 0, touchedCustomers = 0, intoLatest = 0;

for (const p of doc.rows) {
  const mh = p.monthly_history || {};
  const moves = [];
  for (const t of (p.transactions || [])) {
    if (t.type !== 'subscription' || t.status !== 'succeeded') continue;
    const d = String(t.created || ''); const day = Number(d.slice(8, 10)); const M = d.slice(0, 7);
    if (!(day <= 3) || !M) continue;
    const pm = shift(M, -1), pm2 = shift(M, -2);
    if ((mh[pm]?.subscription || 0) === 0 && (mh[pm2]?.subscription || 0) > 0) {
      moves.push({ M, pm, amt: (t.net_amount ?? t.amount) || 0 });
    }
  }
  if (!moves.length) continue;
  let touched = false;
  for (const { M, pm, amt } of moves) {
    if (!(amt > 0)) continue;
    if (!mh[pm]) mh[pm] = { subscription: 0, services: 0, connect: 0, total: 0 };
    mh[pm].subscription = r2((mh[pm].subscription || 0) + amt);
    mh[pm].total = r2((mh[pm].total || 0) + amt);
    if (mh[M]) {
      mh[M].subscription = r2(Math.max(0, (mh[M].subscription || 0) - amt));
      mh[M].total = r2(Math.max(0, (mh[M].total || 0) - amt));
      const e = mh[M];
      if ((e.subscription || 0) <= 0.5 && (e.services || 0) <= 0.5 && (e.connect || 0) <= 0.5) delete mh[M];
    }
    movedCharges++; touched = true;
    if (pm === latestCompleteMonth) intoLatest++;
  }
  if (touched) {
    // Re-sync current_subscription_mrr with the (now corrected) latest complete month.
    p.current_subscription_mrr = r2(mh[latestCompleteMonth]?.subscription || 0);
    touchedCustomers++;
  }
}

fs.writeFileSync(FILE, JSON.stringify(doc, null, 2));
console.error(`[billing-period-shift] reattributed ${movedCharges} boundary-slip charge(s) across ${touchedCustomers} customer(s); ${intoLatest} landed in ${latestCompleteMonth}`);
