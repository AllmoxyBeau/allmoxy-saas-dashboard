import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Collapse from '@mui/material/Collapse';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';
import annualPayerIds from '../data/annual_payer_ids.json';

// Annual payers bill once a year (amortized to monthly MRR). Their last charge is
// a yearly lump, so the monthly clustering would wrongly treat them as "due again"
// the following month — exclude them from the upcoming-expected list.
const ANNUAL_PAYER_IDS = new Set<number>(annualPayerIds.annual_payer_ids);

type MrrRow = {
  month: string;
  logo_qty: number | null;
  mrr_subscription: number | null;
  mrr_services: number | null;
  mrr_connect: number | null;
  mrr_blended: number | null;
  avg_mrr_blended: number | null;
};
type MrrSnap = { rows: MrrRow[]; fetchedAt: string };

type Transaction = {
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
function netAmount(t: Transaction): number {
  if (typeof t.net_amount === 'number') return t.net_amount;
  if (typeof t.amount_refunded === 'number') return Math.max(t.amount - t.amount_refunded, 0);
  return t.amount;
}

// Expand reallocated lump payments into per-allocation virtual transactions so
// the cluster matcher sees normal monthly cadence. The original row is
// REPLACED in the returned list (not kept alongside) to avoid double-counting.
// Storage in customer_profiles.transactions[] is untouched — this is only the
// view-friendly representation used by this page.
function expandReallocations(txns: Transaction[]): Transaction[] {
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
type ProfileRow = {
  allmoxy_customer_id: number;
  name: string;
  stripe_customer_ids: string[];
  pay_status?: string | null;
  status?: string | null;
  monthly_history: Record<string, { subscription: number; services: number; connect: number; total: number }>;
  transactions: Transaction[];
};
type ProfilesSnap = { rows: ProfileRow[]; fetchedAt: string };

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function priorMonth(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function daysInMonth(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function daysElapsed(currentMonth: string, fetchedAt: string) {
  const fetched = new Date(fetchedAt);
  const fetchedMonth = `${fetched.getFullYear()}-${String(fetched.getMonth() + 1).padStart(2, '0')}`;
  if (fetchedMonth < currentMonth) return 0;
  if (fetchedMonth > currentMonth) return daysInMonth(currentMonth);
  return fetched.getDate();
}
function pctDelta(a: number | null, b: number | null) {
  if (a == null || b == null || b === 0) return null;
  return (a - b) / b;
}
function fmtPct(v: number | null) {
  if (v == null) return '—';
  const pct = v * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
function fmtIso(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export default function CurrentMonth() {
  const { data: mrrData, isLoading: mrrLoading } = useSheetTab('mrr_by_month');
  const { data: profilesData } = useSheetTab('customer_profiles');

  type VarianceCategory = 'overdue' | 'cancelled' | 'contracted' | 'expanded' | 'new_sub' | 'reactivated' | 'reconnected';
  const ALL_CATEGORIES: VarianceCategory[] = ['overdue', 'cancelled', 'contracted', 'expanded', 'new_sub', 'reactivated', 'reconnected'];
  const [activeCategories, setActiveCategories] = useState<Set<VarianceCategory>>(new Set(ALL_CATEGORIES));
  const varianceTable = useCollapse(true);
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

  const view = useMemo(() => {
    if (!mrr || mrr.rows.length === 0) return null;
    const lastRow = mrr.rows[mrr.rows.length - 1];
    const currentMonth = lastRow.month;
    const prior = priorMonth(currentMonth);
    const priorRow = mrr.rows.find((r) => r.month === prior) ?? null;

    const totalDays = daysInMonth(currentMonth);
    const elapsed = daysElapsed(currentMonth, mrr.fetchedAt);
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
  }, [mrr]);

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
      for (const t of currTxns) {
        const best = matchClusterByIdentity(t);
        if (best) best.currentTotal += netAmount(t);
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
            // Reconnected: subscription history exists within the 3-month lookback,
            // but the customer skipped the immediately prior month. Variance vs pm is
            // the full currentTotal — not an expansion of an actively-billing sub.
            detail.push({
              ...rowBase,
              category: 'reconnected',
              priorAmount: 0,
              currentAmount: round2(c.currentTotal),
              delta: round2(c.currentTotal),
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
          } else if (!skipForStatus && p.status === 'active' && !ANNUAL_PAYER_IDS.has(p.allmoxy_customer_id)) {
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
    const catOrder: Record<VarianceCategory, number> = { new_sub: 0, reactivated: 1, reconnected: 2, expanded: 3, contracted: 4, overdue: 5, cancelled: 6 };
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
    };
    const sums = {
      overdue: round2(sumDelta('overdue')),
      cancelled: round2(sumDelta('cancelled')),
      contracted: round2(sumDelta('contracted')),
      expanded: round2(sumDelta('expanded')),
      new_sub: round2(sumDelta('new_sub')),
      reactivated: round2(sumDelta('reactivated')),
      reconnected: round2(sumDelta('reconnected')),
    };

    return {
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

  if (mrrLoading || !view) {
    return (
      <Box>
        <PageHeader title="Current Month" subtitle="Month-to-date metrics from the latest snapshot." />
        <Skeleton variant="rectangular" height={140} />
      </Box>
    );
  }

  const elapsedCaveat = `${view.elapsed} of ${view.totalDays} days`;

  return (
    <Box>
      <PageHeader
        title={`${monthLabel(view.currentMonth)} · Month-to-date`}
        subtitle={`Live snapshot of the partial current month. Data refreshed ${fmtIso(mrr?.fetchedAt)} · ${elapsedCaveat} elapsed · ${view.remaining} days remaining.`}
      />

      {view.elapsed === 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The data snapshot was generated before any day in {monthLabel(view.currentMonth)} elapsed — projections aren't meaningful yet.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="Subscription MRR"
            value={subscriptionView ? USD0.format(subscriptionView.projected) : USD0.format(view.subscription.mtd ?? 0)}
            valueHint={subscriptionView ? 'projected month-end (excludes overdue & paused)' : undefined}
            sub={
              subscriptionView
                ? `${USD0.format(subscriptionView.postedCur)} posted from ${subscriptionView.postedSubs} subscriptions · ${USD0.format(subscriptionView.expectedDollars)} expected from ${subscriptionView.expectedSubs}`
                : `${view.subscription.currentLogos ?? 0} of ${view.subscription.priorLogos ?? '—'} expected billings posted`
            }
            delta={subscriptionView?.variancePct ?? null}
            deltaLabel={`vs ${monthLabel(view.prior)} apples-to-apples`}
            info={
              <>
                <strong>Headline value:</strong> projected end-of-month subscription MRR. Posted (already billed) + expected (active accounts, still-on-time pending, will bill at prior amount). <em>Expected counts active-status accounts only</em> — overdue, paused, at-risk, non-payment, and cancelled customers are counted as zero in the projection until they actually bill. The <strong>Upcoming expected subscription payments</strong> table at the bottom of the page lists every subscription in the "expected" figure.
                <br /><br />
                <strong>Variance vs {monthLabel(view.prior)}</strong> is the apples-to-apples customer-level comparison: posted-customer changes (contraction/expansion/new logos) <em>plus</em> overdue customers' lost revenue. The Overdue panel below breaks the variance into its two components so the math reconciles.
              </>
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="Services revenue (MTD)"
            value={USD0.format(view.services.mtd ?? 0)}
            sub={view.services.projected != null ? `Projected month-end: ${USD0.format(view.services.projected)}` : 'Projection unavailable'}
            projectionCaveat={elapsedCaveat}
            delta={pctDelta(view.services.projected, view.services.priorTotal)}
            deltaLabel={`projected vs ${monthLabel(view.prior)} full`}
            info={<><strong>What it is:</strong> Services revenue (one-off project work). MTD value is sum of services charges so far this month; the projection assumes the same daily run-rate continues.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="Connect fees (MTD, net USD)"
            value={view.connect.mtd != null ? USD0.format(view.connect.mtd) : '—'}
            sub={
              view.connect.mtd == null
                ? 'Not yet in the current snapshot'
                : view.connect.projected != null
                  ? `Projected month-end: ${USD0.format(view.connect.projected)}`
                  : 'Projection unavailable'
            }
            projectionCaveat={view.connect.mtd != null ? elapsedCaveat : undefined}
            delta={pctDelta(view.connect.projected, view.connect.priorTotal)}
            deltaLabel={`projected vs ${monthLabel(view.prior)} full`}
            info={<><strong>What it is:</strong> Stripe Connect (affiliate) fees — <strong>net settled in USD</strong>, i.e. what actually hits the bank. Sourced live from Stripe <em>balance transactions</em> (type <code>application_fee</code>), so foreign-currency (CAD) fees are already FX-converted by Stripe and refunds are netted out. This differs from the gross take on the Payments Opportunity page, which reports each fee in its original charge currency. June 2026+ is live; earlier months come from history.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          {(() => {
            const subProj = subscriptionView?.projected ?? view.subscription.mtd ?? 0;
            const svcProj = view.services.projected ?? view.services.mtd ?? 0;
            const connProj = view.connect.projected ?? view.connect.mtd ?? 0;
            const blendedProjected = subProj + svcProj + connProj;
            const blendedMtd = view.blended.mtd ?? 0;
            const stillExpected = Math.max(blendedProjected - blendedMtd, 0);
            return (
              <KPICard
                label="Blended revenue"
                value={USD0.format(blendedProjected)}
                valueHint="projected month-end (all 3 streams)"
                sub={`${USD0.format(blendedMtd)} posted · ${USD0.format(stillExpected)} still expected`}
                delta={pctDelta(blendedProjected, view.blended.priorTotal)}
                deltaLabel={`projected vs ${monthLabel(view.prior)} full`}
                info={
                  <>
                    <strong>Headline value:</strong> projected end-of-month total revenue across all three streams (Subscription + Services + Connect). Combines the per-stream projections from the cards above.
                    <br /><br />
                    <strong>Subscription</strong> contribution = posted + non-overdue pending (billing-cycle aware). <strong>Services</strong> + <strong>Connect</strong> contributions = linear MTD run-rate × days-in-month / days-elapsed.
                    <br /><br />
                    Delta is projected month-end vs. {monthLabel(view.prior)} full — a forward-looking comparison rather than MTD-vs-full.
                  </>
                }
              />
            );
          })()}
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: varianceTable.open ? 2 : 0 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <CollapseToggle open={varianceTable.open} onToggle={varianceTable.toggle} label="variance detail" />
                <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                  Variance vs {monthLabel(view.prior)} · per-customer detail
                </Typography>
                <InfoIcon
                  info={
                    <>
                      Per-customer breakdown of the subscription MRR variance vs {monthLabel(view.prior)}. Each customer falls into one of these categories: <em>new logo</em> (no prior subscription history, billed this month), <em>reactivated</em> (returning after 4+ month gap), <em>reconnected</em> (skipped prior month but has recent history, now billing again), <em>expanded</em> (billed prior month and paid more this month), <em>contracted</em> (billed prior month and paid less), <em>overdue</em> (billed prior month, past their expected day with no charge yet), or <em>cancelled</em> (billed prior month, confirmed cancellation in HubSpot, no charge this month). Category sums reconcile to the total variance.
                      <br /><br />
                      Click chips to filter the table.
                    </>
                  }
                />
              </Stack>
              {subscriptionView && (
                <CsvExportButton
                  filename={`variance_${view.currentMonth}_vs_${view.prior}`}
                  columns={[
                    { key: 'customerId', label: 'Allmoxy ID' },
                    { key: 'customerName', label: 'Customer' },
                    { key: 'subLabel', label: 'Subscription' },
                    { key: 'category', label: 'Category', getValue: (r) => categoryLabel(r.category) },
                    { key: 'priorAmount', label: 'Prior $' },
                    { key: 'currentAmount', label: 'Current $' },
                    { key: 'delta', label: 'Δ' },
                    { key: 'expectedByDay', label: 'Expected day', getValue: (r) => r.expectedByDay ?? '' },
                    { key: 'daysOverdue', label: 'Days overdue', getValue: (r) => r.daysOverdue ?? '' },
                    { key: 'stripeIds', label: 'Stripe customer ID', getValue: (r) => r.stripeIds?.[0] ?? '' },
                  ]}
                  rows={subscriptionView.detail.filter((r) => activeCategories.has(r.category))}
                />
              )}
            </Stack>

            <Collapse in={varianceTable.open} unmountOnExit>
            {!subscriptionView ? (
              <Skeleton variant="rectangular" height={240} />
            ) : (
              <>
                {/* Total variance headline + 5-card category breakdown.
                    Each category card doubles as a filter toggle for the table below.
                    Replaces the old amber reconciliation strip + separate chip row. */}
                <Box sx={{ mb: 2.5, p: 2.5, bgcolor: 'rgba(255, 255, 255, 0.03)', border: '1px solid', borderColor: 'rgba(255,255,255,0.08)', borderRadius: 1.5 }}>
                  <Stack direction="row" spacing={2} alignItems="baseline" justifyContent="space-between" sx={{ mb: 2 }}>
                    <Box>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11 }}>
                        Total variance vs {monthLabel(view.prior)}
                      </Typography>
                      <Stack direction="row" spacing={1.5} alignItems="baseline" sx={{ mt: 0.25 }}>
                        <Typography variant="h4" sx={{ fontWeight: 600, color: subscriptionView.varianceAbs < 0 ? '#E53E3E' : subscriptionView.varianceAbs > 0 ? '#1A9E5C' : 'text.primary', fontVariantNumeric: 'tabular-nums' }}>
                          {subscriptionView.varianceAbs > 0 ? '+' : ''}{USD0.format(subscriptionView.varianceAbs)}
                        </Typography>
                        <Typography variant="h6" sx={{ fontWeight: 500, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                          {fmtPct(subscriptionView.variancePct)}
                        </Typography>
                      </Stack>
                    </Box>
                    <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'right' }}>
                      {subscriptionView.postedSubs.toLocaleString()} subs billed · {subscriptionView.overdueSubs.toLocaleString()} overdue
                      <br />
                      <Box component="span" sx={{ fontSize: 11 }}>Click any card to filter the table</Box>
                    </Typography>
                  </Stack>
                  <Grid container spacing={1.5}>
                    <VarianceCard label="New" count={subscriptionView.counts.new_sub} sum={subscriptionView.sums.new_sub} variance={subscriptionView.varianceAbs} accent="#2C73FF" active={activeCategories.has('new_sub')} onClick={() => toggleCategory('new_sub')} />
                    <VarianceCard label="Reactivated" count={subscriptionView.counts.reactivated} sum={subscriptionView.sums.reactivated} variance={subscriptionView.varianceAbs} accent="#9F7AEA" active={activeCategories.has('reactivated')} onClick={() => toggleCategory('reactivated')} />
                    <VarianceCard label="Reconnected" count={subscriptionView.counts.reconnected} sum={subscriptionView.sums.reconnected} variance={subscriptionView.varianceAbs} accent="#14B8A6" active={activeCategories.has('reconnected')} onClick={() => toggleCategory('reconnected')} />
                    <VarianceCard label="Expansion" count={subscriptionView.counts.expanded} sum={subscriptionView.sums.expanded} variance={subscriptionView.varianceAbs} accent="#1A9E5C" active={activeCategories.has('expanded')} onClick={() => toggleCategory('expanded')} />
                    <VarianceCard label="Contraction" count={subscriptionView.counts.contracted} sum={subscriptionView.sums.contracted} variance={subscriptionView.varianceAbs} accent="#E53E3E" active={activeCategories.has('contracted')} onClick={() => toggleCategory('contracted')} />
                    <VarianceCard label="Overdue" count={subscriptionView.counts.overdue} sum={subscriptionView.sums.overdue} variance={subscriptionView.varianceAbs} accent="#F5A623" active={activeCategories.has('overdue')} onClick={() => toggleCategory('overdue')} />
                    <VarianceCard label="Cancelled" count={subscriptionView.counts.cancelled} sum={subscriptionView.sums.cancelled} variance={subscriptionView.varianceAbs} accent="#8B949E" active={activeCategories.has('cancelled')} onClick={() => toggleCategory('cancelled')} />
                  </Grid>
                </Box>

                {/* Per-subscription table — when 2+ chips are active, rows are grouped by category.
                    Each row represents one subscription; a customer with multiple subs has
                    multiple rows. */}
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Customer</TableCell>
                      <TableCell>Subscription</TableCell>
                      <TableCell>Category</TableCell>
                      <TableCell align="right">Prior $</TableCell>
                      <TableCell align="right">Current $</TableCell>
                      <TableCell align="right">Δ</TableCell>
                      <TableCell>Notes</TableCell>
                      <TableCell align="right">Stripe</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(() => {
                      const visibleRows = subscriptionView.detail.filter((r) => activeCategories.has(r.category));
                      if (visibleRows.length === 0) {
                        return (
                          <TableRow>
                            <TableCell colSpan={8} sx={{ color: 'text.secondary', textAlign: 'center', py: 3 }}>
                              {activeCategories.size === 0
                                ? 'No filters active. Click a chip above to show rows.'
                                : 'No rows match the active filters.'}
                            </TableCell>
                          </TableRow>
                        );
                      }

                      const renderRow = (r: typeof visibleRows[number]) => {
                        const deltaColor = r.delta < 0 ? '#E53E3E' : r.delta > 0 ? '#1A9E5C' : '#8B949E';
                        const sign = r.delta > 0 ? '+' : '';
                        const stripeId = r.stripeIds[0];
                        return (
                          <TableRow key={`row-${r.rowKey}`}>
                            <TableCell>
                              <CustomerLink id={r.customerId} name={r.customerName} />
                            </TableCell>
                            <TableCell sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{r.subLabel}</TableCell>
                            <TableCell>
                              <Chip label={categoryLabel(r.category)} size="small" color={categoryChipColor(r.category)} variant="outlined" />
                            </TableCell>
                            <TableCell align="right">{r.priorAmount > 0 ? USD0.format(r.priorAmount) : '—'}</TableCell>
                            <TableCell align="right">{r.currentAmount > 0 ? USD0.format(r.currentAmount) : '—'}</TableCell>
                            <TableCell align="right" sx={{ color: deltaColor, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                              {sign}{USD0.format(r.delta)}
                            </TableCell>
                            <TableCell sx={{ color: 'text.secondary' }}>
                              {r.category === 'overdue' && r.expectedByDay != null
                                ? `expected day ${r.expectedByDay} · ${r.daysOverdue}d overdue`
                                : ''}
                            </TableCell>
                            <TableCell align="right">
                              {stripeId ? (
                                <Link
                                  href={`https://dashboard.stripe.com/customers/${stripeId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  underline="hover"
                                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 12 }}
                                >
                                  Open
                                  <OpenInNewIcon sx={{ fontSize: 14 }} />
                                </Link>
                              ) : (
                                <Typography variant="caption" sx={{ color: 'text.secondary' }}>—</Typography>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      };

                      // Single chip → flat list, already sorted by delta ascending.
                      if (activeCategories.size <= 1) {
                        return visibleRows.map(renderRow);
                      }

                      // Multi-chip → group by category, in chip-strip order:
                      // New logos → Reactivated → Expanded → Contracted → Overdue.
                      // Headers span the full row with a left accent stripe so they
                      // can't be mistaken for data rows.
                      const groupOrder: VarianceCategory[] = ['new_sub', 'reactivated', 'reconnected', 'expanded', 'contracted', 'overdue', 'cancelled'];
                      const accentColors: Record<VarianceCategory, string> = {
                        new_sub: '#2C73FF',
                        reactivated: '#9F7AEA',
                        reconnected: '#14B8A6',
                        expanded: '#1A9E5C',
                        contracted: '#E53E3E',
                        overdue: '#F5A623',
                        cancelled: '#8B949E',
                      };
                      const elements: React.ReactNode[] = [];
                      for (const cat of groupOrder) {
                        if (!activeCategories.has(cat)) continue;
                        const rows = visibleRows.filter((r) => r.category === cat);
                        if (rows.length === 0) continue;
                        const sum = rows.reduce((s, r) => s + r.delta, 0);
                        const sign = sum > 0 ? '+' : '';
                        elements.push(
                          <TableRow
                            key={`hdr-${cat}`}
                            sx={{
                              bgcolor: 'rgba(255,255,255,0.06)',
                              '& > td': { borderBottom: 'none' },
                            }}
                          >
                            <TableCell
                              colSpan={8}
                              sx={{
                                py: 1.25,
                                borderLeft: `3px solid ${accentColors[cat]}`,
                                pl: 2,
                              }}
                            >
                              <Stack direction="row" justifyContent="space-between" alignItems="center">
                                <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, fontSize: 11, color: 'text.primary' }}>
                                  {categoryLabel(cat)} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 500 }}>· {rows.length} {rows.length === 1 ? 'subscription' : 'subscriptions'}</Box>
                                </Typography>
                                <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 11, color: 'text.primary' }}>
                                  {sign}{USD0.format(sum)}
                                </Typography>
                              </Stack>
                            </TableCell>
                          </TableRow>
                        );
                        for (const r of rows) elements.push(renderRow(r));
                      }
                      return elements;
                    })()}
                  </TableBody>
                </Table>
              </>
            )}
            </Collapse>
          </Paper>
        </Grid>

        {subscriptionView && subscriptionView.upcoming.length > 0 && (
          <Grid item xs={12}>
            <Paper sx={{ p: 2.5 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 0.5 }} flexWrap="wrap" gap={1}>
                <Typography variant="h6">Upcoming expected subscription payments</Typography>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                  {USD0.format(subscriptionView.expectedDollars)} from {subscriptionView.expectedSubs}
                </Typography>
              </Stack>
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                The subscriptions that billed in {monthLabel(view.prior)} but haven't billed yet this month and whose billing day hasn't arrived — the
                line items behind the <em>"{USD0.format(subscriptionView.expectedDollars)} expected from {subscriptionView.expectedSubs}"</em> in Subscription MRR above.
                Active accounts only — paused, at-risk, non-payment, and cancelled subscriptions are excluded (they don't count toward the projection).
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Customer</TableCell>
                    <TableCell align="right">Expected amount</TableCell>
                    <TableCell align="center">Bills on</TableCell>
                    <TableCell align="right">Last billed</TableCell>
                    <TableCell>Notes</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {subscriptionView.upcoming.map((u) => {
                    const inDays = u.expectedDay - view.elapsed;
                    return (
                      <TableRow key={u.rowKey} hover>
                        <TableCell>
                          <CustomerLink id={u.customerId} name={u.customerName} />
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(u.amount)}</TableCell>
                        <TableCell align="center" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                          day {u.expectedDay}
                          <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75 }}>
                            {inDays > 0 ? `(in ${inDays}d)` : '(due)'}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{u.lastBilledMonth}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                            {u.attempting && <Chip size="small" color="warning" variant="outlined" label="Stripe attempting" />}
                            {u.payStatus && u.payStatus !== 'Active' && <Chip size="small" variant="outlined" label={u.payStatus} />}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow sx={{ '& > td': { borderBottom: 'none', fontWeight: 700, pt: 1.5 } }}>
                    <TableCell>Total expected</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(subscriptionView.expectedDollars)}</TableCell>
                    <TableCell colSpan={3} sx={{ color: 'text.secondary', fontWeight: 500 }}>
                      {subscriptionView.expectedSubs} subscription{subscriptionView.expectedSubs === 1 ? '' : 's'} still expected this month
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </Paper>
          </Grid>
        )}

      </Grid>
    </Box>
  );
}

type CategoryKey = 'overdue' | 'cancelled' | 'contracted' | 'expanded' | 'new_sub' | 'reactivated' | 'reconnected';
type ChipColor = 'warning' | 'error' | 'success' | 'info' | 'secondary' | 'primary' | 'default';
function categoryLabel(c: CategoryKey): string {
  switch (c) {
    case 'overdue': return 'Overdue';
    case 'cancelled': return 'Cancelled';
    case 'contracted': return 'Contraction';
    case 'expanded': return 'Expansion';
    case 'new_sub': return 'New';
    case 'reactivated': return 'Reactivated';
    case 'reconnected': return 'Reconnected';
  }
}
function categoryChipColor(c: CategoryKey): ChipColor {
  switch (c) {
    case 'overdue': return 'warning';
    case 'cancelled': return 'default';
    case 'contracted': return 'error';
    case 'expanded': return 'success';
    case 'new_sub': return 'info';
    case 'reactivated': return 'secondary';
    case 'reconnected': return 'primary';
  }
}
function VarianceCard({
  label, count, sum, variance, accent, active, onClick,
}: {
  label: string;
  count: number;
  sum: number;
  variance: number;
  accent: string;
  active: boolean;
  onClick: () => void;
}) {
  const sign = sum > 0 ? '+' : '';
  // Share of *absolute total variance*: how much of the gross movement does this
  // category represent? Useful when the variance is small but one category is
  // doing all the work (e.g., new logos +$10K offset by churn -$10K).
  const grossTotal = Math.abs(variance);
  const shareOfTotal = grossTotal > 0 ? Math.abs(sum) / grossTotal : 0;
  const sumColor = sum < 0 ? '#E53E3E' : sum > 0 ? '#1A9E5C' : 'text.secondary';
  return (
    <Grid item xs={6} sm={4} md={2.4}>
      <Box
        onClick={onClick}
        role="button"
        aria-pressed={active}
        sx={{
          p: 1.5,
          borderRadius: 1,
          cursor: 'pointer',
          border: '1px solid',
          borderLeft: `3px solid ${accent}`,
          borderColor: active ? accent : 'rgba(255,255,255,0.1)',
          bgcolor: active ? `${accent}1F` : 'rgba(255,255,255,0.02)',
          transition: 'all 120ms ease',
          opacity: count === 0 ? 0.45 : 1,
          '&:hover': { bgcolor: active ? `${accent}26` : 'rgba(255,255,255,0.05)', borderColor: accent },
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5, fontWeight: 600 }}>
            {label}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
            {count}
          </Typography>
        </Stack>
        <Typography variant="h6" sx={{ fontWeight: 600, color: sumColor, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
          {count === 0 ? '—' : `${sign}${USD0.format(sum)}`}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10.5, mt: 0.25 }}>
          {count === 0 ? 'no rows' : `${count} ${count === 1 ? 'sub' : 'subs'} · ${(shareOfTotal * 100).toFixed(0)}% of |Δ|`}
        </Typography>
      </Box>
    </Grid>
  );
}

function KPICard({
  label, value, valueHint, sub, delta, deltaLabel, projectionCaveat, info,
}: {
  label: string;
  value: string;
  valueHint?: string;
  sub: string;
  delta?: number | null;
  deltaLabel?: string;
  projectionCaveat?: string;
  info?: React.ReactNode;
}) {
  const deltaColor = delta == null ? 'text.secondary' : delta >= 0 ? 'success.main' : 'error.main';
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label}
        </Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      <Typography variant="h4" sx={{ fontWeight: 500, mb: valueHint ? 0 : 0.5 }}>{value}</Typography>
      {valueHint && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5, fontStyle: 'italic' }}>
          {valueHint}
        </Typography>
      )}
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>{sub}</Typography>
      {projectionCaveat && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5, fontStyle: 'italic' }}>
          based on {projectionCaveat}
        </Typography>
      )}
      {delta != null && deltaLabel && (
        <Typography variant="caption" sx={{ color: deltaColor }}>
          {fmtPct(delta)} {deltaLabel}
        </Typography>
      )}
    </Paper>
  );
}
