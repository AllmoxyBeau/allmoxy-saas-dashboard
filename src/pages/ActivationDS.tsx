/**
 * Activation on the Allmoxy design system. Data logic is the classic page's (Activation.tsx, kept
 * at /activation-classic): the same activation snapshot, the same card figures, the same cohort
 * series (signup cohorts with at least one signup), the same stalled list (MRR first, MRR breaking
 * ties) and the same stalled CSV, following the table's sort.
 *
 * Order: the cards, the stalled list to work, then the cohort chart. The classic line (activation
 * rate) becomes the value label on each month's columns and a tooltip row, since charts are columns.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { exportRowsAsCsv } from '../lib/csvExport';
import { ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, mlabel, thisMonth, usd, useMonthRange } from '../design-system/parts';

type Cohort = { month: string; signups: number; activated: number; churned_never: number; still_stalled: number; mrr_signed: number; activation_rate: number | null };
type Row = {
  allmoxy_customer_id: number; name: string; signup_date: string; cohort_month: string;
  status: string | null; mrr: number; paying_now: boolean;
  activated: boolean | null; order_data_known: boolean;
  first_order_month: string | null; first_order_year: string | null;
  days_to_activate: number | null; days_since_signup: number; state: string;
  owner: string | null; churn_month: string | null; churn_reason: string | null;
  lifetime_subscription: number; hubspot_url: string | null;
};
type Snap = {
  stall_threshold_days: number;
  totals: { customers: number; measurable: number; unknown_no_order_record: number; activated: number; activation_rate: number | null; bid_only_excluded: number };
  now: { stalled: number; stalled_mrr: number; stalled_arr: number; onboarding: number; onboarding_mrr: number; paying_customers: number; stalled_share_of_mrr: number | null };
  cost: { churned_never_activated: number; mrr_lost: number; lifetime_paid: number; median_months_paid_before_quitting: number | null };
  time_to_activate: { measurable: number; median_days: number | null; p75_days: number | null; note: string };
  cohorts: Cohort[];
  stalled_customers: Row[];
  onboarding_customers: Row[];
  customers: Row[];
};

const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const pctOf = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const statusWord = (s: string | null) => (s ? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '—');
const statusTone = (s: string | null) => (s === 'at_risk' ? 'warning' : s === 'active' ? 'success' : 'neutral');
// Classic coloured the wait past 180 / 365 days; here it is a worded tag in its own column.
const waitTag = (d: number) => (d > 365 ? <span className="am-tag am-tag--error">Over a year</span> : d > 180 ? <span className="am-tag am-tag--warning">Over 6 months</span> : <span className="am-tag am-tag--neutral">Under 6 months</span>);

export default function ActivationDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('activation');
  const snap = data as unknown as Snap | undefined;
  const listRef = useRef<HTMLElement>(null);
  const [showAll, setShowAll] = useState(false);
  const [csvOrder, setCsvOrder] = useState<number[] | null>(null);

  // Classic default order: MRR descending, MRR breaking ties. The table's own sort is stable, so
  // re-sorting by another column keeps the biggest money first among equals.
  const stalled = useMemo(() => [...(snap?.stalled_customers ?? [])].sort((a, b) => b.mrr - a.mrr), [snap]);

  // Cohort series exactly as the classic chart: cohorts with at least one signup.
  const cohorts = useMemo(() => (snap?.cohorts ?? []).filter((c) => c.signups > 0), [snap]);
  const { months, controls, rangeText } = useMonthRange(cohorts.map((c) => c.month));
  const shown = useMemo(() => { const set = new Set(months); return cohorts.filter((c) => set.has(c.month)); }, [cohorts, months]);
  const cur = thisMonth();

  const subtitle = 'Signup to first verified order: the moment a customer either starts using Allmoxy or quietly never does.';
  if (error) {
    return <DsPage path="/activation" title="Activation" subtitle={subtitle}><p className="am-card__text"><span className="am-tag am-tag--error">Failed to load</span> activation: {String(error)}</p></DsPage>;
  }
  if (isLoading || !snap) {
    return <DsPage path="/activation" title="Activation" subtitle={subtitle}><p className="am-card__text">Loading activation…</p></DsPage>;
  }

  const t = snap.totals, now = snap.now, cost = snap.cost;
  const LIMIT = 25;
  const csvRows = csvOrder && csvOrder.length === stalled.length ? csvOrder.map((i) => stalled[i]) : stalled;
  const exportCsv = () => exportRowsAsCsv('activation_stalled.csv', [
    { key: 'name', label: 'Customer' }, { key: 'mrr', label: 'MRR' },
    { key: 'days_since_signup', label: 'Days since signup' }, { key: 'signup_date', label: 'Signed up' },
    { key: 'owner', label: 'Owner' }, { key: 'status', label: 'Status' },
    { key: 'lifetime_subscription', label: 'Paid to date' },
  ], csvRows);
  const openCustomer = (r: Row) => navigate(`/customer-detail?id=${encodeURIComponent(String(r.allmoxy_customer_id))}`);
  const toList = () => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const onb = snap.onboarding_customers ?? [];

  return (
    <DsPage path="/activation" title="Activation" subtitle={subtitle}
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={stalled.length === 0}><Icon name="download" />Export stalled CSV</button>}>

      <KpiGrid>
        <KpiCard label="Stalled now" value={N0.format(now.stalled ?? 0)} hint={`${usd(now.stalled_mrr ?? 0)}/mo · ${usd(now.stalled_arr ?? 0)} ARR`}
          tag={(now.stalled ?? 0) > 0 ? 'Needs action' : 'Clear'} tagTone={(now.stalled ?? 0) > 0 ? 'error' : 'success'} onOpen={toList} />
        <KpiCard label="Stalled share of MRR" value={pctOf(now.stalled_share_of_mrr)} hint="Paying but never ordered"
          tag={(now.stalled_share_of_mrr ?? 0) > 0 ? 'At risk' : 'Clear'} tagTone={(now.stalled_share_of_mrr ?? 0) > 0 ? 'warning' : 'success'} />
        <KpiCard label="Activation rate" value={pctOf(t.activation_rate)} hint={`${N0.format(t.activated ?? 0)} of ${N0.format(t.measurable ?? 0)} measurable`} />
        <KpiCard label="Median time to activate" value={snap.time_to_activate.median_days != null ? `${snap.time_to_activate.median_days}d` : '—'} hint={`${snap.time_to_activate.measurable ?? 0} measurable`} />
        <KpiCard label="Never-activated churn" value={N0.format(cost.churned_never_activated ?? 0)} hint={`${usd(cost.lifetime_paid ?? 0)} paid, never used`}
          tag={(cost.churned_never_activated ?? 0) > 0 ? 'Lost' : 'None'} tagTone={(cost.churned_never_activated ?? 0) > 0 ? 'error' : 'success'} />
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--tight"><span className="am-tag am-tag--warning">Revenue at risk</span></div>
        <p className="am-card__text">
          <b>{now.stalled} customers are paying {usd(now.stalled_mrr ?? 0)} a month for something they have never used.</b>{' '}
          That is {usd(now.stalled_arr ?? 0)} of ARR and {pctOf(now.stalled_share_of_mrr)} of MRR sitting on accounts with no verified order, past day {snap.stall_threshold_days}.
          Historically this is where churn comes from: {cost.churned_never_activated} customers have already left without ever ordering, having paid {usd(cost.lifetime_paid ?? 0)} over a median of {cost.median_months_paid_before_quitting} months first.
        </p>
      </section>

      {/* The list to work */}
      <section className="am-card am-card--outlined" ref={listRef}>
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Work this list · {stalled.length} stalled</span>
            <span className="am-chart__caption">Paying, past day {snap.stall_threshold_days}, and no verified order on record. Sorted by MRR: this is a revenue-at-risk queue, not a support queue. Bid-only customers are held out ({t.bid_only_excluded}): they use Allmoxy for quotes and never place verified orders by design.</span>
          </div>
          <button className="am-btn am-btn--text" onClick={exportCsv} disabled={stalled.length === 0}><Icon name="download" />CSV</button>
        </div>
        <DataTable label="Stalled customers"
          cols={[['Customer', false], ['MRR', true], ['Days since signup', true], ['Waiting', false], ['Paid to date', true], ['Owner', false], ['Status', false], ['HubSpot', false]]}
          rows={stalled.map((r) => [
            r.name, usd(r.mrr), N0.format(r.days_since_signup), waitTag(r.days_since_signup), usd(r.lifetime_subscription), r.owner ?? '—',
            <span key="s" className={`am-tag am-tag--${statusTone(r.status)}`}>{statusWord(r.status)}</span>,
            r.hubspot_url ? <a key="h" className="am-btn am-btn--text" href={r.hubspot_url} target="_blank" rel="noopener noreferrer">Open<Icon name="open_in_new" /></a> : '—',
          ])}
          sortValues={stalled.map((r) => [r.name ?? '', r.mrr ?? 0, r.days_since_signup ?? 0, r.days_since_signup ?? 0, r.lifetime_subscription ?? 0, r.owner ?? '￿', r.status ?? '', r.hubspot_url ? 1 : 0])}
          defaultSort={{ col: 1, dir: 'desc' }}
          onSortChange={(order) => setCsvOrder(order)}
          clickable={(c) => c === 0} onCell={(i) => openCustomer(stalled[i])}
          limit={showAll ? undefined : LIMIT}
          foot={[`Total · ${stalled.length} customers`, usd(stalled.reduce((s, r) => s + r.mrr, 0)), '', '', usd(stalled.reduce((s, r) => s + r.lifetime_subscription, 0)), '', '', '']}
          onFoot={() => setShowAll(true)} footClickable={(c) => (c === 0 || c === 1 || c === 4) && !showAll && stalled.length > LIMIT} />
        {!showAll && stalled.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {stalled.length}</button>}
      </section>

      {onb.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Still inside the window · {onb.length} signed up within {snap.stall_threshold_days} days</span>
            <span className="am-chart__caption">Not stalled yet: they have not had time to place a first order</span>
          </div>
          <DataTable label="Customers still inside the activation window"
            cols={[['Customer', false], ['MRR', true], ['Day', true], ['Owner', false]]}
            rows={onb.map((r) => [r.name, usd(r.mrr), `day ${r.days_since_signup}`, r.owner ?? '—'])}
            sortValues={onb.map((r) => [r.name, r.mrr, r.days_since_signup, r.owner ?? '￿'])}
            clickable={(c) => c === 0} onCell={(i) => openCustomer(onb[i])}
            foot={[`Total · ${onb.length} customers`, usd(onb.reduce((s, r) => s + r.mrr, 0)), '', '']} />
        </section>
      )}

      {/* Cohorts */}
      <ChartCard title="Activation by signup cohort"
        caption={`How many signed up each month (gray) and how many ever placed a verified order (green); the label is the activation rate. Recent cohorts read low because they have not had time yet. Customers with no order record at all (${N0.format(t.unknown_no_order_record ?? 0)}, mostly historical) are left out of the rate rather than counted as failures; counting them would report about 40% instead of the real ${pctOf(t.activation_rate)}.`}>
        <div className="am-row am-row--spread am-row--wrap">
          {controls}
          <span className="am-card__text">{rangeText}</span>
        </div>
        <ColumnChart grouped legend months={shown.map((c) => c.month)} fmt={(v) => Math.round(v).toLocaleString()}
          series={[
            { key: 'signups', label: 'Signed up', tone: 'other', values: shown.map((c) => c.signups) },
            { key: 'activated', label: 'Activated', tone: 'div-2', values: shown.map((c) => c.activated) },
          ]}
          labelFor={(i) => (shown[i].activation_rate != null ? `${Math.round(shown[i].activation_rate! * 100)}%` : null)}
          catTitle={(m) => `${mlabel(m)}${m === cur ? ' (in progress)' : ''}`}
          tipRows={(i) => { const c = shown[i]; return [
            ['Signed up', N0.format(c.signups)], ['Activated', N0.format(c.activated)],
            ['Activation rate', c.activation_rate != null ? `${Math.round(c.activation_rate * 100)}%` : '—'],
            ['Left without ordering', N0.format(c.churned_never)], ['Still stalled', N0.format(c.still_stalled)], ['MRR signed', usd(c.mrr_signed)],
          ]; }}
          aria="Signups and activations by signup month, with the activation rate." />
      </ChartCard>

      <p className="am-card__text">Activation = has ever placed a verified order. {snap.time_to_activate.note}</p>
    </DsPage>
  );
}
