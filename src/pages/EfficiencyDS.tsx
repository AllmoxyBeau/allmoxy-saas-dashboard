/**
 * Efficiency on the Allmoxy design system. Data logic is the classic page's (Efficiency.tsx, kept
 * at /efficiency-classic), ported verbatim: same three snapshots (unit_economics, mrr_waterfall,
 * mrr_by_month), the in-progress month dropped, accrual waterfall preferred over cash, P&L windows
 * that touch an uncovered month return blank rather than $0, and the same rounding.
 *
 * Cards: Rule of 40 and Burn Multiple anchor at the last month whose trailing 12 months are fully
 * covered by the QuickBooks P&L; Magic Number at the last quarter with S&M for every month; Quick
 * Ratio and Annual NRR come straight from the waterfall's ttm_accrual. Each card opens its method.
 * Trend charts are column charts; values below zero are drawn in the loss tone.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, SideSheet,
  downloadCsv, mlabel, useMonthRange, type ColumnSeries,
} from '../design-system/parts';

type UnitEconMonthly = {
  month: string;
  subscription_revenue: number;
  total_income: number;
  snm_expense: number | null;
  gross_margin: number | null;
  net_op_income: number | null;
  cac: number | null;
  pnl_available?: boolean;
  qb_total_income?: number | null;
};
type UnitEconSnap = { monthly: UnitEconMonthly[] };

type WaterfallMonthly = {
  month: string;
  partial?: boolean;
  net_new_mrr: number;
  quick_ratio: number | null;
  nrr_monthly: number | null;
  grr_monthly: number | null;
  gross_churn_rate_monthly: number | null;
};
type WaterfallTtm = { windowStart: string; windowEnd: string; annual_nrr: number | null; annual_grr: number | null; quick_ratio: number | null };
type WaterfallSnap = { monthly: WaterfallMonthly[]; monthly_accrual?: WaterfallMonthly[]; ttm_accrual?: WaterfallTtm };
type MrrSnap = { rows: Array<{ month: string; mrr_subscription: number | null }> };

type Point = {
  month: string; pnlComplete: boolean;
  arrGrowth: number | null; rule40: number | null; magic: number | null; quickRatio: number | null;
  grossMargin: number | null; annualNRR: number | null; annualGRR: number | null; burnMultiple: number | null; opMargin: number | null;
};

function addMonths(iso: string, delta: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const ratio = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}x`);
const pctNum = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`);
type Tone = 'success' | 'warning' | 'error';
const band = (v: number | null | undefined, good: number, ok: number): { tag?: string; tone?: Tone } =>
  v == null ? {} : v >= good ? { tag: 'On target', tone: 'success' } : v >= ok ? { tag: 'Watch', tone: 'warning' } : { tag: 'Below target', tone: 'error' };

const LIMIT = 24;

export default function EfficiencyDS() {
  const { data: ueData, isLoading, error } = useSheetTab('unit_economics');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: mrrData } = useSheetTab('mrr_by_month');
  const ue = ueData as unknown as UnitEconSnap | undefined;
  const wf = wfData as unknown as WaterfallSnap | undefined;
  const mrr = mrrData as unknown as MrrSnap | undefined;
  const [help, setHelp] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // ---- classic logic, verbatim (Efficiency.tsx `series`)
  const series: Point[] = useMemo(() => {
    if (!ue || !wf || !mrr) return [];
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const completeUeMonthly = ue.monthly.filter((m) => m.month < currentMonth);
    const ueByMonth = new Map(completeUeMonthly.map((m) => [m.month, m]));
    const wfByMonth = new Map(wf.monthly.filter((m) => !m.partial).map((m) => [m.month, m]));
    for (const m of wf.monthly_accrual ?? []) if (!m.partial) wfByMonth.set(m.month, m);
    const pnlOk = (m: UnitEconMonthly | undefined, k: keyof UnitEconMonthly) =>
      !!m && m.pnl_available !== false && typeof m[k] === 'number';
    const mrrByMonth = new Map(mrr.rows.map((r) => [r.month, r]));
    const months = completeUeMonthly.map((m) => m.month);

    function sumWindow<K extends keyof UnitEconMonthly>(endMonth: string, k: K, windowMonths: number): number | null {
      const endIdx = months.indexOf(endMonth);
      if (endIdx < windowMonths - 1) return null;
      let total = 0;
      for (let i = endIdx - windowMonths + 1; i <= endIdx; i++) {
        const u = ueByMonth.get(months[i]);
        if (!pnlOk(u, k)) return null;
        total += u![k] as number;
      }
      return total;
    }
    function sumWfWindow<K extends keyof WaterfallMonthly>(endMonth: string, k: K, windowMonths: number): number | null {
      const endIdx = months.indexOf(endMonth);
      if (endIdx < windowMonths - 1) return null;
      let total = 0;
      for (let i = endIdx - windowMonths + 1; i <= endIdx; i++) {
        const v = wfByMonth.get(months[i])?.[k];
        if (typeof v !== 'number') return null;
        total += v;
      }
      return total;
    }

    return months.map((month) => {
      const u = ueByMonth.get(month);
      const w = wfByMonth.get(month);
      const curMrr = mrrByMonth.get(month)?.mrr_subscription ?? null;
      const priorMrr = mrrByMonth.get(addMonths(month, -12))?.mrr_subscription ?? null;
      const arrGrowth = curMrr != null && priorMrr != null && priorMrr > 0 ? (curMrr - priorMrr) / priorMrr : null;

      const ttmNetOp = sumWindow(month, 'net_op_income', 12);
      const ttmTotal = ue.monthly.some((r) => r.qb_total_income != null)
        ? sumWindow(month, 'qb_total_income', 12)
        : sumWindow(month, 'total_income', 12);
      const opMargin = ttmNetOp != null && ttmTotal != null && ttmTotal > 0 ? ttmNetOp / ttmTotal : null;
      const rule40 = arrGrowth != null && opMargin != null ? (arrGrowth + opMargin) * 100 : null;

      const q_net_new = sumWfWindow(month, 'net_new_mrr', 3);
      const q_snm = sumWindow(month, 'snm_expense', 3);
      const magic = q_net_new != null && q_snm != null && q_snm > 0 ? (q_net_new * 4) / q_snm : null;

      const pnlComplete = ttmNetOp != null && ttmTotal != null;
      const burn = ttmNetOp != null && ttmNetOp < 0 ? -ttmNetOp : 0;
      const ttmNetNewMrr = sumWfWindow(month, 'net_new_mrr', 12);
      const burnMultiple = burn > 0 && ttmNetNewMrr != null && ttmNetNewMrr > 0 ? burn / ttmNetNewMrr : null;

      function trailingMeanPow(k: 'nrr_monthly' | 'grr_monthly'): number | null {
        const endIdx = months.indexOf(month);
        if (endIdx < 11) return null;
        let sum = 0;
        for (let i = endIdx - 11; i <= endIdx; i++) {
          const v = wfByMonth.get(months[i])?.[k];
          if (typeof v !== 'number') return null;
          sum += v;
        }
        return Math.pow(sum / 12, 12);
      }
      const annualNRR = trailingMeanPow('nrr_monthly');
      const annualGRR = trailingMeanPow('grr_monthly');

      return {
        month,
        pnlComplete,
        arrGrowth: arrGrowth != null ? Math.round(arrGrowth * 1000) / 10 : null,
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
  }, [ue, wf, mrr]);

  const pnlAnchor = useMemo(() => {
    for (let i = series.length - 1; i >= 0; i--) if (series[i].pnlComplete) return series[i];
    return undefined;
  }, [series]);
  const magicAnchor = useMemo(() => {
    for (let i = series.length - 1; i >= 0; i--) if (series[i].magic != null) return series[i];
    return undefined;
  }, [series]);
  const pnlThrough = pnlAnchor ? `P&L through ${mlabel(pnlAnchor.month)}` : 'P&L pending';
  const ttmAcc = wf?.ttm_accrual;
  const ttmLabel = ttmAcc ? `${mlabel(ttmAcc.windowStart)} to ${mlabel(ttmAcc.windowEnd)}` : '';
  const lastComplete = series.length ? series[series.length - 1].month : null;

  const range = useMonthRange(series.map((p) => p.month));
  const byMonth = useMemo(() => new Map(series.map((p) => [p.month, p])), [series]);
  const visible = range.months.map((m) => byMonth.get(m)!).filter(Boolean);

  // ---- methodology, the classic page's info text, opened from each card and chart
  const HELP: Record<string, { title: string; body: ReactNode }> = {
    rule40: { title: 'Rule of 40', body: <>
      <p className="am-card__text"><b>What it is.</b> SaaS efficiency benchmark: growth rate % plus operating margin %. Above 40 signals efficient growth; below suggests over-spending or under-growing.</p>
      <p className="am-card__text"><b>Data.</b> ARR growth year over year (current subscription MRR × 12 against 12 months prior) plus trailing-12-month operating margin (Net Operating Income ÷ Total Income from the QuickBooks P&L). Both sides use the same 12 months, anchored at the last month the QuickBooks P&L covers{pnlAnchor ? ` (${mlabel(pnlAnchor.month)})` : ''}. Months after that are not counted as $0. On the trend chart, months whose 12-month window reaches past the last P&L month are blank.</p>
      <p className="am-card__text"><b>Target.</b> 40 or more.</p></> },
    magic: { title: 'Magic Number', body: <>
      <p className="am-card__text"><b>What it is.</b> Sales and marketing efficiency: how much net new ARR each dollar of S&M produces. Watching it over time shows whether acquisition cost is scaling or compressing.</p>
      <p className="am-card__text"><b>Data.</b> Trailing-quarter net new MRR (New + Reactivated + Recovered + Expansion − Contraction − Churn − Voided − Lapsed − Paused, from the accrual MRR waterfall where available, cash waterfall for earlier history) × 4, divided by trailing-quarter S&M spend (QuickBooks: Marketing Payroll + Marketing & Advertising + Sales Expenses + Sales Commission). The card shows the latest quarter where every month has QuickBooks S&M; the chart is blank where any S&M month is not yet in the P&L.</p>
      <p className="am-card__text"><b>Target.</b> 0.75 or more means spend more; 1.0 or more is self-funded growth; under 0.5 usually triggers S&M cuts.</p></> },
    quick: { title: 'Quick Ratio', body: <>
      <p className="am-card__text"><b>What it is.</b> Growth durability: dollars of MRR added divided by dollars lost. A high ratio means growth comes from new business, not just offsetting churn. On the monthly chart, spikes are great months; a sustained decline means churn and contraction are outpacing new business.</p>
      <p className="am-card__text"><b>Data.</b> (New + Reactivated + Recovered + Expansion MRR) ÷ (Contraction + Churn + Voided + Lapsed + Paused MRR). The card sums the trailing 12 months of the accrual MRR waterfall ({ttmLabel}). The chart shows each month: accrual waterfall where available, cash waterfall for earlier history. Months in progress are excluded.</p>
      <p className="am-card__text"><b>Target.</b> 4x or more is healthy; under 2x is a warning sign.</p></> },
    nrr: { title: 'Annual NRR', body: <>
      <p className="am-card__text"><b>What it is.</b> Net Revenue Retention: of every $1 of MRR at the start of the period, how much remains from the same customers at the end, including expansion and minus contraction and churn. Over 100% means existing customers grow on net.</p>
      <p className="am-card__text"><b>Data.</b> Monthly NRR = (Starting MRR + Expansion + Recovered − Contraction − Churn − Voided − Lapsed − Paused) ÷ Starting MRR, from the accrual MRR waterfall. Annualized as the mean of the trailing 12 monthly rates, compounded to the 12th power. The card is the waterfall's trailing-12-month accrual figure ({ttmLabel}); each point on the chart uses the same method (accrual where available, cash for earlier history).</p>
      <p className="am-card__text"><b>Target.</b> 100% or more is good; 110% or more is top-quartile SaaS.</p></> },
    burn: { title: 'Burn Multiple', body: <>
      <p className="am-card__text"><b>What it is.</b> Cash efficiency: how many dollars are burned to add a dollar of ARR. "N/A" means the business is operating profitably, so there is no burn.</p>
      <p className="am-card__text"><b>Data.</b> |Trailing-12-month operating loss| ÷ trailing-12-month net new MRR, anchored at the last month the QuickBooks P&L covers{pnlAnchor ? ` (${mlabel(pnlAnchor.month)})` : ''}. If trailing net operating income is positive there is no burn to divide, and the card shows N/A.</p>
      <p className="am-card__text"><b>Target.</b> Under 1x is strong; 1 to 2x is decent; over 2x is inefficient.</p></> },
    arr: { title: 'ARR growth, year over year', body: <>
      <p className="am-card__text"><b>What it is.</b> Year-over-year subscription ARR growth rate, the growth input to Rule of 40.</p>
      <p className="am-card__text"><b>Data.</b> For each month M, (MRR[M] × 12) ÷ (MRR[M−12] × 12) − 1, using point-in-time subscription MRR from the MRR by Month tab. Same method as the Scorecard page.</p>
      <p className="am-card__text"><b>Target.</b> 15% or more is healthy; 30% or more is strong.</p></> },
    gm: { title: 'Gross margin', body: <>
      <p className="am-card__text"><b>What it is.</b> Revenue after direct cost of revenue, as a share of revenue. The higher and steadier, the more the business looks like real SaaS.</p>
      <p className="am-card__text"><b>Data.</b> Gross Profit ÷ Total Income per month, from the QuickBooks P&L. Cost of revenue includes 5000 Credit Card Acceptance Fees, 5200 Sales Commission, 5300 Services Commissions and 5400 Affiliate Commissions.</p>
      <p className="am-card__text"><b>Target.</b> 70% or more; 75% or more is top-quartile SaaS.</p></> },
  };

  const r40 = band(pnlAnchor?.rule40, 40, 20);
  const mg = band(magicAnchor?.magic, 1, 0.75);
  const qr = band(ttmAcc?.quick_ratio, 4, 2);
  const nrr = band(ttmAcc?.annual_nrr, 1.1, 1);
  const bm = pnlAnchor?.burnMultiple;
  const burnTag: { tag?: string; tone?: Tone } = !pnlAnchor ? {} : bm == null ? { tag: 'No burn', tone: 'success' } : bm < 1 ? { tag: 'On target', tone: 'success' } : bm < 2 ? { tag: 'Watch', tone: 'warning' } : { tag: 'Below target', tone: 'error' };

  // ---- trend charts: one column per month; values below zero take the loss tone.
  type Metric = { key: keyof Point; title: string; tone: string; fmt: (v: number) => string; target: string; help: string; blank: string };
  const METRICS: Metric[] = [
    { key: 'arrGrowth', title: 'ARR growth, year over year', tone: 'div-1', fmt: (v) => `${v.toFixed(1)}%`, target: 'target 15% or more', help: 'arr', blank: 'No MRR 12 months earlier' },
    { key: 'rule40', title: 'Rule of 40 (trailing 12 months)', tone: 'div-2', fmt: (v) => v.toFixed(1), target: 'target 40 or more', help: 'rule40', blank: 'Not yet covered by the QuickBooks P&L' },
    { key: 'magic', title: 'Magic Number (trailing quarter)', tone: 'div-1', fmt: (v) => `${v.toFixed(2)}x`, target: 'target 0.75x or more', help: 'magic', blank: 'S&M not yet in the QuickBooks P&L' },
    { key: 'quickRatio', title: 'Quick Ratio (monthly)', tone: 'div-2', fmt: (v) => `${v.toFixed(2)}x`, target: 'target 4x or more', help: 'quick', blank: 'No losses to divide by, or no data' },
    { key: 'annualNRR', title: 'Annual NRR (trailing-12 mean monthly, compounded)', tone: 'div-1', fmt: (v) => `${v.toFixed(1)}%`, target: 'target 100% or more', help: 'nrr', blank: 'Fewer than 12 months of waterfall' },
    { key: 'grossMargin', title: 'Gross margin (monthly)', tone: 'div-2', fmt: (v) => `${Math.round(v * 100)}%`, target: 'target 75%', help: 'gm', blank: 'Not yet covered by the QuickBooks P&L' },
  ];
  const chartFor = (mt: Metric) => {
    const raw = visible.map((p) => p[mt.key] as number | null);
    const s: ColumnSeries[] = [
      { key: 'pos', label: mt.title, tone: mt.tone, values: raw.map((v) => (v != null && v >= 0 ? v : 0)) },
      { key: 'neg', label: 'Below zero', tone: 'div-5', values: raw.map((v) => (v != null && v < 0 ? v : 0)) },
    ];
    const blanks = raw.filter((v) => v == null).length;
    return (
      <ChartCard key={String(mt.key)} title={mt.title}
        caption={`${mt.target} · hover a column for the exact figure · ${range.rangeText}${blanks ? ` · ${blanks} blank month${blanks === 1 ? '' : 's'}` : ''}`}>
        <div className="am-row">
          <button className="am-btn am-btn--text" onClick={() => setHelp(mt.help)}><Icon name="info" />How it is measured</button>
        </div>
        <ColumnChart months={range.months} series={s} stacked fmt={mt.fmt}
          labelFor={(i) => (raw[i] == null ? null : mt.fmt(raw[i]!))}
          tipRows={(i) => [[mt.title.split(' (')[0], raw[i] == null ? `— (${mt.blank})` : mt.fmt(raw[i]!)]]}
          aria={`${mt.title}, ${range.rangeText}.`} />
      </ChartCard>
    );
  };

  // ---- month-by-month table and CSV (newest first)
  const tableRows = [...visible].reverse();
  const tcols: Array<[string, boolean]> = [['Month', false], ['ARR growth', true], ['Op margin (TTM)', true], ['Rule of 40', true], ['Magic Number', true], ['Quick Ratio', true], ['Annual NRR', true], ['Annual GRR', true], ['Burn multiple', true], ['Gross margin', true]];
  const exportCsv = () => downloadCsv(`efficiency_${range.months[0] ?? ''}_to_${range.months[range.months.length - 1] ?? ''}`,
    ['Month', 'ARR growth %', 'TTM op margin %', 'Rule of 40', 'Magic Number', 'Quick Ratio', 'Annual NRR %', 'Annual GRR %', 'Burn multiple', 'Gross margin'],
    tableRows.map((p) => [p.month, p.arrGrowth ?? '', p.opMargin ?? '', p.rule40 ?? '', p.magic ?? '', p.quickRatio ?? '', p.annualNRR ?? '', p.annualGRR ?? '', p.burnMultiple ?? '', p.grossMargin ?? '']));

  const h = help ? HELP[help] : null;

  return (
    <DsPage
      path="/efficiency"
      title="Efficiency"
      subtitle={`How our operator metrics trend month by month: whether efficiency is improving, flat or eroding. Rule of 40, Magic Number and Burn Multiple are anchored at ${pnlAnchor ? mlabel(pnlAnchor.month) : '…'}, the last month the QuickBooks P&L fully covers; Quick Ratio and Annual NRR use the trailing 12 months of the accrual waterfall${ttmLabel ? ` (${ttmLabel})` : ''}.`}
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!tableRows.length}><Icon name="download" />Export CSV</button>}
      overlays={h && (
        <SideSheet open onClose={() => setHelp(null)} title={h.title}>{h.body}</SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Could not load unit economics: {String(error)}</p> : null}

      {!isLoading && series.length > 0 && (
        <KpiGrid>
          <KpiCard label="Rule of 40" value={pnlAnchor?.rule40 != null ? pnlAnchor.rule40.toFixed(1) : '—'}
            hint={`Growth + operating margin, 12 months to ${pnlAnchor ? mlabel(pnlAnchor.month) : '—'} (last month with full P&L) · target 40`}
            tag={r40.tag} tagTone={r40.tone} onOpen={() => setHelp('rule40')} />
          <KpiCard label="Magic Number" value={ratio(magicAnchor?.magic ?? null)}
            hint={magicAnchor ? `Quarter ending ${mlabel(magicAnchor.month)} · target 0.75x` : 'Trailing quarter · target 0.75x'}
            tag={mg.tag} tagTone={mg.tone} onOpen={() => setHelp('magic')} />
          <KpiCard label="Quick Ratio" value={ratio(ttmAcc?.quick_ratio ?? null)}
            hint={`12 months ${ttmLabel} · accrual · target 4x`}
            tag={qr.tag} tagTone={qr.tone} onOpen={() => setHelp('quick')} />
          <KpiCard label="Annual NRR" value={ttmAcc?.annual_nrr != null ? `${(ttmAcc.annual_nrr * 100).toFixed(1)}%` : '—'}
            hint={`12 months ${ttmLabel} · accrual · target 100%`}
            tag={nrr.tag} tagTone={nrr.tone} onOpen={() => setHelp('nrr')} />
          <KpiCard label="Burn Multiple" value={!pnlAnchor ? '—' : bm != null ? `${bm.toFixed(2)}x` : 'N/A'}
            hint={bm == null ? `Net operating income positive · ${pnlThrough}` : `Burn ÷ net new ARR · under 1x is strong · ${pnlThrough}`}
            tag={burnTag.tag} tagTone={burnTag.tone} onOpen={() => setHelp('burn')} />
        </KpiGrid>
      )}
      <p className="am-card__text">
        Select a card for how it is measured. Every view stops at {lastComplete ? mlabel(lastComplete) : 'the last complete month'}: the month in progress is never counted.
        {pnlAnchor && lastComplete && pnlAnchor.month < lastComplete ? ` The P&L-based figures (Rule of 40, Burn Multiple, Magic Number, gross margin) are blank after ${mlabel(pnlAnchor.month)} until QuickBooks catches up.` : ''}
      </p>

      <div className="am-row am-row--wrap">{range.controls}</div>

      <div className="am-grid" style={{ ['--am-grid-min' as string]: '900px' }}>
        {METRICS.map(chartFor)}
      </div>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Month by month</span>
          <span className="am-chart__caption">Newest first · {range.rangeText} · blank where the inputs are not yet complete · select a header to sort</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Efficiency month by month" cols={tcols}
            rows={tableRows.map((p) => [mlabel(p.month), pctNum(p.arrGrowth), pctNum(p.opMargin), p.rule40 == null ? '—' : p.rule40.toFixed(1), ratio(p.magic), ratio(p.quickRatio), pctNum(p.annualNRR), pctNum(p.annualGRR), ratio(p.burnMultiple), p.grossMargin == null ? '—' : `${(p.grossMargin * 100).toFixed(1)}%`])}
            sortValues={tableRows.map((p) => [p.month, p.arrGrowth, p.opMargin, p.rule40, p.magic, p.quickRatio, p.annualNRR, p.annualGRR, p.burnMultiple, p.grossMargin])}
            limit={showAll ? undefined : LIMIT} />
        </div>
        {!showAll && tableRows.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {tableRows.length}</button>}
      </section>
    </DsPage>
  );
}
