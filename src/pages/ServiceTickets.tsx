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
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import { useSheetTab } from '../hooks/useSheetTab';

type MonthRow = {
  month: string; created: number; closed: number; net: number; open_at_month_end: number;
  median_resolution_days: number | null; p90_resolution_days: number | null;
  instant_close_rate: number | null; same_day_rate: number | null; within_7d_rate: number | null;
  cohort_median_resolution_days: number | null; cohort_p90_resolution_days: number | null;
  cohort_measurable: number; cohort_closed_share: number | null;
  backlog_purge: boolean; partial: boolean;
  by_source: Record<string, number>;
};
type Cut = { key: string; tickets: number; open: number; closed: number; median_resolution_days: number | null; measurable: number };
type CustRow = {
  allmoxy_customer_id: number; name: string; status: string | null; mrr: number;
  tickets: number; open: number; ttm_tickets: number;
  median_resolution_days: number | null; last_ticket: string | null; tickets_per_1k_mrr: number | null;
};
type OpenRow = {
  id: string; subject: string | null; created: string | null; age_days: number | null;
  stage: string | null; owner: string | null; source: string | null; priority: string | null;
  url: string | null; customer: string | null; allmoxy_customer_id: number | null;
};
type Snap = {
  fetchedAt: string; source_fetched_at: string | null;
  window: { first_month: string; last_month: string; ttm_start: string };
  totals: {
    tickets: number; open: number; closed: number; customers_with_tickets: number;
    unattributed_tickets: number; median_resolution_days: number | null; instant_close_rate_all_time: number | null;
  };
  ttm: {
    created: number; closed: number; net: number; per_month: number;
    median_resolution_days: number | null; p90_resolution_days: number | null;
    cohort_median_resolution_days: number | null; cohort_p90_resolution_days: number | null;
    cohort_measurable: number; cohort_closed_share: number | null;
    same_day_rate: number | null; within_7d_rate: number | null; measurable: number;
    purge_months: string[];
  };
  monthly: MonthRow[];
  by_owner: Cut[]; by_source: Cut[]; by_stage: Cut[]; by_category: Cut[]; by_priority: Cut[];
  customers: CustRow[]; open_tickets: OpenRow[];
  data_quality: { instant_close_rate_all_time: number | null; note: string; attribution: string };
};

const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const days = (v: number | null | undefined) =>
  v == null ? '—' : v < 1 ? `${Math.round(v * 24)}h` : v < 30 ? `${v.toFixed(1)}d` : `${Math.round(v)}d`;
function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

