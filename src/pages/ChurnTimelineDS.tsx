/**
 * Churn Timeline on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (ChurnTimeline.tsx, kept at
 * /churn-timeline-classic): the same `churn_timeline` snapshot, the same TTM figures (churn
 * dated to the first un-invoiced month, counted from customer_base.logo_flow, lapsed and
 * paused reported beside churn and never in it), the same story-window and reason filters
 * and the same CSV.
 *
 * Chart: churn months are sparse, so the month axis is filled with zero months from the first
 * churn to the last before the range control cuts it (the classic page cut by date for the
 * same reason). Bars show customers lost or MRR lost; hover shows both.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, Select, SideSheet,
  addMonths, downloadCsv, mlabel, thisMonth, usd, usdk, useMonthRange,
} from '../design-system/parts';

type Row = {
  allmoxy_customer_id: number; name: string;
  churn_month: string; last_paid_month: string; last_payment_date: string | null;
  sign_up_date: string | null; tenure_years: number | null;
  mrr_at_churn: number; peak_mrr: number; peak_month: string;
  decline_from_peak_pct: number | null; months_declining_before_churn: number; months_paying: number;
  lifetime_subscription: number;
  reason: string | null; reason_source: string; confidence: string | null;
  evidence_quote: string | null; evidence_date: string | null;
  subpattern_label: string | null; subpattern_parent: string | null; subpattern_description: string | null;
  owner: string | null; segment: string | null;
  final_year_orders_usd: number | null; prior_year_orders_usd: number | null; orders_decline_pct: number | null;
  tickets_lifetime: number | null; failed_payments_final_6mo: number;
  orders_comparable?: boolean; orders_suppressed_reason?: string | null;
  hubspot_url: string | null;
};
type Tally = { key: string; customers: number; mrr_lost: number };
type Snap = {
  totals: { churned_customers: number; mrr_lost: number; lifetime_lost: number; with_reason: number; researched: number; unexplained: number };
  ttm: {
    window_start: string; window_end?: string; basis?: string;
    churned_customers: number; mrr_lost: number; avg_tenure_years: number | null; left_at_full_price: number; declined_first: number;
    lapsed_customers?: number; lapsed_mrr?: number; paused_customers?: number; paused_mrr?: number;
  };
  monthly: Array<{ month: string; customers: number; mrr_lost: number }>;
  by_reason: Tally[]; by_subpattern: Tally[]; by_segment: Tally[];
  customers: Row[];
};

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
// Signed whole-percent, as the classic page shows it (−25%, +10%).
const spct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}%`);
const SOURCE: Record<string, { label: string; tone: Tone; help: string }> = {
  research: { label: 'Researched', tone: 'success', help: 'Someone read the account and established why.' },
  inferred: { label: 'Inferred', tone: 'info', help: 'Deduced from signals and a quote; not confirmed with the customer.' },
  hubspot: { label: 'HubSpot field', tone: 'warning', help: 'A dropdown someone picked in HubSpot; not researched.' },
  none: { label: 'Undiagnosed', tone: 'neutral', help: 'Nobody has established why this customer left.' },
};
const sourceOf = (s: string) => SOURCE[s] ?? { label: s, tone: 'neutral' as Tone, help: '' };
// The tallies key a missing reason as "(unclassified)"; the classic filter compared it to
// "(undiagnosed)" and so matched nothing. Both keys mean "no reason" here.
const NO_REASON = new Set(['(undiagnosed)', '(unclassified)']);
const matchesReason = (r: Row, key: string) => (r.reason == null ? NO_REASON.has(key) : r.reason === key);
const tenure = (r: Row) => (r.tenure_years != null ? `${r.tenure_years.toFixed(1)}y` : '—');
const STORY_LIMIT = 20;
const TALLY_LIMIT = 15;

function Tag({ tone, children, help }: { tone: Tone; children: ReactNode; help?: string }) {
  const tag = <span className={`am-tag am-tag--${tone}`}>{children}</span>;
  return help ? <span className="am-tooltip">{tag}<span className="am-tooltip__tip">{help}</span></span> : tag;
}

/** The run-up: what was already happening before they left, one tag per signal. */
function runUp(r: Row): ReactNode[] {
  const out: ReactNode[] = [];
  if (r.decline_from_peak_pct != null && r.decline_from_peak_pct < -0.01)
    out.push(<Tag key="peak" tone="warning">Shrank {spct(r.decline_from_peak_pct)} from {usd(r.peak_mrr)} peak ({mlabel(r.peak_month)})</Tag>);
  if (r.months_declining_before_churn > 0)
    out.push(<Tag key="decl" tone="warning">{r.months_declining_before_churn} month{r.months_declining_before_churn === 1 ? '' : 's'} declining first</Tag>);
  if (r.months_declining_before_churn === 0 && (r.decline_from_peak_pct ?? 0) >= -0.01)
    out.push(<Tag key="full" tone="neutral">Left at full price, no warning in the revenue</Tag>);
  if (r.orders_decline_pct != null)
    out.push(<Tag key="ord" tone={r.orders_decline_pct < -0.2 ? 'error' : 'neutral'}>Orders {spct(r.orders_decline_pct)} in final year</Tag>);
  else if (r.orders_suppressed_reason)
    out.push(<span key="ords" className="am-card__text">Orders: {r.orders_suppressed_reason}</span>);
  if (r.failed_payments_final_6mo > 0)
    out.push(<Tag key="fail" tone="error">{r.failed_payments_final_6mo} failed payment{r.failed_payments_final_6mo === 1 ? '' : 's'} in final 6 months</Tag>);
  if ((r.tickets_lifetime ?? 0) > 0)
    out.push(<Tag key="tix" tone="neutral">{r.tickets_lifetime} support tickets</Tag>);
  return out;
}

