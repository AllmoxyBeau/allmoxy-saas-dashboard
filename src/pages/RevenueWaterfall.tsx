import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Collapse from '@mui/material/Collapse';
import { ResponsiveContainer, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, Line, ComposedChart } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import { useSheetTab } from '../hooks/useSheetTab';

type NewDetail = { name: string; mrr: number };
type ChurnDetail = { name: string; mrr: number };
type ChangeDetail = { name: string; prev_mrr: number; new_mrr: number; delta: number };
type MonthlyDetails = {
  new: NewDetail[];
  reactivated?: NewDetail[];
  expansion: ChangeDetail[];
  contraction: ChangeDetail[];
  churn: ChurnDetail[];
};

type MonthlyRow = {
  month: string;
  starting_mrr: number;
  new_mrr: number;
  reactivated_mrr?: number;
  expansion_mrr: number;
  contraction_mrr: number;
  churn_mrr: number;
  ending_mrr: number;
  net_new_mrr: number;
  new_logos: number;
  reactivated_logos?: number;
  churned_logos: number;
  gross_churn_rate_monthly: number | null;
  net_churn_rate_monthly: number | null;
  expansion_rate_monthly: number | null;
  grr_monthly: number | null;
  nrr_monthly: number | null;
  quick_ratio: number | null;
  details: MonthlyDetails;
};

type DrillCategory = 'new' | 'reactivated' | 'expansion' | 'contraction' | 'churn';

type WaterfallSnapshot = {
  monthly: MonthlyRow[];
  ttm: {
    windowStart: string;
    windowEnd: string;
    starting_mrr: number;
    ending_mrr: number;
    new_mrr: number;
    reactivated_mrr?: number;
    expansion_mrr: number;
    contraction_mrr: number;
    churn_mrr: number;
    net_new_mrr: number;
    gross_mrr_churn_ttm: number | null;
    annual_gross_churn_rate: number | null;
    annual_grr: number | null;
    annual_nrr: number | null;
    quick_ratio: number | null;
  };
  notes: string;
};

