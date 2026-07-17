import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, ComposedChart, Bar, Area, Legend } from 'recharts';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import Collapse from '@mui/material/Collapse';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import type { CsvColumn } from '../lib/csvExport';
import { useSheetTab } from '../hooks/useSheetTab';

type WaterfallMonthlyRow = {
  month: string;
  gross_churn_rate_monthly?: number | null;
  nrr_monthly?: number | null;
  grr_monthly?: number | null;
  details: {
    new: Array<{ name: string; mrr: number }>;
    churn: Array<{ name: string; mrr: number }>;
  };
};
type WaterfallSnap = { monthly: WaterfallMonthlyRow[] };

type ServicesRow = { customer_name: string } & Record<string, number | null>;
type ServicesSnap = { rows: ServicesRow[] };

type DrillKind = 'ttm_new' | 'ttm_churn' | 'services';

type MonthlyRow = {
  month: string;
  subscription_revenue: number;
  services_revenue: number;
  connect_revenue: number;
  total_income: number;
  cogs: number;
  gross_profit: number;
  gross_margin: number | null;
  subscription_gross_margin: number | null;
  snm_expense: number;
  new_logos: number;
  cac: number | null;
  logo_qty: number | null;
  avg_mrr_per_customer: number | null;
  net_op_income: number;
};

type UnitEconSnapshot = {
  monthly: MonthlyRow[];
  ttm: {
    windowStart: string;
    windowEnd: string;
    subscription_revenue: number;
    services_revenue: number;
    connect_revenue: number;
    affiliate_revenue: number;
    total_income: number;
    cogs: number;
    gross_profit: number;
    gross_margin: number | null;
    subscription_gross_margin: number | null;
    snm_expense: number;
    new_logos: number;
    cac: number | null;
    net_op_income: number;
    monthly_churn_rate: number | null;
    annual_churn_rate: number | null;
    avg_mrr_per_customer: number | null;
    logo_qty_latest: number | null;
    ltv: number | null;
    cac_payback_months: number | null;
    ltv_cac_ratio: number | null;
  };
  services: {
    total_customers_ever: number;
    customers_bought_services: number;
    attach_rate: number | null;
    avg_services_revenue_per_attached_customer: number | null;
  };
  connect?: {
    customers_using_connect: number;
    active_logos: number | null;
    attach_rate: number | null;
    connect_revenue_ttm: number;
    avg_connect_revenue_per_connect_customer: number | null;
    avg_monthly_connect_revenue: number;
  };
  notes: string;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function pct(v: number | null, digits = 1) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}
function months(v: number | null) {
  return v == null ? '—' : `${v.toFixed(1)} mo`;
}
function ratio(v: number | null) {
  return v == null ? '—' : `${v.toFixed(2)}x`;
}
function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

// Benchmark colors — industry standard bands for each metric.
function paybackColor(m: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (m == null) return 'text.primary';
  if (m <= 12) return 'success.main';
  if (m <= 18) return 'warning.main';
  return 'error.main';
}
function ltvCacColor(r: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (r == null) return 'text.primary';
  if (r >= 3) return 'success.main';
  if (r >= 1) return 'warning.main';
  return 'error.main';
}
function churnColor(r: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (r == null) return 'text.primary';
  if (r <= 0.10) return 'success.main';
  if (r <= 0.20) return 'warning.main';
  return 'error.main';
}
function gmColor(r: number | null): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (r == null) return 'text.primary';
  if (r >= 0.75) return 'success.main';
  if (r >= 0.60) return 'warning.main';
  return 'error.main';
}