export default function ChurnTimelineDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('churn_timeline');
  const snap = data as unknown as Snap | undefined;
  const [reason, setReason] = useState('');
  const [since, setSince] = useState('ttm');
  const [view, setView] = useState<'stories' | 'table'>('stories');
  const [showAll, setShowAll] = useState(false);
  const [metric, setMetric] = useState<'customers' | 'mrr'>('customers');
  const [allReasons, setAllReasons] = useState(false);
  const [sheet, setSheet] = useState<{ title: string; text?: string; list: Row[] } | null>(null);
  const [story, setStory] = useState<Row | null>(null);

  const openCustomer = (r: Row) => navigate(`/customer-detail?id=${encodeURIComponent(String(r.allmoxy_customer_id))}`);
  const all = snap?.customers ?? [];

  // Story list: identical to the classic page's window and reason filters.
  const rows = useMemo(() => {
    let r = snap?.customers ?? [];
    if (since === 'ttm' && snap) r = r.filter((x) => x.churn_month >= snap.ttm.window_start && (!snap.ttm.window_end || x.churn_month <= snap.ttm.window_end));
    else if (since === '24m' && snap) {
      const [y, m] = snap.ttm.window_start.split('-').map(Number);
      const cut = `${y - 1}-${String(m).padStart(2, '0')}`;
      r = r.filter((x) => x.churn_month >= cut);
    }
    if (reason) r = r.filter((x) => matchesReason(x, reason));
    return r;
  }, [snap, reason, since]);

  // Chart: fill the sparse churn months with zeros so the range is a span of calendar months.
  const byMonth = useMemo(() => new Map((snap?.monthly ?? []).map((m) => [m.month, m])), [snap]);
  const allMonths = useMemo(() => {
    const ms = snap?.monthly ?? [];
    if (!ms.length) return [] as string[];
    const out: string[] = [];
    for (let m = ms[0].month; m <= ms[ms.length - 1].month; m = addMonths(m, 1)) out.push(m);
    return out;
  }, [snap]);
  const range = useMonthRange(allMonths);
  const cur = thisMonth();
  const mTitle = (m: string) => `${mlabel(m)}${m >= cur ? ' (in progress)' : ''}`;
  const chartSeries = [{
    key: metric, label: metric === 'customers' ? 'Customers lost' : 'MRR lost', tone: 'div-5',
    values: range.months.map((m) => (metric === 'customers' ? byMonth.get(m)?.customers ?? 0 : byMonth.get(m)?.mrr_lost ?? 0)),
  }];
  const inRange = range.months.reduce((a, m) => ({ c: a.c + (byMonth.get(m)?.customers ?? 0), v: a.v + (byMonth.get(m)?.mrr_lost ?? 0) }), { c: 0, v: 0 });
  const openMonths = (months: string[], title: string) => {
    const set = new Set(months);
    setSheet({ title, list: all.filter((r) => set.has(r.churn_month)) });
  };

  const t = snap?.totals; const ttm = snap?.ttm;
  const ttmRows = useMemo(() => (snap ? snap.customers.filter((x) => x.churn_month >= snap.ttm.window_start && (!snap.ttm.window_end || x.churn_month <= snap.ttm.window_end)) : []), [snap]);
  const windowText = ttm ? `${mlabel(ttm.window_start)} to ${mlabel(ttm.window_end ?? ttm.window_start)}` : '';

  const exportCsv = () => downloadCsv('churn_timeline',
    ['Churn month', 'Customer', 'MRR at churn', 'Peak MRR', 'Decline from peak', 'Months declining', 'Tenure (yrs)', 'Lifetime', 'Reason', 'Source', 'Pattern', 'Orders decline', 'Failed payments (final 6mo)', 'Evidence'],
    rows.map((r) => [r.churn_month, r.name, r.mrr_at_churn, r.peak_mrr, r.decline_from_peak_pct ?? '', r.months_declining_before_churn, r.tenure_years ?? '',
      r.lifetime_subscription, r.reason ?? '', r.reason_source, r.subpattern_label ?? '', r.orders_decline_pct ?? '', r.failed_payments_final_6mo, r.evidence_quote ?? '']));

  // ---- one churn as a card: when, who, what it cost, why, and the run-up
  const StoryCard = ({ r, inSheet }: { r: Row; inSheet?: boolean }) => {
    const src = sourceOf(r.reason_source);
    const signals = runUp(r);
    const body = (
      <>
        <div className="am-row am-row--spread">
          <div className="am-row am-row--wrap">
            <span className="am-card__text">{mlabel(r.churn_month)}</span>
            <button className="am-btn am-btn--text" onClick={() => openCustomer(r)}>{r.name}</button>
            <Tag tone="error">{usd(r.mrr_at_churn)}/mo lost</Tag>
            <span className="am-card__text">{tenure(r)} · {usd(r.lifetime_subscription)} lifetime{r.segment ? ` · ${r.segment}` : ''}{r.owner ? ` · ${r.owner}` : ''}</span>
          </div>
          {r.hubspot_url && <a className="am-btn am-btn--text" href={r.hubspot_url} target="_blank" rel="noopener noreferrer">HubSpot<Icon name="open_in_new" /></a>}
        </div>
        <div className="am-row am-row--wrap">
          <Tag tone={src.tone} help={src.help}>{src.label}</Tag>
          {r.reason ? <span className="am-chart__title">{r.reason}</span> : <Tag tone="warning">No reason established</Tag>}
          {r.subpattern_label && <Tag tone="neutral">{r.subpattern_parent ? `${r.subpattern_parent} · ${r.subpattern_label}` : r.subpattern_label}</Tag>}
        </div>
        {signals.length > 0 && <div className="am-row am-row--wrap">{signals}</div>}
        {r.evidence_quote && <p className="am-card__text"><i>“{r.evidence_quote}”{r.evidence_date ? ` (${r.evidence_date})` : ''}</i></p>}
      </>
    );
    return inSheet ? <div style={{ display: 'grid', gap: 12 }}>{body}</div>
      : <article className="am-card am-card--outlined" style={{ display: 'grid', gap: 8 }}>{body}</article>;
  };

  // ---- a customer list (side sheets), sortable, with its Total row
  const CustomerTable = ({ list, label }: { list: Row[]; label: string }) => (
    list.length ? (
      <DataTable label={label}
        cols={[['Churned', false], ['Customer', false], ['MRR at churn', true], ['Lifetime', true], ['Tenure', true], ['Reason', false], ['Source', false]]}
        rows={list.map((r) => [mlabel(r.churn_month), r.name, usd(r.mrr_at_churn), usd(r.lifetime_subscription), tenure(r), r.reason ?? 'No reason established',
          <Tag key="s" tone={sourceOf(r.reason_source).tone}>{sourceOf(r.reason_source).label}</Tag>])}
        sortValues={list.map((r) => [r.churn_month, r.name, r.mrr_at_churn, r.lifetime_subscription, r.tenure_years, r.reason ?? '', r.reason_source])}
        clickable={(c) => c === 1} onCell={(i) => setStory(list[i])}
        foot={[`Total · ${list.length} customers`, '', usd(list.reduce((a, r) => a + r.mrr_at_churn, 0)), usd(list.reduce((a, r) => a + r.lifetime_subscription, 0)), '', '', '']} />
    ) : <p className="am-card__text">No churned customers here.</p>
  );

  // ---- reason / pattern tallies (all time, as in the classic page)
  const TallyCard = ({ title, caption, list, field }: { title: string; caption: string; list: Tally[]; field: 'reason' | 'pattern' }) => {
    const shown = allReasons ? list : list.slice(0, TALLY_LIMIT);
    const custFor = (k: string) => all.filter((r) => (field === 'reason' ? matchesReason(r, k) : (r.subpattern_label ?? '(unclassified)') === k));
    return (
      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">{title}</span>
          <span className="am-chart__caption">{caption}</span>
        </div>
        <DataTable label={title} cols={[[field === 'reason' ? 'Reason' : 'Pattern', false], ['MRR lost', true], ['Customers', true]]}
          rows={shown.map((r) => [r.key, usd(r.mrr_lost), r.customers.toLocaleString()])}
          sortValues={shown.map((r) => [r.key, r.mrr_lost, r.customers])}
          clickable={(c) => c >= 1} onCell={(i) => setSheet({ title: `${field === 'reason' ? 'Reason' : 'Pattern'}: ${shown[i].key}`, text: 'All time.', list: custFor(shown[i].key) })}
          foot={[`Total · ${list.length} ${field === 'reason' ? 'reasons' : 'patterns'}`, usd(list.reduce((a, r) => a + r.mrr_lost, 0)), list.reduce((a, r) => a + r.customers, 0).toLocaleString()]}
          footClickable={(c) => c >= 1} onFoot={() => { setAllReasons(true); setSheet({ title: 'Every churned customer', text: 'All time, newest first.', list: all }); }} />
        {!allReasons && list.length > TALLY_LIMIT && <button className="am-btn am-btn--text" onClick={() => setAllReasons(true)}>Show all {list.length}</button>}
      </section>
    );
  };

  const storyShown = showAll ? rows : rows.slice(0, STORY_LIMIT);
  const windowLabel = since === 'ttm' ? 'last 12 months' : since === '24m' ? 'last 24 months' : 'all time';

  return (
    <DsPage
      path="/churn-timeline"
      title="Churn Timeline"
      subtitle="Every churned customer in the order they left, with the run-up that explains why."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />Export CSV</button>}
      overlays={<>
        {sheet && (
          <SideSheet open onClose={() => setSheet(null)} title={sheet.title} text={sheet.text}>
            <div style={{ overflowX: 'auto' }}>{CustomerTable({ list: sheet.list, label: sheet.title })}</div>
          </SideSheet>
        )}
        {story && (
          <SideSheet open onClose={() => setStory(null)} title={story.name} text={`Churned ${mlabel(story.churn_month)} · last paid ${mlabel(story.last_paid_month)}`}>
            {StoryCard({ r: story, inSheet: true })}
          </SideSheet>
        )}
      </>}
    >
      {error ? <p className="am-card__text">Could not load churn_timeline: {String(error)}</p> : null}
      {isLoading && <p className="am-card__text">Loading…</p>}

      {snap && ttm && t && (
        <KpiGrid>
          <KpiCard label="Churned · last 12 months" value={String(ttm.churned_customers)}
            hint={`${usd(ttm.mrr_lost)} of MRR · ${windowText}`} tag="Lost" tagTone="error"
            onOpen={() => setSheet({ title: `Churned · ${windowText}`, text: 'Churn month is the first un-invoiced month. Lapsed and paused customers are not in this list.', list: ttmRows })} />
          <KpiCard label="Not yet churned · last 12 months" value={String((ttm.lapsed_customers ?? 0) + (ttm.paused_customers ?? 0))}
            hint={`${ttm.lapsed_customers ?? 0} lapsed (${usd(ttm.lapsed_mrr ?? 0)}) · ${ttm.paused_customers ?? 0} paused (${usd(ttm.paused_mrr ?? 0)}) · not counted as churn`}
            tag="Watch" tagTone="warning" />
          <KpiCard label="Average tenure at churn" value={ttm.avg_tenure_years != null ? `${ttm.avg_tenure_years.toFixed(1)}y` : '—'} hint="Last 12 months" />
          <KpiCard label="Declined before leaving" value={`${ttm.declined_first} of ${ttm.churned_customers}`} hint={`${ttm.left_at_full_price} left at full price`}
            tag="Early warning" tagTone="warning"
            onOpen={() => setSheet({ title: 'Declined before leaving · last 12 months', text: 'Shrank from their peak or had months of decline before they left.', list: ttmRows.filter((r) => !(r.months_declining_before_churn === 0 && (r.decline_from_peak_pct ?? 0) >= -0.01)) })} />
          <KpiCard label="Churned all time" value={t.churned_customers.toLocaleString()} hint={`${usd(t.lifetime_lost)} lifetime revenue`}
            onOpen={() => setSheet({ title: 'Every churned customer', text: 'All time, newest first.', list: all })} />
          <KpiCard label="Undiagnosed" value={String(t.unexplained)} hint={`${t.researched} properly researched`}
            tag={t.unexplained > 0 ? 'Needs research' : 'All diagnosed'} tagTone={t.unexplained > 0 ? 'warning' : 'success'}
            onOpen={() => setSheet({ title: 'Undiagnosed churns', text: 'Nobody has established why these customers left.', list: all.filter((r) => r.reason == null) })} />
        </KpiGrid>
      )}

      {snap && (
        <ChartCard title="Churn by month" caption={`Churn month is the first un-invoiced month: confirmed by a Stripe cancellation, a HubSpot Cancelled status or churn reason, or three months unbilled. Paused accounts are never churn. Not HubSpot's cancellation date, which is often months later. · ${range.rangeText} · ${inRange.c} customers, ${usd(inRange.v)} MRR · select a month to see who left`}>
          <div className="am-row am-row--wrap">
            {range.controls}
            <Segmented label="Show" value={metric} onChange={setMetric} options={[['customers', 'Customers lost'], ['mrr', 'MRR lost']]} />
          </div>
          <ColumnChart months={range.months} series={chartSeries} fmt={metric === 'customers' ? (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) : usdk}
            labelFor={(i) => { const v = chartSeries[0].values[i]; return v ? (metric === 'customers' ? String(v) : usdk(v)) : null; }}
            catTitle={mTitle}
            tipRows={(i) => { const m = byMonth.get(range.months[i]); return [['Customers lost', String(m?.customers ?? 0)], ['MRR lost', usd(m?.mrr_lost ?? 0)]]; }}
            onSegment={(i) => openMonths([range.months[i]], `Churned · ${mTitle(range.months[i])}`)}
            aria={`Churn by month, ${metric === 'customers' ? 'customers lost' : 'MRR lost'}, ${range.rangeText}.`} />
        </ChartCard>
      )}

      {snap && (
        <section className="am-card am-card--outlined" style={{ display: 'grid', gap: 12 }}>
          <div className="am-row am-row--spread">
            <div className="am-chart__head">
              <span className="am-chart__title">The stories · {rows.length}</span>
              <span className="am-chart__caption">One per churn, newest first · {windowLabel} · {usd(rows.reduce((a, r) => a + r.mrr_at_churn, 0))} MRR lost. The run-up tags show how far they had shrunk, how long they were shrinking, whether orders fell and whether payments failed. The source tag says how well the reason is known.</span>
            </div>
          </div>
          <div className="am-row am-row--wrap">
            <Segmented label="View" value={view} onChange={setView} options={[['stories', 'Stories'], ['table', 'Table']]} />
            <div className="am-row am-row--tight">
              <span className="am-card__text">Window</span>
              <Select label="Window" value={since} onPick={(v) => { setSince(v); setShowAll(false); }} width={170}
                options={[['ttm', 'Last 12 months'], ['24m', 'Last 24 months'], ['all', 'All time']]} />
            </div>
            <div className="am-row am-row--tight">
              <span className="am-card__text">Reason</span>
              <Select label="Reason" value={reason} onPick={(v) => { setReason(v); setShowAll(false); }} width={300}
                options={[['', 'All reasons'], ...snap.by_reason.map((r) => [r.key, `${r.key} (${r.customers})`] as [string, string])]} />
            </div>
            {reason && <button className="am-btn am-btn--text" onClick={() => setReason('')}>Clear reason</button>}
          </div>

          {rows.length === 0 && <p className="am-card__text">No churns match this filter.</p>}

          {view === 'stories' && storyShown.map((r) => <div key={r.allmoxy_customer_id} style={{ display: "contents" }}>{StoryCard({ r })}</div>)}

          {view === 'table' && rows.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Churned customers"
                cols={[['Churned', false], ['Customer', false], ['MRR at churn', true], ['Peak MRR', true], ['From peak', true], ['Months declining', true], ['Tenure', true], ['Lifetime', true], ['Reason', false], ['Source', false]]}
                rows={storyShown.map((r) => [mlabel(r.churn_month), r.name, usd(r.mrr_at_churn), usd(r.peak_mrr), spct(r.decline_from_peak_pct), String(r.months_declining_before_churn), tenure(r),
                  usd(r.lifetime_subscription), r.reason ?? 'No reason established', <Tag key="s" tone={sourceOf(r.reason_source).tone}>{sourceOf(r.reason_source).label}</Tag>])}
                sortValues={storyShown.map((r) => [r.churn_month, r.name, r.mrr_at_churn, r.peak_mrr, r.decline_from_peak_pct, r.months_declining_before_churn, r.tenure_years, r.lifetime_subscription, r.reason ?? '', r.reason_source])}
                clickable={(c) => c === 1} onCell={(i) => setStory(storyShown[i])}
                foot={[`Total · ${rows.length} customers`, '', usd(rows.reduce((a, r) => a + r.mrr_at_churn, 0)), usd(rows.reduce((a, r) => a + r.peak_mrr, 0)), '', '', '', usd(rows.reduce((a, r) => a + r.lifetime_subscription, 0)), '', '']}
                footClickable={(c) => c === 0 || c === 2 || c === 3 || c === 7}
                onFoot={() => { setShowAll(true); setSheet({ title: `The stories · ${windowLabel}${reason ? ` · ${reason}` : ''}`, list: rows }); }} />
            </div>
          )}

          {!showAll && rows.length > STORY_LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {rows.length}</button>}
          {showAll && rows.length > STORY_LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show the newest {STORY_LIMIT}</button>}
        </section>
      )}

      {snap && (
        <div className="am-grid" style={{ ['--am-grid-min' as string]: '420px' }}>
          {TallyCard({ title: "Why they left", caption: "All time · MRR at churn · select a reason to see its customers", list: snap.by_reason, field: "reason" })}
          {TallyCard({ title: "Pattern", caption: "All time · finer pattern within the reason", list: snap.by_subpattern, field: "pattern" })}
        </div>
      )}
    </DsPage>
  );
}
