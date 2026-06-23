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
import TableSortLabel from '@mui/material/TableSortLabel';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

// DEV-board tickets tagged with customers (Customer labels field), weighted by
// the revenue of those customers — a Customer Success → Dev prioritization view.
type FeatureCustomer = { allmoxy_customer_id: number; name: string; mrr: number; lifetime: number; status: string };
type Row = {
  key: string;
  summary: string;
  status: string | null;
  stage_category: string | null; // To Do | In Progress | Done
  issue_type: string | null;
  priority: string | null;
  issue_score: number | null;
  created: string | null;
  updated: string | null;
  url: string;
  customers: FeatureCustomer[];
  tag_count: number;
  customer_count: number;
  active_customer_count: number;
  total_mrr: number;
  total_arr: number;
  total_lifetime: number;
  unmatched_labels: string[];
};
type Aggregates = {
  total_tickets: number;
  open_tickets: number;
  done_tickets: number;
  tickets_with_matched_customer: number;
  open_mrr_at_stake: number;
  distinct_customers_tagged: number;
  unmatched_labels: string[];
};
type Snapshot = { fetchedAt: string; aggregates: Aggregates; rows: Row[] };

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const DEV_BOARD = 'https://allmoxy.atlassian.net/jira/software/c/projects/DEV/boards/2';

function catColor(c: string | null): string {
  if (c === 'Done') return '#1A9E5C';
  if (c === 'In Progress') return '#2C73FF';
  return '#8B949E'; // To Do / other
}

type SortKey = 'mrr' | 'customers' | 'score' | 'updated' | 'key';

