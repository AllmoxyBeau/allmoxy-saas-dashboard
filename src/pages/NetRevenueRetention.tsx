import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Collapse from '@mui/material/Collapse';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, Legend } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import type { CsvColumn } from '../lib/csvExport';
import { useSheetTab } from '../hooks/useSheetTab';

type SubRow = { customer_name: string } & Record<string, number | string | null>;
type SubSnap = { rows: SubRow[]; columns: string[] };
type UeTtm = { windowEnd: string };
type UeSnap = { ttm: UeTtm };

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function pct(v: number | null, digits = 1) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}
function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

// Benchmark colors — industry standard bands.
// NRR > 100% is the line above which the business grows from existing customers alone.
function nrrColor(v: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (v == null) return 'text.primary';
  if (v >= 1.10) return 'success.main';
  if (v >= 1.00) return 'text.primary';
  if (v >= 0.90) return 'warning.main';
  return 'error.main';
}
function grrColor(v: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (v == null) return 'text.primary';
  if (v >= 0.90) return 'success.main';
  if (v >= 0.85) return 'text.primary';
  if (v >= 0.75) return 'warning.main';
  return 'error.main';
}

// One anchor month's NRR/GRR computation.
// Cohort = every customer with sub MRR > 0 at month M-N.
// NRR = (sum of those customers' MRR at month M) / (sum of their MRR at month M-N).
// GRR = (sum of min(end, start) per customer) / (sum of start).
// Expansion / Contraction / Churn $ decomposed from the same pool.
type AnchorBreakdown = {
  month: string;
  windowStart: string;
  cohortCount: number;
  starting_mrr: number;
  ending_mrr: number;
  expansion_mrr: number;
  contraction_mrr: number;
  churn_mrr: number;
  churn_count: number;
  expand_count: number;
  contract_count: number;
  hold_count: number;
  nrr: number | null;
  grr: number | null;
};

function val(r: SubRow, m: string): number {
  const v = r[m];
  return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
}

function computeBreakdown(rows: SubRow[], anchor: string, windowMonths: number, allMonths: string[]): AnchorBreakdown | null {
  const idx = allMonths.indexOf(anchor);
  if (idx < windowMonths) return null;
  const start = allMonths[idx - windowMonths];

  let starting = 0;
  let ending = 0;
  let expansion = 0;
  let contraction = 0;
  let churn = 0;
  let cohort = 0;
  let churnCount = 0;
  let expandCount = 0;
  let contractCount = 0;
  let holdCount = 0;

  for (const r of rows) {
    const s = val(r, start);
    if (s <= 0) continue;
    cohort += 1;
    starting += s;
    const e = val(r, anchor);
    ending += e;
    if (e === 0) {
      churn += s;
      churnCount += 1;
    } else if (e > s) {
      expansion += e - s;
      expandCount += 1;
    } else if (e < s) {
      contraction += s - e;
      contractCount += 1;
    } else {
      holdCount += 1;
    }
  }

  return {
    month: anchor,
    windowStart: start,
    cohortCount: cohort,
    starting_mrr: starting,
    ending_mrr: ending,
    expansion_mrr: expansion,
    contraction_mrr: contraction,
    churn_mrr: churn,
    churn_count: churnCount,
    expand_count: expandCount,
    contract_count: contractCount,
    hold_count: holdCount,
    nrr: starting > 0 ? ending / starting : null,
    grr: starting > 0 ? (ending - expansion) / starting : null,
  };
}

