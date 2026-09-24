import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, ComposedChart, Bar, LabelList, Legend, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type Cust = { allmoxy_customer_id: number; name: string; mrr: number; status: string };
type Bug = {
  key: string; issue_type: string; summary: string; status: string; stage_category: string; priority: string;
  issue_score: number | null; created: string; updated: string; resolved: string | null;
  closed_at: string | null; resolution_date_missing: boolean; is_open: boolean; age_days: number | null;
  customers: Cust[]; customer_count: number; mrr_affected: number; active_customers_affected: number; url: string;
};
type Tally = { key: string; bugs: number; mrr_affected: number; open: number };
type Snap = {
  source: string;
  totals: { bugs: number; open: number; resolved: number; open_mrr_affected: number; customers_waiting: number; unattributed_open: number; closed_without_resolution_date: number };
  age: { median_open_days: number | null; p90_open_days: number | null; median_days_to_resolve: number | null; note: string };
  monthly: Array<{ month: string; filed: number; resolved: number; net: number; open_at_month_end: number; median_days_to_resolve: number | null; partial: boolean }>;
  weekly: Array<{ week: string; filed: number; partial: boolean }>;
  by_priority: Tally[]; by_status: Tally[]; by_type: Tally[];
  customers: Array<Cust & { open_bugs: number; highest_priority: string | null; oldest_days: number }>;
  bugs: Bug[];
  unmatched_labels: Array<{ label: string; tickets: number }>;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function weekLabel(w: string) {
  const [, m, d] = w.split('-');
  return `${m}/${d}`;
}
function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}
const PRIORITY_TONE: Record<string, 'error' | 'warning' | 'info' | 'default'> = {
  Highest: 'error', High: 'error', Medium: 'warning', Low: 'info', Lowest: 'default', None: 'default',
};

type SortKey = 'mrr_affected' | 'age_days' | 'priority' | 'created' | 'key' | 'customer_count';
const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right'; defaultDesc: boolean; value: (b: Bug) => string | number }> = [
  { key: 'key', label: 'Ticket', defaultDesc: false, value: (b) => b.key },
  { key: 'priority', label: 'Priority', defaultDesc: true, value: (b) => ({ Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 } as Record<string, number>)[b.priority] ?? 0 },
  { key: 'age_days', label: 'Age', align: 'right', defaultDesc: true, value: (b) => b.age_days ?? 0 },
  { key: 'mrr_affected', label: 'MRR affected', align: 'right', defaultDesc: true, value: (b) => b.mrr_affected },
  { key: 'customer_count', label: 'Customers', align: 'right', defaultDesc: true, value: (b) => b.customer_count },
  { key: 'created', label: 'Filed', defaultDesc: true, value: (b) => b.created ?? '' },
];

