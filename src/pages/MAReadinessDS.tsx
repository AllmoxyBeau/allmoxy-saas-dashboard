/**
 * M&A Scorecard on the Allmoxy design system. Every figure and every pass/fail test comes from
 * the same snapshots and the same maths as the classic page (MAReadiness.tsx, kept at
 * /scorecard-classic): unit_economics, mrr_waterfall (accrual basis), mrr_by_month,
 * customer_health and customer_base.
 *
 * Order follows what a reader acts on: the three verdicts, then every test behind them (failing
 * first, with the measured figure the test reads), the headline metrics, the Rule of 40 and
 * Magic Number workings, and the diligence checklist.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, Icon, KpiCard, KpiGrid, SideSheet, downloadCsv, mlabel, pct, usd } from '../design-system/parts';

type UnitEconSnap = {
  monthly: Array<{ month: string; subscription_revenue: number; total_income: number; snm_expense: number | null; gross_margin: number | null; net_op_income: number | null; pnl_available?: boolean }>;
  ttm: {
    windowStart: string; windowEnd: string;
    pnl_coverage?: { months: number; start: string | null; end: string | null } | null;
    pnl_total_income?: number | null; operating_margin?: number | null;
    subscription_revenue: number; services_revenue: number; total_income: number; gross_profit: number;
    gross_margin: number | null; subscription_gross_margin: number | null; snm_expense: number; new_logos: number;
    cac: number | null; net_op_income: number; monthly_churn_rate: number | null; annual_churn_rate: number | null;
    annual_logo_churn_rate: number | null; annual_revenue_churn_rate: number | null; avg_mrr_per_customer: number | null;
    ltv: number | null; cac_payback_months: number | null; ltv_cac_ratio: number | null;
  };
};
type WaterfallMonthRow = { month: string; partial?: boolean; new_mrr: number; expansion_mrr: number; contraction_mrr: number; churn_mrr: number; net_new_mrr: number; starting_mrr: number; ending_mrr: number };
type RetTtm = { annual_grr: number | null; annual_nrr: number | null; quick_ratio: number | null; annual_gross_churn_rate: number | null };
type WaterfallSnap = { monthly_accrual?: WaterfallMonthRow[]; monthly: WaterfallMonthRow[]; ttm: RetTtm; ttm_accrual?: RetTtm | null };
type MrrSnap = { rows: Array<{ month: string; mrr_subscription: number | null; logo_qty: number | null }> };
type CustomerBaseSnap = { as_of: string; customers: number; mrr: number; arr: number; by_month: Array<{ month: string; customers: number; mrr: number }> };
type HealthSnap = { concentration: { top10: { pct: number | null }; total_active_customers: number; total_mrr: number } };

type Tone = 'success' | 'warning' | 'error' | 'neutral';
type Verdict = 'strong' | 'solid' | 'watch' | 'weak' | 'unknown';

// ---- formatting exactly as the classic page
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const pctSigned = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v * 100 >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);
const ratio = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}x`);
const monthsTxt = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)} mo`);
const monLabel = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' }) + '-' + String(y).slice(2);
};
const shiftMonth = (iso: string, delta: number) => {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// ---- the classic page's colour thresholds, as a status word + tone (never colour alone)
const band = (good: boolean, fair: boolean): Tone => (good ? 'success' : fair ? 'warning' : 'error');
const hi = (v: number | null | undefined, g: number, f: number): Tone | null => (v == null ? null : band(v >= g, v >= f));
const lo = (v: number | null | undefined, g: number, f: number): Tone | null => (v == null ? null : band(v <= g, v <= f));
const TONE_WORD: Record<Tone, string> = { success: 'On target', warning: 'Watch', error: 'Off target', neutral: '' };

const VERDICT_WORD: Record<Verdict, string> = { strong: 'Strong', solid: 'Solid', watch: 'Watch', weak: 'Work to do', unknown: '—' };
const VERDICT_TONE: Record<Verdict, Tone> = { strong: 'success', solid: 'success', watch: 'warning', weak: 'error', unknown: 'neutral' };

type Group = 'healthy' | 'efficient' | 'exit';
const GROUPS: Array<{ key: Group; label: string; sub: string }> = [
  { key: 'healthy', label: 'Healthy?', sub: 'Growth + retention' },
  { key: 'efficient', label: 'Efficient?', sub: 'Unit economics' },
  { key: 'exit', label: 'Durable?', sub: 'Long-term staying power' },
];

type Metric = { key: string; label: string; value: string; hint: string; tone: Tone | null; what: string; data: string; target?: string; read?: string };

export default function MAReadinessDS() {
  const { data: ueData, isLoading: ueLoading } = useSheetTab('unit_economics');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: mrrData } = useSheetTab('mrr_by_month');
  const { data: healthData } = useSheetTab('customer_health');
  const { data: baseData } = useSheetTab('customer_base');
  const base = baseData as unknown as CustomerBaseSnap | undefined;
  const ue = ueData as unknown as UnitEconSnap | undefined;
  const wf = wfData as unknown as WaterfallSnap | undefined;
  const mrr = mrrData as unknown as MrrSnap | undefined;
  const health = healthData as unknown as HealthSnap | undefined;
  // Retention reads the ACCRUAL basis (cash overstates churn); falls back to cash if absent.
  const ret = wf?.ttm_accrual ?? wf?.ttm;
  const retentionBasis = wf?.ttm_accrual ? 'accrual (billed)' : 'cash (cleared)';
  // QuickBooks P&L coverage inside the TTM window: every P&L-derived figure is labelled with it.
  const pnlCov = ue?.ttm.pnl_coverage ?? null;
  const pnlThrough = pnlCov?.end ? `P&L through ${monLabel(pnlCov.end)}` : 'P&L pending';
  const pnlSpan = `${monLabel(pnlCov?.start)} – ${monLabel(pnlCov?.end)}, ${pnlCov?.months ?? '—'} mo`;

  const [sheet, setSheet] = useState<{ kind: 'metric'; key: string } | { kind: 'verdict'; key: Group } | null>(null);
  const [showChecklist, setShowChecklist] = useState(true);

  // ---- identical to the classic page's `computed`
  const computed = useMemo(() => {
    if (!ue || !wf || !mrr || !health) return null;
    const asOf = base?.as_of ?? ue.ttm.windowEnd;
    const priorMonth = shiftMonth(asOf, -12);
    const baseNow = base?.by_month.find((r) => r.month === asOf);
    const basePrior = base?.by_month.find((r) => r.month === priorMonth);
    const arrCurrent = base ? base.mrr * 12 : (mrr.rows.find((r) => r.month === asOf)?.mrr_subscription ?? 0) * 12;
    const arrYearAgo = basePrior && baseNow ? basePrior.mrr * 12 : (mrr.rows.find((r) => r.month === priorMonth)?.mrr_subscription ?? 0) * 12;
    const arrBasis = basePrior && baseNow ? 'customer_base (accrual)' : 'mrr_by_month (cash)';
    const arrGrowth = arrYearAgo > 0 ? (arrCurrent - arrYearAgo) / arrYearAgo : null;
    const opMargin = ue.ttm.operating_margin
      ?? (ue.ttm.pnl_total_income && ue.ttm.pnl_total_income > 0 ? ue.ttm.net_op_income / ue.ttm.pnl_total_income : null);
    const rule40 = arrGrowth != null && opMargin != null ? (arrGrowth + opMargin) * 100 : null;

    // Magic Number: accrual waterfall with in-progress months dropped; the quarter is the last 3
    // consecutive months with both QuickBooks S&M and a waterfall row.
    const allWf = wf.monthly_accrual && wf.monthly_accrual.length ? wf.monthly_accrual : wf.monthly;
    const partialMonths = allWf.filter((m) => m.partial).map((m) => m.month);
    const wfRows = allWf.filter((m) => !m.partial);
    const wfByMonth = new Map(wfRows.map((m) => [m.month, m]));
    const ueByMonth = new Map(ue.monthly.map((m) => [m.month, m]));
    const hasSnm = (mo: string) => { const u = ueByMonth.get(mo); return !!u && u.pnl_available !== false && typeof u.snm_expense === 'number'; };
    let magicEnd: string | null = null;
    for (let i = wfRows.length - 1; i >= 0; i--) {
      const mo = wfRows[i].month;
      const q = [shiftMonth(mo, -2), shiftMonth(mo, -1), mo];
      if (q.every((x) => hasSnm(x) && wfByMonth.has(x))) { magicEnd = mo; break; }
    }
    const magicMonths = magicEnd ? [shiftMonth(magicEnd, -2), shiftMonth(magicEnd, -1), magicEnd] : [];
    const magicRows = magicMonths.map((mo) => ({ month: mo, nnm: wfByMonth.get(mo)?.net_new_mrr ?? 0, snm: ueByMonth.get(mo)?.snm_expense ?? 0 }));
    const q_net_new_mrr = magicMonths.reduce((s, mo) => s + (wfByMonth.get(mo)?.net_new_mrr ?? 0), 0);
    const q_snm = magicMonths.reduce((s, mo) => s + (ueByMonth.get(mo)?.snm_expense ?? 0), 0);
    const magicNumber = magicEnd && q_snm > 0 ? (q_net_new_mrr * 4) / q_snm : null;
    const magicWindow = magicEnd ? `${monLabel(magicMonths[0])} – ${monLabel(magicEnd)}` : null;
    return { arrCurrent, arrYearAgo, arrGrowth, arrBasis, asOf, priorMonth, opMargin, magicWindow, magicRows, partialMonths, rule40, magicNumber, q_net_new_mrr, q_snm };
  }, [ue, wf, mrr, health, base]);

  // ---- the figures each card displays; the tests below read these SAME values
  const fig = useMemo(() => {
    if (!ue || !ret || !health || !computed) return null;
    return {
      arr: computed.arrCurrent,
      growth: computed.arrGrowth,
      nrr: ret.annual_nrr,
      grr: ret.annual_grr,
      logoChurn: ue.ttm.annual_logo_churn_rate ?? ue.ttm.annual_churn_rate,
      revChurn: ue.ttm.annual_revenue_churn_rate ?? ret.annual_gross_churn_rate,
      rule40: computed.rule40,
      opMargin: computed.opMargin,
      ltvCac: ue.ttm.ltv_cac_ratio,
      payback: ue.ttm.cac_payback_months,
      gm: ue.ttm.gross_margin,
      top10: health.concentration.top10.pct,
      magic: computed.magicNumber,
    };
  }, [ue, ret, health, computed]);

  // ---- tests: the classic page's thresholds and null fallbacks, unchanged
  const tests = useMemo(() => {
    if (!fig) return [];
    const t = (key: string, label: string, measured: string, pass: boolean, groups: Group[], metric: string) => ({ key, label, measured, pass, groups, metric });
    return [
      t('growth', 'ARR growth ≥ 15%', pctSigned(fig.growth), (fig.growth ?? 0) >= 0.15, ['healthy'], 'growth'),
      t('nrr', 'NRR ≥ 100%', pct(fig.nrr), (fig.nrr ?? 0) >= 1, ['healthy', 'exit'], 'nrr'),
      t('grr', 'GRR ≥ 80%', pct(fig.grr), (fig.grr ?? 0) >= 0.8, ['healthy'], 'grr'),
      t('revchurn', 'Annual revenue churn ≤ 10%', pct(fig.revChurn), (fig.revChurn ?? 1) <= 0.1, ['healthy', 'exit'], 'revChurn'),
      t('top10', 'Top-10 concentration ≤ 30%', pct(fig.top10), (fig.top10 ?? 1) <= 0.3, ['healthy', 'exit'], 'top10'),
      t('ltvcac', 'LTV:CAC ≥ 3', ratio(fig.ltvCac), (fig.ltvCac ?? 0) >= 3, ['efficient', 'exit'], 'ltvCac'),
      t('payback', 'CAC payback ≤ 18 months', monthsTxt(fig.payback), (fig.payback ?? 99) <= 18, ['efficient'], 'payback'),
      t('gm', 'Gross margin ≥ 70%', pct(fig.gm), (fig.gm ?? 0) >= 0.7, ['efficient'], 'gm'),
      t('opm', 'Operating margin ≥ 0%', pct(fig.opMargin), (fig.opMargin ?? -1) >= 0, ['efficient'], 'rule40'),
      t('rule40', 'Rule of 40 ≥ 40', fig.rule40 != null ? fig.rule40.toFixed(1) : '—', (fig.rule40 ?? 0) >= 40, ['efficient', 'exit'], 'rule40'),
      t('arr', 'ARR ≥ $2M', USD_COMPACT.format(fig.arr), fig.arr >= 2_000_000, ['exit'], 'arr'),
    ];
  }, [fig]);

  const verdicts = useMemo(() => {
    const out = {} as Record<Group, { score: number; total: number; verdict: Verdict; tests: typeof tests }>;
    for (const g of GROUPS) {
      const list = tests.filter((x) => x.groups.includes(g.key));
      const score = list.filter((x) => x.pass).length, total = list.length;
      const r = total > 0 ? score / total : 0;
      const verdict: Verdict = !fig ? 'unknown' : r >= 0.8 ? 'strong' : r >= 0.6 ? 'solid' : r >= 0.4 ? 'watch' : 'weak';
      out[g.key] = { score, total, verdict, tests: list };
    }
    return out;
  }, [tests, fig]);

  // ---- headline metrics (classic cards, same values, hints and explanations)
  const metrics: Metric[] = useMemo(() => {
    if (!fig || !computed || !ue) return [];
    return [
      { key: 'arr', label: 'Subscription ARR', value: USD_COMPACT.format(fig.arr), hint: `Canonical MRR × 12 · ${monLabel(computed.asOf)}`, tone: null,
        what: 'Current subscription run-rate annualized.', data: 'customer_base MRR (invoiced, accrual basis: the canonical MRR every page shows, including annual payers at amortized MRR) × 12.' },
      { key: 'growth', label: 'YoY ARR growth', value: pctSigned(fig.growth), hint: `from ${USD_COMPACT.format(computed.arrYearAgo)} (${monLabel(computed.priorMonth)})`, tone: hi(fig.growth, 0.30, 0.10),
        what: 'Subscription ARR growth year over year.',
        data: `(Current ARR − Year-ago ARR) ÷ Year-ago ARR. Both ends are point-in-time canonical MRR × 12 from customer_base.by_month (same basis as Subscription ARR)${computed.arrBasis !== 'customer_base (accrual)' ? '; falling back to cash mrr_by_month because the canonical series does not reach back 12 months' : ''}.`,
        target: '≥ 15% healthy · ≥ 30% strong' },
      { key: 'nrr', label: 'NRR (annual)', value: pct(fig.nrr), hint: `Target ≥ 110% · ${retentionBasis}`, tone: hi(fig.nrr, 1.1, 1),
        what: 'Net Revenue Retention: of every $1 existing customers paid a year ago, how much they pay now (including expansion, excluding new logos).',
        data: 'Accrual MRR waterfall, trailing 12 months: every lost dollar (churn, contraction, voided, delinquent, paused) counts, recovered lapses are credited back, expansion added; mean monthly rate compounded ^12.',
        target: '≥ 100% good · ≥ 110% top quartile' },
      { key: 'grr', label: 'GRR (annual)', value: pct(fig.grr), hint: 'Target ≥ 90%', tone: hi(fig.grr, 0.9, 0.8),
        what: 'Gross Revenue Retention: like NRR but without expansion credit. The retention ceiling.',
        data: '(Starting − Churn − Contraction − Voided − Delinquent − Paused + Recovered) ÷ Starting, from the accrual MRR waterfall; mean monthly rate over the trailing 12 months, compounded ^12.',
        target: '≥ 90% top quartile' },
      { key: 'logoChurn', label: 'Annual logo churn', value: pct(fig.logoChurn), hint: 'Confirmed churns only', tone: lo(fig.logoChurn, 0.10, 0.20),
        what: 'Share of customers who confirmed-churned in the trailing 12 months (excludes delinquency, pauses and annual-payer gaps, which are tracked separately).',
        data: 'Lost logos (churned + lapsed) from the canonical logo flow (customer_base.logo_flow) ÷ starting logos, summed over the trailing 12 months and annualized. Paused customers are not churn.',
        target: '≤ 10% excellent · ≤ 20% acceptable' },
      { key: 'revChurn', label: 'Annual revenue churn', value: pct(fig.revChurn), hint: '1 − accrual TTM GRR', tone: lo(fig.revChurn, 0.10, 0.20),
        what: 'Share of MRR lost to churn in the trailing 12 months (gross, before expansion). The dollar-weighted retention signal a buyer weighs most.',
        data: '1 − annual GRR from the accrual MRR waterfall: every lost dollar counts (churn, contraction, voided, delinquent, paused), recovered lapses credited back; mean monthly rate over the trailing 12 months, compounded ^12.',
        read: 'Logo churn counts customers lost; revenue churn weights them by MRR and also includes downgrades, so the two can move independently. Compare them to see whether losses skew toward small or large accounts.' },
      { key: 'rule40', label: 'Rule of 40', value: fig.rule40 != null ? fig.rule40.toFixed(0) : '—', hint: `Growth % + Op margin % · ${pnlThrough}`, tone: hi(fig.rule40, 40, 20),
        what: 'Growth rate + operating margin. The benchmark for efficient growth in SaaS.',
        data: `YoY ARR growth % + operating margin (QuickBooks Net Operating Income ÷ QuickBooks Total Income over the same P&L-covered months, ${pnlSpan}).`, target: '≥ 40' },
      { key: 'magic', label: 'Magic Number', value: ratio(fig.magic), hint: `Quarter ${computed.magicWindow ?? 'N/A'} · ${pnlThrough}`, tone: hi(fig.magic, 1, 0.75),
        what: 'Sales and marketing efficiency in a single number: net new ARR added per dollar of S&M.',
        data: 'Net new MRR over the latest complete quarter that QuickBooks S&M covers × 4 (annualized) ÷ S&M spend over the same 3 months. Net new MRR = New + Reactivated + Recovered + Expansion − Contraction − Churn − Voided − Delinquent − Paused from the accrual waterfall (in-progress months excluded). S&M = Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission from QuickBooks.',
        target: '≥ 0.75 (spend more) · ≥ 1.0 excellent (self-funded growth) · below 0.5 usually triggers S&M cuts' },
      { key: 'ltvCac', label: 'LTV : CAC', value: ratio(fig.ltvCac), hint: `Target ≥ 3x · ${pnlThrough}`, tone: hi(fig.ltvCac, 3, 1),
        what: 'Lifetime value of a customer relative to the cost to acquire one.',
        data: 'LTV (avg MRR × subscription gross margin ÷ monthly gross revenue churn, i.e. 1 − accrual TTM GRR) ÷ CAC (TTM S&M ÷ TTM new logos).', target: '≥ 3x · ≥ 5x best in class' },
      { key: 'payback', label: 'CAC payback', value: monthsTxt(fig.payback), hint: `Good ≤ 12 mo · ${pnlThrough}`, tone: lo(fig.payback, 12, 18),
        what: 'Months of gross profit to recover CAC on a new customer.', data: 'CAC ÷ (avg MRR × subscription gross margin).', target: '≤ 12 mo good · 12–18 caution' },
      { key: 'gm', label: 'Gross margin', value: pct(fig.gm), hint: `Target ≥ 70% · ${pnlThrough}`, tone: hi(fig.gm, 0.75, 0.60),
        what: 'TTM blended gross margin.', data: `(Total Income − Total COGS) ÷ Total Income from QuickBooks, summed across the P&L-covered months of the TTM window (${pnlSpan}).`, target: '≥ 70% · ≥ 75% top-quartile SaaS' },
      { key: 'top10', label: 'Top 10 concentration', value: pct(fig.top10), hint: 'Target ≤ 25%', tone: lo(fig.top10, 0.25, 0.40),
        what: 'Share of subscription MRR from the top 10 customers: the concentration-risk number a buyer asks about first.',
        data: 'Sum of top-10 current MRR ÷ total subscription MRR from the Customer Health snapshot.', target: '≤ 25% low risk · > 40% concerning' },
    ];
  }, [fig, computed, ue, retentionBasis, pnlThrough, pnlSpan]);
  const metricOf = (k: string) => metrics.find((m) => m.key === k);

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
  const CHECK: Record<'ok' | 'partial' | 'gap', { word: string; tone: Tone; rank: number }> = {
    gap: { word: 'Needs work', tone: 'error', rank: 0 }, partial: { word: 'Partial', tone: 'warning', rank: 1 }, ok: { word: 'In place', tone: 'success', rank: 2 },
  };
  const counts = { ok: checklist.filter((c) => c.status === 'ok').length, partial: checklist.filter((c) => c.status === 'partial').length, gap: checklist.filter((c) => c.status === 'gap').length };

  const exportCsv = () => downloadCsv(`ma_scorecard_${ue?.ttm.windowEnd ?? ''}`, ['Section', 'Item', 'Value', 'Status', 'Note'], [
    ...GROUPS.map((g) => ['Verdict', g.label, `${verdicts[g.key].score}/${verdicts[g.key].total}`, VERDICT_WORD[verdicts[g.key].verdict], g.sub]),
    ...tests.map((t) => ['Test', t.label, t.measured, t.pass ? 'Pass' : 'Fail', t.groups.map((g) => GROUPS.find((x) => x.key === g)!.label).join(' ')]),
    ...metrics.map((m) => ['Metric', m.label, m.value, m.tone ? TONE_WORD[m.tone] : '', m.hint]),
    ...checklist.map((c) => ['Checklist', `${c.category}: ${c.label}`, '', CHECK[c.status].word, c.note ?? '']),
  ]);

  const subtitle = ue ? `Healthy, efficient, durable: the one-pager leadership runs against · ${ue.ttm.windowStart} – ${ue.ttm.windowEnd} TTM · QuickBooks figures ${pnlThrough}` : 'Loading…';

  if (ueLoading || !computed || !fig) {
    return <DsPage path="/scorecard" title="M&A Scorecard" subtitle="Loading…"><p className="am-card__text">Loading the scorecard…</p></DsPage>;
  }

  const groupTag = (gs: Group[]) => (
    <span className="am-row am-row--tight">{gs.map((g) => <span key={g} className="am-tag am-tag--neutral">{GROUPS.find((x) => x.key === g)!.label.replace('?', '')}</span>)}</span>
  );
  const passTag = (pass: boolean) => <span className={`am-tag am-tag--${pass ? 'success' : 'error'}`}>{pass ? 'Pass' : 'Fail'}</span>;

  // side sheet content
  const sheetMetric = sheet?.kind === 'metric' ? metricOf(sheet.key) : undefined;
  const sheetVerdict = sheet?.kind === 'verdict' ? GROUPS.find((g) => g.key === sheet.key) : undefined;

  const partialNote = computed.partialMonths.length ? ` · ${computed.partialMonths.map((m) => `${mlabel(m)} (in progress)`).join(', ')} excluded` : '';

  return (
    <DsPage path="/scorecard" title="M&A Scorecard" subtitle={subtitle}
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv}><Icon name="download" />Download CSV</button>}
      overlays={
        <SideSheet open={!!sheet} onClose={() => setSheet(null)}
          title={sheetMetric ? sheetMetric.label : sheetVerdict ? `${sheetVerdict.label} ${verdicts[sheetVerdict.key].score}/${verdicts[sheetVerdict.key].total} · ${VERDICT_WORD[verdicts[sheetVerdict.key].verdict]}` : ''}
          text={sheetMetric ? `${sheetMetric.value} · ${sheetMetric.hint}` : sheetVerdict ? `${sheetVerdict.sub}. Strong at 80% of tests passed, Solid at 60%, Watch at 40%, otherwise Work to do.` : undefined}>
          {sheetMetric && <>
            {sheetMetric.tone && <div className="am-row"><span className={`am-tag am-tag--${sheetMetric.tone}`}>{TONE_WORD[sheetMetric.tone]}</span></div>}
            <p className="am-card__text"><b>What it is.</b> {sheetMetric.what}</p>
            <p className="am-card__text"><b>Data.</b> {sheetMetric.data}</p>
            {sheetMetric.target && <p className="am-card__text"><b>Target.</b> {sheetMetric.target}</p>}
            {sheetMetric.read && <p className="am-card__text"><b>Reading it with logo churn.</b> {sheetMetric.read}</p>}
            {tests.some((t) => t.metric === sheetMetric.key) && (
              <DataTable label="Tests that read this figure" cols={[['Test', false], ['Measured', true], ['Result', false]]}
                rows={tests.filter((t) => t.metric === sheetMetric.key).map((t) => [t.label, t.measured, passTag(t.pass)])} />
            )}
          </>}
          {sheetVerdict && (
            <DataTable label={`${sheetVerdict.label} tests`} cols={[['Test', false], ['Measured', true], ['Result', false]]}
              rows={verdicts[sheetVerdict.key].tests.map((t) => [t.label, t.measured, passTag(t.pass)])}
              foot={['Passed', '', `${verdicts[sheetVerdict.key].score} of ${verdicts[sheetVerdict.key].total}`]} />
          )}
        </SideSheet>
      }>

      {/* 1. The three verdicts */}
      <KpiGrid max={3}>
        {GROUPS.map((g) => {
          const v = verdicts[g.key];
          const failing = v.tests.filter((t) => !t.pass).map((t) => t.label);
          return (
            <KpiCard key={g.key} label={`${g.label} · ${g.sub}`} value={`${v.score}/${v.total}`}
              hint={failing.length ? `Failing: ${failing.join(' · ')}` : 'Every test passes'}
              tag={VERDICT_WORD[v.verdict]} tagTone={VERDICT_TONE[v.verdict]} onOpen={() => setSheet({ kind: 'verdict', key: g.key })} />
          );
        })}
      </KpiGrid>

      {/* 2. Every test behind the verdicts, failing first */}
      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Tests behind the verdicts · {tests.filter((t) => !t.pass).length} of {tests.length} failing</span>
          <span className="am-chart__caption">Each test reads the same figure its headline card shows. Select a measured figure to see how it is calculated.</span>
        </div>
        <DataTable label="Scorecard tests"
          cols={[['Test', false], ['Measured', true], ['Result', false], ['Counts toward', false]]}
          rows={tests.map((t) => [t.label, t.measured, passTag(t.pass), groupTag(t.groups)])}
          sortValues={tests.map((t) => [t.label, t.measured, t.pass ? 1 : 0, t.groups.join(',')])}
          defaultSort={{ col: 2, dir: 'asc' }}
          clickable={(c) => c === 1} onCell={(row) => setSheet({ kind: 'metric', key: tests[row].metric })} />
      </section>

      {/* 3. Headline metrics */}
      <div className="am-chart__head">
        <span className="am-chart__title">Growth and retention</span>
        <span className="am-chart__caption">{ue!.ttm.windowStart} – {ue!.ttm.windowEnd} TTM · retention on the {retentionBasis} basis · select a card for its definition</span>
      </div>
      <KpiGrid>
        {['arr', 'growth', 'nrr', 'grr', 'logoChurn', 'revChurn'].map((k) => { const m = metricOf(k)!; return (
          <KpiCard key={k} label={m.label} value={m.value} hint={m.hint} tag={m.tone ? TONE_WORD[m.tone] : undefined} tagTone={m.tone ?? undefined} onOpen={() => setSheet({ kind: 'metric', key: k })} />
        ); })}
      </KpiGrid>
      <div className="am-chart__head">
        <span className="am-chart__title">Efficiency and risk</span>
        <span className="am-chart__caption">QuickBooks figures {pnlThrough} ({pnlSpan} of the TTM window)</span>
      </div>
      <KpiGrid>
        {['rule40', 'magic', 'ltvCac', 'payback', 'gm', 'top10'].map((k) => { const m = metricOf(k)!; return (
          <KpiCard key={k} label={m.label} value={m.value} hint={m.hint} tag={m.tone ? TONE_WORD[m.tone] : undefined} tagTone={m.tone ?? undefined} onOpen={() => setSheet({ kind: 'metric', key: k })} />
        ); })}
      </KpiGrid>

      {/* 4. Workings */}
      <div className="am-grid" style={{ ['--am-grid-min' as string]: 'max(420px, calc((100% - var(--am-space-block)) / 2))' }}>
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Rule of 40 breakdown</span>
            <span className="am-chart__caption">YoY ARR growth (canonical MRR × 12 vs 12 months prior) + operating margin (QuickBooks, {pnlThrough})</span>
          </div>
          <DataTable label="Rule of 40 breakdown" cols={[['Component', false], ['Value', true], ['Status', false]]}
            rows={[
              ['ARR growth rate (YoY)', pctSigned(computed.arrGrowth), hi(computed.arrGrowth, 0.30, 0.10) ? <span key="t" className={`am-tag am-tag--${hi(computed.arrGrowth, 0.30, 0.10)}`}>{TONE_WORD[hi(computed.arrGrowth, 0.30, 0.10)!]}</span> : ''],
              [<span key="l">+ Operating margin ({pnlSpan} P&L)</span>, pct(computed.opMargin), hi(computed.opMargin, 0.15, 0) ? <span key="t" className={`am-tag am-tag--${hi(computed.opMargin, 0.15, 0)}`}>{TONE_WORD[hi(computed.opMargin, 0.15, 0)!]}</span> : ''],
            ]}
            foot={['Rule of 40 score', computed.rule40 != null ? computed.rule40.toFixed(1) : '—', hi(computed.rule40, 40, 20) ? <span key="t" className={`am-tag am-tag--${hi(computed.rule40, 40, 20)}`}>{TONE_WORD[hi(computed.rule40, 40, 20)!]}</span> : '']} />
          <p className="am-card__text">Target ≥ 40. Above 40 signals efficient growth; below suggests the business is either growing too slowly for its spend or burning more than its growth justifies.</p>
        </section>
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Magic Number (trailing quarter){computed.magicWindow ? ` · ${computed.magicWindow}` : ''}</span>
            <span className="am-chart__caption">Latest complete quarter QuickBooks S&M covers · {pnlThrough}{partialNote}</span>
          </div>
          {!computed.magicWindow && <p className="am-card__text">N/A: no complete quarter with QuickBooks S&M ({pnlThrough}).</p>}
          <DataTable label="Magic Number quarter" cols={[['Month', false], ['Net new MRR', true], ['S&M spend', true]]}
            rows={computed.magicRows.map((r) => [mlabel(r.month), usd(r.nnm), usd(r.snm)])}
            foot={[`Quarter (${computed.magicWindow ?? 'N/A'})`, usd(computed.q_net_new_mrr), usd(computed.q_snm)]} />
          <DataTable label="Magic Number" cols={[['Step', false], ['Value', true], ['Status', false]]}
            rows={[
              ['Annualized net new MRR (×4)', usd(computed.q_net_new_mrr * 4), ''],
              ['÷ S&M spend', usd(computed.q_snm), ''],
            ]}
            foot={['Magic Number', ratio(computed.magicNumber), hi(computed.magicNumber, 1, 0.75) ? <span key="t" className={`am-tag am-tag--${hi(computed.magicNumber, 1, 0.75)}`}>{TONE_WORD[hi(computed.magicNumber, 1, 0.75)!]}</span> : '']} />
          <p className="am-card__text">Target ≥ 0.75 (spend more); ≥ 1.0 is excellent (self-funded growth). Below 0.5 usually triggers S&M cuts.</p>
        </section>
      </div>

      {/* 5. Diligence checklist */}
      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Diligence readiness checklist</span>
            <span className="am-chart__caption">The data and operating records a well-run business keeps on hand: what this dashboard already covers and what still needs producing elsewhere</span>
          </div>
          <button className="am-btn am-btn--text" onClick={() => setShowChecklist(!showChecklist)}>{showChecklist ? 'Hide' : 'Show'} checklist</button>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-tag am-tag--success">{counts.ok} in place</span>
          <span className="am-tag am-tag--warning">{counts.partial} partial</span>
          <span className="am-tag am-tag--error">{counts.gap} needs work</span>
        </div>
        {showChecklist && (
          <DataTable label="Diligence readiness checklist" cols={[['Category', false], ['Item', false], ['Status', false], ['Note', false]]}
            rows={checklist.map((c) => [c.category, c.label, <span key="s" className={`am-tag am-tag--${CHECK[c.status].tone}`}>{CHECK[c.status].word}</span>, c.note ? <span key="n" title={c.note}>{c.note}</span> : ''])}
            sortValues={checklist.map((c) => [c.category, c.label, CHECK[c.status].rank, c.note ?? ''])} />
        )}
      </section>
    </DsPage>
  );
}
