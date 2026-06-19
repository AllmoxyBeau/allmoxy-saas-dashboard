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
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Cell,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from 'recharts';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import RenewalPanelContent from '../components/common/RenewalPanelContent';
import { useSheetTab } from '../hooks/useSheetTab';

type ActionTag = 'Expansion Opportunity' | 'Contraction Risk' | 'Watch' | 'Stable' | 'Paused';
type Tier = 'red' | 'yellow' | 'green' | 'unscored' | null;

type MonthlyTrendPoint = {
  month: string;
  subscription: number;
  orders_dollars: number;
  orders_source: 'supplement' | 'yearly_avg';
  // Cost as % of orders verified for that month (lower = better deal).
  // Replaces the prior "ROI multiplier" framing.
  cost_ratio_pct: number | null;
};

type RenewalRow = {
  instance_id: string;
  account_name: string;
  allmoxy_customer_id: number;
  customer_name: string;
  renewal_date: string | null;
  days_to_renewal: number | null;
  calculated_renewal_date: string | null;
  renewal_date_manual: string | null;
  contract_status: string | null;
  contract_length_months: number | null;
  monthly_flat_fee_hubspot: number | null;
  arr_up_for_renewal: number;
  last_renewal_expansion: string | null;
  last_no_expansion_reason: string | null;
  pay_status: string;
  cs_pulse: string | null;
  health_score: number | null;
  health_score_status: string | null;
  vip_legacy: string | null;
  implementation_status: string | null;
  is_launched: string | null;
  owner_name: string | null;
  current_mrr: number;
  current_arr: number;
  lifetime_subscription: number;
  lifetime_orders_dollars: number;
  orders_monthly_avg_current_year: number;
  orders_monthly_avg_prior_year: number;
  orders_yoy_pct: number | null;
  cost_ratio_lifetime_pct: number | null;
  cost_ratio_annualized_pct: number | null;
  monthly_trend: MonthlyTrendPoint[];
  dropoff_pct: number | null;
  risk_tier: Tier;
  risk_score: number | null;
  is_bid_only: boolean;
  action_tag: ActionTag;
  action_reason: string;
  customer_entered_orders_prev_billing_period: number | null;
};

type Aggregates = {
  total_instances: number;
  with_renewal_date: number;
  renewals_in_next_90d: number;
  renewals_in_next_90d_arr: number;
  renewals_in_next_180d: number;
  renewals_in_next_180d_arr: number;
  renewals_in_next_12mo: number;
  renewals_in_next_12mo_arr: number;
  expansion_opportunities: number;
  contraction_risks: number;
  watch: number;
  stable: number;
  paused: number;
  median_cost_ratio_lifetime_pct: number | null;
  median_cost_ratio_annualized_pct: number | null;
  dropoff_count: number;
};

