import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, BarChart, Bar, Legend } from 'recharts';

import { useSheetTab } from '../hooks/useSheetTab';
import { segmentColor, segmentLabel, CANONICAL_SEGMENTS } from '../lib/segmentsRegistry';
import narrative from '../data/cim_narrative.json';

// ============================================================================
// Types — minimal projections of the snapshot shapes the CIM Packet reads.
// ============================================================================

type MonthlyCell = { subscription: number; services: number; connect: number; total: number; annualized?: boolean };
type ProfileRow = {
  allmoxy_customer_id: number;
  name: string;
  primary_segment: string | null;
  sub_segment: string | null;
  pay_status: string | null;
  status: string;
  current_subscription_mrr: number;
  current_services: number;
  current_connect: number;
  lifetime_total: number;
  lifetime_subscription: number;
  first_payment_date: string | null;
  last_payment_date: string | null;
  years_with_us: number | null;
  monthly_history: Record<string, MonthlyCell>;
  latest_month: string;
  churn_reason: string | null;
};

type MrrMonthlyRow = {
  month: string;
  logo_qty: number;
  mrr_subscription: number;
  mrr_services: number | null;
  mrr_connect: number | null;
  mrr_blended: number | null;
  avg_mrr_blended: number | null;
};

type WaterfallTtm = {
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
type WaterfallMonthly = {
  month: string;
  starting_mrr: number;
  new_mrr: number;
  reactivated_mrr?: number;
  expansion_mrr: number;
  contraction_mrr: number;
  churn_mrr: number;
  ending_mrr: number;
  net_new_mrr: number;
  nrr_monthly: number | null;
  grr_monthly: number | null;
  quick_ratio: number | null;
};

type UnitEconTtm = {
  windowStart: string;
  windowEnd: string;
  subscription_revenue: number;
  services_revenue: number;
  affiliate_revenue: number;
  total_income: number;
  cogs: number;
  gross_profit: number;
  gross_margin: number;
  subscription_gross_margin: number;
  snm_expense: number;
  new_logos: number;
  cac: number | null;
  net_op_income: number;
  monthly_churn_rate: number | null;
  annual_churn_rate: number | null;
  avg_mrr_per_customer: number | null;
  logo_qty_latest: number;
  ltv: number | null;
  cac_payback_months: number | null;
};

type CohortSummary = { year: number; initial: number; active: number; churned: number; retentionPct: number | null };

type PnlSnapshot = {
  months: string[];
  lineItems: Array<{ key: string; label: string; section: string; isTotal: boolean; parentKey?: string }>;
  data: Record<string, Record<string, number>>;
};

// ============================================================================
// Formatters
// ============================================================================

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function pct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}
function monthLabelLong(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function monthLabelShort(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

// ============================================================================
// Section helper — every CIM block uses this. Adds anti-page-break, print-safe
// padding, and a numbered section header so the document reads as a packet.
// ============================================================================

type SectionProps = {
  number: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
};

function Section({ number, title, subtitle, children }: SectionProps) {
  return (
    <Paper
      className="cim-section"
      sx={{
        p: { xs: 2.5, md: 3.5 },
        mb: 3,
        breakInside: 'avoid',
        pageBreakInside: 'avoid',
      }}
    >
      <Stack direction="row" alignItems="baseline" spacing={1.5} sx={{ mb: 0.75 }}>
        <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 700, letterSpacing: '0.1em', fontSize: 11 }}>
          §{number}
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 600 }}>{title}</Typography>
      </Stack>
      {subtitle && (
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2, fontStyle: 'italic' }}>{subtitle}</Typography>
      )}
      <Divider sx={{ mb: 2 }} />
      {children}
    </Paper>
  );
}

function NarrativeBlock({ text }: { text: string }) {
  const paragraphs = text.split(/\n\n+/);
  return (
    <Stack spacing={1.5}>
      {paragraphs.map((p, i) => (
        <Typography key={i} variant="body2" sx={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
          {renderInlineMarkdown(p)}
        </Typography>
      ))}
    </Stack>
  );
}

// Minimal inline bold-only Markdown renderer. Splits on **…** and bolds the
// captured segments. No links, no italics — keeps the dep surface zero.
function renderInlineMarkdown(s: string): React.ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <Box key={i} component="strong" sx={{ fontWeight: 700 }}>{part.slice(2, -2)}</Box>;
    }
    return <span key={i}>{part}</span>;
  });
}

function KPITile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.75, height: '100%' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10, fontWeight: 600 }}>
        {label}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 600, mt: 0.5, color: accent ?? 'text.primary', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25, fontSize: 11 }}>
          {sub}
        </Typography>
      )}
    </Paper>
  );
}

// ============================================================================
// CIM Packet — the page.
// ============================================================================

