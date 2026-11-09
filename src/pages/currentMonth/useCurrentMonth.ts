import { useMemo, useState } from 'react';
import { useSheetTab } from '../../hooks/useSheetTab';
import annualPayerIds from '../../data/annual_payer_ids.json';

/**
 * Current Month calculations, moved verbatim out of CurrentMonth.tsx (2026-11-09) so the
 * classic page and the design-system page share one source of every month-to-date figure.
 */
export type VarianceCategory = 'overdue' | 'cancelled' | 'contracted' | 'expanded' | 'new_sub' | 'reactivated' | 'reconnected' | 'billing_timing';

// Annual payers bill once a year (amortized to monthly MRR). Their last charge is
// a yearly lump, so the monthly clustering would wrongly treat them as "due again"
// the following month — exclude them from the upcoming-expected list.
export const ANNUAL_PAYER_IDS = new Set<number>(annualPayerIds.annual_payer_ids);

export type MrrRow = {
  month: string;
  logo_qty: number | null;
  mrr_subscription: number | null;
  mrr_services: number | null;
  mrr_connect: number | null;
  mrr_blended: number | null;
  avg_mrr_blended: number | null;
};
export type MrrSnap = { rows: MrrRow[]; fetchedAt: string };

export type Transaction = {
  created: string | null;
  amount: number;
  amount_refunded?: number;
  net_amount?: number;
  type: string | null;
  status: string | null;
  description: string;
  stripe_subscription_id?: string | null;
  // Stamped by apply_transaction_overrides when a lump catch-up payment has been
  // reallocated across multiple billing months. The receipt row stays intact for
  // cash-basis QB reconciliation; expandReallocations() below splits it into
  // virtual per-month receipts so the variance categorizer sees normal cadence
  // instead of one anomalous lump.
  reallocated?: {
    receipt_month: string;
    allocations: Array<{ month: string; amount: number }>;
    reason?: string | null;
  };
};
// Effective post-refund amount for any transaction. Falls back to gross amount when
// net_amount is missing (older snapshots / data without refund tracking).
export function netAmount(t: Transaction): number {
  if (typeof t.net_amount === 'number') return t.net_amount;
  if (typeof t.amount_refunded === 'number') return Math.max(t.amount - t.amount_refunded, 0);
  return t.amount;
}

// Expand reallocated lump payments into per-allocation virtual transactions so
// the cluster matcher sees normal monthly cadence. The original row is
// REPLACED in the returned list (not kept alongside) to avoid double-counting.
// Storage in customer_profiles.transactions[] is untouched — this is only the
// view-friendly representation used by this page.
export function expandReallocations(txns: Transaction[]): Transaction[] {
  const out: Transaction[] = [];
  for (const t of txns) {
    if (t.reallocated && Array.isArray(t.reallocated.allocations) && t.reallocated.allocations.length > 0) {
      // Use day 01 for the synthesized date — most subscription cadences bill
      // at the start of the month, and the variance categorizer just needs the
      // month bucket and a plausible day for "expected day" calculation.
      for (const alloc of t.reallocated.allocations) {
        out.push({
          ...t,
          amount: alloc.amount,
          net_amount: alloc.amount,
          amount_refunded: 0,
          created: `${alloc.month}-01 00:00:00`,
        });
      }
      continue;
    }
    out.push(t);
  }
  return out;
}
export type ProfileRow = {
  allmoxy_customer_id: number;
  name: string;
  stripe_customer_ids: string[];
  pay_status?: string | null;
  status?: string | null;
  monthly_history: Record<string, { subscription: number; services: number; connect: number; total: number }>;
  transactions: Transaction[];
};
export type ProfilesSnap = { rows: ProfileRow[]; fetchedAt: string };
// Only the cut-off fields are read here; the rest of current_month.json drives AccrualMonthPanel.
export type CurrentMonthSnap = { month?: string; as_of?: string; day_of_month?: number; data_stale?: boolean; generated_on?: string };

