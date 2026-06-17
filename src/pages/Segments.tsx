import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import Collapse from '@mui/material/Collapse';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import { segmentColor, segmentLabel } from '../lib/segmentsRegistry';
import { useSheetTab } from '../hooks/useSheetTab';

type MonthlyCell = { subscription: number; services: number; connect: number; total: number };
type ProfileRow = {
  allmoxy_customer_id: number;
  name: string;
  primary_segment: string | null;
  sub_segment: string | null;
  pay_status: string | null;
  current_subscription_mrr: number;
  lifetime_total: number;
  lifetime_subscription: number;
  first_payment_date: string | null;
  monthly_history: Record<string, MonthlyCell>;
  latest_month: string;
};

type SubSegmentRow = {
  name: string;
  customerCount: number;
  activeCount: number;
  currentMrr: number;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
function shiftMonth(iso: string, delta: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function fmtPct(v: number | null | undefined, digits = 0) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

// Segment colors come from the canonical registry — 9 distinct GTM colors for
// the segments Allmoxy sells to / influences, charcoal for the 11 context-only
// segments, neutral grey for the Unsegmented bucket. See src/lib/segmentsRegistry.ts.

type SegmentRow = {
  name: string;
  isUnsegmented: boolean;
  customers: ProfileRow[];
  customerCount: number;
  activeCount: number;
  cancelledCount: number;
  retentionPct: number | null;
  currentMrr: number;
  servicesTTM: number;
  connectTTM: number;
  avgMrr: number | null;
  newLogos12m: number;
  lifetimeRevenue: number;
  subSegments: SubSegmentRow[];
};

type Filter = 'all' | 'active' | 'cancelled';

// Module-scope so the same definition is used inside the useMemo and the render
// body. "Active" = currently billing subscription MRR > 0 in the latest complete
// month (matches Overview's mrr_by_month.logo_qty and Customer Health's count).
function isActive(c: ProfileRow): boolean {
  return (c.current_subscription_mrr ?? 0) > 0;
}

export default function Segments() {
  const { data: profilesData, isLoading } = useSheetTab('customer_profiles');
  const snap = profilesData as unknown as { rows: ProfileRow[] } | undefined;
  const profiles = snap?.rows ?? [];

  const [filter, setFilter] = useState<Filter>('all');
  const [drillSegment, setDrillSegment] = useState<string | null>(null);
  const scorecardTable = useCollapse(true);
  const drillTable = useCollapse(true);
  // Which primary-segment rows are expanded to show their sub-segment breakdown.
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(() => new Set());
  function toggleSub(name: string) {
    setExpandedSubs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }
  type DrillSortKey = 'name' | 'pay_status' | 'current_subscription_mrr' | 'lifetime_total' | 'first_payment_date';
  const [drillSearch, setDrillSearch] = useState('');
  const [drillPayStatus, setDrillPayStatus] = useState<string>('all');
  const [drillSortKey, setDrillSortKey] = useState<DrillSortKey>('current_subscription_mrr');
  const [drillSortDir, setDrillSortDir] = useState<'asc' | 'desc'>('desc');
  function setSort(key: DrillSortKey) {
    if (drillSortKey === key) {
      setDrillSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setDrillSortKey(key);
      // Default direction: text columns ascending, numeric columns descending.
      setDrillSortDir(key === 'name' || key === 'pay_status' || key === 'first_payment_date' ? 'asc' : 'desc');
    }
  }

  const view = useMemo(() => {
    if (profiles.length === 0) return null;
    const latestMonth = profiles[0]?.latest_month ?? '';
    if (!latestMonth) return null;

    // 12-month window for TTM aggregates: latestMonth - 11 months .. latestMonth
    const ttmMonths: string[] = [];
    for (let i = 11; i >= 0; i--) ttmMonths.push(shiftMonth(latestMonth, -i));

    // 24-month window for the time-series chart
    const chartMonths: string[] = [];
    for (let i = 23; i >= 0; i--) chartMonths.push(shiftMonth(latestMonth, -i));

    const today = new Date();

    // Group profiles by segment (treat blank as "Unsegmented")
    const bySegment = new Map<string, ProfileRow[]>();
    for (const p of profiles) {
      const seg = (p.primary_segment ?? '').trim() || 'Unsegmented';
      if (!bySegment.has(seg)) bySegment.set(seg, []);
      bySegment.get(seg)!.push(p);
    }

    function sumOver(months: string[], customers: ProfileRow[], stream: keyof MonthlyCell): number {
      let total = 0;
      for (const c of customers) {
        for (const m of months) {
          const cell = c.monthly_history[m];
          if (cell) total += cell[stream] ?? 0;
        }
      }
      return total;
    }

    // isActive defined at module scope. "Cancelled" inside this scope = not actively
    // billing this month (matches Overview / Customer Health rather than HubSpot's
    // pay_status tag, which would inflate the count by including paused / pre-sale /
    // card-failure customers who aren't generating revenue).
    function isCancelled(c: ProfileRow): boolean {
      return !isActive(c);
    }
    function isWithinLast12Months(iso: string | null | undefined): boolean {
      if (!iso) return false;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return false;
      const cutoff = new Date(today);
      cutoff.setMonth(cutoff.getMonth() - 12);
      return d >= cutoff;
    }

    const segments: SegmentRow[] = [];
    for (const [name, customers] of bySegment) {
      const active = customers.filter((c) => !isCancelled(c));
      const cancelled = customers.filter(isCancelled);
      const currentMrr = customers.reduce((s, c) => s + (c.current_subscription_mrr ?? 0), 0);
      const servicesTTM = sumOver(ttmMonths, customers, 'services');
      const connectTTM = sumOver(ttmMonths, customers, 'connect');
      const lifetimeRevenue = customers.reduce((s, c) => s + (c.lifetime_total ?? 0), 0);
      const billingCustomers = customers.filter((c) => (c.current_subscription_mrr ?? 0) > 0).length;
      const avgMrr = billingCustomers > 0 ? currentMrr / billingCustomers : null;
      const newLogos12m = customers.filter((c) => isWithinLast12Months(c.first_payment_date)).length;

      // Aggregate sub-segments within this primary segment.
      const subBuckets = new Map<string, ProfileRow[]>();
      for (const c of customers) {
        const s = (c.sub_segment ?? '').trim() || '(unspecified)';
        if (!subBuckets.has(s)) subBuckets.set(s, []);
        subBuckets.get(s)!.push(c);
      }
      const subSegments: SubSegmentRow[] = [];
      for (const [subName, subCustomers] of subBuckets) {
        const subActive = subCustomers.filter((c) => !isCancelled(c));
        subSegments.push({
          name: subName,
          customerCount: subCustomers.length,
          activeCount: subActive.length,
          currentMrr: subCustomers.reduce((s, c) => s + (c.current_subscription_mrr ?? 0), 0),
        });
      }
      // Sort by current MRR desc, with "(unspecified)" pinned to the bottom.
      subSegments.sort((a, b) => {
        const aUnk = a.name === '(unspecified)';
        const bUnk = b.name === '(unspecified)';
        if (aUnk !== bUnk) return aUnk ? 1 : -1;
        return b.currentMrr - a.currentMrr;
      });

      segments.push({
        name,
        isUnsegmented: name === 'Unsegmented',
        customers,
        customerCount: customers.length,
        activeCount: active.length,
        cancelledCount: cancelled.length,
        retentionPct: customers.length > 0 ? active.length / customers.length : null,
        currentMrr,
        servicesTTM,
        connectTTM,
        avgMrr,
        newLogos12m,
        lifetimeRevenue,
        subSegments,
      });
    }

    // Default sort: current MRR desc; Unsegmented sinks to the bottom regardless.
    segments.sort((a, b) => {
      if (a.isUnsegmented !== b.isUnsegmented) return a.isUnsegmented ? 1 : -1;
      return b.currentMrr - a.currentMrr;
    });

    // Time-series for chart: subscription MRR per month, by segment.
    // Only include named segments (skip Unsegmented from the chart for clarity).
    const chartSegments = segments.filter((s) => !s.isUnsegmented);
    const chartData = chartMonths.map((month) => {
      const row: Record<string, string | number> = { month, label: monthLabel(month) };
      for (const seg of chartSegments) {
        let sub = 0;
        for (const c of seg.customers) {
          const cell = c.monthly_history[month];
          if (cell) sub += cell.subscription ?? 0;
        }
        row[seg.name] = Math.round(sub * 100) / 100;
      }
      return row;
    });

    // Color assignment — canonical GTM palette (mirrors registry/segments.md).
    // Sells-to segments get their distinct hex; context-only segments get charcoal.
    const colorByName: Record<string, string> = {};
    for (const s of segments) {
      colorByName[s.name] = segmentColor(s.isUnsegmented ? null : s.name);
    }

    // Headline KPIs
    const totalCustomers = profiles.length;
    const totalActive = profiles.filter((c) => !isCancelled(c)).length;
    const totalCancelled = profiles.filter(isCancelled).length;
    const totalSegmented = profiles.filter((c) => (c.primary_segment ?? '').trim()).length;
    const totalCurrentMrr = profiles.reduce((s, c) => s + (c.current_subscription_mrr ?? 0), 0);

    return {
      latestMonth,
      segments,
      chartData,
      chartSegments,
      colorByName,
      kpi: {
        totalCustomers,
        totalActive,
        totalCancelled,
        totalSegmented,
        segmentedPct: totalCustomers > 0 ? totalSegmented / totalCustomers : 0,
        totalCurrentMrr,
        segmentCount: segments.filter((s) => !s.isUnsegmented).length,
      },
    };
  }, [profiles]);

  if (isLoading || !view) {
    return (
      <Box>
        <PageHeader title="Segments" subtitle="Customer mix and revenue by primary segment." />
        <Skeleton variant="rectangular" height={140} sx={{ mb: 2 }} />
        <Skeleton variant="rectangular" height={300} />
      </Box>
    );
  }

  // Apply pay-status filter to segment rows for display.
  const visibleSegments = view.segments.map((s) => {
    if (filter === 'all') return s;
    const filtered = s.customers.filter((c) => (filter === 'cancelled' ? !isActive(c) : isActive(c)));
    const billing = filtered.filter((c) => (c.current_subscription_mrr ?? 0) > 0);
    return {
      ...s,
      customers: filtered,
      customerCount: filtered.length,
      activeCount: filter === 'active' ? filtered.length : 0,
      cancelledCount: filter === 'cancelled' ? filtered.length : 0,
      currentMrr: filtered.reduce((sum, c) => sum + (c.current_subscription_mrr ?? 0), 0),
      avgMrr: billing.length > 0 ? filtered.reduce((sum, c) => sum + (c.current_subscription_mrr ?? 0), 0) / billing.length : null,
    };
  });

  return (
    <Box>
      <PageHeader
        title="Segments"
        subtitle={`Customer mix, revenue, and retention by primary segment. ${view.kpi.segmentCount} segments · ${view.kpi.totalSegmented} of ${view.kpi.totalCustomers} customers tagged (${fmtPct(view.kpi.segmentedPct)}).`}
      />

      {/* Top KPI row */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard label="Active customers" value={view.kpi.totalActive.toLocaleString()} sub={`of ${view.kpi.totalCustomers} total · ${view.kpi.totalCancelled} cancelled`} />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard label="Subscription MRR" value={USD0.format(view.kpi.totalCurrentMrr)} sub={`Latest complete month: ${monthLabel(view.latestMonth)}`} />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="Largest segment"
            value={view.segments[0]?.name ?? '—'}
            sub={`${view.segments[0]?.customerCount ?? 0} customers · ${USD0.format(view.segments[0]?.currentMrr ?? 0)} MRR`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="Top 2 share of MRR"
            value={fmtPct(((view.segments[0]?.currentMrr ?? 0) + (view.segments[1]?.currentMrr ?? 0)) / Math.max(view.kpi.totalCurrentMrr, 1))}
            sub={`Concentration in ${view.segments[0]?.name?.slice(0, 18) ?? ''}${view.segments[1] ? ' + ' + view.segments[1].name.slice(0, 18) : ''}`}
          />
        </Grid>
      </Grid>

      {/* Filter chips */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Chip
          label={`All · ${view.kpi.totalCustomers}`}
          color="primary"
          variant={filter === 'all' ? 'filled' : 'outlined'}
          size="small"
          onClick={() => setFilter('all')}
          sx={{ cursor: 'pointer' }}
        />
        <Chip
          label={`Active · ${view.kpi.totalActive}`}
          color="success"
          variant={filter === 'active' ? 'filled' : 'outlined'}
          size="small"
          onClick={() => setFilter('active')}
          sx={{ cursor: 'pointer' }}
        />
        <Chip
          label={`Cancelled · ${view.kpi.totalCancelled}`}
          color="error"
          variant={filter === 'cancelled' ? 'filled' : 'outlined'}
          size="small"
          onClick={() => setFilter('cancelled')}
          sx={{ cursor: 'pointer' }}
        />
      </Stack>

      {/* Segment scorecard table */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: scorecardTable.open ? 2 : 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CollapseToggle open={scorecardTable.open} onToggle={scorecardTable.toggle} label="segment scorecard" />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Segment scorecard
            </Typography>
            <InfoIcon
              info={
                <>
                  One row per primary segment, sorted by current subscription MRR (largest first). <em>Unsegmented</em> drops to the bottom — that's our 12% of customers without a Primary Segment in HubSpot.
                  <br /><br />
                  <strong>Retention</strong> = active / total customers in segment (active = currently billing subscription MRR &gt; 0).
                  <br />
                  <strong>Avg MRR</strong> = sum of current subscription MRR / count of customers currently billing.
                  <br />
                  Click a row to drill into that segment's customers below.
                </>
              }
            />
          </Stack>
          <CsvExportButton
            filename={`segments_scorecard_${filter}`}
            columns={[
              { key: 'name', label: 'Segment' },
              { key: 'customerCount', label: 'Customers' },
              { key: 'activeCount', label: 'Active' },
              { key: 'cancelledCount', label: 'Cancelled' },
              { key: 'retentionPct', label: 'Retention', getValue: (r) => r.retentionPct == null ? '' : (r.retentionPct * 100).toFixed(1) + '%' },
              { key: 'currentMrr', label: 'Current MRR' },
              { key: 'avgMrr', label: 'Avg MRR', getValue: (r) => r.avgMrr ?? '' },
              { key: 'servicesTTM', label: 'Services TTM' },
              { key: 'connectTTM', label: 'Connect TTM' },
              { key: 'newLogos12m', label: 'New logos 12mo' },
              { key: 'lifetimeRevenue', label: 'Lifetime revenue' },
            ]}
            rows={visibleSegments}
          />
        </Stack>
        <Collapse in={scorecardTable.open} unmountOnExit>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Segment</TableCell>
              <TableCell align="right">Customers</TableCell>
              <TableCell align="right">Active</TableCell>
              <TableCell align="right">Cancelled</TableCell>
              <TableCell align="right">Retention</TableCell>
              <TableCell align="right">Current MRR</TableCell>
              <TableCell align="right">Avg MRR</TableCell>
              <TableCell align="right">Services TTM</TableCell>
              <TableCell align="right">Connect TTM</TableCell>
              <TableCell align="right">New logos 12mo</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {visibleSegments.flatMap((s) => {
              const isSelected = drillSegment === s.name;
              const isExpanded = expandedSubs.has(s.name);
              const hasSubs = s.subSegments.length > 1 || (s.subSegments.length === 1 && s.subSegments[0].name !== '(unspecified)');
              const rows: React.ReactNode[] = [];
              rows.push(
                <TableRow
                  key={s.name}
                  hover
                  sx={{
                    cursor: 'pointer',
                    bgcolor: isSelected ? 'rgba(44, 115, 255, 0.08)' : 'transparent',
                    opacity: s.isUnsegmented ? 0.65 : 1,
                  }}
                >
                  <TableCell onClick={() => setDrillSegment(isSelected ? null : s.name)}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      {hasSubs ? (
                        <IconButton
                          size="small"
                          onClick={(e) => { e.stopPropagation(); toggleSub(s.name); }}
                          sx={{ p: 0.25 }}
                          aria-label={isExpanded ? `Collapse sub-segments for ${s.name}` : `Expand sub-segments for ${s.name}`}
                        >
                          {isExpanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
                        </IconButton>
                      ) : (
                        <Box sx={{ width: 24 }} />
                      )}
                      {!s.isUnsegmented && (
                        <Box sx={{ width: 10, height: 10, bgcolor: view.colorByName[s.name] ?? '#8B949E', borderRadius: '2px' }} />
                      )}
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {s.isUnsegmented ? s.name : segmentLabel(s.name)}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="right" onClick={() => setDrillSegment(isSelected ? null : s.name)}>{s.customerCount.toLocaleString()}</TableCell>
                  <TableCell align="right" sx={{ color: 'success.main' }} onClick={() => setDrillSegment(isSelected ? null : s.name)}>{filter === 'cancelled' ? '—' : s.activeCount.toLocaleString()}</TableCell>
                  <TableCell align="right" sx={{ color: 'error.main' }} onClick={() => setDrillSegment(isSelected ? null : s.name)}>{filter === 'active' ? '—' : s.cancelledCount.toLocaleString()}</TableCell>
                  <TableCell align="right" onClick={() => setDrillSegment(isSelected ? null : s.name)}>{fmtPct(s.retentionPct, 1)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 500 }} onClick={() => setDrillSegment(isSelected ? null : s.name)}>{USD0.format(s.currentMrr)}</TableCell>
                  <TableCell align="right" onClick={() => setDrillSegment(isSelected ? null : s.name)}>{s.avgMrr != null ? USD0.format(s.avgMrr) : '—'}</TableCell>
                  <TableCell align="right" onClick={() => setDrillSegment(isSelected ? null : s.name)}>{USD0.format(s.servicesTTM)}</TableCell>
                  <TableCell align="right" onClick={() => setDrillSegment(isSelected ? null : s.name)}>{USD0.format(s.connectTTM)}</TableCell>
                  <TableCell align="right" onClick={() => setDrillSegment(isSelected ? null : s.name)}>{s.newLogos12m}</TableCell>
                </TableRow>
              );
              if (isExpanded) {
                for (const sub of s.subSegments) {
                  rows.push(
                    <TableRow key={`${s.name}::${sub.name}`} sx={{ bgcolor: 'rgba(255,255,255,0.02)' }}>
                      <TableCell sx={{ pl: 6, color: 'text.secondary', fontSize: 13, borderLeft: `3px solid ${view.colorByName[s.name] ?? '#8B949E'}` }}>
                        ↳ {sub.name}
                      </TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>{sub.customerCount.toLocaleString()}</TableCell>
                      <TableCell align="right" sx={{ color: 'success.main', opacity: 0.85 }}>{filter === 'cancelled' ? '—' : sub.activeCount.toLocaleString()}</TableCell>
                      <TableCell align="right" sx={{ color: 'error.main', opacity: 0.85 }}>{filter === 'active' ? '—' : (sub.customerCount - sub.activeCount).toLocaleString()}</TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>{fmtPct(sub.customerCount > 0 ? sub.activeCount / sub.customerCount : null, 1)}</TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>{USD0.format(sub.currentMrr)}</TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>—</TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>—</TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>—</TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>—</TableCell>
                    </TableRow>
                  );
                }
              }
              return rows;
            })}
          </TableBody>
        </Table>
        </Collapse>
      </Paper>

      {/* Stacked time-series chart */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Subscription MRR by segment · trailing 24 months
          </Typography>
          <InfoIcon info={<>Stacked monthly subscription MRR per segment. <em>Unsegmented</em> customers are excluded from the chart for clarity (they're ~12% of customers, mostly with low MRR). Hover for breakdown.</>} />
        </Stack>
        <Box sx={{ width: '100%', height: 360 }}>
          <ResponsiveContainer>
            <BarChart data={view.chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
              <XAxis dataKey="label" stroke="#8B949E" fontSize={11} />
              <YAxis stroke="#8B949E" fontSize={11} tickFormatter={(v: number) => USD0.format(v)} width={70} />
              <RTooltip
                contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                labelStyle={{ color: '#FFFFFF' }}
                itemStyle={{ color: '#FFFFFF' }}
                formatter={(v: number, name: string) => [USD0.format(v), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {view.chartSegments.map((s) => (
                <Bar key={s.name} dataKey={s.name} stackId="a" fill={view.colorByName[s.name] ?? '#8B949E'} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </Box>
      </Paper>

      {/* Drill-down: top customers in selected segment */}
      {drillSegment && (() => {
        const seg = view.segments.find((s) => s.name === drillSegment);
        const segFiltered = !seg ? 0 : (filter === 'all' ? seg.customers.length : seg.customers.filter((c) => (filter === 'cancelled' ? !isActive(c) : isActive(c))).length);
        return (
        <Paper sx={{ p: 3 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} justifyContent="space-between">
            <Stack direction="row" spacing={1} alignItems="center">
              <CollapseToggle open={drillTable.open} onToggle={drillTable.toggle} label="segment customers" />
              <Box sx={{ width: 12, height: 12, bgcolor: view.colorByName[drillSegment] ?? '#8B949E', borderRadius: '2px' }} />
              <Typography variant="subtitle2" sx={{ fontWeight: 500 }}>
                Customers · {segmentLabel(drillSegment)}
              </Typography>
              <Chip label={`${segFiltered.toLocaleString()} ${filter === 'all' ? 'total' : filter}`} size="small" variant="outlined" />
            </Stack>
            <Stack direction="row" spacing={1}>
              <CsvExportButton
                filename={`segment_${drillSegment.replace(/\s+/g, '_').toLowerCase()}_customers`}
                columns={[
                  { key: 'allmoxy_customer_id', label: 'Allmoxy ID' },
                  { key: 'name', label: 'Customer' },
                  { key: 'pay_status', label: 'Pay status' },
                  { key: 'current_subscription_mrr', label: 'Current MRR' },
                  { key: 'lifetime_total', label: 'Lifetime revenue' },
                  { key: 'first_payment_date', label: 'First payment' },
                  { key: 'last_payment_date', label: 'Last payment' },
                ]}
                rows={(view.segments.find((s) => s.name === drillSegment)?.customers ?? [])}
              />
              <Chip label="Close" size="small" variant="outlined" onClick={() => setDrillSegment(null)} sx={{ cursor: 'pointer' }} />
            </Stack>
          </Stack>
          <Collapse in={drillTable.open} unmountOnExit>
          {(() => {
            const seg = view.segments.find((s) => s.name === drillSegment);
            if (!seg) return null;
            const filteredByStatus = filter === 'all' ? seg.customers : seg.customers.filter((c) => (filter === 'cancelled' ? !isActive(c) : isActive(c)));
            // Distinct HubSpot pay_status values present in this segment, plus a
            // "(no HubSpot match)" bucket and a "(blank)" bucket so unmatched
            // customers can still be picked. Sorted with named statuses first.
            const payStatusValuesRaw = new Map<string, number>();
            for (const c of seg.customers) {
              const v = c.pay_status ?? '__null__';
              payStatusValuesRaw.set(v, (payStatusValuesRaw.get(v) ?? 0) + 1);
            }
            const payStatusOptions = [...payStatusValuesRaw.entries()].sort((a, b) => {
              if (a[0] === '__null__') return 1;
              if (b[0] === '__null__') return -1;
              return a[0].localeCompare(b[0]);
            });
            const payStatusFilteredRows = drillPayStatus === 'all'
              ? filteredByStatus
              : filteredByStatus.filter((c) => (c.pay_status ?? '__null__') === drillPayStatus);
            const search = drillSearch.trim().toLowerCase();
            const filtered = search
              ? payStatusFilteredRows.filter((c) => (c.name ?? '').toLowerCase().includes(search))
              : payStatusFilteredRows;
            const sortVal = (c: ProfileRow): string | number => {
              switch (drillSortKey) {
                case 'name': return (c.name ?? '').toLowerCase();
                case 'pay_status': return (c.pay_status ?? '~').toLowerCase(); // '~' sorts blanks to bottom asc
                case 'current_subscription_mrr': return c.current_subscription_mrr ?? 0;
                case 'lifetime_total': return c.lifetime_total ?? 0;
                case 'first_payment_date': return c.first_payment_date ?? '';
              }
            };
            const sorted = [...filtered].sort((a, b) => {
              const av = sortVal(a);
              const bv = sortVal(b);
              if (av < bv) return drillSortDir === 'asc' ? -1 : 1;
              if (av > bv) return drillSortDir === 'asc' ? 1 : -1;
              // Stable tiebreaker: alphabetical by name when primary sort matches
              const an = (a.name ?? '').toLowerCase();
              const bn = (b.name ?? '').toLowerCase();
              return an < bn ? -1 : an > bn ? 1 : 0;
            });
            return (
              <>
                <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                  <TextField
                    size="small"
                    placeholder="Filter by customer name…"
                    value={drillSearch}
                    onChange={(e) => setDrillSearch(e.target.value)}
                    sx={{ minWidth: 280, maxWidth: 360, flexGrow: 1 }}
                    InputProps={{
                      startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} /></InputAdornment>,
                      endAdornment: drillSearch ? (
                        <InputAdornment position="end">
                          <IconButton size="small" onClick={() => setDrillSearch('')} aria-label="Clear search"><ClearIcon fontSize="small" /></IconButton>
                        </InputAdornment>
                      ) : null,
                    }}
                  />
                  <TextField
                    size="small"
                    select
                    label="Pay status"
                    value={drillPayStatus}
                    onChange={(e) => setDrillPayStatus(e.target.value)}
                    sx={{ minWidth: 220 }}
                  >
                    <MenuItem value="all">All ({seg.customers.length.toLocaleString()})</MenuItem>
                    {payStatusOptions.map(([value, count]) => (
                      <MenuItem key={value} value={value}>
                        {value === '__null__' ? '(no HubSpot match)' : value} ({count.toLocaleString()})
                      </MenuItem>
                    ))}
                  </TextField>
                </Stack>
                {sorted.length === 0 ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {search || drillPayStatus !== 'all'
                      ? `No customers in this segment match the current filters.`
                      : 'No customers match the active filter in this segment.'}
                  </Typography>
                ) : (
                  <>
                    {(search || filter !== 'all' || drillPayStatus !== 'all') && (
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
                        Showing {sorted.length.toLocaleString()} of {seg.customers.length.toLocaleString()} customer{seg.customers.length === 1 ? '' : 's'}
                        {filter !== 'all' ? ` · ${filter}` : ''}
                        {drillPayStatus !== 'all' ? ` · ${drillPayStatus === '__null__' ? '(no HubSpot match)' : drillPayStatus}` : ''}
                        {search ? ` · matching "${drillSearch}"` : ''}
                      </Typography>
                    )}
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell sortDirection={drillSortKey === 'name' ? drillSortDir : false}>
                            <TableSortLabel active={drillSortKey === 'name'} direction={drillSortKey === 'name' ? drillSortDir : 'asc'} onClick={() => setSort('name')}>Customer</TableSortLabel>
                          </TableCell>
                          <TableCell sortDirection={drillSortKey === 'pay_status' ? drillSortDir : false}>
                            <TableSortLabel active={drillSortKey === 'pay_status'} direction={drillSortKey === 'pay_status' ? drillSortDir : 'asc'} onClick={() => setSort('pay_status')}>Pay status</TableSortLabel>
                          </TableCell>
                          <TableCell align="right" sortDirection={drillSortKey === 'current_subscription_mrr' ? drillSortDir : false}>
                            <TableSortLabel active={drillSortKey === 'current_subscription_mrr'} direction={drillSortKey === 'current_subscription_mrr' ? drillSortDir : 'desc'} onClick={() => setSort('current_subscription_mrr')}>Current MRR</TableSortLabel>
                          </TableCell>
                          <TableCell align="right" sortDirection={drillSortKey === 'lifetime_total' ? drillSortDir : false}>
                            <TableSortLabel active={drillSortKey === 'lifetime_total'} direction={drillSortKey === 'lifetime_total' ? drillSortDir : 'desc'} onClick={() => setSort('lifetime_total')}>Lifetime revenue</TableSortLabel>
                          </TableCell>
                          <TableCell sortDirection={drillSortKey === 'first_payment_date' ? drillSortDir : false}>
                            <TableSortLabel active={drillSortKey === 'first_payment_date'} direction={drillSortKey === 'first_payment_date' ? drillSortDir : 'asc'} onClick={() => setSort('first_payment_date')}>First payment</TableSortLabel>
                          </TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {sorted.map((c) => (
                          <TableRow key={c.allmoxy_customer_id}>
                            <TableCell>{c.name}</TableCell>
                            <TableCell>
                              <Chip
                                label={c.pay_status ?? '—'}
                                size="small"
                                variant="outlined"
                                color={c.pay_status === 'Cancelled' ? 'error' : c.pay_status?.startsWith('Active') ? 'success' : 'default'}
                              />
                            </TableCell>
                            <TableCell align="right" sx={{ fontWeight: 500 }}>{USD0.format(c.current_subscription_mrr ?? 0)}</TableCell>
                            <TableCell align="right">{USD0.format(c.lifetime_total ?? 0)}</TableCell>
                            <TableCell>{c.first_payment_date ?? '—'}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
              </>
            );
          })()}
          </Collapse>
        </Paper>
        );
      })()}
    </Box>
  );
}

function KPICard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 500, mt: 0.5, mb: 0.5 }}>{value}</Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>{sub}</Typography>
    </Paper>
  );
}
