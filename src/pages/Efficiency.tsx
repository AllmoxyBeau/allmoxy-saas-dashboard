import { useMemo, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import { useSheetTab } from '../hooks/useSheetTab';

type UnitEconMonthly = {
  month: string;
  subscription_revenue: number;
  total_income: number;
  snm_expense: number;
  gross_margin: number | null;
  net_op_income: number;
  cac: number | null;
};
type UnitEconSnap = { monthly: UnitEconMonthly[] };

type WaterfallMonthly = {
  month: string;
  net_new_mrr: number;
  quick_ratio: number | null;
  nrr_monthly: number | null;
  grr_monthly: number | null;
  gross_churn_rate_monthly: number | null;
};
type WaterfallSnap = { monthly: WaterfallMonthly[] };

type MrrSnap = { rows: Array<{ month: string; mrr_subscription: number | null }> };

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function pct(v: number | null | undefined, digits = 1) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}
function ratio(v: number | null | undefined) { return v == null ? '—' : `${v.toFixed(2)}x`; }
function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
function addMonths(iso: string, delta: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Color thresholds
function rule40Color(v: number | null) { if (v == null) return 'text.primary'; if (v >= 40) return 'success.main'; if (v >= 20) return 'warning.main'; return 'error.main'; }
function magicColor(v: number | null) { if (v == null) return 'text.primary'; if (v >= 1) return 'success.main'; if (v >= 0.75) return 'warning.main'; return 'error.main'; }
function quickColor(v: number | null) { if (v == null) return 'text.primary'; if (v >= 4) return 'success.main'; if (v >= 2) return 'warning.main'; return 'error.main'; }
function nrrColor(v: number | null) { if (v == null) return 'text.primary'; if (v >= 1.1) return 'success.main'; if (v >= 1) return 'warning.main'; return 'error.main'; }

type Window = '24M' | '36M' | '60M' | 'ALL';

export default function Efficiency() {
  const { data: ueData, isLoading } = useSheetTab('unit_economics');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: mrrData } = useSheetTab('mrr_by_month');
  const ue = ueData as unknown as UnitEconSnap | undefined;
  const wf = wfData as unknown as WaterfallSnap | undefined;
  const mrr = mrrData as unknown as MrrSnap | undefined;

  const [win, setWin] = useState<Window>('24M');

  // Build per-month efficiency metrics derived from UE + WF + MRR.
  // Excludes the current (partial) month — waterfall snapshot already excludes it,
  // and we don't want half-month data skewing TTM / trend calculations.
  const series = useMemo(() => {
    if (!ue || !wf || !mrr) return [];
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const completeUeMonthly = ue.monthly.filter((m) => m.month < currentMonth);
    const ueByMonth = new Map(completeUeMonthly.map((m) => [m.month, m]));
    const wfByMonth = new Map(wf.monthly.map((m) => [m.month, m]));
    const mrrByMonth = new Map(mrr.rows.map((r) => [r.month, r]));
    const months = completeUeMonthly.map((m) => m.month); // canonical ordering

    // TTM helpers
    function sumWindow<K extends keyof UnitEconMonthly>(endMonth: string, k: K, windowMonths: number): number | null {
      const endIdx = months.indexOf(endMonth);
      if (endIdx < windowMonths - 1) return null;
      let total = 0;
      for (let i = endIdx - windowMonths + 1; i <= endIdx; i++) {
        const v = ueByMonth.get(months[i])?.[k];
        total += typeof v === 'number' ? v : 0;
      }
      return total;
    }
    function sumWfWindow<K extends keyof WaterfallMonthly>(endMonth: string, k: K, windowMonths: number): number | null {
      const endIdx = months.indexOf(endMonth);
      if (endIdx < windowMonths - 1) return null;
      let total = 0;
      for (let i = endIdx - windowMonths + 1; i <= endIdx; i++) {
        const m = months[i];
        const v = wfByMonth.get(m)?.[k];
        total += typeof v === 'number' ? v : 0;
      }
      return total;
    }

    return months.map((month) => {
      const u = ueByMonth.get(month);
      const w = wfByMonth.get(month);

      // ARR growth YoY = MRR[M] / MRR[M-12] − 1 (point-in-time, SaaS standard)
      // Matches the methodology used on M&A Readiness.
      const curMrr = mrrByMonth.get(month)?.mrr_subscription ?? null;
      const priorMrr = mrrByMonth.get(addMonths(month, -12))?.mrr_subscription ?? null;
      const arrGrowth = curMrr != null && priorMrr != null && priorMrr > 0
        ? (curMrr - priorMrr) / priorMrr
        : null;

      // TTM op margin
      const ttmNetOp = sumWindow(month, 'net_op_income', 12);
      const ttmTotal = sumWindow(month, 'total_income', 12);
      const opMargin = ttmNetOp != null && ttmTotal != null && ttmTotal > 0 ? ttmNetOp / ttmTotal : null;

      const rule40 = arrGrowth != null && opMargin != null ? (arrGrowth + opMargin) * 100 : null;

      // Magic Number (trailing 3-month)
      const q_net_new = sumWfWindow(month, 'net_new_mrr', 3);
      const q_snm = sumWindow(month, 'snm_expense', 3);
      const magic = q_net_new != null && q_snm != null && q_snm > 0
        ? (q_net_new * 4) / q_snm
        : null;

      // Burn multiple TTM = |TTM op loss| / TTM net new MRR (× 12? Net new MRR summed 12 months already equals ARR added). If positive op income, treat as 0 burn.
      const burn = ttmNetOp != null && ttmNetOp < 0 ? -ttmNetOp : 0;
      const ttmNetNewMrr = sumWfWindow(month, 'net_new_mrr', 12);
      const burnMultiple = burn > 0 && ttmNetNewMrr != null && ttmNetNewMrr > 0
        ? burn / ttmNetNewMrr
        : null;

      // Monthly NRR & GRR annualized
      const annualNRR = w?.nrr_monthly != null ? Math.pow(w.nrr_monthly, 12) : null;
      const annualGRR = w?.grr_monthly != null ? Math.pow(w.grr_monthly, 12) : null;

      return {
        month,
        arrGrowth: arrGrowth != null ? Math.round(arrGrowth * 1000) / 10 : null, // percent with 1dp
        rule40: rule40 != null ? Math.round(rule40 * 10) / 10 : null,
        magic: magic != null ? Math.round(magic * 100) / 100 : null,
        quickRatio: w?.quick_ratio ?? null,
        grossMargin: u?.gross_margin ?? null,
        annualNRR: annualNRR != null ? Math.round(annualNRR * 1000) / 10 : null,
        annualGRR: annualGRR != null ? Math.round(annualGRR * 1000) / 10 : null,
        burnMultiple: burnMultiple != null ? Math.round(burnMultiple * 100) / 100 : null,
        opMargin: opMargin != null ? Math.round(opMargin * 1000) / 10 : null,
      };
    });
  }, [ue, wf]);

  // Latest row with waterfall data populated (skips partial current month where wf excludes data).
  const latest = useMemo(() => {
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].quickRatio != null || series[i].annualNRR != null) return series[i];
    }
    return series[series.length - 1];
  }, [series]);

  // Trim series to window
  const visible = useMemo(() => {
    if (win === 'ALL') return series;
    const n = win === '24M' ? 24 : win === '36M' ? 36 : 60;
    return series.slice(-n);
  }, [series, win]);

  return (
    <Box>
      <PageHeader
        title="Efficiency"
        subtitle="How our operator metrics are trending month by month — lets us see whether efficiency is improving, flat, or eroding over time."
        question="efficient"
      />

      {/* Current-value cards (hover the ℹ icon for methodology) */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <SummaryCard
            label="Rule of 40"
            value={latest?.rule40 != null ? `${latest.rule40.toFixed(1)}` : null}
            hint="TTM growth + op margin"
            color={rule40Color(latest?.rule40 ?? null)}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> SaaS efficiency benchmark — growth rate % + operating margin %.
                Above 40 signals efficient growth; below suggests over-spending or under-growing.
                <br /><br />
                <strong>Data:</strong> ARR growth YoY (current subscription MRR × 12 vs. 12 months prior) plus TTM operating margin (Net Operating Income ÷ Total Income from QuickBooks P&L, trailing 12 months).
                <br /><br />
                <strong>Target:</strong> ≥ 40
              </>
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <SummaryCard
            label="Magic Number"
            value={ratio(latest?.magic ?? null)}
            hint="Trailing Q · ≥ 0.75"
            color={magicColor(latest?.magic ?? null)}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Sales & marketing efficiency — how much net new ARR each dollar of S&M produces.
                <br /><br />
                <strong>Data:</strong> Trailing-quarter net new MRR (New + Expansion − Contraction − Churn from the MRR waterfall) × 4, divided by trailing-quarter S&M spend (QuickBooks: Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission).
                <br /><br />
                <strong>Target:</strong> ≥ 0.75 = spend more · ≥ 1.0 = self-funded growth · &lt; 0.5 usually triggers S&M cuts
              </>
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <SummaryCard
            label="Quick Ratio"
            value={ratio(latest?.quickRatio ?? null)}
            hint="Monthly · ≥ 4x"
            color={quickColor(latest?.quickRatio ?? null)}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Growth durability — dollars of MRR added divided by dollars lost each month. High ratio means growth is coming from new business, not just offsetting churn.
                <br /><br />
                <strong>Data:</strong> (New MRR + Expansion MRR) ÷ (Contraction MRR + Churn MRR), derived from per-customer MRR changes month over month.
                <br /><br />
                <strong>Target:</strong> ≥ 4x healthy · &lt; 2x is a warning sign
              </>
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <SummaryCard
            label="Annual NRR"
            value={latest?.annualNRR != null ? `${latest.annualNRR.toFixed(1)}%` : null}
            hint="Monthly NRR compounded · ≥ 100%"
            color={nrrColor(latest?.annualNRR != null ? latest.annualNRR / 100 : null)}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Net Revenue Retention — of every $1 of MRR at the start of the period, how much remains from the same customers at the end (including expansion, minus contraction and churn). &gt; 100% means existing customers grow net.
                <br /><br />
                <strong>Data:</strong> Monthly NRR = (Starting MRR − Churn − Contraction + Expansion) ÷ Starting MRR, from the MRR waterfall. Annualized by compounding the monthly rate × 12.
                <br /><br />
                <strong>Target:</strong> ≥ 100% good · ≥ 110% top-quartile SaaS
              </>
            }
          />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <SummaryCard
            label="Burn Multiple"
            value={latest?.burnMultiple != null ? `${latest.burnMultiple.toFixed(2)}x` : 'N/A'}
            hint={latest?.burnMultiple == null ? 'Net operating income positive' : 'Burn / Net new ARR · < 1x is strong'}
            color={latest?.burnMultiple == null ? 'success.main' : latest.burnMultiple < 1 ? 'success.main' : latest.burnMultiple < 2 ? 'warning.main' : 'error.main'}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Cash efficiency — how many dollars you burn to add a dollar of ARR. "N/A" means you're operating profitably (no burn).
                <br /><br />
                <strong>Data:</strong> |TTM Operating Loss| ÷ TTM Net New MRR. If TTM net operating income is positive, there's no burn to divide, and we show N/A.
                <br /><br />
                <strong>Target:</strong> &lt; 1x strong · 1–2x decent · &gt; 2x inefficient
              </>
            }
          />
        </Grid>
      </Grid>

      {/* Window toggle */}
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={win}
          onChange={(_, v) => v && setWin(v as Window)}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="24M">24M</ToggleButton>
          <ToggleButton value="36M">36M</ToggleButton>
          <ToggleButton value="60M">5Y</ToggleButton>
          <ToggleButton value="ALL">All</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      {/* Trend grid — ℹ icon on each chart explains what and where the numbers come from */}
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <TrendChart
            title="ARR growth · YoY"
            data={visible}
            dataKey="arrGrowth"
            color="#2C73FF"
            yFormatter={(v) => `${v}%`}
            refLine={0}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Year-over-year subscription ARR growth rate — the growth input to Rule of 40.
                <br /><br />
                <strong>Data:</strong> For each month M, (MRR[M] × 12) ÷ (MRR[M−12] × 12) − 1, using point-in-time subscription MRR from the MRR by Month tab. Same methodology used on the Scorecard page.
                <br /><br />
                <strong>Target:</strong> ≥ 15% healthy · ≥ 30% strong
              </>
            }
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendChart
            title="Rule of 40 (TTM)"
            data={visible}
            dataKey="rule40"
            color="#1A9E5C"
            yFormatter={(v) => `${v}`}
            refLine={40}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Growth % + operating margin % over time. Shows whether efficiency is improving or eroding.
                <br /><br />
                <strong>Data:</strong> At each month, ARR growth YoY + TTM operating margin (Net Operating Income ÷ Total Income, summed over the prior 12 months).
                <br /><br />
                <strong>Target:</strong> ≥ 40 · above means efficient growth for the stage
              </>
            }
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendChart
            title="Magic Number (trailing Q)"
            data={visible}
            dataKey="magic"
            color="#F59E0B"
            yFormatter={(v) => `${v}x`}
            refLine={0.75}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Sales-and-marketing efficiency trend. Watching this over time reveals if CAC is scaling or compressing.
                <br /><br />
                <strong>Data:</strong> For each month M, (trailing 3-month net new MRR × 4) ÷ trailing 3-month S&M spend. Net new MRR from the waterfall; S&M from QuickBooks (Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission).
                <br /><br />
                <strong>Target:</strong> ≥ 0.75 good · ≥ 1.0 excellent
              </>
            }
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendChart
            title="Quick Ratio"
            data={visible}
            dataKey="quickRatio"
            color="#E6A24E"
            yFormatter={(v) => `${v}x`}
            refLine={4}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Monthly growth-durability ratio. Spikes mean a great month; sustained decline means churn/contraction is outpacing new business.
                <br /><br />
                <strong>Data:</strong> For each month, (New MRR + Expansion MRR) ÷ (Contraction MRR + Churn MRR) — directly from the MRR waterfall's per-customer monthly deltas.
                <br /><br />
                <strong>Target:</strong> ≥ 4x healthy
              </>
            }
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendChart
            title="Annual NRR (TTM-annualized)"
            data={visible}
            dataKey="annualNRR"
            color="#2C73FF"
            yFormatter={(v) => `${v}%`}
            refLine={100}
            loading={isLoading}
            info={
              <>
                <strong>What it is:</strong> Rolling annualized Net Revenue Retention — is your existing customer base growing or shrinking in aggregate?
                <br /><br />
                <strong>Data:</strong> Monthly NRR = (Starting MRR − Churn − Contraction + Expansion) ÷ Starting MRR, then compounded to annual as monthly_nrr<sup>12</sup>. Source is the MRR waterfall.
                <br /><br />
                <strong>Target:</strong> ≥ 100% good · ≥ 110% top-quartile
              </>
            }
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <TrendChart
            title="Gross margin (monthly)"
            data={visible}
            dataKey="grossMargin"
            color="#1A9E5C"
            yFormatter={(v) => `${Math.round(v * 100)}%`}
            refLine={0.75}
            loading={isLoading}
            yDomain={[0.5, 1]}
            info={
              <>
                <strong>What it is:</strong> Revenue after direct cost-of-revenue, as a % of revenue. The higher and more stable, the more the business looks like "real" SaaS.
                <br /><br />
                <strong>Data:</strong> Gross Profit ÷ Total Income per month, from QuickBooks P&L. COGS includes 5000 Credit Card Acceptance Fees, 5200 Sales Commission, 5300 Services Commissions, 5400 Affiliate Commissions.
                <br /><br />
                <strong>Target:</strong> ≥ 70% · ≥ 75% top-quartile SaaS
              </>
            }
          />
        </Grid>
      </Grid>
    </Box>
  );
}

