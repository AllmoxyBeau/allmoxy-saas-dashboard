import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import TablePagination from '@mui/material/TablePagination';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';

type OrdersYear = {
  order_count: number;
  total_usd: number;
  subtotal_usd?: number;
  b2b_subtotal_usd?: number;
};
type OrdersRecord = {
  allmoxy_customer_id: number;
  name: string;
  installer_id: string | null;
  subdomain: string | null;
  years: Record<string, OrdersYear>;
  monthly_avg: Record<string, number>;
  monthly_supplement?: Record<string, number>;
  live_date: string | null;
  is_launched: boolean;
  months_to_launch: number | null;
  total_lifetime_orders: number;
  total_lifetime_usd: number;
  monthly_avg_current_year: number;
  monthly_avg_prior_year: number;
  monthly_avg_yoy_pct: number | null;
};
type OrdersSnap = { by_customer: Record<string, OrdersRecord> };

type Profile = {
  allmoxy_customer_id: number;
  hubspot_instance_name?: string | null;
  customer_name?: string | null;
  name?: string | null;
  status: string;
  pay_status: string | null;
  primary_segment: string | null;
  sub_segment: string | null;
  instance_owner_first_name: string | null;
  instance_owner: string | null;
  current_subscription_mrr: number;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

type Row = {
  aid: number;
  name: string;
  segment: string | null;
  sub_segment: string | null;
  owner: string;
  status: string;
  pay_status: string | null;
  live_date: string | null;
  months_to_launch: number | null;
  lifetime_orders: number;
  lifetime_usd: number;
  current_year_usd: number;       // YTD raw $ for current year
  current_year_annualized: number; // YTD × 12 / months_loaded
  prior_year_usd: number;          // prior full-year total
  monthly_avg_current: number;
  monthly_avg_prior: number;
  yoy_pct: number | null;
  months_loaded: number;           // how many months of current-year data exist
  current_mrr: number;
  years_by_total: Record<string, { order_count: number; total_usd: number }>;
};

type SortKey =
  | 'name' | 'segment' | 'sub_segment' | 'owner' | 'status' | 'live_date'
  | 'lifetime_orders' | 'lifetime_usd' | 'current_year_annualized' | 'prior_year_usd'
  | 'monthly_avg_current' | 'yoy_pct' | 'current_mrr';

export default function OrdersVerified() {
  const { data: ordersData, isLoading: ordersLoading, error: ordersError } = useSheetTab<OrdersSnap>('orders_verified');
  const { data: profilesData, isLoading: profilesLoading } = useSheetTab<Profile>('customer_profiles');

  const isLoading = ordersLoading || profilesLoading;

  const [search, setSearch] = useState('');
  const [segmentFilter, setSegmentFilter] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [launchedOnly, setLaunchedOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('current_year_annualized');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'name' || k === 'segment' || k === 'sub_segment' || k === 'owner' || k === 'status' || k === 'live_date' ? 'asc' : 'desc');
    }
    setPage(0);
  }

  function toggleSetItem(s: Set<string>, item: string, setter: (n: Set<string>) => void) {
    const next = new Set(s);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    setter(next);
    setPage(0);
  }

  // Build the unified row set — join orders_verified with customer_profiles by aid
  const ordersByAid = useMemo(() => {
    const raw = (ordersData as unknown as OrdersSnap | undefined)?.by_customer ?? {};
    return raw;
  }, [ordersData]);

  const profileByAid = useMemo(() => {
    const m = new Map<number, Profile>();
    for (const p of (profilesData?.rows ?? [])) m.set(p.allmoxy_customer_id, p);
    return m;
  }, [profilesData]);

  const allRows = useMemo<Row[]>(() => {
    const currentYear = new Date().getFullYear();
    const priorYear = currentYear - 1;
    const rows: Row[] = [];
    for (const ov of Object.values(ordersByAid)) {
      const profile = profileByAid.get(ov.allmoxy_customer_id);
      const monthsLoaded = Object.keys(ov.monthly_supplement || {}).length;
      const curYearTotal = ov.years?.[String(currentYear)]?.total_usd || 0;
      const priorYearTotal = ov.years?.[String(priorYear)]?.total_usd || 0;
      const annualized = monthsLoaded > 0 && monthsLoaded < 12
        ? (curYearTotal * 12) / monthsLoaded
        : curYearTotal;
      rows.push({
        aid: ov.allmoxy_customer_id,
        name: profile?.hubspot_instance_name || profile?.customer_name || profile?.name || ov.name,
        segment: profile?.primary_segment ?? null,
        sub_segment: profile?.sub_segment ?? null,
        owner: profile?.instance_owner_first_name?.trim() || profile?.instance_owner?.trim() || '',
        status: profile?.status ?? '',
        pay_status: profile?.pay_status ?? null,
        live_date: ov.live_date,
        months_to_launch: ov.months_to_launch,
        lifetime_orders: ov.total_lifetime_orders || 0,
        lifetime_usd: ov.total_lifetime_usd || 0,
        current_year_usd: curYearTotal,
        current_year_annualized: annualized,
        prior_year_usd: priorYearTotal,
        monthly_avg_current: ov.monthly_avg_current_year || 0,
        monthly_avg_prior: ov.monthly_avg_prior_year || 0,
        yoy_pct: ov.monthly_avg_yoy_pct,
        months_loaded: monthsLoaded,
        current_mrr: profile?.current_subscription_mrr || 0,
        years_by_total: ov.years || {},
      });
    }
    return rows;
  }, [ordersByAid, profileByAid]);

  // Facets for filter chips
  const facets = useMemo(() => {
    const segments = new Map<string, number>();
    const statuses = new Map<string, number>();
    for (const r of allRows) {
      if (r.segment) segments.set(r.segment, (segments.get(r.segment) ?? 0) + 1);
      if (r.status) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    }
    return {
      segments: [...segments.entries()].sort((a, b) => b[1] - a[1]),
      statuses: [...statuses.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [allRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (segmentFilter.size > 0 && !segmentFilter.has(r.segment ?? '')) return false;
      if (statusFilter.size > 0 && !statusFilter.has(r.status)) return false;
      if (launchedOnly && !r.live_date) return false;
      return true;
    });
  }, [allRows, search, segmentFilter, statusFilter, launchedOnly]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case 'name': av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); break;
        case 'segment': av = (a.segment || '').toLowerCase(); bv = (b.segment || '').toLowerCase(); break;
        case 'sub_segment': av = (a.sub_segment || '').toLowerCase(); bv = (b.sub_segment || '').toLowerCase(); break;
        case 'owner': av = (a.owner || '~').toLowerCase(); bv = (b.owner || '~').toLowerCase(); break;
        case 'status': av = a.status; bv = b.status; break;
        case 'live_date': av = a.live_date || ''; bv = b.live_date || ''; break;
        case 'lifetime_orders': av = a.lifetime_orders; bv = b.lifetime_orders; break;
        case 'lifetime_usd': av = a.lifetime_usd; bv = b.lifetime_usd; break;
        case 'current_year_annualized': av = a.current_year_annualized; bv = b.current_year_annualized; break;
        case 'prior_year_usd': av = a.prior_year_usd; bv = b.prior_year_usd; break;
        case 'monthly_avg_current': av = a.monthly_avg_current; bv = b.monthly_avg_current; break;
        case 'yoy_pct': av = a.yoy_pct ?? -999; bv = b.yoy_pct ?? -999; break;
        case 'current_mrr': av = a.current_mrr; bv = b.current_mrr; break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  const paged = useMemo(
    () => sorted.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [sorted, page, rowsPerPage]
  );

  const summary = useMemo(() => {
    const totalAnnualized = filtered.reduce((s, r) => s + r.current_year_annualized, 0);
    const totalPriorYear = filtered.reduce((s, r) => s + r.prior_year_usd, 0);
    const totalLifetime = filtered.reduce((s, r) => s + r.lifetime_usd, 0);
    const totalLifetimeOrders = filtered.reduce((s, r) => s + r.lifetime_orders, 0);
    const totalMrr = filtered.reduce((s, r) => s + r.current_mrr, 0);
    const launchedCount = filtered.filter((r) => r.live_date).length;
    const growingCount = filtered.filter((r) => r.yoy_pct != null && r.yoy_pct > 0).length;
    const decliningCount = filtered.filter((r) => r.yoy_pct != null && r.yoy_pct < 0).length;
    const yoyPct = totalPriorYear > 0
      ? (totalAnnualized - totalPriorYear) / totalPriorYear
      : null;
    return {
      count: filtered.length,
      totalAnnualized,
      totalPriorYear,
      totalLifetime,
      totalLifetimeOrders,
      totalMrr,
      launchedCount,
      growingCount,
      decliningCount,
      yoyPct,
    };
  }, [filtered]);

  // Build year-over-year chart data — aggregate each customer's per-year
  // total across the filtered set. Current year's bar shows actual YTD plus
  // a translucent "if pace continues" annualized projection on top.
  const yearlyChart = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const totals = new Map<string, { total_usd: number; orders: number; active_customers: number }>();
    for (const r of filtered) {
      for (const [year, y] of Object.entries(r.years_by_total)) {
        const orderCount = y.order_count || 0;
        const usd = y.total_usd || 0;
        if (orderCount === 0 && usd === 0) continue;
        if (!totals.has(year)) totals.set(year, { total_usd: 0, orders: 0, active_customers: 0 });
        const e = totals.get(year)!;
        e.total_usd += usd;
        e.orders += orderCount;
        e.active_customers += 1;
      }
    }
    // Compute current-year annualized projection diff for the stacked bar
    return [...totals.entries()]
      .map(([year, v]) => {
        const isCurrent = Number(year) === currentYear;
        // Find avg months loaded across filtered customers contributing to this year
        let monthsLoadedAvg = 12;
        if (isCurrent) {
          const monthsLoadedList = filtered
            .filter((r) => (r.years_by_total[year]?.total_usd || 0) > 0)
            .map((r) => r.months_loaded || 0)
            .filter((m) => m > 0);
          if (monthsLoadedList.length > 0) {
            monthsLoadedAvg = monthsLoadedList.reduce((a, b) => a + b, 0) / monthsLoadedList.length;
          }
        }
        const annualized = isCurrent && monthsLoadedAvg > 0 && monthsLoadedAvg < 12
          ? (v.total_usd * 12) / monthsLoadedAvg
          : v.total_usd;
        return {
          year,
          actual_usd: Math.round(v.total_usd * 100) / 100,
          projected_extra: Math.round(Math.max(0, annualized - v.total_usd) * 100) / 100,
          orders: v.orders,
          active_customers: v.active_customers,
          is_partial: isCurrent && monthsLoadedAvg < 12,
        };
      })
      .sort((a, b) => a.year.localeCompare(b.year));
  }, [filtered]);

  const csvColumns = useMemo(
    () => ([
      { key: 'aid', label: 'Allmoxy ID', getValue: (r: Row) => r.aid },
      { key: 'name', label: 'Customer', getValue: (r: Row) => r.name },
      { key: 'segment', label: 'Segment', getValue: (r: Row) => r.segment ?? '' },
      { key: 'sub_segment', label: 'Sub-segment', getValue: (r: Row) => r.sub_segment ?? '' },
      { key: 'owner', label: 'Owner', getValue: (r: Row) => r.owner },
      { key: 'status', label: 'Status', getValue: (r: Row) => r.status },
      { key: 'pay_status', label: 'Pay status', getValue: (r: Row) => r.pay_status ?? '' },
      { key: 'live_date', label: 'Live date', getValue: (r: Row) => r.live_date ?? '' },
      { key: 'months_to_launch', label: 'Months to launch', getValue: (r: Row) => r.months_to_launch ?? '' },
      { key: 'lifetime_orders', label: 'Lifetime orders', getValue: (r: Row) => r.lifetime_orders },
      { key: 'lifetime_usd', label: 'Lifetime invoice $', getValue: (r: Row) => r.lifetime_usd },
      { key: 'current_year_usd', label: 'YTD invoice $', getValue: (r: Row) => r.current_year_usd },
      { key: 'current_year_annualized', label: 'YTD annualized $', getValue: (r: Row) => r.current_year_annualized },
      { key: 'prior_year_usd', label: 'Prior year invoice $', getValue: (r: Row) => r.prior_year_usd },
      { key: 'monthly_avg_current', label: 'Monthly avg (current)', getValue: (r: Row) => r.monthly_avg_current },
      { key: 'monthly_avg_prior', label: 'Monthly avg (prior)', getValue: (r: Row) => r.monthly_avg_prior },
      { key: 'yoy_pct', label: 'YoY %', getValue: (r: Row) => r.yoy_pct == null ? '' : Math.round(r.yoy_pct * 100) },
      { key: 'current_mrr', label: 'Current MRR', getValue: (r: Row) => r.current_mrr },
    ]),
    []
  );

  return (
    <Box>
      <PageHeader
        title="Orders Verified"
        subtitle="Verified order volume + invoice $ for every customer with order data. Filter by segment to compare books of business. YTD column is annualized so partial-year customers compare apples-to-apples with prior full years."
        question="durable"
      />

      {ordersError && <Alert severity="error" sx={{ mb: 2 }}>Failed to load orders_verified: {String(ordersError)}</Alert>}

      {/* Metric cards — KPI tiles for the filtered customer set */}
      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Customers</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{summary.count.toLocaleString()}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{summary.launchedCount} launched · {USD0.format(summary.totalMrr)}/mo MRR</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: 'primary.main' }}>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>YTD annualized</Typography>
              <InfoIcon info="Sum of every filtered customer's current-year invoiced $ multiplied by (12 / months loaded). Apples-to-apples comparison with prior year total." />
            </Stack>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500, color: 'primary.main' }}>{USD_COMPACT.format(summary.totalAnnualized)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Prior year: {USD_COMPACT.format(summary.totalPriorYear)}</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: summary.yoyPct != null && summary.yoyPct >= 0 ? 'success.main' : 'error.main' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>YoY (cohort)</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500, color: summary.yoyPct != null && summary.yoyPct >= 0 ? 'success.main' : 'error.main' }}>
                  {summary.yoyPct == null ? '—' : `${summary.yoyPct >= 0 ? '+' : ''}${Math.round(summary.yoyPct * 100)}%`}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{summary.growingCount} growing · {summary.decliningCount} declining</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Lifetime invoiced</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD_COMPACT.format(summary.totalLifetime)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{summary.totalLifetimeOrders.toLocaleString()} orders all-time</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Export</Typography>
            <Box>
              <CsvExportButton filename="orders_verified.csv" rows={sorted} columns={csvColumns} />
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* Yearly trend chart — aggregate of filtered customers' per-year invoiced $ */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Yearly invoice $ — across {summary.count.toLocaleString()} filtered customer{summary.count === 1 ? '' : 's'}</Typography>
          <InfoIcon info={
            <>
              <strong>What it is:</strong> Aggregate invoiced $ across all customers matching the current filters, by year.<br /><br />
              <strong>Current year:</strong> the lighter top portion of the bar is the annualized projection (if YTD pace held for the full year). Line shows the count of customers active that year.<br /><br />
              <strong>Filters:</strong> change segment/status above to compare cohorts side-by-side.
            </>
          } />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={300} /> : yearlyChart.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>No verified order data for the current filter.</Typography>
        ) : (
          <Box sx={{ height: 300 }}>
            <ResponsiveContainer>
              <ComposedChart data={yearlyChart} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="year" stroke="#8B949E" fontSize={11} />
                <YAxis yAxisId="left" stroke="#8B949E" fontSize={11} width={70} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <YAxis yAxisId="right" orientation="right" stroke="#8B949E" fontSize={11} width={50} tickFormatter={(v) => Number(v).toLocaleString()} />
                <RTooltip
                  formatter={(v: number, name: string) => {
                    if (name === 'Invoiced $' || name === 'Annualized (projected)') return [USD0.format(v), name];
                    return [Number(v).toLocaleString(), name];
                  }}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                  labelStyle={{ color: '#FFFFFF' }}
                  itemStyle={{ color: '#FFFFFF' }}
                  cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: '#8B949E' }} />
                <Bar yAxisId="left" name="Invoiced $" dataKey="actual_usd" stackId="yr" fill="#2C73FF" />
                <Bar yAxisId="left" name="Annualized (projected)" dataKey="projected_extra" stackId="yr" fill="#2C73FF" fillOpacity={0.25} stroke="#2C73FF" strokeOpacity={0.4} strokeDasharray="3 3" />
                <Line yAxisId="right" name="Active customers" type="monotone" dataKey="active_customers" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3, fill: '#F59E0B' }} />
              </ComposedChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Filters */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack spacing={1.5}>
          <TextField
            size="small"
            placeholder="Search by customer name…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            InputProps={{ startAdornment: (<InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>) }}
            sx={{ maxWidth: 480 }}
          />
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5, minWidth: 70 }}>
              Segment
              <InfoIcon info="Primary segment from HubSpot. Filter is a multi-select — click a chip to add it to the active filter; click again to remove." />
            </Typography>
            {facets.segments.map(([seg, count]) => (
              <Chip
                key={seg}
                label={`${seg} (${count})`}
                size="small"
                variant={segmentFilter.has(seg) ? 'filled' : 'outlined'}
                color={segmentFilter.has(seg) ? 'primary' : 'default'}
                onClick={() => toggleSetItem(segmentFilter, seg, setSegmentFilter)}
                sx={{ height: 22, fontSize: 11 }}
              />
            ))}
            {segmentFilter.size > 0 && (
              <Chip label="clear" size="small" variant="outlined" onClick={() => setSegmentFilter(new Set())} sx={{ height: 22, fontSize: 11, color: 'text.secondary' }} />
            )}
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5, minWidth: 70 }}>Status</Typography>
            {facets.statuses.map(([st, count]) => (
              <Chip
                key={st}
                label={`${st} (${count})`}
                size="small"
                variant={statusFilter.has(st) ? 'filled' : 'outlined'}
                color={statusFilter.has(st) ? 'primary' : 'default'}
                onClick={() => toggleSetItem(statusFilter, st, setStatusFilter)}
                sx={{ height: 22, fontSize: 11 }}
              />
            ))}
            <Chip
              label={launchedOnly ? '✓ Launched only' : 'Launched only'}
              size="small"
              variant={launchedOnly ? 'filled' : 'outlined'}
              color={launchedOnly ? 'primary' : 'default'}
              onClick={() => { setLaunchedOnly(!launchedOnly); setPage(0); }}
              sx={{ height: 22, fontSize: 11, ml: 1 }}
            />
            {statusFilter.size > 0 && (
              <Chip label="clear" size="small" variant="outlined" onClick={() => setStatusFilter(new Set())} sx={{ height: 22, fontSize: 11, color: 'text.secondary' }} />
            )}
          </Stack>
        </Stack>
      </Paper>

      {/* Table */}
      <Paper sx={{ p: 0, mb: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 1400 }}>
            <TableHead>
              <TableRow>
                <SortHead label="Customer" active={sortKey === 'name'} dir={sortDir} onClick={() => toggleSort('name')} />
                <SortHead label="Segment" active={sortKey === 'segment'} dir={sortDir} onClick={() => toggleSort('segment')} />
                <SortHead label="Sub-segment" active={sortKey === 'sub_segment'} dir={sortDir} onClick={() => toggleSort('sub_segment')} />
                <SortHead label="Owner" active={sortKey === 'owner'} dir={sortDir} onClick={() => toggleSort('owner')} />
                <SortHead label="Status" active={sortKey === 'status'} dir={sortDir} onClick={() => toggleSort('status')} />
                <SortHead label="Live date" active={sortKey === 'live_date'} dir={sortDir} onClick={() => toggleSort('live_date')} />
                <SortHead label="Lifetime orders" active={sortKey === 'lifetime_orders'} dir={sortDir} onClick={() => toggleSort('lifetime_orders')} align="right" />
                <SortHead label="Lifetime $" active={sortKey === 'lifetime_usd'} dir={sortDir} onClick={() => toggleSort('lifetime_usd')} align="right" />
                <SortHead label="YTD annualized" active={sortKey === 'current_year_annualized'} dir={sortDir} onClick={() => toggleSort('current_year_annualized')} align="right" />
                <SortHead label="Prior year $" active={sortKey === 'prior_year_usd'} dir={sortDir} onClick={() => toggleSort('prior_year_usd')} align="right" />
                <SortHead label="MA current" active={sortKey === 'monthly_avg_current'} dir={sortDir} onClick={() => toggleSort('monthly_avg_current')} align="right" />
                <SortHead label="YoY" active={sortKey === 'yoy_pct'} dir={sortDir} onClick={() => toggleSort('yoy_pct')} align="right" />
                <SortHead label="MRR" active={sortKey === 'current_mrr'} dir={sortDir} onClick={() => toggleSort('current_mrr')} align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading && (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {Array.from({ length: 13 }).map((__, j) => (
                      <TableCell key={j}><Skeleton variant="text" /></TableCell>
                    ))}
                  </TableRow>
                ))
              )}
              {!isLoading && paged.length === 0 && (
                <TableRow><TableCell colSpan={13} align="center" sx={{ py: 4, color: 'text.secondary' }}>No customers match the current filters.</TableCell></TableRow>
              )}
              {!isLoading && paged.map((r) => {
                const yoyPct = r.yoy_pct == null || r.yoy_pct === -1 ? null : Math.round(r.yoy_pct * 100);
                return (
                  <TableRow key={r.aid} hover>
                    <TableCell sx={{ fontWeight: 500 }}>
                      <CustomerLink id={r.aid} name={r.name} />
                    </TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{r.segment ?? '—'}</TableCell>
                    <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>{r.sub_segment ?? '—'}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{r.owner || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{r.status}</TableCell>
                    <TableCell sx={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{r.live_date ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.lifetime_orders.toLocaleString()}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.lifetime_usd)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                      {USD0.format(r.current_year_annualized)}
                      {r.months_loaded > 0 && r.months_loaded < 12 && (
                        <Box component="span" sx={{ display: 'block', fontSize: 10, color: 'text.secondary', fontWeight: 400 }}>
                          from {USD0.format(r.current_year_usd)} YTD ({r.months_loaded}mo)
                        </Box>
                      )}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{USD0.format(r.prior_year_usd)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{USD0.format(r.monthly_avg_current)}/mo</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: yoyPct == null ? 'text.disabled' : yoyPct >= 0 ? 'success.main' : 'error.main' }}>
                      {yoyPct == null ? '—' : `${yoyPct >= 0 ? '+' : ''}${yoyPct}%`}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{USD0.format(r.current_mrr)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
        <TablePagination
          component="div"
          count={sorted.length}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(e) => { setRowsPerPage(Number(e.target.value)); setPage(0); }}
          rowsPerPageOptions={[25, 50, 100, 200]}
        />
      </Paper>
    </Box>
  );
}

function SortHead({
  label, active, dir, onClick, align,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <TableCell align={align} sx={{ fontWeight: 600, fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
      <TableSortLabel active={active} direction={dir} onClick={onClick}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
}