type Preset = '12M' | '24M' | '60M' | 'ALL' | 'CUSTOM';

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function pct(v: number | null, digits = 1) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}
function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
function monthLabelLong(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function addMonths(iso: string, delta: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nrrColor(v: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (v == null) return 'text.primary';
  if (v >= 1.1) return 'success.main';
  if (v >= 1.0) return 'warning.main';
  return 'error.main';
}
function grrColor(v: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (v == null) return 'text.primary';
  if (v >= 0.9) return 'success.main';
  if (v >= 0.8) return 'warning.main';
  return 'error.main';
}
function quickRatioColor(v: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (v == null) return 'text.primary';
  if (v >= 4) return 'success.main';
  if (v >= 2) return 'warning.main';
  return 'error.main';
}

export default function RevenueWaterfall() {
  const [source, setSource] = useState<'qb' | 'txns'>('qb');
  const { data: qbData, isLoading: qbLoading, error: qbError } = useSheetTab('mrr_waterfall');
  const { data: txnData, isLoading: txnLoading, error: txnError } = useSheetTab('mrr_waterfall_txns');
  const qbSnap = qbData as unknown as WaterfallSnapshot | undefined;
  const txnSnap = txnData as unknown as WaterfallSnapshot | undefined;
  const snap = source === 'txns' ? txnSnap : qbSnap;
  const isLoading = source === 'txns' ? txnLoading : qbLoading;
  const error = source === 'txns' ? txnError : qbError;

  const [preset, setPreset] = useState<Preset>('12M');
  const [fromMonth, setFromMonth] = useState<string>('');
  const [toMonth, setToMonth] = useState<string>('');
  const [headerWindow, setHeaderWindow] = useState<'3M' | '6M' | '12M'>('12M');
  const monthlyTable = useCollapse(true);
  const [drill, setDrill] = useState<{ month: string; category: DrillCategory } | null>(null);

  function openDrill(month: string, category: DrillCategory) {
    setDrill({ month, category });
    setTimeout(() => {
      document.getElementById('drill-down-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  const monthly = snap?.monthly ?? [];
  const firstMonth = monthly[0]?.month;
  const lastMonth = monthly[monthly.length - 1]?.month;

  // Init range from preset
  useMemo(() => {
    if (!firstMonth || !lastMonth || preset === 'CUSTOM') return;
    const end = lastMonth;
    const max = (a: string, b: string) => (a > b ? a : b);
    const start =
      preset === 'ALL'
        ? firstMonth
        : preset === '60M'
          ? max(firstMonth, addMonths(end, -59))
          : preset === '24M'
            ? max(firstMonth, addMonths(end, -23))
            : max(firstMonth, addMonths(end, -11));
    setFromMonth(start);
    setToMonth(end);
  }, [preset, firstMonth, lastMonth]);

  const visible = useMemo(() => {
    if (!fromMonth || !toMonth) return [];
    return monthly
      .filter((r) => r.month >= fromMonth && r.month <= toMonth)
      .map((r) => ({
        ...r,
        neg_contraction: -r.contraction_mrr,
        neg_churn: -r.churn_mrr,
      }));
  }, [monthly, fromMonth, toMonth]);

  // Header card stats computed over the user-selected trailing window.
  // All rates are annualized so 3M / 6M / 12M views stay apples-to-apples.
  const headerStats = useMemo(() => {
    if (monthly.length === 0) return null;
    const N = headerWindow === '3M' ? 3 : headerWindow === '6M' ? 6 : 12;
    const rows = monthly.slice(-N);
    if (rows.length === 0) return null;
    const starting = rows[0].starting_mrr;
    const ending = rows[rows.length - 1].ending_mrr;
    const sum = (k: 'new_mrr' | 'reactivated_mrr' | 'expansion_mrr' | 'contraction_mrr' | 'churn_mrr') =>
      rows.reduce((a, r) => a + ((r as MonthlyRow)[k] ?? 0), 0);
    const new_mrr = sum('new_mrr');
    const reactivated = sum('reactivated_mrr');
    const expansion = sum('expansion_mrr');
    const contraction = sum('contraction_mrr');
    const churn = sum('churn_mrr');
    const net_new = new_mrr + reactivated + expansion - contraction - churn;
    const windowGrr = starting > 0 ? (starting - churn - contraction) / starting : null;
    const windowNrr = starting > 0 ? (starting - churn - contraction + expansion) / starting : null;
    const windowGrossChurn = starting > 0 ? churn / starting : null;
    const exp = 12 / N;
    const annualize = (v: number | null) => (v == null ? null : Math.pow(Math.max(v, 0), exp));
    const annual_grr = annualize(windowGrr);
    const annual_nrr = annualize(windowNrr);
    const annual_gross_churn_rate =
      windowGrossChurn == null ? null : 1 - Math.pow(Math.max(1 - windowGrossChurn, 0), exp);
    const quick_ratio = churn + contraction > 0 ? (new_mrr + reactivated + expansion) / (churn + contraction) : null;
    return {
      windowStart: rows[0].month,
      windowEnd: rows[rows.length - 1].month,
      windowMonths: rows.length,
      starting_mrr: starting,
      ending_mrr: ending,
      new_mrr,
      reactivated_mrr: reactivated,
      expansion_mrr: expansion,
      contraction_mrr: contraction,
      churn_mrr: churn,
      net_new_mrr: net_new,
      annual_grr,
      annual_nrr,
      annual_gross_churn_rate,
      quick_ratio,
    };
  }, [monthly, headerWindow]);

  return (
    <Box>
      <PageHeader
        title="Revenue Waterfall"
        subtitle="See exactly how MRR moved each month — new wins, expansion, contraction, and churn broken out, so you can spot the drivers and intervene early."
        question="healthy"
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load mrr_waterfall — {String(error)}
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1} sx={{ mb: 2 }}>
        {headerStats ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {headerWindow} window: {monthLabelLong(headerStats.windowStart)} – {monthLabelLong(headerStats.windowEnd)} · rates annualized for comparability · source: {source === 'txns' ? 'Stripe transactions' : 'QuickBooks MRR by Month'}
          </Typography>
        ) : (
          <span />
        )}
        <Stack direction="row" spacing={1}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={source}
            onChange={(_, v) => v && setSource(v as 'qb' | 'txns')}
            sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="qb" title="QuickBooks-derived MRR by Month tab (current source of truth)">QB</ToggleButton>
            <ToggleButton value="txns" title="Built directly from Stripe Sync transactions, post-overrides">Stripe txns</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={headerWindow}
            onChange={(_, v) => v && setHeaderWindow(v as '3M' | '6M' | '12M')}
            sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="3M">Trailing 3M</ToggleButton>
            <ToggleButton value="6M">Trailing 6M</ToggleButton>
            <ToggleButton value="12M">Trailing 12M</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Stack>

      {/* Header cards — annualized for whichever window is selected */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Net new MRR · ${headerWindow}`}
            value={headerStats ? USD0.format(headerStats.net_new_mrr) : null}
            hint={headerStats ? `${USD0.format(headerStats.starting_mrr)} → ${USD0.format(headerStats.ending_mrr)}` : 'loading'}
            color={headerStats && headerStats.net_new_mrr >= 0 ? 'success.main' : 'error.main'}
            loading={isLoading}
            info={<><strong>What it is:</strong> Net change in MRR over the selected trailing window.<br /><br /><strong>Data:</strong> Sum of monthly New + Expansion − Contraction − Churn across the last {headerWindow === '3M' ? 3 : headerWindow === '6M' ? 6 : 12} months.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Annualized NRR · ${headerWindow}`}
            value={pct(headerStats?.annual_nrr ?? null)}
            hint="Target ≥ 110%"
            color={nrrColor(headerStats?.annual_nrr ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> Net Revenue Retention — of every $1 of MRR existing customers were paying at the start of the window, how many cents they're paying now (expansion in, contraction/churn out). Does NOT include new logos.<br /><br /><strong>Data:</strong> Window NRR = (Starting − Churn − Contraction + Expansion) ÷ Starting, then annualized by raising to 12/N.<br /><br /><strong>Why toggle:</strong> 3M vs 12M reveals trajectory — if 3M &lt; 12M, recent retention is softening.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Annualized GRR · ${headerWindow}`}
            value={pct(headerStats?.annual_grr ?? null)}
            hint="Target ≥ 90%"
            color={grrColor(headerStats?.annual_grr ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> Gross Revenue Retention — what % of starting MRR survives (no expansion credit).<br /><br /><strong>Data:</strong> Window GRR = (Starting − Churn − Contraction) ÷ Starting, annualized.<br /><br /><strong>Target:</strong> ≥ 90% top-quartile · ≥ 80% acceptable</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Quick ratio · ${headerWindow}`}
            value={headerStats?.quick_ratio != null ? `${headerStats.quick_ratio.toFixed(2)}x` : '—'}
            hint="(New + Expansion) ÷ (Contraction + Churn) · Target ≥ 4x"
            color={quickRatioColor(headerStats?.quick_ratio ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> Growth-durability ratio over the selected window — dollars of MRR added per dollar lost.<br /><br /><strong>Data:</strong> (Window New + Expansion) ÷ (Window Contraction + Churn). Not annualized (it's a ratio).<br /><br /><strong>Target:</strong> ≥ 4x strong · 2–4x acceptable · &lt; 2x warning</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Annual MRR churn · ${headerWindow}`}
            value={pct(headerStats?.annual_gross_churn_rate ?? null)}
            hint={headerStats ? `${USD0.format(headerStats.churn_mrr)} lost in window` : 'loading'}
            color={grrColor(headerStats?.annual_grr ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> Annualized gross MRR lost to full customer churn (contraction excluded).<br /><br /><strong>Data:</strong> Window churn rate = Churn ÷ Starting, annualized as 1 − (1 − rate)^(12/N).<br /><br /><strong>Target:</strong> ≤ 10% good · ≤ 20% acceptable</>}
          />
        </Grid>
      </Grid>

      {/* Waterfall chart */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', md: 'center' }}
          spacing={2}
          sx={{ mb: 2 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Monthly MRR movement · bars above = growth · bars below = shrinkage
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> The MRR bridge — how each month's ending MRR gets from the previous month's ending MRR.<br /><br /><strong>Data:</strong> For each customer × month in the MRR by Month tab, classify the change vs. prior month: New (0→&gt;0) · Churn (&gt;0→0) · Expansion (cur&gt;prev) · Contraction (cur&lt;prev). Stream is subscription only.<br /><br /><strong>White line</strong> = Net new MRR (the resulting $ change that month). <strong>Click any bar segment</strong> to see the contributing customers.</>} />
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={preset}
              onChange={(_, v) => v && setPreset(v as Preset)}
              sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
            >
              <ToggleButton value="12M">12M</ToggleButton>
              <ToggleButton value="24M">24M</ToggleButton>
              <ToggleButton value="60M">5Y</ToggleButton>
              <ToggleButton value="ALL">All</ToggleButton>
            </ToggleButtonGroup>
            <Stack direction="row" spacing={1} alignItems="center">
              <Select
                size="small"
                value={fromMonth || ''}
                onChange={(e) => { setPreset('CUSTOM'); const v = e.target.value; setFromMonth(v); if (toMonth && v > toMonth) setToMonth(v); }}
                sx={{ minWidth: 110, fontSize: 12 }}
                MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
                disabled={!monthly.length}
              >
                {monthly.map((r) => (
                  <MenuItem key={r.month} value={r.month} sx={{ fontSize: 12 }}>{monthLabel(r.month)}</MenuItem>
                ))}
              </Select>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>to</Typography>
              <Select
                size="small"
                value={toMonth || ''}
                onChange={(e) => { setPreset('CUSTOM'); const v = e.target.value; setToMonth(v); if (fromMonth && v < fromMonth) setFromMonth(v); }}
                sx={{ minWidth: 110, fontSize: 12 }}
                MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
                disabled={!monthly.length}
              >
                {monthly.map((r) => (
                  <MenuItem key={r.month} value={r.month} sx={{ fontSize: 12 }}>{monthLabel(r.month)}</MenuItem>
                ))}
              </Select>
            </Stack>
          </Stack>
        </Stack>

        {isLoading ? (
          <Skeleton variant="rectangular" height={340} />
        ) : (
          <Box sx={{ height: 340 }}>
            <ResponsiveContainer>
              <ComposedChart data={visible} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} stackOffset="sign">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                <YAxis stroke="#8B949E" fontSize={11} width={55} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <ReferenceLine y={0} stroke="#8B949E" />
                <RTooltip
                  labelFormatter={(v) => monthLabelLong(String(v))}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                  formatter={(v: number, name: string) => {
                    const absVal = Math.abs(v);
                    const labels: Record<string, string> = {
                      new_mrr: 'New',
                      reactivated_mrr: 'Reactivated',
                      expansion_mrr: 'Expansion',
                      neg_contraction: 'Contraction',
                      neg_churn: 'Churn',
                      net_new_mrr: 'Net new',
                    };
                    return [USD0.format(absVal), labels[name] ?? name];
                  }}
                />
                <Bar dataKey="new_mrr" stackId="movement" fill="#1A9E5C" name="new_mrr" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'new')} />
                <Bar dataKey="reactivated_mrr" stackId="movement" fill="#9F7AEA" name="reactivated_mrr" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'reactivated')} />
                <Bar dataKey="expansion_mrr" stackId="movement" fill="#2C73FF" name="expansion_mrr" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'expansion')} />
                <Bar dataKey="neg_contraction" stackId="movement" fill="#F59E0B" name="neg_contraction" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'contraction')} />
                <Bar dataKey="neg_churn" stackId="movement" fill="#DA3633" name="neg_churn" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'churn')} />
                <Line type="monotone" dataKey="net_new_mrr" stroke="#E6EDF3" strokeWidth={2} dot={{ r: 2.5, fill: '#E6EDF3' }} name="net_new_mrr" />
              </ComposedChart>
            </ResponsiveContainer>
          </Box>
        )}
        <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
          <LegendSwatch color="#1A9E5C" label="New MRR" />
          <LegendSwatch color="#9F7AEA" label="Reactivated" />
          <LegendSwatch color="#2C73FF" label="Expansion" />
          <LegendSwatch color="#F59E0B" label="Contraction" />
          <LegendSwatch color="#DA3633" label="Churn" />
          <LegendSwatch color="#E6EDF3" label="Net new (line)" />
        </Stack>
      </Paper>

      {/* Month-by-month table — uses the same date filter as the chart above. Newest first. */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: monthlyTable.open ? 2 : 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CollapseToggle open={monthlyTable.open} onToggle={monthlyTable.toggle} label="month-by-month detail" />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Month-by-month detail
              {fromMonth && toMonth ? ` · ${monthLabelLong(fromMonth)} → ${monthLabelLong(toMonth)} (${visible.length} months)` : ''}
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> The waterfall in table form, with NRR and Quick Ratio computed for each month. Range matches the chart filter above — change the preset / custom dates to expand or narrow the view. Sorted newest first.<br /><br /><strong>Data:</strong> Same source as the chart above (per-customer MRR deltas from the MRR by Month tab). NRR = (Starting − Churn − Contraction + Expansion) ÷ Starting. Quick = (New + Expansion) ÷ (Contraction + Churn).<br /><br /><strong>Click any dollar cell</strong> (New / Reactiv. / Exp / Contr / Churn) to drill into the customers that drove it.</>} />
          </Stack>
          {snap && (
            <CsvExportButton
              filename={`revenue_waterfall_${fromMonth ?? ''}_to_${toMonth ?? ''}`}
              columns={[
                { key: 'month', label: 'Month' },
                { key: 'starting_mrr', label: 'Starting MRR' },
                { key: 'new_mrr', label: 'New MRR' },
                { key: 'reactivated_mrr', label: 'Reactivated MRR', getValue: (r) => r.reactivated_mrr ?? 0 },
                { key: 'expansion_mrr', label: 'Expansion MRR' },
                { key: 'contraction_mrr', label: 'Contraction MRR' },
                { key: 'churn_mrr', label: 'Churn MRR' },
                { key: 'net_new_mrr', label: 'Net new MRR' },
                { key: 'ending_mrr', label: 'Ending MRR' },
                { key: 'new_logos', label: 'New logos' },
                { key: 'reactivated_logos', label: 'Reactivated logos', getValue: (r) => r.reactivated_logos ?? 0 },
                { key: 'churned_logos', label: 'Churned logos' },
                { key: 'gross_churn_rate_monthly', label: 'Gross churn (mo)' },
                { key: 'nrr_monthly', label: 'NRR (mo)' },
                { key: 'grr_monthly', label: 'GRR (mo)' },
                { key: 'quick_ratio', label: 'Quick ratio' },
              ]}
              rows={snap.monthly.filter((r) => fromMonth && toMonth && r.month >= fromMonth && r.month <= toMonth).slice().reverse()}
            />
          )}
        </Stack>
        <Collapse in={monthlyTable.open} unmountOnExit>
        {isLoading || !snap ? (
          <Skeleton variant="rectangular" height={400} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Month</TableCell>
                <TableCell align="right">Starting</TableCell>
                <TableCell align="right">+ New</TableCell>
                <TableCell align="right">+ Reactiv.</TableCell>
                <TableCell align="right">+ Exp.</TableCell>
                <TableCell align="right">− Contr.</TableCell>
                <TableCell align="right">− Churn</TableCell>
                <TableCell align="right">Net new</TableCell>
                <TableCell align="right">Ending</TableCell>
                <TableCell align="right">NRR</TableCell>
                <TableCell align="right">Quick</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {snap.monthly
                .filter((r) => fromMonth && toMonth && r.month >= fromMonth && r.month <= toMonth)
                .slice()
                .reverse()
                .map((r) => {
                const hoverCell = { cursor: 'pointer', '&:hover': { bgcolor: 'rgba(44, 115, 255, 0.08)' } } as const;
                return (
                  <TableRow key={r.month}>
                    <TableCell sx={{ fontWeight: 500 }}>{monthLabel(r.month)}</TableCell>
                    <TableCell align="right" sx={{ color: 'text.secondary' }}>
                      {USD0.format(r.starting_mrr)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: 'success.main', ...hoverCell }} onClick={() => openDrill(r.month, 'new')}>
                      {USD0.format(r.new_mrr)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: '#9F7AEA', ...hoverCell }} onClick={() => openDrill(r.month, 'reactivated')}>
                      {USD0.format(r.reactivated_mrr ?? 0)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: 'primary.main', ...hoverCell }} onClick={() => openDrill(r.month, 'expansion')}>
                      {USD0.format(r.expansion_mrr)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: 'warning.main', ...hoverCell }} onClick={() => openDrill(r.month, 'contraction')}>
                      −{USD0.format(r.contraction_mrr)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: 'error.main', ...hoverCell }} onClick={() => openDrill(r.month, 'churn')}>
                      −{USD0.format(r.churn_mrr)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: r.net_new_mrr >= 0 ? 'success.main' : 'error.main', fontWeight: 500 }}>
                      {r.net_new_mrr >= 0 ? '+' : '−'}{USD0.format(Math.abs(r.net_new_mrr))}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 500 }}>{USD0.format(r.ending_mrr)}</TableCell>
                    <TableCell align="right" sx={{ color: r.nrr_monthly != null && r.nrr_monthly >= 1 ? 'success.main' : 'warning.main' }}>
                      {pct(r.nrr_monthly, 2)}
                    </TableCell>
                    <TableCell align="right" sx={{ color: quickRatioColor(r.quick_ratio) }}>
                      {r.quick_ratio != null ? `${r.quick_ratio.toFixed(2)}x` : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1, fontStyle: 'italic' }}>
          Click any New / Expansion / Contraction / Churn value (in the table or chart) to see the contributing customers.
        </Typography>
        </Collapse>
      </Paper>

      {drill && snap && (() => {
        const row = snap.monthly.find((r) => r.month === drill.month);
        if (!row) return null;
        const { category, month } = drill;
        const title =
          category === 'new' ? 'New MRR'
          : category === 'reactivated' ? 'Reactivated MRR'
          : category === 'expansion' ? 'Expansion MRR'
          : category === 'contraction' ? 'Contraction MRR'
          : 'Churn MRR';
        const total =
          category === 'new' ? row.new_mrr
          : category === 'reactivated' ? (row.reactivated_mrr ?? 0)
          : category === 'expansion' ? row.expansion_mrr
          : category === 'contraction' ? row.contraction_mrr
          : row.churn_mrr;
        const accent =
          category === 'new' ? 'rgba(26, 158, 92, 0.5)'
          : category === 'reactivated' ? 'rgba(159, 122, 234, 0.5)'
          : category === 'expansion' ? 'rgba(44, 115, 255, 0.5)'
          : category === 'contraction' ? 'rgba(245, 158, 11, 0.5)'
          : 'rgba(218, 54, 51, 0.5)';
        const count =
          category === 'new' ? row.details.new.length
          : category === 'reactivated' ? (row.details.reactivated?.length ?? 0)
          : category === 'expansion' ? row.details.expansion.length
          : category === 'contraction' ? row.details.contraction.length
          : row.details.churn.length;
        const subtitle = `${category === 'contraction' || category === 'churn' ? '−' : '+'}${USD0.format(total)} across ${count} customer${count === 1 ? '' : 's'} · click to reconcile against the sheet`;

        if (category === 'new' || category === 'reactivated' || category === 'churn') {
          const rows =
            category === 'new' ? row.details.new
            : category === 'reactivated' ? (row.details.reactivated ?? [])
            : row.details.churn;
          const columns: DrillColumn<NewDetail | ChurnDetail>[] = [
            { key: 'name', label: 'Customer' },
            { key: 'mrr', label: category === 'churn' ? 'MRR lost' : 'MRR added', align: 'right', render: (r) => USD0.format(r.mrr) },
            {
              key: 'pct',
              label: `% of ${title}`,
              align: 'right',
              render: (r) => (total > 0 ? `${((r.mrr / total) * 100).toFixed(1)}%` : '—'),
              exportValue: (r) => (total > 0 ? r.mrr / total : 0),
            },
          ];
          return (
            <DrillDownPanel
              title={`${title} · ${monthLabelLong(month)}`}
              subtitle={subtitle}
              accent={accent}
              rows={rows as unknown as Array<Record<string, unknown>>}
              columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
              filename={`mrr_${category}_${month}`}
              onClose={() => setDrill(null)}
            />
          );
        }

        const rows = category === 'expansion' ? row.details.expansion : row.details.contraction;
        const columns: DrillColumn<ChangeDetail>[] = [
          { key: 'name', label: 'Customer' },
          { key: 'prev_mrr', label: 'Prior month MRR', align: 'right', render: (r) => USD0.format(r.prev_mrr) },
          { key: 'new_mrr', label: `${monthLabel(month)} MRR`, align: 'right', render: (r) => USD0.format(r.new_mrr) },
          { key: 'delta', label: category === 'expansion' ? 'Increase' : 'Decrease', align: 'right', render: (r) => `${category === 'contraction' ? '−' : '+'}${USD0.format(r.delta)}` },
          {
            key: 'pct',
            label: `% of ${title}`,
            align: 'right',
            render: (r) => (total > 0 ? `${((r.delta / total) * 100).toFixed(1)}%` : '—'),
            exportValue: (r) => (total > 0 ? r.delta / total : 0),
          },
        ];
        return (
          <DrillDownPanel
            title={`${title} · ${monthLabelLong(month)}`}
            subtitle={subtitle}
            accent={accent}
            rows={rows as unknown as Array<Record<string, unknown>>}
            columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
            filename={`mrr_${category}_${month}`}
            onClose={() => setDrill(null)}
          />
        );
      })()}

      <ReconcilePanel qb={qbSnap} txn={txnSnap} fromMonth={fromMonth} toMonth={toMonth} />
    </Box>
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
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label}
        </Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      {loading || value == null ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 32 }} />
      ) : (
        <Typography variant="h4" sx={{ fontWeight: 500, color, mt: 0.5 }}>
          {value}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 11 }}>
        {hint}
      </Typography>
    </Paper>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box sx={{ width: 14, height: 14, bgcolor: color, borderRadius: 0.5 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
        {label}
      </Typography>
    </Stack>
  );
}

