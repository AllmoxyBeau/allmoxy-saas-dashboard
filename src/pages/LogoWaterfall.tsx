import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import Collapse from '@mui/material/Collapse';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import { useSheetTab } from '../hooks/useSheetTab';

type WaterfallMonthly = {
  month: string;
  new_logos: number;
  reactivated_logos: number;
  churned_logos: number;
  details?: {
    new?: Array<{ name: string; mrr?: number }>;
    reactivated?: Array<{ name: string; mrr?: number }>;
    churn?: Array<{ name: string; mrr?: number }>;
  };
};
type WaterfallSnapshot = { monthly: WaterfallMonthly[] };
type MrrByMonthRow = { month: string; logo_qty: number | null };
type MrrByMonthSnapshot = { rows: MrrByMonthRow[] };

type Preset = '12M' | '24M' | '60M' | 'ALL' | 'CUSTOM';
type DrillCategory = 'new' | 'reactivated' | 'churn';

const monthLabel = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
};
const monthLabelLong = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};
function addMonths(iso: string, delta: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function pct(v: number | null) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}
function churnColor(v: number | null) {
  if (v == null) return 'text.secondary';
  if (v <= 0.05) return 'success.main';
  if (v <= 0.12) return 'warning.main';
  return 'error.main';
}

export default function LogoWaterfall() {
  const { data: wfData, isLoading: wfLoading, error: wfError } = useSheetTab('mrr_waterfall');
  const { data: mrrData, isLoading: mrrLoading } = useSheetTab('mrr_by_month');
  const wf = wfData as unknown as WaterfallSnapshot | undefined;
  const mrr = mrrData as unknown as MrrByMonthSnapshot | undefined;

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

  // Merge waterfall buckets with mrr_by_month logo_qty (the canonical
  // ending-logo count). starting_logos for each month = previous month's
  // ending; ending = starting + new + reactivated - churned. For the very
  // first month in the data, starting = 0.
  const monthly = useMemo(() => {
    if (!wf || !mrr) return [];
    const logoQtyByMonth = new Map<string, number>();
    for (const r of mrr.rows ?? []) {
      if (typeof r.logo_qty === 'number') logoQtyByMonth.set(r.month, r.logo_qty);
    }
    const months = wf.monthly ?? [];
    return months.map((m, i) => {
      const ending = logoQtyByMonth.get(m.month) ?? null;
      const prevMonth = months[i - 1]?.month;
      const starting = prevMonth ? (logoQtyByMonth.get(prevMonth) ?? 0) : Math.max(0, (ending ?? 0) - m.new_logos - m.reactivated_logos + m.churned_logos);
      const computedEnding = starting + m.new_logos + m.reactivated_logos - m.churned_logos;
      const finalEnding = ending ?? computedEnding;
      const netNew = m.new_logos + m.reactivated_logos - m.churned_logos;
      // Logo-weighted churn (gross): churned ÷ starting
      const grossChurn = starting > 0 ? m.churned_logos / starting : null;
      return {
        month: m.month,
        starting_logos: starting,
        new_logos: m.new_logos,
        reactivated_logos: m.reactivated_logos,
        churned_logos: m.churned_logos,
        ending_logos: finalEnding,
        net_new_logos: netNew,
        logo_growth_rate: starting > 0 ? netNew / starting : null,
        gross_churn_rate_monthly: grossChurn,
      };
    });
  }, [wf, mrr]);

  const firstMonth = monthly[0]?.month;
  const lastMonth = monthly[monthly.length - 1]?.month;

  // Init range from preset
  useMemo(() => {
    if (!firstMonth || !lastMonth || preset === 'CUSTOM') return;
    const end = lastMonth;
    const max = (a: string, b: string) => (a > b ? a : b);
    const start =
      preset === 'ALL' ? firstMonth :
      preset === '60M' ? max(firstMonth, addMonths(end, -59)) :
      preset === '24M' ? max(firstMonth, addMonths(end, -23)) :
      max(firstMonth, addMonths(end, -11));
    setFromMonth(start);
    setToMonth(end);
  }, [preset, firstMonth, lastMonth]);

  const visible = useMemo(() => {
    if (!fromMonth || !toMonth) return [];
    return monthly
      .filter((r) => r.month >= fromMonth && r.month <= toMonth)
      .map((r) => ({
        ...r,
        neg_churn: -r.churned_logos,
      }));
  }, [monthly, fromMonth, toMonth]);

  const headerStats = useMemo(() => {
    if (monthly.length === 0) return null;
    const N = headerWindow === '3M' ? 3 : headerWindow === '6M' ? 6 : 12;
    const rows = monthly.slice(-N);
    if (rows.length === 0) return null;
    const starting = rows[0].starting_logos;
    const ending = rows[rows.length - 1].ending_logos;
    const newSum = rows.reduce((s, r) => s + r.new_logos, 0);
    const reSum = rows.reduce((s, r) => s + r.reactivated_logos, 0);
    const churnedSum = rows.reduce((s, r) => s + r.churned_logos, 0);
    const netNew = newSum + reSum - churnedSum;
    const annualGrossChurn = starting > 0 ? 1 - Math.pow(1 - churnedSum / starting, 12 / N) : null;
    const annualGrowthRate = starting > 0 ? Math.pow(ending / starting, 12 / N) - 1 : null;
    const annualNrr = starting > 0 ? Math.pow((starting - churnedSum + reSum) / starting, 12 / N) : null;
    return {
      windowStart: rows[0].month,
      windowEnd: rows[rows.length - 1].month,
      starting,
      ending,
      newSum,
      reSum,
      churnedSum,
      netNew,
      annualGrossChurn,
      annualGrowthRate,
      annualNrr,
    };
  }, [monthly, headerWindow]);

  if (wfError) {
    return (
      <Box>
        <PageHeader title="Logo Waterfall" subtitle="Per-month customer count movement: starting → new + reactivated − churned → ending." />
        <Alert severity="warning">Failed to load mrr_waterfall snapshot.</Alert>
      </Box>
    );
  }
  const isLoading = wfLoading || mrrLoading;

  return (
    <Box>
      <PageHeader
        title="Logo Waterfall"
        subtitle="Mirror of the MRR waterfall but counting paying customers instead of dollars. New + reactivated − churned = net new logos for each month."
      />

      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1} sx={{ mb: 2 }}>
        {headerStats ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {headerWindow} window: {monthLabelLong(headerStats.windowStart)} – {monthLabelLong(headerStats.windowEnd)} · rates annualized for comparability
          </Typography>
        ) : <span />}
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

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label={`Net new logos · ${headerWindow}`}
            value={headerStats ? `${headerStats.netNew >= 0 ? '+' : ''}${headerStats.netNew}` : null}
            hint={headerStats ? `${headerStats.starting} → ${headerStats.ending} customers` : 'loading'}
            color={headerStats && headerStats.netNew >= 0 ? 'success.main' : 'error.main'}
            loading={isLoading}
            info={<><strong>What it is:</strong> Net change in paying-customer count over the window. New + Reactivated − Churned.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label={`Annualized logo growth · ${headerWindow}`}
            value={pct(headerStats?.annualGrowthRate ?? null)}
            hint={headerStats ? `${headerStats.starting} → ${headerStats.ending}` : 'loading'}
            color={headerStats?.annualGrowthRate != null && headerStats.annualGrowthRate >= 0 ? 'success.main' : 'error.main'}
            loading={isLoading}
            info={<><strong>What it is:</strong> Compounded annual growth rate of customer count over the window. (ending / starting)^(12/N) − 1.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label={`Annualized gross churn · ${headerWindow}`}
            value={pct(headerStats?.annualGrossChurn ?? null)}
            hint="Logo-weighted (count of customers, not $)"
            color={churnColor(headerStats?.annualGrossChurn ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> Logo-weighted gross churn — % of starting customers who left, annualized.<br /><br /><strong>Differs from MRR churn:</strong> a $20K customer leaving counts the same as a $200 customer here. Logo churn typically runs higher than MRR churn because the long tail of small customers churns more than the larger accounts.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label={`Annualized logo NRR · ${headerWindow}`}
            value={pct(headerStats?.annualNrr ?? null)}
            hint="(start − churned + reactivated) ÷ start"
            color={(headerStats?.annualNrr ?? 0) >= 1 ? 'success.main' : (headerStats?.annualNrr ?? 0) >= 0.85 ? 'warning.main' : 'error.main'}
            loading={isLoading}
            info={<><strong>What it is:</strong> Logo-NRR — of the customers existing at the start of the window, how many remain (or returned) by the end. Doesn't credit new logos.<br /><br /><strong>Reactivated counts toward retention</strong> because the customer existed in our universe before — they just had a gap.</>}
          />
        </Grid>
      </Grid>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Logo movement · {fromMonth && toMonth ? `${monthLabelLong(fromMonth)} → ${monthLabelLong(toMonth)} (${visible.length} months)` : ''}
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> Stacked bars show new + reactivated (positive) and churned (negative) per month. The line on top shows net new logos.<br /><br /><strong>Click any bar segment</strong> to drill into the customers that contributed to that month's New / Reactivated / Churn.</>} />
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControl size="small">
              <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} sx={{ minWidth: 100, fontSize: 12 }}>
                <MenuItem value="12M">Last 12M</MenuItem>
                <MenuItem value="24M">Last 24M</MenuItem>
                <MenuItem value="60M">Last 60M</MenuItem>
                <MenuItem value="ALL">All</MenuItem>
                <MenuItem value="CUSTOM">Custom range</MenuItem>
              </Select>
            </FormControl>
            {preset === 'CUSTOM' && (
              <Stack direction="row" spacing={1} alignItems="center">
                <FormControl size="small">
                  <Select value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} sx={{ minWidth: 110, fontSize: 12 }}>
                    {monthly.map((r) => <MenuItem key={r.month} value={r.month}>{monthLabel(r.month)}</MenuItem>)}
                  </Select>
                </FormControl>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>→</Typography>
                <FormControl size="small">
                  <Select value={toMonth} onChange={(e) => setToMonth(e.target.value)} sx={{ minWidth: 110, fontSize: 12 }}>
                    {monthly.map((r) => <MenuItem key={r.month} value={r.month}>{monthLabel(r.month)}</MenuItem>)}
                  </Select>
                </FormControl>
              </Stack>
            )}
          </Stack>
        </Stack>

        {isLoading || visible.length === 0 ? (
          <Skeleton variant="rectangular" height={420} />
        ) : (
          <Box sx={{ width: '100%', height: 420 }}>
            <ResponsiveContainer>
              <ComposedChart data={visible} margin={{ top: 16, right: 12, bottom: 8, left: 12 }}>
                <CartesianGrid stroke="#21262D" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11, fill: '#8B949E' }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11, fill: '#8B949E' }} />
                <RTooltip
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6 }}
                  labelFormatter={monthLabelLong}
                  formatter={(value: number, name: string) => {
                    const labelMap: Record<string, string> = {
                      new_logos: 'New', reactivated_logos: 'Reactivated', neg_churn: 'Churned', net_new_logos: 'Net new',
                    };
                    return [Math.abs(value), labelMap[name] || name];
                  }}
                />
                <Bar dataKey="new_logos" stackId="movement" fill="#1A9E5C" name="new_logos" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'new')} />
                <Bar dataKey="reactivated_logos" stackId="movement" fill="#9F7AEA" name="reactivated_logos" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'reactivated')} />
                <Bar dataKey="neg_churn" stackId="movement" fill="#DA3633" name="neg_churn" cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill(p.payload.month, 'churn')} />
                <Line type="monotone" dataKey="net_new_logos" stroke="#E6EDF3" strokeWidth={2} dot={{ r: 2.5, fill: '#E6EDF3' }} name="net_new_logos" />
              </ComposedChart>
            </ResponsiveContainer>
          </Box>
        )}
        <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
          <LegendSwatch color="#1A9E5C" label="New logos" />
          <LegendSwatch color="#9F7AEA" label="Reactivated" />
          <LegendSwatch color="#DA3633" label="Churned" />
          <LegendSwatch color="#E6EDF3" label="Net new (line)" />
        </Stack>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: monthlyTable.open ? 2 : 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CollapseToggle open={monthlyTable.open} onToggle={monthlyTable.toggle} label="month-by-month detail" />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Month-by-month detail{fromMonth && toMonth ? ` · ${monthLabelLong(fromMonth)} → ${monthLabelLong(toMonth)} (${visible.length} months)` : ''}
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> The waterfall in table form, sorted newest first. Click any New / Reactivated / Churned cell to drill into the customers.</>} />
          </Stack>
          {visible.length > 0 && (
            <CsvExportButton
              filename={`logo_waterfall_${fromMonth ?? ''}_to_${toMonth ?? ''}`}
              columns={[
                { key: 'month', label: 'Month' },
                { key: 'starting_logos', label: 'Starting' },
                { key: 'new_logos', label: 'New' },
                { key: 'reactivated_logos', label: 'Reactivated' },
                { key: 'churned_logos', label: 'Churned' },
                { key: 'ending_logos', label: 'Ending' },
                { key: 'net_new_logos', label: 'Net new' },
                { key: 'gross_churn_rate_monthly', label: 'Gross churn (mo)' },
                { key: 'logo_growth_rate', label: 'Logo growth (mo)' },
              ]}
              rows={[...visible].reverse()}
            />
          )}
        </Stack>
        <Collapse in={monthlyTable.open} unmountOnExit>
        {isLoading || visible.length === 0 ? (
          <Skeleton variant="rectangular" height={320} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Month</TableCell>
                <TableCell align="right">Starting</TableCell>
                <TableCell align="right">New</TableCell>
                <TableCell align="right">Reactiv.</TableCell>
                <TableCell align="right">Churned</TableCell>
                <TableCell align="right">Ending</TableCell>
                <TableCell align="right">Net new</TableCell>
                <TableCell align="right">Gross churn</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {[...visible].reverse().map((r) => {
                const hoverCell = { cursor: 'pointer', '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' } };
                return (
                  <TableRow key={r.month} hover>
                    <TableCell sx={{ fontWeight: 500 }}>{monthLabelLong(r.month)}</TableCell>
                    <TableCell align="right" sx={{ color: 'text.secondary' }}>{r.starting_logos}</TableCell>
                    <TableCell align="right" sx={{ color: 'success.main', ...hoverCell }} onClick={() => openDrill(r.month, 'new')}>
                      {r.new_logos > 0 ? `+${r.new_logos}` : '—'}
                    </TableCell>
                    <TableCell align="right" sx={{ color: '#9F7AEA', ...hoverCell }} onClick={() => openDrill(r.month, 'reactivated')}>
                      {r.reactivated_logos > 0 ? `+${r.reactivated_logos}` : '—'}
                    </TableCell>
                    <TableCell align="right" sx={{ color: 'error.main', ...hoverCell }} onClick={() => openDrill(r.month, 'churn')}>
                      {r.churned_logos > 0 ? `-${r.churned_logos}` : '—'}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 500 }}>{r.ending_logos}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 500, color: r.net_new_logos >= 0 ? 'success.main' : 'error.main' }}>
                      {r.net_new_logos >= 0 ? `+${r.net_new_logos}` : `${r.net_new_logos}`}
                    </TableCell>
                    <TableCell align="right" sx={{ color: churnColor(r.gross_churn_rate_monthly) }}>
                      {pct(r.gross_churn_rate_monthly)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1, fontStyle: 'italic' }}>
          Click any New / Reactivated / Churned count to see the customers.
        </Typography>
        </Collapse>
      </Paper>

      {drill && wf && (() => {
        const row = wf.monthly.find((r) => r.month === drill.month);
        if (!row) return null;
        const { category, month } = drill;
        const title = category === 'new' ? 'New logos' : category === 'reactivated' ? 'Reactivated logos' : 'Churned logos';
        const accent = category === 'new' ? 'rgba(26, 158, 92, 0.5)' : category === 'reactivated' ? 'rgba(159, 122, 234, 0.5)' : 'rgba(218, 54, 51, 0.5)';
        const items = (row.details?.[category] ?? []) as Array<{ name: string; mrr?: number }>;
        const columns: DrillColumn<{ name: string; mrr?: number }>[] = [
          { key: 'name', label: 'Customer', render: (r) => <CustomerLink name={r.name} /> },
          {
            key: 'mrr',
            label: category === 'churn' ? 'Last MRR' : 'MRR',
            align: 'right',
            render: (r) => (typeof r.mrr === 'number' ? `$${r.mrr.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'),
            exportValue: (r) => r.mrr ?? 0,
          },
        ];
        return (
          <DrillDownPanel
            title={`${title} · ${monthLabelLong(month)}`}
            subtitle={`${items.length} customers · sorted by MRR`}
            accent={accent}
            rows={items as unknown as Array<Record<string, unknown>>}
            columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
            filename={`logos_${category}_${month}`}
            onClose={() => setDrill(null)}
          />
        );
      })()}
    </Box>
  );
}

function StatCard({
  label, value, hint, color, loading, info,
}: { label: string; value: string | null; hint: string; color: string; loading?: boolean; info?: React.ReactNode }) {
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>{label}</Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      {loading || value == null ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 32 }} />
      ) : (
        <Typography variant="h4" sx={{ fontWeight: 500, color, mt: 0.5 }}>{value}</Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 11 }}>{hint}</Typography>
    </Paper>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box sx={{ width: 14, height: 14, bgcolor: color, borderRadius: 0.5 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>{label}</Typography>
    </Stack>
  );
}
