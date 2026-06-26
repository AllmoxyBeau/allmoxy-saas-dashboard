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
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, ComposedChart, Bar, Legend } from 'recharts';
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
  const snap = data as unknown as UnitEconSnapshot | undefined;
  const wf = wfData as unknown as WaterfallSnap | undefined;
  const svcSheet = svcData as unknown as ServicesSnap | undefined;
  const ttm = snap?.ttm;
  const svc = snap?.services;

  const [drill, setDrill] = useState<DrillKind | null>(null);
  const [headerWindow, setHeaderWindow] = useState<'3M' | '6M' | '12M'>('12M');
  const [streamBasis, setStreamBasis] = useState<'annual' | 'monthly'>('annual');
  const ttmTable = useCollapse(true);
  function openDrill(d: DrillKind) {
    setDrill(d);
    setTimeout(() => {
      document.getElementById('drill-down-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  // Header stats computed for the selected trailing window.
  // Dollar fields (revenue, spend, net income) are summed over the window.
  // Rates are annualized so 3M / 6M / 12M stay apples-to-apples.
  // LTV assumes avg MRR in the last month × sub GM over window ÷ monthly churn rate.
  const windowStats = useMemo(() => {
    if (!snap || snap.monthly.length === 0) return null;
    // Anchor to the latest complete month (the builder already excludes partial).
    // Filter monthly rows up through the TTM windowEnd (which is the latest complete month).
    const endMonth = snap.ttm?.windowEnd ?? snap.monthly[snap.monthly.length - 1].month;
    const completeRows = snap.monthly.filter((r) => r.month <= endMonth);
    const N = headerWindow === '3M' ? 3 : headerWindow === '6M' ? 6 : 12;
    const rows = completeRows.slice(-N);
    if (rows.length === 0) return null;

    const sum = (k: keyof MonthlyRow) =>
      rows.reduce((a, r) => a + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);

    const subscription_revenue = sum('subscription_revenue');
    const services_revenue = sum('services_revenue');
    const connect_revenue = sum('connect_revenue');
    const total_income = sum('total_income');
    const cogs = sum('cogs');
    const gross_profit = sum('gross_profit');
    const snm_expense = sum('snm_expense');
    const new_logos = sum('new_logos');
    const net_op_income = sum('net_op_income');

    const gross_margin = total_income > 0 ? gross_profit / total_income : null;
    // Sub GM: weighted by each month's subscription revenue (when present).
    let subGmWeightedNum = 0;
    let subGmWeightedDen = 0;
    for (const r of rows) {
      if (r.subscription_gross_margin != null && r.subscription_revenue > 0) {
        subGmWeightedNum += r.subscription_gross_margin * r.subscription_revenue;
        subGmWeightedDen += r.subscription_revenue;
      }
    }
    const subscription_gross_margin = subGmWeightedDen > 0 ? subGmWeightedNum / subGmWeightedDen : null;

    const cac = new_logos > 0 ? snm_expense / new_logos : null;

    // Latest complete month values for snapshot metrics.
    const last = rows[rows.length - 1];
    const avg_mrr_per_customer = last.avg_mrr_per_customer;
    const logo_qty_latest = last.logo_qty;

    // Churn rate pulled from the waterfall's monthly gross_churn_rate for the matching months.
    const wfRows = (wf?.monthly ?? []).filter((r) => r.month >= rows[0].month && r.month <= last.month);
    let monthlyChurnAvg: number | null = null;
    if (wfRows.length > 0) {
      const vals = wfRows.map((r) => r.gross_churn_rate_monthly ?? 0);
      monthlyChurnAvg = vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    const annual_churn_rate =
      monthlyChurnAvg == null ? null : 1 - Math.pow(Math.max(1 - monthlyChurnAvg, 0), 12);

    // LTV and CAC payback use per-month economics.
    const ltv =
      avg_mrr_per_customer != null && subscription_gross_margin != null && monthlyChurnAvg != null && monthlyChurnAvg > 0
        ? (avg_mrr_per_customer * subscription_gross_margin) / monthlyChurnAvg
        : null;
    const cac_payback_months =
      cac != null && avg_mrr_per_customer != null && subscription_gross_margin != null && avg_mrr_per_customer * subscription_gross_margin > 0
        ? cac / (avg_mrr_per_customer * subscription_gross_margin)
        : null;
    const ltv_cac_ratio = ltv != null && cac != null && cac > 0 ? ltv / cac : null;

    return {
      windowStart: rows[0].month,
      windowEnd: last.month,
      windowMonths: rows.length,
      subscription_revenue,
      services_revenue,
      connect_revenue,
      total_income,
      cogs,
      gross_profit,
      snm_expense,
      new_logos,
      net_op_income,
      gross_margin,
      subscription_gross_margin,
      cac,
      avg_mrr_per_customer,
      logo_qty_latest,
      monthly_churn_rate: monthlyChurnAvg,
      annual_churn_rate,
      ltv,
      cac_payback_months,
      ltv_cac_ratio,
    };
  }, [snap, wf, headerWindow]);

  // Last 24 complete months for the trend charts (exclude current partial month).
  const trend = useMemo(() => {
    if (!snap) return [];
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return snap.monthly.filter((m) => m.month < currentMonth).slice(-24);
  }, [snap]);

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

      const gross_margin = total_income > 0 ? gross_profit / total_income : null;

      let subGmNum = 0;
      let subGmDen = 0;
      for (const r of rows) {
        if (r.subscription_gross_margin != null && r.subscription_revenue > 0) {
          subGmNum += r.subscription_gross_margin * r.subscription_revenue;
          subGmDen += r.subscription_revenue;
        }
      }
      const subscription_gross_margin = subGmDen > 0 ? subGmNum / subGmDen : null;

      const cac = new_logos > 0 ? snm_expense / new_logos : null;
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
      });
    }
    return out;
  }, [snap, wf]);

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

      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1} sx={{ mb: 2 }}>
        {windowStats ? (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {headerWindow} window: {monthLabel(windowStats.windowStart)} – {monthLabel(windowStats.windowEnd)} · rates annualized for comparability
          </Typography>
        ) : (
          <span />
        )}
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

      {/* Headline row: the five unit-economics numbers management runs against */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`CAC · ${headerWindow}`}
            value={windowStats ? USD0.format(windowStats.cac ?? 0) : null}
            hint={windowStats ? `${windowStats.new_logos} new logos · ${USD_COMPACT.format(windowStats.snm_expense)} S&M · click` : 'loading'}
            color="text.primary"
            loading={isLoading}
            onClick={() => openDrill('ttm_new')}
            info={<><strong>What it is:</strong> Customer Acquisition Cost — average sales & marketing dollars spent to win one new customer over the selected window.<br /><br /><strong>Data:</strong> Window S&M spend (QuickBooks: Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission) ÷ window new logos.<br /><br /><strong>Click</strong> to see the new-customer list.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`LTV · ${headerWindow}`}
            value={windowStats?.ltv != null ? USD0.format(windowStats.ltv) : null}
            hint={windowStats ? `${USD0.format(windowStats.avg_mrr_per_customer ?? 0)}/mo · ${pct(windowStats.subscription_gross_margin)} GM` : 'loading'}
            color="text.primary"
            loading={isLoading}
            info={<><strong>What it is:</strong> Customer Lifetime Value — gross profit a subscription customer generates before they churn.<br /><br /><strong>Data:</strong> Avg MRR per customer (last month of window) × window subscription gross margin ÷ window avg monthly gross churn rate. Services excluded (tracked separately below).<br /><br /><strong>Target:</strong> Should be materially higher than CAC.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`LTV : CAC · ${headerWindow}`}
            value={ratio(windowStats?.ltv_cac_ratio ?? null)}
            hint="Target ≥ 3x · best-in-class ≥ 5x"
            color={ltvCacColor(windowStats?.ltv_cac_ratio ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> The ratio of lifetime customer value to acquisition cost — the single most scrutinized SaaS unit-economics ratio.<br /><br /><strong>Data:</strong> LTV ÷ CAC for the selected window.<br /><br /><strong>Target:</strong> ≥ 3x justifies sales spend · ≥ 5x top-quartile · &lt; 1x means you're losing money per customer.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`CAC payback · ${headerWindow}`}
            value={months(windowStats?.cac_payback_months ?? null)}
            hint="Good ≤ 12 mo · caution 12–18 · red > 18"
            color={paybackColor(windowStats?.cac_payback_months ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> Months of gross profit needed to recover CAC.<br /><br /><strong>Data:</strong> Window CAC ÷ (Avg MRR × Subscription gross margin).<br /><br /><strong>Target:</strong> ≤ 12 mo good · 12–18 caution · &gt; 18 inefficient.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <StatCard
            label={`Annual logo churn · ${headerWindow}`}
            value={pct(windowStats?.annual_churn_rate ?? null, 1)}
            hint={windowStats ? `Monthly avg: ${pct(windowStats.monthly_churn_rate, 2)} · click for list` : 'loading'}
            color={churnColor(windowStats?.annual_churn_rate ?? null)}
            loading={isLoading}
            onClick={() => openDrill('ttm_churn')}
            info={<><strong>What it is:</strong> Annualized customer churn rate over the selected window.<br /><br /><strong>Data:</strong> Monthly churn averaged across window, then compounded: 1 − (1 − avg_monthly_churn)^12.<br /><br /><strong>Why toggle:</strong> 3M vs 12M reveals trajectory — if 3M &gt; 12M, churn is accelerating.</>}
          />
        </Grid>
      </Grid>

      {/* Second row: revenue / margin mix */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label={`Revenue · ${headerWindow}`}
            value={windowStats ? USD_COMPACT.format(windowStats.total_income) : null}
            hint={windowStats ? `Sub ${USD_COMPACT.format(windowStats.subscription_revenue)} · Svc ${USD_COMPACT.format(windowStats.services_revenue)} · Connect ${USD_COMPACT.format(windowStats.connect_revenue)}` : 'loading'}
            color="text.primary"
            loading={isLoading}
            info={<><strong>What it is:</strong> Total GAAP-billed revenue over the selected window — all streams.<br /><br /><strong>Data:</strong> "Total Income" line from QuickBooks P&L, summed across the window.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label={`Gross margin (blended) · ${headerWindow}`}
            value={pct(windowStats?.gross_margin ?? null)}
            hint={windowStats ? `${USD_COMPACT.format(windowStats.gross_profit)} / ${USD_COMPACT.format(windowStats.total_income)}` : 'loading'}
            color={gmColor(windowStats?.gross_margin ?? null)}
            loading={isLoading}
            info={<><strong>What it is:</strong> Gross profit as a % of revenue, blended across all streams.<br /><br /><strong>Data:</strong> (Total Income − Total COGS) ÷ Total Income over window. COGS includes Credit Card fees, Sales Commission, Services Commissions, Affiliate Commissions.<br /><br /><strong>Target:</strong> ≥ 70% baseline · ≥ 75% top-quartile.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label={`Net Operating Income · ${headerWindow}`}
            value={windowStats ? USD_COMPACT.format(windowStats.net_op_income) : null}
            hint={windowStats && windowStats.net_op_income < 0 ? 'At breakeven · reinvesting' : 'Positive operating income'}
            color={windowStats && windowStats.net_op_income >= 0 ? 'success.main' : 'warning.main'}
            loading={isLoading}
            info={<><strong>What it is:</strong> Revenue minus all operating expenses over the window — proxy for EBITDA.<br /><br /><strong>Data:</strong> "Net Operating Income" from QuickBooks P&L summed. Negative = reinvesting; positive = cash-generating.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <StatCard
            label="Avg MRR per customer"
            value={windowStats ? USD0.format(windowStats.avg_mrr_per_customer ?? 0) : null}
            hint={windowStats ? `${windowStats.logo_qty_latest} active logos · last complete month` : 'loading'}
            color="text.primary"
            loading={isLoading}
            info={<><strong>What it is:</strong> Average subscription MRR per currently-active customer — feeds LTV and CAC payback. Uses the latest complete month regardless of window since it's a point-in-time snapshot.<br /><br /><strong>Data:</strong> Total subscription MRR ÷ Logo Qty for the latest complete month, from MRR by Month.</>}
          />
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

      {/* Trend charts */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                CAC trend · trailing 24 months
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> How CAC has moved month by month. Spikes indicate a slow month or a heavy S&M push; downward trends show improving acquisition efficiency.<br /><br /><strong>Data:</strong> For each month M, monthly S&M expense ÷ new logos that month. S&M from QuickBooks; new logos from allmoxy_core_customer signups.</>} />
            </Stack>
            {isLoading ? (
              <Skeleton variant="rectangular" height={220} />
            ) : (
              <Box sx={{ height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                    <YAxis stroke="#8B949E" fontSize={11} width={55} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                    <RTooltip
                      labelFormatter={(v) => monthLabel(String(v))}
                      formatter={(v: number) => [USD0.format(v), 'CAC']}
                      contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                    />
                    <Line type="monotone" dataKey="cac" stroke="#2C73FF" strokeWidth={2} dot={{ r: 2.5, fill: '#2C73FF' }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </Box>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                New logos vs S&M spend · trailing 24 months
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> Side-by-side view of S&M dollars (bars, left axis) and new logos acquired (line, right axis). Lets you see whether additional sales spend translates into proportional logo growth.<br /><br /><strong>Data:</strong> Bars — monthly S&M from QuickBooks. Line — count of customers whose first payment date falls in that month from the master customer roster.</>} />
            </Stack>
            {isLoading ? (
              <Skeleton variant="rectangular" height={220} />
            ) : (
              <Box sx={{ height: 220 }}>
                <ResponsiveContainer>
                  <ComposedChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                    <YAxis yAxisId="left" stroke="#8B949E" fontSize={11} width={55} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                    <YAxis yAxisId="right" orientation="right" stroke="#8B949E" fontSize={11} width={30} />
                    <RTooltip
                      labelFormatter={(v) => monthLabel(String(v))}
                      contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                    />
                    <Bar yAxisId="left" dataKey="snm_expense" fill="rgba(44, 115, 255, 0.4)" name="S&M $" />
                    <Line yAxisId="right" type="monotone" dataKey="new_logos" stroke="#1A9E5C" strokeWidth={2} dot={{ r: 2.5, fill: '#1A9E5C' }} name="New logos" />
                  </ComposedChart>
                </ResponsiveContainer>
              </Box>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                Gross margin trend · dashed line = 75%
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> Monthly gross margin. Should stay high and stable for a mature SaaS.<br /><br /><strong>Data:</strong> (Total Income − Total COGS) ÷ Total Income per month, from QuickBooks P&L. Top-quartile SaaS operates above the 75% dashed line.</>} />
            </Stack>
            {isLoading ? (
              <Skeleton variant="rectangular" height={220} />
            ) : (
              <Box sx={{ height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                    <YAxis stroke="#8B949E" fontSize={11} width={45} tickFormatter={(v) => `${Math.round(v * 100)}%`} domain={[0.5, 1]} />
                    <ReferenceLine y={0.75} stroke="#8B949E" strokeDasharray="4 4" />
                    <RTooltip
                      labelFormatter={(v) => monthLabel(String(v))}
                      formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, 'GM']}
                      contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                    />
                    <Line type="monotone" dataKey="gross_margin" stroke="#1A9E5C" strokeWidth={2} dot={{ r: 2.5, fill: '#1A9E5C' }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </Box>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                Avg MRR per customer · trailing 24 months
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> Evolution of average MRR per customer — is pricing power improving, and are new logos landing at higher ACVs?<br /><br /><strong>Data:</strong> For each month, total subscription MRR ÷ Logo Qty, both from the MRR by Month tab.</>} />
            </Stack>
            {isLoading ? (
              <Skeleton variant="rectangular" height={220} />
            ) : (
              <Box sx={{ height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                    <YAxis stroke="#8B949E" fontSize={11} width={55} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                    <RTooltip
                      labelFormatter={(v) => monthLabel(String(v))}
                      formatter={(v: number) => [USD0.format(v), 'Avg MRR']}
                      contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                    />
                    <Line type="monotone" dataKey="avg_mrr_per_customer" stroke="#2C73FF" strokeWidth={2} dot={{ r: 2.5, fill: '#2C73FF' }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </Box>
            )}
          </Paper>
        </Grid>
      </Grid>

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
                    <TableCell align="right">{USD_COMPACT.format(r.snm_expense)}</TableCell>
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