type Snapshot = {
  fetchedAt: string;
  aggregates: Aggregates;
  rows: RenewalRow[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

const ACTION_COLOR: Record<ActionTag, string> = {
  'Expansion Opportunity': '#1A9E5C',
  'Contraction Risk': '#D63A4D',
  Watch: '#F5A623',
  Stable: '#8B949E',
  Paused: '#2C73FF',
};

type SortKey = 'days_to_renewal' | 'arr' | 'mrr' | 'cost_ratio_lifetime' | 'cost_ratio_annualized' | 'orders_yoy' | 'name' | 'tier';

// Clickable KPI tile filters. Tap a tile to narrow the table to that slice;
// tap it again to clear. Mutually exclusive — clicking a different tile
// switches the filter (rather than ANDing) because the tiles slice
// overlapping populations and an AND combination is rarely what the user
// wants when drilling in from a headline number.
type MetricFilter = 'next_90d' | 'next_180d' | 'next_12mo' | 'expansion' | 'contraction' | 'dropoff' | 'no_renewal_date' | null;

export default function RenewalManagement() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('renewal_management');
  const snap = data as Snapshot | undefined;

  const [actionFilter, setActionFilter] = useState<ActionTag[]>([]);
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [showOnlyWithRenewalDate, setShowOnlyWithRenewalDate] = useState(true);
  const [metricFilter, setMetricFilter] = useState<MetricFilter>(null);
  // Clicking a bar in the renewal pipeline chart drills into that month. e.g.
  // "2026-08". Stacks additively with metricFilter / owner / action filters.
  const [monthFilter, setMonthFilter] = useState<string | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('days_to_renewal');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleMetric(m: MetricFilter) {
    setMetricFilter((prev) => (prev === m ? null : m));
  }

  function toggleMonth(ym: string) {
    setMonthFilter((prev) => (prev === ym ? null : ym));
  }

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'name' || k === 'days_to_renewal' ? 'asc' : 'desc'); }
  }

  const rows = snap?.rows ?? [];
  const agg = snap?.aggregates;

  // No-renewal-date count is not in the snapshot aggregates today — compute
  // it from rows so the tile is always accurate.
  const noRenewalDateCount = useMemo(() => rows.filter((r) => !r.renewal_date).length, [rows]);

  // Facets
  const ownerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.owner_name || '(unassigned)', (m.get(r.owner_name || '(unassigned)') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  // Filter base — applies all filters EXCEPT monthFilter. Used by the pipeline
  // chart so all months stay visible while the user drills into a specific
  // month for the table.
  const filteredForChart = useMemo(() => {
    const actionSet = new Set(actionFilter);
    const ownerSet = new Set(ownerFilter);
    // When the "No renewal date" metric tile is active, it inverts the gate
    // and shows only customers WITHOUT a renewal date — regardless of the
    // showOnlyWithRenewalDate chip's value.
    const noDateOnly = metricFilter === 'no_renewal_date';
    return rows.filter((r) => {
      if (noDateOnly) {
        if (r.renewal_date) return false;
      } else {
        if (showOnlyWithRenewalDate && !r.renewal_date) return false;
      }
      if (actionSet.size > 0 && !actionSet.has(r.action_tag)) return false;
      if (ownerSet.size > 0 && !ownerSet.has(r.owner_name || '(unassigned)')) return false;
      if (metricFilter === 'next_90d' && (r.days_to_renewal == null || r.days_to_renewal < 0 || r.days_to_renewal > 90)) return false;
      if (metricFilter === 'next_180d' && (r.days_to_renewal == null || r.days_to_renewal < 0 || r.days_to_renewal > 180)) return false;
      if (metricFilter === 'next_12mo' && (r.days_to_renewal == null || r.days_to_renewal < 0 || r.days_to_renewal > 365)) return false;
      if (metricFilter === 'expansion' && r.action_tag !== 'Expansion Opportunity') return false;
      if (metricFilter === 'contraction' && r.action_tag !== 'Contraction Risk') return false;
      if (metricFilter === 'dropoff' && (r.dropoff_pct == null || r.dropoff_pct > -0.25)) return false;
      return true;
    });
  }, [rows, actionFilter, ownerFilter, showOnlyWithRenewalDate, metricFilter]);

  // Final filter — adds monthFilter on top of the chart base. This is what
  // the table renders.
  const filtered = useMemo(() => {
    if (!monthFilter) return filteredForChart;
    return filteredForChart.filter((r) => r.renewal_date && r.renewal_date.slice(0, 7) === monthFilter);
  }, [filteredForChart, monthFilter]);

  // Sort
  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case 'days_to_renewal':
          av = a.days_to_renewal ?? 99999; bv = b.days_to_renewal ?? 99999; break;
        case 'arr': av = a.arr_up_for_renewal; bv = b.arr_up_for_renewal; break;
        case 'mrr': av = a.current_mrr; bv = b.current_mrr; break;
        // For cost ratio, null sorts to the END regardless of dir — null
        // means "no orders" which is the messiest case to interpret.
        case 'cost_ratio_lifetime': av = a.cost_ratio_lifetime_pct ?? 99999; bv = b.cost_ratio_lifetime_pct ?? 99999; break;
        case 'cost_ratio_annualized': av = a.cost_ratio_annualized_pct ?? 99999; bv = b.cost_ratio_annualized_pct ?? 99999; break;
        case 'orders_yoy': av = a.orders_yoy_pct ?? -1; bv = b.orders_yoy_pct ?? -1; break;
        case 'name': av = (a.account_name || '').toLowerCase(); bv = (b.account_name || '').toLowerCase(); break;
        case 'tier': {
          const order: Record<string, number> = { red: 0, yellow: 1, unscored: 2, green: 3 };
          av = order[a.risk_tier ?? 'unscored'] ?? 9;
          bv = order[b.risk_tier ?? 'unscored'] ?? 9;
          break;
        }
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  // Pipeline chart — group by month, sum ARR. Uses filteredForChart so all
  // months stay visible even when one is selected for the table drill.
  const pipelineChart = useMemo(() => {
    const months = new Map<string, { ym: string; count: number; arr: number }>();
    for (const r of filteredForChart) {
      if (!r.renewal_date) continue;
      const ym = r.renewal_date.slice(0, 7);
      if (!months.has(ym)) months.set(ym, { ym, count: 0, arr: 0 });
      const e = months.get(ym)!;
      e.count += 1;
      e.arr += r.arr_up_for_renewal;
    }
    return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
  }, [filteredForChart]);

  const csvColumns = useMemo(() => ([
    { key: 'customer', label: 'Customer', getValue: (r: RenewalRow) => r.account_name },
    { key: 'aid', label: 'Allmoxy ID', getValue: (r: RenewalRow) => r.allmoxy_customer_id },
    { key: 'renewal_date', label: 'Renewal Date', getValue: (r: RenewalRow) => r.renewal_date ?? '' },
    { key: 'days_to_renewal', label: 'Days to Renewal', getValue: (r: RenewalRow) => r.days_to_renewal ?? '' },
    { key: 'mrr', label: 'Current MRR', getValue: (r: RenewalRow) => r.current_mrr },
    { key: 'arr_up_for_renewal', label: 'ARR up for Renewal', getValue: (r: RenewalRow) => r.arr_up_for_renewal },
    { key: 'cost_ratio_lifetime', label: 'Cost Ratio Lifetime (%)', getValue: (r: RenewalRow) => r.cost_ratio_lifetime_pct ?? '' },
    { key: 'cost_ratio_annualized', label: 'Cost Ratio Annualized (%)', getValue: (r: RenewalRow) => r.cost_ratio_annualized_pct ?? '' },
    { key: 'orders_yoy_pct', label: 'Orders YoY %', getValue: (r: RenewalRow) => r.orders_yoy_pct == null ? '' : Math.round(r.orders_yoy_pct * 100) },
    { key: 'dropoff_pct', label: 'Recent 3mo cost ratio vs trailing 9mo (% change)', getValue: (r: RenewalRow) => r.dropoff_pct == null ? '' : Math.round(r.dropoff_pct * 100) },
    { key: 'risk_tier', label: 'Risk Tier', getValue: (r: RenewalRow) => r.risk_tier ?? '' },
    { key: 'action_tag', label: 'Action Tag', getValue: (r: RenewalRow) => r.action_tag },
    { key: 'last_expansion', label: 'Last Renewal Expansion', getValue: (r: RenewalRow) => r.last_renewal_expansion ?? '' },
    { key: 'last_no_expansion_reason', label: 'No Expansion Reason', getValue: (r: RenewalRow) => r.last_no_expansion_reason ?? '' },
    { key: 'pay_status', label: 'Pay Status', getValue: (r: RenewalRow) => r.pay_status },
    { key: 'cs_pulse', label: 'CS Pulse', getValue: (r: RenewalRow) => r.cs_pulse ?? '' },
    { key: 'owner', label: 'Owner', getValue: (r: RenewalRow) => r.owner_name ?? '' },
  ]), []);

  return (
    <Box>
      <PageHeader
        title="Renewal Management"
        subtitle="Upcoming renewals with expansion vs contraction visibility. Cost ratio shows what % of a customer's verified-order $ they pay Allmoxy — lower is better, and the durable renewal narrative."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load renewal_management: {String(error)}</Alert>}

      {/* KPI tiles — click a tile to filter the table below to that slice;
          click again to clear. Mutually exclusive. */}
      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <KpiTile
          label="Renewals · next 90d"
          info="Customers with a renewal date in the next 90 days. Click to filter the table to just this set. ARR shown is monthly_flat_fee × 12 from HubSpot, or current MRR × 12 if HubSpot's value is missing."
          value={agg?.renewals_in_next_90d}
          sub={`${USD_COMPACT.format(agg?.renewals_in_next_90d_arr ?? 0)} ARR`}
          active={metricFilter === 'next_90d'}
          onClick={() => toggleMetric('next_90d')}
          isLoading={isLoading}
        />
        <KpiTile
          label="Renewals · next 180d"
          info="Customers with a renewal date in the next 180 days. Click to filter."
          value={agg?.renewals_in_next_180d}
          sub={`${USD_COMPACT.format(agg?.renewals_in_next_180d_arr ?? 0)} ARR`}
          active={metricFilter === 'next_180d'}
          onClick={() => toggleMetric('next_180d')}
          isLoading={isLoading}
        />
        <KpiTile
          label="Expansion ops"
          info="Customers tagged Expansion Opportunity — orders growing YoY by 20%+ and no health red. Click to filter."
          value={agg?.expansion_opportunities}
          sub="Orders YoY ≥ +20%"
          accent="success.main"
          valueColor="success.main"
          active={metricFilter === 'expansion'}
          onClick={() => toggleMetric('expansion')}
          isLoading={isLoading}
        />
        <KpiTile
          label="Contraction risks"
          info="Customers tagged Contraction Risk — health tier red, OR orders monthly avg down 20%+ YoY. Click to filter."
          value={agg?.contraction_risks}
          sub="Health red OR orders -20%"
          accent="error.main"
          valueColor="error.main"
          active={metricFilter === 'contraction'}
          onClick={() => toggleMetric('contraction')}
          isLoading={isLoading}
        />
        <KpiTile
          label="Median cost ratio · lifetime"
          info="Median (lifetime subscription paid / lifetime orders verified $) × 100. The typical customer pays this percentage of their verified order revenue to Allmoxy. Lower is better — small % means customers are getting a great deal. Informational only — not clickable."
          value={agg?.median_cost_ratio_lifetime_pct != null ? `${agg.median_cost_ratio_lifetime_pct.toFixed(2)}%` : '—'}
          sub={`Annualized: ${agg?.median_cost_ratio_annualized_pct != null ? `${agg.median_cost_ratio_annualized_pct.toFixed(2)}%` : '—'}`}
          accent="primary.main"
          valueColor="primary.main"
          isLoading={isLoading}
        />
        <KpiTile
          label="Cost-ratio drift"
          info="Customers whose cost ratio in the most recent 3 months is 25%+ HIGHER (worse) than their trailing 9-month baseline. Means orders are dropping faster than subscription — customer is paying a bigger fraction of their throughput, a leading indicator of contraction. Click to filter."
          value={agg?.dropoff_count}
          sub="Recent 3mo > +25% vs trailing"
          accent="warning.main"
          valueColor="warning.main"
          active={metricFilter === 'dropoff'}
          onClick={() => toggleMetric('dropoff')}
          isLoading={isLoading}
        />
        <KpiTile
          label="No renewal date"
          info="Active customers whose HubSpot Instance has no calculated_renewal_date AND no manual renewal_date set. Either MTM, brand-new (still in trial), or contract data not yet entered in HubSpot. Click to see who needs renewal-date hygiene. Overrides the 'has renewal date' chip filter."
          value={noRenewalDateCount}
          sub="MTM / unset in HubSpot"
          accent="info.main"
          valueColor="info.main"
          active={metricFilter === 'no_renewal_date'}
          onClick={() => toggleMetric('no_renewal_date')}
          isLoading={isLoading}
        />
      </Grid>

      {/* Active-filter banner */}
      {metricFilter && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          onClose={() => setMetricFilter(null)}
        >
          Filtered to <strong>{metricFilterLabel(metricFilter)}</strong> · {filtered.length} customer{filtered.length === 1 ? '' : 's'} match. Click the tile again or the × to clear.
        </Alert>
      )}

      {/* Pipeline chart — bars are clickable. Click a bar to drill the table
          into that month; click the same bar again to clear. */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Renewal pipeline · ARR by month</Typography>
          <InfoIcon info="Aggregate ARR coming up for renewal each month. Tall bars are concentration months. Click a bar to drill the table below into that month; click it again to clear." />
          {monthFilter && (
            <Chip
              label={`Filtered: ${monthFilter}`}
              size="small"
              onDelete={() => setMonthFilter(null)}
              sx={{ height: 22, fontSize: 11, bgcolor: 'primary.main', color: 'common.white', '& .MuiChip-deleteIcon': { color: 'common.white' } }}
            />
          )}
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={260} /> : pipelineChart.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>No renewal dates in the filtered set.</Typography>
        ) : (
          <Box sx={{ height: 260 }}>
            <ResponsiveContainer>
              <ComposedChart data={pipelineChart} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="ym" stroke="#8B949E" fontSize={11} />
                <YAxis yAxisId="left" stroke="#8B949E" fontSize={11} width={70} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <YAxis yAxisId="right" orientation="right" stroke="#8B949E" fontSize={11} width={40} />
                <RTooltip
                  formatter={(v: number, name: string) => name === 'Renewal count' ? [v.toString(), name] : [USD0.format(v), name]}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                  labelStyle={{ color: '#FFFFFF' }}
                  itemStyle={{ color: '#FFFFFF' }}
                  cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: '#8B949E' }} />
                <Bar
                  yAxisId="left"
                  name="ARR up for renewal"
                  dataKey="arr"
                  onClick={(d: { ym?: string }) => { if (d?.ym) toggleMonth(d.ym); }}
                  cursor="pointer"
                >
                  {pipelineChart.map((entry) => (
                    <Cell
                      key={entry.ym}
                      fill={monthFilter === entry.ym ? '#1A9E5C' : (monthFilter ? 'rgba(44, 115, 255, 0.35)' : '#2C73FF')}
                    />
                  ))}
                </Bar>
                <Line yAxisId="right" name="Renewal count" type="monotone" dataKey="count" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3, fill: '#F59E0B' }} />
              </ComposedChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Filters */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <Autocomplete
          multiple
          disableCloseOnSelect
          size="small"
          options={['Expansion Opportunity', 'Contraction Risk', 'Watch', 'Stable', 'Paused'] as ActionTag[]}
          value={actionFilter}
          onChange={(_, v) => setActionFilter(v)}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => (
              <Chip variant="filled" label={option} size="small" {...getTagProps({ index })} key={option} sx={{ height: 20, fontSize: 11, bgcolor: ACTION_COLOR[option] + '22', color: ACTION_COLOR[option] }} />
            ))
          }
          renderInput={(params) => <TextField {...params} label="Action" placeholder={actionFilter.length === 0 ? 'All actions' : ''} sx={{ '& .MuiInputBase-input': { fontSize: 12 }, '& .MuiFormLabel-root': { fontSize: 12 } }} />}
          sx={{ minWidth: 240, maxWidth: 400 }}
        />
        {ownerCounts.length > 0 && (
          <Autocomplete
            multiple
            disableCloseOnSelect
            size="small"
            options={ownerCounts.map((o) => o[0])}
            value={ownerFilter}
            onChange={(_, v) => setOwnerFilter(v)}
            getOptionLabel={(o) => {
              const found = ownerCounts.find((x) => x[0] === o);
              return found ? `${found[0]} (${found[1]})` : o;
            }}
            renderTags={(value, getTagProps) =>
              value.map((option, index) => (
                <Chip variant="filled" label={option} size="small" {...getTagProps({ index })} key={option} sx={{ height: 20, fontSize: 11 }} />
              ))
            }
            renderInput={(params) => <TextField {...params} label="Owner" placeholder={ownerFilter.length === 0 ? 'All owners' : ''} sx={{ '& .MuiInputBase-input': { fontSize: 12 }, '& .MuiFormLabel-root': { fontSize: 12 } }} />}
            sx={{ minWidth: 200, maxWidth: 360 }}
          />
        )}
        <Chip
          label={showOnlyWithRenewalDate ? '✓ Has renewal date' : 'Show all (incl. MTM)'}
          variant={showOnlyWithRenewalDate ? 'filled' : 'outlined'}
          color={showOnlyWithRenewalDate ? 'primary' : 'default'}
          onClick={() => setShowOnlyWithRenewalDate(!showOnlyWithRenewalDate)}
          sx={{ cursor: 'pointer' }}
        />
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {sorted.length} of {rows.length} customers
        </Typography>
        <CsvExportButton filename={`renewal_management_${new Date().toISOString().slice(0, 10)}`} rows={sorted} columns={csvColumns} />
      </Stack>

      {/* Table */}
      <Paper sx={{ p: 0 }}>
        {isLoading ? (
          <Skeleton variant="rectangular" height={400} sx={{ m: 2 }} />
        ) : sorted.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>No customers match this filter.</Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>
                  <TableSortLabel active={sortKey === 'days_to_renewal'} direction={sortKey === 'days_to_renewal' ? sortDir : 'asc'} onClick={() => toggleSort('days_to_renewal')}>Renews</TableSortLabel>
                </TableCell>
                <TableCell>
                  <TableSortLabel active={sortKey === 'name'} direction={sortKey === 'name' ? sortDir : 'asc'} onClick={() => toggleSort('name')}>Customer</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'arr'} direction={sortKey === 'arr' ? sortDir : 'desc'} onClick={() => toggleSort('arr')}>ARR</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'cost_ratio_lifetime'} direction={sortKey === 'cost_ratio_lifetime' ? sortDir : 'asc'} onClick={() => toggleSort('cost_ratio_lifetime')}>Cost % · Lifetime</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'cost_ratio_annualized'} direction={sortKey === 'cost_ratio_annualized' ? sortDir : 'asc'} onClick={() => toggleSort('cost_ratio_annualized')}>Cost % · Annualized</TableSortLabel>
                </TableCell>
                <TableCell align="right">
                  <TableSortLabel active={sortKey === 'orders_yoy'} direction={sortKey === 'orders_yoy' ? sortDir : 'desc'} onClick={() => toggleSort('orders_yoy')}>Orders YoY</TableSortLabel>
                </TableCell>
                <TableCell align="center">
                  <TableSortLabel active={sortKey === 'tier'} direction={sortKey === 'tier' ? sortDir : 'asc'} onClick={() => toggleSort('tier')}>Health</TableSortLabel>
                </TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((r) => {
                const isExpanded = expandedRow === r.instance_id;
                const tierColor = r.risk_tier === 'red' ? '#D63A4D' : r.risk_tier === 'yellow' ? '#F5A623' : r.risk_tier === 'green' ? '#1A9E5C' : '#8B949E';
                const yoyColor = r.orders_yoy_pct == null ? 'text.secondary' : r.orders_yoy_pct >= 0 ? 'success.main' : 'error.main';
                const lifetimeFmt = r.cost_ratio_lifetime_pct == null ? '—' : `${r.cost_ratio_lifetime_pct.toFixed(2)}%`;
                const annualizedFmt = r.cost_ratio_annualized_pct == null ? '—' : `${r.cost_ratio_annualized_pct.toFixed(2)}%`;
                // Cost-ratio drift flag: recent 3mo is 25%+ HIGHER (worse) than trailing 9mo baseline
                const dropoffFlag = r.dropoff_pct != null && r.dropoff_pct >= 0.25;
                return (
                  <>
                    <TableRow key={r.instance_id} hover onClick={() => setExpandedRow(isExpanded ? null : r.instance_id)} sx={{ cursor: 'pointer', '& > td': { borderBottom: isExpanded ? 'none' : undefined } }}>
                      <TableCell sx={{ fontSize: 12 }}>
                        {r.renewal_date ? (
                          <>
                            <Box sx={{ fontWeight: 500 }}>{r.renewal_date}</Box>
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                              {r.days_to_renewal != null && r.days_to_renewal >= 0 ? `in ${r.days_to_renewal}d` : r.days_to_renewal != null ? `${Math.abs(r.days_to_renewal)}d ago` : ''}
                            </Typography>
                          </>
                        ) : <Typography variant="caption" sx={{ color: 'text.disabled' }}>—</Typography>}
                      </TableCell>
                      <TableCell sx={{ fontWeight: 500 }}>
                        <CustomerLink id={r.allmoxy_customer_id} name={r.customer_name || r.account_name}>{r.account_name || r.customer_name}</CustomerLink>
                        {r.last_renewal_expansion === 'Yes' && <Chip label="last: expansion" size="small" sx={{ ml: 0.5, height: 16, fontSize: 9, bgcolor: 'rgba(26, 158, 92, 0.15)', color: 'success.main' }} />}
                        {r.vip_legacy === 'Yes' && <Chip label="VIP" size="small" sx={{ ml: 0.5, height: 16, fontSize: 9, bgcolor: 'rgba(44, 115, 255, 0.18)', color: 'primary.main' }} />}
                      </TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.arr_up_for_renewal)}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: 'primary.main' }}>{lifetimeFmt}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{annualizedFmt}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: yoyColor, fontSize: 12 }}>
                        {r.orders_yoy_pct == null ? '—' : `${r.orders_yoy_pct >= 0 ? '+' : ''}${Math.round(r.orders_yoy_pct * 100)}%`}
                        {dropoffFlag && <Box component="span" sx={{ ml: 0.5, color: 'warning.main', fontSize: 10 }}>▲ cost drift</Box>}
                      </TableCell>
                      <TableCell align="center">
                        {r.risk_tier && (
                          <Chip label={String(r.risk_tier).toUpperCase()} size="small" sx={{ height: 18, fontSize: 10, bgcolor: tierColor + '22', color: tierColor, fontWeight: 600 }} />
                        )}
                      </TableCell>
                      <TableCell sx={{ fontSize: 11 }}>
                        <Chip label={r.action_tag} size="small" sx={{ height: 20, fontSize: 10.5, bgcolor: ACTION_COLOR[r.action_tag] + '22', color: ACTION_COLOR[r.action_tag], fontWeight: 600 }} />
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{r.owner_name || <Typography variant="caption" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>unassigned</Typography>}</TableCell>
                      <TableCell sx={{ fontSize: 10, color: 'text.secondary' }}>{isExpanded ? '▲' : '▼'}</TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow>
                        <TableCell colSpan={10} sx={{ bgcolor: 'rgba(0,0,0,0.02)', borderTop: '1px dashed', borderColor: tierColor }}>
                          <Stack spacing={2} sx={{ p: 1.5 }}>
                            <RenewalPanelContent row={r} />
                          </Stack>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>
    </Box>
  );
}

