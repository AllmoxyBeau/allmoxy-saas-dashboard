import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorIcon from '@mui/icons-material/Error';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import { useSheetTab } from '../hooks/useSheetTab';

type UnitEconSnap = {
  monthly: Array<{ month: string; subscription_revenue: number; total_income: number; snm_expense: number; gross_margin: number | null; net_op_income: number }>;
  ttm: {
    windowStart: string;
    windowEnd: string;
    subscription_revenue: number;
    services_revenue: number;
    total_income: number;
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
    ltv: number | null;
    cac_payback_months: number | null;
    ltv_cac_ratio: number | null;
  };
  services: {
    attach_rate: number | null;
    avg_services_revenue_per_attached_customer: number | null;
  };
};
type WaterfallSnap = {
  monthly: Array<{ month: string; new_mrr: number; expansion_mrr: number; contraction_mrr: number; churn_mrr: number; net_new_mrr: number; starting_mrr: number; ending_mrr: number }>;
  ttm: {
    annual_grr: number | null;
    annual_nrr: number | null;
    quick_ratio: number | null;
    annual_gross_churn_rate: number | null;
  };
};
type MrrSnap = { rows: Array<{ month: string; mrr_subscription: number | null; logo_qty: number | null }> };
type HealthSnap = { concentration: { top10: { pct: number | null }; total_active_customers: number; total_mrr: number }; dunning_summary: { total_dunning_customers: number; total_at_risk_amount: number } };

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function pct(v: number | null | undefined, digits = 1) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}
function pctSigned(v: number | null | undefined, digits = 1) {
  if (v == null) return '—';
  const s = v * 100;
  return `${s >= 0 ? '+' : ''}${s.toFixed(digits)}%`;
}
function ratio(v: number | null | undefined) { return v == null ? '—' : `${v.toFixed(2)}x`; }
function months(v: number | null | undefined) { return v == null ? '—' : `${v.toFixed(1)} mo`; }

type Verdict = 'strong' | 'solid' | 'watch' | 'weak' | 'unknown';
function verdictColor(v: Verdict): 'success.main' | 'warning.main' | 'error.main' | 'text.primary' {
  if (v === 'strong' || v === 'solid') return 'success.main';
  if (v === 'watch') return 'warning.main';
  if (v === 'weak') return 'error.main';
  return 'text.primary';
}
function verdictBg(v: Verdict): string {
  if (v === 'strong') return 'rgba(26, 158, 92, 0.18)';
  if (v === 'solid') return 'rgba(26, 158, 92, 0.10)';
  if (v === 'watch') return 'rgba(245, 158, 11, 0.18)';
  if (v === 'weak') return 'rgba(218, 54, 51, 0.18)';
  return 'rgba(139, 148, 158, 0.10)';
}

