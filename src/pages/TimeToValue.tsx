import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type TtvCustomer = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_company_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  primary_segment: string | null;
  sub_segment: string | null;
  first_payment_date: string | null;
  months_paying: number | null;
  years_with_us: number | null;
  current_subscription_mrr: number;
  lifetime_subscription: number;
  is_launched: boolean;
  live_date: number | null;
  months_to_launch: number | null;
  lifetime_orders: number;
  monthly_avg_current_year: number;
  monthly_avg_prior_year: number;
  category: 'gym_member' | 'never_launched_some_orders' | 'launched_dormant' | 'declining' | 'healthy' | 'bid_only' | 'no_data' | 'unknown';
  waste_label: string;
  wasted_to_date: number;
  current_burn_annualized: number;
  has_order_data: boolean;
  is_bid_only?: boolean;
};

type Snapshot = {
  fetched_at: string;
  as_of_year: number;
  cohort_size: number;
  summary: {
    total_wasted_to_date: number;
    total_annualized_burn_at_risk: number;
    gym_member_count: number;
    launched_dormant_count: number;
    declining_count: number;
    healthy_count: number;
  };
  ttv_distribution: {
    sample_size: number;
    median_months: number | null;
    p90_months: number | null;
    buckets: Record<string, number>;
  };
  by_category: Record<string, { label: string; count: number; current_mrr_sum: number; wasted_to_date_sum: number; annualized_burn_sum: number }>;
  customers: TtvCustomer[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const CATEGORY_COLOR: Record<TtvCustomer['category'], string> = {
  gym_member: '#D63A4D',
  never_launched_some_orders: '#E67E22',
  launched_dormant: '#F5A623',
  declining: '#F5A623',
  healthy: '#1A9E5C',
  bid_only: '#2C73FF',
  no_data: '#94a3b8',
  unknown: '#94a3b8',
};

const CATEGORY_LABEL: Record<TtvCustomer['category'], string> = {
  gym_member: 'Gym Member',
  never_launched_some_orders: 'Hygiene Gap',
  launched_dormant: 'Dormant',
  declining: 'Declining',
  healthy: 'Healthy',
  bid_only: 'Bid-only',
  no_data: 'No Order Data',
  unknown: 'Unknown',
};

const BID_ONLY_STORAGE_KEY = 'allmoxy.bid_only.pending';
function readBidOnlyOverrides(): Record<string, boolean> {
  try { const raw = localStorage.getItem(BID_ONLY_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

export default function TimeToValue() {
  const { data, isLoading, error } = useSheetTab('time_to_value');
  const rawSnap = data as unknown as Snapshot | undefined;

  // Live bid-only overrides from localStorage — polled so changes from the
  // Customer Detail toggle reflect instantly.
  const [bidOnlyOverrides, setBidOnlyOverrides] = useState<Record<string, boolean>>(() => readBidOnlyOverrides());
  useEffect(() => {
    const reload = () => setBidOnlyOverrides(readBidOnlyOverrides());
    window.addEventListener('storage', reload);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(t); };
  }, []);

  // Re-derive snap with localStorage overrides applied.
  // Bid-only override: category → 'bid_only', waste_label cleared.
  const snap = useMemo<Snapshot | undefined>(() => {
    if (!rawSnap) return undefined;
    const customers = rawSnap.customers.map((c) => {
      const aidKey = String(c.allmoxy_customer_id);
      const localOverride = bidOnlyOverrides[aidKey];
      if (localOverride === undefined) return c;
      const wasBidOnly = c.category === 'bid_only';
      if (localOverride === wasBidOnly) return c; // no change
      if (localOverride) {
        return {
          ...c,
          category: 'bid_only' as const,
          waste_label: 'Bid-only customer (live override) — uses Allmoxy primarily for quotes/bids that never verify as orders.',
          wasted_to_date: 0,
          is_bid_only: true,
        };
      }
      // Turning bid-only OFF — flip back to healthy-ish (can't perfectly recompute, default to healthy)
      return {
        ...c,
        category: 'healthy' as const,
        waste_label: 'Bid-only flag removed (live override) — health to recompute on next refresh.',
        is_bid_only: false,
      };
    });
    // Rebuild category buckets + summary
    const by_category: Snapshot['by_category'] = { ...rawSnap.by_category };
    for (const key of Object.keys(by_category)) {
      by_category[key] = { ...by_category[key], count: 0, current_mrr_sum: 0, wasted_to_date_sum: 0, annualized_burn_sum: 0 };
    }
    for (const c of customers) {
      const b = by_category[c.category];
      if (!b) continue;
      b.count++;
      b.current_mrr_sum += c.current_subscription_mrr;
      b.wasted_to_date_sum += c.wasted_to_date;
      b.annualized_burn_sum += c.current_burn_annualized;
    }
    const summary = {
      ...rawSnap.summary,
      total_wasted_to_date: customers.reduce((s, c) => s + c.wasted_to_date, 0),
      total_annualized_burn_at_risk: customers.filter((c) => c.category !== 'healthy' && c.category !== 'bid_only').reduce((s, c) => s + c.current_burn_annualized, 0),
      gym_member_count: customers.filter((c) => c.category === 'gym_member').length,
      launched_dormant_count: customers.filter((c) => c.category === 'launched_dormant').length,
      declining_count: customers.filter((c) => c.category === 'declining').length,
      healthy_count: customers.filter((c) => c.category === 'healthy').length,
    };
    return { ...rawSnap, customers, by_category, summary };
  }, [rawSnap, bidOnlyOverrides]);

  const [filter, setFilter] = useState<'all' | 'at_risk' | TtvCustomer['category']>('at_risk');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');

  const ownerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of snap?.customers ?? []) {
      const key = c.owner_name || '(unassigned)';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [snap]);

  // Owner-filtered snapshot — re-rolls every KPI/by-category/category-toggle
  // metric from the owner's slice. When ownerFilter === 'all', uses snap as-is.
  const viewSnap = useMemo(() => {
    if (!snap || ownerFilter === 'all') return snap;
    const customers = snap.customers.filter((c) => (c.owner_name || '(unassigned)') === ownerFilter);
    // Rebuild by_category from the filtered set
    const by_category: Snapshot['by_category'] = { ...snap.by_category };
    for (const key of Object.keys(by_category)) {
      by_category[key] = { ...by_category[key], count: 0, current_mrr_sum: 0, wasted_to_date_sum: 0, annualized_burn_sum: 0 };
    }
    for (const c of customers) {
      const b = by_category[c.category];
      if (!b) continue;
      b.count++;
      b.current_mrr_sum += c.current_subscription_mrr || 0;
      b.wasted_to_date_sum += c.wasted_to_date || 0;
      b.annualized_burn_sum += c.current_burn_annualized || 0;
    }
    // Rebuild summary
    const summary: Snapshot['summary'] = {
      total_wasted_to_date: customers.reduce((s, c) => s + (c.wasted_to_date || 0), 0),
      total_annualized_burn_at_risk: customers.filter((c) => c.category !== 'healthy' && c.category !== 'bid_only').reduce((s, c) => s + (c.current_burn_annualized || 0), 0),
      gym_member_count: customers.filter((c) => c.category === 'gym_member').length,
      launched_dormant_count: customers.filter((c) => c.category === 'launched_dormant').length,
      declining_count: customers.filter((c) => c.category === 'declining').length,
      healthy_count: customers.filter((c) => c.category === 'healthy').length,
    };
    // Rebuild TTV distribution from this owner's launched customers
    const ttvSamples = customers
      .filter((c) => c.is_launched && c.months_to_launch != null && c.months_to_launch >= 0)
      .map((c) => c.months_to_launch as number)
      .sort((a, b) => a - b);
    const pickPct = (arr: number[], p: number) => arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
    const median = ttvSamples.length === 0
      ? null
      : ttvSamples.length % 2 === 1
        ? ttvSamples[Math.floor(ttvSamples.length / 2)]
        : Math.round((ttvSamples[ttvSamples.length / 2 - 1] + ttvSamples[ttvSamples.length / 2]) / 2);
    const buckets: Record<string, number> = {};
    for (const k of Object.keys(snap.ttv_distribution.buckets)) buckets[k] = 0;
    for (const m of ttvSamples) {
      let key: string;
      if (m <= 3) key = '0-3';
      else if (m <= 6) key = '4-6';
      else if (m <= 12) key = '7-12';
      else if (m <= 18) key = '13-18';
      else if (m <= 24) key = '19-24';
      else key = '25+';
      if (key in buckets) buckets[key]++;
      else buckets[key] = (buckets[key] ?? 0) + 1;
    }
    const ttv_distribution: Snapshot['ttv_distribution'] = {
      sample_size: ttvSamples.length,
      median_months: median,
      p90_months: pickPct(ttvSamples, 0.9),
      buckets,
    };
    return { ...snap, customers, by_category, summary, cohort_size: customers.length, ttv_distribution };
  }, [snap, ownerFilter]);

  const filtered = useMemo(() => {
    let rows = snap?.customers ?? [];
    if (filter === 'all') {/* no-op */}
    else if (filter === 'at_risk') rows = rows.filter((c) => c.category !== 'healthy' && c.category !== 'no_data');
    else rows = rows.filter((c) => c.category === filter);
    if (ownerFilter !== 'all') {
      rows = rows.filter((c) => (c.owner_name || '(unassigned)') === ownerFilter);
    }
    return rows;
  }, [snap, filter, ownerFilter]);

  const ttvChart = useMemo(() => {
    const buckets = viewSnap?.ttv_distribution.buckets ?? {};
    return Object.entries(buckets).map(([range, count]) => ({ range, count }));
  }, [viewSnap]);

  return (
    <Box>
      <PageHeader
        title="Time to Value"
        subtitle="Are paying customers getting actual product value? Cohort = all paying customers (active + at-risk, lifetime > $0). Driven by verified order data — orders flowing through Allmoxy = value realized, regardless of MRR collected. The headline numbers tell you how much $ is going to customers who aren't (yet) getting value."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load time_to_value: {String(error)}</Alert>}

      {/* Headline KPIs — with monthly $ for each cohort the tile measures */}
      {(() => {
        // Helper: sum MRR for customers in given categories (owner-filtered).
        const sumMrr = (cats: string[]) => (viewSnap?.customers ?? [])
          .filter((c) => cats.includes(c.category))
          .reduce((s, c) => s + (c.current_subscription_mrr || 0), 0);
        const wastedMonthlyMrr = sumMrr(['gym_member', 'never_launched_some_orders', 'launched_dormant', 'declining']);
        const burnMonthlyMrr = wastedMonthlyMrr; // same cohort as annual burn / 12
        const healthyMonthlyMrr = sumMrr(['healthy', 'bid_only']);
        return (
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5, borderLeft: '3px solid', borderColor: 'error.main' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>$ Paid without value</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500, color: 'error.main' }}>{USD0.format(viewSnap?.summary.total_wasted_to_date ?? 0)}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Cumulative paid by customers not getting value</Typography>
                    <Typography variant="caption" sx={{ color: 'error.main', fontWeight: 600, display: 'block', mt: 0.25 }}>
                      {USD0.format(wastedMonthlyMrr)}/mo continuing
                    </Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5, borderLeft: '3px solid', borderColor: 'warning.main' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Annualized Burn at risk</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500, color: 'warning.main' }}>{USD0.format(viewSnap?.summary.total_annualized_burn_at_risk ?? 0)}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>If non-healthy customers don't realize value in next 12mo</Typography>
                    <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 600, display: 'block', mt: 0.25 }}>
                      {USD0.format(burnMonthlyMrr)}/mo at risk
                    </Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Median time to value</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500 }}>{viewSnap?.ttv_distribution.median_months ?? '—'} mo</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>p90: {viewSnap?.ttv_distribution.p90_months ?? '—'} mo · {viewSnap?.ttv_distribution.sample_size ?? 0} launched</Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5, borderLeft: '3px solid', borderColor: 'success.main' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Healthy</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500, color: 'success.main' }}>{viewSnap?.summary.healthy_count ?? 0}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>of {viewSnap?.cohort_size ?? 0} {ownerFilter === 'all' ? 'paying customers' : `${ownerFilter}'s customers`}</Typography>
                    <Typography variant="caption" sx={{ color: 'success.main', fontWeight: 600, display: 'block', mt: 0.25 }}>
                      {USD0.format(healthyMonthlyMrr)}/mo realized
                    </Typography>
                  </>
                )}
              </Paper>
            </Grid>
          </Grid>
        );
      })()}

      {/* Category breakdown */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>By Category</Typography>
          <InfoIcon info={
            <>
              <strong>Gym Member:</strong> never launched, never ran a verified order. Highest concern.<br />
              <strong>Hygiene Gap:</strong> has lifetime orders but no Live Date marked in the orders xlsx. Likely a data-cleanliness issue (they ARE live, just not flagged). Fix the xlsx.<br />
              <strong>Dormant:</strong> Live Date present but zero orders in {snap?.as_of_year ?? 'current year'} YTD. Real churn risk.<br />
              <strong>Declining:</strong> orders down &gt;50% year-over-year (monthly avg basis).<br />
              <strong>Healthy:</strong> launched, running orders, not declining.
            </>
          } />
        </Stack>
        {(() => {
          const cats = Object.entries(viewSnap?.by_category ?? {}).filter(([, b]) => b.count > 0);
          const totalCount = cats.reduce((s, [, b]) => s + b.count, 0);
          const totalMrr = cats.reduce((s, [, b]) => s + b.current_mrr_sum, 0);
          const fmtPct = (v: number, total: number) => total > 0 ? ((v / total) * 100).toFixed(1) + '%' : '—';
          return (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Category</TableCell>
                  <TableCell align="right">Customers</TableCell>
                  <TableCell align="right">% of total</TableCell>
                  <TableCell align="right">Current MRR</TableCell>
                  <TableCell align="right">% of MRR</TableCell>
                  <TableCell align="right">$ Wasted to Date</TableCell>
                  <TableCell align="right">Annualized Burn</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {cats.map(([key, b]) => {
                  const color = CATEGORY_COLOR[key as TtvCustomer['category']] ?? '#94a3b8';
                  return (
                    <TableRow key={key} hover sx={{ cursor: 'pointer' }} onClick={() => setFilter(key as TtvCustomer['category'])}>
                      <TableCell>
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: color, display: 'inline-block', mr: 1 }} />
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>{b.label}</Typography>
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{b.count}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary', fontSize: 11 }}>{fmtPct(b.count, totalCount)}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(b.current_mrr_sum)}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary', fontSize: 11 }}>{fmtPct(b.current_mrr_sum, totalMrr)}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: b.wasted_to_date_sum > 0 ? 'error.main' : 'text.secondary' }}>{USD0.format(b.wasted_to_date_sum)}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: b.annualized_burn_sum > 0 && key !== 'healthy' && key !== 'bid_only' ? 'warning.main' : 'text.secondary' }}>{USD0.format(b.annualized_burn_sum)}</TableCell>
                    </TableRow>
                  );
                })}
                {/* Totals row */}
                <TableRow sx={{ '& td': { fontWeight: 700, borderTop: '2px solid', borderColor: 'divider' } }}>
                  <TableCell>Total</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{totalCount}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>100.0%</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(totalMrr)}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>100.0%</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'error.main' }}>{USD0.format(cats.reduce((s, [, b]) => s + b.wasted_to_date_sum, 0))}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'warning.main' }}>{USD0.format(cats.filter(([k]) => k !== 'healthy' && k !== 'bid_only').reduce((s, [, b]) => s + b.annualized_burn_sum, 0))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          );
        })()}
      </Paper>

      {/* TTV histogram */}
      {(viewSnap?.ttv_distribution.sample_size ?? 0) > 0 && (
        <Paper sx={{ p: 3, mb: 3 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Time to Value Distribution</Typography>
            <InfoIcon info={`Months between first payment and Live Date for ${viewSnap?.ttv_distribution.sample_size} successfully launched customers${ownerFilter === 'all' ? '' : ` (${ownerFilter}'s book)`}. The shape tells you what 'normal' onboarding looks like — customers exceeding the p90 (${viewSnap?.ttv_distribution.p90_months} months) are clear outliers.`} />
          </Stack>
          <Box sx={{ height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={ttvChart} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid stroke="rgba(0,0,0,0.06)" />
                <XAxis dataKey="range" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <RTooltip />
                <Bar dataKey="count" fill="#2C73FF" />
              </BarChart>
            </ResponsiveContainer>
          </Box>
          <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
            Median: <strong>{viewSnap?.ttv_distribution.median_months} months</strong> · p90: <strong>{viewSnap?.ttv_distribution.p90_months} months</strong>. Treat customers paying for &gt; {viewSnap?.ttv_distribution.p90_months} months without launching as outlier risk.
          </Typography>
        </Paper>
      )}

      {/* Filter + attack list */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="all">All ({viewSnap?.customers?.length ?? 0})</ToggleButton>
          <ToggleButton value="at_risk">At risk ({(viewSnap?.customers?.length ?? 0) - (viewSnap?.summary.healthy_count ?? 0) - ((viewSnap?.by_category.no_data?.count ?? 0))})</ToggleButton>
          {(viewSnap?.by_category.gym_member?.count ?? 0) > 0 && <ToggleButton value="gym_member">Gym ({viewSnap!.by_category.gym_member.count})</ToggleButton>}
          {(viewSnap?.by_category.never_launched_some_orders?.count ?? 0) > 0 && <ToggleButton value="never_launched_some_orders">Hygiene ({viewSnap!.by_category.never_launched_some_orders.count})</ToggleButton>}
          {(viewSnap?.by_category.launched_dormant?.count ?? 0) > 0 && <ToggleButton value="launched_dormant">Dormant ({viewSnap!.by_category.launched_dormant.count})</ToggleButton>}
          {(viewSnap?.by_category.declining?.count ?? 0) > 0 && <ToggleButton value="declining">Declining ({viewSnap!.by_category.declining.count})</ToggleButton>}
          {(viewSnap?.by_category.healthy?.count ?? 0) > 0 && <ToggleButton value="healthy">Healthy ({viewSnap!.by_category.healthy.count})</ToggleButton>}
        </ToggleButtonGroup>

        {ownerCounts.length > 0 && (
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5 }}>Owner</Typography>
            <Chip
              label={`All (${snap?.customers?.length ?? 0})`}
              size="small"
              variant={ownerFilter === 'all' ? 'filled' : 'outlined'}
              onClick={() => setOwnerFilter('all')}
              sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
            />
            {ownerCounts.map((o) => {
              const isActive = ownerFilter === o.name;
              return (
                <Chip
                  key={o.name}
                  label={`${o.name} (${o.count})`}
                  size="small"
                  variant={isActive ? 'filled' : 'outlined'}
                  onClick={() => setOwnerFilter(isActive ? 'all' : o.name)}
                  sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
                />
              );
            })}
          </Stack>
        )}

        <Box sx={{ flexGrow: 1 }} />
        <CsvExportButton
          filename={`time_to_value_${new Date().toISOString().slice(0, 10)}`}
          columns={[
            { key: 'allmoxy_customer_id', label: 'Allmoxy ID' },
            { key: 'name', label: 'Customer' },
            { key: 'owner_name', label: 'Owner' },
            { key: 'category', label: 'Category' },
            { key: 'current_subscription_mrr', label: 'Current MRR' },
            { key: 'wasted_to_date', label: '$ Paid w/o Value' },
            { key: 'current_burn_annualized', label: 'Annual Burn' },
            { key: 'lifetime_subscription', label: 'Lifetime $' },
            { key: 'years_with_us', label: 'Tenure (yrs)' },
            { key: 'months_paying', label: 'Months Paying' },
            { key: 'months_to_launch', label: 'Months to Launch' },
            { key: 'live_date', label: 'Live Date Year' },
            { key: 'is_launched', label: 'Is Launched' },
            { key: 'lifetime_orders', label: 'Lifetime Orders' },
            { key: 'monthly_avg_current_year', label: '2026 Monthly Avg $' },
            { key: 'monthly_avg_prior_year', label: '2025 Monthly Avg $' },
            { key: 'primary_segment', label: 'Primary Segment' },
            { key: 'waste_label', label: 'Detail' },
            { key: 'hubspot_company_id', label: 'HubSpot ID' },
          ]}
          rows={filtered as unknown as Array<Record<string, unknown>>}
          label="Export CSV"
        />
      </Stack>

      <Paper sx={{ p: 0 }}>
        {isLoading ? (
          <Skeleton variant="rectangular" height={400} />
        ) : filtered.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>No customers in this category.</Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Category</TableCell>
                <TableCell>Customer</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell align="right">MRR</TableCell>
                <TableCell align="right">$ Wasted</TableCell>
                <TableCell align="right">Annual Burn</TableCell>
                <TableCell align="center">Months Paying</TableCell>
                <TableCell>Launch / Orders</TableCell>
                <TableCell>Detail</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((c) => {
                const color = CATEGORY_COLOR[c.category];
                return (
                  <TableRow key={c.allmoxy_customer_id} hover>
                    <TableCell>
                      <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: color, display: 'inline-block', mr: 1 }} />
                      <Typography variant="caption" sx={{ fontWeight: 600, color, textTransform: 'uppercase', fontSize: 10 }}>{CATEGORY_LABEL[c.category]}</Typography>
                    </TableCell>
                    <TableCell sx={{ fontWeight: 500 }}>
                      <CustomerLink id={c.allmoxy_customer_id} name={c.name} />
                      {c.primary_segment && (
                        <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontSize: 11 }}>
                          {c.primary_segment}{c.sub_segment ? ` · ${c.sub_segment}` : ''}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{c.owner_name || <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>unassigned</Typography>}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(c.current_subscription_mrr)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: c.wasted_to_date > 0 ? 'error.main' : 'text.secondary' }}>{USD0.format(c.wasted_to_date)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: c.category !== 'healthy' && c.current_burn_annualized > 0 ? 'warning.main' : 'text.secondary' }}>{USD0.format(c.current_burn_annualized)}</TableCell>
                    <TableCell align="center" sx={{ fontSize: 12 }}>
                      {c.months_paying != null ? `${c.months_paying} mo` : '—'}
                      {c.months_to_launch != null && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontSize: 10 }}>{c.months_to_launch}mo to launch</Typography>}
                    </TableCell>
                    <TableCell sx={{ fontSize: 12 }}>
                      {c.is_launched ? (
                        <Chip label={`Live ${c.live_date}`} size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(26, 158, 92, 0.15)', color: 'success.main' }} />
                      ) : (
                        <Chip label="No Live Date" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(214, 58, 77, 0.15)', color: 'error.main' }} />
                      )}
                      <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontSize: 11, mt: 0.5 }}>
                        {c.lifetime_orders} lifetime · {USD0.format(c.monthly_avg_current_year)}/mo (2026)
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ fontSize: 11, color: 'text.secondary', maxWidth: 280 }}>{c.waste_label}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Box sx={{ mt: 3, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          How this complements Churn Risk Matrix
        </Typography>
        <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>
          The <Link href="/churn-risk-matrix">Churn Risk Matrix</Link> shows the full 5-signal health picture. This page zooms into the single strongest signal — <strong>verified order volume</strong> — to surface the customers who are paying without realizing product value. Closing the "Hygiene Gap" alone (customers with orders but no Live Date marked) sharpens the rest of the dashboard. Closing the "Dormant" + "Declining" categories closes real revenue risk.
        </Typography>
      </Box>
    </Box>
  );
}
