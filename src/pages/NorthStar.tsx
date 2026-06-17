import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  LabelList,
} from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import { useSheetTab } from '../hooks/useSheetTab';
import annualPayersCfg from '../data/annual_payer_ids.json';

const ANNUAL_PAYER_IDS = new Set<number>(annualPayersCfg.annual_payer_ids);

type ActiveCustomer = {
  name: string;
  allmoxy_customer_id: number | null;
  current_mrr: number;
  lifetime_revenue: number;
  years_with_us: number | null;
  failed_3mo: number;
};
type CustomerHealthSnap = {
  latestMonth: string;
  concentration: { total_mrr: number };
  all_active_customers?: ActiveCustomer[];
};

type DrillKind =
  | { kind: 'active_logos' | 'subscription' | 'services' | 'connect' | 'blended' }
  | { kind: 'bar'; month: string; stream: 'subscription' | 'services' | 'connect' };

type MRRByMonthRow = {
  month: string;
  logo_qty: number | null;
  mrr_subscription: number | null;
  mrr_services: number | null;
  mrr_connect: number | null;
  mrr_blended: number | null;
  avg_mrr_blended: number | null;
};

const USD_COMPACT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

const USD0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const MONTH_LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });

function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return MONTH_LABEL.format(new Date(y, m - 1, 1));
}

