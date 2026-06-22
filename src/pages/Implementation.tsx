import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Cell,
} from 'recharts';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

// One row per customer with implementation activity. The team's north star is
// TIME TO FIRST ORDER: not-yet-launched customers are in INITIAL implementation
// (racing to first value); launched customers doing implementation work are
// doing CATALOG UPDATES. JIRA supplies stage; Harvest supplies hours + $.
type Row = {
  allmoxy_customer_id: number;
  name: string;
  customer_status: string | null;
  sign_up_date: string | null;
  first_payment_date: string | null;
  // launch / time-to-first-order
  launch_status: 'pre_launch' | 'launched' | 'unknown';
  is_launched: boolean | null;
  implementation_type: 'Initial implementation' | 'Catalog update' | 'Unknown';
  first_order_year: number | null;
  time_to_first_order_months: number | null;
  ttv_category: string | null;
  days_since_signup: number | null;
  // JIRA
  has_jira: boolean;
  jira_key: string | null;
  jira_url: string | null;
  stage: string | null;
  stage_category: string | null;
  assignee: string | null;
  // Harvest
  has_harvest: boolean;
  harvest_project_name: string | null;
  billing_method: string | null;
  hourly_rate: number | null;
  hours: number;
  billable_hours: number;
  billable_amount: number;
  last_entry: string | null;
  is_active: boolean;
};

type Aggregates = {
  total_customers: number;
  active: number;
  initial_implementation: number;
  catalog_update: number;
  unknown_launch: number;
  initial_overdue: number;
  initial_at_risk: number;
  initial_by_sla: { on_track: number; at_risk: number; overdue: number; unknown: number };
  stalled_gym_members: number;
  median_months_to_first_order: number | null;
  with_jira: number;
  with_harvest: number;
  total_hours: number;
  total_billable_amount: number;
  by_stage: Record<string, number>;
  jira_unmatched_count: number;
  jira_epics_total: number;
  jira_matched: number;
};