export const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
export function priorMonth(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function daysInMonth(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
// Days of `currentMonth` covered by the DATA, from its cut-off date (YYYY-MM-DD).
// Never the wall clock or the snapshot's fetchedAt: when the Stripe sync trails today,
// a wall-clock day count inflates every run-rate denominator and marks billing days
// as "passed" that the data cannot see yet.
export function daysElapsed(currentMonth: string, asOfIso: string) {
  const asOfMonth = asOfIso.slice(0, 7);
  if (asOfMonth < currentMonth) return 0;
  if (asOfMonth > currentMonth) return daysInMonth(currentMonth);
  return Number(asOfIso.slice(8, 10));
}
export function pctDelta(a: number | null, b: number | null) {
  if (a == null || b == null || b === 0) return null;
  return (a - b) / b;
}
export function fmtPct(v: number | null) {
  if (v == null) return '—';
  const pct = v * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
export function fmtIso(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
export function round2(n: number) {
  return Math.round(n * 100) / 100;
}


export function useCurrentMonth() {
  const { data: mrrData, isLoading: mrrLoading } = useSheetTab('mrr_by_month');
  const { data: profilesData } = useSheetTab('customer_profiles');
  // Data cut-off (Stripe sync as-of date) — the one elapsed-days basis for every
  // projection on this page.
  const { data: cmData } = useSheetTab('current_month');
  // Accrual (invoiced) series — see the 'billing_timing' category below. A cash gap in
  // the prior month is only a real interruption if the customer was not INVOICED then.
  const { data: rrData } = useSheetTab('revenue_recognition');
  const accrualByCustomer = useMemo(() => {
    const m = new Map<number, Record<string, number>>();
    const series = (rrData as unknown as { accrual_series?: Array<{ allmoxy_customer_id: number; months: Record<string, number> }> } | undefined)?.accrual_series ?? [];
    for (const r of series) m.set(r.allmoxy_customer_id, r.months || {});
    return m;
  }, [rrData]);

  const ALL_CATEGORIES: VarianceCategory[] = ['overdue', 'cancelled', 'contracted', 'expanded', 'new_sub', 'reactivated', 'reconnected', 'billing_timing'];
  const [activeCategories, setActiveCategories] = useState<Set<VarianceCategory>>(new Set(ALL_CATEGORIES));
  const toggleCategory = (cat: VarianceCategory) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const mrr = mrrData as unknown as MrrSnap | undefined;
  const profiles = profilesData as unknown as ProfilesSnap | undefined;

  const cmSnap = cmData as unknown as CurrentMonthSnap | undefined;

  const view = useMemo(() => {
    if (!mrr || mrr.rows.length === 0) return null;
    const lastRow = mrr.rows[mrr.rows.length - 1];
    const currentMonth = lastRow.month;
    const prior = priorMonth(currentMonth);
    const priorRow = mrr.rows.find((r) => r.month === prior) ?? null;

    const totalDays = daysInMonth(currentMonth);
    // Cut-off resolution. The cash cards below are built from customer_profiles
    // transactions + mrr_by_month, which come from the Stripe Sync pipeline and can trail
    // the Stripe API caches that set current_month.json as_of. So the cut-off is the
    // EARLIER of: current_month.json as_of (Stripe data cut-off) and the latest
    // transaction date in customer_profiles. snapshot fetchedAt is the last resort only.
    let asOf: string | null = null;
    let asOfSource: 'current_month' | 'transactions' | 'fetchedAt' = 'fetchedAt';
    if (cmSnap?.as_of && /^\d{4}-\d{2}-\d{2}/.test(cmSnap.as_of)) {
      asOf = cmSnap.as_of.slice(0, 10);
      asOfSource = 'current_month';
    }
    if (profiles) {
      let latest = '';
      for (const p of profiles.rows) {
        for (const t of p.transactions ?? []) {
          const d = (t.created ?? '').slice(0, 10);
          if (d > latest) latest = d;
        }
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(latest) && (!asOf || latest < asOf)) {
        asOf = latest;
        asOfSource = 'transactions';
      }
    }
    if (!asOf) {
      const f = new Date(mrr.fetchedAt);
      asOf = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    }
    const elapsed = daysElapsed(currentMonth, asOf);
    const remaining = Math.max(totalDays - elapsed, 0);

    const project = (mtd: number | null) => {
      if (mtd == null || elapsed === 0) return null;
      return (mtd / elapsed) * totalDays;
    };

    return {
      currentMonth,
      prior,
      lastRow,
      priorRow,
      totalDays,
      asOf,
      asOfSource,
      stripeAsOf: cmSnap?.as_of?.slice(0, 10) ?? null,
      dataStale: cmSnap?.data_stale === true,
      elapsed,
      remaining,
      // Subscription is a snapshot — billing cycles, NOT daily accrual; no projection.
      services: {
        mtd: lastRow.mrr_services,
        projected: project(lastRow.mrr_services),
        priorTotal: priorRow?.mrr_services ?? null,
      },
      connect: {
        mtd: lastRow.mrr_connect,
        projected: project(lastRow.mrr_connect),
        priorTotal: priorRow?.mrr_connect ?? null,
      },
      subscription: {
        mtd: lastRow.mrr_subscription,
        priorTotal: priorRow?.mrr_subscription ?? null,
        priorLogos: priorRow?.logo_qty ?? null,
        currentLogos: lastRow.logo_qty,
      },
      blended: {
        mtd: lastRow.mrr_blended,
        priorTotal: priorRow?.mrr_blended ?? null,
      },
    };
  }, [mrr, cmSnap, profiles]);

  // Per-subscription variance computation. Each customer can have multiple subscriptions
  // (e.g., DOT Cabinets has a $49 sandbox + $880 main on different billing days). We
  // identify subscriptions synthetically by clustering each customer's prior-month
  // succeeded subscription transactions on amount; the same amount month-over-month is
  // a strong signal of "same recurring sub". Each cluster gets its own row in the
  // variance detail, so a customer with 2 subs produces 2 rows.
  //
  // When `stripe_subscription_id` becomes available in Stripe Sync, replace the
  // `subKey` function below with `t.stripe_subscription_id` and the rest stays.
  const subscriptionView = useMemo(() => {
    if (!profiles || !view) return null;
    const cm = view.currentMonth;
    const pm = view.prior;
    const elapsedDay = view.elapsed;

    type DetailRow = {
      rowKey: string;
      customerId: number;
      customerName: string;
      stripeIds: string[];
      subLabel: string;
      category: VarianceCategory;
      priorAmount: number;
      currentAmount: number;
      delta: number;
      expectedByDay?: number;
      daysOverdue?: number;
      // Billing day has passed and Stripe shows NO attempt (success or failure) yet —
      // either the charge isn't synced yet or the sub was turned off. Never skipped.
      noAttempt?: boolean;
    };

    let postedCur = 0;
    let postedPriors = 0;
    let postedSubs = 0;
    let pendingPriors = 0;
    let pendingSubs = 0;
    let overduePriors = 0;
    let overdueSubs = 0;
    const detail: DetailRow[] = [];

    // Upcoming expected subscriptions: clusters that billed last month, haven't
    // billed yet this month, and whose billing day hasn't arrived — i.e. still
    // genuinely expected to come in. These (not the paused/cancelled-not-yet-due
    // edge cases that also briefly increment pendingSubs) are what the headline
    // "expected from N" figure and the audit table below are built from.
    type UpcomingRow = {
      rowKey: string;
      customerId: number;
      customerName: string;
      stripeIds: string[];
      amount: number;        // prior-month billed amount = what we expect again
      expectedDay: number;   // day of month it typically bills
      payStatus: string;
      attempting: boolean;   // Stripe has already attempted (early/failed) this month
      lastBilledMonth: string;
    };
    const upcoming: UpcomingRow[] = [];

    // Subscription identity — three-tier resolution:
    //   1) Real Stripe Subscription ID from HubSpot (`s:<sub_id>`) — authoritative.
    //      Available for ~196 single-sub customers via build_customer_profiles ETL.
    //   2) Description handle `Subscription <domain>.allmoxy.com:` (`h:<domain>`) —
    //      stable identifier when the amount swings (e.g., Raumplus usage-based).
    //   3) Rounded amount (`a:<key>`) — fallback. Same-customer clusters within
    //      ±15% are merged to absorb rate changes (Westwind: $3,810 → $3,674).
    function txnIdentity(t: Transaction): { id: string; isHandle: boolean; key: number } {
      const key = Math.round(t.amount);
      if (t.stripe_subscription_id) return { id: `s:${t.stripe_subscription_id}`, isHandle: true, key };
      const m = (t.description ?? '').match(/^Subscription\s+(\S+\.allmoxy\.com)/i);
      if (m) return { id: `h:${m[1].toLowerCase()}`, isHandle: true, key };
      return { id: `a:${key}`, isHandle: false, key };
    }

    // Trailing 3-month lookback window for cluster construction so we capture
    // customers with irregular billing (e.g., National Wood Products skips March
    // but pays Feb→Apr at $107.65). Cluster from any of these months; baseline
    // amount comes from the most recent prior-billed month within the window.
    function shiftMonth(iso: string, delta: number) {
      const [y, m] = iso.split('-').map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const lookbackMonths = new Set([pm, shiftMonth(pm, -1), shiftMonth(pm, -2)]);

    for (const p of profiles.rows) {
      const stripeIds = p.stripe_customer_ids ?? [];
      // Reallocation-aware view of this customer's transactions: any reallocated
      // lump (e.g., Rehau Pty's $1,698 May catch-up covering Mar + Apr) is
      // virtually split into one row per allocation, so the cluster matcher
      // sees normal monthly cadence instead of one anomalous high-amount blip.
      const txns = expandReallocations(p.transactions);
      // succeeded-and-net-positive charges drive amount aggregation. A fully-refunded
      // charge (net $0) is treated as if it didn't happen — same as a failure.
      // ALL attempts (succeeded OR failed) drive the active-billing-cycle check.
      const isNetPositive = (t: Transaction) => netAmount(t) > 0.01;
      const lookbackTxns = txns.filter(
        (t) => t.created && t.type === 'subscription' && t.status === 'succeeded' && isNetPositive(t) && lookbackMonths.has(t.created.slice(0, 7))
      );
      // A subscription payment that CLEARED in a later calendar month than the one
      // being viewed (e.g. a 30th-biller whose June cycle cleared July 1) means they
      // have already paid for the cycle on a cash basis — so they're not "expected
      // to still bill." Prevents end-of-month billers from showing as expected when
      // the completed month is viewed at the start of the next one.
      const billedAfterCm = txns.some(
        (t) => t.created && t.type === 'subscription' && t.status === 'succeeded' && isNetPositive(t) && t.created.slice(0, 7) > cm
      );
      const lookbackAttempts = txns.filter(
        (t) => t.created && t.type === 'subscription' && (t.status === 'failed' || (t.status === 'succeeded' && isNetPositive(t))) && lookbackMonths.has(t.created.slice(0, 7))
      );
      const currTxns = txns.filter(
        (t) => t.created && t.created.startsWith(cm) && t.type === 'subscription' && t.status === 'succeeded' && isNetPositive(t)
      );
      // ALL current-month subscription attempts (success OR failure) — used to detect
      // whether Stripe is still actively retrying. NextGen-style fully-refunded
      // charges are NOT counted as attempts (they're effectively reversals, not
      // dunning activity).
      const currAttempts = txns.filter(
        (t) => t.created && t.created.startsWith(cm) && t.type === 'subscription' && (t.status === 'failed' || (t.status === 'succeeded' && isNetPositive(t)))
      );
      if (lookbackTxns.length === 0 && currTxns.length === 0) continue;

      // Brand-new logo: NO succeeded subscription transactions in any month before cm.
      // (Wider than just the lookback — if they billed years ago, they're not new.)
      const hasAnyPriorSub = txns.some(
        (t) => t.created && t.type === 'subscription' && t.status === 'succeeded' && t.created.slice(0, 7) < cm
      );

      // CASE A: customer billed in current month with NO recent (3-month) lookback.
      // Either a brand-new logo (no subscription history ever) or a reactivation
      // (had subscription history before but went silent and is now back).
      if (currTxns.length > 0 && lookbackTxns.length === 0) {
        const total = currTxns.reduce((s, t) => s + netAmount(t), 0);
        const avgAmount = Math.round(total / currTxns.length);
        const subDay = Number((currTxns[0].created ?? '').slice(8, 10));
        const isReactivated = hasAnyPriorSub;
        postedCur += total;
        postedSubs += 1;
        detail.push({
          rowKey: `${p.allmoxy_customer_id}-${isReactivated ? 'react' : 'new'}`,
          customerId: p.allmoxy_customer_id,
          customerName: p.name,
          stripeIds,
          subLabel: `${USD0.format(avgAmount)}/mo · day ${subDay}${isReactivated ? ' · returning' : ''}`,
          category: isReactivated ? 'reactivated' : 'new_sub',
          priorAmount: 0,
          currentAmount: round2(total),
          delta: round2(total),
        });
        continue;
      }

      // CASE B: customer has prior history. Build clusters from the trailing 3-month
      // lookback. Each cluster tracks per-month sums so we can use the most recent
      // billed month as the variance baseline (handles irregular cycles like National
      // Wood that skip months).
      type Cluster = {
        id: string;            // 'h:<handle>' or 'a:<amountKey>' or 's:<sub_id>'
        isHandle: boolean;
        key: number;           // canonical amount (most recent for handle clusters)
        perMonth: Record<string, number>;     // succeeded $ amounts per month
        attemptedMonths: Set<string>;         // any attempt (succeeded OR failed) in lookback
        currentTotal: number;                 // succeeded $ in current month
        currentAttempted: boolean;            // any attempt (succeeded OR failed) in current month
        expectedDay: number;
      };
      const clustersRaw = new Map<string, Cluster>();
      // Pass 1: index ATTEMPT months for every succeeded-or-failed charge. Drives the
      // active-cycle check below — a customer in active dunning has 0 successes but
      // many failed attempts, and is still very much expected to bill.
      for (const t of lookbackAttempts) {
        const ident = txnIdentity(t);
        const day = Number((t.created ?? '').slice(8, 10));
        const monthKey = (t.created ?? '').slice(0, 7);
        if (!clustersRaw.has(ident.id)) {
          clustersRaw.set(ident.id, { id: ident.id, isHandle: ident.isHandle, key: ident.key, perMonth: {}, attemptedMonths: new Set(), currentTotal: 0, currentAttempted: false, expectedDay: 0 });
        }
        const c = clustersRaw.get(ident.id)!;
        c.attemptedMonths.add(monthKey);
        if (Number.isFinite(day) && day > c.expectedDay) c.expectedDay = day;
      }
      // Pass 2: layer in successful $ amounts for revenue aggregation.
      for (const t of lookbackTxns) {
        const ident = txnIdentity(t);
        const monthKey = (t.created ?? '').slice(0, 7);
        const c = clustersRaw.get(ident.id);
        if (!c) continue;
        c.perMonth[monthKey] = (c.perMonth[monthKey] ?? 0) + netAmount(t);
      }

      // Post-process: for amount-based clusters only, merge any whose keys are within
      // ±15% (catches rate changes on the same sub, e.g., Westwind $3,810 → $3,674).
      // Handle-based clusters are already canonical — they share an explicit identifier.
      const MERGE_TOLERANCE = 0.15;
      const sortedClusters = [...clustersRaw.values()].sort((a, b) => {
        const aLast = Object.keys(a.perMonth).sort().slice(-1)[0] ?? '';
        const bLast = Object.keys(b.perMonth).sort().slice(-1)[0] ?? '';
        if (aLast !== bLast) return bLast.localeCompare(aLast);
        return b.key - a.key;
      });
      const clusters: Cluster[] = [];
      for (const c of sortedClusters) {
        const canMerge = !c.isHandle;
        const target = canMerge
          ? clusters.find((m) => !m.isHandle && Math.abs(m.key - c.key) / Math.max(m.key, c.key, 1) <= MERGE_TOLERANCE)
          : undefined;
        if (target) {
          for (const [month, amt] of Object.entries(c.perMonth)) {
            target.perMonth[month] = (target.perMonth[month] ?? 0) + amt;
          }
          for (const m of c.attemptedMonths) target.attemptedMonths.add(m);
          // Update the canonical key to the more recent cluster's key (already first
          // in sorted order, so target was added first when it had a more recent month).
          if (c.expectedDay > target.expectedDay) target.expectedDay = c.expectedDay;
        } else {
          clusters.push(c);
        }
      }

      // Match current-month transactions to clusters: exact identity match first
      // (handle or amount), then fuzzy fallback to the closest cluster by amount —
      // ANY cluster including handle ones, since a customer's only sub is often a
      // handle cluster and their current charge may carry a different description
      // format (e.g., Staley's "Subscription staleycc.allmoxy.com" history vs an
      // April "Invoice C1A4156A-0010"). Letting amount-typed current charges fall
      // into handle clusters fixes those false-overdue cases.
      function matchClusterByIdentity(t: Transaction): Cluster | null {
        const ident = txnIdentity(t);
        let best: Cluster | null = clusters.find((c) => c.id === ident.id) ?? null;
        if (best) return best;
        let bestDiff = Infinity;
        for (const c of clusters) {
          const diff = Math.abs(c.key - ident.key) / Math.max(c.key, ident.key, 1);
          if (diff < bestDiff) { best = c; bestDiff = diff; }
        }
        return best;
      }
      // Successful current-month charges → drive currentTotal.
      // Month-boundary slip: a charge in the first few days of the current month
      // that is really LAST month's cycle (a ~end-of-month biller whose invoice
      // cleared on the 1st). If the cluster has no prior-month charge but did bill
      // the month before that, treat this as the prior-month payment (perMonth[pm])
      // instead of a current-month charge — so it's a normal continuing sub, not a
      // false "Reconnected"/"New" this month. (e.g. Drawer Works, Intermountain,
      // Cabinet Parts to Go billing on the 30th, clearing the 1st.)
      const pmPrev = shiftMonth(pm, -1);
      for (const t of currTxns) {
        const best = matchClusterByIdentity(t);
        if (!best) continue;
        const day = Number((t.created ?? '').slice(8, 10));
        const isBoundarySlip = day <= 3 && !((best.perMonth[pm] ?? 0) > 0) && (best.perMonth[pmPrev] ?? 0) > 0;
        if (isBoundarySlip) best.perMonth[pm] = (best.perMonth[pm] ?? 0) + netAmount(t);
        else best.currentTotal += netAmount(t);
      }
      // ALL current-month attempts (success OR failure) → mark cluster as "still
      // being attempted by Stripe". Used in the overdue branch to distinguish
      // active dunning (LV: 5 failed Apr attempts) from silently-canceled subs
      // (NJ Drawers' $49: zero Apr attempts, customer turned it off).
      for (const t of currAttempts) {
        const best = matchClusterByIdentity(t);
        if (best) best.currentAttempted = true;
      }

      // Emit one detail row per cluster.
      for (const c of clusters) {
        // Baseline amount = most recent prior-billed month for this cluster.
        const monthsBilled = Object.keys(c.perMonth).sort();
        const lastBilledMonth = monthsBilled[monthsBilled.length - 1];
        const priorAmount = c.perMonth[lastBilledMonth] ?? 0;
        const subLabel = `${USD0.format(c.key)}/mo · day ${c.expectedDay}`;
        const rowBase = {
          rowKey: `${p.allmoxy_customer_id}-${c.key}`,
          customerId: p.allmoxy_customer_id,
          customerName: p.name,
          stripeIds,
          subLabel,
        };
        if (c.currentTotal > 0) {
          const billedLastMonth = (c.perMonth[pm] ?? 0) > 0;
          postedCur += c.currentTotal;
          postedSubs += 1;
          if (!billedLastMonth) {
            // A cash gap in the prior month has two very different causes, and until
            // the accrual report existed there was no way to tell them apart:
            //
            //   billing_timing — the customer WAS invoiced last month; only the cash
            //     landed outside it (a late clear, a Link/bank settlement, or a charge
            //     the sync failed to capture). Nothing happened commercially, so
            //     counting the full amount as variance is noise. In Sept 2026 this was
            //     10 of 11 "reconnections", and the same customers the charge-cache
            //     invariant reports as short — Craftsman Specialty, Classic Kitchen
            //     Doors, Sherwood Shelving, Ironwood, Mullet Door, Superior Woodworking.
            //
            //   reconnected — genuinely not invoiced last month and billing again now.
            //
            const accrualMonths = accrualByCustomer.get(p.allmoxy_customer_id);
            const accrualPrior = accrualMonths?.[pm] ?? 0;
            const accrualCur = accrualMonths?.[cm] ?? 0;
            const timingOnly = accrualPrior > 0;
            detail.push({
              ...rowBase,
              category: timingOnly ? 'billing_timing' : 'reconnected',
              priorAmount: timingOnly ? round2(accrualPrior) : 0,
              currentAmount: round2(c.currentTotal),
              // Measure timing rows INVOICE TO INVOICE, never against the cash that
              // happened to arrive. Comparing cash to the prior invoice still credits a
              // catch-up as growth: Bella IMC paid two months at once in Sept 2026, so
              // cash $1,316 against an invoiced $658 read as +$658 of expansion when
              // their subscription had not moved at all. When this month's invoice has
              // not been issued yet (mid-month, most have not), there is no evidence of
              // any change, so the honest contribution is zero.
              delta: timingOnly ? (accrualCur > 0 ? round2(accrualCur - accrualPrior) : 0) : round2(c.currentTotal),
            });
            continue;
          }
          postedPriors += priorAmount;
          const delta = c.currentTotal - priorAmount;
          if (Math.abs(delta) < 0.01) continue; // stable — no variance contribution
          if (delta > 0) {
            detail.push({ ...rowBase, category: 'expanded', priorAmount: round2(priorAmount), currentAmount: round2(c.currentTotal), delta: round2(delta) });
          } else {
            detail.push({ ...rowBase, category: 'contracted', priorAmount: round2(priorAmount), currentAmount: round2(c.currentTotal), delta: round2(delta) });
          }
        } else {
          // Two stale-cluster guards before deciding what to do with this cluster:
          //   (a) Cluster must have attempted a charge in the immediately prior month
          //       (succeeded OR failed). Filters discontinued / one-off charges
          //       like Nexis3's old $107 cluster.
          //   (b) If the cluster's expected billing day has ALREADY passed this month
          //       AND Stripe isn't even attempting (no successes, no failures), the
          //       customer canceled the sub — skip it entirely. Filters NJ Drawers'
          //       $49 (turned off after March, day 1 long passed, zero retries).
          //
          // Clusters whose day hasn't arrived yet still count as PENDING (anticipated
          // to bill later this month — e.g., DOT's $880 sub on day 30, today day 28).
          // Clusters whose day has passed AND have attempts (success or fail) but no
          // success yet count as OVERDUE (active dunning — LV's $699).
          const attemptedLastMonth = c.attemptedMonths.has(pm);
          if (!attemptedLastMonth) continue;
          const dayPassed = c.expectedDay > 0 && elapsedDay > c.expectedDay;
          // "First month without payment" gate for the Cancelled bucket: the cluster's
          // most recent successful charge must be in the previous month (pm). If the
          // last successful charge was older — e.g. Phoenix Direct, last paid Jan 2026,
          // failed retries through March — they were already silently churned a cycle
          // or two ago and shouldn't reappear as freshly Cancelled. (`attemptedLastMonth`
          // alone is too loose because failed-retry attempts also count.)
          const cancelledFreshMiss = p.pay_status === 'Cancelled' && lastBilledMonth === pm;
          // Sub silently stopped — Stripe isn't even attempting this month. If HubSpot
          // confirms cancellation AND it's the first miss, surface it as Cancelled.
          // Otherwise skip (paused, irregular biller, or already-stale dunning case).
          if (dayPassed && !c.currentAttempted) {
            if (cancelledFreshMiss) {
              overduePriors += priorAmount; // counts as a confirmed loss in projection math
              detail.push({
                ...rowBase,
                category: 'cancelled',
                priorAmount: round2(priorAmount),
                currentAmount: 0,
                delta: round2(-priorAmount),
              });
            } else if (
              p.status === 'active' &&
              p.pay_status !== 'Active - Pause Granted' &&
              p.pay_status !== 'Cancelled' &&
              !ANNUAL_PAYER_IDS.has(p.allmoxy_customer_id) &&
              !billedAfterCm
            ) {
              // An ACTIVE account whose billing day has passed with zero Stripe
              // attempts used to vanish from the page — neither posted, expected, nor
              // overdue. Surface it as overdue ("no attempt — not yet synced?") so
              // the projection and the variance both account for it.
              overduePriors += priorAmount;
              overdueSubs += 1;
              detail.push({
                ...rowBase,
                category: 'overdue',
                priorAmount: round2(priorAmount),
                currentAmount: 0,
                delta: round2(-priorAmount),
                expectedByDay: c.expectedDay,
                daysOverdue: elapsedDay - c.expectedDay,
                noAttempt: true,
              });
            }
            continue;
          }
          pendingPriors += priorAmount;
          pendingSubs += 1;
          // Cancelled is only valid AFTER the billing day has passed without a successful
          // charge — i.e., this is the first month they actually missed. Before the day
          // passes we can't yet tell if they'll bill, so don't surface them. Pause Granted
          // means intentionally skipping a month — silently omit, no row.
          const skipForStatus = p.pay_status === 'Cancelled' || p.pay_status === 'Active - Pause Granted';
          if (cancelledFreshMiss && dayPassed) {
            overduePriors += priorAmount;
            detail.push({
              ...rowBase,
              category: 'cancelled',
              priorAmount: round2(priorAmount),
              currentAmount: 0,
              delta: round2(-priorAmount),
            });
          } else if (!skipForStatus && dayPassed) {
            overduePriors += priorAmount;
            overdueSubs += 1;
            detail.push({
              ...rowBase,
              category: 'overdue',
              priorAmount: round2(priorAmount),
              currentAmount: 0,
              delta: round2(-priorAmount),
              expectedByDay: c.expectedDay,
              daysOverdue: elapsedDay - c.expectedDay,
            });
          } else if (!skipForStatus && p.status === 'active' && !ANNUAL_PAYER_IDS.has(p.allmoxy_customer_id) && !billedAfterCm) {
            // On-time: billing day hasn't arrived yet → still expected to bill
            // this month. Restricted to active-status accounts only (at-risk,
            // non-payment, churned, etc. don't count as expected revenue) AND
            // excludes annual payers, whose last charge is a yearly lump that
            // would otherwise look like a monthly bill due again this month.
            // This set makes up the headline "expected from N".
            upcoming.push({
              rowKey: rowBase.rowKey,
              customerId: rowBase.customerId,
              customerName: rowBase.customerName,
              stripeIds: rowBase.stripeIds,
              amount: round2(priorAmount),
              expectedDay: c.expectedDay,
              payStatus: p.pay_status ?? '',
              attempting: c.currentAttempted,
              lastBilledMonth,
            });
          }
        }
      }
    }

    // Sort: by category in chip order (New → Reactivated → Expansion → Contraction → Overdue).
    // Within each category, biggest mover first (|delta| desc) — EXCEPT Overdue, which
    // sorts by days overdue desc (oldest first) since longer-unbilled subs are higher
    // priority to chase.
    const catOrder: Record<VarianceCategory, number> = { new_sub: 0, reactivated: 1, reconnected: 2, billing_timing: 3, expanded: 4, contracted: 5, overdue: 6, cancelled: 7 };
    detail.sort((a, b) => {
      const catDiff = catOrder[a.category] - catOrder[b.category];
      if (catDiff !== 0) return catDiff;
      if (a.category === 'overdue' && b.category === 'overdue') {
        const aDays = a.daysOverdue ?? 0;
        const bDays = b.daysOverdue ?? 0;
        if (aDays !== bDays) return bDays - aDays;
      }
      const impactDiff = Math.abs(b.delta) - Math.abs(a.delta);
      if (impactDiff !== 0) return impactDiff;
      return a.customerName.localeCompare(b.customerName);
    });

    // "Expected" = the genuinely on-time upcoming list (excludes paused /
    // cancelled-not-yet-due clusters that briefly inflate pendingSubs). The
    // headline figure, the projection, and the audit table all derive from this
    // one list so they reconcile exactly.
    upcoming.sort((a, b) => a.expectedDay - b.expectedDay || b.amount - a.amount);
    const expectedDollars = round2(upcoming.reduce((s, u) => s + u.amount, 0));
    const expectedSubs = upcoming.length;

    // Variance baseline must cover the SAME population the projection does, or the
    // delta is nonsense. projected = postedCur + expectedDollars (active monthly
    // accounts only), so the prior-month baseline is those same accounts' prior
    // amounts: posted accounts' prior (postedPriors) + expected accounts' prior
    // (== expectedDollars, since we expect the prior amount again) + overdue
    // accounts' prior (overduePriors, a real loss this month). Paused / annual /
    // non-active accounts are excluded from BOTH sides so they create no phantom
    // variance (e.g. B&B Door's $32k annual lump was distorting the total).
    // With this baseline, varianceAbs collapses to postedDelta − overduePriors,
    // which equals the sum of the New/Expansion/Contraction/Overdue/Cancelled
    // category cards below — so the headline and the breakdown reconcile exactly.
    const priorFull = postedPriors + expectedDollars + overduePriors;
    const postedDelta = postedCur - postedPriors;
    const projected = postedCur + expectedDollars;
    const varianceAbs = projected - priorFull;
    const variancePct = priorFull > 0 ? varianceAbs / priorFull : null;

    const sumDelta = (cat: VarianceCategory) =>
      detail.filter((d) => d.category === cat).reduce((s, d) => s + d.delta, 0);
    const counts = {
      overdue: detail.filter((d) => d.category === 'overdue').length,
      cancelled: detail.filter((d) => d.category === 'cancelled').length,
      contracted: detail.filter((d) => d.category === 'contracted').length,
      expanded: detail.filter((d) => d.category === 'expanded').length,
      new_sub: detail.filter((d) => d.category === 'new_sub').length,
      reactivated: detail.filter((d) => d.category === 'reactivated').length,
      reconnected: detail.filter((d) => d.category === 'reconnected').length,
      billing_timing: detail.filter((d) => d.category === 'billing_timing').length,
    };
    const sums = {
      overdue: round2(sumDelta('overdue')),
      cancelled: round2(sumDelta('cancelled')),
      contracted: round2(sumDelta('contracted')),
      expanded: round2(sumDelta('expanded')),
      new_sub: round2(sumDelta('new_sub')),
      reactivated: round2(sumDelta('reactivated')),
      reconnected: round2(sumDelta('reconnected')),
      billing_timing: round2(sumDelta('billing_timing')),
    };

    // Annual prepay recognized this month — the amortized monthly slice of
    // annual-payer payments. They pay a lump upfront (no monthly charge), so
    // they're outside the transaction clustering above; add them back so blended
    // revenue reconciles to the MRR-by-Month basis.
    let annualAmort = 0;
    for (const p of profiles.rows) {
      if (ANNUAL_PAYER_IDS.has(p.allmoxy_customer_id)) annualAmort += p.monthly_history?.[cm]?.subscription ?? 0;
    }

    return {
      annualAmort: round2(annualAmort),
      postedCur: round2(postedCur),
      postedPriors: round2(postedPriors),
      postedSubs,
      postedDelta: round2(postedDelta),
      pendingPriors: round2(pendingPriors),
      pendingSubs,
      overduePriors: round2(overduePriors),
      overdueSubs,
      expectedDollars,
      expectedSubs,
      upcoming,
      detail,
      counts,
      sums,
      priorFull: round2(priorFull),
      projected: round2(projected),
      varianceAbs: round2(varianceAbs),
      variancePct,
    };
  }, [profiles, view]);

  return { mrrLoading, mrr, profiles, cmSnap, view, subscriptionView, ALL_CATEGORIES, activeCategories, setActiveCategories, toggleCategory };
}
