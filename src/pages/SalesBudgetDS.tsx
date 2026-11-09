/**
 * Sales Budget on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data is the classic page's (SalesBudget.tsx, kept at
 * /sales-budget-classic): the same sales_budget snapshot, every figure read from it unchanged,
 * including today's fixes: subscription is the true trailing twelve complete months (run-rate
 * shown alongside as its basis), new logos a month are the real count plus their average-ARPA
 * equivalent, and the Connect attach denominator is the canonical customer base.
 *
 * The classic page has no editable plan inputs (the target lives in
 * _etl_scripts/sales_budget_config.json), so this page writes nothing.
 *
 * Order: what the target asks for, why it is a reversal, the month-by-month budget to manage,
 * the levers that close it, then the trailing year and the whole revenue base behind it.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Link, Segmented, SideSheet,
  downloadCsv, mlabel, pct, thisMonth, usd, usdk, useMonthRange,
} from '../design-system/parts';

type PlanRow = {
  month: string; opening_mrr: number; target_closing_mrr: number; target_closing_arr: number;
  net_required: number; expected_losses: number; gross_required: number; new_logos_required: number | null;
  actual_closing_mrr: number | null; actual_gross: number | null; actual_losses: number | null; variance: number | null;
};
type Stream = { key: string; label: string; basis: string; ttm: number; monthly: number; share: number | null; run_rate?: number };
type Snap = {
  streams: Stream[];
  total_revenue: { ttm: number; monthly: number; target_annual: number; gap: number; note: string; window?: { start: string; end: string } };
  connect_opportunity: {
    processing_now: number; active_customers: number; attach_rate: number; not_processing: number;
    fee_potential_annual: number; current_fees_annual: number; gross_application_fees_annual?: number | null; basis: string | null;
    covers_pct_of_subscription_gap: number; covers_pct_of_total_gap: number;
  } | null;
  config: { target_annual_growth: number; plan_months: number; churn_improvement: number; editable_at: string };
  baseline: { as_of: string; mrr: number; arr: number; customers: number; arpa: number };
  target: { annual_growth: number; monthly_growth: number; target_arr: number; target_mrr: number; arr_gap: number; end_month: string | null };
  trailing: { gains: number; losses: number; net: number; monthly_gain_rate: number; monthly_loss_rate: number; grr: number | null; nrr: number | null; new_logos_per_month: number | null; new_logo_arpa_equivalents_per_month?: number | null; window?: { start: string; end: string } };
  effort: { run_rate_gross_per_month: number; required_gross_per_month: number; multiple: number | null; net_today_per_month: number };
  plan: PlanRow[];
  notes?: string;
};

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;
const n1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

// Summable plan columns (index into the budget table) and how each reads in its drill-down.
const SUM_COLS: Record<number, { label: string; get: (p: PlanRow) => number | null; fmt: (v: number) => string }> = {
  3: { label: 'Net needed', get: (p) => p.net_required, fmt: usd },
  4: { label: 'Expected losses', get: (p) => p.expected_losses, fmt: usd },
  5: { label: 'Gross needed', get: (p) => p.gross_required, fmt: usd },
  6: { label: 'New logos needed (average ARPA)', get: (p) => p.new_logos_required, fmt: n1 },
  8: { label: 'Variance', get: (p) => p.variance, fmt: signed },
};

type Drill = { kind: 'column'; col: number } | { kind: 'streams' };

export default function SalesBudgetDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('sales_budget');
  const snap = data as unknown as Snap | undefined;
  const [unit, setUnit] = useState<'arr' | 'mrr'>('arr');
  const [drill, setDrill] = useState<Drill | null>(null);
  const cm = thisMonth();

  const plan = useMemo(() => snap?.plan ?? [], [snap]);
  const byMonth = useMemo(() => new Map(plan.map((p) => [p.month, p])), [plan]);
  const range = useMonthRange(plan.map((p) => p.month));
  const status = (p: PlanRow): [string, Tone] => {
    if (p.actual_closing_mrr != null) return p.variance != null && p.variance < 0 ? ['Behind plan', 'warning'] : ['On plan', 'success'];
    if (p.month === cm) return ['In progress', 'info'];
    return ['Ahead', 'neutral'];
  };
  const mName = (m: string) => `${mlabel(m)}${m === cm ? ' (in progress)' : ''}`;

  const b = snap?.baseline, tg = snap?.target, tr = snap?.trailing, ef = snap?.effort, co = snap?.connect_opportunity;
  const sub = snap?.streams.find((x) => x.key === 'subscription');
  const growthPct = Math.round((tg?.annual_growth ?? 0) * 100);
  const logosNeeded = plan[0]?.new_logos_required ?? null;

  const val = (p: PlanRow, which: 'target' | 'actual') => which === 'target'
    ? (unit === 'arr' ? p.target_closing_arr : p.target_closing_mrr)
    : p.actual_closing_mrr == null ? 0 : (unit === 'arr' ? p.actual_closing_mrr * 12 : p.actual_closing_mrr);
  const anyActual = range.months.some((m) => byMonth.get(m)?.actual_closing_mrr != null);
  const series = [
    { key: 'target', label: `Target ${unit.toUpperCase()}`, tone: 'div-1', values: range.months.map((m) => val(byMonth.get(m)!, 'target')) },
    { key: 'actual', label: `Actual ${unit.toUpperCase()}`, tone: 'div-2', values: range.months.map((m) => val(byMonth.get(m)!, 'actual')) },
  ];

  // ---- totals of the monthly budget
  const sumOf = (col: number) => {
    const vals = plan.map((p) => SUM_COLS[col].get(p)).filter((v): v is number => v != null);
    return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
  };

  const exportCsv = () => downloadCsv('sales_budget',
    ['Month', 'Opening MRR', 'Target closing MRR', 'Target ARR', 'Net required', 'Expected losses', 'Gross required', 'New logos required', 'Actual closing MRR', 'Variance'],
    plan.map((p) => [p.month, p.opening_mrr, p.target_closing_mrr, p.target_closing_arr, p.net_required, p.expected_losses, p.gross_required,
      p.new_logos_required ?? '', p.actual_closing_mrr ?? '', p.variance ?? '']));

  // ---- drill sheet
  const sheet = (() => {
    if (!drill || !snap) return null;
    if (drill.kind === 'streams') {
      const w = snap.total_revenue.window;
      return (
        <SideSheet open onClose={() => setDrill(null)} title="Total revenue, trailing twelve months"
          text={`${w ? `${mlabel(w.start)} to ${mlabel(w.end)} · ` : ''}${snap.total_revenue.note}`}>
          <DataTable label="Revenue by stream"
            cols={[['Stream', false], ['Trailing 12 mo', true], ['Per month', true], ['Share', true], ['Basis', false]]}
            rows={snap.streams.map((st) => [st.label, usd(st.ttm), usd(st.monthly), pct(st.share), st.basis])}
            foot={['Total revenue', usd(snap.total_revenue.ttm), usd(snap.total_revenue.monthly), '100.0%', 'mixed']} />
          {sub?.run_rate != null && <p className="am-card__text">Subscription run-rate today (current MRR × 12) is {usd(sub.run_rate)} a year, {signed(sub.run_rate - sub.ttm)} against the trailing twelve months it is measured on.</p>}
          <p className="am-card__text">Target at +{growthPct}%: {usd(snap.total_revenue.target_annual)} a year, a gap of {usd(snap.total_revenue.gap)} across all streams.</p>
        </SideSheet>
      );
    }
    const c = SUM_COLS[drill.col];
    const rows = plan.map((p) => ({ p, v: c.get(p) }));
    const total = sumOf(drill.col);
    return (
      <SideSheet open onClose={() => setDrill(null)} title={`${c.label} · ${plan.length ? `${mlabel(plan[0].month)} to ${mlabel(plan[plan.length - 1].month)}` : ''}`}
        text={drill.col === 8 ? 'Variance exists only for months the accrual waterfall has closed.' : 'Every month of the plan that this total adds up.'}>
        <DataTable label={c.label} cols={[['Month', false], [c.label, true], ['Status', false]]}
          rows={rows.map(({ p, v }) => { const [w, t] = status(p); return [mName(p.month), v == null ? '—' : c.fmt(v), <span key="s" className={`am-tag am-tag--${t}`}>{w}</span>]; })}
          foot={[`Total · ${rows.filter((r) => r.v != null).length} months`, total == null ? '—' : c.fmt(total), '']} />
      </SideSheet>
    );
  })();

  const multipleTag: [string, Tone] | null = ef?.multiple == null ? null : ef.multiple > 1.2 ? ['Well above today', 'error'] : ['Close to today', 'success'];

  return (
    <DsPage
      path="/sales-budget"
      title="Sales Budget"
      subtitle={isLoading ? 'Loading…' : 'What the growth target requires each month, measured as gross new business, because the book has to be replaced before it can be grown.'}
      actions={
        <button className="am-btn am-btn--outlined" disabled={!plan.length} onClick={exportCsv}>
          <Icon name="download" />Export CSV
        </button>
      }
      overlays={sheet}
    >
      {error ? <p className="am-card__text">Could not load the sales budget: {String(error)}</p> : null}

      {snap && b && tg && tr && ef && <>
        <KpiGrid>
          <KpiCard label="Current ARR" value={usd(b.arr)} hint={`${b.customers} customers · ${usd(b.arpa)} ARPA · as of ${mlabel(b.as_of)}`} />
          <KpiCard label={`Target ARR (+${growthPct}%)`} value={usd(tg.target_arr)} hint={`by ${tg.end_month ? mlabel(tg.end_month) : '—'}`} />
          <KpiCard label="ARR to add" value={usd(tg.arr_gap)} hint={`${pct(tg.monthly_growth)} compounding per month`} />
          <KpiCard label="Gross new needed" value={`${usd(ef.required_gross_per_month)}/mo`} hint={`vs ${usd(ef.run_rate_gross_per_month)}/mo today`}
            tag="Gap to close" tagTone="warning" />
          <KpiCard label="That is" value={ef.multiple != null ? `${ef.multiple}× today` : '—'}
            hint={`${logosNeeded ?? '—'} average-ARPA logos a month if all from new`}
            tag={multipleTag?.[0]} tagTone={multipleTag?.[1]} />
          <KpiCard label="New logos today" value={tr.new_logos_per_month != null ? `${tr.new_logos_per_month}/mo` : '—'}
            hint={`${tr.new_logo_arpa_equivalents_per_month != null ? `${tr.new_logo_arpa_equivalents_per_month} at average ARPA` : 'Average-ARPA equivalent not available'} · trailing twelve months`} />
        </KpiGrid>

        <section className="am-card am-card--outlined">
          <div className="am-row am-row--tight"><span className="am-tag am-tag--warning">Reversal, not extrapolation</span></div>
          <p className="am-card__text" style={{ marginTop: 8 }}>
            Over the last twelve months the book added {usd(tr.gains)} and lost {usd(tr.losses)}, a net of {signed(tr.net)}: it is roughly flat.
            Hitting +{growthPct}% means replacing those losses and adding {usd(tg.arr_gap / 12)} of MRR on top, which is why the gross requirement is {ef.multiple}× the current run rate rather than 1.2×.
            Retention is the cheapest lever here: every point of churn avoided is a point sales does not have to sell twice.
          </p>
        </section>

        <ChartCard title="Plan vs actual"
          caption={`Target compounds ${pct(tg.monthly_growth)} a month and lands on +${growthPct}% after ${snap.config.plan_months} months · actual appears only for months the accrual waterfall has closed · baseline is the canonical customer base at ${mlabel(b.as_of)}: ${b.customers} customers, invoiced basis · ${range.rangeText}${range.months.includes(cm) ? ` · ${mlabel(cm)} is in progress` : ''}`}>
          <div className="am-row am-row--wrap am-row--spread">
            {range.controls}
            <Segmented label="Unit" value={unit} onChange={setUnit} options={[['arr', 'ARR'], ['mrr', 'MRR']]} />
          </div>
          <ColumnChart months={range.months} series={series} fmt={usdk} grouped legend
            labelFor={(i) => usdk(series[0].values[i])}
            tipRows={(i) => {
              const p = byMonth.get(range.months[i])!;
              const [w] = status(p);
              return [
                [`Target ${unit.toUpperCase()}`, usd(val(p, 'target'))],
                [`Actual ${unit.toUpperCase()}`, p.actual_closing_mrr == null ? `none yet (${w.toLowerCase()})` : usd(val(p, 'actual'))],
                ['Gross needed this month', usd(p.gross_required)],
              ];
            }}
            aria={`Target and actual ${unit.toUpperCase()} by month, ${range.rangeText}.`} />
          {!anyActual && <p className="am-card__text">No plan month has closed yet, so there are no actual columns to compare.</p>}
        </ChartCard>

        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread am-row--wrap">
            <div className="am-chart__head">
              <span className="am-chart__title">Monthly budget</span>
              <span className="am-chart__caption">Gross needed is the number to manage: the net growth step plus the MRR the book is expected to lose that month, because losses have to be replaced before anything counts as growth. New logos assumes every dollar comes from new customers at current ARPA; expansion reduces it one for one. Select a total to see its months.</span>
            </div>
            <button className="am-btn am-btn--text" disabled={!plan.length} onClick={exportCsv}><Icon name="download" />CSV</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Monthly budget"
              cols={[['Month', false], ['Opening', true], ['Target close', true], ['Net needed', true], ['Expected losses', true], ['Gross needed', true], ['Logos', true], ['Actual', true], ['Variance', true], ['Status', false]]}
              rows={plan.map((p) => {
                const [w, t] = status(p);
                return [mName(p.month), usd(p.opening_mrr), usd(p.target_closing_mrr), usd(p.net_required), usd(p.expected_losses), usd(p.gross_required),
                  p.new_logos_required ?? '—', p.actual_closing_mrr != null ? usd(p.actual_closing_mrr) : '—', p.variance == null ? '—' : signed(p.variance),
                  <span key="s" className={`am-tag am-tag--${t}`}>{w}</span>];
              })}
              sortValues={plan.map((p) => [p.month, p.opening_mrr, p.target_closing_mrr, p.net_required, p.expected_losses, p.gross_required, p.new_logos_required, p.actual_closing_mrr, p.variance, status(p)[0]])}
              foot={[`Total · ${plan.length} months`, '', plan.length ? usd(plan[plan.length - 1].target_closing_mrr) : '',
                ...[3, 4, 5, 6].map((c) => { const s = sumOf(c); return s == null ? '—' : SUM_COLS[c].fmt(s); }), '—',
                (() => { const s = sumOf(8); return s == null ? '—' : signed(s); })(), '']}
              footClickable={(c) => c in SUM_COLS}
              onFoot={(c) => setDrill({ kind: 'column', col: c })} />
          </div>
          <p className="am-card__text">The Target close total is the plan’s ending MRR ({usd(tg.target_mrr)}), not a sum.</p>
        </section>

        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">The levers</span>
            <span className="am-chart__caption">Each lever closes the same gap, and they are different teams’ work. What today’s run rate delivers against what the plan needs.</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="The levers" cols={[['Lever', false], ['What the plan needs', true], ['Today', true], ['Status', false]]}
              rows={([
                ['Win more', `${logosNeeded ?? '—'} average-ARPA logos/mo`,
                  `${tr.new_logos_per_month ?? '—'} new logos/mo${tr.new_logo_arpa_equivalents_per_month != null ? ` (${tr.new_logo_arpa_equivalents_per_month} at average ARPA)` : ''}`,
                  'Below plan', 'error'],
                ['Expand more', `${usd(ef.required_gross_per_month)}/mo gross`, `${usd(ef.run_rate_gross_per_month)}/mo`, 'Below plan', 'warning'],
                ['Lose less', `${pct(tr.monthly_loss_rate)}/mo leaking`, `GRR ${pct(tr.grr)} · NRR ${pct(tr.nrr)}`, 'Leaking', 'warning'],
                ['Attach payments', co ? `${usd(co.fee_potential_annual)}/yr available` : '—', co ? `${co.not_processing} of ${co.active_customers} customers not processing` : '—', 'Warm list', 'success'],
              ] as Array<[string, string, string, string, Tone]>).map(([lever, need, now, w, t]) => [
                lever === 'Attach payments' ? <Link key="l" to="/payments-opportunity">{lever}</Link> : lever, need, now,
                <span key="s" className={`am-tag am-tag--${t}`}>{w}</span>,
              ])} />
          </div>
          <p className="am-card__text">Target is set in <code>{snap.config.editable_at}</code>. Set <code>churn_improvement</code> there to model the plan with better retention: at 0.25 the gross requirement falls by a quarter of the loss line (now {snap.config.churn_improvement}).</p>
        </section>

        {co && (
          <section className="am-card am-card--outlined">
            <div className="am-row am-row--tight"><span className="am-tag am-tag--success">Largest single lever</span></div>
            <p className="am-card__text" style={{ marginTop: 8 }}>
              Connect attach is sold to customers you already have. Only {co.processing_now} of {co.active_customers} customers in the customer base process payments through Allmoxy ({pct(co.attach_rate, 0)}, any Connect fee in the last 3 complete months).
              Attaching the other {co.not_processing} is worth about {usd(co.fee_potential_annual)} a year, {pct(co.covers_pct_of_subscription_gap, 0)} of the subscription growth gap, at roughly 99.6% gross margin, without winning a single new logo.
              {' '}{logosNeeded != null ? `About ${Math.round(logosNeeded)} average-ARPA new logos a month` : 'Winning new logos'} is one route to the target; this is another, and it starts from a warm list.
            </p>
            {co.basis && <p className="am-card__text" style={{ marginTop: 8 }}>{co.basis}</p>}
          </section>
        )}

        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Trailing twelve months</span>
            <span className="am-chart__caption">{tr.window ? `${mlabel(tr.window.start)} to ${mlabel(tr.window.end)} · ` : ''}MRR movement from the accrual waterfall · select the net to open the Revenue Waterfall’s months</span>
          </div>
          <DataTable label="Trailing twelve months" cols={[['Movement', false], ['MRR', true], ['Direction', false]]}
            rows={[
              ['Added (new + expansion)', usd(tr.gains), <span key="s" className="am-tag am-tag--success">Gain</span>],
              ['Lost (churn, contraction, delinquency, voids)', `−${usd(tr.losses)}`, <span key="s" className="am-tag am-tag--error">Loss</span>],
            ]}
            foot={['Net', signed(tr.net), '']}
            footClickable={(c) => c === 1}
            onFoot={() => navigate('/revenue-waterfall')} />
          <p className="am-card__text">Monthly gain rate {pct(tr.monthly_gain_rate)} · monthly loss rate {pct(tr.monthly_loss_rate)} · GRR {pct(tr.grr)} · NRR {pct(tr.nrr)} · net today {usd(ef.net_today_per_month)}/mo.</p>
        </section>

        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">The whole revenue base</span>
            <span className="am-chart__caption">
              The monthly plan is priced on subscription only, the recurring line MRR discipline applies to ({pct(sub?.share)} of trailing revenue). Every stream is summed over the same trailing twelve complete months{snap.total_revenue.window ? ` (${mlabel(snap.total_revenue.window.start)} to ${mlabel(snap.total_revenue.window.end)})` : ''}; subscription is the monthly invoiced MRR including annual-payer amortization, with today’s run-rate (MRR × 12) shown as its basis. Bases are not fused: subscription is invoiced (accrual), Connect and services are cash.
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Revenue by stream"
              cols={[['Stream', false], ['Trailing 12 mo', true], ['Per month', true], ['Share', true], ['Basis', false]]}
              rows={snap.streams.map((st) => [st.label, usd(st.ttm), usd(st.monthly), pct(st.share),
                `${st.basis}${st.run_rate != null ? ` · run-rate ${usd(st.run_rate)}/yr` : ''}`])}
              sortValues={snap.streams.map((st) => [st.label, st.ttm, st.monthly, st.share, st.basis])}
              foot={['Total revenue', usd(snap.total_revenue.ttm), usd(snap.total_revenue.monthly), '100.0%', 'mixed']}
              footClickable={(c) => c === 1 || c === 2}
              onFoot={() => setDrill({ kind: 'streams' })} />
          </div>
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--info">Target at +{Math.round(snap.config.target_annual_growth * 100)}%</span>
            <span className="am-card__text">{usd(snap.total_revenue.target_annual)} a year · a gap of {usd(snap.total_revenue.gap)} across all streams</span>
          </div>
        </section>
      </>}
    </DsPage>
  );
}