type Snapshot = {
  fetchedAt: string;
  aggregates: Aggregates;
  rows: Row[];
  unmatched_jira_epics?: Array<{ key: string; summary: string; stage: string | null }>;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const STAGE_ORDER = ['Stage 1: Discovery', 'Stage 2: Prototyping', 'Waiting on Customer', 'Done', 'On Hold / Abandoned'];
function stageColor(stage: string | null): string {
  if (!stage) return '#8B949E';
  if (/discovery/i.test(stage)) return '#2C73FF';
  if (/prototyp/i.test(stage)) return '#7C5CFF';
  if (/waiting/i.test(stage)) return '#F5A623';
  if (/done/i.test(stage)) return '#1A9E5C';
  if (/hold|abandon/i.test(stage)) return '#8B949E';
  return '#2C73FF';
}

// SLA against the 90-day first-order target, from sign-up. Computed live so the
// clock is always current (build only stores sign_up_date + a static snapshot).
const SLA_COLOR = { on_track: '#1A9E5C', at_risk: '#F5A623', overdue: '#D63A4D', unknown: '#8B949E' } as const;
type Sla = keyof typeof SLA_COLOR;
function daysSince(date: string | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}
function slaOf(days: number | null): Sla {
  if (days == null) return 'unknown';
  if (days > 90) return 'overdue';
  if (days >= 60) return 'at_risk';
  return 'on_track';
}

const TYPE_COLOR: Record<string, string> = {
  'Initial implementation': '#2C73FF',
  'Catalog update': '#8B949E',
  Unknown: '#8B949E',
};

type View = 'initial' | 'catalog' | 'all';
type SortKey = 'age' | 'name' | 'stage' | 'hours' | 'billable' | 'first_order';

export default function Implementation() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('implementation');
  const snap = data as Snapshot | undefined;
  const rows = snap?.rows ?? [];
  const agg = snap?.aggregates;

  // Default to the INITIAL implementation worklist — the time-to-first-order focus.
  const [view, setView] = useState<View>('initial');
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [slaFilter, setSlaFilter] = useState<Sla | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('age');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc'); }
  }

  const stageChart = useMemo(() => {
    const by = agg?.by_stage ?? {};
    return [...STAGE_ORDER.filter((s) => by[s] != null).map((s) => ({ stage: s, count: by[s] })),
      ...Object.keys(by).filter((s) => !STAGE_ORDER.includes(s)).map((s) => ({ stage: s, count: by[s] }))];
  }, [agg]);

  // Live SLA aging buckets for the pre-launch (initial) set.
  const initialRows = useMemo(() => rows.filter((r) => r.launch_status === 'pre_launch'), [rows]);
  const slaChart = useMemo(() => {
    const b: Record<Sla, number> = { on_track: 0, at_risk: 0, overdue: 0, unknown: 0 };
    for (const r of initialRows) b[slaOf(daysSince(r.sign_up_date))] += 1;
    return ([
      { key: 'on_track' as Sla, label: 'On track (<60d)', count: b.on_track },
      { key: 'at_risk' as Sla, label: 'At risk (60–90d)', count: b.at_risk },
      { key: 'overdue' as Sla, label: 'Overdue (>90d)', count: b.overdue },
      ...(b.unknown ? [{ key: 'unknown' as Sla, label: 'No sign-up date', count: b.unknown }] : []),
    ]);
  }, [initialRows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (view === 'initial' && r.launch_status !== 'pre_launch') return false;
    if (view === 'catalog' && r.launch_status !== 'launched') return false;
    if (stageFilter && r.stage !== stageFilter) return false;
    if (slaFilter && slaOf(daysSince(r.sign_up_date)) !== slaFilter) return false;
    return true;
  }), [rows, view, stageFilter, slaFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const stageRank = (r: Row) => { const i = STAGE_ORDER.indexOf(r.stage || ''); return i === -1 ? 99 : i; };
    out.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case 'age': av = daysSince(a.sign_up_date) ?? -1; bv = daysSince(b.sign_up_date) ?? -1; break;
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'stage': av = stageRank(a); bv = stageRank(b); break;
        case 'hours': av = a.hours; bv = b.hours; break;
        case 'billable': av = a.billable_amount; bv = b.billable_amount; break;
        case 'first_order': av = a.first_order_year ?? 0; bv = b.first_order_year ?? 0; break;
        default: av = 0; bv = 0;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  const csvColumns = useMemo(() => ([
    { key: 'customer', label: 'Customer', getValue: (r: Row) => r.name },
    { key: 'aid', label: 'Allmoxy ID', getValue: (r: Row) => r.allmoxy_customer_id },
    { key: 'type', label: 'Type', getValue: (r: Row) => r.implementation_type },
    { key: 'sign_up_date', label: 'Sign-up Date', getValue: (r: Row) => r.sign_up_date ?? '' },
    { key: 'days_since_signup', label: 'Days Since Sign-up', getValue: (r: Row) => daysSince(r.sign_up_date) ?? '' },
    { key: 'launched', label: 'Launched (first order)', getValue: (r: Row) => (r.is_launched == null ? 'unknown' : r.is_launched ? 'yes' : 'no') },
    { key: 'first_order_year', label: 'First Order Year', getValue: (r: Row) => r.first_order_year ?? '' },
    { key: 'ttfo_months', label: 'Time to First Order (mo, approx)', getValue: (r: Row) => r.time_to_first_order_months ?? '' },
    { key: 'stage', label: 'Stage', getValue: (r: Row) => r.stage ?? '' },
    { key: 'assignee', label: 'Owner', getValue: (r: Row) => r.assignee ?? '' },
    { key: 'hours', label: 'Hours', getValue: (r: Row) => r.hours },
    { key: 'billable_amount', label: 'Billable $', getValue: (r: Row) => r.billable_amount },
    { key: 'last_entry', label: 'Last Time Entry', getValue: (r: Row) => r.last_entry ?? '' },
    { key: 'jira', label: 'JIRA', getValue: (r: Row) => r.jira_key ?? '' },
  ]), []);

  return (
    <Box>
      <PageHeader
        title="Implementation Overview"
        subtitle="The implementation team's north star is time to first order. Customers who haven't placed a first verified live order are in initial implementation (racing to first value); already-launched customers doing implementation work are doing catalog updates. First-order target: 90 days from sign-up."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load implementation: {String(error)}</Alert>}

      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <KpiTile label="Initial implementations" info="Customers who have NOT yet placed a first verified live order — racing to first value. This is the team's focus list. Catalog-update (already launched) customers are split out separately." value={agg?.initial_implementation} sub="pre-first-order" accent="primary.main" valueColor="primary.main" isLoading={isLoading} />
        <KpiTile label="Overdue to first order" info="Initial-implementation customers more than 90 days past sign-up with still no first order. The most urgent worklist." value={agg?.initial_overdue} sub="> 90 days since sign-up" accent="error.main" valueColor="error.main" isLoading={isLoading} />
        <KpiTile label="Stalled (never launched)" info="Customers paying but who have never run a verified order ('gym members' in Time to Value). Long-tenured initial implementations that stalled." value={agg?.stalled_gym_members} sub="paying, no first order" accent="warning.main" valueColor="warning.main" isLoading={isLoading} />
        <KpiTile label="Median time to first order" info="Median time from sign-up to first verified live order, for launched customers. Approximate — Orders Verified live dates are year-granular." value={agg?.median_months_to_first_order != null ? `~${agg.median_months_to_first_order} mo` : '—'} sub="launched cohort (~year)" isLoading={isLoading} />
        <KpiTile label="Catalog updates" info="Already-launched customers with implementation work — catalog rebuilds/expansions, not first-time-to-value." value={agg?.catalog_update} sub="post-launch projects" isLoading={isLoading} />
        <KpiTile label="Billable services $" info="Billable hours × rate across all implementation projects (services revenue), both initial and catalog." value={agg ? USD0.format(agg.total_billable_amount) : undefined} sub={`${agg ? NUM.format(agg.total_hours) : '—'} hrs · all projects`} accent="success.main" valueColor="success.main" isLoading={isLoading} />
      </Grid>

      {/* View switch + chart. For the initial view, show the 90-day SLA aging;
          otherwise the JIRA stage funnel. */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={view}
            onChange={(_, v) => { if (v) { setView(v); setStageFilter(null); setSlaFilter(null); setSortKey(v === 'initial' ? 'age' : 'billable'); setSortDir('desc'); } }}
          >
            <ToggleButton value="initial">Initial ({agg?.initial_implementation ?? 0})</ToggleButton>
            <ToggleButton value="catalog">Catalog updates ({agg?.catalog_update ?? 0})</ToggleButton>
            <ToggleButton value="all">All ({agg?.total_customers ?? 0})</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {view === 'initial' ? 'Time to first order · 90-day SLA' : 'Implementation stage funnel'}
          </Typography>
          <InfoIcon info={view === 'initial'
            ? 'How long initial-implementation customers have gone since sign-up without a first order, bucketed against the 90-day target. Click a bar to filter the table.'
            : 'Count of customers at each JIRA implementation stage. Click a bar to filter the table.'} />
          {stageFilter && <Chip label={`Stage: ${stageFilter}`} size="small" onDelete={() => setStageFilter(null)} sx={{ height: 22, fontSize: 11 }} />}
          {slaFilter && <Chip label={`SLA: ${slaFilter}`} size="small" onDelete={() => setSlaFilter(null)} sx={{ height: 22, fontSize: 11 }} />}
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={240} /> : view === 'initial' ? (
          slaChart.every((s) => s.count === 0) ? <Empty text="No initial-implementation customers." /> : (
            <Box sx={{ height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={slaChart} layout="vertical" margin={{ top: 4, right: 24, left: 10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" horizontal={false} />
                  <XAxis type="number" stroke="#8B949E" fontSize={11} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" stroke="#8B949E" fontSize={11} width={120} />
                  <RTooltip contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} cursor={{ fill: 'rgba(44,115,255,0.06)' }} />
                  <Bar dataKey="count" name="Customers" cursor="pointer" onClick={(d: { key?: Sla }) => d?.key && setSlaFilter((p) => (p === d.key ? null : d.key!))}>
                    {slaChart.map((e) => <Cell key={e.key} fill={slaFilter && slaFilter !== e.key ? 'rgba(139,148,158,0.3)' : SLA_COLOR[e.key]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Box>
          )
        ) : stageChart.length === 0 ? <Empty text="No JIRA stages found." /> : (
          <Box sx={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={stageChart} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="stage" stroke="#8B949E" fontSize={11} interval={0} angle={-12} textAnchor="end" height={50} />
                <YAxis stroke="#8B949E" fontSize={11} width={36} allowDecimals={false} />
                <RTooltip contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} cursor={{ fill: 'rgba(44,115,255,0.06)' }} />
                <Bar dataKey="count" name="Customers" cursor="pointer" onClick={(d: { stage?: string }) => d?.stage && setStageFilter((p) => (p === d.stage ? null : d.stage!))}>
                  {stageChart.map((e) => <Cell key={e.stage} fill={stageFilter && stageFilter !== e.stage ? 'rgba(44,115,255,0.3)' : stageColor(e.stage)} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      <Paper sx={{ p: 0 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>{sorted.length} customer{sorted.length === 1 ? '' : 's'}</Typography>
          <CsvExportButton filename="implementation" columns={csvColumns} rows={sorted} />
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <SortTh label="Customer" k="name" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <TableCell>Type</TableCell>
                <SortTh label="Stage" k="stage" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <SortTh label={view === 'catalog' ? 'First order' : 'Time to first order'} k={view === 'catalog' ? 'first_order' : 'age'} {...{ sortKey, sortDir, onSort: toggleSort }} />
                <TableCell>Owner</TableCell>
                <SortTh label="Hours" k="hours" align="right" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <SortTh label="Billable $" k="billable" align="right" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <TableCell>JIRA</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => <TableRow key={i}><TableCell colSpan={8}><Skeleton variant="text" /></TableCell></TableRow>)
              ) : sorted.length === 0 ? (
                <TableRow><TableCell colSpan={8}><Empty text="No customers match the current view." /></TableCell></TableRow>
              ) : sorted.map((r) => {
                const days = daysSince(r.sign_up_date);
                const sla = slaOf(days);
                return (
                  <TableRow key={r.allmoxy_customer_id} hover>
                    <TableCell sx={{ fontWeight: 500 }}>
                      <CustomerLink id={r.allmoxy_customer_id} name={r.name} />
                      {r.ttv_category === 'gym_member' && <Chip label="stalled" size="small" sx={{ ml: 0.75, height: 16, fontSize: 9, bgcolor: 'rgba(245,166,35,0.18)', color: '#B07206' }} />}
                    </TableCell>
                    <TableCell>
                      <Chip label={r.implementation_type === 'Initial implementation' ? 'Initial' : r.implementation_type === 'Catalog update' ? 'Catalog' : 'Unknown'} size="small" sx={{ height: 20, fontSize: 10.5, fontWeight: 600, bgcolor: TYPE_COLOR[r.implementation_type] + '22', color: TYPE_COLOR[r.implementation_type] }} />
                    </TableCell>
                    <TableCell>
                      {r.stage ? <Chip label={r.stage} size="small" sx={{ height: 20, fontSize: 11, fontWeight: 600, bgcolor: stageColor(r.stage) + '22', color: stageColor(r.stage) }} />
                        : <Typography variant="caption" sx={{ color: 'text.disabled' }}>—</Typography>}
                    </TableCell>
                    <TableCell>
                      {r.launch_status === 'launched' ? (
                        <Typography variant="body2" sx={{ color: '#1A9E5C', fontWeight: 500 }}>
                          {r.first_order_year ? `Live ${r.first_order_year}` : 'Launched'}
                          {r.time_to_first_order_months != null && <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}> · ~{r.time_to_first_order_months}mo</Typography>}
                        </Typography>
                      ) : r.launch_status === 'pre_launch' ? (
                        <Stack direction="row" spacing={0.75} alignItems="baseline">
                          <Typography variant="body2" sx={{ color: SLA_COLOR[sla], fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{days != null ? `${days}d` : '—'}</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>since sign-up · no order yet</Typography>
                        </Stack>
                      ) : <Typography variant="caption" sx={{ color: 'text.disabled' }}>unknown</Typography>}
                      {r.sign_up_date && <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>signed up {r.sign_up_date.slice(0, 10)}</Typography>}
                    </TableCell>
                    <TableCell sx={{ fontSize: 13, color: 'text.secondary' }}>{r.assignee || '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.has_harvest ? NUM.format(r.hours) : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.has_harvest ? USD0.format(r.billable_amount) : '—'}</TableCell>
                    <TableCell>{r.jira_url && <Box component="a" href={r.jira_url} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 11, color: 'primary.light', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>{r.jira_key} ↗</Box>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      </Paper>

      {snap?.unmatched_jira_epics && snap.unmatched_jira_epics.length > 0 && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          <strong>{snap.unmatched_jira_epics.length} JIRA epic(s)</strong> couldn't be matched to a customer by name and are excluded:{' '}
          {snap.unmatched_jira_epics.map((e) => `${e.key} "${e.summary}"`).join(', ')}. Add them to <code>_etl_scripts/jira_customer_overrides.json</code> and rebuild.
        </Alert>
      )}
    </Box>
  );
}

function Empty({ text }: { text: string }) {
  return <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>{text}</Typography>;
}

function SortTh({ label, k, align, sortKey, sortDir, onSort }: { label: string; k: SortKey; align?: 'right'; sortKey: SortKey; sortDir: 'asc' | 'desc'; onSort: (k: SortKey) => void }) {
  return (
    <TableCell align={align} sortDirection={sortKey === k ? sortDir : false}>
      <TableSortLabel active={sortKey === k} direction={sortKey === k ? sortDir : 'asc'} onClick={() => onSort(k)}>{label}</TableSortLabel>
    </TableCell>
  );
}

function KpiTile({ label, info, value, sub, accent, valueColor, isLoading }: { label: string; info: string; value: number | string | null | undefined; sub: string; accent?: string; valueColor?: string; isLoading: boolean }) {
  return (
    <Grid item xs={12} sm={6} md={2} sx={{ display: 'flex' }}>
      <Paper sx={{ p: 2, flexGrow: 1, borderLeft: accent ? '3px solid' : undefined, borderColor: accent }}>
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
