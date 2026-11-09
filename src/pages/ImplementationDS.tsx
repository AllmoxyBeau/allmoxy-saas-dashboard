/**
 * Implementation on the Allmoxy design system. Data logic is ported verbatim from the classic page
 * (Implementation.tsx, kept at /implementation-classic): same 'implementation' snapshot, same live
 * 90-day SLA clock (anchored on effective_start_date, else sign-up), same view / stage / SLA /
 * account-rep / implementation-rep filters, same sort keys and the same CSV columns.
 *
 * The page leads with the time-to-first-order worklist: initial implementations, oldest first.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, Segmented, Select, downloadCsv, usd,
} from '../design-system/parts';

type Row = {
  allmoxy_customer_id: number;
  name: string;
  customer_status: string | null;
  account_rep: string | null;
  sign_up_date: string | null;
  restart_date: string | null;
  effective_start_date: string | null;
  first_payment_date: string | null;
  launch_status: 'pre_launch' | 'launched' | 'unknown';
  is_launched: boolean | null;
  implementation_type: 'Initial implementation' | 'Catalog update' | 'Unknown';
  first_order_year: number | null;
  time_to_first_order_months: number | null;
  ttv_category: string | null;
  days_since_signup: number | null;
  has_jira: boolean;
  jira_key: string | null;
  jira_url: string | null;
  stage: string | null;
  stage_category: string | null;
  assignee: string | null;
  has_harvest: boolean;
  harvest_project_name: string | null;
  billing_method: string | null;
  hourly_rate: number | null;
  hours: number;
  billable_hours: number;
  billable_amount: number;
  last_entry: string | null;
  is_active: boolean;
};
type Aggregates = {
  total_customers: number; active: number; initial_implementation: number; catalog_update: number; unknown_launch: number;
  initial_overdue: number; initial_at_risk: number;
  initial_by_sla: { on_track: number; at_risk: number; overdue: number; unknown: number };
  stalled_gym_members: number; median_months_to_first_order: number | null;
  with_jira: number; with_harvest: number; total_hours: number; total_billable_amount: number;
  by_stage: Record<string, number>; jira_unmatched_count: number; jira_epics_total: number; jira_matched: number;
};
type Snapshot = { fetchedAt: string; aggregates: Aggregates; rows: Row[]; unmatched_jira_epics?: Array<{ key: string; summary: string; stage: string | null }> };

const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const STAGE_ORDER = ['Stage 1: Discovery', 'Stage 2: Prototyping', 'Waiting on Customer', 'Done', 'On Hold / Abandoned'];
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
// Stage status as a word and a tone (classic: discovery/prototyping blue, waiting amber, done green, hold grey).
function stageTone(stage: string | null): Tone {
  if (!stage) return 'neutral';
  if (/waiting/i.test(stage)) return 'warning';
  if (/done/i.test(stage)) return 'success';
  if (/hold|abandon/i.test(stage)) return 'neutral';
  return 'info';
}
// Chart tones: steady work blue, done green, waiting on the customer is the bad direction (yellow), parked neutral.
function stageSeriesTone(stage: string): string {
  if (/waiting/i.test(stage)) return 'div-3';
  if (/done/i.test(stage)) return 'div-2';
  if (/hold|abandon/i.test(stage)) return 'other';
  return 'div-1';
}

type Sla = 'on_track' | 'at_risk' | 'overdue' | 'unknown';
const SLA: Record<Sla, { label: string; word: string; tone: Tone; series: string }> = {
  on_track: { label: 'On track (<60d)', word: 'On track', tone: 'success', series: 'div-2' },
  at_risk: { label: 'At risk (60–90d)', word: 'At risk', tone: 'warning', series: 'div-3' },
  overdue: { label: 'Overdue (>90d)', word: 'Overdue', tone: 'error', series: 'div-5' },
  unknown: { label: 'No sign-up date', word: 'No date', tone: 'neutral', series: 'other' },
};
function daysSince(date: string | null): number | null {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}
// SLA / age anchor: restart_date when the customer paused then reactivated, else sign-up.
function ageAnchor(r: { effective_start_date: string | null; sign_up_date: string | null }): string | null {
  return r.effective_start_date || r.sign_up_date;
}
function slaOf(days: number | null): Sla {
  if (days == null) return 'unknown';
  if (days > 90) return 'overdue';
  if (days >= 60) return 'at_risk';
  return 'on_track';
}
const TYPE_WORD: Record<string, { word: string; tone: Tone }> = {
  'Initial implementation': { word: 'Initial', tone: 'info' },
  'Catalog update': { word: 'Catalog', tone: 'neutral' },
  Unknown: { word: 'Unknown', tone: 'neutral' },
};
const stageRank = (r: Row) => { const i = STAGE_ORDER.indexOf(r.stage || ''); return i === -1 ? 99 : i; };

type View = 'initial' | 'catalog' | 'all';
const LIMIT = 25;

export default function ImplementationDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab<Snapshot>('implementation');
  const snap = data as Snapshot | undefined;
  const rows = useMemo(() => snap?.rows ?? [], [snap]);
  const agg = snap?.aggregates;

  const [view, setViewRaw] = useState<View>('initial');
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [slaFilter, setSlaFilter] = useState<Sla | null>(null);
  const [repFilter, setRepFilter] = useState<string | null>(null);
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [order, setOrder] = useState<number[] | null>(null);
  // Same as the classic toggle: switching view clears stage/SLA filters and resets the sort.
  const setView = (v: View) => { setViewRaw(v); setStageFilter(null); setSlaFilter(null); setShowAll(false); };

  const countBy = (pick: (r: Row) => string | null) => {
    const counts = new Map<string, number>();
    for (const r of rows) { const k = pick(r); if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
    return counts;
  };
  const repOptions = useMemo(() => [...countBy((r) => r.account_rep).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const assigneeOptions = useMemo(() => [...countBy((r) => r.assignee).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])), [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const stageOptions = useMemo(() => [...countBy((r) => r.stage).entries()].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a[0]); const ib = STAGE_ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a[0].localeCompare(b[0]);
  }), [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const stageChart = useMemo(() => {
    const by = agg?.by_stage ?? {};
    return [...STAGE_ORDER.filter((s) => by[s] != null).map((s) => ({ stage: s, count: by[s] })),
      ...Object.keys(by).filter((s) => !STAGE_ORDER.includes(s)).map((s) => ({ stage: s, count: by[s] }))];
  }, [agg]);

  // Live SLA aging buckets for the pre-launch (initial) set.
  const initialRows = useMemo(() => rows.filter((r) => r.launch_status === 'pre_launch'), [rows]);
  const slaChart = useMemo(() => {
    const b: Record<Sla, number> = { on_track: 0, at_risk: 0, overdue: 0, unknown: 0 };
    for (const r of initialRows) b[slaOf(daysSince(ageAnchor(r)))] += 1;
    return (['on_track', 'at_risk', 'overdue', ...(b.unknown ? ['unknown'] : [])] as Sla[]).map((key) => ({ key, count: b[key] }));
  }, [initialRows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (view === 'initial' && r.launch_status !== 'pre_launch') return false;
    if (view === 'catalog' && r.launch_status !== 'launched') return false;
    if (stageFilter && r.stage !== stageFilter) return false;
    if (slaFilter && slaOf(daysSince(ageAnchor(r))) !== slaFilter) return false;
    if (repFilter && r.account_rep !== repFilter) return false;
    if (assigneeFilter && r.assignee !== assigneeFilter) return false;
    return true;
  }), [rows, view, stageFilter, slaFilter, repFilter, assigneeFilter]);

  const totHours = filtered.reduce((s, r) => s + (r.has_harvest ? r.hours : 0), 0);
  const totBillable = filtered.reduce((s, r) => s + (r.has_harvest ? r.billable_amount : 0), 0);

  // CSV: same columns as the classic export, in the table's current order.
  const exportCsv = () => {
    const list = order && order.length === filtered.length ? order.map((i) => filtered[i]) : filtered;
    downloadCsv('implementation',
      ['Customer', 'Allmoxy ID', 'Type', 'Sign-up Date', 'Days Since Sign-up', 'Launched (first order)', 'First Order Year', 'Time to First Order (mo, approx)', 'Stage', 'Account rep', 'Assignee (JIRA)', 'Hours', 'Billable $', 'Last Time Entry', 'JIRA'],
      list.map((r) => [r.name, r.allmoxy_customer_id, r.implementation_type, r.sign_up_date ?? '', daysSince(r.sign_up_date) ?? '',
        r.is_launched == null ? 'unknown' : r.is_launched ? 'yes' : 'no', r.first_order_year ?? '', r.time_to_first_order_months ?? '',
        r.stage ?? '', r.account_rep ?? '', r.assignee ?? '', r.hours, r.billable_amount, r.last_entry ?? '', r.jira_key ?? '']));
  };

  const firstOrderCol = view === 'catalog' ? 'First order' : 'Time to first order';
  const cols: Array<[string, boolean]> = [['Customer', false], ['Account rep', false], ['Type', false], ['Stage', false], [firstOrderCol, false], ['Assignee', false], ['Hours', true], ['Billable $', true], ['JIRA', false]];

  const tableRows = filtered.map((r) => {
    const days = daysSince(ageAnchor(r));
    const sla = slaOf(days);
    return [
      <span key="n" className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        <button className="am-btn am-btn--text" onClick={() => navigate(`/customer-detail?id=${encodeURIComponent(String(r.allmoxy_customer_id))}`)}
          style={{ whiteSpace: 'normal', textAlign: 'left', height: 'auto' }}>{r.name}</button>
        {(r.ttv_category === 'gym_member' || r.restart_date) && (
          <span className="am-row am-row--tight">
            {r.ttv_category === 'gym_member' && <span className="am-tag am-tag--warning">Stalled</span>}
            {r.restart_date && <span className="am-tag am-tag--info">Restarted {r.restart_date.slice(0, 10)}</span>}
          </span>
        )}
      </span>,
      r.account_rep || '—',
      <span key="t" className={`am-tag am-tag--${TYPE_WORD[r.implementation_type]?.tone ?? 'neutral'}`}>{TYPE_WORD[r.implementation_type]?.word ?? 'Unknown'}</span>,
      r.stage ? <span key="s" className={`am-tag am-tag--${stageTone(r.stage)}`}>{r.stage}</span> : '—',
      <span key="f" className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
        {r.launch_status === 'launched' ? (
          <span className="am-row am-row--tight">
            <span className="am-tag am-tag--success">{r.first_order_year ? `Live ${r.first_order_year}` : 'Launched'}</span>
            {r.time_to_first_order_months != null && <span className="am-card__text">~{r.time_to_first_order_months} mo</span>}
          </span>
        ) : r.launch_status === 'pre_launch' ? (
          <span className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
            <span className={`am-tag am-tag--${SLA[sla].tone}`}>{days != null ? `${days}d · ${SLA[sla].word}` : SLA[sla].word}</span>
            <span className="am-card__text">{r.restart_date ? 'since restart, no order yet' : 'since sign-up, no order yet'}</span>
          </span>
        ) : <span className="am-tag am-tag--neutral">Unknown</span>}
        {r.sign_up_date && <span className="am-card__text">Signed up {r.sign_up_date.slice(0, 10)}</span>}
      </span>,
      r.assignee || '—',
      r.has_harvest ? NUM.format(r.hours) : '—',
      r.has_harvest ? usd(r.billable_amount) : '—',
      r.jira_url ? <a key="j" className="am-btn am-btn--text" href={r.jira_url} target="_blank" rel="noopener noreferrer">{r.jira_key}<Icon name="open_in_new" /></a> : '—',
    ];
  });
  // Raw sort values, the classic's sort keys: age (or first-order year in the catalog view), name, stage rank, hours, billable.
  const sortValues = filtered.map((r) => [
    r.name.toLowerCase(), r.account_rep ?? null, r.implementation_type, stageRank(r),
    view === 'catalog' ? (r.first_order_year ?? 0) : (daysSince(ageAnchor(r)) ?? -1),
    r.assignee ?? null, r.hours, r.billable_amount, r.jira_key ?? null,
  ]);

  const filterCount = [stageFilter, slaFilter, repFilter, assigneeFilter].filter(Boolean).length;
  const viewWord = view === 'initial' ? 'Initial implementations' : view === 'catalog' ? 'Catalog updates' : 'All implementation customers';

  return (
    <DsPage
      path="/implementation"
      title="Implementation"
      subtitle="The implementation team's north star is time to first order. Customers who haven't placed a first verified live order are in initial implementation (racing to first value); already-launched customers doing implementation work are doing catalog updates. First-order target: 90 days from sign-up."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!filtered.length}><Icon name="download" />Export CSV</button>}
    >
      {error ? <p className="am-card__text">Failed to load implementation: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="Overdue to first order" value={isLoading || !agg ? '…' : String(agg.initial_overdue)} hint="Initial implementations more than 90 days past sign-up with no first order"
          tag={agg && agg.initial_overdue > 0 ? 'Needs action' : 'Clear'} tagTone={agg && agg.initial_overdue > 0 ? 'error' : 'success'}
          onOpen={() => { setView('initial'); setSlaFilter('overdue'); }} />
        <KpiCard label="Initial implementations" value={isLoading || !agg ? '…' : String(agg.initial_implementation)} hint="No first verified live order yet: the team's focus list"
          tag="Pre-first-order" tagTone="info" onOpen={() => setView('initial')} />
        <KpiCard label="Stalled paying customers on the boards" value={isLoading || !agg ? '…' : String(agg.stalled_gym_members)}
          hint="Paying, never ran a verified order, and have an implementation project. A subset of Time to Value's gym members."
          tag={agg && agg.stalled_gym_members > 0 ? 'Stalled' : 'None'} tagTone={agg && agg.stalled_gym_members > 0 ? 'warning' : 'success'} />
        <KpiCard label="Median time to first order" value={agg?.median_months_to_first_order != null ? `~${agg.median_months_to_first_order} mo` : '—'}
          hint="Launched customers, sign-up to first order (approximate: live dates are by year)" />
        <KpiCard label="Catalog updates" value={isLoading || !agg ? '…' : String(agg.catalog_update)} hint="Already launched, doing catalog rebuilds or expansions"
          tag="Post-launch" tagTone="neutral" onOpen={() => setView('catalog')} />
        <KpiCard label="Billable services" value={isLoading || !agg ? '…' : usd(agg.total_billable_amount)}
          hint={`${agg ? NUM.format(agg.total_hours) : '—'} hours across all projects, initial and catalog`} />
      </KpiGrid>

      <ChartCard title={view === 'initial' ? 'Time to first order · 90-day target' : 'Implementation stage funnel'}
        caption={view === 'initial'
          ? 'How long initial implementations have gone since sign-up (or restart) without a first order. Select a column to filter the table.'
          : 'Customers at each JIRA implementation stage, all views. Select a column to filter the table.'}>
        <div className="am-row am-row--wrap">
          <Segmented label="View" value={view} onChange={setView} options={[
            ['initial', `Initial (${agg?.initial_implementation ?? 0})`], ['catalog', `Catalog updates (${agg?.catalog_update ?? 0})`], ['all', `All (${agg?.total_customers ?? 0})`],
          ]} />
        </div>
        {isLoading ? <p className="am-card__text">Loading…</p> : view === 'initial' ? (
          slaChart.every((s) => s.count === 0) ? <p className="am-card__text">No initial-implementation customers.</p> : (
            <ColumnChart months={slaChart.map((s) => s.key)} stacked fmt={(v) => NUM.format(v)}
              series={slaChart.map((s, i) => ({ key: s.key, label: SLA[s.key].label, tone: SLA[s.key].series, values: slaChart.map((_, j) => (j === i ? s.count : 0)) }))}
              catLabel={(k) => SLA[k as Sla].label} catTitle={(k) => SLA[k as Sla].label}
              tipRows={(i) => [['Customers', NUM.format(slaChart[i].count)], ['Share of initial', initialRows.length ? `${Math.round((slaChart[i].count / initialRows.length) * 100)}%` : '—']]}
              onSegment={(i) => { const k = slaChart[i].key; setSlaFilter((p) => (p === k ? null : k)); setShowAll(false); }}
              aria="Initial implementations by days since sign-up against the 90-day target." />
          )
        ) : stageChart.length === 0 ? <p className="am-card__text">No JIRA stages found.</p> : (
          <ColumnChart months={stageChart.map((s) => s.stage)} stacked fmt={(v) => NUM.format(v)}
            series={stageChart.map((s, i) => ({ key: s.stage, label: s.stage, tone: stageSeriesTone(s.stage), values: stageChart.map((_, j) => (j === i ? s.count : 0)) }))}
            catLabel={(k) => k.replace(/^Stage \d+: /, '')} catTitle={(k) => k}
            tipRows={(i) => [['Customers', NUM.format(stageChart[i].count)]]}
            onSegment={(i) => { const k = stageChart[i].stage; setStageFilter((p) => (p === k ? null : k)); setShowAll(false); }}
            aria="Customers at each JIRA implementation stage." />
        )}
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">{viewWord} · {filtered.length} customer{filtered.length === 1 ? '' : 's'}</span>
          <span className="am-chart__caption">{view === 'initial' ? 'Oldest first: the customers furthest past the 90-day target lead.' : 'Biggest billable services first.'} Select a customer to open their detail.</span>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Stage</span>
          <Select label="Stage" width={230} value={stageFilter ?? ''} onPick={(v) => { setStageFilter(v || null); setShowAll(false); }}
            options={[['', 'All stages'], ...stageOptions.map(([s, n]) => [s, `${s} (${n})`] as [string, string])]} />
          <span className="am-card__text">Implementation rep</span>
          <Select label="Implementation rep" width={220} value={assigneeFilter ?? ''} onPick={(v) => { setAssigneeFilter(v || null); setShowAll(false); }}
            options={[['', 'All implementers'], ...assigneeOptions.map(([s, n]) => [s, `${s} (${n})`] as [string, string])]} />
          <span className="am-card__text">Account rep</span>
          <Select label="Account rep" width={220} value={repFilter ?? ''} onPick={(v) => { setRepFilter(v || null); setShowAll(false); }}
            options={[['', `All reps (${rows.length})`], ...repOptions.map(([s, n]) => [s, `${s} (${n})`] as [string, string])]} />
        </div>
        {filterCount > 0 && (
          <div className="am-row am-row--wrap">
            <span className="am-card__text">Filtered by</span>
            {stageFilter && <FilterChip checked onChange={() => setStageFilter(null)}>Stage: {stageFilter}</FilterChip>}
            {slaFilter && <FilterChip checked onChange={() => setSlaFilter(null)}>Time to first order: {SLA[slaFilter].word}</FilterChip>}
            {assigneeFilter && <FilterChip checked onChange={() => setAssigneeFilter(null)}>Implementation rep: {assigneeFilter}</FilterChip>}
            {repFilter && <FilterChip checked onChange={() => setRepFilter(null)}>Account rep: {repFilter}</FilterChip>}
            <button className="am-btn am-btn--text" onClick={() => { setStageFilter(null); setSlaFilter(null); setAssigneeFilter(null); setRepFilter(null); }}>Clear all</button>
          </div>
        )}
        {isLoading ? <p className="am-card__text">Loading customers…</p> : filtered.length === 0 ? <p className="am-card__text">No customers match the current view.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable key={view} label="Implementation customers" cols={cols} rows={tableRows} sortValues={sortValues}
              defaultSort={view === 'initial' ? { col: 4, dir: 'desc' } : { col: 7, dir: 'desc' }}
              limit={showAll ? undefined : LIMIT} onSortChange={(o) => setOrder(o)}
              foot={[`Total · ${filtered.length} customers`, '', '', '', '', '', NUM.format(totHours), usd(totBillable), '']}
              onFoot={() => setShowAll(true)} footClickable={(c) => (c === 0 || c === 6 || c === 7) && !showAll && filtered.length > LIMIT} />
          </div>
        )}
        {!isLoading && !showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {filtered.length}</button>}
        {!isLoading && showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show top {LIMIT}</button>}
      </section>

      {snap?.unmatched_jira_epics && snap.unmatched_jira_epics.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-row">
            <span className="am-tag am-tag--warning">{snap.unmatched_jira_epics.length} JIRA epic{snap.unmatched_jira_epics.length === 1 ? '' : 's'} unmatched</span>
            <p className="am-card__text">
              These couldn't be matched to a customer by name and are excluded: {snap.unmatched_jira_epics.map((e) => `${e.key} "${e.summary}"`).join(', ')}. Add them to _etl_scripts/jira_customer_overrides.json and rebuild.
            </p>
          </div>
        </section>
      )}
    </DsPage>
  );
}