function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatDateMDY(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}-${m[3]}-${m[1].slice(2)}`;
}

type Preset = '12M' | '24M' | '60M' | 'ALL' | 'CUSTOM';

function addMonths(iso: string, delta: number): string {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

type ServicesRow = { customer_name: string } & Record<string, number | null>;
type ServicesTransaction = {
  created: string;
  amount: number;
  amount_refunded?: number;
  net_amount?: number;
  type: string;
  status: string;
  description?: string;
};
type MonthlyHistoryCell = {
  subscription?: number;
  services?: number;
  connect?: number;
  total?: number;
  annualized?: boolean;
};
type CustomerProfileRow = {
  allmoxy_customer_id?: number;
  name: string;
  transactions?: ServicesTransaction[];
  monthly_history?: Record<string, MonthlyHistoryCell>;
};
type CustomerProfilesSnap = { rows: CustomerProfileRow[] };
type ConnectRow = { month: string; connect_fees: number | null };

export default function NorthStar() {
  const { data: mrrData, isLoading: mrrLoading, error: mrrError } = useSheetTab<MRRByMonthRow>('mrr_by_month');
  const { data: servicesData, isLoading: servicesLoading, error: servicesError } =
    useSheetTab<ServicesRow>('services_by_month');
  const { data: connectData, isLoading: connectLoading, error: connectError } =
    useSheetTab<ConnectRow>('connect_by_month');
  const { data: healthData } = useSheetTab('customer_health');
  const health = healthData as unknown as CustomerHealthSnap | undefined;
  const { data: subMonthlyData } = useSheetTab('subscription_by_month');
  const subMonthly = subMonthlyData as unknown as { rows: Array<{ customer_name: string } & Record<string, number | null>> } | undefined;
  const { data: connectByCustomerData } = useSheetTab('connect_by_customer_month');
  const { data: customerProfilesData } = useSheetTab('customer_profiles');
  const connectByCustomer = connectByCustomerData as unknown as { rows: Array<{ customer_name: string } & Record<string, number | null>> } | undefined;
  const customerProfiles = customerProfilesData as unknown as CustomerProfilesSnap | undefined;

  const [drill, setDrill] = useState<DrillKind | null>(null);
  function openDrill(d: DrillKind) {
    setDrill(d);
    setTimeout(() => {
      document.getElementById('drill-down-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  const isLoading = mrrLoading || servicesLoading || connectLoading;
  const error = mrrError ?? servicesError ?? connectError;
  const data = mrrData;

  // Override the stale `mrr_services` / `mrr_connect` / `mrr_blended` values in
  // mrr_by_month with totals from the dedicated Services and Connect tabs
  // (sources of truth — the Meta sheet's stacked MRR rows are formula-driven
  // off stale intermediate cells for these streams).
  const rows = useMemo<MRRByMonthRow[]>(() => {
    if (!mrrData?.rows) return [];
    const svcTotals = (servicesData?.monthlyTotals ?? {}) as Record<string, number>;
    const connectTotals = (connectData?.monthlyTotals ?? {}) as Record<string, number>;
    return mrrData.rows.map((r) => {
      const svc = svcTotals[r.month] ?? (r.mrr_services ?? 0);
      const conn = connectTotals[r.month] ?? (r.mrr_connect ?? 0);
      const sub = r.mrr_subscription ?? 0;
      return { ...r, mrr_services: svc, mrr_connect: conn, mrr_blended: sub + svc + conn };
    });
  }, [mrrData, servicesData, connectData]);

  const currentMonth = currentYearMonth();
  // Most recent *complete* month — the current month's data is partial.
  const headline = [...rows].reverse().find((r) => r.month < currentMonth) ?? null;
  const partial = rows.find((r) => r.month === currentMonth) ?? null;

  // Sum of amortized annual-payer subscription contributions to the headline month
  // (the slice of mrr_subscription that came from annualized lump-sum payments,
  // 1/12 per month over a 12-month window — not regular monthly recurring revenue).
  const annualizedSubscription = useMemo(() => {
    if (!headline || !customerProfiles?.rows) return 0;
    let sum = 0;
    for (const p of customerProfiles.rows) {
      if (p.allmoxy_customer_id == null || !ANNUAL_PAYER_IDS.has(p.allmoxy_customer_id)) continue;
      const cell = p.monthly_history?.[headline.month];
      if (cell?.annualized && typeof cell.subscription === 'number') sum += cell.subscription;
    }
    return Math.round(sum * 100) / 100;
  }, [headline, customerProfiles]);

  const completeMonths = useMemo(() => rows.filter((r) => r.month < currentMonth), [rows, currentMonth]);
  const firstMonth = completeMonths[0]?.month;
  const lastComplete = completeMonths[completeMonths.length - 1]?.month;

  const [preset, setPreset] = useState<Preset>('12M');
  const [fromMonth, setFromMonth] = useState<string>('');
  const [toMonth, setToMonth] = useState<string>('');
  const [visibleStreams, setVisibleStreams] = useState({ subscription: true, services: true, connect: true });

  function toggleStream(k: keyof typeof visibleStreams) {
    setVisibleStreams((s) => ({ ...s, [k]: !s[k] }));
  }

  // Initialize (and re-snap on preset change) once data has loaded.
  useEffect(() => {
    if (!firstMonth || !lastComplete) return;
    if (preset === 'CUSTOM') return;
    const end = lastComplete;
    const start =
      preset === 'ALL'
        ? firstMonth
        : preset === '60M'
          ? max(firstMonth, addMonths(end, -59))
          : preset === '24M'
            ? max(firstMonth, addMonths(end, -23))
            : max(firstMonth, addMonths(end, -11)); // 12M
    setFromMonth(start);
    setToMonth(end);
  }, [preset, firstMonth, lastComplete]);

  const visibleRange = useMemo(() => {
    if (!fromMonth || !toMonth) return [];
    return completeMonths.filter((r) => r.month >= fromMonth && r.month <= toMonth);
  }, [completeMonths, fromMonth, toMonth]);

  // Per-row total of the currently visible streams. Used as the source for the bar-top
  // label on the stacked MRR chart so the label sits at the actual top of the visible
  // stack (not the all-streams total, which would float when a stream is toggled off).
  const visibleRangeWithTotal = useMemo(() => {
    return visibleRange.map((r) => {
      const total =
        (visibleStreams.subscription ? (r.mrr_subscription || 0) : 0) +
        (visibleStreams.services ? (r.mrr_services || 0) : 0) +
        (visibleStreams.connect ? (r.mrr_connect || 0) : 0);
      return { ...r, mrr_total_visible: total };
    });
  }, [visibleRange, visibleStreams]);

  // Pick the topmost visible stream — that's the Bar that should host the total label so it
  // renders at the top of the stack. Falls back gracefully if all streams are off.
  const topVisibleStream: 'subscription' | 'services' | 'connect' | null = visibleStreams.connect
    ? 'connect'
    : visibleStreams.services
      ? 'services'
      : visibleStreams.subscription
        ? 'subscription'
        : null;

  function max(a: string, b: string) {
    return a > b ? a : b;
  }

  return (
    <Box>
      <PageHeader
        title="Overview"
        subtitle="The one-page view of the business — key metrics at a glance, with every number one click from its underlying detail."
        question="healthy"
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load mrr_by_month — {String(error)}
        </Alert>
      )}

      <Grid container spacing={2}>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            label="Active paying customers"
            value={isLoading || !headline ? null : headline.logo_qty?.toLocaleString() ?? '—'}
            hint={headline ? `${monthLabel(headline.month)} · click for list` : 'loading'}
            stream="Blended"
            onClick={() => openDrill({ kind: 'active_logos' })}
            info={<><strong>What it is:</strong> Count of unique customers with subscription MRR &gt; 0 in the latest complete month.<br /><br /><strong>Data:</strong> "Logo Qty" row of the MRR by Month tab, which counts distinct paying customers per month from the per-customer × month subscription grid.<br /><br /><strong>Click:</strong> Drill to the full list of active customers with their current MRR.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            label="Subscription MRR"
            value={
              isLoading || !headline
                ? null
                : headline.mrr_subscription != null
                  ? USD0.format(headline.mrr_subscription)
                  : '—'
            }
            hint={headline ? `${monthLabel(headline.month)} · Stream 1 · click` : 'loading'}
            stream="Stream 1"
            onClick={() => openDrill({ kind: 'subscription' })}
            info={<><strong>What it is:</strong> Total subscription MRR for the latest complete month — the recurring-revenue engine of the business.<br /><br /><strong>Data:</strong> Sum of per-customer subscription MRR from the MRR by Month tab for the headline month.<br /><br /><strong>Includes:</strong> regular monthly subscriptions <em>plus</em> 1/12 of any annual lump-sum payments still in their 12-month amortization window (annual-payer list: <code>src/data/annual_payers.json</code>).<br /><br /><strong>Click:</strong> Drill to each contributing transaction; filter for annual vs. regular.</>}
            footerChip={
              annualizedSubscription > 0
                ? { label: `incl. ${USD0.format(annualizedSubscription)} annualized`, tooltip: '1/12 portions of annual lump-sum payments from annual-payer customers' }
                : null
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            label="Services MRR"
            value={
              isLoading || !headline
                ? null
                : headline.mrr_services != null
                  ? USD0.format(headline.mrr_services)
                  : '—'
            }
            hint={headline ? `${monthLabel(headline.month)} · Stream 2 · click` : 'loading'}
            stream="Stream 2"
            onClick={() => openDrill({ kind: 'services' })}
            info={<><strong>What it is:</strong> Services (project-based) revenue recognized in the latest complete month. Non-recurring by nature — we track it separately from subscription so recurring-revenue metrics aren't distorted by one-off project billings.<br /><br /><strong>Data:</strong> Sum of Stripe transactions where transaction_type = "services" and status = "succeeded", aggregated from the Stripe Sync tab.<br /><br /><strong>Click:</strong> Drill to each services customer with their payment date and amount.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            label="Connect MRR"
            value={
              isLoading || !headline
                ? null
                : headline.mrr_connect != null
                  ? USD0.format(headline.mrr_connect)
                  : '—'
            }
            hint={headline ? `${monthLabel(headline.month)} · Stream 3 · click` : 'loading'}
            stream="Stream 3"
            onClick={() => openDrill({ kind: 'connect' })}
            info={<><strong>What it is:</strong> Stripe Connect affiliate fees — the platform fee Allmoxy earns on transactions processed by customers through Stripe Connect.<br /><br /><strong>Data:</strong> Summary-row total from the Stripe Connect Revenue sheets (2024/2025/2026) for the latest complete month.<br /><br /><strong>Click:</strong> Drill to each Connect customer with fee + lifetime totals.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <MetricCard
            label="Blended MRR"
            value={
              isLoading || !headline
                ? null
                : headline.mrr_blended != null
                  ? USD0.format(headline.mrr_blended)
                  : '—'
            }
            hint={headline ? `${monthLabel(headline.month)} · Stream 1 + 2 + 3 · click` : 'loading'}
            stream="Blended"
            onClick={() => openDrill({ kind: 'blended' })}
            info={<><strong>What it is:</strong> Subscription MRR + Services revenue + Connect fees for the latest complete month — the total "dollars in" number.<br /><br /><strong>Data:</strong> Sum of the three stream cards above. Each stream comes from its own authoritative source (see individual card info).<br /><br /><strong>Note:</strong> Each stream behaves differently — subscription is recurring, services is project-based, Connect is transaction-driven. The Blended total is informative but the per-stream cards tell the actual operating story.</>}
          />
        </Grid>
      </Grid>

      <Paper sx={{ p: 3, mt: 3 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', md: 'center' }}
          spacing={2}
          sx={{ mb: 2 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Active paying customers
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> Monthly trend of active paying customer count — the "logo growth" story.<br /><br /><strong>Data:</strong> "Logo Qty" row from the MRR by Month tab, which counts distinct customers with subscription MRR &gt; 0 each month.<br /><br /><strong>Click any bar</strong> to see the customers that were paying that month with their MRR.<br /><br /><strong>Range picker</strong> on the right lets you zoom from 12 months to all history.</>} />
            {fromMonth && toMonth && (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {monthLabel(fromMonth)} – {monthLabel(toMonth)}
              </Typography>
            )}
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
                onChange={(e) => {
                  setPreset('CUSTOM');
                  const v = e.target.value;
                  setFromMonth(v);
                  if (toMonth && v > toMonth) setToMonth(v);
                }}
                sx={{ minWidth: 120, fontSize: 12 }}
                MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
                disabled={!completeMonths.length}
              >
                {completeMonths.map((r) => (
                  <MenuItem key={r.month} value={r.month} sx={{ fontSize: 12 }}>
                    {monthLabel(r.month)}
                  </MenuItem>
                ))}
              </Select>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>to</Typography>
              <Select
                size="small"
                value={toMonth || ''}
                onChange={(e) => {
                  setPreset('CUSTOM');
                  const v = e.target.value;
                  setToMonth(v);
                  if (fromMonth && v < fromMonth) setFromMonth(v);
                }}
                sx={{ minWidth: 120, fontSize: 12 }}
                MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
                disabled={!completeMonths.length}
              >
                {completeMonths.map((r) => (
                  <MenuItem key={r.month} value={r.month} sx={{ fontSize: 12 }}>
                    {monthLabel(r.month)}
                  </MenuItem>
                ))}
              </Select>
            </Stack>
          </Stack>
        </Stack>
        {partial && partial.logo_qty != null && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1 }}>
            {monthLabel(partial.month)} MTD: {partial.logo_qty.toLocaleString()} (partial — not plotted)
          </Typography>
        )}
        {isLoading ? (
          <Skeleton variant="rectangular" height={260} />
        ) : (
          <Box sx={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              {/* Top margin bumped so the count label above the tallest bar has room. */}
              <BarChart data={visibleRange} margin={{ top: 22, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis
                  dataKey="month"
                  tickFormatter={monthLabel}
                  stroke="#8B949E"
                  fontSize={11}
                />
                <YAxis stroke="#8B949E" fontSize={11} width={40} />
                <Tooltip
                  labelFormatter={(v) => monthLabel(String(v))}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                  cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                />
                <Bar
                  dataKey="logo_qty"
                  fill="#2C73FF"
                  radius={[2, 2, 0, 0]}
                  cursor="pointer"
                  onClick={(p: { payload?: { month: string } }) =>
                    p.payload && openDrill({ kind: 'bar', month: p.payload.month, stream: 'subscription' })
                  }
                >
                  {/* Total above each bar — simple integer since logo_qty is a count. */}
                  <LabelList
                    dataKey="logo_qty"
                    position="top"
                    style={{ fill: '#C9D1D9', fontSize: 10, fontWeight: 500 }}
                    formatter={(v: number) => (v != null ? v.toLocaleString() : '')}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      <Paper sx={{ p: 3, mt: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Monthly recurring revenue by stream
          </Typography>
          <InfoIcon info={<><strong>What it is:</strong> Stacked monthly revenue by stream — how each of Subscription, Services, and Connect contributes to the total each month.<br /><br /><strong>Data:</strong> Subscription MRR from the MRR by Month tab · Services revenue from Stripe Sync (transaction_type=services, succeeded) · Connect fees from the Stripe Connect Revenue sheets.<br /><br /><strong>Click any bar segment</strong> to drill into the customers that contributed to that month and stream. Click the color chips below the chart to toggle streams on/off.</>} />
          {fromMonth && toMonth && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              · {monthLabel(fromMonth)} – {monthLabel(toMonth)} · range picker above applies here too
            </Typography>
          )}
        </Stack>
        {isLoading ? (
          <Skeleton variant="rectangular" height={260} />
        ) : (
          <Box sx={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              {/* visibleRangeWithTotal adds mrr_total_visible per row (sum of currently-visible
                  streams) so the bar-top label sits at the actual top of the stack rather than
                  floating when a stream is toggled off. */}
              <BarChart data={visibleRangeWithTotal} margin={{ top: 22, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                <YAxis
                  stroke="#8B949E"
                  fontSize={11}
                  width={60}
                  tickFormatter={(v) => USD_COMPACT.format(Number(v))}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                  labelFormatter={(v) => monthLabel(String(v))}
                  formatter={(v: number, name: string) => [USD0.format(v), name]}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                />
                <Bar name="Subscription" dataKey="mrr_subscription" stackId="mrr" fill="#2C73FF" hide={!visibleStreams.subscription} cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill({ kind: 'bar', month: p.payload.month, stream: 'subscription' })}>
                  {topVisibleStream === 'subscription' && (
                    <LabelList dataKey="mrr_total_visible" position="top" style={{ fill: '#C9D1D9', fontSize: 10, fontWeight: 500 }} formatter={(v: number) => (v ? USD_COMPACT.format(v) : '')} />
                  )}
                </Bar>
                <Bar name="Services" dataKey="mrr_services" stackId="mrr" fill="#1A9E5C" hide={!visibleStreams.services} cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill({ kind: 'bar', month: p.payload.month, stream: 'services' })}>
                  {topVisibleStream === 'services' && (
                    <LabelList dataKey="mrr_total_visible" position="top" style={{ fill: '#C9D1D9', fontSize: 10, fontWeight: 500 }} formatter={(v: number) => (v ? USD_COMPACT.format(v) : '')} />
                  )}
                </Bar>
                <Bar name="Connect" dataKey="mrr_connect" stackId="mrr" fill="#F59E0B" hide={!visibleStreams.connect} cursor="pointer" onClick={(p: { payload?: { month: string } }) => p.payload && openDrill({ kind: 'bar', month: p.payload.month, stream: 'connect' })}>
                  {topVisibleStream === 'connect' && (
                    <LabelList dataKey="mrr_total_visible" position="top" style={{ fill: '#C9D1D9', fontSize: 10, fontWeight: 500 }} formatter={(v: number) => (v ? USD_COMPACT.format(v) : '')} />
                  )}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Box>
        )}
        <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap alignItems="center">
          <LegendToggle color="#2C73FF" label="Subscription (Stream 1)" active={visibleStreams.subscription} onClick={() => toggleStream('subscription')} />
          <LegendToggle color="#1A9E5C" label="Services (Stream 2)" active={visibleStreams.services} onClick={() => toggleStream('services')} />
          <LegendToggle color="#F59E0B" label="Connect (Stream 3)" active={visibleStreams.connect} onClick={() => toggleStream('connect')} />
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            Click to toggle · bar total = sum of visible streams.
          </Typography>
        </Stack>
      </Paper>

      {data && (
        <Typography
          variant="caption"
          sx={{ display: 'block', mt: 2, color: 'text.secondary', textAlign: 'center' }}
        >
          Data refreshed {new Date(data.fetchedAt).toLocaleString()}
        </Typography>
      )}

      {drill && headline && (
        <NorthStarDrill
          drill={drill}
          health={health}
          subMonthly={subMonthly}
          connectByCustomer={connectByCustomer}
          customerProfiles={customerProfiles}
          headlineMonth={headline.month}
          onClose={() => setDrill(null)}
        />
      )}
    </Box>
  );
}

function MetricCard({
  label,
  value,
  hint,
  stream,
  pending = false,
  onClick,
  info,
  footerChip,
}: {
  label: string;
  value: string | null;
  hint: string;
  stream: string;
  pending?: boolean;
  onClick?: () => void;
  info?: React.ReactNode;
  footerChip?: { label: string; tooltip?: string } | null;
}) {
  return (
    <Paper
      sx={{
        p: 2.5,
        height: '100%',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background-color 120ms',
        '&:hover': onClick ? { bgcolor: 'rgba(44, 115, 255, 0.04)' } : {},
      }}
      onClick={onClick}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </Typography>
        <Stack direction="row" spacing={0.5} alignItems="center" onClick={(e) => e.stopPropagation()}>
          {info && <InfoIcon info={info} />}
          <Chip
            label={stream}
            size="small"
            sx={{
              height: 20,
              fontSize: 10,
              bgcolor: pending ? 'rgba(139, 148, 158, 0.12)' : 'rgba(44, 115, 255, 0.12)',
              color: pending ? 'text.secondary' : 'primary.main',
              fontWeight: 500,
            }}
          />
        </Stack>
      </Stack>
      {value === null ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 32 }} />
      ) : (
        <Typography variant="h4" sx={{ fontWeight: 500, color: pending ? 'text.secondary' : 'text.primary' }}>
          {value}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
        {hint}
      </Typography>
      {footerChip && (
        <Chip
          label={footerChip.label}
          size="small"
          title={footerChip.tooltip}
          sx={{
            mt: 0.75,
            height: 20,
            fontSize: 11,
            fontWeight: 500,
            bgcolor: 'rgba(159, 122, 234, 0.14)',
            color: '#9F7AEA',
            border: '1px solid rgba(159, 122, 234, 0.3)',
          }}
        />
      )}
    </Paper>
  );
}

function LegendToggle({
  color,
  label,
  active,
  onClick,
}: {
  color: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Stack
      direction="row"
      spacing={0.75}
      alignItems="center"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        cursor: 'pointer',
        userSelect: 'none',
        px: 0.75,
        py: 0.25,
        borderRadius: 1,
        opacity: active ? 1 : 0.45,
        transition: 'opacity 120ms, background-color 120ms',
        '&:hover': { bgcolor: 'rgba(139, 148, 158, 0.08)' },
      }}
    >
      <Box
        sx={{
          width: 10,
          height: 10,
          bgcolor: color,
          borderRadius: '2px',
          boxShadow: active ? 'none' : 'inset 0 0 0 1px rgba(0,0,0,0.2)',
        }}
      />
      <Typography
        variant="caption"
        sx={{
          color: active ? 'text.primary' : 'text.secondary',
          fontSize: 11,
          textDecoration: active ? 'none' : 'line-through',
        }}
      >
        {label}
      </Typography>
    </Stack>
  );
}

function NorthStarDrill({
  drill,
  health,
  subMonthly,
  connectByCustomer,
  customerProfiles,
  headlineMonth,
  onClose,
}: {
  drill: DrillKind;
  health: CustomerHealthSnap | undefined;
  subMonthly: { rows: Array<{ customer_name: string } & Record<string, number | null>> } | undefined;
  connectByCustomer: { rows: Array<{ customer_name: string } & Record<string, number | null>> } | undefined;
  customerProfiles: CustomerProfilesSnap | undefined;
  headlineMonth: string;
  onClose: () => void;
}) {
  // Helper: extract per-transaction rows of a given type for a given YYYY-MM,
  // drawing from customer_profiles (the only snapshot with transaction-level dates).
  //
  // For subscription, annual-payer customers' lump-sum transactions are REPLACED
  // by a synthetic amortized row (1/12 of the lump sum, from monthly_history) so
  // the drill total reconciles to the post-amortization mrr_subscription headline.
  // Annualized rows are tagged so the drill can filter on them.
  function transactionsForMonth(month: string, type: 'services' | 'subscription' | 'connect') {
    const profileRows = customerProfiles?.rows ?? [];
    const txns: Array<{ date: string; customer: string; amount: number; description: string; is_annualized: boolean }> = [];
    for (const p of profileRows) {
      const isAnnualPayer = type === 'subscription'
        && p.allmoxy_customer_id != null
        && ANNUAL_PAYER_IDS.has(p.allmoxy_customer_id);
      const cell = isAnnualPayer ? p.monthly_history?.[month] : undefined;
      if (isAnnualPayer && cell?.annualized && typeof cell.subscription === 'number' && cell.subscription > 0) {
        // Synthetic amortized row — replaces this annual payer's raw subscription
        // transactions for the month. Date is the origin lump-sum (the customer's
        // most recent >=$3K subscription charge), so the user can see which
        // payment is being amortized.
        const origin = (p.transactions ?? [])
          .filter((t) => t.type === 'subscription' && t.status === 'succeeded' && ((typeof t.net_amount === 'number' ? t.net_amount : t.amount) ?? 0) >= 3000)
          .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))[0];
        const lumpSum = origin ? Math.round(((typeof origin.net_amount === 'number' ? origin.net_amount : origin.amount) ?? 0) * 100) / 100 : 0;
        txns.push({
          date: origin?.created ?? `${month}-01`,
          customer: p.name,
          amount: Math.round(cell.subscription * 100) / 100,
          description: lumpSum > 0
            ? `Annualized 1/12 of ${USD0.format(lumpSum)} lump-sum${origin?.description ? ` · ${origin.description}` : ''}`
            : 'Annualized 1/12 of annual lump-sum',
          is_annualized: true,
        });
        continue; // skip this customer's raw subscription txns for the month
      }
      const list = p.transactions ?? [];
      for (const t of list) {
        if (t.type !== type || t.status !== 'succeeded') continue;
        const created = t.created ?? '';
        if (!created.startsWith(month)) continue;
        const amount = (typeof t.net_amount === 'number' ? t.net_amount : t.amount) ?? 0;
        if (amount <= 0) continue;
        txns.push({
          date: created,
          customer: p.name,
          amount: Math.round(amount * 100) / 100,
          description: t.description ?? '',
          is_annualized: false,
        });
      }
    }
    return txns.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  const active = health?.all_active_customers ?? [];
  // Filter for the subscription drill: show all rows, annual-payer amortized
  // contributions only, or regular monthly subscription transactions only.
  const [subFilter, setSubFilter] = useState<'all' | 'annualized' | 'regular'>('all');

  // Stacked-bar click: month + stream → per-customer breakdown for that month.
  if (drill.kind === 'bar') {
    const { month, stream } = drill;
    if (stream === 'subscription') {
      const rows = (subMonthly?.rows ?? [])
        .map((r) => {
          const dates = (r as { payment_dates?: Record<string, string> }).payment_dates ?? {};
          return {
            name: r.customer_name,
            mrr: typeof r[month] === 'number' ? (r[month] as number) : 0,
            payment_date: dates[month] ?? null,
          };
        })
        .filter((r) => r.mrr > 0)
        .sort((a, b) => b.mrr - a.mrr);
      const total = rows.reduce((s, r) => s + r.mrr, 0);
      const columns: DrillColumn<(typeof rows)[number]>[] = [
        { key: 'name', label: 'Customer' },
        { key: 'mrr', label: `${month} subscription MRR`, align: 'right', render: (r) => USD0.format(r.mrr) },
        {
          key: 'pct',
          label: '% of month total',
          align: 'right',
          render: (r) => (total > 0 ? `${((r.mrr / total) * 100).toFixed(2)}%` : '—'),
          exportValue: (r) => (total > 0 ? r.mrr / total : 0),
        },
        {
          key: 'payment_date',
          label: 'Payment date',
          render: (r) => formatDateMDY((r as { payment_date: string | null }).payment_date),
          exportValue: (r) => formatDateMDY((r as { payment_date: string | null }).payment_date),
          sortValue: (r) => (r as { payment_date: string | null }).payment_date ?? '',
        },
      ];
      return (
        <DrillDownPanel
          title={`Subscription MRR · ${monthLabel(month)}`}
          subtitle={`${rows.length} customers · ${USD0.format(total)}/mo · sorted by MRR desc`}
          accent="rgba(44, 115, 255, 0.5)"
          rows={rows as unknown as Array<Record<string, unknown>>}
          columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
          filename={`subscription_${month}`}
          onClose={onClose}
        />
      );
    }
    if (stream === 'services') {
      const rows = transactionsForMonth(month, 'services');
      const total = rows.reduce((s, r) => s + r.amount, 0);
      const uniqueCustomers = new Set(rows.map((r) => r.customer)).size;
      const columns: DrillColumn<(typeof rows)[number]>[] = [
        {
          key: 'date',
          label: 'Date',
          render: (r) => formatDateMDY(r.date),
          exportValue: (r) => formatDateMDY(r.date),
          sortValue: (r) => r.date,
        },
        { key: 'customer', label: 'Customer' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => USD0.format(r.amount) },
        {
          key: 'pct',
          label: '% of month total',
          align: 'right',
          render: (r) => (total > 0 ? `${((r.amount / total) * 100).toFixed(2)}%` : '—'),
          exportValue: (r) => (total > 0 ? r.amount / total : 0),
        },
        { key: 'description', label: 'Description' },
      ];
      return (
        <DrillDownPanel
          title={`Services revenue · ${monthLabel(month)}`}
          subtitle={`${rows.length} transactions · ${uniqueCustomers} customers · ${USD0.format(total)} · newest first`}
          accent="rgba(26, 158, 92, 0.5)"
          rows={rows as unknown as Array<Record<string, unknown>>}
          columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
          filename={`services_${month}`}
          onClose={onClose}
        />
      );
    }
    // stream === 'connect'
    const rows = (connectByCustomer?.rows ?? [])
      .map((r) => {
        let lifetime = 0;
        for (const [k, v] of Object.entries(r)) {
          if (k === 'customer_name') continue;
          if (typeof v === 'number' && v > 0) lifetime += v;
        }
        return {
          name: r.customer_name,
          fee: typeof r[month] === 'number' ? (r[month] as number) : 0,
          lifetime_connect_fees: Math.round(lifetime * 100) / 100,
        };
      })
      .filter((r) => r.fee > 0)
      .sort((a, b) => b.fee - a.fee);
    const total = rows.reduce((s, r) => s + r.fee, 0);
    const columns: DrillColumn<(typeof rows)[number]>[] = [
      { key: 'name', label: 'Customer' },
      { key: 'fee', label: `${month} Connect fees`, align: 'right', render: (r) => USD0.format(r.fee) },
      {
        key: 'pct',
        label: '% of month total',
        align: 'right',
        render: (r) => (total > 0 ? `${((r.fee / total) * 100).toFixed(2)}%` : '—'),
        exportValue: (r) => (total > 0 ? r.fee / total : 0),
      },
      { key: 'lifetime_connect_fees', label: 'Lifetime Connect fees', align: 'right', render: (r) => USD0.format(r.lifetime_connect_fees) },
    ];
    return (
      <DrillDownPanel
        title={`Connect fees · ${monthLabel(month)}`}
        subtitle={`${rows.length} customers · ${USD0.format(total)} · sorted by fee desc`}
        accent="rgba(245, 158, 11, 0.5)"
        rows={rows as unknown as Array<Record<string, unknown>>}
        columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
        filename={`connect_${month}`}
        onClose={onClose}
        emptyMessage={month < '2024-01' ? 'Connect per-customer data starts Jan 2024.' : 'No Connect fees recorded for this month.'}
      />
    );
  }

  if (drill.kind === 'connect') {
    const rows = (connectByCustomer?.rows ?? [])
      .map((r) => {
        let lifetime = 0;
        for (const [k, v] of Object.entries(r)) {
          if (k === 'customer_name') continue;
          if (typeof v === 'number' && v > 0) lifetime += v;
        }
        return {
          name: r.customer_name,
          fee: typeof r[headlineMonth] === 'number' ? (r[headlineMonth] as number) : 0,
          lifetime_connect_fees: Math.round(lifetime * 100) / 100,
        };
      })
      .filter((r) => r.fee > 0)
      .sort((a, b) => b.fee - a.fee);
    const total = rows.reduce((s, r) => s + r.fee, 0);
    const columns: DrillColumn<(typeof rows)[number]>[] = [
      { key: 'name', label: 'Customer' },
      { key: 'fee', label: `${headlineMonth} Connect fees`, align: 'right', render: (r) => USD0.format(r.fee) },
      {
        key: 'pct',
        label: '% of month total',
        align: 'right',
        render: (r) => (total > 0 ? `${((r.fee / total) * 100).toFixed(2)}%` : '—'),
        exportValue: (r) => (total > 0 ? r.fee / total : 0),
      },
      { key: 'lifetime_connect_fees', label: 'Lifetime Connect fees', align: 'right', render: (r) => USD0.format(r.lifetime_connect_fees) },
    ];
    return (
      <DrillDownPanel
        title={`Connect fees · ${headlineMonth}`}
        subtitle={`${rows.length} customers · ${USD0.format(total)} · sorted by fee desc`}
        accent="rgba(245, 158, 11, 0.5)"
        rows={rows as unknown as Array<Record<string, unknown>>}
        columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
        filename={`connect_${headlineMonth}`}
        onClose={onClose}
      />
    );
  }

  if (drill.kind === 'active_logos' || drill.kind === 'blended') {
    const sorted = [...active].sort((a, b) => b.current_mrr - a.current_mrr);
    const totalMrr = sorted.reduce((s, c) => s + c.current_mrr, 0);
    const columns: DrillColumn<ActiveCustomer>[] = [
      { key: 'name', label: 'Customer' },
      { key: 'current_mrr', label: 'Current MRR', align: 'right', render: (r) => USD0.format(r.current_mrr) },
      {
        key: 'pct',
        label: '% of MRR',
        align: 'right',
        render: (r) => `${((r.current_mrr / totalMrr) * 100).toFixed(2)}%`,
        exportValue: (r) => r.current_mrr / totalMrr,
      },
      { key: 'lifetime_revenue', label: 'Lifetime revenue', align: 'right', render: (r) => USD0.format(r.lifetime_revenue) },
      { key: 'years_with_us', label: 'Years', align: 'right', render: (r) => (r.years_with_us != null ? r.years_with_us.toFixed(1) : '—') },
    ];
    const titleMap: Record<string, string> = {
      active_logos: 'Active paying customers',
      blended: 'Blended MRR contributors',
    };
    return (
      <DrillDownPanel
        title={`${titleMap[drill.kind]} · ${headlineMonth}`}
        subtitle={`${sorted.length} customers · ${USD0.format(totalMrr)}/mo total · sorted by MRR desc`}
        rows={sorted as unknown as Array<Record<string, unknown>>}
        columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
        filename={`${drill.kind}_${headlineMonth}`}
        onClose={onClose}
      />
    );
  }

  if (drill.kind === 'subscription') {
    const allRows = transactionsForMonth(headlineMonth, 'subscription');
    const rows =
      subFilter === 'annualized' ? allRows.filter((r) => r.is_annualized)
      : subFilter === 'regular' ? allRows.filter((r) => !r.is_annualized)
      : allRows;
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const grandTotal = allRows.reduce((s, r) => s + r.amount, 0);
    const annualizedTotal = allRows.filter((r) => r.is_annualized).reduce((s, r) => s + r.amount, 0);
    const uniqueCustomers = new Set(rows.map((r) => r.customer)).size;
    const columns: DrillColumn<(typeof rows)[number]>[] = [
      {
        key: 'date',
        label: 'Date',
        render: (r) => formatDateMDY(r.date),
        exportValue: (r) => formatDateMDY(r.date),
        sortValue: (r) => r.date,
      },
      { key: 'customer', label: 'Customer' },
      {
        key: 'type',
        label: 'Type',
        render: (r) => (
          <Chip
            label={r.is_annualized ? 'Annualized' : 'Monthly'}
            size="small"
            sx={{
              height: 18,
              fontSize: 10,
              fontWeight: 500,
              bgcolor: r.is_annualized ? 'rgba(159, 122, 234, 0.14)' : 'rgba(44, 115, 255, 0.10)',
              color: r.is_annualized ? '#9F7AEA' : 'primary.main',
            }}
          />
        ),
        exportValue: (r) => (r.is_annualized ? 'Annualized' : 'Monthly'),
        sortValue: (r) => (r.is_annualized ? 1 : 0),
      },
      { key: 'amount', label: `${headlineMonth} amount`, align: 'right', render: (r) => USD0.format(r.amount) },
      {
        key: 'pct',
        label: '% of month total',
        align: 'right',
        render: (r) => (grandTotal > 0 ? `${((r.amount / grandTotal) * 100).toFixed(2)}%` : '—'),
        exportValue: (r) => (grandTotal > 0 ? r.amount / grandTotal : 0),
      },
      { key: 'description', label: 'Description' },
    ];
    return (
      <Box id="drill-down-panel">
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Filter
          </Typography>
          <ToggleButtonGroup
            value={subFilter}
            exclusive
            size="small"
            onChange={(_, v) => v && setSubFilter(v)}
            sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="all">All ({allRows.length})</ToggleButton>
            <ToggleButton value="regular">Regular monthly ({allRows.filter((r) => !r.is_annualized).length})</ToggleButton>
            <ToggleButton value="annualized">Annual payments ({allRows.filter((r) => r.is_annualized).length})</ToggleButton>
          </ToggleButtonGroup>
          {annualizedTotal > 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              · {USD0.format(annualizedTotal)} annualized of {USD0.format(grandTotal)} total
            </Typography>
          )}
        </Stack>
        <DrillDownPanel
          title={`Subscription MRR contributors · ${headlineMonth}`}
          subtitle={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'} · ${uniqueCustomers} customers · ${USD0.format(total)} shown${subFilter !== 'all' ? ` (of ${USD0.format(grandTotal)} total)` : ''} · newest first`}
          rows={rows as unknown as Array<Record<string, unknown>>}
          columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
          filename={`subscription_${headlineMonth}${subFilter === 'all' ? '' : '_' + subFilter}`}
          onClose={onClose}
        />
      </Box>
    );
  }

  if (drill.kind === 'services') {
    const rows = transactionsForMonth(headlineMonth, 'services');
    const total = rows.reduce((s, r) => s + r.amount, 0);
    const uniqueCustomers = new Set(rows.map((r) => r.customer)).size;
    const columns: DrillColumn<(typeof rows)[number]>[] = [
      {
        key: 'date',
        label: 'Date',
        render: (r) => formatDateMDY(r.date),
        exportValue: (r) => formatDateMDY(r.date),
        sortValue: (r) => r.date,
      },
      { key: 'customer', label: 'Customer' },
      { key: 'amount', label: `${headlineMonth} amount`, align: 'right', render: (r) => USD0.format(r.amount) },
      {
        key: 'pct',
        label: '% of month total',
        align: 'right',
        render: (r) => (total > 0 ? `${((r.amount / total) * 100).toFixed(2)}%` : '—'),
        exportValue: (r) => (total > 0 ? r.amount / total : 0),
      },
      { key: 'description', label: 'Description' },
    ];
    return (
      <DrillDownPanel
        title={`Services transactions · ${headlineMonth}`}
        subtitle={`${rows.length} transactions · ${uniqueCustomers} customers · ${USD0.format(total)} this month · newest first`}
        rows={rows as unknown as Array<Record<string, unknown>>}
        columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
        filename={`services_${headlineMonth}`}
        onClose={onClose}
      />
    );
  }

  return null;
}


