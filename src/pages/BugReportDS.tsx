/**
 * Bug Report on the Allmoxy design system. Data logic is ported from the classic page
 * (BugReport.tsx, kept at /bug-report-classic): same `bug_report` snapshot and totals, same
 * Open / All view and Type / Priority filters, same default sort (MRR affected, highest first),
 * same filed-volume chart with the straight-line projection of the in-progress month or week,
 * and the same CSV columns.
 *
 * Order follows what someone acts on: the customers waiting on a fix (the call list), then the
 * bug list ranked by revenue waiting, then how many bugs are being raised over time.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, Select, SideSheet, downloadCsv, mlabel, useMonthRange, usd,
} from '../design-system/parts';

type Cust = { allmoxy_customer_id: number; name: string; mrr: number; status: string };
type Bug = {
  key: string; issue_type: string; summary: string; status: string; stage_category: string; priority: string;
  issue_score: number | null; created: string; updated: string; resolved: string | null;
  closed_at: string | null; resolution_date_missing: boolean; is_open: boolean; age_days: number | null;
  customers: Cust[]; customer_count: number; mrr_affected: number; active_customers_affected: number; url: string;
};
type Tally = { key: string; bugs: number; mrr_affected: number; open: number };
type WaitingCust = Cust & { open_bugs: number; highest_priority: string | null; oldest_days: number };
type Snap = {
  source: string;
  totals: { bugs: number; open: number; resolved: number; open_mrr_affected: number; customers_waiting: number; unattributed_open: number; closed_without_resolution_date: number };
  age: { median_open_days: number | null; p90_open_days: number | null; median_days_to_resolve: number | null; note: string };
  monthly: Array<{ month: string; filed: number; resolved: number; net: number; open_at_month_end: number; median_days_to_resolve: number | null; partial: boolean }>;
  weekly: Array<{ week: string; filed: number; partial: boolean }>;
  by_priority: Tally[]; by_status: Tally[]; by_type: Tally[];
  customers: WaitingCust[];
  bugs: Bug[];
  unmatched_labels: Array<{ label: string; tickets: number }>;
};

const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const LIMIT = 25;
const PRIORITY_TONE: Record<string, 'error' | 'warning' | 'info' | 'neutral'> = { Highest: 'error', High: 'error', Medium: 'warning', Low: 'info', Lowest: 'neutral', None: 'neutral' };
const PRIORITY_RANK: Record<string, number> = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
const weekLabel = (w: string) => { const [, m, d] = w.split('-'); return `${m}/${d}`; };
const weekTitle = (w: string) => { const [y, m, d] = w.split('-').map(Number); return `Week of ${new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`; };
const priorityTag = (p: string | null) => <span className={`am-tag am-tag--${PRIORITY_TONE[p ?? 'None'] ?? 'neutral'}`}>{p ?? '—'}</span>;

export default function BugReportDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('bug_report');
  const snap = data as unknown as Snap | undefined;
  const [view, setView] = useState<'open' | 'all'>('open');
  const [priority, setPriority] = useState('');
  const [issueType, setIssueType] = useState('');
  const [grain, setGrain] = useState<'month' | 'week'>('month');
  const [showAll, setShowAll] = useState(false);
  const [showAllCust, setShowAllCust] = useState(false);
  const [waitingOpen, setWaitingOpen] = useState(false);
  const order = useRef<number[]>([]); // a ref, not state: the table reports its order on every render
  const range = useMonthRange(useMemo(() => (snap?.monthly ?? []).map((m) => m.month), [snap]));

  // Same filters as the classic page, pre-sorted by its default (MRR affected, highest first).
  const rows = useMemo(() => {
    let r = snap?.bugs ?? [];
    if (view === 'open') r = r.filter((b) => b.is_open);
    if (priority) r = r.filter((b) => b.priority === priority);
    if (issueType) r = r.filter((b) => b.issue_type === issueType);
    return [...r].sort((a, b) => b.mrr_affected - a.mrr_affected);
  }, [snap, view, priority, issueType]);

  // Filed volume, with the classic page's straight-line projection of the in-progress period
  // (filings so far ÷ fraction of the period elapsed, measured against today's date).
  const chart = useMemo(() => {
    const now = new Date();
    if (grain === 'week') {
      const from = range.months[0], to = range.months[range.months.length - 1];
      const all = (snap?.weekly ?? []).filter((w) => !from || (w.week.slice(0, 7) >= from && w.week.slice(0, 7) <= to));
      const dowElapsed = ((now.getDay() + 6) % 7) + 1; // Mon = 1 … Sun = 7
      return all.map((w) => {
        const frac = w.partial ? Math.min(1, dowElapsed / 7) : 1;
        const projTotal = w.partial && frac > 0 ? Math.round(w.filed / frac) : w.filed;
        return { key: w.week, filed: w.filed, extra: w.partial ? Math.max(0, projTotal - w.filed) : 0, total: w.partial ? projTotal : null, partial: w.partial };
      });
    }
    const set = new Set(range.months);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthFrac = Math.min(1, now.getDate() / daysInMonth);
    return (snap?.monthly ?? []).filter((c) => set.has(c.month)).map((c) => {
      const frac = c.partial ? monthFrac : 1;
      const projTotal = c.partial && frac > 0 ? Math.round(c.filed / frac) : c.filed;
      return { key: c.month, filed: c.filed, extra: c.partial ? Math.max(0, projTotal - c.filed) : 0, total: c.partial ? projTotal : null, partial: c.partial };
    });
  }, [snap, grain, range.months]);

  const openCustomer = (id: number) => navigate(`/customer-detail?id=${encodeURIComponent(String(id))}`);

  const exportCsv = () => {
    const list = order.current.length === rows.length ? order.current.map((i) => rows[i]) : rows;
    downloadCsv('bug_report', ['Ticket', 'Summary', 'Status', 'Priority', 'Age (days)', 'MRR affected', 'Customers', 'Filed', 'Closed', 'URL'],
      list.map((b) => [b.key, b.summary, b.status, b.priority, b.age_days ?? '', b.mrr_affected, b.customer_count, b.created ?? '', b.closed_at ?? '', b.url]));
  };

  if (error) {
    return <DsPage path="/bug-report" title="Bug Report" subtitle="Bugs filed on the JIRA DEV board"><p className="am-card__text">Failed to load bug_report: {String(error)}</p></DsPage>;
  }
  if (isLoading || !snap) {
    return <DsPage path="/bug-report" title="Bug Report" subtitle="Loading…"><p className="am-card__text">Loading the DEV-board bugs…</p></DsPage>;
  }

  const t = snap.totals;
  const waiting = snap.customers;
  const waitingIds = new Set(waiting.map((c) => c.allmoxy_customer_id));
  const waitingBugs = snap.bugs.filter((b) => b.is_open && b.customers.some((c) => waitingIds.has(c.allmoxy_customer_id))).sort((a, b) => b.mrr_affected - a.mrr_affected);
  const partialLabel = grain === 'week' ? 'week' : 'month';
  const last = chart[chart.length - 1];

  const bugRows = (list: Bug[]) => list.map((b) => [
    <a key="k" className="am-btn am-btn--text" href={b.url} target="_blank" rel="noopener noreferrer">{b.key}</a>,
    priorityTag(b.priority),
    b.age_days != null ? `${b.age_days}d` : '—',
    b.is_open && (b.age_days ?? 0) > 30 ? <span key="w" className="am-tag am-tag--warning">Over 30 days</span> : '',
    b.mrr_affected > 0 ? usd(b.mrr_affected) : '—',
    b.customer_count ? b.customer_count.toLocaleString() : '—',
    b.created ?? '—',
    <div key="s" style={{ maxWidth: 420 }}>
      <div>{b.summary}</div>
      {b.customers.length > 0 && (
        <div className="am-row am-row--wrap am-row--tight">
          {b.customers.map((c) => <button key={c.allmoxy_customer_id} className="am-btn am-btn--text" onClick={() => openCustomer(c.allmoxy_customer_id)}>{c.name}</button>)}
        </div>
      )}
    </div>,
    <span key="st" className={`am-tag am-tag--${b.is_open ? 'info' : 'success'}`}>{b.status}</span>,
  ]);
  const bugCols: Array<[string, boolean]> = [['Ticket', false], ['Priority', false], ['Age', true], ['Waiting', false], ['MRR affected', true], ['Customers', true], ['Filed', false], ['Summary', false], ['Status', false]];
  const bugSort = (list: Bug[]) => list.map((b) => [b.key, PRIORITY_RANK[b.priority] ?? 0, b.age_days ?? 0, b.is_open && (b.age_days ?? 0) > 30 ? 1 : 0, b.mrr_affected, b.customer_count, b.created ?? '', b.summary, b.status]);

  return (
    <DsPage
      path="/bug-report"
      title="Bug Report"
      subtitle="Every bug on the JIRA DEV board, ranked by the revenue waiting on it rather than only by engineering priority."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />CSV</button>}
      overlays={
        <SideSheet open={waitingOpen} onClose={() => setWaitingOpen(false)} title={`Open bugs with a customer waiting · ${waitingBugs.length}`}
          text="Every open bug tagged with at least one of the customers waiting on a fix.">
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Open bugs with a customer waiting" cols={bugCols} rows={bugRows(waitingBugs)} sortValues={bugSort(waitingBugs)}
              foot={[`Total · ${waitingBugs.length} bugs`, '', '', '', usd(waitingBugs.reduce((a, b) => a + b.mrr_affected, 0)), waitingBugs.reduce((a, b) => a + b.customer_count, 0).toLocaleString(), '', '', '']} />
          </div>
        </SideSheet>
      }
    >
      <KpiGrid>
        <KpiCard label="Open bugs" value={N0.format(t.open)} hint={`of ${N0.format(t.bugs)} ever filed`}
          tag={t.open > 20 ? 'Above 20 open' : '20 or fewer open'} tagTone={t.open > 20 ? 'error' : 'success'} />
        <KpiCard label="MRR affected" value={usd(t.open_mrr_affected)} hint={`${t.customers_waiting} customers waiting`}
          tag={t.open_mrr_affected > 0 ? 'Customers waiting' : 'None waiting'} tagTone={t.open_mrr_affected > 0 ? 'warning' : 'success'}
          onOpen={waitingBugs.length ? () => setWaitingOpen(true) : undefined} />
        <KpiCard label="Median open age" value={snap.age.median_open_days != null ? `${snap.age.median_open_days}d` : '—'} hint={`90th percentile ${snap.age.p90_open_days ?? '—'}d`} />
        <KpiCard label="Median time to fix" value={snap.age.median_days_to_resolve != null ? `${snap.age.median_days_to_resolve}d` : '—'} hint="Resolved bugs" />
        <KpiCard label="Unattributed" value={N0.format(t.unattributed_open)} hint="Open, no customer tagged"
          tag={t.unattributed_open > 0 ? 'Needs tagging' : 'All tagged'} tagTone={t.unattributed_open > 0 ? 'warning' : 'success'}
          onOpen={t.unattributed_open > 0 ? () => { setView('open'); setPriority(''); setIssueType(''); setShowAll(true); document.getElementById('bug-list')?.scrollIntoView({ behavior: 'smooth' }); } : undefined} />
      </KpiGrid>

      {t.closed_without_resolution_date > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread">
            <span className="am-chart__title">Open is decided by stage, not by the resolution date</span>
            <span className="am-tag am-tag--info">How open is counted</span>
          </div>
          <p className="am-card__text">
            {t.closed_without_resolution_date} bugs sit in stage Done (status Resolved, Closed or In Production) with no resolution date recorded in JIRA.
            Trusting that timestamp would report {t.closed_without_resolution_date + t.open} open bugs with a multi-year median age, when {t.open} are genuinely open.
            Those closures are aged to their last update instead.
          </p>
        </section>
      )}

      {waiting.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Customers waiting on a fix · {waiting.length}</span>
            <span className="am-chart__caption">Customers tagged on at least one open bug, ordered by MRR. This is the call list: who to tell what, before they ask.</span>
          </div>
          <DataTable label="Customers waiting on a fix" cols={[['Customer', false], ['MRR', true], ['Open bugs', true], ['Oldest', true], ['Waiting', false], ['Highest priority', false]]}
            rows={waiting.map((c) => [c.name, usd(c.mrr), c.open_bugs.toLocaleString(), `${c.oldest_days}d`,
              c.oldest_days > 30 ? <span key="w" className="am-tag am-tag--warning">Over 30 days</span> : '', priorityTag(c.highest_priority)])}
            sortValues={waiting.map((c) => [c.name, c.mrr, c.open_bugs, c.oldest_days, c.oldest_days > 30 ? 1 : 0, PRIORITY_RANK[c.highest_priority ?? ''] ?? 0])}
            clickable={(col) => col === 0} onCell={(row) => openCustomer(waiting[row].allmoxy_customer_id)}
            limit={showAllCust ? undefined : LIMIT}
            foot={[`Total · ${waiting.length} customers`, usd(waiting.reduce((a, c) => a + c.mrr, 0)), waiting.reduce((a, c) => a + c.open_bugs, 0).toLocaleString(), '', '', '']}
            onFoot={() => setWaitingOpen(true)} footClickable={(c) => c <= 2 && waitingBugs.length > 0} />
          {!showAllCust && waiting.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAllCust(true)}>Show all {waiting.length}</button>}
        </section>
      )}

      <section className="am-card am-card--outlined" id="bug-list">
        <div className="am-row am-row--spread am-row--wrap">
          <div className="am-chart__head">
            <span className="am-chart__title">{view === 'open' ? 'Open bugs' : 'All bugs'} · {rows.length.toLocaleString()}</span>
            <span className="am-chart__caption">MRR affected is the combined subscription MRR of the customers tagged on the ticket: what the business is losing while it waits. A bug at $0 has no customer tagged ({t.unattributed_open} open bugs).</span>
          </div>
          <div className="am-row am-row--wrap">
            <Segmented label="Bugs shown" value={view} onChange={(v) => { setView(v); setShowAll(false); }} options={[['open', 'Open'], ['all', 'All']]} />
            <Select label="Type" width={170} value={issueType} onPick={(v) => { setIssueType(v); setShowAll(false); }}
              options={[['', 'All types'], ...snap.by_type.map((x) => [x.key, `${x.key} (${x.bugs})`] as [string, string])]} />
            <Select label="Priority" width={180} value={priority} onPick={(v) => { setPriority(v); setShowAll(false); }}
              options={[['', 'All priorities'], ...snap.by_priority.map((x) => [x.key, `${x.key} (${x.bugs})`] as [string, string])]} />
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Bugs by MRR affected" cols={bugCols} rows={bugRows(rows)} sortValues={bugSort(rows)}
            defaultSort={{ col: 4, dir: 'desc' }} limit={showAll ? undefined : LIMIT} onSortChange={(o) => { order.current = o; }}
            foot={[`Total · ${rows.length.toLocaleString()} bugs`, '', '', '', usd(rows.reduce((a, b) => a + b.mrr_affected, 0)), rows.reduce((a, b) => a + b.customer_count, 0).toLocaleString(), '', '', '']}
            onFoot={() => setShowAll(true)} footClickable={(c) => !showAll && rows.length > LIMIT && (c === 0 || c === 4 || c === 5)} />
        </div>
        {!showAll && rows.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {rows.length.toLocaleString()}</button>}
        {rows.length === 0 && <p className="am-card__text">No bugs match the current filters.</p>}
        <p className="am-card__text">
          {snap.source} · Bug and Investigate issue types, including tickets with no customer tag.
          {' '}{snap.unmatched_labels.length} customer labels match no roster customer and are excluded from MRR affected.
          {' '}A customer-reported problem triaged onto a Task or New Feature is not counted here: HubSpot's "Bug Reported" resolution is a wider net than JIRA's defect types.
        </p>
      </section>

      <ChartCard title="Bugs filed" caption={`How many bugs are raised over time${range.rangeText ? ` · ${range.rangeText}` : ''}. Weeks start on Monday and quiet weeks show as zero. The current ${partialLabel} is still running: its gray block is the rest of the period at the pace so far, and the projected total is labelled above it.`}>
        <div className="am-row am-row--wrap">
          <Segmented label="Grain" value={grain} onChange={setGrain} options={[['month', 'Monthly'], ['week', 'Weekly']]} />
          {range.controls}
        </div>
        {last?.partial && last.total != null && (
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--neutral">{grain === 'week' ? weekTitle(last.key) : mlabel(last.key)} in progress</span>
            <span className="am-card__text">{N0.format(last.filed)} filed so far · projected {N0.format(last.total)}</span>
          </div>
        )}
        <ColumnChart months={chart.map((c) => c.key)} stacked legend fmt={(v) => N0.format(v)}
          series={[
            { key: 'filed', label: 'Filed', tone: 'div-1', values: chart.map((c) => c.filed) },
            { key: 'extra', label: 'Projected remainder', tone: 'other', values: chart.map((c) => c.extra) },
          ]}
          labelFor={(i) => N0.format(chart[i].total ?? chart[i].filed)}
          tipRows={(i) => { const c = chart[i]; return c.partial ? [['Filed so far', N0.format(c.filed)], ['Projected remainder', N0.format(c.extra)], ['Projected total', N0.format(c.total ?? c.filed)]] : [['Filed', N0.format(c.filed)]]; }}
          catLabel={grain === 'week' ? (k) => weekLabel(k) : undefined}
          catTitle={grain === 'week' ? (k) => `${weekTitle(k)}${chart.find((c) => c.key === k)?.partial ? ' (in progress)' : ''}` : (k) => `${mlabel(k)}${chart.find((c) => c.key === k)?.partial ? ' (in progress)' : ''}`}
          aria="Bugs filed per period, with the in-progress period's projection." />
      </ChartCard>
    </DsPage>
  );
}