export default function CIMPacket() {
  const { data: mrrData, isLoading: mrrLoading, error: mrrError } = useSheetTab('mrr_by_month');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: ueData } = useSheetTab('unit_economics');
  const { data: cohortData } = useSheetTab('cohort_retention');
  const { data: profilesData } = useSheetTab('customer_profiles');
  const { data: pnlData } = useSheetTab('pnl_by_month');

  const mrr = mrrData as unknown as { rows: MrrMonthlyRow[] } | undefined;
  const wf = wfData as unknown as { monthly: WaterfallMonthly[]; ttm: WaterfallTtm } | undefined;
  const ue = ueData as unknown as { ttm: UnitEconTtm; monthly: Array<{ month: string; subscription_revenue: number; gross_margin: number; new_logos: number; cac: number | null; avg_mrr_per_customer: number | null }> } | undefined;
  const cohort = cohortData as unknown as { cohortSummary: CohortSummary[]; totalCustomers: number; activeToday: number } | undefined;
  const profiles = profilesData as unknown as { rows: ProfileRow[] } | undefined;
  const pnl = pnlData as unknown as PnlSnapshot | undefined;

  // ---- Derived: latest complete month ----
  // Source of truth: the ETL pipeline's TTM window end. Both the unit_economics
  // and mrr_waterfall snapshots stamp ttm.windowEnd at the latest *complete*
  // month — the in-progress current month is excluded by the builder. Using
  // mrr_by_month's last row would pick up a partial month (e.g. mid-June while
  // we're sitting in June) and badly understate every headline metric.
  const headlineMonth = useMemo(() => {
    if (ue?.ttm?.windowEnd) return ue.ttm.windowEnd;
    if (wf?.ttm?.windowEnd) return wf.ttm.windowEnd;
    // Fallback: walk back from the latest month and skip the calendar month
    // matching today's YYYY-MM (rough proxy for "incomplete").
    const rows = mrr?.rows ?? [];
    if (rows.length === 0) return '';
    const now = new Date();
    const currentYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].month === currentYM) continue;
      if ((rows[i].mrr_subscription ?? 0) > 0) return rows[i].month;
    }
    return rows[rows.length - 1].month;
  }, [mrr, ue, wf]);

  const headlineRow = useMemo(() => mrr?.rows.find((r) => r.month === headlineMonth), [mrr, headlineMonth]);

  // ---- Derived: ARR trajectory (24m) ----
  const arrSeries = useMemo(() => {
    const rows = (mrr?.rows ?? []).filter((r) => r.month <= headlineMonth);
    return rows.slice(-24).map((r) => ({
      month: r.month,
      label: monthLabelShort(r.month),
      arr: (r.mrr_subscription ?? 0) * 12,
      mrr_sub: r.mrr_subscription ?? 0,
      mrr_svc: r.mrr_services ?? 0,
      mrr_connect: r.mrr_connect ?? 0,
    }));
  }, [mrr, headlineMonth]);

  // ---- Derived: stream composition for headline month + TTM ----
  const streamComposition = useMemo(() => {
    if (!headlineRow) return null;
    const sub = headlineRow.mrr_subscription ?? 0;
    const svc = headlineRow.mrr_services ?? 0;
    const conn = headlineRow.mrr_connect ?? 0;
    const total = sub + svc + conn;
    return {
      subscription: sub,
      services: svc,
      connect: conn,
      total,
      subPct: total > 0 ? sub / total : 0,
      svcPct: total > 0 ? svc / total : 0,
      connPct: total > 0 ? conn / total : 0,
    };
  }, [headlineRow]);

  // ---- Derived: top customer concentration (post-amortization) ----
  const concentration = useMemo(() => {
    const rows = (profiles?.rows ?? []).filter((r) => (r.current_subscription_mrr ?? 0) > 0);
    const sorted = rows.slice().sort((a, b) => (b.current_subscription_mrr ?? 0) - (a.current_subscription_mrr ?? 0));
    const totalMrr = sorted.reduce((s, r) => s + (r.current_subscription_mrr ?? 0), 0);
    const slice = (n: number) => sorted.slice(0, n).reduce((s, r) => s + (r.current_subscription_mrr ?? 0), 0);
    const top10Rows = sorted.slice(0, 10);
    return {
      activeBilling: sorted.length,
      totalMrr,
      top1Pct: totalMrr > 0 ? slice(1) / totalMrr : 0,
      top5Pct: totalMrr > 0 ? slice(5) / totalMrr : 0,
      top10Pct: totalMrr > 0 ? slice(10) / totalMrr : 0,
      top20Pct: totalMrr > 0 ? slice(20) / totalMrr : 0,
      top10: top10Rows,
    };
  }, [profiles]);

  // ---- Derived: segment mix (primary + sub) ----
  const segmentMix = useMemo(() => {
    const rows = (profiles?.rows ?? []).filter((r) => (r.current_subscription_mrr ?? 0) > 0);
    const byPrimary = new Map<string, { count: number; mrr: number; subByName: Map<string, { count: number; mrr: number }> }>();
    for (const r of rows) {
      const seg = (r.primary_segment ?? '').trim() || '(unsegmented)';
      if (!byPrimary.has(seg)) byPrimary.set(seg, { count: 0, mrr: 0, subByName: new Map() });
      const bucket = byPrimary.get(seg)!;
      bucket.count += 1;
      bucket.mrr += r.current_subscription_mrr ?? 0;
      const sub = (r.sub_segment ?? '').trim() || '(unspecified)';
      if (!bucket.subByName.has(sub)) bucket.subByName.set(sub, { count: 0, mrr: 0 });
      const sb = bucket.subByName.get(sub)!;
      sb.count += 1;
      sb.mrr += r.current_subscription_mrr ?? 0;
    }
    const primaryRows = [...byPrimary.entries()]
      .map(([name, v]) => ({
        name,
        count: v.count,
        mrr: v.mrr,
        subSegments: [...v.subByName.entries()]
          .map(([sname, sv]) => ({ name: sname, count: sv.count, mrr: sv.mrr }))
          .sort((a, b) => b.mrr - a.mrr),
      }))
      .sort((a, b) => b.mrr - a.mrr);
    const totalMrr = primaryRows.reduce((s, r) => s + r.mrr, 0);
    return { primary: primaryRows, totalMrr };
  }, [profiles]);

  // ---- Derived: churn-by-reason (top clusters) ----
  const churnByReason = useMemo(() => {
    const rows = (profiles?.rows ?? []).filter((r) => r.status === 'churned');
    const buckets = new Map<string, { count: number; lifetime: number }>();
    let totalLifetime = 0;
    for (const r of rows) {
      const lifetime = r.lifetime_subscription ?? 0;
      totalLifetime += lifetime;
      const raw = (r.churn_reason ?? '').trim();
      if (!raw) {
        const k = '(no reason recorded)';
        if (!buckets.has(k)) buckets.set(k, { count: 0, lifetime: 0 });
        const b = buckets.get(k)!;
        b.count += 1;
        b.lifetime += lifetime;
        continue;
      }
      const reasons = raw.split(';').map((s) => s.trim()).filter(Boolean);
      const weight = lifetime / reasons.length;
      for (const reason of reasons) {
        if (!buckets.has(reason)) buckets.set(reason, { count: 0, lifetime: 0 });
        const b = buckets.get(reason)!;
        b.count += 1;
        b.lifetime += weight;
      }
    }
    return {
      total: rows.length,
      totalLifetime,
      reasons: [...buckets.entries()]
        .map(([reason, v]) => ({ reason, count: v.count, lifetime: v.lifetime }))
        .sort((a, b) => b.lifetime - a.lifetime),
    };
  }, [profiles]);

  // ---- Derived: NRR/GRR trend (last 24 months) ----
  const retentionTrend = useMemo(() => {
    const months = (wf?.monthly ?? []).slice(-24);
    return months.map((m) => ({
      month: m.month,
      label: monthLabelShort(m.month),
      nrr: m.nrr_monthly,
      grr: m.grr_monthly,
    }));
  }, [wf]);

  // ---- Derived: P&L summary (latest 6 months) ----
  const pnlSummary = useMemo(() => {
    if (!pnl) return null;
    const months = pnl.months ?? [];
    const last6 = months.slice(-6);
    const get = (key: string, m: string) => (pnl.data?.[key]?.[m] ?? 0);
    const sumOver = (key: string, ms: string[]) => ms.reduce((s, m) => s + get(key, m), 0);
    return {
      months: last6,
      totalIncome: last6.map((m) => get('total_income', m)),
      totalCogs: last6.map((m) => get('total_cogs', m)),
      grossProfit: last6.map((m) => get('gross_profit', m)),
      totalOpex: last6.map((m) => get('total_expenses', m)),
      netOp: last6.map((m) => get('net_op_income', m)),
      ttm: {
        income: sumOver('total_income', months.slice(-12)),
        gp: sumOver('gross_profit', months.slice(-12)),
        opex: sumOver('total_expenses', months.slice(-12)),
        netOp: sumOver('net_op_income', months.slice(-12)),
      },
    };
  }, [pnl]);

  const isLoading = mrrLoading;
  const isReady = mrr && wf && ue && cohort && profiles && headlineRow;

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <Box className="cim-packet" sx={{ pb: 6 }}>
      {/* Document header / title block */}
      <Paper
        className="cim-title-block"
        sx={{
          p: { xs: 3, md: 5 },
          mb: 3,
          borderLeft: '6px solid',
          borderColor: 'primary.main',
          breakAfter: 'avoid',
        }}
      >
        <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 11, letterSpacing: '0.2em' }}>
          {narrative.document.classification}
        </Typography>
        <Typography variant="h3" sx={{ fontWeight: 700, mt: 1, lineHeight: 1.15 }}>
          {narrative.company.name}
        </Typography>
        <Typography variant="h6" sx={{ fontWeight: 500, color: 'primary.main', mt: 0.75, fontStyle: 'italic' }}>
          {narrative.company.tagline}
        </Typography>
        <Typography variant="h5" sx={{ fontWeight: 400, color: 'text.secondary', mt: 1.5 }}>
          {narrative.document.title}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1, fontStyle: 'italic' }}>
          {narrative.document.subtitle}
        </Typography>

        <Divider sx={{ my: 3 }} />

        <Grid container spacing={2}>
          <Grid item xs={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>
              Category
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.5 }}>{narrative.company.category}</Typography>
          </Grid>
          <Grid item xs={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>
              Stage
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.5 }}>{narrative.company.stage}</Typography>
          </Grid>
          <Grid item xs={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>
              Headquarters
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.5 }}>{narrative.company.headquarters}</Typography>
          </Grid>
          <Grid item xs={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>
              Year founded
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.5 }}>{narrative.company.year_founded}</Typography>
          </Grid>
        </Grid>

        <Alert severity="info" sx={{ mt: 3, '@media print': { display: 'none' } }}>
          This is a live, working-draft CIM. Every data section re-populates from the latest snapshot refresh. Narrative
          sections are sourced from <code>src/data/cim_narrative.json</code> — edit there and reload to update. Print
          to PDF (Cmd+P → Save as PDF) when you need a shareable artifact.
        </Alert>
      </Paper>

      {mrrError && <Alert severity="error" sx={{ mb: 2 }}>Failed to load source data: {String(mrrError)}</Alert>}
      {isLoading && (
        <Stack spacing={2}>
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} variant="rectangular" height={180} />)}
        </Stack>
      )}

      {isReady && (
        <>
          {/* §1 EXECUTIVE SUMMARY */}
          <Section number="1" title="Executive Summary" subtitle={`Latest complete month: ${monthLabelLong(headlineMonth)}`}>
            <Typography variant="body2" sx={{ fontSize: 14, lineHeight: 1.7, mb: 2.5, whiteSpace: 'pre-wrap' }}>
              {renderInlineMarkdown(narrative.executive_summary_lede)}
            </Typography>
            <Grid container spacing={1.5}>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="ARR"
                  value={USD_COMPACT.format((headlineRow!.mrr_subscription ?? 0) * 12)}
                  sub={`${USD0.format(headlineRow!.mrr_subscription ?? 0)} subscription MRR`}
                  accent="primary.main"
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="Blended MRR"
                  value={USD_COMPACT.format(headlineRow!.mrr_blended ?? 0)}
                  sub="Subscription + Services + Connect"
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="Active customers"
                  value={(headlineRow!.logo_qty ?? 0).toLocaleString()}
                  sub={`${cohort!.activeToday ?? 0} active today / ${cohort!.totalCustomers ?? 0} lifetime`}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="NRR (TTM)"
                  value={pct(wf!.ttm.annual_nrr)}
                  sub={`GRR ${pct(wf!.ttm.annual_grr)}`}
                  accent={wf!.ttm.annual_nrr != null && wf!.ttm.annual_nrr >= 1 ? 'success.main' : 'warning.main'}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="LTV : CAC"
                  value={ue!.ttm.ltv != null && ue!.ttm.cac ? `${(ue!.ttm.ltv / ue!.ttm.cac).toFixed(1)}x` : '—'}
                  sub={`Payback ${ue!.ttm.cac_payback_months != null ? `${ue!.ttm.cac_payback_months.toFixed(1)} mo` : '—'}`}
                  accent={ue!.ttm.ltv != null && ue!.ttm.cac && (ue!.ttm.ltv / ue!.ttm.cac) >= 3 ? 'success.main' : 'warning.main'}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="Gross margin (TTM)"
                  value={pct(ue!.ttm.gross_margin)}
                  sub={`Sub GM ${pct(ue!.ttm.subscription_gross_margin)}`}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="Net new MRR (TTM)"
                  value={USD_COMPACT.format(wf!.ttm.net_new_mrr ?? 0)}
                  sub={`Quick ratio ${wf!.ttm.quick_ratio != null ? `${wf!.ttm.quick_ratio.toFixed(1)}x` : '—'}`}
                  accent={wf!.ttm.net_new_mrr >= 0 ? 'success.main' : 'error.main'}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="Annual churn (TTM)"
                  value={pct(ue!.ttm.annual_churn_rate)}
                  sub={`${USD_COMPACT.format(wf!.ttm.churn_mrr ?? 0)} MRR churned`}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="ARPU (TTM)"
                  value={ue!.ttm.avg_mrr_per_customer != null ? USD0.format(ue!.ttm.avg_mrr_per_customer) : '—'}
                  sub={`${ue!.ttm.new_logos} new logos (TTM)`}
                />
              </Grid>
              <Grid item xs={6} sm={4} md={2.4}>
                <KPITile
                  label="Top-10 concentration"
                  value={pct(concentration.top10Pct, 0)}
                  sub={`Top-5 ${pct(concentration.top5Pct, 0)} · Top-20 ${pct(concentration.top20Pct, 0)}`}
                  accent={concentration.top10Pct > 0.4 ? 'warning.main' : 'success.main'}
                />
              </Grid>
            </Grid>
          </Section>

          {/* §2 COMPANY OVERVIEW */}
          <Section number="2" title="Company Overview">
            <NarrativeBlock text={narrative.company_overview} />
          </Section>

          {/* §3 MARKET OPPORTUNITY */}
          <Section number="3" title="Market Opportunity">
            <NarrativeBlock text={narrative.market_opportunity} />

            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mt: 3, mb: 1 }}>
              The wedge — why nothing else fits
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontSize: 11 }}>Alternative</TableCell>
                  <TableCell sx={{ fontSize: 11 }}>Examples</TableCell>
                  <TableCell sx={{ fontSize: 11 }}>Why it breaks</TableCell>
                  <TableCell sx={{ fontSize: 11 }}>Where Allmoxy wins</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {narrative.competitive_wedge.map((row) => (
                  <TableRow key={row.alternative}>
                    <TableCell sx={{ fontWeight: 600, fontSize: 12 }}>{row.alternative}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{row.examples}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{row.why_it_breaks}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{row.where_allmoxy_wins}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mt: 3, mb: 1 }}>
              The buying committee inside a shop
            </Typography>
            <Stack spacing={0.75}>
              {narrative.buying_committee.map((p) => (
                <Box key={p.persona} sx={{ pl: 2, borderLeft: '3px solid', borderColor: 'primary.light' }}>
                  <Typography variant="body2" sx={{ fontSize: 13 }}>
                    <Box component="strong" sx={{ fontWeight: 700 }}>{p.persona}</Box>
                    <Box component="span" sx={{ color: 'text.secondary' }}> · {p.role} · </Box>
                    {p.what_they_want}
                  </Typography>
                </Box>
              ))}
            </Stack>

            <Box sx={{ mt: 3, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Allmoxy GTM Segments (live, post-amortization)
              </Typography>
              <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5 }}>
                Allmoxy actively sells to <strong>{CANONICAL_SEGMENTS.filter((s) => s.inMotion).length}</strong> of the canonical{' '}
                <strong>{CANONICAL_SEGMENTS.length}</strong> industry segments, with material customer presence today in{' '}
                <strong>{segmentMix.primary.filter((p) => p.name !== '(unsegmented)').length}</strong> of them. The current customer base
                concentrates in Cabinetry (Component Manufacturers + Custom Cabinet Shops), with diversified exposure across Closets,
                Architectural Woodwork, Dealer/Showroom, and Distribution.
              </Typography>
            </Box>
          </Section>

          {/* §4 PRODUCT */}
          <Section number="4" title="Product">
            <NarrativeBlock text={narrative.product_overview} />
          </Section>

          {/* §5 FINANCIAL HIGHLIGHTS */}
          <Section number="5" title="Financial Highlights" subtitle={`TTM window: ${ue!.ttm.windowStart} → ${ue!.ttm.windowEnd}`}>
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10, letterSpacing: '0.06em' }}>
                    Trailing-12-month revenue
                  </Typography>
                  <Table size="small" sx={{ mt: 1 }}>
                    <TableBody>
                      <TableRow><TableCell sx={{ borderBottom: 'none' }}>Subscription revenue</TableCell><TableCell align="right" sx={{ borderBottom: 'none', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{USD0.format(ue!.ttm.subscription_revenue)}</TableCell></TableRow>
                      <TableRow><TableCell sx={{ borderBottom: 'none' }}>Services revenue</TableCell><TableCell align="right" sx={{ borderBottom: 'none', fontVariantNumeric: 'tabular-nums' }}>{USD0.format(ue!.ttm.services_revenue)}</TableCell></TableRow>
                      <TableRow><TableCell sx={{ borderBottom: 'none' }}>Affiliate (Connect) revenue</TableCell><TableCell align="right" sx={{ borderBottom: 'none', fontVariantNumeric: 'tabular-nums' }}>{USD0.format(ue!.ttm.affiliate_revenue)}</TableCell></TableRow>
                      <TableRow><TableCell sx={{ fontWeight: 600 }}>Total income</TableCell><TableCell align="right" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{USD0.format(ue!.ttm.total_income)}</TableCell></TableRow>
                    </TableBody>
                  </Table>
                </Paper>
              </Grid>
              <Grid item xs={12} md={6}>
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10, letterSpacing: '0.06em' }}>
                    Trailing-12-month profitability
                  </Typography>
                  <Table size="small" sx={{ mt: 1 }}>
                    <TableBody>
                      <TableRow><TableCell sx={{ borderBottom: 'none' }}>Gross profit</TableCell><TableCell align="right" sx={{ borderBottom: 'none', fontVariantNumeric: 'tabular-nums' }}>{USD0.format(ue!.ttm.gross_profit)}</TableCell></TableRow>
                      <TableRow><TableCell sx={{ borderBottom: 'none' }}>Gross margin</TableCell><TableCell align="right" sx={{ borderBottom: 'none', fontVariantNumeric: 'tabular-nums' }}>{pct(ue!.ttm.gross_margin)}</TableCell></TableRow>
                      <TableRow><TableCell sx={{ borderBottom: 'none' }}>Subscription gross margin</TableCell><TableCell align="right" sx={{ borderBottom: 'none', fontVariantNumeric: 'tabular-nums' }}>{pct(ue!.ttm.subscription_gross_margin)}</TableCell></TableRow>
                      <TableRow><TableCell sx={{ borderBottom: 'none' }}>S&M expense (TTM)</TableCell><TableCell align="right" sx={{ borderBottom: 'none', fontVariantNumeric: 'tabular-nums' }}>{USD0.format(ue!.ttm.snm_expense)}</TableCell></TableRow>
                      <TableRow><TableCell sx={{ fontWeight: 600 }}>Net operating income</TableCell><TableCell align="right" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: ue!.ttm.net_op_income >= 0 ? 'success.main' : 'error.main' }}>{USD0.format(ue!.ttm.net_op_income)}</TableCell></TableRow>
                    </TableBody>
                  </Table>
                </Paper>
              </Grid>
            </Grid>
          </Section>

          {/* §6 REVENUE COMPOSITION */}
          <Section number="6" title="Revenue Composition" subtitle="Latest complete month, by stream">
            {streamComposition && (
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <Paper variant="outlined" sx={{ p: 2, borderLeft: '4px solid', borderColor: '#2C73FF' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10, letterSpacing: '0.06em' }}>Subscription (recurring)</Typography>
                    <Typography variant="h5" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', mt: 0.5 }}>{USD0.format(streamComposition.subscription)}</Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{pct(streamComposition.subPct)} of blended MRR</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12} md={4}>
                  <Paper variant="outlined" sx={{ p: 2, borderLeft: '4px solid', borderColor: '#1A9E5C' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10, letterSpacing: '0.06em' }}>Services (project-based)</Typography>
                    <Typography variant="h5" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', mt: 0.5 }}>{USD0.format(streamComposition.services)}</Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{pct(streamComposition.svcPct)} of blended MRR</Typography>
                  </Paper>
                </Grid>
                <Grid item xs={12} md={4}>
                  <Paper variant="outlined" sx={{ p: 2, borderLeft: '4px solid', borderColor: '#D97706' }}>
                    <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10, letterSpacing: '0.06em' }}>Connect (affiliate fees)</Typography>
                    <Typography variant="h5" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', mt: 0.5 }}>{USD0.format(streamComposition.connect)}</Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>{pct(streamComposition.connPct)} of blended MRR</Typography>
                  </Paper>
                </Grid>
              </Grid>
            )}
            <Box sx={{ height: 220, mt: 3 }}>
              <ResponsiveContainer>
                <BarChart data={arrSeries}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => USD_COMPACT.format(v as number)} tick={{ fontSize: 11 }} />
                  <RTooltip formatter={(v: number) => USD0.format(v)} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="mrr_sub" stackId="a" fill="#2C73FF" name="Subscription" />
                  <Bar dataKey="mrr_svc" stackId="a" fill="#1A9E5C" name="Services" />
                  <Bar dataKey="mrr_connect" stackId="a" fill="#D97706" name="Connect" />
                </BarChart>
              </ResponsiveContainer>
            </Box>
          </Section>

          {/* §7 ARR TRAJECTORY */}
          <Section number="7" title="ARR Trajectory" subtitle="Subscription MRR × 12 · last 24 months">
            <Box sx={{ height: 260 }}>
              <ResponsiveContainer>
                <AreaChart data={arrSeries}>
                  <defs>
                    <linearGradient id="arrGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2C73FF" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#2C73FF" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => USD_COMPACT.format(v as number)} tick={{ fontSize: 11 }} />
                  <RTooltip formatter={(v: number) => USD0.format(v)} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6 }} />
                  <Area type="monotone" dataKey="arr" stroke="#2C73FF" fill="url(#arrGradient)" name="ARR" />
                </AreaChart>
              </ResponsiveContainer>
            </Box>
          </Section>

          {/* §8 MRR WATERFALL (TTM) */}
          <Section number="8" title="MRR Waterfall — Trailing 12 Months" subtitle={`${wf!.ttm.windowStart} → ${wf!.ttm.windowEnd}`}>
            <Grid container spacing={1.5}>
              <Grid item xs={6} md={2}><KPITile label="Starting MRR" value={USD_COMPACT.format(wf!.ttm.starting_mrr)} /></Grid>
              <Grid item xs={6} md={2}><KPITile label="+ New" value={USD_COMPACT.format(wf!.ttm.new_mrr)} accent="success.main" /></Grid>
              <Grid item xs={6} md={2}><KPITile label="+ Reactivated" value={USD_COMPACT.format(wf!.ttm.reactivated_mrr ?? 0)} accent="success.main" /></Grid>
              <Grid item xs={6} md={2}><KPITile label="+ Expansion" value={USD_COMPACT.format(wf!.ttm.expansion_mrr)} accent="success.main" /></Grid>
              <Grid item xs={6} md={2}><KPITile label="− Contraction" value={USD_COMPACT.format(wf!.ttm.contraction_mrr)} accent="warning.main" /></Grid>
              <Grid item xs={6} md={2}><KPITile label="− Churn" value={USD_COMPACT.format(wf!.ttm.churn_mrr)} accent="error.main" /></Grid>
              <Grid item xs={6} md={3}><KPITile label="Net new MRR" value={USD_COMPACT.format(wf!.ttm.net_new_mrr)} accent={wf!.ttm.net_new_mrr >= 0 ? 'success.main' : 'error.main'} /></Grid>
              <Grid item xs={6} md={3}><KPITile label="Ending MRR" value={USD_COMPACT.format(wf!.ttm.ending_mrr)} sub="Latest complete month" /></Grid>
              <Grid item xs={6} md={3}><KPITile label="Quick ratio" value={wf!.ttm.quick_ratio != null ? `${wf!.ttm.quick_ratio.toFixed(2)}x` : '—'} sub="(New+Exp) / (Churn+Contr)" /></Grid>
              <Grid item xs={6} md={3}><KPITile label="Annual gross churn" value={pct(wf!.ttm.annual_gross_churn_rate)} sub="$ basis" /></Grid>
            </Grid>
          </Section>

          {/* §9 NET REVENUE RETENTION */}
          <Section number="9" title="Net Revenue Retention" subtitle="Trailing 12 months · monthly NRR / GRR series">
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={6} md={3}>
                <KPITile label="NRR (TTM)" value={pct(wf!.ttm.annual_nrr)} accent={wf!.ttm.annual_nrr != null && wf!.ttm.annual_nrr >= 1 ? 'success.main' : 'warning.main'} />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="GRR (TTM)" value={pct(wf!.ttm.annual_grr)} accent={wf!.ttm.annual_grr != null && wf!.ttm.annual_grr >= 0.9 ? 'success.main' : 'warning.main'} />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="Expansion $ (TTM)" value={USD_COMPACT.format(wf!.ttm.expansion_mrr)} />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="Contraction $ (TTM)" value={USD_COMPACT.format(wf!.ttm.contraction_mrr)} />
              </Grid>
            </Grid>
            <Box sx={{ height: 220 }}>
              <ResponsiveContainer>
                <AreaChart data={retentionTrend}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0.7, 1.2]} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} tick={{ fontSize: 11 }} />
                  <RTooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="nrr" stroke="#2C73FF" fill="#2C73FF22" name="NRR (monthly)" />
                  <Area type="monotone" dataKey="grr" stroke="#1A9E5C" fill="#1A9E5C22" name="GRR (monthly)" />
                </AreaChart>
              </ResponsiveContainer>
            </Box>
          </Section>

          {/* §10 COHORT RETENTION */}
          <Section number="10" title="Cohort Retention" subtitle={`${cohort!.totalCustomers} lifetime customers · ${cohort!.activeToday} active today`}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Cohort year</TableCell>
                  <TableCell align="right">Signups</TableCell>
                  <TableCell align="right">Active today</TableCell>
                  <TableCell align="right">Churned</TableCell>
                  <TableCell align="right">Retention %</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {cohort!.cohortSummary
                  .filter((c) => c.year >= 2015)
                  .slice()
                  .reverse()
                  .map((c) => (
                    <TableRow key={c.year}>
                      <TableCell sx={{ fontWeight: 500 }}>{c.year}</TableCell>
                      <TableCell align="right">{c.initial.toLocaleString()}</TableCell>
                      <TableCell align="right">{c.active.toLocaleString()}</TableCell>
                      <TableCell align="right">{c.churned.toLocaleString()}</TableCell>
                      <TableCell
                        align="right"
                        sx={{ color: c.retentionPct != null && c.retentionPct >= 60 ? 'success.main' : c.retentionPct != null && c.retentionPct >= 40 ? 'warning.main' : 'error.main', fontWeight: 500 }}
                      >
                        {c.retentionPct != null ? `${c.retentionPct.toFixed(1)}%` : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </Section>

          {/* §11 UNIT ECONOMICS */}
          <Section number="11" title="Unit Economics" subtitle="Trailing-12-month basis · S&M from QuickBooks lines 6050 / 6300 / 6310">
            <Grid container spacing={1.5}>
              <Grid item xs={6} md={3}>
                <KPITile
                  label="CAC"
                  value={ue!.ttm.cac != null ? USD0.format(ue!.ttm.cac) : '—'}
                  sub={`${ue!.ttm.new_logos} new logos · ${USD0.format(ue!.ttm.snm_expense)} S&M`}
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile
                  label="LTV"
                  value={ue!.ttm.ltv != null ? USD0.format(ue!.ttm.ltv) : '—'}
                  sub={`Annual churn ${pct(ue!.ttm.annual_churn_rate)}`}
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile
                  label="LTV : CAC"
                  value={ue!.ttm.ltv != null && ue!.ttm.cac ? `${(ue!.ttm.ltv / ue!.ttm.cac).toFixed(2)}x` : '—'}
                  sub=">3x healthy · >5x best-in-class"
                  accent={ue!.ttm.ltv != null && ue!.ttm.cac && ue!.ttm.ltv / ue!.ttm.cac >= 3 ? 'success.main' : 'warning.main'}
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile
                  label="CAC payback (months)"
                  value={ue!.ttm.cac_payback_months != null ? ue!.ttm.cac_payback_months.toFixed(1) : '—'}
                  sub="<12 mo healthy · <24 mo acceptable"
                  accent={ue!.ttm.cac_payback_months != null && ue!.ttm.cac_payback_months <= 12 ? 'success.main' : 'warning.main'}
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile
                  label="ARPU"
                  value={ue!.ttm.avg_mrr_per_customer != null ? USD0.format(ue!.ttm.avg_mrr_per_customer) : '—'}
                  sub="Avg subscription MRR / billing customer"
                />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="Gross margin" value={pct(ue!.ttm.gross_margin)} sub={`Sub GM ${pct(ue!.ttm.subscription_gross_margin)}`} />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="Net op income (TTM)" value={USD_COMPACT.format(ue!.ttm.net_op_income)} accent={ue!.ttm.net_op_income >= 0 ? 'success.main' : 'error.main'} />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="Logos (current)" value={(ue!.ttm.logo_qty_latest ?? 0).toLocaleString()} sub={`${ue!.ttm.new_logos} added TTM`} />
              </Grid>
            </Grid>
          </Section>

          {/* §12 CUSTOMER METRICS — ARPU + concentration headline */}
          <Section number="12" title="Customer Metrics" subtitle={`Post-amortization · Reference month: ${monthLabelLong(headlineMonth)}`}>
            <Grid container spacing={1.5}>
              <Grid item xs={6} md={3}>
                <KPITile label="Active billing customers" value={concentration.activeBilling.toLocaleString()} sub="Subscription MRR > 0 in reference month" />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="Total subscription MRR" value={USD_COMPACT.format(concentration.totalMrr)} sub="Sum of active customers" />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="ARPU" value={USD0.format(concentration.activeBilling > 0 ? concentration.totalMrr / concentration.activeBilling : 0)} sub="Average MRR / billing customer" />
              </Grid>
              <Grid item xs={6} md={3}>
                <KPITile label="Lifetime customers" value={cohort!.totalCustomers.toLocaleString()} sub={`${(cohort!.activeToday / cohort!.totalCustomers * 100).toFixed(0)}% active today`} />
              </Grid>
            </Grid>
          </Section>

          {/* §13 CUSTOMER CONCENTRATION */}
          <Section
            number="13"
            title="Customer Concentration"
            subtitle={`Top customers by current subscription MRR · ${monthLabelLong(headlineMonth)} · post-amortization basis (annual lump-sums spread across coverage months)`}
          >
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={6} md={3}><KPITile label="Top 1" value={pct(concentration.top1Pct, 1)} /></Grid>
              <Grid item xs={6} md={3}><KPITile label="Top 5" value={pct(concentration.top5Pct, 1)} /></Grid>
              <Grid item xs={6} md={3}><KPITile label="Top 10" value={pct(concentration.top10Pct, 1)} accent={concentration.top10Pct > 0.4 ? 'warning.main' : 'success.main'} /></Grid>
              <Grid item xs={6} md={3}><KPITile label="Top 20" value={pct(concentration.top20Pct, 1)} /></Grid>
            </Grid>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  <TableCell>Customer</TableCell>
                  <TableCell>Segment</TableCell>
                  <TableCell>Sub-segment</TableCell>
                  <TableCell align="right">Current MRR</TableCell>
                  <TableCell align="right">% of total</TableCell>
                  <TableCell align="right">Lifetime $</TableCell>
                  <TableCell align="right">Tenure</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {concentration.top10.map((c, i) => (
                  <TableRow key={c.allmoxy_customer_id}>
                    <TableCell sx={{ color: 'text.secondary' }}>{i + 1}</TableCell>
                    <TableCell sx={{ fontWeight: 500 }}>{c.name}</TableCell>
                    <TableCell>
                      {c.primary_segment ? (
                        <Chip
                          label={segmentLabel(c.primary_segment)}
                          size="small"
                          variant="outlined"
                          sx={{ height: 20, fontSize: 11, color: segmentColor(c.primary_segment), borderColor: segmentColor(c.primary_segment) }}
                        />
                      ) : '—'}
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{c.sub_segment ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{USD0.format(c.current_subscription_mrr ?? 0)}</TableCell>
                    <TableCell align="right">{pct((c.current_subscription_mrr ?? 0) / concentration.totalMrr, 1)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(c.lifetime_total ?? 0)}</TableCell>
                    <TableCell align="right">{c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y` : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>

          {/* §14 SEGMENT MIX */}
          <Section number="14" title="Segment Mix" subtitle="Live, by current subscription MRR — canonical Allmoxy segments + sub-segments">
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Primary segment</TableCell>
                  <TableCell align="right">Customers</TableCell>
                  <TableCell align="right">Current MRR</TableCell>
                  <TableCell align="right">% of MRR</TableCell>
                  <TableCell>Top sub-segments</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {segmentMix.primary
                  .filter((p) => p.name !== '(unsegmented)' && p.mrr > 0)
                  .slice(0, 12)
                  .map((p) => {
                    const namedSubs = p.subSegments.filter((s) => s.name !== '(unspecified)').slice(0, 3);
                    return (
                      <TableRow key={p.name}>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Box sx={{ width: 10, height: 10, bgcolor: segmentColor(p.name), borderRadius: '2px' }} />
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>{segmentLabel(p.name)}</Typography>
                          </Stack>
                        </TableCell>
                        <TableCell align="right">{p.count}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{USD0.format(p.mrr)}</TableCell>
                        <TableCell align="right">{pct(p.mrr / segmentMix.totalMrr, 1)}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {namedSubs.length === 0 ? (
                              <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                                (no sub-segment data)
                              </Typography>
                            ) : (
                              namedSubs.map((s) => (
                                <Chip key={s.name} label={`${s.name} (${s.count})`} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                              ))
                            )}
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </Section>

          {/* §15 CUSTOMER PROOF & VALIDATION */}
          <Section
            number="15"
            title="Customer Proof & Validation"
            subtitle="Verbatim from the Allmoxy Proof Library · single-customer results, not base-wide averages"
          >
            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mb: 1 }}>
              Quantified proof points
            </Typography>
            <Table size="small" sx={{ mb: 3 }}>
              <TableHead>
                <TableRow>
                  <TableCell>Metric</TableCell>
                  <TableCell>Before</TableCell>
                  <TableCell>After</TableCell>
                  <TableCell>Source</TableCell>
                  <TableCell>Pillar</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {narrative.customer_proof.quantified.map((p, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontWeight: 500, fontSize: 12 }}>{p.metric}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{p.before ?? '—'}</TableCell>
                    <TableCell sx={{ fontWeight: 600, color: 'success.main', fontSize: 12 }}>{p.after}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{p.source}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 11 }}>{p.pillar}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mb: 1 }}>
              Customer voice (verbatim quotes)
            </Typography>
            <Stack spacing={1.5} sx={{ mb: 3 }}>
              {narrative.customer_proof.quotes.map((q, i) => (
                <Box key={i} sx={{ pl: 2.5, borderLeft: '3px solid', borderColor: 'primary.main' }}>
                  <Typography variant="body2" sx={{ fontStyle: 'italic', fontSize: 13.5, lineHeight: 1.6 }}>
                    "{q.text}"
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                    — <strong>{q.attribution}</strong> · {q.theme}
                  </Typography>
                </Box>
              ))}
            </Stack>

            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mb: 1 }}>
              Named references / advocates
            </Typography>
            <Table size="small" sx={{ mb: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontSize: 11 }}>Customer</TableCell>
                  <TableCell sx={{ fontSize: 11 }}>Contact</TableCell>
                  <TableCell sx={{ fontSize: 11 }}>Notes</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {narrative.customer_proof.advocates.map((a, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontWeight: 500, fontSize: 12 }}>{a.customer}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{a.person}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{a.notes}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 2, fontStyle: 'italic' }}>
              {narrative.customer_proof.usage_note}
            </Typography>
          </Section>

          {/* §16 CHURN ANALYSIS */}
          <Section number="16" title="Churn Analysis" subtitle={`Lifetime churned customer base: ${churnByReason.total} customers · ${USD_COMPACT.format(churnByReason.totalLifetime)} lifetime $`}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Reason (top clusters)</TableCell>
                  <TableCell align="right">Customers</TableCell>
                  <TableCell align="right">Weighted lifetime $</TableCell>
                  <TableCell align="right">% of churn $</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {churnByReason.reasons.slice(0, 10).map((r) => (
                  <TableRow key={r.reason}>
                    <TableCell sx={{ fontWeight: r.reason === '(no reason recorded)' ? 400 : 500, color: r.reason === '(no reason recorded)' ? 'warning.main' : 'text.primary' }}>{r.reason}</TableCell>
                    <TableCell align="right">{r.count}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.lifetime)}</TableCell>
                    <TableCell align="right">{pct(r.lifetime / churnByReason.totalLifetime, 1)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5, fontStyle: 'italic' }}>
              "(no reason recorded)" represents customers whose HubSpot Churn Reason field was empty at churn time. The Churn
              Investigator surface backfills these via AI inference from CSM notes; investors should expect process discipline
              questions on the unattributed share.
            </Typography>
          </Section>

          {/* §17 P&L SUMMARY */}
          {pnlSummary && (
            <Section number="17" title="Profit & Loss Summary" subtitle={`Last 6 months · TTM totals shown for context`}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell></TableCell>
                    {pnlSummary.months.map((m) => (
                      <TableCell key={m} align="right">{monthLabelShort(m)}</TableCell>
                    ))}
                    <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 600 }}>TTM</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 500 }}>Total income</TableCell>
                    {pnlSummary.totalIncome.map((v, i) => (
                      <TableCell key={i} align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(v)}</TableCell>
                    ))}
                    <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(pnlSummary.ttm.income)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Gross profit</TableCell>
                    {pnlSummary.grossProfit.map((v, i) => (
                      <TableCell key={i} align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(v)}</TableCell>
                    ))}
                    <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(pnlSummary.ttm.gp)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Total operating expense</TableCell>
                    {pnlSummary.totalOpex.map((v, i) => (
                      <TableCell key={i} align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(v)}</TableCell>
                    ))}
                    <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(pnlSummary.ttm.opex)}</TableCell>
                  </TableRow>
                  <TableRow sx={{ borderTop: '2px solid', borderColor: 'divider' }}>
                    <TableCell sx={{ fontWeight: 600 }}>Net operating income</TableCell>
                    {pnlSummary.netOp.map((v, i) => (
                      <TableCell key={i} align="right" sx={{ fontWeight: 600, color: v >= 0 ? 'success.main' : 'error.main', fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(v)}</TableCell>
                    ))}
                    <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 700, color: pnlSummary.ttm.netOp >= 0 ? 'success.main' : 'error.main', fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(pnlSummary.ttm.netOp)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5, fontStyle: 'italic' }}>
                Source: QuickBooks export via the dashboard's <code>pnl_by_month</code> snapshot. For the full line-item P&L,
                see the Profit & Loss page in the dashboard.
              </Typography>
            </Section>
          )}

          {/* §18 GROWTH DRIVERS */}
          <Section number="18" title="Growth Drivers">
            <Stack spacing={1.5}>
              {narrative.growth_drivers.map((g, i) => (
                <Box key={i} sx={{ pl: 2, borderLeft: '3px solid', borderColor: 'success.main' }}>
                  <Typography variant="body2" sx={{ fontSize: 14, lineHeight: 1.7 }}>{renderInlineMarkdown(g)}</Typography>
                </Box>
              ))}
            </Stack>
          </Section>

          {/* §19 KEY RISKS */}
          <Section number="19" title="Key Risks">
            <Stack spacing={1.5}>
              {narrative.key_risks.map((r, i) => (
                <Box key={i} sx={{ pl: 2, borderLeft: '3px solid', borderColor: 'warning.main' }}>
                  <Typography variant="body2" sx={{ fontSize: 14, lineHeight: 1.7 }}>{renderInlineMarkdown(r)}</Typography>
                </Box>
              ))}
            </Stack>
          </Section>

          {/* §20 OPERATIONS */}
          <Section number="20" title="Operations">
            <NarrativeBlock text={narrative.operations_overview} />
          </Section>

          {/* §21 APPENDIX — DEFINITIONS + DATA SOURCES + METHODOLOGY */}
          <Section number="21" title="Appendix">
            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mb: 1 }}>
              Definitions
            </Typography>
            <Stack spacing={0.5} sx={{ mb: 3 }}>
              {Object.entries(narrative.definitions).map(([term, def]) => (
                <Typography key={term} variant="body2" sx={{ fontSize: 13, lineHeight: 1.6 }}>
                  <Box component="strong" sx={{ fontWeight: 600 }}>{term}.</Box> {def}
                </Typography>
              ))}
            </Stack>

            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mb: 1 }}>
              Data sources
            </Typography>
            <Stack spacing={0.5} sx={{ mb: 3 }}>
              {narrative.data_sources.map((s, i) => (
                <Typography key={i} variant="body2" sx={{ fontSize: 13, lineHeight: 1.6 }}>
                  • {renderInlineMarkdown(s)}
                </Typography>
              ))}
            </Stack>

            <Typography variant="overline" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, letterSpacing: '0.06em', mb: 1 }}>
              Methodology notes
            </Typography>
            <Stack spacing={0.5}>
              {narrative.methodology_notes.map((s, i) => (
                <Typography key={i} variant="body2" sx={{ fontSize: 13, lineHeight: 1.6 }}>
                  • {renderInlineMarkdown(s)}
                </Typography>
              ))}
            </Stack>
          </Section>

          {/* Footer */}
          <Box sx={{ mt: 4, textAlign: 'center', '@media print': { pageBreakBefore: 'avoid' } }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              End of Document · {narrative.document.classification}
            </Typography>
          </Box>
        </>
      )}

      {/* Print stylesheet — applies when user does Cmd+P → Save as PDF. */}
      <style>{`
        @media print {
          @page { margin: 0.5in; }
          body { background: #fff !important; color: #000 !important; }
          .cim-packet { background: #fff !important; }
          .cim-section, .cim-title-block {
            background: #fff !important;
            box-shadow: none !important;
            border: 1px solid #ddd !important;
            page-break-inside: avoid;
            break-inside: avoid;
          }
        }
      `}</style>
    </Box>
  );
}
