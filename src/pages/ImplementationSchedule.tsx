import { useMemo, useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type Priority = 'P1' | 'P2' | 'P3';
type Task = {
  key: string;
  summary: string;
  status: string | null;
  stage_category: string | null; // To Do | In Progress | Done
  assignee: string | null;
  created: string | null;
  updated: string | null;
  due: string | null;
  url: string;
  start: string | null;   // seeded from created (or committed override)
  end: string | null;     // seeded from due/last-update (or committed override)
};
type Row = {
  allmoxy_customer_id: number;
  name: string;
  implementation_type: 'Initial implementation' | 'Catalog update' | 'Unknown';
  launch_status: 'pre_launch' | 'launched' | 'unknown';
  stage: string | null;
  is_active: boolean;
  days_since_signup: number | null;
  schedule_start: string | null;
  schedule_end: string | null;
  priority: Priority | null;
  task_count: number;
  tasks_done: number;
  tasks: Task[];
};
type Snapshot = { fetchedAt: string; rows: Row[] };

// Browser-pending edits overlaid on the committed snapshot values, applied to
// _etl_scripts/implementation_schedule_overrides.json on refresh.
const STORAGE_KEY = 'allmoxy.implementation_schedule.v2';
type Edits = { tickets: Record<string, { start?: string; end?: string }>; priorities: Record<string, Priority | null> };
function readEdits(): Edits {
  try { const raw = localStorage.getItem(STORAGE_KEY); const p = raw ? JSON.parse(raw) : null; return { tickets: p?.tickets ?? {}, priorities: p?.priorities ?? {} }; }
  catch { return { tickets: {}, priorities: {} }; }
}

const PRI_COLOR: Record<Priority, string> = { P1: '#D63A4D', P2: '#F5A623', P3: '#2C73FF' };
const PRI_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, '': 3 };
function taskColor(cat: string | null): string {
  if (cat === 'Done') return '#1A9E5C';
  if (cat === 'In Progress') return '#2C73FF';
  if (cat === 'To Do') return '#8B949E';
  return '#F5A623';
}
const DAY = 86400000;
const toTime = (iso: string | null) => (iso ? new Date(iso + 'T00:00:00').getTime() : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type View = 'all' | 'initial' | 'catalog';
type SortKey = 'priority' | 'start' | 'urgency' | 'name';

const LEFT_W = 432;
const PX_PER_DAY = 22; // daily columns
// Daily grid drawn as CSS gradients (no DOM node per day per row): faint daily
// lines, stronger weekly Monday lines, light weekend shading. The domain min is
// snapped to a Monday, so day 0 of each period is Monday.
const GRID_BG = [
  `repeating-linear-gradient(90deg, rgba(139,148,158,0.20) 0 1px, transparent 1px ${7 * PX_PER_DAY}px)`,
  `repeating-linear-gradient(90deg, rgba(139,148,158,0.08) 0 1px, transparent 1px ${PX_PER_DAY}px)`,
  `repeating-linear-gradient(90deg, transparent 0 ${5 * PX_PER_DAY}px, rgba(139,148,158,0.05) ${5 * PX_PER_DAY}px ${7 * PX_PER_DAY}px)`,
].join(',');

export default function ImplementationSchedule() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('implementation');
  const allRows = (data as Snapshot | undefined)?.rows ?? [];

  const [edits, setEdits] = useState<Edits>(() => readEdits());
  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(edits)); } catch { /* ignore */ } }, [edits]);

  const [view, setView] = useState<View>('all');
  const [activeOnly, setActiveOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set()); // empty = all expanded
  const [statusSel, setStatusSel] = useState<string[] | null>(null);  // null = default (hide Done)
  const toggleCollapse = (id: number) => setCollapsed((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

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

  // Customers that carry JIRA tickets (the schedulable set).
  const withTickets = useMemo(() => allRows.filter((r) => r.task_count > 0), [allRows]);
  const noTicketCount = allRows.length - withTickets.length;

  // Customer-level view filters.
  const scoped = useMemo(() => withTickets.filter((r) => {
    if (activeOnly && !r.is_active) return false;
    if (view === 'initial' && r.launch_status !== 'pre_launch') return false;
    if (view === 'catalog' && r.launch_status !== 'launched') return false;
    return true;
  }), [withTickets, activeOnly, view]);

  // Distinct statuses across scoped tasks, with category, for the filter chips.
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

  // Visible tasks per customer (status filter), then only customers with ≥1.
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

  // Timeline domain from all visible ticket dates + today.
  const today = Date.now();
  const domain = useMemo(() => {
    const times: number[] = [today];
    for (const g of groups) for (const t of g.tasks) { const e = effTask(t); const s = toTime(e.start); const en = toTime(e.end); if (s) times.push(s); if (en) times.push(en); }
    let min = Math.min(...times) - 7 * DAY;
    const max = Math.max(...times) + 14 * DAY;
    const d = new Date(min); const dow = (d.getDay() + 6) % 7; min -= dow * DAY;
    return { min, max };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, edits]);
  const totalDays = Math.max(1, Math.round((domain.max - domain.min) / DAY));
  const timelineW = Math.round(totalDays * PX_PER_DAY);
  const xOf = (t: number) => ((t - domain.min) / DAY) * PX_PER_DAY;
  const dayTicks = useMemo(() => { const a: number[] = []; for (let t = domain.min; t <= domain.max; t += DAY) a.push(t); return a; }, [domain]);

  const pendingCount = Object.values(edits.tickets).filter((e) => e && (e.start !== undefined || e.end !== undefined)).length
    + Object.keys(edits.priorities).length;
  const visibleTickets = groups.reduce((s, g) => s + g.tasks.length, 0);

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
    navigator.clipboard?.writeText(JSON.stringify({ customer_priority, tickets }, null, 2)).then(() => {}, () => {});
  }

  return (
    <Box>
      <PageHeader
        title="Implementation Schedule"
        subtitle="Ticket-level Gantt for the weekly prioritization meeting. Every JIRA ticket has its own start (created date) and end (due date, or last update) — edit either freely. Tickets show expanded under each customer; Done tickets are hidden by default. Set a project priority and sort to decide what to work on. Edits save in your browser — ask Claude to apply them so the team sees them."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load implementation: {String(error)}</Alert>}

      {pendingCount > 0 && (
        <Alert severity="info" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={copyOverridesJson}>Copy schedule JSON</Button>}>
          <strong>{pendingCount}</strong> unsaved change{pendingCount === 1 ? '' : 's'} (this browser only). Click <strong>Copy schedule JSON</strong> and ask Claude to apply it to <code>implementation_schedule_overrides.json</code>.
        </Alert>
      )}

      {/* Controls */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
        <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)}>
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="initial">Initial</ToggleButton>
          <ToggleButton value="catalog">Catalog</ToggleButton>
        </ToggleButtonGroup>
        <FormControlLabel control={<Switch size="small" checked={activeOnly} onChange={(_, v) => setActiveOnly(v)} />} label={<Typography variant="caption">Active only</Typography>} />
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>Sort</Typography>
          <Select size="small" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} sx={{ fontSize: 13, height: 32 }}>
            <MenuItem value="priority">Priority, then urgency</MenuItem>
            <MenuItem value="urgency">Urgency (overdue / oldest)</MenuItem>
            <MenuItem value="start">Earliest ticket start</MenuItem>
            <MenuItem value="name">Customer name</MenuItem>
          </Select>
        </Stack>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>{groups.length} customer{groups.length === 1 ? '' : 's'} · {visibleTickets} ticket{visibleTickets === 1 ? '' : 's'}</Typography>
      </Stack>

      {/* Status filter */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Status</Typography>
        {statuses.map((s) => (
          <Chip
            key={s.name}
            label={`${s.name} (${s.count})`}
            size="small"
            onClick={() => toggleStatus(s.name)}
            variant={isSel(s.name) ? 'filled' : 'outlined'}
            sx={{ height: 22, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              bgcolor: isSel(s.name) ? taskColor(s.category) + '33' : 'transparent',
              color: isSel(s.name) ? taskColor(s.category) : 'text.disabled',
              borderColor: taskColor(s.category) + '55' }}
          />
        ))}
        <InfoIcon info="Filter which ticket statuses appear. Done is hidden by default — click it to show completed tickets. Bars are colored by status; the dashed line is today." />
      </Stack>

      <Paper sx={{ p: 0, overflow: 'hidden' }}>
        {isLoading ? <Box sx={{ p: 3 }}><Skeleton variant="rectangular" height={400} /></Box> : groups.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 6, textAlign: 'center' }}>No tickets match the current filters.</Typography>
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Box sx={{ minWidth: LEFT_W + timelineW }}>
              {/* Header */}
              <Box sx={{ display: 'flex', position: 'sticky', top: 0, zIndex: 2, bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ width: LEFT_W, flexShrink: 0, display: 'flex', px: 1.5, py: 1, gap: 1 }}>
                  <Box sx={{ width: 40, fontSize: 10, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Pri</Box>
                  <Box sx={{ flex: 1, fontSize: 10, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Customer / ticket</Box>
                  <Box sx={{ width: 92, fontSize: 10, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Start</Box>
                  <Box sx={{ width: 92, fontSize: 10, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em' }}>End</Box>
                </Box>
                <Box sx={{ position: 'relative', width: timelineW, flexShrink: 0, height: 32 }}>
                  {dayTicks.map((t) => {
                    const d = new Date(t); const dom = d.getDate(); const mon = d.getDay() === 1; const showMonth = dom === 1 || t === dayTicks[0];
                    return (
                      <Box key={t} sx={{ position: 'absolute', left: xOf(t), top: 0, height: '100%', width: PX_PER_DAY, borderLeft: '1px solid', borderColor: mon ? 'divider' : 'rgba(139,148,158,0.10)' }}>
                        {showMonth && <Typography sx={{ position: 'absolute', top: 1, left: 2, fontSize: 9, fontWeight: 700, color: 'text.primary', whiteSpace: 'nowrap' }}>{MONTHS[d.getMonth()]}</Typography>}
                        <Typography sx={{ position: 'absolute', bottom: 2, left: 2, fontSize: 8.5, color: mon ? 'text.primary' : 'text.secondary' }}>{dom}</Typography>
                      </Box>
                    );
                  })}
                  <Box sx={{ position: 'absolute', left: xOf(today), top: 0, height: '100%', borderLeft: '2px dashed', borderColor: 'error.main' }} />
                </Box>
              </Box>

              {groups.map(({ row: r, tasks }) => {
                const pri = effPriority(r);
                const open = !collapsed.has(r.allmoxy_customer_id);
                const envStart = toTime(r.schedule_start), envEnd = toTime(r.schedule_end);
                return (
                  <Box key={r.allmoxy_customer_id}>
                    {/* Customer header row */}
                    <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'action.hover', minHeight: 40 }}>
                      <Box sx={{ width: LEFT_W, flexShrink: 0, display: 'flex', alignItems: 'center', px: 1.5, py: 0.5, gap: 1 }}>
                        <Select
                          size="small" variant="standard" disableUnderline displayEmpty
                          value={pri ?? ''}
                          onChange={(ev) => setPriority(r.allmoxy_customer_id, (ev.target.value || null) as Priority | null)}
                          renderValue={(v) => (v ? v : '—')}
                          sx={{ width: 40, fontSize: 12, fontWeight: 700, color: pri ? PRI_COLOR[pri] : 'text.disabled', '& .MuiSelect-select': { py: 0.25 } }}
                        >
                          <MenuItem value=""><em>—</em></MenuItem>
                          <MenuItem value="P1" sx={{ color: PRI_COLOR.P1, fontWeight: 700 }}>P1</MenuItem>
                          <MenuItem value="P2" sx={{ color: PRI_COLOR.P2, fontWeight: 700 }}>P2</MenuItem>
                          <MenuItem value="P3" sx={{ color: PRI_COLOR.P3, fontWeight: 700 }}>P3</MenuItem>
                        </Select>
                        <Box
                          onClick={() => toggleCollapse(r.allmoxy_customer_id)}
                          sx={{ cursor: 'pointer', userSelect: 'none', color: 'text.secondary', fontSize: 11, width: 12, flexShrink: 0 }}
                        >{open ? '▾' : '▸'}</Box>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Box sx={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            <CustomerLink id={r.allmoxy_customer_id} name={r.name} />
                          </Box>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            <Chip label={r.launch_status === 'pre_launch' ? 'Initial' : r.launch_status === 'launched' ? 'Catalog' : '?'} size="small" sx={{ height: 14, fontSize: 9, bgcolor: (r.launch_status === 'pre_launch' ? '#2C73FF' : '#8B949E') + '22', color: r.launch_status === 'pre_launch' ? '#2C73FF' : '#8B949E' }} />
                            <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{tasks.length} open · {r.tasks_done} done{r.stage ? ` · ${r.stage}` : ''}</Typography>
                          </Stack>
                        </Box>
                      </Box>
                      <Box sx={{ position: 'relative', width: timelineW, flexShrink: 0, height: 40, backgroundImage: GRID_BG }}>
                        <Box sx={{ position: 'absolute', left: xOf(today), top: 0, height: '100%', borderLeft: '2px dashed', borderColor: 'rgba(214,58,77,0.5)' }} />
                        {/* faint project envelope spanning the customer's tickets */}
                        {envStart != null && envEnd != null && (
                          <Box sx={{ position: 'absolute', top: 18, height: 4, left: xOf(envStart), width: Math.max(4, xOf(envEnd) - xOf(envStart)), bgcolor: 'rgba(139,148,158,0.4)', borderRadius: 2 }} />
                        )}
                      </Box>
                    </Box>

                    {/* Ticket rows (expanded by default) */}
                    {open && tasks.map((tk) => {
                      const e = effTask(tk);
                      const ts = toTime(e.start), te = toTime(e.end);
                      const col = taskColor(tk.stage_category);
                      const left = ts != null ? xOf(ts) : 0;
                      const width = (ts != null && te != null) ? Math.max(6, xOf(te) - xOf(ts)) : 0;
                      return (
                        <Box key={tk.key} sx={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider', '&:hover': { bgcolor: 'action.hover' }, minHeight: 34 }}>
                          <Box sx={{ width: LEFT_W, flexShrink: 0, display: 'flex', alignItems: 'center', pl: 10, pr: 1.5, gap: 1 }}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ minWidth: 0 }}>
                                <Box component="a" href={tk.url} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 12, color: 'text.primary', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', '&:hover': { textDecoration: 'underline' } }}>
                                  {tk.summary || tk.key}
                                </Box>
                                {e.dirty && <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main', flexShrink: 0 }} title="unsaved edit" />}
                              </Stack>
                              <Typography sx={{ fontSize: 9.5, color: col, fontWeight: 600 }}>{tk.status} · {tk.key}</Typography>
                            </Box>
                            <input type="date" value={e.start ?? ''} onChange={(ev) => setTicket(tk.key, { start: ev.target.value })} style={dateInputStyle} />
                            <input type="date" value={e.end ?? ''} onChange={(ev) => setTicket(tk.key, { end: ev.target.value })} style={dateInputStyle} />
                          </Box>
                          <Box sx={{ position: 'relative', width: timelineW, flexShrink: 0, height: 34, backgroundImage: GRID_BG }}>
                            <Box sx={{ position: 'absolute', left: xOf(today), top: 0, height: '100%', borderLeft: '2px dashed', borderColor: 'rgba(214,58,77,0.5)' }} />
                            {width > 0 && (
                              <Box title={`${tk.summary}: ${e.start} → ${e.end}`} sx={{ position: 'absolute', top: 9, height: 16, left, width, bgcolor: col, borderRadius: 1, opacity: 0.92, display: 'flex', alignItems: 'center', px: 0.75, boxShadow: 1 }}>
                                <Typography sx={{ fontSize: 9.5, color: '#fff', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {tk.assignee ? tk.assignee.split(' ')[0] : ''}
                                </Typography>
                              </Box>
                            )}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}
      </Paper>

      {noTicketCount > 0 && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          {noTicketCount} implementation customer{noTicketCount === 1 ? '' : 's'} have no JIRA tickets and aren't shown here (nothing to schedule). They still appear on the Implementation Overview.
        </Typography>
      )}
    </Box>
  );
}

const dateInputStyle: React.CSSProperties = {
  width: 92, fontSize: 11, padding: '3px 4px', background: 'transparent',
  color: 'inherit', border: '1px solid rgba(139,148,158,0.3)', borderRadius: 4, colorScheme: 'dark',
};