function SummaryCard({
  label, value, hint, color, loading, info,
}: { label: string; value: string | null; hint: string; color: string; loading?: boolean; info?: ReactNode }) {
  return (
    <Paper sx={{ p: 2.5, height: '100%', position: 'relative' }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between">
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

function TrendChart({
  title, data, dataKey, color, yFormatter, refLine, loading, yDomain, info,
}: {
  title: string;
  data: Array<Record<string, unknown>>;
  dataKey: string;
  color: string;
  yFormatter: (v: number) => string;
  refLine?: number;
  loading?: boolean;
  yDomain?: [number, number];
  info?: ReactNode;
}) {
  return (
    <Paper sx={{ p: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
          {title}
        </Typography>
        <Stack direction="row" alignItems="center" spacing={1}>
          {refLine != null && (
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10.5 }}>
              target line at {yFormatter(refLine)}
            </Typography>
          )}
          {info && <InfoIcon info={info} />}
        </Stack>
      </Stack>
      {loading ? (
        <Skeleton variant="rectangular" height={180} />
      ) : (
        <Box sx={{ height: 180 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
              <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
              <YAxis stroke="#8B949E" fontSize={11} width={50} tickFormatter={(v) => yFormatter(Number(v))} domain={yDomain} />
              {refLine != null && <ReferenceLine y={refLine} stroke="#8B949E" strokeDasharray="4 4" />}
              <RTooltip
                labelFormatter={(v) => monthLabel(String(v))}
                formatter={(v: number) => [yFormatter(v), title]}
                contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
              />
              <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2} dot={{ r: 2, fill: color }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </Box>
      )}
    </Paper>
  );
}
