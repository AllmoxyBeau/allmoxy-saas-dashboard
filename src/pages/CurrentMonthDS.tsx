/**
 * Current Month on the Allmoxy design system. Every figure comes from the same sources as the
 * classic page (CurrentMonth.tsx, kept at /current-month-classic): the month-to-date cash view
 * from useCurrentMonth() (moved verbatim out of the classic page), the invoiced (billed) view
 * from current_month.json, and the pace chart's logic from MonthPaceChart.
 *
 * Order follows what the month's question is: where is MRR heading (billed view), how does the
 * month pace against prior months, cash by stream, then the reconciliation detail.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, FilterChip, Icon, KpiCard, downloadCsv, mlabel, mshort, usd, usdk,
} from '../design-system/parts';
import { useCurrentMonth, type VarianceCategory } from './currentMonth/useCurrentMonth';

type Bucket = { amount: number; customers: number };
type CustRow = {
  allmoxy_customer_id: number; name: string; prior_billed: number; billed_so_far: number; upcoming_expected: number;
  expected: number; delta: number; failed_attempts: number; expected_billing_day: number | null; next_billing_date: string | null;
  billing_state: string; movement: string;
};
type CmSnap = {
  month: string; prior_month: string; as_of: string; day_of_month: number; days_in_month: number; elapsed_pct: number;
  mrr: { starting: number; expected_ending: number; net_change: number; net_change_pct: number | null; billed_so_far: number; still_to_bill: number; annual_amortized?: number };
  movement: Record<'new' | 'expansion' | 'contraction' | 'lost' | 'flat', Bucket>;
  billing: Record<string, Bucket>;
  customers: CustRow[];
};
type MrrRow = { month: string; mrr_subscription: number | null; mrr_services: number | null; mrr_connect: number | null };

const signed = (v: number) => (Math.abs(v) < 0.5 ? '$0' : `${v > 0 ? '+' : '−'}${usd(Math.abs(v))}`);
const pctTxt = (v: number | null | undefined) => (v == null ? '' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`);

// Billing states, worst first so the eye lands on what needs working.
const STATES: Array<{ key: string; label: string; tone: 'error' | 'warning' | 'info' | 'success' | 'neutral'; help: string }> = [
  { key: 'nothing_scheduled', label: 'Nothing scheduled', tone: 'error', help: 'Billed last month, no invoice issued and no billing date ahead: the genuine risk set.' },
  { key: 'failing', label: 'Payment failing', tone: 'error', help: 'Invoice issued and a charge attempt already failed.' },
  { key: 'written_off', label: 'Written off', tone: 'neutral', help: 'Invoice issued and marked uncollectible.' },
  { key: 'awaiting_payment', label: 'Awaiting payment', tone: 'warning', help: 'Invoice issued, not yet paid, no failure behind it. Usually just early.' },
  { key: 'partially_billed', label: 'Partly billed', tone: 'info', help: 'Some billing landed and more is still scheduled this month.' },
  { key: 'not_yet_billed', label: 'Not yet billed', tone: 'info', help: 'Billing day still ahead this month, valued at last month. An expectation, not a fact.' },
  { key: 'collected', label: 'Collected', tone: 'success', help: 'Billed and paid.' },
  { key: 'annual_amortized', label: 'Annual (amortized)', tone: 'neutral', help: 'Annual prepay carried at its monthly amortization; never billed monthly.' },
];
const stateOf = (k: string) => STATES.find((s) => s.key === k);

const CATS: Array<{ k: VarianceCategory; label: string }> = [
  { k: 'new_sub', label: 'New' }, { k: 'reactivated', label: 'Reactivated' }, { k: 'reconnected', label: 'Reconnected' },
  { k: 'billing_timing', label: 'Billing timing' }, { k: 'expanded', label: 'Expansion' }, { k: 'contracted', label: 'Contraction' },
  { k: 'overdue', label: 'Overdue' }, { k: 'cancelled', label: 'Cancelled' },
];
const catLabel = (k: VarianceCategory) => CATS.find((c) => c.k === k)?.label ?? k;

export default function CurrentMonthDS() {
  const { mrrLoading, view, subscriptionView: sv, activeCategories, toggleCategory, setActiveCategories, ALL_CATEGORIES } = useCurrentMonth();
  const { data: cmData } = useSheetTab('current_month');
  const { data: mrrData } = useSheetTab<MrrRow>('mrr_by_month');
  const cm = cmData as unknown as CmSnap | undefined;
  const [focus, setFocus] = useState<string | null>(null);
  const [showAllCust, setShowAllCust] = useState(false);
  const [showAllUpcoming, setShowAllUpcoming] = useState(false);

  // ---- month-end pace (MonthPaceChart's logic): subscription uses what is still scheduled
  // to bill, never a straight line; Services and Connect are paced by days elapsed.
  const pace = useMemo(() => {
    const all = (mrrData?.rows ?? []) as MrrRow[];
    if (!all.length || !cm) return null;
    const win = all.filter((r) => r.month <= cm.month).slice(-13);
    const rows = win.map((r) => {
      const sub = r.mrr_subscription || 0, svc = r.mrr_services || 0, con = r.mrr_connect || 0;
      if (r.month !== cm.month) return { month: r.month, actual: sub + svc + con, remaining: 0 };
      const el = cm.elapsed_pct > 0 ? cm.elapsed_pct : 1;
      const eom = cm.mrr.expected_ending + svc / el + con / el;
      return { month: r.month, actual: sub + svc + con, remaining: Math.max(0, eom - (sub + svc + con)) };
    });
    const cur = rows[rows.length - 1];
    const done = rows.slice(0, -1);
    const priorAvg = done.length ? done.slice(-3).reduce((a, r) => a + r.actual, 0) / Math.min(3, done.length) : 0;
    const projected = cur.actual + cur.remaining;
    return { rows, projected, vsAvg: priorAvg > 0 ? projected / priorAvg - 1 : null };
  }, [mrrData, cm]);

  const shownCustomers = useMemo(() => {
    const all = cm?.customers ?? [];
    if (focus) return all.filter((c) => c.billing_state === focus);
    return all.filter((c) => c.movement !== 'flat');
  }, [cm, focus]);

  if (mrrLoading || !view) {
    return <DsPage path="/current-month" title="Current Month" subtitle="Loading…"><p className="am-card__text">Loading the month-to-date figures…</p></DsPage>;
  }

  const dataThrough = new Date(`${view.asOf}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const m = cm?.mrr;
  const atRisk = cm ? cm.billing.nothing_scheduled.amount + cm.billing.failing.amount : 0;
  const pctBilled = m && m.billed_so_far + m.still_to_bill > 0 ? (m.billed_so_far / (m.billed_so_far + m.still_to_bill)) * 100 : 0;

  // cash projections, exactly as the classic cards
  const subProj = sv?.projected ?? view.subscription.mtd ?? 0;
  const svcProj = view.services.projected ?? view.services.mtd ?? 0;
  const conProj = view.connect.projected ?? view.connect.mtd ?? 0;
  const annual = sv?.annualAmort ?? 0;
  const blendedProj = subProj + svcProj + conProj + annual;
  const blendedMtd = view.blended.mtd ?? 0;
  const vsPrior = (a: number | null | undefined, b: number | null | undefined) => (a != null && b ? a / b - 1 : null);

  const detail = sv ? sv.detail.filter((r) => activeCategories.has(r.category)) : [];

  return (
    <DsPage
      path="/current-month"
      title={`${mlabel(view.currentMonth)} · month to date`}
      subtitle={`Data through ${dataThrough}${view.dataStale ? ' (stale: trails today, run a refresh)' : ''} · day ${view.elapsed} of ${view.totalDays} · ${view.remaining} days remaining · every projection uses this cut-off`}
    >
      {/* 1. Where MRR is heading, billed basis */}
      <div className="am-chart__head">
        <span className="am-chart__title">MRR this month</span>
        <span className="am-chart__caption">Billing against last month's billing, so a late payment is never contraction and a catch-up payment is never growth</span>
      </div>
      <div className="am-grid" style={{ ['--am-grid-min' as string]: '240px' }}>
        {m && cm && <>
          <KpiCard label="Starting MRR" value={usd(m.starting)} hint={`Billed in ${mlabel(cm.prior_month)}`} />
          <KpiCard label="Expected ending" value={usd(m.expected_ending)} hint={`Billed + still to bill${m.annual_amortized ? ` + ${usd(m.annual_amortized)} annual (amortized)` : ''}`} />
          <KpiCard label="Net change" value={signed(m.net_change)} hint={m.net_change_pct != null ? `${pctTxt(m.net_change_pct)} on starting MRR` : undefined}
            tag={m.net_change >= 0 ? 'Growing' : 'Shrinking'} tagTone={m.net_change >= 0 ? 'success' : 'warning'} />
          <KpiCard label="Billed so far" value={usd(m.billed_so_far)} hint={`${usd(m.still_to_bill)} still to bill · ${Math.round(pctBilled)}% issued at ${Math.round(cm.elapsed_pct * 100)}% of the month`} />
          <KpiCard label="At risk" value={usd(atRisk)} hint="Nothing scheduled + payment failing"
            tag={atRisk > 0 ? 'Needs action' : 'Clear'} tagTone={atRisk > 0 ? 'error' : 'success'} onOpen={atRisk > 0 ? () => setFocus('nothing_scheduled') : undefined} />
        </>}
      </div>

      {cm && (
        <div className="am-grid" style={{ ['--am-grid-min' as string]: '420px' }}>
          <section className="am-card am-card--outlined">
            <div className="am-chart__head"><span className="am-chart__title">How MRR moved</span><span className="am-chart__caption">Billing to billing, customers</span></div>
            <DataTable label="How MRR moved" cols={[['Movement', false], ['MRR', true], ['Customers', true]]}
              rows={([['New', cm.movement.new], ['Expansion', cm.movement.expansion], ['Contraction', cm.movement.contraction], ['Lost', cm.movement.lost], ['Unchanged', cm.movement.flat]] as Array<[string, Bucket]>)
                .map(([l, b]) => [l, b.amount === 0 ? '—' : signed(b.amount), b.customers.toLocaleString()])}
              foot={['Net change', signed(m!.net_change), (['new', 'expansion', 'contraction', 'lost'] as const).reduce((a, k) => a + cm.movement[k].customers, 0).toLocaleString()]}
              onFoot={() => { setFocus(null); setShowAllCust(true); }} footClickable={(c) => c === 1} />
          </section>
          <section className="am-card am-card--outlined">
            <div className="am-chart__head"><span className="am-chart__title">Where the month is up to</span><span className="am-chart__caption">Select a state to list its customers below</span></div>
            <DataTable label="Billing states" cols={[['State', false], ['MRR', true], ['Customers', true]]}
              rows={STATES.filter((s) => cm.billing[s.key] && (cm.billing[s.key].customers || cm.billing[s.key].amount)).map((s) => [
                <span key={s.key} className="am-tooltip"><span className={`am-tag am-tag--${s.tone}`}>{s.label}</span><span className="am-tooltip__tip">{s.help}</span></span>,
                usd(cm.billing[s.key].amount), cm.billing[s.key].customers.toLocaleString()])}
              clickable={(c) => c === 1}
              onCell={(row) => { const keys = STATES.filter((s) => cm.billing[s.key] && (cm.billing[s.key].customers || cm.billing[s.key].amount)); setFocus(keys[row].key); setShowAllCust(true); }}
              foot={['Total', usd(STATES.reduce((a, s) => a + (cm.billing[s.key]?.amount ?? 0), 0)), STATES.reduce((a, s) => a + (cm.billing[s.key]?.customers ?? 0), 0).toLocaleString()]}
              onFoot={() => { setFocus('__all'); setShowAllCust(true); }} footClickable={(c) => c === 1} />
          </section>
        </div>
      )}

      {cm && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread">
            <div className="am-chart__head">
              <span className="am-chart__title">{focus === '__all' ? `All customers · ${cm.customers.length}` : focus ? `${stateOf(focus)?.label} · ${shownCustomers.length}` : `Customers that moved · ${shownCustomers.length}`}</span>
              <span className="am-chart__caption">{focus ? 'Filtered by billing state' : 'Every customer whose billing changed against last month'}</span>
            </div>
            <div className="am-row">
              {focus && <button className="am-btn am-btn--text" onClick={() => setFocus(null)}>Clear filter</button>}
              <button className="am-btn am-btn--text" onClick={() => downloadCsv(`current_month_${cm.month}`, ['Customer', `Billed ${cm.prior_month}`, 'Billed so far', 'Still to bill', 'Expected', 'Change', 'Movement', 'Billing state', 'Billing day'],
                cm.customers.map((c) => [c.name, c.prior_billed, c.billed_so_far, c.upcoming_expected, c.expected, c.delta, c.movement, c.billing_state, c.expected_billing_day ?? '']))}>
                <Icon name="download" />CSV
              </button>
            </div>
          </div>
          {(() => {
            const list = focus === '__all' ? cm.customers : shownCustomers;
            const rows = showAllCust ? list : list.slice(0, 25);
            return <>
              <DataTable label="Customers this month" cols={[['Customer', false], [`Billed ${mshort(cm.prior_month)}`, true], ['Billed so far', true], ['Still to bill', true], ['Change', true], ['State', false], ['Bills on', true]]}
                rows={rows.map((c) => [c.name, usd(c.prior_billed), c.billed_so_far > 0 ? usd(c.billed_so_far) : '—', c.upcoming_expected > 0 ? usd(c.upcoming_expected) : '—',
                  c.delta === 0 ? '—' : signed(c.delta),
                  <span key="s" className="am-row am-row--tight">
                    <span className={`am-tag am-tag--${stateOf(c.billing_state)?.tone ?? 'neutral'}`}>{stateOf(c.billing_state)?.label ?? c.billing_state}</span>
                    {c.failed_attempts > 0 && <span className="am-tag am-tag--error">{c.failed_attempts} failed</span>}
                  </span>,
                  c.next_billing_date ? c.next_billing_date.slice(5) : c.expected_billing_day ? `day ${c.expected_billing_day}` : '—'])}
                foot={[`Total · ${list.length} customers`, usd(list.reduce((a, c) => a + c.prior_billed, 0)), usd(list.reduce((a, c) => a + c.billed_so_far, 0)), usd(list.reduce((a, c) => a + c.upcoming_expected, 0)), signed(list.reduce((a, c) => a + c.delta, 0)), '', '']}
                onFoot={() => setShowAllCust(true)} footClickable={(c) => c === 0 && !showAllCust && list.length > 25} />
              {!showAllCust && list.length > 25 && <button className="am-btn am-btn--text" onClick={() => setShowAllCust(true)}>Show all {list.length}</button>}
              {list.length === 0 && <p className="am-card__text">No customers in this state.</p>}
            </>;
          })()}
        </section>
      )}

      {/* 2. Pace against prior months */}
      {pace && cm && (
        <ChartCard title="Month-end pace" caption={`All revenue streams. The ${mlabel(cm.month)} column is booked so far plus what is still expected (gray), so it reads like for like against complete months. Subscription is never projected in a straight line: it uses what is still scheduled to bill.`}>
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--neutral">Day {cm.day_of_month} of {cm.days_in_month}</span>
            {pace.vsAvg != null && <span className={`am-tag am-tag--${pace.vsAvg >= 0 ? 'success' : 'warning'}`}>{pctTxt(pace.vsAvg)} vs the prior 3-month average</span>}
            <span className="am-card__text">Projected month-end {usd(pace.projected)}</span>
          </div>
          <ColumnChart months={pace.rows.map((r) => r.month)} stacked legend fmt={usdk}
            series={[
              { key: 'booked', label: 'Booked', tone: 'div-1', values: pace.rows.map((r) => r.actual) },
              { key: 'expected', label: 'Still expected', tone: 'other', values: pace.rows.map((r) => r.remaining) },
            ]}
            tipRows={(i) => { const r = pace.rows[i]; return r.remaining ? [['Booked so far', usd(r.actual)], ['Still expected', usd(r.remaining)], ['Projected', usd(r.actual + r.remaining)]] : [['Revenue', usd(r.actual)]]; }}
            aria="Monthly revenue with the current month's projection." />
        </ChartCard>
      )}

      {/* 3. Cash by stream */}
      <div className="am-chart__head">
        <span className="am-chart__title">Cash month to date</span>
        <span className="am-chart__caption">What cleared Stripe so far, projected to month end · compared with {mlabel(view.prior)} in full</span>
      </div>
      <div className="am-grid" style={{ ['--am-grid-min' as string]: '240px' }}>
        <KpiCard label="Subscription MRR" value={usd(subProj)}
          hint={sv ? `Projected month end: ${usd(sv.postedCur)} posted from ${sv.postedSubs} subscriptions + ${usd(sv.expectedDollars)} expected from ${sv.expectedSubs}` : undefined}
          tag={sv?.variancePct != null ? `${pctTxt(sv.variancePct)} vs ${mshort(view.prior)}` : undefined} tagTone={sv?.variancePct != null ? (sv.variancePct >= 0 ? 'success' : 'warning') : undefined} />
        <KpiCard label="Services revenue" value={usd(view.services.mtd ?? 0)}
          hint={view.services.projected != null ? `Month to date · projected ${usd(view.services.projected)}` : 'Month to date'}
          tag={vsPrior(view.services.projected, view.services.priorTotal) != null ? `${pctTxt(vsPrior(view.services.projected, view.services.priorTotal))} vs ${mshort(view.prior)}` : 'Not recurring'} tagTone="neutral" />
        <KpiCard label="Connect fees (net USD)" value={view.connect.mtd != null ? usd(view.connect.mtd) : '—'}
          hint={view.connect.mtd == null ? 'Not yet in the snapshot' : view.connect.projected != null ? `Month to date · projected ${usd(view.connect.projected)}` : 'Month to date'}
          tag={vsPrior(view.connect.projected, view.connect.priorTotal) != null ? `${pctTxt(vsPrior(view.connect.projected, view.connect.priorTotal))} vs ${mshort(view.prior)}` : undefined} tagTone="neutral" />
        <KpiCard label="Annual payments (amortized)" value={usd(annual)} hint={annual > 0 ? 'Annual prepay recognized this month' : 'No annual payers this month'} />
        <KpiCard label="Blended revenue" value={usd(blendedProj)} hint={`Projected month end · ${usd(blendedMtd)} posted, ${usd(Math.max(blendedProj - blendedMtd, 0))} still expected`}
          tag={vsPrior(blendedProj, view.blended.priorTotal) != null ? `${pctTxt(vsPrior(blendedProj, view.blended.priorTotal))} vs ${mshort(view.prior)}` : undefined}
          tagTone={(vsPrior(blendedProj, view.blended.priorTotal) ?? 0) >= 0 ? 'success' : 'warning'} />
      </div>

      {/* 4. Reconciliation detail */}
      {sv && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread">
            <div className="am-chart__head">
              <span className="am-chart__title">Subscription variance vs {mlabel(view.prior)} · {signed(sv.varianceAbs)} ({pctTxt(sv.variancePct)})</span>
              <span className="am-chart__caption">{sv.postedSubs.toLocaleString()} subscriptions billed · {sv.overdueSubs.toLocaleString()} overdue · every customer falls in exactly one category, and the categories add up to the variance</span>
            </div>
            <button className="am-btn am-btn--text" onClick={() => downloadCsv(`variance_${view.currentMonth}_vs_${view.prior}`, ['Allmoxy ID', 'Customer', 'Subscription', 'Category', 'Prior $', 'Current $', 'Change', 'Expected day', 'Days overdue', 'Stripe customer'],
              detail.map((r) => [r.customerId ?? '', r.customerName, r.subLabel, catLabel(r.category), r.priorAmount, r.currentAmount, r.delta, r.expectedByDay ?? '', r.daysOverdue ?? '', r.stripeIds?.[0] ?? '']))}>
              <Icon name="download" />CSV
            </button>
          </div>
          <div className="am-row am-row--wrap" role="group" aria-label="Variance categories">
            {CATS.map((c) => (
              <FilterChip key={c.k} checked={activeCategories.has(c.k)} onChange={() => toggleCategory(c.k)}>
                {c.label} · {sv.counts[c.k]} · {signed(sv.sums[c.k])}
              </FilterChip>
            ))}
            <button className="am-btn am-btn--text" onClick={() => setActiveCategories(new Set(ALL_CATEGORIES))}>Select all</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Subscription variance by customer"
              cols={[['Customer', false], ['Subscription', false], ['Category', false], ['Prior', true], ['Current', true], ['Change', true], ['Notes', false], ['Stripe', false]]}
              rows={detail.map((r) => [r.customerName, r.subLabel, catLabel(r.category),
                r.priorAmount > 0 ? usd(r.priorAmount) : '—', r.currentAmount > 0 ? usd(r.currentAmount) : '—', signed(r.delta),
                r.category === 'overdue' && r.expectedByDay != null ? `expected day ${r.expectedByDay} · ${r.daysOverdue}d overdue${r.noAttempt ? ' · no Stripe attempt yet' : ''}` : '',
                r.stripeIds[0] ? <a key="s" className="am-btn am-btn--text" href={`https://dashboard.stripe.com/customers/${r.stripeIds[0]}`} target="_blank" rel="noopener noreferrer">Open<Icon name="open_in_new" /></a> : '—'])}
              foot={[`Total · ${detail.length} subscriptions`, '', '', usd(detail.reduce((a, r) => a + r.priorAmount, 0)), usd(detail.reduce((a, r) => a + r.currentAmount, 0)), signed(detail.reduce((a, r) => a + r.delta, 0)), '', '']}
              onFoot={() => setActiveCategories(new Set(ALL_CATEGORIES))} footClickable={(c) => c === 5 && activeCategories.size < ALL_CATEGORIES.length} />
          </div>
          {detail.length === 0 && <p className="am-card__text">{activeCategories.size === 0 ? 'No categories selected.' : 'No subscriptions in the selected categories.'}</p>}
        </section>
      )}

      {sv && (
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Upcoming expected subscription payments · {usd(sv.expectedDollars)}</span>
            <span className="am-chart__caption">Active subscriptions whose billing day is still ahead this month, at last month's amount. This is the "expected" part of the Subscription MRR projection.</span>
          </div>
          <DataTable label="Upcoming expected payments" cols={[['Customer', false], ['Expected', true], ['Bills on', true], ['Last billed', true], ['Notes', false]]}
            rows={(showAllUpcoming ? sv.upcoming : sv.upcoming.slice(0, 15)).map((u) => [u.customerName, usd(u.amount), `day ${u.expectedDay}${u.expectedDay - view.elapsed > 0 ? ` · in ${u.expectedDay - view.elapsed}d` : ''}`, u.lastBilledMonth,
              <span key="n" className="am-row am-row--tight">
                {u.attempting && <span className="am-tag am-tag--warning">Stripe attempting</span>}
                {u.payStatus && u.payStatus !== 'Active' && <span className="am-tag am-tag--neutral">{u.payStatus}</span>}
              </span>])}
            foot={[`Total expected · ${sv.upcoming.length} subscriptions`, usd(sv.expectedDollars), '', '', '']}
            onFoot={() => setShowAllUpcoming(true)} footClickable={(c) => c <= 1 && !showAllUpcoming && sv.upcoming.length > 15} />
          {!showAllUpcoming && sv.upcoming.length > 15 && <button className="am-btn am-btn--text" onClick={() => setShowAllUpcoming(true)}>Show all {sv.upcoming.length}</button>}
        </section>
      )}
    </DsPage>
  );
}
