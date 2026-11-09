/**
 * Implementation Schedule on the Allmoxy design system. Data logic is ported verbatim from the
 * classic page (ImplementationSchedule.tsx, kept at /implementation-schedule-classic): same
 * 'implementation' snapshot, same customer filters (view, active only), same status filter
 * (Done hidden by default), same four sort orders, and the same browser edit store
 * (localStorage 'allmoxy.implementation_schedule.v2', { tickets, priorities }) with the same
 * "Copy schedule JSON" payload for implementation_schedule_overrides.json. Edits made on either
 * page are shared.
 *
 * The design system has no certified Gantt / time-block part, so the timeline is a schedule
 * table: one customer row (priority, project span) followed by its ticket rows (status, start
 * and end date fields, length, and a timing tag that says where the ticket sits against today).
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, Segmented, Select, SideSheet, Switch } from '../design-system/parts';

type Priority = 'P1' | 'P2' | 'P3';
type Task = {
  key: string; summary: string; status: string | null; stage_category: string | null; assignee: string | null;
  created: string | null; updated: string | null; due: string | null; url: string;
  start: string | null; end: string | null;
};
type Row = {
  allmoxy_customer_id: number; name: string;
  implementation_type: 'Initial implementation' | 'Catalog update' | 'Unknown';
  launch_status: 'pre_launch' | 'launched' | 'unknown';
  stage: string | null; is_active: boolean; days_since_signup: number | null;
  schedule_start: string | null; schedule_end: string | null; priority: Priority | null;
  task_count: number; tasks_done: number; tasks: Task[];
};
type Snapshot = { fetchedAt: string; rows: Row[] };

// Browser-pending edits overlaid on the committed snapshot values. Same key and shape as the
// classic page, applied to _etl_scripts/implementation_schedule_overrides.json on refresh.
const STORAGE_KEY = 'allmoxy.implementation_schedule.v2';
type Edits = { tickets: Record<string, { start?: string; end?: string }>; priorities: Record<string, Priority | null> };
function readEdits(): Edits {
  try { const raw = localStorage.getItem(STORAGE_KEY); const p = raw ? JSON.parse(raw) : null; return { tickets: p?.tickets ?? {}, priorities: p?.priorities ?? {} }; }
  catch { return { tickets: {}, priorities: {} }; }
}

const PRI_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, '': 3 };
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
function statusTone(cat: string | null): Tone {
  if (cat === 'Done') return 'success';
  if (cat === 'In Progress') return 'info';
  if (cat === 'To Do') return 'neutral';
  return 'warning';
}
const DAY = 86400000;
const toTime = (iso: string | null) => (iso ? new Date(iso + 'T00:00:00').getTime() : null);
const DFMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay = (iso: string | null) => (iso ? DFMT.format(new Date(iso + 'T00:00:00')) : '—');
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

type View = 'all' | 'initial' | 'catalog';
type SortKey = 'priority' | 'start' | 'urgency' | 'name';
const LIMIT = 15; // customers shown before "Show all"

/** Where a ticket sits against today: the table's stand-in for the Gantt's today line. */
function timing(start: string | null, end: string | null, done: boolean, today: number): { word: string; tone: Tone } {
  if (done) return { word: 'Done', tone: 'success' };
  const s = toTime(start), e = toTime(end);
  if (e != null && e < today) return { word: `Past end · ${Math.round((today - e) / DAY)}d`, tone: 'error' };
  if (s != null && s > today) return { word: `Starts in ${Math.round((s - today) / DAY)}d`, tone: 'neutral' };
  if (e != null) return { word: `Ends in ${Math.round((e - today) / DAY)}d`, tone: 'info' };
  return { word: 'No end date', tone: 'warning' };
}
const span = (a: string | null, b: string | null) => { const s = toTime(a), e = toTime(b); return s != null && e != null ? `${Math.max(0, Math.round((e - s) / DAY))}d` : '—'; };

function DateField({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="am-field am-field--outlined" style={{ width: 150, minWidth: 0 }}>
      <input className="am-field__input" type="date" placeholder=" " value={value} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap" /><i /></span>
    </label>
  );
}

