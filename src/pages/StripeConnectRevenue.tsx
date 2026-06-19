import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
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
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';

// Snapshot types — match _etl_scripts/build_connect_by_customer.mjs outputs.
type MonthRow = { month: string; mrr_connect: number };
type ConnectByMonth = { rows: MonthRow[]; notes?: string };
type CustomerMonthRow = { customer_name: string; [yearMonth: string]: string | number };
type ConnectByCustomerMonth = {
  rows: CustomerMonthRow[];
  monthlyTotals: Record<string, number>;
  unknownAccountsCount: number;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

type CustomerRow = {
  name: string;
  ytd: number;
  ytd_annualized: number;
  prior_year: number;
  yoy_pct: number | null;
  lifetime: number;
};

type SortKey = 'name' | 'ytd' | 'ytd_annualized' | 'prior_year' | 'yoy_pct' | 'lifetime';

export default function StripeConnectRevenue() {
  const { data: monthData, isLoading: monthLoading, error: monthError } = useSheetTab<ConnectByMonth>('connect_by_month');
  const { data: custData, isLoading: custLoading } = useSheetTab<ConnectByCustomerMonth>('connect_by_customer_month');
  const isLoading = monthLoading || custLoading;

  const [sortKey, setSortKey] = useState<SortKey>('ytd_annualized');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [trendRange, setTrendRange] = useState<'24m' | '48m' | 'all'>('24m');

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'name' ? 'asc' : 'desc');
    }
  }

  // Aggregate monthly totals → per-year totals + KPI summary
  const summary = useMemo(() => {
    const rows = (monthData as ConnectByMonth | undefined)?.rows ?? [];
    if (rows.length === 0) {
      return { currentYear: 0, priorYear: 0, current: 0, priorYearMonthCount: 0, ytdAnnualized: 0, yoyPct: null as number | null, monthsLoadedCurrent: 0, lifetime: 0, latestMonth: null as string | null, latestAmount: 0 };
    }
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    let cy = 0, py = 0, lifetime = 0, monthsLoadedCurrent = 0;
    for (const r of rows) {
      const v = Number(r.mrr_connect) || 0;
      lifetime += v;
      const yr = r.month.slice(0, 4);
      if (yr === currentYearStr) { cy += v; if (v > 0) monthsLoadedCurrent++; }
      else if (yr === priorYearStr) py += v;
    }
    const latest = rows[rows.length - 1];
    const annualized = monthsLoadedCurrent > 0 ? (cy * 12) / monthsLoadedCurrent : cy;
    const yoyPct = py > 0 ? (annualized - py) / py : null;
    return {
      currentYear: cy,
      priorYear: py,
      current: cy,
      priorYearMonthCount: rows.filter((r) => r.month.slice(0, 4) === priorYearStr).length,
      ytdAnnualized: annualized,
      yoyPct,
      monthsLoadedCurrent,
      lifetime,
      latestMonth: latest?.month ?? null,
      latestAmount: Number(latest?.mrr_connect) || 0,
    };
  }, [monthData]);

  // Yearly chart — group monthly rows by year, project current year if partial.
  // Mirrors the OrdersVerified yearly chart shape so the visualization reads
  // the same across pages.
  const yearlyChart = useMemo(() => {
    const rows = (monthData as ConnectByMonth | undefined)?.rows ?? [];
    if (rows.length === 0) return [];
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const byYear = new Map<string, { total: number; months: number }>();
    for (const r of rows) {
      const yr = r.month.slice(0, 4);
      const v = Number(r.mrr_connect) || 0;
      if (!byYear.has(yr)) byYear.set(yr, { total: 0, months: 0 });
      const e = byYear.get(yr)!;
      e.total += v;
      if (v > 0) e.months++;
    }
    return [...byYear.entries()]
      .map(([year, v]) => {
        const isCurrent = year === currentYearStr && v.months > 0 && v.months < 12;
        const annualized = isCurrent ? (v.total * 12) / v.months : v.total;
        return {
          year,
          actual_usd: Math.round(v.total * 100) / 100,
          projected_extra: Math.round(Math.max(0, annualized - v.total) * 100) / 100,
          months: v.months,
          is_partial: isCurrent,
        };
      })
      .sort((a, b) => a.year.localeCompare(b.year));
  }, [monthData]);

  // Monthly trend — for the small chart below the yearly bar.
  const trendChart = useMemo(() => {
    const rows = (monthData as ConnectByMonth | undefined)?.rows ?? [];
    const sliceN = trendRange === '24m' ? 24 : trendRange === '48m' ? 48 : rows.length;
    return rows.slice(-sliceN).map((r) => ({
      month: r.month,
      mrr_connect: Math.round(Number(r.mrr_connect) * 100) / 100,
    }));
  }, [monthData, trendRange]);

  // Top customers — aggregate each customer's current-year, prior-year, lifetime.
  const customerRows = useMemo<CustomerRow[]>(() => {
    const c = (custData as ConnectByCustomerMonth | undefined);
    if (!c?.rows) return [];
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    const out: CustomerRow[] = [];
    // Determine months loaded for current year from the overall total (consistent
    // with the KPI summary) so per-customer annualization uses the same divisor.
    const monthsLoadedCurrent = summary.monthsLoadedCurrent || 1;
    for (const row of c.rows) {
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
      const annualized = monthsLoadedCurrent > 0 && monthsLoadedCurrent < 12 ? (cy * 12) / monthsLoadedCurrent : cy;
      const yoyPct = py > 0 ? (annualized - py) / py : (cy > 0 ? null : -1);
      out.push({
        name: row.customer_name,
        ytd: cy,
        ytd_annualized: annualized,
        prior_year: py,
        yoy_pct: yoyPct === -1 ? null : yoyPct,
        lifetime,
      });
    }
    return out;
  }, [custData, summary.monthsLoadedCurrent]);

  const sortedCustomers = useMemo(() => {
    const out = [...customerRows];
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
  }, [customerRows, sortKey, sortDir]);

  const csvColumns = useMemo(
    () => ([
      { key: 'name', label: 'Customer', getValue: (r: CustomerRow) => r.name },
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
        title="Stripe Connect Revenue"
        subtitle="Affiliate / Connect fees collected from customers' Stripe payouts. Yearly trend with annualized projection of the current year — same visualization style as Orders Verified."
      />

      {monthError && <Alert severity="error" sx={{ mb: 2 }}>Failed to load connect_by_month: {String(monthError)}</Alert>}

      {/* KPI tiles */}
      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Latest month</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD_COMPACT.format(summary.latestAmount)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{summary.latestMonth ?? '—'}</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: 'primary.main' }}>
            <Stack direction="row" spacing={0.5} alignItems="center">
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>YTD annualized</Typography>
              <InfoIcon info="Sum of all current-year monthly Connect fees × (12 / months loaded). If the YTD pace continues for the rest of the year." />
            </Stack>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500, color: 'primary.main' }}>{USD_COMPACT.format(summary.ytdAnnualized)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{summary.monthsLoadedCurrent}/12 months loaded</Typography>
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
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Lifetime Connect $</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD_COMPACT.format(summary.lifetime)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{customerRows.length} customers contributed</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={2.4} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Export</Typography>
            <Box>
              <CsvExportButton filename="stripe_connect_revenue.csv" rows={sortedCustomers} columns={csvColumns} />
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* Yearly chart */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Yearly Connect $ — actual + annualized projection</Typography>
          <InfoIcon info={
            <>
              <strong>What it is:</strong> Total Connect (affiliate) fees by calendar year. The lighter top portion of the current year&apos;s bar shows the annualized projection if YTD pace continues.<br /><br />
              <strong>Annualized:</strong> YTD total × (12 / months loaded). When months loaded = 12 (a complete year) the projection is 0 — bar is just the actual total.
            </>
          } />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={300} /> : yearlyChart.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>No Connect revenue data available.</Typography>
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
                <Bar yAxisId="left" name="Connect $" dataKey="actual_usd" stackId="yr" fill="#2C73FF" />
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
          <InfoIcon info="Monthly Connect fee total. Use the range toggle on the right to widen the window." />
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
                <Line type="monotone" dataKey="mrr_connect" name="Connect $" stroke="#2C73FF" strokeWidth={2} dot={{ r: 2, fill: '#2C73FF' }} />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Top customers table */}
      <Paper sx={{ p: 0, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 2, pb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Top customers by Connect $</Typography>
          <InfoIcon info={
            <>
              Per-customer Connect fee aggregation. YTD annualized uses the same months-loaded divisor as the cohort summary, so customers are directly comparable to one another and to the headline numbers above.<br /><br />
              <strong>Note:</strong> Some Stripe Connect transactions can&apos;t be attributed to a known customer (unmapped accounts) — those appear under &quot;Unknown&quot; in the source data.
            </>
          } />
        </Stack>
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
                  <TableCell sx={{ fontWeight: 500 }}>{r.name}</TableCell>
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