// ─── Clickable KPI tile ────────────────────────────────────────────────
function KpiTile({
  label,
  info,
  value,
  sub,
  accent,
  valueColor,
  active,
  onClick,
  isLoading,
}: {
  label: string;
  info: string;
  value: number | string | null | undefined;
  sub: string;
  accent?: string;
  valueColor?: string;
  active?: boolean;
  onClick?: () => void;
  isLoading: boolean;
}) {
  const clickable = !!onClick;
  return (
    <Grid item xs={12} sm={6} md={2} sx={{ display: 'flex' }}>
      <Paper
        onClick={onClick}
        sx={{
          p: 2,
          flexGrow: 1,
          cursor: clickable ? 'pointer' : 'default',
          borderLeft: accent ? '3px solid' : undefined,
          borderColor: accent,
          // Active state: filled background + thicker border for clear "this is the active filter" affordance.
          bgcolor: active ? 'action.selected' : undefined,
          outline: active ? '2px solid' : undefined,
          outlineColor: active ? (accent || 'primary.main') : undefined,
          outlineOffset: active ? '-2px' : undefined,
          transition: 'background-color 120ms, outline-color 120ms',
          '&:hover': clickable
            ? { bgcolor: active ? 'action.selected' : 'action.hover' }
            : undefined,
        }}
      >
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>{label}</Typography>
          <InfoIcon info={info} />
        </Stack>
        {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
          <>
            <Typography variant="h5" sx={{ fontWeight: 500, color: valueColor }}>{value ?? '—'}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{sub}</Typography>
          </>
        )}
      </Paper>
    </Grid>
  );
}

function metricFilterLabel(m: MetricFilter): string {
  switch (m) {
    case 'next_90d': return 'renewals in the next 90 days';
    case 'next_180d': return 'renewals in the next 180 days';
    case 'next_12mo': return 'renewals in the next 12 months';
    case 'expansion': return 'expansion opportunities';
    case 'contraction': return 'contraction risks';
    case 'dropoff': return 'ROI drop-offs';
    case 'no_renewal_date': return 'customers with no renewal date set';
    default: return '';
  }
}