export default function ImplementationScheduleDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab<Snapshot>('implementation');
  const allRows = useMemo(() => (data as Snapshot | undefined)?.rows ?? [], [data]);

  const [edits, setEdits] = useState<Edits>(() => readEdits());
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(edits)); } catch { /* ignore */ } }, [edits]);

  const [view, setView] = useState<View>('all');
  const [activeOnly, setActiveOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set()); // empty = all expanded
  const [statusSel, setStatusSel] = useState<string[] | null>(null);  // null = default (hide Done)
  const [showAll, setShowAll] = useState(false);
  const [sheet, setSheet] = useState<'past' | 'unprioritized' | null>(null);
  const [copied, setCopied] = useState(false);
  const toggleCollapse = (id: number) => setCollapsed((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Effective (pending-over-committed) accessors.
  const effPriority = (r: Row): Priority | null => {
    const p = edits.priorities[String(r.allmoxy_customer_id)];
    return p !== undefined ? p : r.priority;
  };
  const effTask = (tk: Task) => {
    const e = edits.tickets[tk.key] || {};
    return { start: e.start ?? tk.start, end: e.end ?? tk.end, dirty: e.start !== undefined || e.end !== undefined };
  };
  const setTicket = (key: string, patch: { start?: string; end?: string }) =>
    setEdits((prev) => ({ ...prev, tickets: { ...prev.tickets, [key]: { ...prev.tickets[key], ...patch } } }));
  const setPriority = (id: number, value: Priority | null) =>
    setEdits((prev) => ({ ...prev, priorities: { ...prev.priorities, [String(id)]: value } }));

  const withTickets = useMemo(() => allRows.filter((r) => r.task_count > 0), [allRows]);
  const noTicketCount = allRows.length - withTickets.length;

  const scoped = useMemo(() => withTickets.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (view === 'initial' && r.launch_status !== 'pre_launch') return false;
    if (view === 'catalog' && r.launch_status !== 'launched') return false;
    return true;
  }), [withTickets, activeOnly, view]);

  const statuses = useMemo(() => {
    const m = new Map<string, { name: string; category: string | null; count: number }>();
    for (const r of scoped) for (const t of r.tasks) {
      const k = t.status || 'Unknown';
      if (!m.has(k)) m.set(k, { name: k, category: t.stage_category, count: 0 });
      m.get(k)!.count += 1;
    }
    return [...m.values()].sort((a, b) => (a.category === 'Done' ? 1 : 0) - (b.category === 'Done' ? 1 : 0) || a.name.localeCompare(b.name));
  }, [scoped]);
  const defaultSel = useMemo(() => statuses.filter((s) => s.category !== 'Done').map((s) => s.name), [statuses]);
  const selectedStatuses = statusSel ?? defaultSel;
  const isSel = (name: string) => selectedStatuses.includes(name);
  const toggleStatus = (name: string) => setStatusSel(() => {
    const cur = statusSel ?? defaultSel;
    return cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
  });

  function urgency(r: Row): number {
    const base = r.days_since_signup ?? 0;
    return r.launch_status === 'pre_launch' ? 1_000_000 + base : base;
  }

  const groups = useMemo(() => {
    const out = scoped.map((r) => ({
      row: r,
      tasks: r.tasks.filter((t) => isSel(t.status || 'Unknown'))
        .sort((a, b) => (toTime(effTask(a).start) ?? Infinity) - (toTime(effTask(b).start) ?? Infinity)),
    })).filter((g) => g.tasks.length > 0);
    out.sort((a, b) => {
      const ra = a.row, rb = b.row;
      switch (sortKey) {
        case 'priority': {
          const d = (PRI_RANK[effPriority(ra) ?? ''] ?? 3) - (PRI_RANK[effPriority(rb) ?? ''] ?? 3);
          return d || (urgency(rb) - urgency(ra));
        }
        case 'urgency': return urgency(rb) - urgency(ra);
        case 'start': return (toTime(a.tasks[0] && effTask(a.tasks[0]).start) ?? Infinity) - (toTime(b.tasks[0] && effTask(b.tasks[0]).start) ?? Infinity);
        case 'name': return ra.name.localeCompare(rb.name);
        default: return 0;
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, selectedStatuses, sortKey, edits]);

  const today = startOfToday();
  const pendingCount = Object.values(edits.tickets).filter((e) => e && (e.start !== undefined || e.end !== undefined)).length
    + Object.keys(edits.priorities).length;
  const visibleTickets = groups.reduce((s, g) => s + g.tasks.length, 0);

  // Acting-on-it counts over what's on screen: open tickets past their end date, and customers with no priority.
  const pastEnd = useMemo(() => groups.flatMap((g) => g.tasks.filter((t) => {
    const e = toTime(effTask(t).end); return t.stage_category !== 'Done' && e != null && e < today;
  }).map((t) => ({ g, t }))), [groups, today]); // eslint-disable-line react-hooks/exhaustive-deps
  const unprioritized = groups.filter((g) => !effPriority(g.row));

  function copyOverridesJson() {
    const customer_priority: Record<string, Priority> = {};
    const tickets: Record<string, { start: string | null; end: string | null }> = {};
    for (const r of allRows) {
      const p = effPriority(r);
      if (p) customer_priority[String(r.allmoxy_customer_id)] = p;
      for (const tk of r.tasks) {
        const e = effTask(tk);
        if (e.dirty || tk['schedule_committed' as keyof Task]) tickets[tk.key] = { start: e.start, end: e.end };
      }
    }
    navigator.clipboard?.writeText(JSON.stringify({ customer_priority, tickets }, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }, () => {});
  }

  const openCustomer = (id: number) => navigate(`/customer-detail?id=${encodeURIComponent(String(id))}`);
  const shownGroups = showAll ? groups : groups.slice(0, LIMIT);

  // Flatten to table rows: a customer row, then its ticket rows (unless collapsed).
  const cols: Array<[string, boolean]> = [['Priority', false], ['Customer / ticket', false], ['Status · assignee', false], ['Start', false], ['End', false], ['Length', true], ['Timing', false]];
  const tableRows: React.ReactNode[][] = [];
  for (const { row: r, tasks } of shownGroups) {
    const pri = effPriority(r);
    const open = !collapsed.has(r.allmoxy_customer_id);
    const priDirty = edits.priorities[String(r.allmoxy_customer_id)] !== undefined;
    tableRows.push([
      // Pick one of a few: segmented buttons, one fixed width on every row (a menu would be clipped by the table's scroller).
      <Segmented key="p" label={`Priority for ${r.name}`} value={pri ?? 'none'} onChange={(v) => setPriority(r.allmoxy_customer_id, v === 'none' ? null : v)}
        options={[['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3'], ['none', 'None']]} />,
      <span key="c" className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start', minWidth: 290 }}>
        <span className="am-row am-row--tight" style={{ flexWrap: 'nowrap' }}>
          <button className="am-btn am-btn--text" aria-expanded={open} aria-label={open ? `Hide tickets for ${r.name}` : `Show tickets for ${r.name}`}
            onClick={() => toggleCollapse(r.allmoxy_customer_id)}><Icon name={open ? 'unfold_less' : 'unfold_more'} /></button>
          <button className="am-btn am-btn--text" onClick={() => openCustomer(r.allmoxy_customer_id)} style={{ whiteSpace: 'normal', textAlign: 'left', height: 'auto' }}><b>{r.name}</b></button>
        </span>
        <span className="am-row am-row--tight">
          <span className={`am-tag am-tag--${r.launch_status === 'pre_launch' ? 'info' : 'neutral'}`}>{r.launch_status === 'pre_launch' ? 'Initial' : r.launch_status === 'launched' ? 'Catalog' : 'Unknown'}</span>
          {priDirty && <span className="am-tag am-tag--warning">Unsaved</span>}
          <span className="am-card__text">{tasks.length} open · {r.tasks_done} done{r.stage ? ` · ${r.stage}` : ''}</span>
        </span>
      </span>,
      <span key="s" className="am-card__text">Project</span>,
      fmtDay(r.schedule_start),
      fmtDay(r.schedule_end),
      span(r.schedule_start, r.schedule_end),
      '',
    ]);
    if (!open) continue;
    for (const tk of tasks) {
      const e = effTask(tk);
      const tm = timing(e.start, e.end, tk.stage_category === 'Done', today);
      tableRows.push([
        '',
        <span key="t" className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start', paddingLeft: 40, minWidth: 290, maxWidth: 440 }}>
          <a className="am-btn am-btn--text" href={tk.url} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: 'normal', textAlign: 'left', height: 'auto' }}>{tk.summary || tk.key}<Icon name="open_in_new" /></a>
          <span className="am-row am-row--tight">
            <span className="am-card__text">{tk.key}</span>
            {e.dirty && <span className="am-tag am-tag--warning">Unsaved</span>}
          </span>
        </span>,
        <span key="st" className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <span className={`am-tag am-tag--${statusTone(tk.stage_category)}`}>{tk.status || 'Unknown'}</span>
          <span className="am-card__text">{tk.assignee || 'Unassigned'}</span>
        </span>,
        <DateField key="ds" label={`Start for ${tk.key}`} value={e.start ?? ''} onChange={(v) => setTicket(tk.key, { start: v })} />,
        <DateField key="de" label={`End for ${tk.key}`} value={e.end ?? ''} onChange={(v) => setTicket(tk.key, { end: v })} />,
        span(e.start, e.end),
        <span key="tm" className={`am-tag am-tag--${tm.tone}`}>{tm.word}</span>,
      ]);
    }
  }

  return (
    <DsPage
      path="/implementation-schedule"
      title="Implementation Schedule"
      subtitle="Ticket-level schedule for the weekly prioritization meeting. Every JIRA ticket has its own start (created date) and end (due date, or last update): edit either freely. Done tickets are hidden by default. Set a project priority and sort to decide what to work on. Edits save in your browser; ask Claude to apply them so the team sees them."
      actions={pendingCount > 0 ? <button className="am-btn am-btn--filled" onClick={copyOverridesJson}><Icon name="content_copy" />{copied ? 'Copied' : `Copy schedule JSON (${pendingCount})`}</button> : undefined}
      overlays={sheet && (
        <SideSheet open onClose={() => setSheet(null)} title={sheet === 'past' ? `Past their end date · ${pastEnd.length} tickets` : `No priority set · ${unprioritized.length} customers`}
          text={sheet === 'past' ? 'Open tickets whose end date is before today, in the current filters. Move the end date or close the ticket.' : 'Customers in the current filters without a P1, P2 or P3. Set one in the schedule.'}>
          {sheet === 'past' ? (
            <DataTable label="Tickets past their end date" cols={[['Customer', false], ['Ticket', false], ['Status', false], ['Assignee', false], ['End', false], ['Days past', true]]}
              rows={pastEnd.map(({ g, t }) => { const e = effTask(t); return [g.row.name, <a key="a" className="am-btn am-btn--text" href={t.url} target="_blank" rel="noopener noreferrer">{t.key}<Icon name="open_in_new" /></a>, <span key="s" className={`am-tag am-tag--${statusTone(t.stage_category)}`}>{t.status || 'Unknown'}</span>, t.assignee || '—', fmtDay(e.end), String(Math.round((today - (toTime(e.end) ?? today)) / DAY))]; })}
              sortValues={pastEnd.map(({ g, t }) => { const e = effTask(t); return [g.row.name, t.key, t.status, t.assignee, e.end, Math.round((today - (toTime(e.end) ?? today)) / DAY)]; })}
              defaultSort={{ col: 5, dir: 'desc' }} foot={[`Total · ${pastEnd.length} tickets`, '', '', '', '', '']} />
          ) : (
            <DataTable label="Customers with no priority" cols={[['Customer', false], ['Type', false], ['Open tickets', true], ['Days since sign-up', true]]}
              rows={unprioritized.map((g) => [g.row.name, g.row.launch_status === 'pre_launch' ? 'Initial' : g.row.launch_status === 'launched' ? 'Catalog' : 'Unknown', String(g.tasks.length), g.row.days_since_signup == null ? '—' : String(g.row.days_since_signup)])}
              sortValues={unprioritized.map((g) => [g.row.name, g.row.launch_status, g.tasks.length, g.row.days_since_signup])}
              foot={[`Total · ${unprioritized.length} customers`, '', String(unprioritized.reduce((s, g) => s + g.tasks.length, 0)), '']} />
          )}
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Failed to load implementation: {String(error)}</p> : null}

      {pendingCount > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--warning">{pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}</span>
            <p className="am-card__text">Saved in this browser only. Select Copy schedule JSON and ask Claude to apply it to implementation_schedule_overrides.json.</p>
          </div>
        </section>
      )}

      <KpiGrid max={4}>
        <KpiCard label="Tickets past their end date" value={isLoading ? '…' : String(pastEnd.length)} hint="Open tickets in view whose end date has passed"
          tag={pastEnd.length ? 'Needs a new date' : 'On schedule'} tagTone={pastEnd.length ? 'error' : 'success'} onOpen={pastEnd.length ? () => setSheet('past') : undefined} />
        <KpiCard label="Customers with no priority" value={isLoading ? '…' : String(unprioritized.length)} hint="Set P1, P2 or P3 to rank them"
          tag={unprioritized.length ? 'Needs a priority' : 'All ranked'} tagTone={unprioritized.length ? 'warning' : 'success'} onOpen={unprioritized.length ? () => setSheet('unprioritized') : undefined} />
        <KpiCard label="Customers scheduled" value={isLoading ? '…' : String(groups.length)} hint={`With at least one ticket in the chosen statuses · ${noTicketCount} have no tickets`} />
        <KpiCard label="Tickets shown" value={isLoading ? '…' : String(visibleTickets)} hint={`${selectedStatuses.length} of ${statuses.length} statuses selected`} />
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Schedule · {groups.length} customer{groups.length === 1 ? '' : 's'} · {visibleTickets} ticket{visibleTickets === 1 ? '' : 's'}</span>
          <span className="am-chart__caption">Each customer row shows the project span; its tickets follow. Timing says where each ticket sits against today. Change a date or priority and it saves in this browser.</span>
        </div>
        <div className="am-row am-row--wrap">
          <Segmented label="Customers" value={view} onChange={(v) => { setView(v); setShowAll(false); }} options={[['all', 'All'], ['initial', 'Initial'], ['catalog', 'Catalog']]} />
          <Switch checked={activeOnly} onChange={(v) => { setActiveOnly(v); setShowAll(false); }}>Active only</Switch>
          <span className="am-card__text">Sort</span>
          <Select label="Sort" width={250} value={sortKey} onPick={(v) => setSortKey(v as SortKey)} options={[
            ['priority', 'Priority, then urgency'], ['urgency', 'Urgency (overdue / oldest)'], ['start', 'Earliest ticket start'], ['name', 'Customer name'],
          ]} />
          <button className="am-btn am-btn--text" onClick={() => setCollapsed(new Set())}><Icon name="unfold_more" />Expand all</button>
          <button className="am-btn am-btn--text" onClick={() => setCollapsed(new Set(groups.map((g) => g.row.allmoxy_customer_id)))}><Icon name="unfold_less" />Collapse all</button>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Status</span>
          {statuses.map((s) => (
            <FilterChip key={s.name} checked={isSel(s.name)} onChange={() => toggleStatus(s.name)}>{s.name} ({s.count})</FilterChip>
          ))}
          {statusSel && <button className="am-btn am-btn--text" onClick={() => setStatusSel(null)}>Reset (hide Done)</button>}
        </div>

        {isLoading ? <p className="am-card__text">Loading schedule…</p> : groups.length === 0 ? <p className="am-card__text">No tickets match the current filters.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Implementation schedule" cols={cols} rows={tableRows}
              foot={['Total', `${groups.length} customers · ${visibleTickets} tickets`, '', '', '', '', '']}
              onFoot={() => setShowAll(true)} footClickable={(c) => c === 1 && !showAll && groups.length > LIMIT} />
          </div>
        )}
        {!isLoading && !showAll && groups.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {groups.length} customers</button>}
        {!isLoading && showAll && groups.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show top {LIMIT}</button>}
        {noTicketCount > 0 && (
          <p className="am-card__text">{noTicketCount} implementation customer{noTicketCount === 1 ? '' : 's'} have no JIRA tickets and aren't shown here (nothing to schedule). They still appear on Implementation.</p>
        )}
      </section>
    </DsPage>
  );
}
