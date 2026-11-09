/**
 * Cohort Retention on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (CohortRetention.tsx, kept at
 * /cohort-retention-classic): same cohort_retention and customer_base snapshots, same pre-2018
 * filter, same overall retention maths, same triangle (yearly steps, or the first 36 monthly
 * steps), same member scoping when a month is drilled, same CSV columns and filenames.
 *
 * The design system has no certified heatmap, so the retention triangle is a DataTable (cohort
 * rows by step columns) holding the percentages as text. Instead of hand-coloured cells, each
 * cohort carries a "Latest" status tag (word + tone) for where it stands at its last step, using
 * the classic page's colour bands as the cut points.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, SideSheet, Switch,
  downloadCsv, mlabel, usd,
} from '../design-system/parts';

type CohortRow = { year: number; initial: number; active: number; churned: number; retentionPct: number | null };
type TriangleCell = {
  yearsSince: number; month: string; activeLogos: number; subscription: number; services: number;
  logoRetentionPct: number | null; dollarRetentionPct: number | null;
};
type CohortMember = {
  allmoxy_customer_id: number; name: string | null; first_payment: string | null; last_payment: string | null;
  streams: string[]; lifetime_revenue: number; active_today: boolean;
};
type TriangleCellMonthly = TriangleCell & { monthsSince: number };
type TriangleEntry = {
  seriesMonthly?: TriangleCellMonthly[]; baselineMonth: string; baselineLogos: number; baselineDollar: number;
  initialLogos: number; series: TriangleCell[]; members: CohortMember[];
};
type CohortSnapshot = {
  totalCustomers: number; activeToday: number; cohortSummary: CohortRow[]; cohortYears: number[];
  cohortTriangle: Record<string, TriangleEntry>; notes: string; activeTodayAsOf?: string | null;
};
type Metric = 'dollar' | 'logo';
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
type Drill = { years: number[]; month?: string; label: string; filterStart?: 'all' | 'active' | 'cancelled' };

// Three years of months is where the retention signal lives (classic MONTH_CAP).
const MONTH_CAP = 36;
const LIMIT = 25;

// Status words for a retention figure, cut at the classic page's colour bands. Dollar retention
// can pass 100% through expansion; logo retention almost never does, so the bands differ.
function dollarStatus(p: number | null): [string, Tone] | null {
  if (p == null) return null;
  if (p >= 100) return ['Expanding', 'success'];
  if (p >= 90) return ['Holding', 'neutral'];
  if (p >= 50) return ['Shrinking', 'warning'];
  return ['Mostly lost', 'error'];
}
function logoStatus(p: number | null): [string, Tone] | null {
  if (p == null) return null;
  if (p >= 60) return ['Strong', 'success'];
  if (p >= 25) return ['Watch', 'warning'];
  return ['Weak', 'error'];
}
// Current retention by cohort (classic bar colours: green 80+, amber 50+, orange 25+, red below).
function currentStatus(p: number | null): [string, Tone] | null {
  if (p == null) return null;
  if (p >= 80) return ['Strong', 'success'];
  if (p >= 50) return ['Fair', 'warning'];
  if (p >= 25) return ['Weak', 'error'];
  return ['Mostly lost', 'error'];
}
const Tag = ({ s }: { s: [string, Tone] | null }) => (s ? <span className={`am-tag am-tag--${s[1]}`}>{s[0]}</span> : <>—</>);

export default function CohortRetentionDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('cohort_retention');
  const snap = data as unknown as CohortSnapshot | undefined;
  // "Active today" is the canonical customer base, labelled with the base's own as-of month.
  const { data: baseData } = useSheetTab('customer_base');
  const baseAsOf = (baseData as unknown as { as_of?: string } | undefined)?.as_of ?? snap?.activeTodayAsOf ?? null;
  const activeAsOfLabel = baseAsOf
    ? (() => { const [y, m] = baseAsOf.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' }); })()
    : 'the latest complete month';

  const [metric, setMetric] = useState<Metric>('dollar');
  const [grain, setGrain] = useState<'year' | 'month'>('year');
  const [showPre2018, setShowPre2018] = useState(false);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillFilter, setDrillFilter] = useState<'all' | 'active' | 'cancelled'>('all');
  const [drillAll, setDrillAll] = useState(false);
  const openDrill = (d: Drill) => { setDrill(d); setDrillFilter(d.filterStart ?? 'all'); setDrillAll(false); };
  const openCohort = (year: number, month?: string) => openDrill({ years: [year], month, label: `${year} cohort` });

  const allCohorts = snap?.cohortSummary ?? [];
  const cohorts = showPre2018 ? allCohorts : allCohorts.filter((c) => c.year >= 2018);
  const pre2018Count = allCohorts.filter((c) => c.year < 2018).length;
  const overallRetention = snap && snap.totalCustomers > 0 ? Math.round((100 * snap.activeToday) / snap.totalCustomers * 10) / 10 : null;

  const visibleCohortYears = useMemo(
    () => (snap ? (showPre2018 ? snap.cohortYears : snap.cohortYears.filter((y) => y >= 2018)) : []),
    [snap, showPre2018],
  );
  const maxSteps = useMemo(() => {
    if (!snap) return 0;
    let max = 0;
    for (const y of visibleCohortYears) {
      const e = snap.cohortTriangle[String(y)];
      const n = grain === 'year' ? e?.series.length ?? 0 : e?.seriesMonthly?.length ?? 0;
      if (n > max) max = n;
    }
    return grain === 'year' ? max : Math.min(max, MONTH_CAP);
  }, [snap, visibleCohortYears, grain]);

  // ---- retention triangle as a table: one row per cohort, one column per step
  const tri = useMemo(() => {
    if (!snap) return [];
    return visibleCohortYears.flatMap((year) => {
      const entry = snap.cohortTriangle[String(year)];
      if (!entry) return [];
      const cells = Array.from({ length: maxSteps }, (_, i) => (grain === 'year' ? entry.series[i] : entry.seriesMonthly?.[i]) ?? null);
      const pctOf = (c: TriangleCell | null) => (c ? (metric === 'dollar' ? c.dollarRetentionPct : c.logoRetentionPct) : null);
      const shown = cells.filter((c): c is TriangleCell => !!c);
      const last = shown[shown.length - 1] ?? null;
      return [{ year, entry, cells, pcts: cells.map(pctOf), last, lastPct: pctOf(last) }];
    });
  }, [snap, visibleCohortYears, maxSteps, grain, metric]);
  const status = metric === 'dollar' ? dollarStatus : logoStatus;
  const stepName = (i: number) => (grain === 'year' ? `Year ${i}` : `M${i}`);
  const triCols: Array<[string, boolean]> = [
    ['Cohort', false], ['Signed up', true], ['At baseline', true], ['Baseline $/mo', true], ['Latest', false],
    ...Array.from({ length: maxSteps }, (_, i) => [stepName(i), true] as [string, boolean]),
  ];
  // A cohort with only its baseline step has nothing to judge yet.
  const latestStatus = (r: { last: TriangleCell | null; cells: Array<TriangleCell | null>; lastPct: number | null }): [string, Tone] | null =>
    r.last && r.cells.indexOf(r.last) === 0 ? ['Baseline only', 'neutral'] : status(r.lastPct);
  const hover = (c: TriangleCell) => `${c.month} · ${c.activeLogos} logos · ${usd(c.subscription)}/mo sub` + (c.services > 0 ? ` (+ ${usd(c.services)} services, not counted)` : '');
  const triRows = tri.map((r) => [
    String(r.year), String(r.entry.initialLogos), String(r.entry.baselineLogos), usd(r.entry.baselineDollar),
    r.last ? <span title={`${stepName(r.cells.indexOf(r.last))} · ${hover(r.last)}`} style={{ whiteSpace: 'nowrap' }}><Tag s={latestStatus(r)} /></span> : '—',
    ...r.cells.map((c, i) => {
      const p = r.pcts[i];
      if (!c) return '—';
      // Monthly cells round to whole percent (classic does the same); hover carries the detail.
      return <span title={hover(c)}>{p == null ? '—' : grain === 'year' ? `${p}%` : `${Math.round(p)}`}</span>;
    }),
  ]);
  const triSort = tri.map((r) => [r.year, r.entry.initialLogos, r.entry.baselineLogos, r.entry.baselineDollar, r.lastPct, ...r.pcts]);
  const triTotals = {
    initial: tri.reduce((a, r) => a + r.entry.initialLogos, 0),
    baseline: tri.reduce((a, r) => a + r.entry.baselineLogos, 0),
    dollar: tri.reduce((a, r) => a + r.entry.baselineDollar, 0),
  };
  const visibleLabel = showPre2018 ? 'All cohorts' : 'Cohorts from 2018';
  const openAllVisible = (filterStart: 'all' | 'active' | 'cancelled' = 'all') =>
    openDrill({ years: visibleCohortYears, label: visibleLabel, filterStart });

  // ---- cohort detail totals
  const sumInitial = cohorts.reduce((a, c) => a + c.initial, 0);
  const sumActive = cohorts.reduce((a, c) => a + c.active, 0);
  const sumChurned = cohorts.reduce((a, c) => a + c.churned, 0);
  const thisYear = new Date().getFullYear();

  // ---- drill: cohort members, scoped to who was paying in a month when a step is chosen
  const drillView = useMemo(() => {
    if (!drill || !snap) return null;
    const entries = drill.years.map((y) => snap.cohortTriangle[String(y)]).filter(Boolean);
    let scoped = entries.flatMap((e) => e.members);
    if (drill.month) {
      const [y, m] = drill.month.split('-').map(Number);
      const monthStart = new Date(y, m - 1, 1);
      const monthEnd = new Date(y, m, 0, 23, 59, 59);
      scoped = scoped.filter((mm) => {
        if (!mm.first_payment || !mm.last_payment) return false;
        const fp = new Date(mm.first_payment);
        const lp = new Date(mm.last_payment);
        return fp <= monthEnd && lp >= monthStart;
      });
    }
    const activeCount = scoped.filter((m) => m.active_today).length;
    const members = scoped
      .filter((mm) => (drillFilter === 'all' ? true : drillFilter === 'active' ? mm.active_today : !mm.active_today))
      .sort((a, b) => b.lifetime_revenue - a.lifetime_revenue);
    const signups = entries.reduce((a, e) => a + e.initialLogos, 0);
    return { scoped, members, activeCount, cancelledCount: scoped.length - activeCount, signups };
  }, [drill, snap, drillFilter]);

  const exportDrill = () => {
    if (!drill || !drillView) return;
    const key = drill.years.length === 1 ? String(drill.years[0]) : 'all';
    downloadCsv(`cohort_${key}${drill.month ? `_${drill.month}` : ''}_${drillFilter}`,
      ['Customer', 'Allmoxy ID', 'First payment', 'Last payment', 'Streams', 'Lifetime revenue', 'Status'],
      drillView.members.map((m) => [m.name ?? '', m.allmoxy_customer_id, m.first_payment ?? '', m.last_payment ?? '', m.streams.join(','), m.lifetime_revenue, m.active_today ? 'active' : 'cancelled']));
  };

  const sheet = drill && drillView && (() => {
    const { members, scoped, activeCount, cancelledCount, signups } = drillView;
    const shown = drillAll ? members : members.slice(0, LIMIT);
    const text = drill.month
      ? `Members of the ${drill.label.toLowerCase()} who were paying in ${mlabel(drill.month)}. Sorted by lifetime revenue.`
      : `${signups} signups · ${scoped.filter((m) => m.active_today).length} still active · ${scoped.filter((m) => !m.active_today).length} cancelled · sorted by lifetime revenue.`;
    return (
      <SideSheet open onClose={() => setDrill(null)} title={`${drill.label}${drill.month ? ` · ${mlabel(drill.month)}` : ''} · ${members.length} ${drillFilter === 'all' ? 'members' : drillFilter}`} text={text}>
        <div className="am-row am-row--wrap am-row--spread">
          <Segmented label="Status" value={drillFilter} onChange={(v) => { setDrillFilter(v); setDrillAll(false); }}
            options={[['all', `All · ${scoped.length}`], ['active', `Active · ${activeCount}`], ['cancelled', `Cancelled · ${cancelledCount}`]]} />
          <button className="am-btn am-btn--text" onClick={exportDrill}><Icon name="download" />Export CSV</button>
        </div>
        {members.length ? (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label={`${drill.label} members`}
              cols={[['Customer', false], ['Allmoxy ID', true], ['First payment', false], ['Last payment', false], ['Streams', false], ['Lifetime revenue', true], ['Status', false]]}
              rows={shown.map((m) => [
                m.name ?? '—', String(m.allmoxy_customer_id), m.first_payment ?? '—', m.last_payment ?? '—', m.streams.join(', '),
                usd(m.lifetime_revenue), <Tag s={m.active_today ? ['Active', 'success'] : ['Cancelled', 'neutral']} />,
              ])}
              sortValues={shown.map((m) => [m.name ?? '', m.allmoxy_customer_id, m.first_payment ?? '', m.last_payment ?? '', m.streams.join(', '), m.lifetime_revenue, m.active_today ? 'Active' : 'Cancelled'])}
              clickable={(col) => col === 0}
              onCell={(row) => { const m = shown[row]; navigate(`/customer-detail?id=${encodeURIComponent(String(m.allmoxy_customer_id))}`); }}
              foot={[`Total · ${members.length} customers`, '', '', '', '', usd(members.reduce((a, m) => a + m.lifetime_revenue, 0)), '']}
              footClickable={(col) => col === 0 || col === 5}
              onFoot={() => setDrillAll(true)} />
          </div>
        ) : <p className="am-card__text">No customers match this filter.</p>}
        {!drillAll && members.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setDrillAll(true)}>Show all {members.length}</button>}
      </SideSheet>
    );
  })();

  const okRet = overallRetention != null && overallRetention >= 40;

  return (
    <DsPage
      path="/cohort-retention"
      title="Cohort Retention"
      subtitle="How customers from each signup year retain and expand over time: which vintages are strongest, where churn kicks in, and which cohorts to learn from. Cash basis, because cohorts need multi-year history and the accrual basis only reaches back to Aug 2025, so retention here runs slightly below the accrual figures on the Revenue Waterfall."
      overlays={sheet}
    >
      {error ? <p className="am-card__text">Could not load cohort_retention: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="Customers ever signed up" value={snap && !isLoading ? snap.totalCustomers.toLocaleString() : '…'}
          hint="Everyone who has ever paid, active or churned. Merged from allmoxy_core_customer and Stripe Sync, duplicates removed." />
        <KpiCard label="Active today" value={snap && !isLoading ? snap.activeToday.toLocaleString() : '…'}
          hint={`Live subscription in ${activeAsOfLabel} (the canonical customer base; paused and lapsed accounts not counted)`} />
        <KpiCard label="Overall logo retention" value={snap && !isLoading ? (overallRetention != null ? `${overallRetention}%` : '—') : '…'}
          hint="Active today ÷ customers ever signed up, across all signup vintages · 40% or more is on track"
          tag={overallRetention != null ? (okRet ? 'On track' : 'Watch') : undefined} tagTone={okRet ? 'success' : 'warning'} />
      </KpiGrid>

      <div className="am-row am-row--wrap">
        {pre2018Count > 0 && <Switch checked={showPre2018} onChange={setShowPre2018}>Include pre-2018 cohorts ({pre2018Count})</Switch>}
      </div>

      <ChartCard title="Current logo retention by signup cohort"
        caption="Share of each cohort still paying today · select a column to see its customers">
        {snap ? (
          <ColumnChart months={cohorts.map((c) => String(c.year))} stacked legend
            catLabel={(k) => k} catTitle={(k) => `${k} cohort`}
            series={[
              { key: 'ok', label: '50% or more still paying', tone: 'div-1', values: cohorts.map((c) => (c.retentionPct != null && c.retentionPct >= 50 ? c.retentionPct : 0)) },
              { key: 'low', label: 'Under 50% still paying', tone: 'div-4', values: cohorts.map((c) => (c.retentionPct != null && c.retentionPct < 50 ? c.retentionPct : 0)) },
            ]}
            fmt={(v) => `${Math.round(v * 10) / 10}%`}
            labelFor={(i) => (cohorts[i].retentionPct != null ? `${cohorts[i].retentionPct}%` : null)}
            tipRows={(i) => { const c = cohorts[i]; return [['Retention', c.retentionPct != null ? `${c.retentionPct}%` : '—'], ['Active', `${c.active} of ${c.initial}`], ['Churned', String(c.churned)], ['Status', currentStatus(c.retentionPct)?.[0] ?? '—']]; }}
            onSegment={(i) => openCohort(cohorts[i].year)}
            aria="Current logo retention by signup cohort." />
        ) : <p className="am-card__text">Loading…</p>}
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Retention triangle</span>
          <span className="am-chart__caption">
            Baseline = December of the cohort year · {grain === 'year' ? 'yearly steps' : `monthly steps, first ${MONTH_CAP} months, values are %`} ·
            {metric === 'dollar'
              ? ' subscription $ retention = the cohort\'s share of subscription MRR at each step ÷ its share at baseline (services excluded)'
              : ' logo retention = % of the cohort\'s customers still active at each step'}
            {' '}· hover a figure for logos and MRR, select it to see who was paying that month
          </span>
        </div>
        <div className="am-row am-row--wrap">
          <Segmented label="Metric" value={metric} onChange={setMetric} options={[['dollar', 'Subscription $ retention'], ['logo', 'Logo retention']]} />
          <Segmented label="Steps" value={grain} onChange={setGrain} options={[['year', 'Yearly'], ['month', 'Monthly']]} />
        </div>
        <p className="am-card__text">
          Latest = where the cohort stands at its most recent step: {metric === 'dollar'
            ? 'Expanding 100% or more · Holding 90 to 100% · Shrinking 50 to 90% · Mostly lost under 50%'
            : 'Strong 60% or more · Watch 25 to 60% · Weak under 25%'}.
          {' '}Yearly shows how a vintage holds up over years; monthly shows when inside a year it broke.
        </p>
        {snap ? (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Retention triangle" cols={triCols} rows={triRows} sortValues={triSort}
              clickable={() => true}
              onCell={(row, col) => {
                const r = tri[row];
                if (col >= 5) { const c = r.cells[col - 5]; if (c) openCohort(r.year, c.month); }
                else if (col === 4 && r.last) openCohort(r.year, r.last.month);
                else openCohort(r.year);
              }}
              foot={[`Total · ${tri.length} cohorts`, String(triTotals.initial), String(triTotals.baseline), usd(triTotals.dollar), '', ...Array.from({ length: maxSteps }, () => '')]}
              footClickable={(col) => col <= 3}
              onFoot={() => openAllVisible()} />
          </div>
        ) : <p className="am-card__text">Loading…</p>}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Cohort detail</span>
          <span className="am-chart__caption">Signups, currently active, churned and retention for each signup year · select any figure to see the customers, then export the list to CSV</span>
        </div>
        {snap ? (
          <DataTable label="Cohort detail"
            cols={[['Cohort', false], ['Signups', true], ['Active today', true], ['Churned', true], ['Retention', true], ['Status', false], ['Age', false]]}
            rows={cohorts.map((c) => {
              const ys = thisYear - c.year;
              return [String(c.year), String(c.initial), String(c.active), String(c.churned), c.retentionPct != null ? `${c.retentionPct}%` : '—',
                <Tag s={currentStatus(c.retentionPct)} />, ys === 0 ? 'YTD' : `${ys} year${ys === 1 ? '' : 's'} since`];
            })}
            sortValues={cohorts.map((c) => [c.year, c.initial, c.active, c.churned, c.retentionPct, c.retentionPct, c.year])}
            clickable={() => true}
            onCell={(row, col) => {
              const c = cohorts[row];
              openDrill({ years: [c.year], label: `${c.year} cohort`, filterStart: col === 2 ? 'active' : col === 3 ? 'cancelled' : 'all' });
            }}
            foot={[`Total · ${cohorts.length} cohorts`, String(sumInitial), String(sumActive), String(sumChurned),
              sumInitial ? `${Math.round((1000 * sumActive) / sumInitial) / 10}%` : '—', '', '']}
            footClickable={(col) => col >= 1 && col <= 3}
            onFoot={(col) => openAllVisible(col === 2 ? 'active' : col === 3 ? 'cancelled' : 'all')} />
        ) : <p className="am-card__text">Loading…</p>}
      </section>
    </DsPage>
  );
}