export default function UnitEconomics() {
  const { data, isLoading, error } = useSheetTab('unit_economics');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: svcData } = useSheetTab('services_by_month');
  // Connect economics — live GMV / take / fee + attach + expansion levers.
  const { data: connectData } = useSheetTab('connect_volume');
  const cv = connectData as unknown as {
    annualized?: { gross_volume: number; fee_revenue: number; txn_count: number; blended_take_rate: number | null; basis: string };
    attach?: { active_customers: number; active_customers_on_connect: number; attach_rate: number | null; connected_accounts: number };
    penetration?: { processing_now: number; attach_target_fee_potential: number };
    scenarios?: Array<{ take_rate: number; annual_fee_revenue: number; delta_vs_current: number; multiple_vs_current: number | null }>;
  } | undefined;
  const snap = data as unknown as UnitEconSnapshot | undefined;
  const wf = wfData as unknown as WaterfallSnap | undefined;
  const svcSheet = svcData as unknown as ServicesSnap | undefined;
  const ttm = snap?.ttm;
  const svc = snap?.services;

  const [drill, setDrill] = useState<DrillKind | null>(null);
  const [streamBasis, setStreamBasis] = useState<'annual' | 'monthly'>('annual');
  const ttmTable = useCollapse(true);
  function openDrill(d: DrillKind) {
    setDrill(d);
    setTimeout(() => {
      document.getElementById('drill-down-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  // Per-stream unit economics: Subscription (MRR) / Services / Stripe Connect.
  // Revenue + share use the TTM block so all three align to one 12-mo window.
  // Subscription & Services are QuickBooks-sourced (may lag a month or two);
  // Connect is platform-fee revenue from connect_by_month and is current — so
  // the stacked trend only plots months where QB subscription data is present.
  const streams = useMemo(() => {
    if (!snap?.ttm) return null;
    const t = snap.ttm;
    const total = (t.subscription_revenue || 0) + (t.services_revenue || 0) + (t.connect_revenue || 0);
    const share = (v: number) => (total > 0 ? v / total : 0);
    // Each card carries the TTM (annual) figures; the UI divides by 12 for the
    // Monthly view. `recurring` streams (MRR, Connect) have a meaningful monthly
    // per-customer rate; Services is project-based so its per-customer figure is
    // shown as a lifetime average regardless of basis.
    const cards = [
      {
        key: 'mrr', label: 'Subscription (MRR)', color: '#2C73FF',
        revenue: t.subscription_revenue, share: share(t.subscription_revenue), recurring: true,
        customers: t.logo_qty_latest, customersLabel: 'active customers',
        arpu: t.avg_mrr_per_customer != null ? t.avg_mrr_per_customer * 12 : null, arpuNoun: 'customer', lifetimeArpu: false,
        margin: t.subscription_gross_margin,
        note: t.logo_qty_latest != null ? 'latest complete month' : null,
      },
      {
        key: 'services', label: 'Services', color: '#F5A623',
        revenue: t.services_revenue, share: share(t.services_revenue), recurring: false,
        customers: snap.services?.customers_bought_services ?? null, customersLabel: 'ever bought services',
        arpu: snap.services?.avg_services_revenue_per_attached_customer ?? null, arpuNoun: 'attached customer', lifetimeArpu: true,
        margin: null,
        note: snap.services?.attach_rate != null ? `${(snap.services.attach_rate * 100).toFixed(0)}% of all customers attach` : null,
      },
      {
        key: 'connect', label: 'Stripe Connect', color: '#14B8A6',
        revenue: t.connect_revenue, share: share(t.connect_revenue), recurring: true,
        customers: snap.connect?.customers_using_connect ?? null, customersLabel: 'active on Connect',
        arpu: snap.connect?.avg_connect_revenue_per_connect_customer ?? null, arpuNoun: 'Connect customer', lifetimeArpu: false,
        margin: null,
        note: snap.connect?.attach_rate != null ? `${(snap.connect.attach_rate * 100).toFixed(0)}% of active book uses Connect` : null,
      },
    ];
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const trendRows = snap.monthly
      .filter((m) => m.month < currentMonth && m.subscription_revenue > 0)
      .slice(-24)
      .map((m) => ({ month: m.month, Subscription: m.subscription_revenue, Services: m.services_revenue, Connect: m.connect_revenue }));
    return { cards, total, trendRows };
  }, [snap]);

  // Rolling trailing-12-month unit economics, anchored at each month M (window = M-11..M).
  // Each row gives a smoothed snapshot of how UE would have looked if you'd run a TTM at that
  // anchor — far less noisy than literal single-month UE (where a month with 0 new logos sends
  // CAC to infinity). Same math the 12M header cards use, applied per anchor month.
  const monthlyTtm = useMemo(() => {
    if (!snap || snap.monthly.length < 12) return [];
    const endMonth = snap.ttm?.windowEnd ?? snap.monthly[snap.monthly.length - 1].month;
    const completeRows = snap.monthly.filter((r) => r.month <= endMonth);
    const wfMonthly = wf?.monthly ?? [];

    const out: Array<{
      month: string;
      cac: number | null;
      ltv: number | null;
      ltv_cac_ratio: number | null;
      cac_payback_months: number | null;
      monthly_churn_rate: number | null;
      annual_churn_rate: number | null;
      gross_margin: number | null;
      subscription_gross_margin: number | null;
      avg_mrr_per_customer: number | null;
      new_logos: number;
      snm_expense: number;
      // Trend-first additions:
      subscription_revenue: number;
      services_revenue: number;
      connect_revenue: number;
      total_revenue: number;
      net_op_income: number | null;
      nrr: number | null;
      grr: number | null;
      logos: number | null;
      pnl_complete: boolean;
    }> = [];

    for (let i = 11; i < completeRows.length; i++) {
      const rows = completeRows.slice(i - 11, i + 1);
      const last = rows[rows.length - 1];

      const sum = (k: keyof MonthlyRow) =>
        rows.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);

      const total_income = sum('total_income');
      const gross_profit = sum('gross_profit');
      const snm_expense = sum('snm_expense');
      const new_logos = sum('new_logos');

      // Revenue streams (live MRR — available every month, so these plot the full range).
      const subscription_revenue = sum('subscription_revenue');
      const services_revenue = sum('services_revenue');
      const connect_revenue = sum('connect_revenue');
      const total_revenue = subscription_revenue + services_revenue + connect_revenue;

      // Profitability metrics hard-stop where the P&L coverage ends: a trailing
      // window that mixes live-revenue months with missing COGS would drag the
      // margin down artificially. Valid only when EVERY month in the window has
      // P&L (cogs present) — matches the "hard-stop the lines" decision.
      const pnl_complete = rows.every((r) => r.cogs != null);
      const net_op_income = pnl_complete ? sum('net_op_income') : null;

      // Trailing-12M retention: compound the monthly NRR/GRR ratios from the
      // waterfall (annualized retention — the figure a buyer scrutinizes).
      const retRows = wfMonthly.filter((r) => r.month >= rows[0].month && r.month <= last.month);
      const nrr = retRows.length === 12 ? retRows.reduce((a, r) => a * (r.nrr_monthly ?? 1), 1) : null;
      const grr = retRows.length === 12 ? retRows.reduce((a, r) => a * (r.grr_monthly ?? 1), 1) : null;
      const logos = last.logo_qty;

      const gross_margin = pnl_complete && total_income > 0 ? gross_profit / total_income : null;

      let subGmNum = 0;
      let subGmDen = 0;
      for (const r of rows) {
        if (r.subscription_gross_margin != null && r.subscription_revenue > 0) {
          subGmNum += r.subscription_gross_margin * r.subscription_revenue;
          subGmDen += r.subscription_revenue;
        }
      }
      const subscription_gross_margin = subGmDen > 0 ? subGmNum / subGmDen : null;

      // CAC (and everything downstream — LTV, payback, ratio) is S&M-driven, so
      // it hard-stops with the P&L too.
      const cac = pnl_complete && new_logos > 0 ? snm_expense / new_logos : null;
      const avg_mrr_per_customer = last.avg_mrr_per_customer;

      const wfRows = wfMonthly.filter((r) => r.month >= rows[0].month && r.month <= last.month);
      const monthlyChurnAvg =
        wfRows.length > 0
          ? wfRows.reduce((s, r) => s + (r.gross_churn_rate_monthly ?? 0), 0) / wfRows.length
          : null;
      const annual_churn_rate =
        monthlyChurnAvg == null ? null : 1 - Math.pow(Math.max(1 - monthlyChurnAvg, 0), 12);

      const ltv =
        avg_mrr_per_customer != null && subscription_gross_margin != null && monthlyChurnAvg != null && monthlyChurnAvg > 0
          ? (avg_mrr_per_customer * subscription_gross_margin) / monthlyChurnAvg
          : null;
      const cac_payback_months =
        cac != null && avg_mrr_per_customer != null && subscription_gross_margin != null && avg_mrr_per_customer * subscription_gross_margin > 0
          ? cac / (avg_mrr_per_customer * subscription_gross_margin)
          : null;
      const ltv_cac_ratio = ltv != null && cac != null && cac > 0 ? ltv / cac : null;

      out.push({
        month: last.month,
        cac,
        ltv,
        ltv_cac_ratio,
        cac_payback_months,
        monthly_churn_rate: monthlyChurnAvg,
        annual_churn_rate,
        gross_margin,
        subscription_gross_margin,
        avg_mrr_per_customer,
        new_logos,
        snm_expense,
        subscription_revenue,
        services_revenue,
        connect_revenue,
        total_revenue,
        net_op_income,
        nrr,
        grr,
        logos,
        pnl_complete,
      });
    }
    return out;
  }, [snap, wf]);

  // Latest complete trailing-12M anchor — the "current" values the KPI strip shows.
  const latest = useMemo(() => (monthlyTtm.length ? monthlyTtm[monthlyTtm.length - 1] : null), [monthlyTtm]);

  // Flat series for the recharts trend panels. Cap at the most recent 60 anchor
  // months (5 years) so the x-axis stays legible; the full series is in the
  // table + CSV below. Profitability fields carry `null` past the P&L coverage
  // so their lines hard-stop instead of drawing a misleading blended tail.
  const chartData = useMemo(
    () =>
      monthlyTtm.slice(-60).map((r) => ({
        month: r.month,
        Subscription: r.subscription_revenue,
        Services: r.services_revenue,
        Connect: r.connect_revenue,
        nrr: r.nrr,
        grr: r.grr,
        gross_margin: r.gross_margin,
        net_op_income: r.net_op_income,
        cac_payback_months: r.cac_payback_months,
        ltv_cac_ratio: r.ltv_cac_ratio,
      })),
    [monthlyTtm],
  );
  // Where the profitability lines stop (last anchor with a complete P&L window).
  const lastPnlMonth = useMemo(() => {
    for (let i = monthlyTtm.length - 1; i >= 0; i--) if (monthlyTtm[i].pnl_complete) return monthlyTtm[i].month;
    return null;
  }, [monthlyTtm]);

  // For a KPI headline: the last anchor with a value (profitability metrics
  // hard-stop before the latest anchor), and the value 6 anchors earlier for
  // the Δ. Reads straight off monthlyTtm so churn (not in chartData) works too.
  const kpiVal = (key: string): { cur: number | null; prev: number | null } => {
    let ci = -1;
    for (let i = monthlyTtm.length - 1; i >= 0; i--) {
      const v = (monthlyTtm[i] as unknown as Record<string, number | null>)[key];
      if (v != null) { ci = i; break; }
    }
    if (ci < 0) return { cur: null, prev: null };
    const cur = (monthlyTtm[ci] as unknown as Record<string, number | null>)[key];
    const pi = ci - 6;
    const prev = pi >= 0 ? (monthlyTtm[pi] as unknown as Record<string, number | null>)[key] : null;
    return { cur, prev };
  };

  // Show the most recent 24 anchor months in the table — keeps the scroll manageable while
  // still showing two years of trajectory. Reversed so the latest month sits at the top.
  const monthlyTtmVisible = useMemo(() => monthlyTtm.slice(-24).reverse(), [monthlyTtm]);

  const monthlyTtmCsvColumns: CsvColumn<(typeof monthlyTtm)[number]>[] = [
    { key: 'month', label: 'Anchor month' },
    { key: 'cac', label: 'CAC' },
    { key: 'ltv', label: 'LTV' },
    { key: 'ltv_cac_ratio', label: 'LTV:CAC' },
    { key: 'cac_payback_months', label: 'CAC payback (months)' },
    { key: 'monthly_churn_rate', label: 'Monthly churn rate' },
    { key: 'annual_churn_rate', label: 'Annual churn rate' },
    { key: 'gross_margin', label: 'Gross margin' },
    { key: 'subscription_gross_margin', label: 'Subscription gross margin' },
    { key: 'avg_mrr_per_customer', label: 'Avg MRR per customer (anchor month)' },
    { key: 'new_logos', label: 'New logos in window' },
    { key: 'snm_expense', label: 'S&M spend in window' },
  ];

  return (
    <Box>
      <PageHeader
        title="Unit Economics"
        subtitle="What it costs to acquire a customer and what they return over their lifetime — guides pricing, sales-spend, and retention investment decisions."
        question="efficient"
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load unit_economics — {String(error)}
        </Alert>
      )}

      {/* Coverage caveats — every metric is a trailing-12M trend; the window IS the
          graph (no 3/6/12M toggle). Retention/revenue are live; profitability
          lines hard-stop where the P&L coverage ends. */}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Every metric below is a trailing-12-month trend — the window is the graph.
        </Typography>
        <Box sx={{ px: 1, py: 0.25, borderRadius: 5, border: '1px solid', borderColor: 'rgba(26,158,92,0.4)', color: 'success.light', fontSize: 11 }}>
          Retention &amp; revenue · live through {latest ? monthLabel(latest.month) : '—'}
        </Box>
        <Box sx={{ px: 1, py: 0.25, borderRadius: 5, border: '1px solid', borderColor: 'rgba(245,166,35,0.4)', color: 'warning.light', fontSize: 11 }}>
          Margin / LTV / CAC · P&amp;L through {lastPnlMonth ? monthLabel(lastPnlMonth) : '—'}
        </Box>
      </Stack>

      {/* Headline KPI strip — current trailing-12M value + benchmark + Δ vs 6mo + sparkline */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {([
          { label: 'Net revenue retention', fmt: (v: number) => pct(v), bench: 'Target ≥ 100%', good: 'up' as const, color: '#1A9E5C', dataKey: 'nrr', deltaFmt: (d: number) => `${(d * 100).toFixed(1)}pt` },
          { label: 'Gross revenue retention', fmt: (v: number) => pct(v), bench: 'Target ≥ 90%', good: 'up' as const, color: '#9F7AEA', dataKey: 'grr', deltaFmt: (d: number) => `${(d * 100).toFixed(1)}pt` },
          { label: 'LTV : CAC', fmt: (v: number) => ratio(v), bench: 'Target ≥ 3×', good: 'up' as const, color: '#2C73FF', dataKey: 'ltv_cac_ratio', deltaFmt: (d: number) => `${d.toFixed(1)}×` },
          { label: 'CAC payback', fmt: (v: number) => months(v), bench: 'Good ≤ 12 mo', good: 'down' as const, color: '#F5A623', dataKey: 'cac_payback_months', deltaFmt: (d: number) => `${Math.abs(d).toFixed(1)} mo` },
          { label: 'Gross margin', fmt: (v: number) => pct(v), bench: 'Target ≥ 75%', good: 'up' as const, color: '#1A9E5C', dataKey: 'gross_margin', deltaFmt: (d: number) => `${(d * 100).toFixed(1)}pt` },
          { label: 'Annual logo churn', fmt: (v: number) => pct(v), bench: 'Lower is better', good: 'down' as const, color: '#DA3633', dataKey: 'annual_churn_rate', deltaFmt: (d: number) => `${(Math.abs(d) * 100).toFixed(1)}pt` },
        ]).map((k) => {
          const { cur, prev } = kpiVal(k.dataKey);
          return (
            <Grid item xs={6} sm={4} md={2} key={k.label}>
              <KpiTile
                label={k.label}
                value={cur != null ? k.fmt(cur) : '—'}
                bench={k.bench}
                cur={cur}
                prev={prev}
                good={k.good}
                color={k.color}
                deltaFmt={k.deltaFmt}
                spark={monthlyTtm.slice(-24).map((r) => ({ v: (r as unknown as Record<string, number | null>)[k.dataKey] }))}
                loading={isLoading}
              />
            </Grid>
          );
        })}
      </Grid>

      {/* Trend panels — Growth · Retention · Margins & Profitability · Efficiency */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <TrendPanel group="Growth" title="Revenue by stream" ctx="Trailing-12M revenue, stacked — subscription is the durable base; Connect is the fastest-growing lever." loading={isLoading}
            info={<><strong>What it is:</strong> Trailing-12-month revenue split by stream, stacked. Live MRR (subscription / services) plus Connect platform-fee revenue.<br /><br /><strong>Read:</strong> A widening Connect band with a stable subscription base is the expansion story a buyer wants.</>}>
            <ResponsiveContainer>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={10} interval={Math.max(0, Math.floor(chartData.length / 8))} />
                <YAxis stroke="#8B949E" fontSize={10} width={48} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <RTooltip labelFormatter={(v) => monthLabel(String(v))} formatter={(v: number, n: string) => [USD0.format(v), n]} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="Subscription" stackId="rev" stroke="#2C73FF" fill="#2C73FF" fillOpacity={0.75} />
                <Area type="monotone" dataKey="Services" stackId="rev" stroke="#F5A623" fill="#F5A623" fillOpacity={0.75} />
                <Area type="monotone" dataKey="Connect" stackId="rev" stroke="#14B8A6" fill="#14B8A6" fillOpacity={0.75} />
              </ComposedChart>
            </ResponsiveContainer>
          </TrendPanel>
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendPanel group="Retention" title="Net & gross revenue retention" ctx="Annualized NRR / GRR, trailing 12 months. The single most scrutinized quality signal — trajectory matters more than the point." loading={isLoading}
            info={<><strong>What it is:</strong> Trailing-12M retention, computed by compounding the waterfall's monthly NRR/GRR ratios.<br /><br /><strong>NRR</strong> includes expansion; <strong>GRR</strong> is retention before upsell. Dashed line = 100% (no net change).</>}>
            <ResponsiveContainer>
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={10} interval={Math.max(0, Math.floor(chartData.length / 8))} />
                <YAxis stroke="#8B949E" fontSize={10} width={44} tickFormatter={(v) => `${Math.round(v * 100)}%`} domain={[0.4, 1.3]} />
                <ReferenceLine y={1} stroke="#8B949E" strokeDasharray="4 4" />
                <RTooltip labelFormatter={(v) => monthLabel(String(v))} formatter={(v: number, n: string) => [pct(v), n === 'nrr' ? 'NRR' : 'GRR']} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }} />
                <Line type="monotone" dataKey="nrr" name="NRR" stroke="#1A9E5C" strokeWidth={2.2} dot={false} connectNulls />
                <Line type="monotone" dataKey="grr" name="GRR" stroke="#9F7AEA" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </TrendPanel>
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendPanel group="Margins & profitability" title="Gross margin & net operating income" ctx={`Gross-margin line + monthly net operating income (bars). Lines hard-stop at ${lastPnlMonth ? monthLabel(lastPnlMonth) : 'the last P&L month'} where P&L coverage ends.`} loading={isLoading}
            info={<><strong>What it is:</strong> Trailing-12M blended gross margin (line) and net operating income (bars, EBITDA proxy).<br /><br /><strong>Hard-stop:</strong> Both derive from the QuickBooks P&L, so they end at the last month with a complete trailing window rather than drawing a misleading blended tail against live revenue.</>}>
            <ResponsiveContainer>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={10} interval={Math.max(0, Math.floor(chartData.length / 8))} />
                <YAxis yAxisId="gm" stroke="#8B949E" fontSize={10} width={40} tickFormatter={(v) => `${Math.round(v * 100)}%`} domain={[0.5, 1]} />
                <YAxis yAxisId="op" orientation="right" stroke="#8B949E" fontSize={10} width={48} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <ReferenceLine yAxisId="gm" y={0.75} stroke="#8B949E" strokeDasharray="4 4" />
                <ReferenceLine yAxisId="op" y={0} stroke="rgba(139,148,158,0.4)" />
                <RTooltip labelFormatter={(v) => monthLabel(String(v))} formatter={(v: number, n: string) => (n === 'Gross margin' ? [pct(v), n] : [USD0.format(v), n])} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="op" dataKey="net_op_income" name="Net op income" fill="rgba(44,115,255,0.45)" />
                <Line yAxisId="gm" type="monotone" dataKey="gross_margin" name="Gross margin" stroke="#1A9E5C" strokeWidth={2.2} dot={false} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </TrendPanel>
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendPanel group="Efficiency" title="CAC payback & LTV : CAC" ctx="Payback in months (target ≤ 12) + LTV:CAC (target ≥ 3×). Improving = acquisition compounding. Hard-stops with the P&L." loading={isLoading}
            info={<><strong>What it is:</strong> Trailing-12M CAC payback (months of gross profit to recover CAC) and the LTV:CAC ratio.<br /><br /><strong>Benchmarks:</strong> payback ≤ 12 mo is healthy; LTV:CAC ≥ 3× justifies sales spend. Both are S&M-driven, so they hard-stop with the P&L.</>}>
            <ResponsiveContainer>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={10} interval={Math.max(0, Math.floor(chartData.length / 8))} />
                <YAxis yAxisId="pb" stroke="#8B949E" fontSize={10} width={34} tickFormatter={(v) => `${v}`} />
                <YAxis yAxisId="lc" orientation="right" stroke="#8B949E" fontSize={10} width={34} tickFormatter={(v) => `${v}×`} />
                <ReferenceLine yAxisId="pb" y={12} stroke="#F5A623" strokeDasharray="4 4" />
                <ReferenceLine yAxisId="lc" y={3} stroke="rgba(44,115,255,0.4)" strokeDasharray="4 4" />
                <RTooltip labelFormatter={(v) => monthLabel(String(v))} formatter={(v: number, n: string) => (n === 'CAC payback (mo)' ? [months(v), n] : [ratio(v), n])} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line yAxisId="pb" type="monotone" dataKey="cac_payback_months" name="CAC payback (mo)" stroke="#F5A623" strokeWidth={2.2} dot={false} connectNulls={false} />
                <Line yAxisId="lc" type="monotone" dataKey="ltv_cac_ratio" name="LTV:CAC" stroke="#2C73FF" strokeWidth={2} dot={false} connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </TrendPanel>
        </Grid>
      </Grid>


      {/* Revenue streams — Subscription (MRR) / Services / Stripe Connect unit economics */}
      {streams && (
        <Paper sx={{ p: 3, mb: 3 }}>
          <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography variant="h6">Revenue streams</Typography>
              <InfoIcon info={<><strong>The three revenue streams and their per-customer economics.</strong><br /><br />Figures are trailing-12-month so all three align to one window; toggle <strong>Monthly</strong> to divide by 12 for an average monthly rate. <strong>Subscription</strong> and <strong>Services</strong> come from the QuickBooks P&L (which can lag the latest month or two); <strong>Stripe Connect</strong> is Allmoxy's platform-fee revenue (from connect_by_month) and is current. The stacked chart plots only months where QuickBooks subscription data is present, so recent QB-lagged months don't read as a cliff.</>} />
            </Stack>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={streamBasis}
              onChange={(_, v) => v && setStreamBasis(v as 'annual' | 'monthly')}
              sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
            >
              <ToggleButton value="annual">Annual (TTM)</ToggleButton>
              <ToggleButton value="monthly">Monthly avg</ToggleButton>
            </ToggleButtonGroup>
          </Stack>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
            {streamBasis === 'monthly' ? 'Avg per month over the' : 'Trailing'} 12 months · {monthLabel(ttm?.windowStart ?? '')} – {monthLabel(ttm?.windowEnd ?? '')} · total {USD_COMPACT.format(streamBasis === 'monthly' ? streams.total / 12 : streams.total)}{streamBasis === 'monthly' ? '/mo' : ''}
          </Typography>
          <Grid container spacing={2}>
            {streams.cards.map((c) => {
              const monthly = streamBasis === 'monthly';
              const revenue = monthly ? c.revenue / 12 : c.revenue;
              // ARPU: recurring streams convert to a per-month rate; project-based
              // Services keeps a lifetime average in both views.
              const arpuVal = c.arpu == null ? null : (monthly && c.recurring && !c.lifetimeArpu ? c.arpu / 12 : c.arpu);
              const arpuLabel = c.lifetimeArpu
                ? `avg lifetime / ${c.arpuNoun}`
                : `revenue / ${c.arpuNoun} / ${monthly ? 'mo' : 'yr'}`;
              return (
                <Grid item xs={12} md={4} key={c.key}>
                  <Box sx={{ p: 2, height: '100%', borderRadius: 1, border: '1px solid', borderColor: 'divider', borderTop: '3px solid', borderTopColor: c.color }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5, fontWeight: 700 }}>{c.label}</Typography>
                    <Typography variant="h5" sx={{ fontWeight: 600, mt: 0.5 }}>{USD_COMPACT.format(revenue)}<Box component="span" sx={{ fontSize: 13, fontWeight: 400, color: 'text.secondary' }}>{monthly ? '/mo' : '/yr'}</Box></Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{(c.share * 100).toFixed(1)}% of stream revenue</Typography>
                    <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      {[
                        { l: c.customersLabel, v: c.customers != null ? c.customers.toLocaleString() : '—' },
                        { l: arpuLabel, v: arpuVal != null ? USD0.format(arpuVal) : '—' },
                        { l: 'gross margin', v: c.margin != null ? pct(c.margin) : '—' },
                      ].map((row) => (
                        <Box key={row.l} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1 }}>
                          <Typography variant="caption" sx={{ color: 'text.secondary' }}>{row.l}</Typography>
                          <Typography variant="caption" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{row.v}</Typography>
                        </Box>
                      ))}
                      {c.note && <Typography variant="caption" sx={{ color: 'text.disabled' }}>{c.note}</Typography>}
                    </Box>
                  </Box>
                </Grid>
              );
            })}
          </Grid>
          <Box sx={{ height: 264, mt: 3 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={streams.trendRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="month" stroke="#8B949E" fontSize={10} interval={2} />
                <YAxis stroke="#8B949E" fontSize={10} width={48} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <RTooltip formatter={(v: number) => USD0.format(v)} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Subscription" stackId="rev" fill="#2C73FF" />
                <Bar dataKey="Services" stackId="rev" fill="#F5A623" />
                <Bar dataKey="Connect" stackId="rev" fill="#14B8A6" />
              </ComposedChart>
            </ResponsiveContainer>
          </Box>
        </Paper>
      )}

      {/* Connect economics — the platform-take business as its own unit */}
      {cv?.annualized && (() => {
        const an = cv.annualized!;
        const at = cv.attach;
        const pen = cv.penetration;
        const processing = pen?.processing_now || at?.active_customers_on_connect || 0;
        const feePerCustomer = processing > 0 ? an.fee_revenue / processing : null;
        const feePerTxn = an.txn_count > 0 ? an.fee_revenue / an.txn_count : null;
        const avgTxnSize = an.txn_count > 0 ? an.gross_volume / an.txn_count : null;
        const s1 = (cv.scenarios || []).find((s) => Math.abs(s.take_rate - 0.01) < 1e-6);
        const attachPotential = pen?.attach_target_fee_potential ?? null;
        const metrics = [
          { l: 'Processing volume (GMV)', v: USD_COMPACT.format(an.gross_volume), s: 'annualized / TTM', color: '#14B8A6' },
          { l: 'Blended take rate', v: an.blended_take_rate != null ? (an.blended_take_rate * 100).toFixed(2) + '%' : '—', s: 'fee ÷ GMV' },
          { l: 'Connect fee revenue', v: USD0.format(an.fee_revenue), s: `${an.txn_count.toLocaleString()} transactions`, color: '#1A9E5C' },
          { l: 'Attach rate', v: at?.attach_rate != null ? (at.attach_rate * 100).toFixed(0) + '%' : '—', s: `${at?.active_customers_on_connect ?? '—'} of ${at?.active_customers ?? '—'} active customers` },
          { l: 'Fee / processing customer', v: feePerCustomer != null ? USD0.format(feePerCustomer) + '/yr' : '—', s: `${processing} processing now` },
          { l: 'Fee / transaction', v: feePerTxn != null ? '$' + feePerTxn.toFixed(2) : '—', s: avgTxnSize != null ? `on ${USD0.format(avgTxnSize)} avg charge` : '' },
        ];
        return (
          <Paper sx={{ p: 3, mb: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography variant="h6">Connect economics</Typography>
              <InfoIcon info={<><strong>The embedded-payments business as its own unit.</strong> Allmoxy takes a platform fee (~0.5%) on GMV processed through Stripe Connect. Live from the application_fees API ({an.basis}). Because it's a take on payments with negligible incremental cost, fee revenue is <strong>near-100% contribution margin</strong> — and it's underpenetrated, so the two levers below are pure upside.</>} />
            </Stack>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
              Platform-fee revenue on payments processed through Connect · near-100% contribution margin (no incremental COGS).
            </Typography>
            <Grid container spacing={2}>
              {metrics.map((m) => (
                <Grid item xs={6} md={2} key={m.l}>
                  <Box sx={{ p: 2, height: '100%', borderRadius: 1, border: '1px solid', borderColor: 'divider', ...(m.color && { borderTop: '3px solid', borderTopColor: m.color }) }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, fontWeight: 700, display: 'block' }}>{m.l}</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 600, mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>{m.v}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.disabled' }}>{m.s}</Typography>
                  </Box>
                </Grid>
              ))}
            </Grid>
            <Grid container spacing={2} sx={{ mt: 0.5 }}>
              <Grid item xs={12} md={6}>
                <Box sx={{ p: 2, borderRadius: 1, bgcolor: 'rgba(26,158,92,0.08)', border: '1px solid', borderColor: 'rgba(26,158,92,0.25)' }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lever 1 · Take-rate standardization</Typography>
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    The book is priced at ~0.5%. Standardizing to the <strong>1.0%</strong> some accounts already pay would lift Connect fee revenue to <strong style={{ color: '#1A9E5C' }}>{s1 ? USD0.format(s1.annual_fee_revenue) + '/yr' : '—'}</strong>{s1 ? <> ({s1.multiple_vs_current}× today, <strong>+{USD0.format(s1.delta_vs_current)}/yr</strong>)</> : ''} at zero acquisition cost.
                  </Typography>
                </Box>
              </Grid>
              <Grid item xs={12} md={6}>
                <Box sx={{ p: 2, borderRadius: 1, bgcolor: 'rgba(44,115,255,0.08)', border: '1px solid', borderColor: 'rgba(44,115,255,0.25)' }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Lever 2 · Attach growth</Typography>
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    Only {at?.attach_rate != null ? (at.attach_rate * 100).toFixed(0) + '%' : '—'} of active customers process on Connect. Attaching the non-processing book (capture-adjusted) is an estimated <strong style={{ color: '#2C73FF' }}>{attachPotential != null ? '+' + USD0.format(attachPotential) + '/yr' : '—'}</strong> in fee revenue — see the Payments Opportunity page for the per-customer targets.
                  </Typography>
                </Box>
              </Grid>
            </Grid>
          </Paper>
        );
      })()}


      {/* Rolling trailing-12 UE by anchor month — full month-over-month trajectory */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1} sx={{ mb: ttmTable.open ? 2 : 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <CollapseToggle open={ttmTable.open} onToggle={ttmTable.toggle} label="unit economics by month" />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Unit economics by month · trailing 12 anchored at each month
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> Every headline UE metric, computed as a trailing-12-month window anchored at the row's month. So the row for Apr 2026 represents how UE looked across May 2025 → Apr 2026.<br /><br /><strong>Why TTM instead of literal monthly:</strong> Single-month UE is noisy — a month with 0 new logos sends CAC to infinity; a quiet churn month inflates LTV. TTM smoothing matches how these metrics are actually used in board decks.<br /><br /><strong>Color bands:</strong> Same benchmarks as the headline cards (green = healthy, yellow = caution, red = below threshold).</>} />
          </Stack>
          <CsvExportButton
            filename={`unit_economics_monthly_ttm_${monthlyTtm.length > 0 ? monthlyTtm[monthlyTtm.length - 1].month : 'empty'}`}
            columns={monthlyTtmCsvColumns}
            rows={monthlyTtm}
            label="Export full series"
          />
        </Stack>
        <Collapse in={ttmTable.open} unmountOnExit>
        {isLoading ? (
          <Skeleton variant="rectangular" height={400} />
        ) : monthlyTtmVisible.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Not enough monthly data to build a trailing-12 window yet.
          </Typography>
        ) : (
          <TableContainer sx={{ maxHeight: 540 }}>
            <Table size="small" stickyHeader sx={{ '& td, & th': { whiteSpace: 'nowrap' }, '& td': { fontVariantNumeric: 'tabular-nums' } }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ position: 'sticky', left: 0, zIndex: 3, bgcolor: 'background.paper' }}>Month</TableCell>
                  <TableCell align="right">CAC</TableCell>
                  <TableCell align="right">LTV</TableCell>
                  <TableCell align="right">LTV : CAC</TableCell>
                  <TableCell align="right">Payback</TableCell>
                  <TableCell align="right">Annual churn</TableCell>
                  <TableCell align="right">GM</TableCell>
                  <TableCell align="right">Sub GM</TableCell>
                  <TableCell align="right">Avg MRR / cust</TableCell>
                  <TableCell align="right">New logos (12M)</TableCell>
                  <TableCell align="right">S&M (12M)</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {monthlyTtmVisible.map((r) => (
                  <TableRow key={r.month} hover>
                    <TableCell sx={{ position: 'sticky', left: 0, zIndex: 1, bgcolor: 'background.paper', fontWeight: 500 }}>{monthLabel(r.month)}</TableCell>
                    <TableCell align="right">{r.cac != null ? USD0.format(r.cac) : '—'}</TableCell>
                    <TableCell align="right">{r.ltv != null ? USD0.format(r.ltv) : '—'}</TableCell>
                    <TableCell align="right" sx={{ color: ltvCacColor(r.ltv_cac_ratio), fontWeight: 500 }}>{ratio(r.ltv_cac_ratio)}</TableCell>
                    <TableCell align="right" sx={{ color: paybackColor(r.cac_payback_months), fontWeight: 500 }}>{months(r.cac_payback_months)}</TableCell>
                    <TableCell align="right" sx={{ color: churnColor(r.annual_churn_rate), fontWeight: 500 }}>{pct(r.annual_churn_rate, 1)}</TableCell>
                    <TableCell align="right" sx={{ color: gmColor(r.gross_margin) }}>{pct(r.gross_margin)}</TableCell>
                    <TableCell align="right">{pct(r.subscription_gross_margin)}</TableCell>
                    <TableCell align="right">{r.avg_mrr_per_customer != null ? USD0.format(r.avg_mrr_per_customer) : '—'}</TableCell>
                    <TableCell align="right">{r.new_logos}</TableCell>
                    <TableCell align="right">{r.snm_expense != null ? USD_COMPACT.format(r.snm_expense) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {monthlyTtm.length > 24 && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
            Showing the latest 24 of {monthlyTtm.length} anchor months · use Export CSV for the full series back to {monthlyTtm[0].month}.
          </Typography>
        )}
        </Collapse>
      </Paper>

      {/* Services unit economics — separate view, since services is non-recurring */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Services add-on economics · non-recurring, tracked separately from subscription LTV
          </Typography>
          <InfoIcon info={<><strong>Why separate:</strong> Services revenue is project-based (one-off invoices), not recurring. Keeping it separate from subscription prevents one-off project dollars from inflating the recurring-revenue retention story.<br /><br /><strong>Data:</strong> Cards below are derived from Stripe Sync transactions classified as type=services.</>} />
        </Stack>
        <Grid container spacing={2}>
          <Grid item xs={12} md={3}>
            <StatCard
              label="Services attach rate"
              value={pct(svc?.attach_rate ?? null)}
              hint={svc ? `${svc.customers_bought_services} of ${svc.total_customers_ever} customers · click` : 'loading'}
              color="text.primary"
              loading={isLoading}
              compact
              onClick={() => openDrill('services')}
              info={<><strong>What it is:</strong> % of customers who have ever purchased services on top of their subscription.<br /><br /><strong>Data:</strong> Customers with ≥ 1 succeeded Stripe transaction of type=services ÷ total unique customers ever. Click to see the attached-customer list.</>}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <StatCard
              label="Avg services per attached customer"
              value={svc?.avg_services_revenue_per_attached_customer != null
                ? USD0.format(svc.avg_services_revenue_per_attached_customer)
                : '—'}
              hint="Lifetime services revenue among customers who bought any"
              color="text.primary"
              loading={isLoading}
              compact
              info={<><strong>What it is:</strong> Average lifetime services revenue per customer who ever bought services (denominator is attached customers only, not all customers).<br /><br /><strong>Data:</strong> Total services revenue across attached customers ÷ count of attached customers.</>}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <StatCard
              label="TTM services revenue"
              value={ttm ? USD_COMPACT.format(ttm.services_revenue) : null}
              hint={ttm ? `${((ttm.services_revenue / ttm.total_income) * 100).toFixed(1)}% of TTM total` : 'loading'}
              color="text.primary"
              loading={isLoading}
              compact
              info={<><strong>What it is:</strong> Services revenue recognized over the trailing 12 months. Hint shows the ratio to total revenue so you can see how material services is to the blended number.<br /><br /><strong>Data:</strong> Sum of "4300 Services Income" from QuickBooks P&L over the TTM window.</>}
            />
          </Grid>
          <Grid item xs={12} md={3}>
            <StatCard
              label="LTV uplift from services"
              value={
                svc?.avg_services_revenue_per_attached_customer != null && svc.attach_rate != null
                  ? USD0.format(svc.avg_services_revenue_per_attached_customer * svc.attach_rate)
                  : '—'
              }
              hint="Avg services $ × attach rate — added to blended LTV"
              info={<><strong>What it is:</strong> Expected services revenue uplift on a random new customer — added on top of subscription LTV to get total blended LTV.<br /><br /><strong>Data:</strong> Avg services per attached customer × Services attach rate. Attach rate is the "probability" a new customer buys services; avg is what they spend if they do.</>}
              color="text.primary"
              loading={isLoading}
              compact
            />
          </Grid>
        </Grid>
      </Paper>

      {drill && snap && ttm && (() => {
        // TTM window = ttm.windowStart..ttm.windowEnd inclusive.
        if ((drill === 'ttm_new' || drill === 'ttm_churn') && wf) {
          const ttmRows = wf.monthly.filter(
            (r) => r.month >= ttm.windowStart && r.month <= ttm.windowEnd
          );
          const combined = new Map<string, { name: string; mrr_sum: number; months: string[] }>();
          for (const r of ttmRows) {
            const list = drill === 'ttm_new' ? r.details.new : r.details.churn;
            for (const d of list) {
              const existing = combined.get(d.name);
              if (existing) {
                existing.mrr_sum += d.mrr;
                existing.months.push(r.month);
              } else {
                combined.set(d.name, { name: d.name, mrr_sum: d.mrr, months: [r.month] });
              }
            }
          }
          const rows = [...combined.values()].sort((a, b) => b.mrr_sum - a.mrr_sum);
          const total = rows.reduce((s, r) => s + r.mrr_sum, 0);
          const columns: DrillColumn<{ name: string; mrr_sum: number; months: string[] }>[] = [
            { key: 'name', label: 'Customer' },
            {
              key: 'month_first',
              label: drill === 'ttm_new' ? 'First new-MRR month' : 'Churn month',
              render: (r) => (drill === 'ttm_new' ? r.months[0] : r.months[r.months.length - 1]),
              exportValue: (r) => (drill === 'ttm_new' ? r.months[0] : r.months[r.months.length - 1]),
            },
            {
              key: 'mrr_sum',
              label: drill === 'ttm_new' ? 'MRR added' : 'MRR lost',
              align: 'right',
              render: (r) => USD0.format(r.mrr_sum),
            },
            {
              key: 'pct',
              label: '% of TTM total',
              align: 'right',
              render: (r) => (total > 0 ? `${((r.mrr_sum / total) * 100).toFixed(1)}%` : '—'),
              exportValue: (r) => (total > 0 ? r.mrr_sum / total : 0),
            },
          ];
          return (
            <DrillDownPanel
              title={
                drill === 'ttm_new'
                  ? `New customers · ${monthLabel(ttm.windowStart)} – ${monthLabel(ttm.windowEnd)}`
                  : `Churned customers · ${monthLabel(ttm.windowStart)} – ${monthLabel(ttm.windowEnd)}`
              }
              subtitle={`${rows.length} customers · ${USD0.format(total)} total MRR ${drill === 'ttm_new' ? 'added' : 'lost'}`}
              accent={drill === 'ttm_new' ? 'rgba(26, 158, 92, 0.5)' : 'rgba(218, 54, 51, 0.5)'}
              rows={rows as unknown as Array<Record<string, unknown>>}
              columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
              filename={`ttm_${drill}_${ttm.windowStart}_${ttm.windowEnd}`}
              onClose={() => setDrill(null)}
            />
          );
        }

        if (drill === 'services' && svcSheet) {
          const rows = svcSheet.rows
            .map((r) => {
              let lifetime = 0;
              let monthsActive = 0;
              let firstMonth: string | null = null;
              let lastMonth: string | null = null;
              for (const [k, v] of Object.entries(r)) {
                if (k === 'customer_name') continue;
                if (typeof v === 'number' && v > 0) {
                  lifetime += v;
                  monthsActive += 1;
                  if (firstMonth == null || k < firstMonth) firstMonth = k;
                  if (lastMonth == null || k > lastMonth) lastMonth = k;
                }
              }
              return {
                name: r.customer_name,
                first_services_month: firstMonth,
                last_services_month: lastMonth,
                months_with_services: monthsActive,
                lifetime_services_revenue: Math.round(lifetime * 100) / 100,
              };
            })
            .filter((r) => r.lifetime_services_revenue > 0)
            .sort((a, b) => b.lifetime_services_revenue - a.lifetime_services_revenue);
          const total = rows.reduce((s, r) => s + r.lifetime_services_revenue, 0);
          const columns: DrillColumn<(typeof rows)[number]>[] = [
            { key: 'name', label: 'Customer' },
            { key: 'first_services_month', label: 'First services month' },
            { key: 'last_services_month', label: 'Last services month' },
            { key: 'months_with_services', label: 'Months active', align: 'right' },
            {
              key: 'lifetime_services_revenue',
              label: 'Lifetime services $',
              align: 'right',
              render: (r) => USD0.format(r.lifetime_services_revenue),
            },
          ];
          return (
            <DrillDownPanel
              title={`Services customers · ${rows.length} attached`}
              subtitle={`${USD0.format(total)} lifetime services revenue · sorted by $`}
              rows={rows as unknown as Array<Record<string, unknown>>}
              columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
              filename={`services_customers`}
              onClose={() => setDrill(null)}
            />
          );
        }
        return null;
      })()}
    </Box>
  );
}

// Headline KPI tile: current trailing-12M value + benchmark + Δ vs 6mo + sparkline.
function KpiTile({
  label, value, bench, cur, prev, good, color, deltaFmt, spark, loading,
}: {
  label: string;
  value: string;
  bench: string;
  cur: number | null;
  prev: number | null;
  good: 'up' | 'down';
  color: string;
  deltaFmt: (d: number) => string;
  spark: Array<{ v: number | null }>;
  loading?: boolean;
}) {
  const delta = cur != null && prev != null ? cur - prev : null;
  // "Better" = moved in the good direction. Green when better, red when worse.
  const better = delta == null ? null : good === 'up' ? delta > 0 : delta < 0;
  const arrow = delta == null || delta === 0 ? '·' : delta > 0 ? '▲' : '▼';
  const deltaColor = better == null ? 'text.disabled' : better ? 'success.main' : 'error.main';
  return (
    <Paper sx={{ p: 1.5, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10, fontWeight: 700, lineHeight: 1.2 }}>
        {label}
      </Typography>
      {loading ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 26 }} />
      ) : (
        <Stack direction="row" alignItems="baseline" justifyContent="space-between" spacing={0.5}>
          <Typography sx={{ fontWeight: 650, fontSize: 24, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>{value}</Typography>
          {delta != null && (
            <Typography variant="caption" sx={{ color: deltaColor, fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {arrow} {deltaFmt(delta)}
            </Typography>
          )}
        </Stack>
      )}
      <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: 10, display: 'block' }}>{bench}</Typography>
      <Box sx={{ height: 34, mt: 0.5, mx: -0.5 }}>
        <ResponsiveContainer>
          <LineChart data={spark} margin={{ top: 4, right: 2, left: 2, bottom: 0 }}>
            <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </Paper>
  );
}

// Trend panel wrapper — section label, title, context line, InfoIcon, and a
// fixed-height chart area. Keeps the four trend sections visually consistent.
function TrendPanel({
  group, title, ctx, info, loading, children,
}: {
  group: string;
  title: string;
  ctx: string;
  info: React.ReactNode;
  loading?: boolean;
  children: React.ReactElement;
}) {
  return (
    <Paper sx={{ p: 3, height: '100%' }}>
      <Typography variant="caption" sx={{ color: 'text.disabled', textTransform: 'uppercase', letterSpacing: '0.12em', fontSize: 10, fontWeight: 700 }}>{group}</Typography>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="h6" sx={{ fontSize: 15 }}>{title}</Typography>
        <InfoIcon info={info} />
      </Stack>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>{ctx}</Typography>
      {loading ? <Skeleton variant="rectangular" height={200} /> : <Box sx={{ height: 200 }}>{children}</Box>}
    </Paper>
  );
}

function StatCard({
  label,
  value,
  hint,
  color,
  loading,
  compact = false,
  onClick,
  info,
}: {
  label: string;
  value: string | null;
  hint: string;
  color: string;
  loading?: boolean;
  compact?: boolean;
  onClick?: () => void;
  info?: React.ReactNode;
}) {
  return (
    <Paper
      sx={{
        p: compact ? 2 : 2.5,
        height: '100%',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background-color 120ms',
        '&:hover': onClick ? { bgcolor: 'rgba(44, 115, 255, 0.04)' } : {},
      }}
      onClick={onClick}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 0.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label}
        </Typography>
        {info && <Box onClick={(e) => e.stopPropagation()}><InfoIcon info={info} /></Box>}
      </Stack>
      {loading || value == null ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: compact ? 24 : 32 }} />
      ) : (
        <Typography variant={compact ? 'h5' : 'h4'} sx={{ fontWeight: 500, color }}>
          {value}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 11 }}>
        {hint}
      </Typography>
    </Paper>
  );
}