export default function NetRevenueRetention() {
  const { data: subData, isLoading: subLoading, error: subError } = useSheetTab('subscription_by_month');
  const { data: ueData } = useSheetTab('unit_economics');
  const sub = subData as unknown as SubSnap | undefined;
  const ue = ueData as unknown as UeSnap | undefined;

  const [windowMonths, setWindowMonths] = useState<3 | 6 | 12>(12);
  const [historyLen, setHistoryLen] = useState<24 | 36 | 60 | 'all'>(60);
  const anchorTable = useCollapse(true);

  // Sorted month column list.
  const allMonths = useMemo(() => {
    if (!sub) return [];
    return (sub.columns || []).filter((c) => /^\d{4}-\d{2}$/.test(c)).sort();
  }, [sub]);

  // Anchor at the latest complete month so the partial current month doesn't drag NRR down.
  const latestAnchor = useMemo(() => {
    if (!ue || !allMonths.length) return allMonths[allMonths.length - 1] ?? null;
    return ue.ttm?.windowEnd && allMonths.includes(ue.ttm.windowEnd) ? ue.ttm.windowEnd : allMonths[allMonths.length - 2] ?? null;
  }, [ue, allMonths]);

  // Anchor-month series: every month where a full window is available.
  const series = useMemo(() => {
    if (!sub || !latestAnchor) return [] as AnchorBreakdown[];
    const out: AnchorBreakdown[] = [];
    const lastIdx = allMonths.indexOf(latestAnchor);
    for (let i = windowMonths; i <= lastIdx; i++) {
      const b = computeBreakdown(sub.rows, allMonths[i], windowMonths, allMonths);
      if (b) out.push(b);
    }
    return out;
  }, [sub, allMonths, latestAnchor, windowMonths]);

  // History length applies to both chart and table. "all" shows every available anchor.
  const visibleSeries = useMemo(() => {
    if (historyLen === 'all') return series;
    return series.slice(-historyLen);
  }, [series, historyLen]);

  const seriesChart = useMemo(() => visibleSeries.map((b) => ({
    month: b.month,
    NRR: b.nrr != null ? Math.round(b.nrr * 1000) / 10 : null,
    GRR: b.grr != null ? Math.round(b.grr * 1000) / 10 : null,
  })), [visibleSeries]);

  const tableRows = useMemo(() => visibleSeries.slice().reverse(), [visibleSeries]);

  const latest = series.length > 0 ? series[series.length - 1] : null;

  // Per-customer breakdown anchored at the latest month — drives the expansion/contraction/churn lists.
  type Mover = { name: string; start: number; end: number; delta: number; type: 'expand' | 'contract' | 'churn' };
  const movers = useMemo(() => {
    if (!sub || !latest) return null as null | {
      expand: Mover[];
      contract: Mover[];
      churn: Mover[];
    };
    const rows = sub.rows;
    const expand: Mover[] = [];
    const contract: Mover[] = [];
    const churn: Mover[] = [];
    for (const r of rows) {
      const s = val(r, latest.windowStart);
      if (s <= 0) continue;
      const e = val(r, latest.month);
      const name = String(r.customer_name);
      if (e === 0) churn.push({ name, start: s, end: 0, delta: -s, type: 'churn' });
      else if (e > s) expand.push({ name, start: s, end: e, delta: e - s, type: 'expand' });
      else if (e < s) contract.push({ name, start: s, end: e, delta: e - s, type: 'contract' });
    }
    expand.sort((a, b) => b.delta - a.delta);
    contract.sort((a, b) => a.delta - b.delta);
    churn.sort((a, b) => a.delta - b.delta);
    return { expand, contract, churn };
  }, [sub, latest]);

  // CSVs for the trend table and the three mover lists.
  const seriesCsvColumns: CsvColumn<AnchorBreakdown>[] = [
    { key: 'month', label: 'Anchor month' },
    { key: 'windowStart', label: 'Window start' },
    { key: 'cohortCount', label: 'Cohort customers' },
    { key: 'starting_mrr', label: 'Starting MRR' },
    { key: 'ending_mrr', label: 'Ending MRR' },
    { key: 'expansion_mrr', label: 'Expansion $' },
    { key: 'contraction_mrr', label: 'Contraction $' },
    { key: 'churn_mrr', label: 'Churn $' },
    { key: 'churn_count', label: 'Churned customers' },
    { key: 'nrr', label: 'NRR' },
    { key: 'grr', label: 'GRR' },
  ];
  const moverCsv: CsvColumn<Mover>[] = [
    { key: 'name', label: 'Customer' },
    { key: 'start', label: 'MRR at window start' },
    { key: 'end', label: 'MRR at anchor month' },
    { key: 'delta', label: 'Delta MRR' },
    { key: 'type', label: 'Type' },
  ];

  return (
    <Box>
      <PageHeader
        title="Net Revenue Retention"
        subtitle="Of the MRR you had a year ago, how much is still here today? The single retention metric M&A buyers look at first."
        question="durable"
      />

      {subError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load subscription_by_month — {String(subError)}
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1} sx={{ mb: 2 }}>
        {latest ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Window: {monthLabel(latest.windowStart)} → {monthLabel(latest.month)} · {latest.cohortCount} cohort customers · {windowMonths}-month look-back
          </Typography>
        ) : (
          <span />
        )}
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5 }}>Look-back</Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={windowMonths}
            onChange={(_, v) => v && setWindowMonths(v as 3 | 6 | 12)}
            sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value={3}>3M</ToggleButton>
            <ToggleButton value={6}>6M</ToggleButton>
            <ToggleButton value={12}>12M</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" sx={{ color: 'text.secondary', ml: 1.5, mr: 0.5 }}>History</Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={historyLen}
            onChange={(_, v) => v && setHistoryLen(v as 24 | 36 | 60 | 'all')}
            sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value={24}>2y</ToggleButton>
            <ToggleButton value={36}>3y</ToggleButton>
            <ToggleButton value={60}>5y</ToggleButton>
            <ToggleButton value="all">All</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Stack>

      {/* Headline cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`NRR · ${windowMonths}M`}
            value={pct(latest?.nrr ?? null)}
            hint="Target ≥ 100% · best-in-class ≥ 120%"
            color={nrrColor(latest?.nrr ?? null)}
            loading={subLoading}
            info={<><strong>What it is:</strong> Net Revenue Retention — how much of the cohort's starting MRR is still being collected, including expansion. The buyer-facing retention metric.<br /><br /><strong>Data:</strong> Cohort = every customer with sub MRR &gt; 0 at the window-start month. NRR = (cohort's MRR at anchor month) ÷ (cohort's MRR at window-start month). Above 100% means the cohort grew net of churn; the business compounds without new logos.<br /><br /><strong>Benchmarks:</strong> ≥ 120% top-quartile · ≥ 100% healthy · &lt; 90% concerning.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`GRR · ${windowMonths}M`}
            value={pct(latest?.grr ?? null)}
            hint="Target ≥ 85% · best-in-class ≥ 90%"
            color={grrColor(latest?.grr ?? null)}
            loading={subLoading}
            info={<><strong>What it is:</strong> Gross Revenue Retention — same cohort, but expansion is excluded (capped at starting MRR per customer). Pure measure of "leakage" from the existing book.<br /><br /><strong>Data:</strong> GRR = (starting MRR − contraction $ − churn $) ÷ starting MRR. Always ≤ 100%.<br /><br /><strong>Why it matters:</strong> A high NRR fueled mostly by a few expansion accounts can mask wide churn — GRR exposes that.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Expansion · ${windowMonths}M`}
            value={latest ? USD_COMPACT.format(latest.expansion_mrr) : null}
            hint={latest ? `${latest.expand_count} customers grew` : 'loading'}
            color="success.main"
            loading={subLoading}
            info={<><strong>What it is:</strong> Total MRR added by surviving customers who upgraded over the window (positive delta).</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Contraction · ${windowMonths}M`}
            value={latest ? USD_COMPACT.format(latest.contraction_mrr) : null}
            hint={latest ? `${latest.contract_count} customers shrank` : 'loading'}
            color="warning.main"
            loading={subLoading}
            info={<><strong>What it is:</strong> MRR lost from surviving customers who downgraded — they still pay, but less.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Churn $ · ${windowMonths}M`}
            value={latest ? USD_COMPACT.format(latest.churn_mrr) : null}
            hint={latest ? `${latest.churn_count} customers left entirely` : 'loading'}
            color="error.main"
            loading={subLoading}
            info={<><strong>What it is:</strong> MRR lost from customers who went to zero. This + contraction = GRR leakage.</>}
          />
        </Grid>
      </Grid>

      {/* NRR + GRR trend chart */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            NRR &amp; GRR trend · {historyLen === 'all' ? `all ${series.length} anchor months` : `last ${historyLen} anchor months`}
          </Typography>
          <InfoIcon info={<><strong>What it is:</strong> Each point's value is the {windowMonths}-month retention computed against the cohort active {windowMonths} months earlier. Dashed line = 100% break-even.<br /><br /><strong>Read:</strong> NRR drifting upward = expansion outweighing churn. GRR drifting downward = book leak getting worse even if NRR stays put.</>} />
        </Stack>
        {subLoading ? (
          <Skeleton variant="rectangular" height={300} />
        ) : seriesChart.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Not enough monthly data to compute a {windowMonths}-month NRR window yet.
          </Typography>
        ) : (
          <Box sx={{ height: 300 }}>
            <ResponsiveContainer>
              <LineChart data={seriesChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                <YAxis stroke="#8B949E" fontSize={11} width={55} tickFormatter={(v) => `${v}%`} domain={['auto', 'auto']} />
                <ReferenceLine y={100} stroke="#8B949E" strokeDasharray="4 4" />
                <RTooltip
                  labelFormatter={(v) => monthLabel(String(v))}
                  formatter={(v: number, name) => [`${v.toFixed(1)}%`, name]}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                  labelStyle={{ color: '#FFFFFF' }}
                  itemStyle={{ color: '#FFFFFF' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="NRR" stroke="#2C73FF" strokeWidth={2} dot={{ r: 2.5, fill: '#2C73FF' }} connectNulls />
                <Line type="monotone" dataKey="GRR" stroke="#1A9E5C" strokeWidth={2} dot={{ r: 2.5, fill: '#1A9E5C' }} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Anchor-by-anchor table */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1} sx={{ mb: anchorTable.open ? 2 : 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CollapseToggle open={anchorTable.open} onToggle={anchorTable.toggle} label="retention by anchor month" />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Retention by anchor month · {windowMonths}-month look-back · {historyLen === 'all' ? `${series.length} months shown` : `last ${historyLen} months`}
            </Typography>
            <InfoIcon info={<><strong>How to read a row:</strong> "May 2025" with a 12-month window means: take every customer with subscription MRR &gt; 0 in May 2024 and see what they're paying now. The columns are that cohort's starting MRR, ending MRR, and the expansion / contraction / churn breakdown that explains the delta.</>} />
          </Stack>
          <CsvExportButton
            filename={`nrr_anchor_series_${windowMonths}m_${latest?.month ?? 'empty'}`}
            columns={seriesCsvColumns}
            rows={series}
            label="Export full series"
          />
        </Stack>
        <Collapse in={anchorTable.open} unmountOnExit>
        {subLoading ? (
          <Skeleton variant="rectangular" height={400} />
        ) : tableRows.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>No anchor months available.</Typography>
        ) : (
          <TableContainer sx={{ maxHeight: 540 }}>
            <Table size="small" stickyHeader sx={{ '& td, & th': { whiteSpace: 'nowrap' }, '& td': { fontVariantNumeric: 'tabular-nums' } }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ position: 'sticky', left: 0, zIndex: 3, bgcolor: 'background.paper' }}>Anchor month</TableCell>
                  <TableCell align="right">NRR</TableCell>
                  <TableCell align="right">GRR</TableCell>
                  <TableCell align="right">Starting MRR</TableCell>
                  <TableCell align="right">Ending MRR</TableCell>
                  <TableCell align="right">Expansion</TableCell>
                  <TableCell align="right">Contraction</TableCell>
                  <TableCell align="right">Churn $</TableCell>
                  <TableCell align="right">Cohort</TableCell>
                  <TableCell align="right">Churned</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((r) => (
                  <TableRow key={r.month} hover>
                    <TableCell sx={{ position: 'sticky', left: 0, zIndex: 1, bgcolor: 'background.paper', fontWeight: 500 }}>{monthLabel(r.month)}</TableCell>
                    <TableCell align="right" sx={{ color: nrrColor(r.nrr), fontWeight: 500 }}>{pct(r.nrr)}</TableCell>
                    <TableCell align="right" sx={{ color: grrColor(r.grr), fontWeight: 500 }}>{pct(r.grr)}</TableCell>
                    <TableCell align="right">{USD0.format(r.starting_mrr)}</TableCell>
                    <TableCell align="right">{USD0.format(r.ending_mrr)}</TableCell>
                    <TableCell align="right" sx={{ color: 'success.main' }}>{USD0.format(r.expansion_mrr)}</TableCell>
                    <TableCell align="right" sx={{ color: 'warning.main' }}>{USD0.format(r.contraction_mrr)}</TableCell>
                    <TableCell align="right" sx={{ color: 'error.main' }}>{USD0.format(r.churn_mrr)}</TableCell>
                    <TableCell align="right">{r.cohortCount}</TableCell>
                    <TableCell align="right">{r.churn_count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        </Collapse>
      </Paper>

      {/* Top movers driving the latest window's NRR */}
      {movers && latest && (
        <Grid container spacing={2}>
          <MoverTable
            title="Top expansion accounts"
            subtitle={`${movers.expand.length} accounts grew over the window · ${USD0.format(latest.expansion_mrr)} total expansion`}
            rows={movers.expand.slice(0, 15)}
            color="success.main"
            csvAll={movers.expand}
            csvName={`nrr_expansion_${latest.month}`}
            csvCols={moverCsv}
            windowStartLabel={monthLabel(latest.windowStart)}
            anchorLabel={monthLabel(latest.month)}
          />
          <MoverTable
            title="Top contraction accounts"
            subtitle={`${movers.contract.length} accounts shrank · ${USD0.format(latest.contraction_mrr)} total contraction`}
            rows={movers.contract.slice(0, 15)}
            color="warning.main"
            csvAll={movers.contract}
            csvName={`nrr_contraction_${latest.month}`}
            csvCols={moverCsv}
            windowStartLabel={monthLabel(latest.windowStart)}
            anchorLabel={monthLabel(latest.month)}
          />
          <MoverTable
            title="Churned accounts"
            subtitle={`${movers.churn.length} accounts left entirely · ${USD0.format(latest.churn_mrr)} total churn`}
            rows={movers.churn.slice(0, 15)}
            color="error.main"
            csvAll={movers.churn}
            csvName={`nrr_churn_${latest.month}`}
            csvCols={moverCsv}
            windowStartLabel={monthLabel(latest.windowStart)}
            anchorLabel={monthLabel(latest.month)}
          />
        </Grid>
      )}
    </Box>
  );
}

function MoverTable({
  title,
  subtitle,
  rows,
  color,
  csvAll,
  csvName,
  csvCols,
  windowStartLabel,
  anchorLabel,
}: {
  title: string;
  subtitle: string;
  rows: Array<{ name: string; start: number; end: number; delta: number }>;
  color: string;
  csvAll: Array<{ name: string; start: number; end: number; delta: number; type: 'expand' | 'contract' | 'churn' }>;
  csvName: string;
  csvCols: CsvColumn<{ name: string; start: number; end: number; delta: number; type: 'expand' | 'contract' | 'churn' }>[];
  windowStartLabel: string;
  anchorLabel: string;
}) {
  const collapse = useCollapse(true);
  return (
    <Grid item xs={12} md={4}>
      <Paper sx={{ p: 2.5, height: '100%' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 0.5 }}>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <CollapseToggle open={collapse.open} onToggle={collapse.toggle} label={title} />
            <Typography variant="subtitle2" sx={{ color, fontWeight: 600 }}>{title}</Typography>
          </Stack>
          <CsvExportButton filename={csvName} columns={csvCols} rows={csvAll} label="CSV" />
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>{subtitle}</Typography>
        <Collapse in={collapse.open} unmountOnExit>
        {rows.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>None this window.</Typography>
        ) : (
          <TableContainer>
            <Table size="small" sx={{ '& td, & th': { whiteSpace: 'nowrap', fontSize: 12 }, '& td': { fontVariantNumeric: 'tabular-nums' } }}>
              <TableHead>
                <TableRow>
                  <TableCell>Customer</TableCell>
                  <TableCell align="right" title={windowStartLabel}>Start</TableCell>
                  <TableCell align="right" title={anchorLabel}>Now</TableCell>
                  <TableCell align="right">Δ MRR</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.name}>
                    <TableCell sx={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</TableCell>
                    <TableCell align="right">{USD0.format(r.start)}</TableCell>
                    <TableCell align="right">{USD0.format(r.end)}</TableCell>
                    <TableCell align="right" sx={{ color, fontWeight: 500 }}>
                      {r.delta >= 0 ? '+' : ''}{USD0.format(r.delta)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        </Collapse>
      </Paper>
    </Grid>
  );
}

function StatCard({
  label,
  value,
  hint,
  color,
  loading,
  info,
}: {
  label: string;
  value: string | null;
  hint: string;
  color: string;
  loading?: boolean;
  info?: React.ReactNode;
}) {
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 0.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label}
        </Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      {loading || value == null ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 32 }} />
      ) : (
        <Typography variant="h4" sx={{ fontWeight: 500, color }}>{value}</Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 11 }}>
        {hint}
      </Typography>
    </Paper>
  );
}