// Side-by-side reconciliation between QB-driven and transaction-driven waterfalls.
// Lists every visible month with its ending_mrr from each source plus the delta —
// quick way to spot months where the two pipelines disagree (often points to an
// override that's needed or stale).
function ReconcilePanel({
  qb, txn, fromMonth, toMonth,
}: {
  qb: WaterfallSnapshot | undefined;
  txn: WaterfallSnapshot | undefined;
  fromMonth: string;
  toMonth: string;
}) {
  if (!qb || !txn || !fromMonth || !toMonth) return null;
  const qbByMonth = new Map(qb.monthly.map((r) => [r.month, r]));
  const txnByMonth = new Map(txn.monthly.map((r) => [r.month, r]));
  const months = qb.monthly
    .map((r) => r.month)
    .filter((m) => m >= fromMonth && m <= toMonth)
    .sort()
    .reverse();
  const rows = months.map((m) => {
    const q = qbByMonth.get(m);
    const t = txnByMonth.get(m);
    return {
      month: m,
      qb_ending: q?.ending_mrr ?? null,
      txn_ending: t?.ending_mrr ?? null,
      delta_ending: q && t ? Math.round((t.ending_mrr - q.ending_mrr) * 100) / 100 : null,
      qb_net_new: q?.net_new_mrr ?? null,
      txn_net_new: t?.net_new_mrr ?? null,
      delta_net_new: q && t ? Math.round((t.net_new_mrr - q.net_new_mrr) * 100) / 100 : null,
    };
  });
  const maxAbsDelta = rows.reduce((a, r) => Math.max(a, Math.abs(r.delta_ending ?? 0)), 0);

  return (
    <Paper sx={{ p: 3, mt: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
          Source reconciliation · QB vs Stripe transactions
        </Typography>
        <InfoIcon info={
          <>
            <strong>What it is:</strong> Per-month comparison between the QB-driven waterfall (MRR by Month tab) and the transaction-driven waterfall (Stripe Sync transactions, post-overrides). Δ shows where the two diverge.
            <br /><br />
            <strong>How to read:</strong> A small Δ ($0–$500/mo) is normal — Stripe fees vs QB net handling, multi-sub aggregation, rate-change rounding. Larger Δs usually mean either an annual prepayer's billing month (transaction-side spikes; QB-side smooths) or a misclassified charge that needs a transaction_overrides entry.
            <br /><br />
            <strong>Largest Δ in window:</strong> {USD0.format(maxAbsDelta)}.
          </>
        } />
      </Stack>
      <Box sx={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: '#8B949E', textAlign: 'right', borderBottom: '1px solid #21262D' }}>
              <th style={{ textAlign: 'left', padding: '8px 12px 8px 0' }}>Month</th>
              <th style={{ padding: '8px 12px' }}>QB ending</th>
              <th style={{ padding: '8px 12px' }}>TXN ending</th>
              <th style={{ padding: '8px 12px' }}>Δ ending</th>
              <th style={{ padding: '8px 12px' }}>QB net new</th>
              <th style={{ padding: '8px 12px' }}>TXN net new</th>
              <th style={{ padding: '8px 0 8px 12px' }}>Δ net new</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sigEnding = Math.abs(r.delta_ending ?? 0) >= 1000;
              const sigNet = Math.abs(r.delta_net_new ?? 0) >= 1000;
              return (
                <tr key={r.month} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '6px 12px 6px 0', color: '#E6EDF3' }}>{monthLabelLong(r.month)}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.qb_ending != null ? USD0.format(r.qb_ending) : '—'}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.txn_ending != null ? USD0.format(r.txn_ending) : '—'}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: sigEnding ? '#F59E0B' : '#8B949E', fontWeight: sigEnding ? 600 : 400 }}>
                    {r.delta_ending != null ? (r.delta_ending >= 0 ? '+' : '') + USD0.format(r.delta_ending) : '—'}
                  </td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.qb_net_new != null ? USD0.format(r.qb_net_new) : '—'}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.txn_net_new != null ? USD0.format(r.txn_net_new) : '—'}</td>
                  <td style={{ padding: '6px 0 6px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: sigNet ? '#F59E0B' : '#8B949E', fontWeight: sigNet ? 600 : 400 }}>
                    {r.delta_net_new != null ? (r.delta_net_new >= 0 ? '+' : '') + USD0.format(r.delta_net_new) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Box>
    </Paper>
  );
}