export default function Features() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('features');
  const snap = data as Snapshot | undefined;
  const rows = snap?.rows ?? [];
  const agg = snap?.aggregates;

  const [showDone, setShowDone] = useState(false);
  const [withRevenueOnly, setWithRevenueOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('mrr');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'key' ? 'asc' : 'desc'); }
  }

  const filtered = useMemo(() => rows.filter((r) => {
    if (!showDone && r.stage_category === 'Done') return false;
    if (withRevenueOnly && r.total_mrr <= 0) return false;
    return true;
  }), [rows, showDone, withRevenueOnly]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case 'mrr': av = a.total_mrr; bv = b.total_mrr; break;
        case 'customers': av = a.customer_count; bv = b.customer_count; break;
        case 'score': av = a.issue_score ?? -1; bv = b.issue_score ?? -1; break;
        case 'updated': av = a.updated ?? ''; bv = b.updated ?? ''; break;
        case 'key': av = a.key; bv = b.key; break;
        default: av = 0; bv = 0;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return b.total_mrr - a.total_mrr;
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  const csvColumns = useMemo(() => ([
    { key: 'ticket', label: 'Ticket', getValue: (r: Row) => r.key },
    { key: 'summary', label: 'Summary', getValue: (r: Row) => r.summary },
    { key: 'status', label: 'Status', getValue: (r: Row) => r.status ?? '' },
    { key: 'type', label: 'Type', getValue: (r: Row) => r.issue_type ?? '' },
    { key: 'customer_count', label: 'Customers', getValue: (r: Row) => r.customer_count },
    { key: 'total_mrr', label: 'MRR at stake', getValue: (r: Row) => r.total_mrr },
    { key: 'total_arr', label: 'ARR at stake', getValue: (r: Row) => r.total_arr },
    { key: 'issue_score', label: 'Dev issue score', getValue: (r: Row) => r.issue_score ?? '' },
    { key: 'customers', label: 'Customer names', getValue: (r: Row) => r.customers.map((c) => c.name).join('; ') },
    { key: 'updated', label: 'Updated', getValue: (r: Row) => r.updated ?? '' },
    { key: 'url', label: 'URL', getValue: (r: Row) => r.url },
  ]), []);

  return (
    <Box>
      <PageHeader
        title="Features"
        subtitle="DEV-board tickets weighted by the revenue of the customers tagged on them — a Customer Success → Dev prioritization signal. Each ticket shows how many customers want it and the MRR they represent, so Dev can weight priority by revenue impact."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load features: {String(error)}</Alert>}

      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <KpiTile label="Open tickets" info="DEV tickets tagged with at least one customer that aren't Done. The CS→Dev prioritization backlog." value={agg?.open_tickets} sub={`${agg?.total_tickets ?? 0} total tagged`} accent="primary.main" valueColor="primary.main" isLoading={isLoading} />
        <KpiTile label="Open MRR at stake" info="Sum of tagged-customer MRR across all open tickets (a customer counts once per ticket). The total recurring revenue represented by the open feature backlog." value={agg ? USD0.format(agg.open_mrr_at_stake) : undefined} sub="across open tickets" accent="success.main" valueColor="success.main" isLoading={isLoading} />
        <KpiTile label="Customers driving features" info="Distinct customers tagged on at least one DEV ticket." value={agg?.distinct_customers_tagged} sub="tagged on ≥1 ticket" isLoading={isLoading} />
        <KpiTile label="Tickets w/ revenue weight" info="Tagged tickets where at least one customer matched the revenue roster. The rest tag customers we couldn't resolve by name (see footer)." value={agg?.tickets_with_matched_customer} sub={`of ${agg?.total_tickets ?? 0} tagged`} isLoading={isLoading} />
      </Grid>

      {/* Controls */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Chip label="Hide done" size="small" onClick={() => setShowDone((v) => !v)} color={!showDone ? 'primary' : 'default'} variant={!showDone ? 'filled' : 'outlined'} sx={{ cursor: 'pointer' }} />
        <Chip label="Revenue-weighted only" size="small" onClick={() => setWithRevenueOnly((v) => !v)} color={withRevenueOnly ? 'primary' : 'default'} variant={withRevenueOnly ? 'filled' : 'outlined'} sx={{ cursor: 'pointer' }} />
        <InfoIcon info="By default Done tickets are hidden (you prioritize open work). 'Revenue-weighted only' hides tickets whose tagged customers have no current MRR." />
        <Box sx={{ flexGrow: 1 }} />
        <Link href={DEV_BOARD} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 13 }}>Open DEV board ↗</Link>
      </Stack>

      <Paper sx={{ p: 0 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>{sorted.length} ticket{sorted.length === 1 ? '' : 's'}</Typography>
          <CsvExportButton filename="features" columns={csvColumns} rows={sorted} />
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <SortTh label="Ticket" k="key" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <TableCell>Status</TableCell>
                <SortTh label="Customers" k="customers" align="right" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <SortTh label="MRR at stake" k="mrr" align="right" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <TableCell align="right">ARR</TableCell>
                <SortTh label="Dev score" k="score" align="right" {...{ sortKey, sortDir, onSort: toggleSort }} />
                <TableCell>Tagged customers</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => <TableRow key={i}><TableCell colSpan={7}><Skeleton variant="text" /></TableCell></TableRow>)
              ) : sorted.length === 0 ? (
                <TableRow><TableCell colSpan={7}><Typography variant="body2" sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>No tickets match the current filters.</Typography></TableCell></TableRow>
              ) : sorted.map((r) => (
                <TableRow key={r.key} hover>
                  <TableCell sx={{ maxWidth: 360 }}>
                    <Box component="a" href={r.url} target="_blank" rel="noopener noreferrer" sx={{ color: 'text.primary', textDecoration: 'none', fontWeight: 500, '&:hover': { textDecoration: 'underline' } }}>
                      {r.summary || r.key}
                    </Box>
                    <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>{r.key}{r.issue_type ? ` · ${r.issue_type}` : ''}</Typography>
                  </TableCell>
                  <TableCell><Chip label={r.status || '—'} size="small" sx={{ height: 20, fontSize: 10.5, fontWeight: 600, bgcolor: catColor(r.stage_category) + '22', color: catColor(r.stage_category) }} /></TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.customer_count || '—'}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: r.total_mrr > 0 ? 'success.main' : 'text.disabled' }}>{r.total_mrr > 0 ? USD0.format(r.total_mrr) : '—'}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{r.total_arr > 0 ? USD0.format(r.total_arr) : '—'}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{r.issue_score ?? '—'}</TableCell>
                  <TableCell sx={{ maxWidth: 320 }}>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {r.customers.slice(0, 6).map((c) => (
                        <CustomerLink key={c.allmoxy_customer_id} id={c.allmoxy_customer_id}>
                          <Chip size="small"
                            label={`${c.name}${c.mrr > 0 ? ` · ${USD0.format(c.mrr)}` : ''}`}
                            sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(44,115,255,0.12)', color: 'primary.light', cursor: 'pointer' }} />
                        </CustomerLink>
                      ))}
                      {r.customer_count > 6 && <Typography variant="caption" sx={{ color: 'text.secondary' }}>+{r.customer_count - 6} more</Typography>}
                      {r.customer_count === 0 && <Typography variant="caption" sx={{ color: 'text.disabled' }}>{r.tag_count > 0 ? 'tags unmatched' : 'none'}</Typography>}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      </Paper>

      {agg && agg.unmatched_labels.length > 0 && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          {agg.unmatched_labels.length} customer tag(s) on DEV tickets didn't match a customer in the roster (no revenue weight applied): {agg.unmatched_labels.slice(0, 30).join(', ')}{agg.unmatched_labels.length > 30 ? '…' : ''}
        </Typography>
      )}
    </Box>
  );
}

function SortTh({ label, k, align, sortKey, sortDir, onSort }: { label: string; k: SortKey; align?: 'right'; sortKey: SortKey; sortDir: 'asc' | 'desc'; onSort: (k: SortKey) => void }) {
  return (
    <TableCell align={align} sortDirection={sortKey === k ? sortDir : false}>
      <TableSortLabel active={sortKey === k} direction={sortKey === k ? sortDir : 'asc'} onClick={() => onSort(k)}>{label}</TableSortLabel>
    </TableCell>
  );
}

function KpiTile({ label, info, value, sub, accent, valueColor, isLoading }: { label: string; info: string; value: number | string | null | undefined; sub: string; accent?: string; valueColor?: string; isLoading: boolean }) {
  return (
    <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
      <Paper sx={{ p: 2, flexGrow: 1, borderLeft: accent ? '3px solid' : undefined, borderColor: accent }}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>{label}</Typography>
          <InfoIcon info={info} />
        </Stack>
        {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
          <>
            <Typography variant="h5" sx={{ fontWeight: 500, color: valueColor }}>{value ?? '—'}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{sub}</Typography>
          </>
        )}
      </Paper>
    </Grid>
  );
}