export default function BugReport() {
  const { data, isLoading, error } = useSheetTab('bug_report');
  const snap = data as unknown as Snap | undefined;
  const [view, setView] = useState<'open' | 'all'>('open');
  const [priority, setPriority] = useState('');
  const [issueType, setIssueType] = useState('');
  const [range, setRange] = useState<'12M' | '24M' | 'ALL'>('24M');
  const [grain, setGrain] = useState<'month' | 'week'>('month');
  const [sortKey, setSortKey] = useState<SortKey>('mrr_affected');
  const [sortDesc, setSortDesc] = useState(true);
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) { setSortDesc((d) => !d); return; }
    setSortKey(k); setSortDesc(COLUMNS.find((c) => c.key === k)!.defaultDesc);
  };

  const rows = useMemo(() => {
    let r = snap?.bugs ?? [];
    if (view === 'open') r = r.filter((b) => b.is_open);
    if (priority) r = r.filter((b) => b.priority === priority);
    if (issueType) r = r.filter((b) => b.issue_type === issueType);
    const col = COLUMNS.find((c) => c.key === sortKey)!;
    return [...r].sort((a, b) => {
      const av = col.value(a), bv = col.value(b);
      let cmp = typeof av === 'string' || typeof bv === 'string' ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number);
      if (cmp === 0) cmp = a.mrr_affected - b.mrr_affected;
      return sortDesc ? -cmp : cmp;
    }).slice(0, view === 'open' ? 500 : 300);
  }, [snap, view, priority, issueType, sortKey, sortDesc]);

  // Filed volume only (Beau, 2026-09-24). The filed-vs-fixed pairing made the chart
  // about throughput; the question here is how many bugs are being raised over time,
  // which a single series answers far more legibly.
  const chart = useMemo(() => {
    // ELAPSED FRACTION of the in-progress period, so the current bar can show where it
    // is heading rather than just how little has accumulated so far. Bugs are filed
    // continuously through a period, so a straight-line pace is the right estimator
    // here — unlike subscription billing, which clusters on billing dates.
    const now = new Date();
    if (grain === 'week') {
      const all = snap?.weekly ?? [];
      if (!all.length) return [];
      const weeks = range === 'ALL' ? all : all.slice(range === '12M' ? -53 : -105);
      const dowElapsed = ((now.getDay() + 6) % 7) + 1;      // Mon = 1 … Sun = 7
      return weeks.map((w) => {
        const frac = w.partial ? Math.min(1, dowElapsed / 7) : 1;
        const projTotal = w.partial && frac > 0 ? Math.round(w.filed / frac) : w.filed;
        return {
          label: weekLabel(w.week),
          filed: w.filed,
          projected_extra: w.partial ? Math.max(0, projTotal - w.filed) : 0,
          projected_total: w.partial ? projTotal : null,
          partial: w.partial,
        };
      });
    }
    const all = snap?.monthly ?? [];
    if (!all.length) return [];
    let rowsIn = all;
    if (range !== 'ALL') {
      const last = all[all.length - 1].month;
      const [y, m] = last.split('-').map(Number);
      const back = range === '12M' ? 11 : 23;
      const d = new Date(y, m - 1 - back, 1);
      const cut = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      rowsIn = all.filter((c) => c.month >= cut);
    }
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthFrac = Math.min(1, now.getDate() / daysInMonth);
    return rowsIn.map((c) => {
      const frac = c.partial ? monthFrac : 1;
      const projTotal = c.partial && frac > 0 ? Math.round(c.filed / frac) : c.filed;
      return {
        label: monthLabel(c.month),
        filed: c.filed,
        projected_extra: c.partial ? Math.max(0, projTotal - c.filed) : 0,
        projected_total: c.partial ? projTotal : null,
        partial: c.partial,
      };
    });
  }, [snap, range, grain]);

  if (error) {
    return (
      <Box>
        <PageHeader title="Bug Report" subtitle="Bugs filed on the JIRA DEV board" />
        <Alert severity="error">Failed to load bug_report — {String(error)}</Alert>
      </Box>
    );
  }

  const t = snap?.totals;

  return (
    <Box>
      <PageHeader
        title="Bug Report"
        subtitle="Every bug on the JIRA DEV board, ranked by the revenue waiting on it rather than only by engineering priority."
        question="durable"
      />

      <Grid container spacing={2} sx={{ mb: 3 }}>
        {[
          { label: 'Open bugs', value: N0.format(t?.open ?? 0), hint: `of ${N0.format(t?.bugs ?? 0)} ever filed`, color: (t?.open ?? 0) > 20 ? 'error.main' : 'success.main' },
          { label: 'MRR affected', value: USD0.format(t?.open_mrr_affected ?? 0), hint: `${t?.customers_waiting ?? 0} customers waiting`, color: 'warning.main' },
          { label: 'Median open age', value: snap?.age.median_open_days != null ? `${snap.age.median_open_days}d` : '—', hint: `p90 ${snap?.age.p90_open_days ?? '—'}d` },
          { label: 'Median time to fix', value: snap?.age.median_days_to_resolve != null ? `${snap.age.median_days_to_resolve}d` : '—', hint: 'resolved bugs' },
          { label: 'Unattributed', value: N0.format(t?.unattributed_open ?? 0), hint: 'open, no customer tagged', color: (t?.unattributed_open ?? 0) > 0 ? 'warning.main' : 'text.primary' },
        ].map((k) => (
          <Grid item xs={12} sm={6} md={2.4} key={k.label}>
            <Paper sx={{ p: 2, height: '100%' }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>{k.label}</Typography>
              {isLoading ? <Skeleton variant="text" width="60%" sx={{ fontSize: 24 }} /> : (
                <Typography variant="h6" sx={{ fontWeight: 600, color: k.color ?? 'text.primary', mt: 0.25 }}>{k.value}</Typography>
              )}
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>{k.hint}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      {snap && snap.totals.closed_without_resolution_date > 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>Open is decided by stage, not by the resolution date.</strong>{' '}
          {snap.totals.closed_without_resolution_date} bugs sit in stage <em>Done</em> — status Resolved, Closed or In Production — with no resolution date recorded in JIRA.
          Trusting that timestamp would report {snap.totals.closed_without_resolution_date + snap.totals.open} open bugs with a multi-year median age, when {snap.totals.open} are genuinely open.
          Those closures are aged to their last update instead.
        </Alert>
      )}

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Bugs filed</Typography>
          <InfoIcon info={<>How many bugs are raised over time. Weeks are keyed to the Monday that starts them, and quiet weeks show as zero rather than a gap — a missing bar would read as missing data when it is really a real observation.<br /><br />The current {grain === 'week' ? 'week' : 'month'} is still running, so its bar carries a dashed block for the rest of the period and the <strong>projected total is labelled above it</strong> — filings so far divided by the fraction of the period elapsed. Bugs arrive steadily through a period, so a straight-line pace is a fair estimator; it is not used for subscription billing elsewhere, which clusters on billing dates.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <ToggleButtonGroup size="small" exclusive value={grain} onChange={(_, v) => v && setGrain(v)} sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}>
            <ToggleButton value="month">Monthly</ToggleButton>
            <ToggleButton value="week">Weekly</ToggleButton>
          </ToggleButtonGroup>
          <ToggleButtonGroup size="small" exclusive value={range} onChange={(_, v) => v && setRange(v)} sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}>
            <ToggleButton value="12M">12M</ToggleButton>
            <ToggleButton value="24M">24M</ToggleButton>
            <ToggleButton value="ALL">All time</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={250} /> : (
          <ResponsiveContainer width="100%" height={270}>
            <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={grain === 'week' ? 34 : 26} />
              <YAxis tick={{ fontSize: 11 }} />
              <RTooltip
                contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 12, color: '#FFFFFF' }}
                labelStyle={{ color: '#FFFFFF' }}
                itemStyle={{ color: '#FFFFFF' }}
                formatter={(v: number, n: string) => [N0.format(v), n === 'projected_extra' ? 'Projected remainder' : 'Filed so far']}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v: string) => (v === 'projected_extra' ? 'Projected remainder' : 'Filed')} />
              <Bar dataKey="filed" stackId="f" fill="#DA3633" name="filed" />
              {/* Same treatment the Orders Verified chart uses: a dashed, translucent
                  block for the un-elapsed part of the period, with the PROJECTED TOTAL
                  labelled above the bar — the label is what makes "where it ends"
                  readable, not the block on its own. */}
              <Bar dataKey="projected_extra" stackId="f" fill="#DA3633" fillOpacity={0.25} stroke="#DA3633" strokeOpacity={0.45} strokeDasharray="3 3" name="projected_extra">
                <LabelList
                  dataKey="projected_total"
                  position="top"
                  formatter={(v: number | null) => (v ? String(v) : '')}
                  style={{ fill: '#F0857F', fontSize: 11, fontWeight: 700 }}
                />
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Paper>

      {(snap?.customers.length ?? 0) > 0 && (
        <Paper sx={{ p: 3, mb: 3 }}>
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
            <Typography variant="h6" sx={{ fontWeight: 500 }}>Customers waiting on a fix</Typography>
            <InfoIcon info="Customers tagged on at least one open bug, ordered by MRR. This is the call list — who to tell what, before they ask." />
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Customer</TableCell>
                <TableCell align="right">MRR</TableCell>
                <TableCell align="right">Open bugs</TableCell>
                <TableCell align="right">Oldest</TableCell>
                <TableCell>Highest priority</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(snap?.customers ?? []).map((c) => (
                <TableRow key={c.allmoxy_customer_id} hover>
                  <TableCell><CustomerLink name={c.name} /></TableCell>
                  <TableCell align="right" sx={{ fontWeight: 500 }}>{USD0.format(c.mrr)}</TableCell>
                  <TableCell align="right">{c.open_bugs}</TableCell>
                  <TableCell align="right" sx={{ color: c.oldest_days > 30 ? 'warning.main' : 'text.secondary' }}>{c.oldest_days}d</TableCell>
                  <TableCell><Chip size="small" color={PRIORITY_TONE[c.highest_priority ?? 'None']} label={c.highest_priority ?? '—'} sx={{ height: 18, fontSize: 10 }} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>{view === 'open' ? 'Open bugs' : 'All bugs'} · {rows.length}</Typography>
          <InfoIcon info={<><strong>MRR affected</strong> is the combined subscription MRR of the customers tagged on the ticket. Sorting by it answers "what is the business losing while this waits", which is the view JIRA cannot give you.<br /><br />A bug with $0 affected is not unimportant — it means no customer is tagged on it. {snap?.totals.unattributed_open} open bugs are in that state.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <ToggleButtonGroup size="small" exclusive value={view} onChange={(_, v) => v && setView(v)} sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}>
            <ToggleButton value="open">Open</ToggleButton>
            <ToggleButton value="all">All</ToggleButton>
          </ToggleButtonGroup>
          <TextField select size="small" label="Type" value={issueType} onChange={(e) => setIssueType(e.target.value)} sx={{ minWidth: 140 }}>
            <MenuItem value="">All types</MenuItem>
            {(snap?.by_type ?? []).map((t) => <MenuItem key={t.key} value={t.key}>{t.key} ({t.bugs})</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="">All priorities</MenuItem>
            {(snap?.by_priority ?? []).map((p) => <MenuItem key={p.key} value={p.key}>{p.key} ({p.bugs})</MenuItem>)}
          </TextField>
          <CsvExportButton
            filename="bug_report.csv"
            rows={rows}
            columns={[
              { key: 'key', label: 'Ticket' }, { key: 'summary', label: 'Summary' },
              { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
              { key: 'age_days', label: 'Age (days)' }, { key: 'mrr_affected', label: 'MRR affected' },
              { key: 'customer_count', label: 'Customers' }, { key: 'created', label: 'Filed' },
              { key: 'closed_at', label: 'Closed' }, { key: 'url', label: 'URL' },
            ]}
          />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              {COLUMNS.map((c) => (
                <TableCell key={c.key} align={c.align} sortDirection={sortKey === c.key ? (sortDesc ? 'desc' : 'asc') : false}>
                  <TableSortLabel active={sortKey === c.key} direction={sortKey === c.key ? (sortDesc ? 'desc' : 'asc') : (c.defaultDesc ? 'desc' : 'asc')} onClick={() => toggleSort(c.key)}>
                    {c.label}
                  </TableSortLabel>
                </TableCell>
              ))}
              <TableCell>Summary</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((b) => (
              <TableRow key={b.key} hover>
                <TableCell><Link href={b.url} target="_blank" rel="noopener" sx={{ fontFamily: 'monospace', fontSize: 12 }}>{b.key}</Link></TableCell>
                <TableCell><Chip size="small" color={PRIORITY_TONE[b.priority]} label={b.priority} sx={{ height: 18, fontSize: 10 }} /></TableCell>
                <TableCell align="right" sx={{ color: (b.age_days ?? 0) > 30 && b.is_open ? 'warning.main' : 'text.secondary' }}>{b.age_days != null ? `${b.age_days}d` : '—'}</TableCell>
                <TableCell align="right" sx={{ fontWeight: b.mrr_affected > 0 ? 500 : 400, color: b.mrr_affected > 0 ? 'text.primary' : 'text.disabled' }}>
                  {b.mrr_affected > 0 ? USD0.format(b.mrr_affected) : '—'}
                </TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{b.customer_count || '—'}</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontSize: 11 }}>{b.created}</TableCell>
                <TableCell sx={{ maxWidth: 420 }}>
                  <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.summary}</Typography>
                  {b.customers.length > 0 && (
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{b.customers.map((c) => c.name).join(' · ')}</Typography>
                  )}
                </TableCell>
                <TableCell><Chip size="small" variant="outlined" label={b.status} sx={{ height: 18, fontSize: 10 }} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {snap && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 2 }}>
            {snap.source} · Bug and Investigate issue types, including tickets with no customer tag.
            {' '}{snap.unmatched_labels.length} customer labels match no roster customer and are excluded from MRR affected.
            {' '}A customer-reported problem triaged onto a Task or New Feature is not counted here — HubSpot&rsquo;s &ldquo;Bug Reported&rdquo; resolution is a wider net than JIRA&rsquo;s defect types.
          </Typography>
        )}
      </Paper>
    </Box>
  );
}