function Kpi({ label, value, hint, color = 'text.primary', loading }: { label: string; value: string; hint: string; color?: string; loading?: boolean }) {
  return (
    <Paper sx={{ p: 2, height: '100%' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>{label}</Typography>
      {loading ? <Skeleton variant="text" width="60%" sx={{ fontSize: 24 }} /> : <Typography variant="h6" sx={{ fontWeight: 600, color, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25, fontSize: 10 }}>{hint}</Typography>
    </Paper>
  );
}

type Range = '12M' | '24M' | 'ALL';

export default function ServiceTickets() {
  const { data, isLoading, error } = useSheetTab('service_tickets');
  const snap = data as unknown as Snap | undefined;
  const [range, setRange] = useState<Range>('24M');
  const monthlyTable = useCollapse(true);
  const openTable = useCollapse(true);

  const rows = useMemo<MonthRow[]>(() => {
    const all = snap?.monthly ?? [];
    if (range === 'ALL') return all;
    return all.slice(range === '12M' ? -13 : -25);
  }, [snap, range]);

  const chart = useMemo(() => rows.map((r) => ({
    month: monthLabel(r.month),
    created: r.created,
    closed: -r.closed,
    backlog: r.open_at_month_end,
    resolution: r.cohort_median_resolution_days,
  })), [rows]);

  const t = snap?.ttm;
  const totals = snap?.totals;

  if (error) {
    return (
      <Box>
        <PageHeader title="Service Tickets" subtitle="HubSpot Help Desk performance" />
        <Alert severity="error">Failed to load service_tickets — {String(error)}</Alert>
      </Box>
    );
  }

  return (
    <Box>
      <PageHeader
        title="Service Tickets"
        subtitle="HubSpot Help Desk volume, backlog and responsiveness — how much support the business absorbs, and how fast it clears."
        question="durable"
      />

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={2.4}>
          <Kpi label="Open now" value={N0.format(totals?.open ?? 0)} hint={`of ${N0.format(totals?.tickets ?? 0)} ever raised`} color={(totals?.open ?? 0) > 200 ? 'warning.main' : 'success.main'} loading={isLoading} />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Kpi label="Tickets / month" value={N0.format(Math.round(t?.per_month ?? 0))} hint="trailing 12 months" loading={isLoading} />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Kpi label="Median time to close" value={days(t?.cohort_median_resolution_days)} hint={`cohort basis · ${N0.format(t?.cohort_measurable ?? 0)} measurable`} color="primary.main" loading={isLoading} />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Kpi label="Closed within 7 days" value={pct(t?.within_7d_rate)} hint={`${pct(t?.same_day_rate)} same day`} loading={isLoading} />
        </Grid>
        <Grid item xs={12} sm={6} md={2.4}>
          <Kpi label="Net queue change" value={`${(t?.net ?? 0) > 0 ? '+' : ''}${N0.format(t?.net ?? 0)}`} hint={`${N0.format(t?.created ?? 0)} in · ${N0.format(t?.closed ?? 0)} out (TTM)`} color={(t?.net ?? 0) > 0 ? 'error.main' : 'success.main'} loading={isLoading} />
        </Grid>
      </Grid>

      {snap && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>Resolution times exclude bulk closes.</strong> {pct(snap.data_quality.instant_close_rate_all_time)} of all closed tickets carry a close timestamp identical to their creation — a migration artifact, not handling time. Left in, the median reads 0 days and the team looks instantaneous.
          The rate is falling fast as the desk matures (93% of 2023 tickets, 40% of 2025, 19% of 2026), so recent months carry far more signal.
          {snap.ttm.purge_months.length > 0 && <> One month in the window, <strong>{snap.ttm.purge_months.map(monthLabel).join(', ')}</strong>, closed more than three times what it took in — a backlog clear-out, flagged in the table below.</>}
          {' '}Volume and backlog are unaffected: creation dates are real throughout.
        </Alert>
      )}

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Volume and backlog</Typography>
          <InfoIcon info={<><strong>Bars:</strong> tickets created (up) against tickets closed (down) each month — when the bars balance, the desk is keeping pace.<br /><br /><strong>Line:</strong> open tickets at month end, the running backlog.<br /><br />Backlog is a created-minus-closed balance from the first month on record ({snap?.window.first_month}), so it is a trend rather than an audited count.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <ToggleButtonGroup size="small" exclusive value={range} onChange={(_, v) => v && setRange(v)} sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}>
            <ToggleButton value="12M">12M</ToggleButton>
            <ToggleButton value="24M">24M</ToggleButton>
            <ToggleButton value="ALL">All</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={300} /> : (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="v" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="b" orientation="right" tick={{ fontSize: 11 }} />
              <RTooltip
                contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 12 }}
                formatter={(v: number, n: string) => [n === 'closed' ? N0.format(Math.abs(v)) : N0.format(v), n === 'backlog' ? 'Open at month end' : n === 'closed' ? 'Closed' : 'Created']}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="v" dataKey="created" fill="#2C73FF" name="created" />
              <Bar yAxisId="v" dataKey="closed" fill="#1A9E5C" name="closed" />
              <Line yAxisId="b" type="monotone" dataKey="backlog" stroke="#D69E2E" strokeWidth={2} dot={false} name="backlog" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Paper>

      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} md={7}>
          <Paper sx={{ p: 3, height: '100%' }}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
              <Typography variant="h6" sx={{ fontWeight: 500 }}>Time to close</Typography>
              <InfoIcon info={<><strong>Cohort basis:</strong> of the tickets <em>created</em> in a month, the median time they took to close. This is the metric that answers "how fast do we handle new work".<br /><br />It is deliberately not "tickets closed this month", which a backlog clear-out distorts — {snap?.ttm.purge_months.map(monthLabel).join(', ') || 'one month in this window'} closed old tickets en masse and would have reported a median in the hundreds of days.<br /><br />Recent cohorts are right-censored: tickets still open are excluded, so the newest months read slightly fast.</>} />
            </Stack>
            {isLoading ? <Skeleton variant="rectangular" height={240} /> : (
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} scale="sqrt" />
                  <RTooltip
                    contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 12 }}
                    formatter={(v: number) => [days(v), 'Median time to close']}
                  />
                  <Line type="monotone" dataKey="resolution" stroke="#2C73FF" strokeWidth={2} dot={{ r: 2 }} name="resolution" connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} md={5}>
          <Paper sx={{ p: 3, height: '100%' }}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
              <Typography variant="h6" sx={{ fontWeight: 500 }}>Where tickets come from</Typography>
              <InfoIcon info="Channel mix across the full history. Chat volume is the lever most worth watching — it is cheaper to serve than email but tends to arrive in bursts." />
            </Stack>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Channel</TableCell>
                  <TableCell align="right">Tickets</TableCell>
                  <TableCell align="right">Share</TableCell>
                  <TableCell align="right">Median close</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(snap?.by_source ?? []).map((s) => (
                  <TableRow key={s.key} hover>
                    <TableCell>{s.key}</TableCell>
                    <TableCell align="right">{N0.format(s.tickets)}</TableCell>
                    <TableCell align="right" sx={{ color: 'text.secondary' }}>{pct(s.tickets / (totals?.tickets || 1))}</TableCell>
                    <TableCell align="right">{days(s.median_resolution_days)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Who is handling them</Typography>
          <InfoIcon info="Trailing twelve months, by ticket owner in HubSpot. Median close excludes bulk closes, so an owner who inherited a migration batch is not credited with instant resolutions." />
          <Box sx={{ flexGrow: 1 }} />
          <CsvExportButton
            filename="service_tickets_by_owner.csv"
            rows={snap?.by_owner ?? []}
            columns={[
              { key: 'key', label: 'Owner' },
              { key: 'tickets', label: 'Tickets (TTM)' },
              { key: 'open', label: 'Open' },
              { key: 'closed', label: 'Closed' },
              { key: 'median_resolution_days', label: 'Median close (days)' },
              { key: 'measurable', label: 'Measurable' },
            ]}
          />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Owner</TableCell>
              <TableCell align="right">Tickets (TTM)</TableCell>
              <TableCell align="right">Still open</TableCell>
              <TableCell align="right">Median close</TableCell>
              <TableCell align="right">Measurable</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(snap?.by_owner ?? []).slice(0, 12).map((o) => (
              <TableRow key={o.key} hover>
                <TableCell sx={{ fontWeight: o.key === '(unassigned)' ? 400 : 500, color: o.key === '(unassigned)' ? 'text.secondary' : 'text.primary' }}>{o.key}</TableCell>
                <TableCell align="right">{N0.format(o.tickets)}</TableCell>
                <TableCell align="right" sx={{ color: o.open > 0 ? 'warning.main' : 'text.secondary' }}>{o.open || '—'}</TableCell>
                <TableCell align="right">{days(o.median_resolution_days)}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary', fontSize: 11 }}>{N0.format(o.measurable)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Heaviest support load</Typography>
          <InfoIcon info={<><strong>Tickets per $1K MRR</strong> is the ratio worth watching: it is support cost against what the account actually pays. A high number is a margin problem, and in this book it has also run ahead of churn.<br /><br />{snap?.data_quality.attribution}</>} />
          <Box sx={{ flexGrow: 1 }} />
          <CsvExportButton
            filename="service_tickets_by_customer.csv"
            rows={snap?.customers ?? []}
            columns={[
              { key: 'name', label: 'Customer' },
              { key: 'allmoxy_customer_id', label: 'Allmoxy ID' },
              { key: 'status', label: 'Status' },
              { key: 'mrr', label: 'MRR' },
              { key: 'ttm_tickets', label: 'Tickets (TTM)' },
              { key: 'tickets', label: 'Tickets (all time)' },
              { key: 'open', label: 'Open' },
              { key: 'tickets_per_1k_mrr', label: 'Tickets per $1K MRR' },
              { key: 'median_resolution_days', label: 'Median close (days)' },
              { key: 'last_ticket', label: 'Last ticket' },
            ]}
          />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Customer</TableCell>
              <TableCell align="right">Tickets (TTM)</TableCell>
              <TableCell align="right">All time</TableCell>
              <TableCell align="right">Open</TableCell>
              <TableCell align="right">MRR</TableCell>
              <TableCell align="right">Per $1K MRR</TableCell>
              <TableCell align="right">Median close</TableCell>
              <TableCell>Last ticket</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(snap?.customers ?? []).slice(0, 20).map((c) => (
              <TableRow key={c.allmoxy_customer_id} hover>
                <TableCell><CustomerLink name={c.name} /></TableCell>
                <TableCell align="right" sx={{ fontWeight: 500 }}>{N0.format(c.ttm_tickets)}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{N0.format(c.tickets)}</TableCell>
                <TableCell align="right" sx={{ color: c.open > 0 ? 'warning.main' : 'text.secondary' }}>{c.open || '—'}</TableCell>
                <TableCell align="right">{c.mrr > 0 ? USD0.format(c.mrr) : '—'}</TableCell>
                <TableCell align="right" sx={{ color: (c.tickets_per_1k_mrr ?? 0) > 12 ? 'error.main' : 'text.primary' }}>
                  {c.tickets_per_1k_mrr == null ? '—' : c.tickets_per_1k_mrr.toFixed(1)}
                </TableCell>
                <TableCell align="right">{days(c.median_resolution_days)}</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontSize: 11 }}>{c.last_ticket ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <CollapseToggle open={openTable.open} onToggle={openTable.toggle} />
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Open tickets · {N0.format(snap?.open_tickets.length ?? 0)}</Typography>
          <InfoIcon info="Everything still in the queue, oldest first. Age is days since creation, so the top of this list is the backlog that has been sitting longest." />
          <Box sx={{ flexGrow: 1 }} />
          <CsvExportButton
            filename="service_tickets_open.csv"
            rows={snap?.open_tickets ?? []}
            columns={[
              { key: 'age_days', label: 'Age (days)' },
              { key: 'subject', label: 'Subject' },
              { key: 'customer', label: 'Customer' },
              { key: 'owner', label: 'Owner' },
              { key: 'stage', label: 'Stage' },
              { key: 'source', label: 'Source' },
              { key: 'priority', label: 'Priority' },
              { key: 'created', label: 'Created' },
              { key: 'url', label: 'HubSpot URL' },
            ]}
          />
        </Stack>
        {openTable.open && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Age</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell>Customer</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell>Stage</TableCell>
                <TableCell>Source</TableCell>
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(snap?.open_tickets ?? []).slice(0, 60).map((o) => (
                <TableRow key={o.id} hover>
                  <TableCell sx={{ color: (o.age_days ?? 0) > 90 ? 'error.main' : (o.age_days ?? 0) > 30 ? 'warning.main' : 'text.primary', fontWeight: 500 }}>
                    {o.age_days != null ? `${N0.format(o.age_days)}d` : '—'}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 380 }}>
                    {o.url ? <Link href={o.url} target="_blank" rel="noopener" sx={{ color: 'text.primary', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>{o.subject || '(no subject)'}</Link> : (o.subject || '(no subject)')}
                  </TableCell>
                  <TableCell>{o.customer ? <CustomerLink name={o.customer} /> : <span style={{ opacity: 0.5 }}>—</span>}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{o.owner ?? '—'}</TableCell>
                  <TableCell><Chip size="small" label={o.stage ?? '—'} sx={{ height: 18, fontSize: 10 }} /></TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 11 }}>{o.source ?? '—'}</TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 11 }}>{o.created ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <CollapseToggle open={monthlyTable.open} onToggle={monthlyTable.toggle} />
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Month by month</Typography>
          <Box sx={{ flexGrow: 1 }} />
          <CsvExportButton
            filename="service_tickets_monthly.csv"
            rows={snap?.monthly ?? []}
            columns={[
              { key: 'month', label: 'Month' },
              { key: 'created', label: 'Created' },
              { key: 'closed', label: 'Closed' },
              { key: 'net', label: 'Net' },
              { key: 'open_at_month_end', label: 'Backlog' },
              { key: 'cohort_median_resolution_days', label: 'Median close (days)' },
              { key: 'cohort_p90_resolution_days', label: 'p90 close (days)' },
              { key: 'instant_close_rate', label: 'Bulk-close share' },
              { key: 'backlog_purge', label: 'Backlog clear-out' },
            ]}
          />
        </Stack>
        {monthlyTable.open && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Month</TableCell>
                <TableCell align="right">Created</TableCell>
                <TableCell align="right">Closed</TableCell>
                <TableCell align="right">Net</TableCell>
                <TableCell align="right">Backlog</TableCell>
                <TableCell align="right">Median close</TableCell>
                <TableCell align="right">p90</TableCell>
                <TableCell align="right">Bulk closes</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {[...rows].reverse().map((r) => (
                <TableRow key={r.month} hover sx={r.backlog_purge ? { bgcolor: 'rgba(214,158,46,0.08)' } : undefined}>
                  <TableCell sx={{ fontWeight: 500 }}>
                    {monthLabel(r.month)}
                    {r.partial && <Chip size="small" label="partial" sx={{ ml: 0.75, height: 16, fontSize: 9 }} />}
                    {r.backlog_purge && <Chip size="small" color="warning" label="backlog clear-out" sx={{ ml: 0.75, height: 16, fontSize: 9 }} />}
                  </TableCell>
                  <TableCell align="right">{N0.format(r.created)}</TableCell>
                  <TableCell align="right">{N0.format(r.closed)}</TableCell>
                  <TableCell align="right" sx={{ color: r.net > 0 ? 'error.main' : 'success.main' }}>{r.net > 0 ? `+${r.net}` : r.net}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 500 }}>{N0.format(r.open_at_month_end)}</TableCell>
                  <TableCell align="right">{days(r.cohort_median_resolution_days)}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>{days(r.cohort_p90_resolution_days)}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary', fontSize: 11 }}>{pct(r.instant_close_rate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      {snap && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 2 }}>
          HubSpot Help Desk · {snap.window.first_month} – {snap.window.last_month} · {N0.format(snap.totals.tickets)} tickets ·
          {' '}{N0.format(snap.totals.customers_with_tickets)} customers matched, {N0.format(snap.totals.unattributed_tickets)} tickets with no matching customer record ·
          {' '}synced {snap.source_fetched_at ? snap.source_fetched_at.slice(0, 10) : '—'}
        </Typography>
      )}
    </Box>
  );
}