export default function MAReadiness() {
  const { data: ueData, isLoading: ueLoading } = useSheetTab('unit_economics');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: mrrData } = useSheetTab('mrr_by_month');
  const { data: healthData } = useSheetTab('customer_health');

  const ue = ueData as unknown as UnitEconSnap | undefined;
  const wf = wfData as unknown as WaterfallSnap | undefined;
  const mrr = mrrData as unknown as MrrSnap | undefined;
  const health = healthData as unknown as HealthSnap | undefined;

  const computed = useMemo(() => {
    if (!ue || !wf || !mrr || !health) return null;

    // ARR growth YoY using subscription MRR × 12 at TTM endpoint vs 12 months prior.
    const ttmEnd = ue.ttm.windowEnd;
    const endingSubMonth = mrr.rows.find((r) => r.month === ttmEnd);
    const priorMonth = (() => {
      const [y, m] = ttmEnd.split('-').map(Number);
      return `${y - 1}-${String(m).padStart(2, '0')}`;
    })();
    const priorSubMonth = mrr.rows.find((r) => r.month === priorMonth);
    const arrCurrent = (endingSubMonth?.mrr_subscription ?? 0) * 12;
    const arrYearAgo = (priorSubMonth?.mrr_subscription ?? 0) * 12;
    const arrGrowth = arrYearAgo > 0 ? (arrCurrent - arrYearAgo) / arrYearAgo : null;

    // Rule of 40 = growth % + operating margin %.
    const opMargin = ue.ttm.total_income > 0 ? ue.ttm.net_op_income / ue.ttm.total_income : null;
    const rule40 = arrGrowth != null && opMargin != null ? (arrGrowth + opMargin) * 100 : null;

    // Magic Number (trailing 3-month): annualized net new MRR / quarterly S&M.
    const last3 = wf.monthly.slice(-3);
    const q_net_new_mrr = last3.reduce((s, m) => s + m.net_new_mrr, 0);
    const q_snm = (() => {
      const last3U = ue.monthly.slice(-3);
      return last3U.reduce((s, m) => s + m.snm_expense, 0);
    })();
    const magicNumber = q_snm > 0 ? (q_net_new_mrr * 4) / q_snm : null;

    // Blended ARR = subscription ARR + annualized services + annualized connect (from TTM).
    const servicesAnnualized = ue.ttm.services_revenue; // already TTM
    const blendedArr = arrCurrent + servicesAnnualized; // Connect not in ue.ttm — rough approximation

    return {
      arrCurrent,
      arrYearAgo,
      arrGrowth,
      opMargin,
      rule40,
      magicNumber,
      q_net_new_mrr,
      q_snm,
      blendedArr,
      servicesAnnualized,
    };
  }, [ue, wf, mrr, health]);

  // Three "big question" verdicts, scored from key metrics.
  const verdicts = useMemo(() => {
    if (!ue || !wf || !health || !computed) {
      return { healthy: { score: 0, total: 0, verdict: 'unknown' as Verdict }, efficient: { score: 0, total: 0, verdict: 'unknown' as Verdict }, exit: { score: 0, total: 0, verdict: 'unknown' as Verdict } };
    }
    const tests = {
      healthy: [
        { label: 'ARR growth ≥ 15%', pass: (computed.arrGrowth ?? 0) >= 0.15 },
        { label: 'NRR ≥ 100%', pass: (wf.ttm.annual_nrr ?? 0) >= 1 },
        { label: 'GRR ≥ 80%', pass: (wf.ttm.annual_grr ?? 0) >= 0.8 },
        { label: 'Annual churn ≤ 20%', pass: (wf.ttm.annual_gross_churn_rate ?? 1) <= 0.2 },
        { label: 'Top-10 concentration ≤ 30%', pass: (health.concentration.top10.pct ?? 1) <= 0.3 },
      ],
      efficient: [
        { label: 'LTV:CAC ≥ 3', pass: (ue.ttm.ltv_cac_ratio ?? 0) >= 3 },
        { label: 'CAC payback ≤ 18 months', pass: (ue.ttm.cac_payback_months ?? 99) <= 18 },
        { label: 'Gross margin ≥ 70%', pass: (ue.ttm.gross_margin ?? 0) >= 0.7 },
        { label: 'Operating margin ≥ 0%', pass: (computed.opMargin ?? -1) >= 0 },
        { label: 'Rule of 40 ≥ 40', pass: (computed.rule40 ?? 0) >= 40 },
      ],
      exit: [
        { label: 'ARR ≥ $2M', pass: computed.arrCurrent >= 2_000_000 },
        { label: 'NRR ≥ 100%', pass: (wf.ttm.annual_nrr ?? 0) >= 1 },
        { label: 'LTV:CAC ≥ 3', pass: (ue.ttm.ltv_cac_ratio ?? 0) >= 3 },
        { label: 'Rule of 40 ≥ 40', pass: (computed.rule40 ?? 0) >= 40 },
        { label: 'Top-10 concentration ≤ 30%', pass: (health.concentration.top10.pct ?? 1) <= 0.3 },
        { label: 'Annual churn ≤ 20%', pass: (wf.ttm.annual_gross_churn_rate ?? 1) <= 0.2 },
      ],
    };
    const score = (arr: Array<{ pass: boolean }>) => arr.filter((x) => x.pass).length;
    const verdict = (s: number, total: number): Verdict => {
      const r = total > 0 ? s / total : 0;
      if (r >= 0.8) return 'strong';
      if (r >= 0.6) return 'solid';
      if (r >= 0.4) return 'watch';
      return 'weak';
    };
    return {
      healthy: { score: score(tests.healthy), total: tests.healthy.length, verdict: verdict(score(tests.healthy), tests.healthy.length), tests: tests.healthy },
      efficient: { score: score(tests.efficient), total: tests.efficient.length, verdict: verdict(score(tests.efficient), tests.efficient.length), tests: tests.efficient },
      exit: { score: score(tests.exit), total: tests.exit.length, verdict: verdict(score(tests.exit), tests.exit.length), tests: tests.exit },
    };
  }, [ue, wf, health, computed]);

  // Data-room diligence checklist — what's built into this dashboard vs. what's still on you.
  const checklist: Array<{ category: string; label: string; status: 'ok' | 'gap' | 'partial'; note?: string }> = [
    { category: 'Financial', label: 'Subscription MRR by month (8+ years)', status: 'ok' },
    { category: 'Financial', label: 'Revenue stream split (Sub / Services / Connect)', status: 'ok' },
    { category: 'Financial', label: 'Full P&L by month (QuickBooks)', status: 'ok' },
    { category: 'Financial', label: 'Audited financials', status: 'gap', note: 'Recommended for any serious external scrutiny — lender, partner, or acquirer review' },
    { category: 'Financial', label: 'Recast EBITDA (owner add-backs)', status: 'partial', note: 'Net operating income surfaced; add-backs not yet formalized' },
    { category: 'Customer', label: 'Full customer roster with signup dates', status: 'ok' },
    { category: 'Customer', label: 'Cohort retention (logo + dollar)', status: 'ok' },
    { category: 'Customer', label: 'Customer concentration analysis', status: 'ok' },
    { category: 'Customer', label: 'Dunning / at-risk customer list', status: 'ok' },
    { category: 'Customer', label: 'Top contract terms summary', status: 'gap', note: 'Roll-up of top-N contract auto-renewal / termination / pricing-escalator terms' },
    { category: 'Unit economics', label: 'CAC / LTV / Payback / LTV:CAC', status: 'ok' },
    { category: 'Unit economics', label: 'MRR waterfall (new/exp/contr/churn)', status: 'ok' },
    { category: 'Unit economics', label: 'Services attach rate + LTV uplift', status: 'ok' },
    { category: 'Ops', label: 'Stripe transaction detail (reconcilable)', status: 'ok' },
    { category: 'Ops', label: 'Org chart + key-employee retention', status: 'gap' },
    { category: 'Ops', label: 'Central document repository', status: 'gap' },
  ];

  return (
    <Box>
      <PageHeader
        title="Scorecard"
        subtitle="Every KPI at a glance with color-coded status — what's healthy, what's on the watchlist, and what needs work. The one-pager leadership runs against."
        question="durable"
      />

      {/* Three big-question verdict cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={4}>
          <VerdictCard
            label="Healthy?"
            subtitle="Growth + retention"
            score={verdicts.healthy.score}
            total={verdicts.healthy.total}
            verdict={verdicts.healthy.verdict}
            tests={verdicts.healthy.tests}
            loading={ueLoading}
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <VerdictCard
            label="Efficient?"
            subtitle="Unit economics"
            score={verdicts.efficient.score}
            total={verdicts.efficient.total}
            verdict={verdicts.efficient.verdict}
            tests={verdicts.efficient.tests}
            loading={ueLoading}
          />
        </Grid>
        <Grid item xs={12} md={4}>
          <VerdictCard
            label="Durable?"
            subtitle="Long-term staying power"
            score={verdicts.exit.score}
            total={verdicts.exit.total}
            verdict={verdicts.exit.verdict}
            tests={verdicts.exit.tests}
            loading={ueLoading}
          />
        </Grid>
      </Grid>

      {/* Headline metrics */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 2 }}>
          Headline metrics · {ue?.ttm.windowStart} – {ue?.ttm.windowEnd} TTM
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="Subscription ARR" value={computed ? USD_COMPACT.format(computed.arrCurrent) : null} hint="Ending sub MRR × 12" loading={ueLoading} info={<><strong>What it is:</strong> Current subscription run-rate annualized.<br /><br /><strong>Data:</strong> Subscription MRR from the latest complete month of MRR by Month × 12.</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="YoY ARR growth" value={computed ? pctSigned(computed.arrGrowth) : null} hint={computed ? `from ${USD_COMPACT.format(computed.arrYearAgo)}` : 'loading'} color={growthColor(computed?.arrGrowth)} loading={ueLoading} info={<><strong>What it is:</strong> Subscription ARR growth year-over-year.<br /><br /><strong>Data:</strong> (Current ARR − Year-ago ARR) ÷ Year-ago ARR. Both endpoints are point-in-time subscription MRR × 12.<br /><br /><strong>Target:</strong> ≥ 15% healthy · ≥ 30% strong</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="NRR (annual)" value={pct(wf?.ttm.annual_nrr)} hint="Target ≥ 110%" color={nrrColor(wf?.ttm.annual_nrr)} loading={ueLoading} info={<><strong>What it is:</strong> Net Revenue Retention — of every $1 existing customers paid a year ago, how much they pay now (including expansion, excluding new logos).<br /><br /><strong>Data:</strong> Monthly NRR from the MRR waterfall, compounded ×12.<br /><br /><strong>Target:</strong> ≥ 100% good · ≥ 110% top-quartile</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="GRR (annual)" value={pct(wf?.ttm.annual_grr)} hint="Target ≥ 90%" color={grrColor(wf?.ttm.annual_grr)} loading={ueLoading} info={<><strong>What it is:</strong> Gross Revenue Retention — like NRR but without expansion credit. The retention "ceiling."<br /><br /><strong>Data:</strong> (Starting − Churn − Contraction) ÷ Starting, compounded to annual from MRR waterfall.<br /><br /><strong>Target:</strong> ≥ 90% top-quartile</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="Rule of 40" value={computed?.rule40 != null ? computed.rule40.toFixed(0) : null} hint="Growth % + Op margin %" color={rule40Color(computed?.rule40)} loading={ueLoading} info={<><strong>What it is:</strong> Growth rate + operating margin. Benchmark for "efficient growth" in SaaS.<br /><br /><strong>Data:</strong> YoY ARR growth % + TTM operating margin (Net Operating Income ÷ Total Income from QB P&L).<br /><br /><strong>Target:</strong> ≥ 40</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="LTV : CAC" value={ratio(ue?.ttm.ltv_cac_ratio)} hint="Target ≥ 3x" color={ltvCacColor(ue?.ttm.ltv_cac_ratio)} loading={ueLoading} info={<><strong>What it is:</strong> Lifetime value of a customer relative to cost to acquire.<br /><br /><strong>Data:</strong> LTV (avg MRR × subscription gross margin ÷ monthly churn) ÷ CAC (TTM S&M ÷ TTM new logos).<br /><br /><strong>Target:</strong> ≥ 3x · ≥ 5x best-in-class</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="CAC payback" value={months(ue?.ttm.cac_payback_months)} hint="Good ≤ 12 mo" color={paybackColor(ue?.ttm.cac_payback_months)} loading={ueLoading} info={<><strong>What it is:</strong> Months of gross profit to recover CAC on a new customer.<br /><br /><strong>Data:</strong> CAC ÷ (avg MRR × subscription gross margin).<br /><br /><strong>Target:</strong> ≤ 12 mo good · 12–18 caution</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="Gross margin" value={pct(ue?.ttm.gross_margin)} hint="Target ≥ 70%" color={gmColor(ue?.ttm.gross_margin)} loading={ueLoading} info={<><strong>What it is:</strong> TTM blended gross margin.<br /><br /><strong>Data:</strong> (Total Income − Total COGS) ÷ Total Income from QuickBooks, summed across TTM.<br /><br /><strong>Target:</strong> ≥ 70% · ≥ 75% top-quartile SaaS</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="Annual logo churn" value={pct(ue?.ttm.annual_churn_rate)} hint="Good ≤ 10%, caution ≤ 20%" color={churnColor(ue?.ttm.annual_churn_rate)} loading={ueLoading} info={<><strong>What it is:</strong> % of customers who stopped paying in the trailing 12 months.<br /><br /><strong>Data:</strong> Churned logos TTM ÷ starting-period logo count.<br /><br /><strong>Target:</strong> ≤ 10% excellent · ≤ 20% acceptable</>} />
          </Grid>
          <Grid item xs={12} sm={6} md={2.4}>
            <Metric label="Top 10 concentration" value={pct(health?.concentration.top10.pct)} hint="Target ≤ 25%" color={concColor(health?.concentration.top10.pct)} loading={ueLoading} info={<><strong>What it is:</strong> % of subscription MRR from the top 10 customers — the concentration-risk number a buyer will ask about first.<br /><br /><strong>Data:</strong> Sum of top-10 current MRR ÷ total subscription MRR from the Customer Health snapshot.<br /><br /><strong>Target:</strong> ≤ 25% low risk · &gt; 40% concerning</>} />
          </Grid>
        </Grid>
      </Paper>

      {/* Rule of 40 + Magic Number breakdowns */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                Rule of 40 breakdown
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> The Rule of 40 number with its two components broken out — the "show your work" box.<br /><br /><strong>Data:</strong> YoY ARR growth % (current sub MRR × 12 vs. 12 months prior) + TTM operating margin (Net Operating Income ÷ Total Income from QuickBooks).</>} />
            </Stack>
            {!computed ? <Skeleton variant="rectangular" height={140} /> : (
              <Stack spacing={1.5}>
                <BreakdownRow label="ARR growth rate (YoY)" value={pctSigned(computed.arrGrowth)} color={growthColor(computed.arrGrowth)} />
                <BreakdownRow label="+ Operating margin (TTM)" value={pct(computed.opMargin)} color={marginColor(computed.opMargin)} />
                <Box sx={{ borderTop: '1px solid rgba(139, 148, 158, 0.25)', pt: 1 }}>
                  <BreakdownRow label="Rule of 40 score" value={computed.rule40 != null ? computed.rule40.toFixed(1) : '—'} color={rule40Color(computed.rule40)} bold />
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  Target ≥ 40. Above 40 signals efficient growth; below suggests the business is either growing too slowly for its spend or burning more than its growth justifies.
                </Typography>
              </Stack>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                Magic Number (trailing quarter)
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> Sales & marketing efficiency in a single number — net new ARR added per dollar of S&M.<br /><br /><strong>Data:</strong> Net new MRR over the last 3 months × 4 (annualized) ÷ S&M spend over the last 3 months. Net new MRR = New + Expansion − Contraction − Churn from the waterfall. S&M = Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission from QuickBooks.</>} />
            </Stack>
            {!computed ? <Skeleton variant="rectangular" height={140} /> : (
              <Stack spacing={1.5}>
                <BreakdownRow label="Net new MRR (last 3 mo)" value={USD0.format(computed.q_net_new_mrr)} />
                <BreakdownRow label="Annualized (×4)" value={USD0.format(computed.q_net_new_mrr * 4)} />
                <BreakdownRow label="÷ S&M spend (last 3 mo)" value={USD0.format(computed.q_snm)} />
                <Box sx={{ borderTop: '1px solid rgba(139, 148, 158, 0.25)', pt: 1 }}>
                  <BreakdownRow label="Magic Number" value={ratio(computed.magicNumber)} color={magicColor(computed.magicNumber)} bold />
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  Target ≥ 0.75 (spend more); ≥ 1.0 is excellent (self-funded growth). Below 0.5 usually triggers S&M cuts.
                </Typography>
              </Stack>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Diligence checklist */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Diligence readiness checklist
          </Typography>
          <InfoIcon info={<><strong>What it is:</strong> Checklist of the data and operational artifacts a well-run business should have on hand — what's already surfaced by this dashboard vs. what still needs to be produced or maintained elsewhere.<br /><br /><strong>Green ✓</strong> = in place · <strong>Amber ⚠</strong> = partial coverage · <strong>Red ✗</strong> = needs work.</>} />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Category</TableCell>
              <TableCell>Item</TableCell>
              <TableCell align="center">Status</TableCell>
              <TableCell>Note</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {checklist.map((c, i) => (
              <TableRow key={i}>
                <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{c.category}</TableCell>
                <TableCell sx={{ fontWeight: 500 }}>{c.label}</TableCell>
                <TableCell align="center">
                  {c.status === 'ok' && <CheckCircleIcon sx={{ color: 'success.main', fontSize: 18 }} />}
                  {c.status === 'partial' && <WarningAmberIcon sx={{ color: 'warning.main', fontSize: 18 }} />}
                  {c.status === 'gap' && <ErrorIcon sx={{ color: 'error.main', fontSize: 18 }} />}
                </TableCell>
                <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{c.note ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
          <Chip size="small" icon={<CheckCircleIcon />} label={`${checklist.filter((c) => c.status === 'ok').length} in place`} sx={{ bgcolor: 'rgba(26, 158, 92, 0.12)', color: 'success.main' }} />
          <Chip size="small" icon={<WarningAmberIcon />} label={`${checklist.filter((c) => c.status === 'partial').length} partial`} sx={{ bgcolor: 'rgba(245, 158, 11, 0.12)', color: 'warning.main' }} />
          <Chip size="small" icon={<ErrorIcon />} label={`${checklist.filter((c) => c.status === 'gap').length} gap`} sx={{ bgcolor: 'rgba(218, 54, 51, 0.12)', color: 'error.main' }} />
        </Stack>
      </Paper>
    </Box>
  );
}

function VerdictCard({
  label, subtitle, score, total, verdict, tests, loading,
}: {
  label: string;
  subtitle: string;
  score: number;
  total: number;
  verdict: Verdict;
  tests?: Array<{ label: string; pass: boolean }>;
  loading?: boolean;
}) {
  const verdictLabel: Record<Verdict, string> = {
    strong: 'Strong',
    solid: 'Solid',
    watch: 'Watch',
    weak: 'Work to do',
    unknown: '—',
  };
  return (
    <Paper sx={{ p: 3, height: '100%', bgcolor: verdictBg(verdict), border: '1px solid', borderColor: 'rgba(139, 148, 158, 0.12)' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1 }}>
        <Stack>
          <Typography variant="overline" sx={{ color: 'text.secondary', fontSize: 10.5 }}>
            {subtitle}
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>
            {label}
          </Typography>
        </Stack>
        <Typography variant="h4" sx={{ fontWeight: 500, color: verdictColor(verdict) }}>
          {loading ? <Skeleton width={60} /> : `${score}/${total}`}
        </Typography>
      </Stack>
      <Typography variant="caption" sx={{ color: verdictColor(verdict), fontWeight: 500, display: 'block', mb: 1 }}>
        {verdictLabel[verdict]}
      </Typography>
      {tests && tests.length > 0 && (
        <Stack spacing={0.5}>
          {tests.map((t) => (
            <Stack key={t.label} direction="row" spacing={0.75} alignItems="center">
              {t.pass ? (
                <CheckCircleIcon sx={{ color: 'success.main', fontSize: 14 }} />
              ) : (
                <ErrorIcon sx={{ color: 'error.main', fontSize: 14 }} />
              )}
              <Typography variant="caption" sx={{ fontSize: 11, color: t.pass ? 'text.primary' : 'text.secondary' }}>
                {t.label}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Paper>
  );
}

function Metric({
  label, value, hint, color = 'text.primary', loading, info,
}: {
  label: string;
  value: string | null;
  hint: string;
  color?: string;
  loading?: boolean;
  info?: React.ReactNode;
}) {
  return (
    <Paper sx={{ p: 2, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>
          {label}
        </Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      {loading || value == null ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 22 }} />
      ) : (
        <Typography variant="h6" sx={{ fontWeight: 500, color, mt: 0.25 }}>
          {value}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25, fontSize: 10 }}>
        {hint}
      </Typography>
    </Paper>
  );
}

function BreakdownRow({ label, value, color = 'text.primary', bold = false }: { label: string; value: string; color?: string; bold?: boolean }) {
  return (
    <Stack direction="row" justifyContent="space-between">
      <Typography variant="body2" sx={{ fontWeight: bold ? 500 : 400 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: bold ? 600 : 500, color }}>{value}</Typography>
    </Stack>
  );
}

// Color thresholds
function growthColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 0.30) return 'success.main';
  if (v >= 0.10) return 'warning.main';
  return 'error.main';
}
function nrrColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 1.1) return 'success.main';
  if (v >= 1) return 'warning.main';
  return 'error.main';
}
function grrColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 0.9) return 'success.main';
  if (v >= 0.8) return 'warning.main';
  return 'error.main';
}
function marginColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 0.15) return 'success.main';
  if (v >= 0) return 'warning.main';
  return 'error.main';
}
function gmColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 0.75) return 'success.main';
  if (v >= 0.60) return 'warning.main';
  return 'error.main';
}
function churnColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v <= 0.10) return 'success.main';
  if (v <= 0.20) return 'warning.main';
  return 'error.main';
}
function concColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v <= 0.25) return 'success.main';
  if (v <= 0.40) return 'warning.main';
  return 'error.main';
}
function rule40Color(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 40) return 'success.main';
  if (v >= 20) return 'warning.main';
  return 'error.main';
}
function ltvCacColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 3) return 'success.main';
  if (v >= 1) return 'warning.main';
  return 'error.main';
}
function paybackColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v <= 12) return 'success.main';
  if (v <= 18) return 'warning.main';
  return 'error.main';
}
function magicColor(v: number | null | undefined) {
  if (v == null) return 'text.primary';
  if (v >= 1) return 'success.main';
  if (v >= 0.75) return 'warning.main';
  return 'error.main';
}
