import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from 'recharts';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';

// Snapshot shape — per-customer rows with month-keyed columns, plus a
// formula-driven monthlyTotals map taken from the sheet's summary row (more
// reliable than summing customer rows since the sheet sums via formula).
type CustomerMonthRow = { customer_name: string; [yearMonth: string]: string | number | null };
type ServicesByMonth = {
  rows: CustomerMonthRow[];
  monthlyTotals: Record<string, number>;
  notes?: string;
};

// Minimal slice of customer_profiles we read — just what we need to attach
// segment + aid to each services row by name match.
type Profile = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_instance_name?: string | null;
  customer_name?: string | null;
  primary_segment: string | null;
};

function normName(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

type CustomerRow = {
  name: string;
  aid: number | null;
  segment: string | null;
  ytd: number;
  ytd_annualized: number;
  prior_year: number;
  yoy_pct: number | null;
  lifetime: number;
};

type SortKey = 'name' | 'ytd' | 'ytd_annualized' | 'prior_year' | 'yoy_pct' | 'lifetime';

export default function Services() {
  const { data, isLoading: servicesLoading, error } = useSheetTab<ServicesByMonth>('services_by_month');
  const { data: profilesData, isLoading: profilesLoading } = useSheetTab<Profile>('customer_profiles');
  const isLoading = servicesLoading || profilesLoading;

  const [sortKey, setSortKey] = useState<SortKey>('ytd_annualized');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [trendRange, setTrendRange] = useState<'24m' | '48m' | 'all'>('24m');
  const [segmentFilter, setSegmentFilter] = useState<Set<string>>(new Set());

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'name' ? 'asc' : 'desc');
    }
  }

  function toggleSegment(seg: string) {
    const next = new Set(segmentFilter);
    if (next.has(seg)) next.delete(seg);
    else next.add(seg);
    setSegmentFilter(next);
  }

  // Build a name → { aid, segment } map from customer_profiles. Match by
  // normalized name (lowercase, strip non-alphanumerics) since the services
  // sheet uses display names that may differ from the profile name in
  // punctuation/whitespace. Try hubspot_instance_name first (closer to
  // services-sheet naming) and fall back to the canonical name.
  const profileByName = useMemo(() => {
    const m = new Map<string, { aid: number; segment: string | null }>();
    for (const p of (profilesData?.rows ?? []) as Profile[]) {
      const candidates = [p.hubspot_instance_name, p.customer_name, p.name].filter(Boolean) as string[];
      for (const c of candidates) {
        const k = normName(c);
        if (k && !m.has(k)) m.set(k, { aid: p.allmoxy_customer_id, segment: p.primary_segment ?? null });
      }
    }
    return m;
  }, [profilesData]);

  // Fractional months elapsed in the current calendar year, prorating the
  // partial trailing month by day-of-month. Today 2026-06-18 → 5 full months
  // (Jan-May) + 18/30 of June ≈ 5.6. Driver for every annualization on the
  // page so customer-level numbers and headline KPIs use the same divisor.
  const monthsElapsed = useMemo(() => {
    const today = new Date();
    const monthIndex = today.getMonth() + 1;
    const dom = today.getDate();
    const daysInThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    return (monthIndex - 1) + dom / daysInThisMonth;
  }, []);

  // Per-customer aggregation. Annualization uses the shared monthsElapsed so
  // every customer-level number is comparable to the filtered KPI cards.
  const customerRows = useMemo<CustomerRow[]>(() => {
    const snap = data as ServicesByMonth | undefined;
    if (!snap?.rows) return [];
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    const divisor = monthsElapsed || 1;
    const out: CustomerRow[] = [];
    for (const row of snap.rows) {
      let cy = 0, py = 0, lifetime = 0;
      for (const [k, v] of Object.entries(row)) {
        if (k === 'customer_name') continue;
        const num = Number(v) || 0;
        if (num === 0) continue;
        lifetime += num;
        const yr = k.slice(0, 4);
        if (yr === currentYearStr) cy += num;
        else if (yr === priorYearStr) py += num;
      }
      if (lifetime === 0) continue;
      const annualized = divisor > 0 && divisor < 12 ? (cy * 12) / divisor : cy;
      const yoyPct = py > 0 ? (annualized - py) / py : null;
      const profile = profileByName.get(normName(row.customer_name));
      out.push({
        name: row.customer_name,
        aid: profile?.aid ?? null,
        segment: profile?.segment ?? null,
        ytd: cy,
        ytd_annualized: annualized,
        prior_year: py,
        yoy_pct: yoyPct,
        lifetime,
      });
    }
    return out;
  }, [data, monthsElapsed, profileByName]);

  // Segment facets — count customers per segment in the unfiltered set so
  // chip counts always reflect the underlying data, not the active filter.
  const segmentFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of customerRows) {
      const seg = r.segment ?? '(no segment)';
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [customerRows]);

  // Apply segment filter before sorting/rendering.
  const filteredCustomers = useMemo(() => {
    if (segmentFilter.size === 0) return customerRows;
    return customerRows.filter((r) => segmentFilter.has(r.segment ?? '(no segment)'));
  }, [customerRows, segmentFilter]);

  // Monthly totals that drive the KPI cards + both charts. With no segment
  // filter active, use the sheet's formula-driven `monthlyTotals` (its summary
  // row is the source of truth and avoids any per-customer-row drift). With a
  // filter active, sum the rows that belong to the selected segments so the
  // headline numbers, yearly bars, and trend line all narrow together.
  const filteredMonthlyTotals = useMemo(() => {
    const snap = data as ServicesByMonth | undefined;
    if (!snap) return {} as Record<string, number>;
    if (segmentFilter.size === 0) return snap.monthlyTotals ?? {};
    const wanted = new Set(filteredCustomers.map((r) => r.name));
    const totals: Record<string, number> = {};
    // Seed every known month so the trend line keeps a continuous x-axis even
    // when the filtered cohort has zero $ in some months.
    for (const m of Object.keys(snap.monthlyTotals ?? {})) totals[m] = 0;
    for (const row of snap.rows) {
      if (!wanted.has(row.customer_name)) continue;
      for (const [k, v] of Object.entries(row)) {
        if (k === 'customer_name') continue;
        const num = Number(v) || 0;
        if (num === 0) continue;
        totals[k] = (totals[k] ?? 0) + num;
      }
    }
    return totals;
  }, [data, segmentFilter, filteredCustomers]);

  // KPI summary — derived from filteredMonthlyTotals so the cards respond to
  // the segment filter. Annualization uses the shared monthsElapsed.
  const summary = useMemo(() => {
    const mt = filteredMonthlyTotals;
    const months = Object.keys(mt).sort();
    if (months.length === 0) {
      return { latestMonth: null as string | null, latestAmount: 0, currentYear: 0, priorYear: 0, ytdAnnualized: 0, yoyPct: null as number | null, lifetime: 0 };
    }
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    let cy = 0, py = 0, lifetime = 0;
    for (const m of months) {
      const v = Number(mt[m]) || 0;
      lifetime += v;
      if (m.startsWith(currentYearStr)) cy += v;
      else if (m.startsWith(priorYearStr)) py += v;
    }
    const annualized = monthsElapsed > 0 && monthsElapsed < 12 ? (cy * 12) / monthsElapsed : cy;
    const yoyPct = py > 0 ? (annualized - py) / py : null;
    const latest = months[months.length - 1];
    return {
      latestMonth: latest,
      latestAmount: Number(mt[latest]) || 0,
      currentYear: cy,
      priorYear: py,
      ytdAnnualized: annualized,
      yoyPct,
      lifetime,
    };
  }, [filteredMonthlyTotals, monthsElapsed]);

  // Yearly chart — same monthly totals, grouped by year, with annualized
  // projection on the current year. Filter-aware.
  const yearlyChart = useMemo(() => {
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const byYear = new Map<string, { total: number; months: number }>();
    for (const [m, v] of Object.entries(filteredMonthlyTotals)) {
      const yr = m.slice(0, 4);
      const num = Number(v) || 0;
      if (!byYear.has(yr)) byYear.set(yr, { total: 0, months: 0 });
      const e = byYear.get(yr)!;
      e.total += num;
      if (num > 0) e.months++;
    }
    return [...byYear.entries()]
      .map(([year, v]) => {
        const isCurrent = year === currentYearStr && monthsElapsed > 0 && monthsElapsed < 12;
        const annualized = isCurrent ? (v.total * 12) / monthsElapsed : v.total;
        return {
          year,
          actual_usd: Math.round(v.total * 100) / 100,
          projected_extra: Math.round(Math.max(0, annualized - v.total) * 100) / 100,
          months: v.months,
          is_partial: isCurrent,
        };
      })
      .sort((a, b) => a.year.localeCompare(b.year));
  }, [filteredMonthlyTotals, monthsElapsed]);

  // Monthly trend window — filter-aware.
  const trendChart = useMemo(() => {
    const months = Object.keys(filteredMonthlyTotals).sort();
    const sliceN = trendRange === '24m' ? 24 : trendRange === '48m' ? 48 : months.length;
    return months.slice(-sliceN).map((m) => ({
      month: m,
      services: Math.round((Number(filteredMonthlyTotals[m]) || 0) * 100) / 100,
    }));
  }, [filteredMonthlyTotals, trendRange]);

  const sortedCustomers = useMemo(() => {
    const out = [...filteredCustomers];
    out.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'ytd': av = a.ytd; bv = b.ytd; break;
        case 'ytd_annualized': av = a.ytd_annualized; bv = b.ytd_annualized; break;
        case 'prior_year': av = a.prior_year; bv = b.prior_year; break;
        case 'yoy_pct': av = a.yoy_pct ?? -999; bv = b.yoy_pct ?? -999; break;
        case 'lifetime': av = a.lifetime; bv = b.lifetime; break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filteredCustomers, sortKey, sortDir]);

  const csvColumns = useMemo(
    () => ([
      { key: 'name', label: 'Customer', getValue: (r: CustomerRow) => r.name },
      { key: 'segment', label: 'Segment', getValue: (r: CustomerRow) => r.segment ?? '' },
      { key: 'ytd', label: 'YTD $', getValue: (r: CustomerRow) => r.ytd },
      { key: 'ytd_annualized', label: 'YTD annualized $', getValue: (r: CustomerRow) => r.ytd_annualized },
      { key: 'prior_year', label: 'Prior year $', getValue: (r: CustomerRow) => r.prior_year },
      { key: 'yoy_pct', label: 'YoY %', getValue: (r: CustomerRow) => r.yoy_pct == null ? '' : Math.round(r.yoy_pct * 100) },
      { key: 'lifetime', label: 'Lifetime $', getValue: (r: CustomerRow) => r.lifetime },
    ]),
    []
  );

  return (
    <Box>
      <PageHeader
        title="Services Revenue"
        subtitle="One-time / project services billed to customers. Yearly trend with annualized projection of the current year — same visualization style as Orders Verified."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load services_by_month: {String(error)}</Alert>}

      {/* KPI tiles */}
      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Latest month</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD_COMPACT.format(summary.latestAmount)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{summary.latestMonth ?? '—'}{summary.latestMonth === new Date().toISOString().slice(0, 7) ? ' (in progress)' : ''}</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: 'primary.main' }}>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>YTD annualized</Typography>
              <InfoIcon info="YTD services × 12 / months-elapsed. Months-elapsed is fractional — today's date prorates the partial trailing month so a half-finished June counts as 0.5 of a month, not a full one." />
            </Stack>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500, color: 'primary.main' }}>{USD_COMPACT.format(summary.ytdAnnualized)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{monthsElapsed.toFixed(1)}/12 months elapsed</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: summary.yoyPct != null && summary.yoyPct >= 0 ? 'success.main' : 'error.main' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>YoY (annualized)</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500, color: summary.yoyPct != null && summary.yoyPct >= 0 ? 'success.main' : 'error.main' }}>
                  {summary.yoyPct == null ? '—' : `${summary.yoyPct >= 0 ? '+' : ''}${Math.round(summary.yoyPct * 100)}%`}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Prior year: {USD_COMPACT.format(summary.priorYear)}</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Lifetime services</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD_COMPACT.format(summary.lifetime)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {filteredCustomers.length} customer{filteredCustomers.length === 1 ? '' : 's'} billed{segmentFilter.size > 0 ? ` · filtered from ${customerRows.length}` : ''}
                </Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Export</Typography>
            <Box>
              <CsvExportButton filename="services_revenue.csv" rows={sortedCustomers} columns={csvColumns} />
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* Yearly chart */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Yearly services $ — actual + annualized projection</Typography>
          <InfoIcon info={
            <>
              <strong>What it is:</strong> Total services revenue by calendar year. The lighter top portion of the current year&apos;s bar shows the annualized projection if YTD pace continues.<br /><br />
              <strong>Annualized:</strong> YTD total × (12 / months elapsed). Months elapsed is fractional — today&apos;s position in the trailing month prorates correctly, so a half-finished June doesn&apos;t over-project. Orange line shows how many distinct months in that year have data.
            </>
          } />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={320} /> : yearlyChart.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>No services revenue data available.</Typography>
        ) : (
          <Box sx={{ height: 320 }}>
            <ResponsiveContainer>
              <ComposedChart data={yearlyChart} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="year" stroke="#8B949E" fontSize={11} />
                <YAxis yAxisId="left" stroke="#8B949E" fontSize={11} width={70} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <YAxis yAxisId="right" orientation="right" stroke="#8B949E" fontSize={11} width={50} />
                <RTooltip
                  formatter={(v: number, name: string) => {
                    if (name === 'Months loaded') return [Number(v).toLocaleString(), name];
                    return [USD0.format(v), name];
                  }}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                  labelStyle={{ color: '#FFFFFF' }}
                  itemStyle={{ color: '#FFFFFF' }}
                  cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: '#8B949E' }} />
                <Bar yAxisId="left" name="Services $" dataKey="actual_usd" stackId="yr" fill="#2C73FF" />
                <Bar yAxisId="left" name="Annualized (projected)" dataKey="projected_extra" stackId="yr" fill="#2C73FF" fillOpacity={0.25} stroke="#2C73FF" strokeOpacity={0.4} strokeDasharray="3 3" />
                <Line yAxisId="right" name="Months loaded" type="monotone" dataKey="months" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3, fill: '#F59E0B' }} />
              </ComposedChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Monthly trend */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Monthly trend</Typography>
          <InfoIcon info="Monthly services revenue. Toggle the range to widen the window. Note: the latest month may be in progress and lower than full-month totals." />
          <Box sx={{ flexGrow: 1 }} />
          <ToggleButtonGroup
            value={trendRange}
            exclusive
            size="small"
            onChange={(_, v) => { if (v) setTrendRange(v); }}
            sx={{ '& .MuiToggleButton-root': { px: 1, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="24m">24 mo</ToggleButton>
            <ToggleButton value="48m">48 mo</ToggleButton>
            <ToggleButton value="all">All</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={220} /> : trendChart.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>No data.</Typography>
        ) : (
          <Box sx={{ height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={trendChart} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="month" stroke="#8B949E" fontSize={11} interval={trendRange === 'all' ? 11 : 'preserveStartEnd'} />
                <YAxis stroke="#8B949E" fontSize={11} width={70} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <RTooltip
                  formatter={(v: number) => USD0.format(v)}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                  labelStyle={{ color: '#FFFFFF' }}
                  itemStyle={{ color: '#FFFFFF' }}
                />
                <Line type="monotone" dataKey="services" name="Services $" stroke="#2C73FF" strokeWidth={2} dot={{ r: 2, fill: '#2C73FF' }} />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Top customers table */}
      <Paper sx={{ p: 0, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 2, pb: 1 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Customers by services $</Typography>
          <InfoIcon info="Per-customer services revenue. YTD annualized uses the same months-elapsed divisor as the cohort summary so customers are directly comparable to the headline KPI above. Use the segment chips below to narrow the list." />
          <Box sx={{ flexGrow: 1 }} />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {sortedCustomers.length} of {customerRows.length}
          </Typography>
        </Stack>
        {/* Segment filter chips — segment is joined in from customer_profiles
            by normalized customer name. Customers with no profile match show
            up under "(no segment)". */}
        {!isLoading && segmentFacets.length > 0 && (
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ px: 2, pb: 1.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5, minWidth: 70 }}>Segment</Typography>
            {segmentFacets.map(([seg, count]) => (
              <Chip
                key={seg}
                label={`${seg} (${count})`}
                size="small"
                variant={segmentFilter.has(seg) ? 'filled' : 'outlined'}
                color={segmentFilter.has(seg) ? 'primary' : 'default'}
                onClick={() => toggleSegment(seg)}
                sx={{ height: 22, fontSize: 11 }}
              />
            ))}
            {segmentFilter.size > 0 && (
              <Chip label="clear" size="small" variant="outlined" onClick={() => setSegmentFilter(new Set())} sx={{ height: 22, fontSize: 11, color: 'text.secondary' }} />
            )}
          </Stack>
        )}
        {isLoading ? (
          <Skeleton variant="rectangular" height={400} sx={{ mx: 2, mb: 2 }} />
        ) : sortedCustomers.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>No customer data.</Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>
                  <TableSortLabel active={sortKey === 'name'} direction={sortKey === 'name' ? sortDir : 'asc'} onClick={() => toggleSort('name')}>Customer</TableSortLabel>
                </TableCell>
                <TableCell>Segment</TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'ytd'} direction={sortKey === 'ytd' ? sortDir : 'desc'} onClick={() => toggleSort('ytd')}>YTD $</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'ytd_annualized'} direction={sortKey === 'ytd_annualized' ? sortDir : 'desc'} onClick={() => toggleSort('ytd_annualized')}>YTD annualized</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'prior_year'} direction={sortKey === 'prior_year' ? sortDir : 'desc'} onClick={() => toggleSort('prior_year')}>Prior year</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'yoy_pct'} direction={sortKey === 'yoy_pct' ? sortDir : 'desc'} onClick={() => toggleSort('yoy_pct')}>YoY %</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'lifetime'} direction={sortKey === 'lifetime' ? sortDir : 'desc'} onClick={() => toggleSort('lifetime')}>Lifetime</TableSortLabel>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedCustomers.slice(0, 100).map((r) => (
                <TableRow key={r.name} hover>
                  <TableCell sx={{ fontWeight: 500 }}>
                    <CustomerLink id={r.aid} name={r.name}>{r.name}</CustomerLink>
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{r.segment ?? <Typography component="span" variant="caption" sx={{ fontStyle: 'italic', color: 'text.disabled' }}>—</Typography>}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.ytd)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'primary.main', fontWeight: 500 }}>{USD0.format(r.ytd_annualized)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.prior_year)}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: r.yoy_pct == null ? 'text.secondary' : r.yoy_pct >= 0 ? 'success.main' : 'error.main' }}>
                    {r.yoy_pct == null ? '—' : `${r.yoy_pct >= 0 ? '+' : ''}${Math.round(r.yoy_pct * 100)}%`}
                  </TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.lifetime)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {sortedCustomers.length > 100 && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', p: 2 }}>
            Showing top 100 of {sortedCustomers.length} customers. Use export for the full list.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
