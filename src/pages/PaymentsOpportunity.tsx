import { useEffect, useMemo, useState, Fragment } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type AccountRow = {
  account: string; customer_name: string | null; allmoxy_customer_id: number | null;
  customer_status: string | null; subscription_mrr: number | null;
  gross_volume: number; fee_revenue: number; txn_count: number; take_rate: number | null;
  first_seen: string; last_seen: string;
};
type Scenario = { take_rate: number; annual_fee_revenue: number; delta_vs_current: number; multiple_vs_current: number | null };
type ConnectStatus = 'processing' | 'lapsed' | 'never';
type CustomerRow = {
  allmoxy_customer_id: number | null; name: string; status: string; primary_segment: string | null;
  subscription_mrr: number; is_launched: string | null; connect_status: ConnectStatus; ever_processed: boolean;
  annual_order_volume: number; connect_gmv_annual?: number; connect_attach_rate?: number | null;
  annual_connect_fee: number; est_annual_connect_fee: number | null;
  lapsed_note?: string | null;
};
type TableFilter = 'processing' | 'lapsed' | 'not_on_connect' | 'targets' | null;
type MonthRow = { month: string; gross_volume: number; fee_revenue: number; txn_count: number; take_rate: number | null };
type Snapshot = {
  stripe_fetchedAt: string;
  window: { since: string };
  currencies: Record<string, number>;
  currency_caveat: string | null;
  annualized: { basis: string; gross_volume: number; fee_revenue: number; txn_count: number; blended_take_rate: number | null };
  attach: { connected_accounts: number; active_customers: number; active_customers_on_connect: number; attach_rate: number | null };
  scenarios: Scenario[];
  take_rate_distribution: Record<string, number>;
  penetration?: {
    active_customers: number; processing_now: number; attach_rate: number | null; lapsed: number; never: number;
    not_processing: number; attach_target_order_volume: number; attach_target_fee_potential: number;
    attach_potential_basis: string;
  };
  customers?: CustomerRow[];
  monthly: MonthRow[];
  by_account: AccountRow[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_C = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const monthLabel = (m: string) => { const [y, mo] = m.split('-'); return new Date(Number(y), Number(mo) - 1).toLocaleString('en-US', { month: 'short', year: '2-digit' }); };
const STATUS_BG: Record<ConnectStatus, string> = { processing: 'rgba(26,158,92,0.16)', lapsed: 'rgba(245,166,35,0.18)', never: 'rgba(139,148,158,0.16)' };
const STATUS_FG: Record<ConnectStatus, string> = { processing: '#1A9E5C', lapsed: '#B07206', never: '#8B949E' };

export default function PaymentsOpportunity() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('connect_volume');
  const snap = data as Snapshot | undefined;

  const trend = useMemo(() => {
    const now = new Date();
    const cm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return (snap?.monthly ?? []).filter((m) => m.month < cm).slice(-24)
      .map((m) => ({ month: monthLabel(m.month), GMV: m.gross_volume, take: m.take_rate != null ? m.take_rate * 100 : null }));
  }, [snap]);

  const a = snap?.annualized;
  const at = snap?.attach;
  const pen = snap?.penetration;
  const customers = snap?.customers ?? [];

  // KPI-driven filter on the customer table. Default ('targets') = non-processing
  // customers with order volume — the attach pipeline. Each KPI toggles its set.
  const [tableFilter, setTableFilter] = useState<TableFilter>('targets');
  const toggleFilter = (f: Exclude<TableFilter, null>) => setTableFilter((cur) => (cur === f ? 'targets' : f));
  const filteredCustomers = useMemo(() => {
    let rows = customers;
    if (tableFilter === 'processing') rows = customers.filter((c) => c.connect_status === 'processing');
    else if (tableFilter === 'lapsed') rows = customers.filter((c) => c.connect_status === 'lapsed');
    else if (tableFilter === 'not_on_connect') rows = customers.filter((c) => c.connect_status === 'never');
    else rows = customers.filter((c) => c.connect_status !== 'processing' && c.annual_order_volume > 0); // 'targets' / default
    const processingView = tableFilter === 'processing';
    return [...rows].sort((x, y) => processingView
      ? (y.annual_connect_fee - x.annual_connect_fee) || (y.annual_order_volume - x.annual_order_volume)
      : (y.annual_order_volume - x.annual_order_volume));
  }, [customers, tableFilter]);
  const showingProcessing = tableFilter === 'processing';

  // Lapsed notes: why each lapsed customer stopped processing. Seeded from the
  // snapshot (connect_lapsed_notes.json), editable in-browser via localStorage,
  // exportable so edits can be persisted for the team. Rows expand to show/edit.
  const NOTES_KEY = 'allmoxy.connect_lapsed_notes';
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>(() => {
    try { const r = localStorage.getItem(NOTES_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(NOTES_KEY, JSON.stringify(noteEdits)); } catch { /* ignore */ } }, [noteEdits]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) => setExpanded((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const noteFor = (c: CustomerRow) => {
    const k = String(c.allmoxy_customer_id);
    return (k in noteEdits) ? noteEdits[k] : (c.lapsed_note ?? '');
  };
  const setNote = (id: number | null, v: string) => { if (id == null) return; setNoteEdits((cur) => ({ ...cur, [String(id)]: v })); };
  const hasNoteEdits = Object.keys(noteEdits).length > 0;
  const copyNotesJson = () => {
    // Merge snapshot notes with local edits so the export is the full set.
    const merged: Record<string, string> = {};
    for (const c of customers) if (c.connect_status === 'lapsed' && c.lapsed_note) merged[String(c.allmoxy_customer_id)] = c.lapsed_note;
    for (const [k, v] of Object.entries(noteEdits)) { if (v && v.trim()) merged[k] = v.trim(); else delete merged[k]; }
    navigator.clipboard?.writeText(JSON.stringify({ notes: merged }, null, 2)).then(() => {}, () => {});
  };
  const current = snap?.scenarios.find((s) => Math.abs(s.take_rate - (a?.blended_take_rate ?? 0.005)) < 0.0006) ?? snap?.scenarios[0];
  const target1 = snap?.scenarios.find((s) => Math.abs(s.take_rate - 0.01) < 0.0001);

  const acctCsv = useMemo(() => ([
    { key: 'customer', label: 'Customer', getValue: (r: AccountRow) => r.customer_name ?? r.account },
    { key: 'account', label: 'Stripe account', getValue: (r: AccountRow) => r.account },
    { key: 'gross_volume', label: 'GMV (TTM-window)', getValue: (r: AccountRow) => r.gross_volume },
    { key: 'fee_revenue', label: 'Fee revenue', getValue: (r: AccountRow) => r.fee_revenue },
    { key: 'take_rate', label: 'Take rate', getValue: (r: AccountRow) => r.take_rate != null ? (r.take_rate * 100).toFixed(2) + '%' : '' },
    { key: 'txn_count', label: 'Transactions', getValue: (r: AccountRow) => r.txn_count },
    { key: 'status', label: 'Customer status', getValue: (r: AccountRow) => r.customer_status ?? '' },
  ]), []);

  return (
    <Box>
      <PageHeader
        title="Payments Opportunity"
        subtitle="The embedded-payments thesis: gross processing volume (GMV) flowing through Stripe Connect, our take-rate, and the revenue upside from take-rate and attach expansion. Pulled live from the Stripe application_fees API (charge expanded for gross)."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load connect_volume: {String(error)}</Alert>}
      {snap?.currency_caveat && (
        <Alert severity="info" sx={{ mb: 2 }}>{snap.currency_caveat} Currency mix: {Object.entries(snap.currencies).map(([c, n]) => `${c} ${n.toLocaleString()}`).join(' · ')}.</Alert>
      )}

      {/* Headline KPIs */}
      <Grid container spacing={2} sx={{ mb: 1 }}>
        <Kpi label="Annual processing volume (GMV)" value={a ? USD_C.format(a.gross_volume) : undefined} sub={a?.basis} accent="primary.main" valueColor="primary.main" loading={isLoading}
          info="Gross dollars charged through Stripe Connect across all connected accounts over the last 12 complete months. From the live application_fees API with the underlying charge expanded." />
        <Kpi label="Blended take rate" value={a?.blended_take_rate != null ? (a.blended_take_rate * 100).toFixed(2) + '%' : undefined} sub="fee ÷ GMV" loading={isLoading}
          info="Our application fee as a share of gross volume. Nearly the entire book sits at a flat 0.50%, with a handful grandfathered at 1.0% and a few discounted." />
        <Kpi label="Connect fee revenue" value={a ? USD0.format(a.fee_revenue) : undefined} sub={`${a?.txn_count.toLocaleString() ?? '—'} transactions`} accent="success.main" valueColor="success.main" loading={isLoading}
          info="Annualized Connect fee revenue — what we monetize today off the processing volume." />
        <Kpi label="Connect attach" value={at ? `${((at.attach_rate ?? 0) * 100).toFixed(0)}%` : undefined} sub={at ? `${at.active_customers_on_connect} of ${at.active_customers} active · ${at.connected_accounts} accounts total` : undefined} loading={isLoading}
          info="Share of the active customer book currently processing payments on Connect. The un-attached majority is the second growth lever (alongside take-rate)." />
      </Grid>

      {/* Monthly GMV + take rate */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Typography variant="h6" sx={{ mb: 2 }}>Monthly processing volume & take rate</Typography>
        <Box sx={{ height: 300 }}>
          {isLoading ? <Skeleton variant="rounded" height={300} /> : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="month" stroke="#8B949E" fontSize={10} interval={1} />
                <YAxis yAxisId="l" stroke="#8B949E" fontSize={10} width={52} tickFormatter={(v) => USD_C.format(Number(v))} />
                <YAxis yAxisId="r" orientation="right" stroke="#8B949E" fontSize={10} width={42} domain={[0, 'dataMax + 0.5']} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} />
                <RTooltip
                  formatter={(v: number, n: string) => n === 'take' ? `${Number(v).toFixed(2)}%` : USD0.format(v)}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="l" dataKey="GMV" name="GMV" fill="#2C73FF" />
                <Line yAxisId="r" dataKey="take" name="take" stroke="#1A9E5C" strokeWidth={2} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </Box>
      </Paper>

      {/* The opportunity: take-rate expansion */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="h6">Take-rate expansion</Typography>
          <InfoIcon info="Holding today's GMV constant, what Connect fee revenue would be at higher take-rates. The whole book is priced at 0.50% — moving toward the 1.0% that some accounts already pay roughly doubles payments revenue at zero acquisition cost. This is the lever a PE buyer underwrites; attach growth compounds on top." />
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
          On {a ? USD_C.format(a.gross_volume) : '—'} annual GMV · current blended {a?.blended_take_rate != null ? (a.blended_take_rate * 100).toFixed(2) + '%' : '—'}
        </Typography>
        <Grid container spacing={2}>
          {(snap?.scenarios ?? []).map((s) => {
            const isCurrent = current && s.take_rate === current.take_rate;
            return (
              <Grid item xs={6} md={3} key={s.take_rate}>
                <Box sx={{ p: 2, borderRadius: 1, border: '1px solid', borderColor: isCurrent ? 'divider' : 'rgba(26,158,92,0.4)', bgcolor: isCurrent ? 'transparent' : 'rgba(26,158,92,0.06)', height: '100%' }}>
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, fontSize: 11 }}>{(s.take_rate * 100).toFixed(2)}% take</Typography>
                    {isCurrent && <Chip label="today" size="small" sx={{ height: 16, fontSize: 9 }} />}
                  </Stack>
                  <Typography variant="h5" sx={{ fontWeight: 600, mt: 0.5 }}>{USD0.format(s.annual_fee_revenue)}<Box component="span" sx={{ fontSize: 12, fontWeight: 400, color: 'text.secondary' }}>/yr</Box></Typography>
                  {!isCurrent && (
                    <Typography variant="caption" sx={{ color: 'success.main', fontWeight: 600 }}>
                      +{USD0.format(s.delta_vs_current)}/yr{s.multiple_vs_current ? ` · ${s.multiple_vs_current}×` : ''}
                    </Typography>
                  )}
                </Box>
              </Grid>
            );
          })}
        </Grid>
        {target1 && (
          <Typography variant="body2" sx={{ color: 'text.secondary', mt: 2 }}>
            Standardizing the book to the <strong>1.0%</strong> some accounts already pay would lift Connect fee revenue to <strong style={{ color: '#1A9E5C' }}>{USD0.format(target1.annual_fee_revenue)}/yr</strong> ({target1.multiple_vs_current}× today), <strong>+{USD0.format(target1.delta_vs_current)}/yr</strong> at zero acquisition cost — before any attach growth.
          </Typography>
        )}
      </Paper>

      {/* Connect penetration + attach opportunity (the second growth lever) */}
      {pen && (
        <Paper sx={{ p: 3, mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="h6">Attach opportunity</Typography>
            <InfoIcon info={<><strong>The second growth lever: monetizing the customers not yet on Connect.</strong><br /><br />"Processing now" = any Connect fee in the last 3 months. <strong>Click any metric below to filter the table</strong> to that set. Attach targets are active customers <em>not</em> processing, ranked by verified-order volume (the addressable base), with fee potential at the standard 0.5% take. {pen.attach_potential_basis}</>} />
          </Stack>
          <Grid container spacing={2} sx={{ mt: 0.5, mb: 1 }}>
            <Kpi label="Processing now" value={`${pen.processing_now}`} sub={`of ${pen.active_customers} active · ${((pen.attach_rate ?? 0) * 100).toFixed(0)}% attach`} accent="success.main" loading={isLoading} info="Active customers with any Connect fee in the last 3 months. Click to list them." onClick={() => toggleFilter('processing')} selected={tableFilter === 'processing'} />
            <Kpi label="Lapsed" value={`${pen.lapsed}`} sub="processed before, idle 3mo+" accent="warning.main" loading={isLoading} info="Previously processed on Connect but idle 3+ months — reactivation targets. Click to list them." onClick={() => toggleFilter('lapsed')} selected={tableFilter === 'lapsed'} />
            <Kpi label="Not on Connect" value={`${pen.never}`} sub="never processed on Connect" loading={isLoading} info="Active customers that have never processed a payment on Connect (lapsed accounts — which were on Connect and fell off — are counted separately). Click to list them." onClick={() => toggleFilter('not_on_connect')} selected={tableFilter === 'not_on_connect'} />
            <Kpi label="Attach fee potential" value={`${USD0.format(pen.attach_target_fee_potential)}/yr`} sub={`~${USD0.format(Math.round(pen.attach_target_fee_potential / 12))}/mo · at 0.5% on ${USD_C.format(pen.attach_target_order_volume)} orders`} accent="primary.main" valueColor="primary.main" loading={isLoading} info="Estimated Connect fee if non-processing customers with order volume attached at the standard 0.5% take. Annual headline; monthly = annual ÷ 12. Upper bound — not all order volume is card-processed. Click to list those targets." onClick={() => toggleFilter('targets')} selected={tableFilter === 'targets'} />
          </Grid>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1, mb: 0.5 }}>
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              {tableFilter === 'processing' ? 'Customers processing on Connect — by Connect fee'
                : tableFilter === 'lapsed' ? 'Lapsed customers — previously processed, now idle'
                : tableFilter === 'not_on_connect' ? 'Active customers never on Connect'
                : 'Attach targets — not processing, by order volume'}
              {' '}({filteredCustomers.length})
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              {hasNoteEdits && <Button size="small" variant="outlined" onClick={copyNotesJson} sx={{ fontSize: 11, textTransform: 'none' }}>Copy notes JSON</Button>}
              <CsvExportButton filename="connect_customers" rows={filteredCustomers} columns={[
                { key: 'name', label: 'Customer', getValue: (r: CustomerRow) => r.name },
                { key: 'connect_status', label: 'Connect status', getValue: (r: CustomerRow) => r.connect_status },
                { key: 'status', label: 'Customer status', getValue: (r: CustomerRow) => r.status },
                { key: 'segment', label: 'Segment', getValue: (r: CustomerRow) => r.primary_segment ?? '' },
                { key: 'mrr', label: 'Subscription MRR', getValue: (r: CustomerRow) => r.subscription_mrr },
                { key: 'orders', label: 'Annual order volume', getValue: (r: CustomerRow) => r.annual_order_volume },
                { key: 'attach_rate', label: 'Connect attach rate', getValue: (r: CustomerRow) => r.connect_attach_rate != null ? (r.connect_attach_rate * 100).toFixed(0) + '%' : '' },
                { key: 'connect_fee', label: 'Connect fee (actual, TTM)', getValue: (r: CustomerRow) => r.annual_connect_fee },
                { key: 'est_fee', label: 'Est annual Connect fee @0.5%', getValue: (r: CustomerRow) => r.est_annual_connect_fee ?? '' },
                { key: 'est_fee_monthly', label: 'Est monthly Connect fee @0.5%', getValue: (r: CustomerRow) => r.est_annual_connect_fee != null ? Math.round(r.est_annual_connect_fee / 12) : '' },
                { key: 'lapsed_note', label: 'Lapsed note', getValue: (r: CustomerRow) => r.connect_status === 'lapsed' ? noteFor(r) : '' },
              ]} />
            </Stack>
          </Stack>
          {hasNoteEdits && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>Note edits are saved in this browser only. Click <strong>Copy notes JSON</strong> and ask Claude to apply it to <code>connect_lapsed_notes.json</code> + rebuild to share with the team.</Typography>}
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Customer</TableCell>
                  <TableCell>Connect</TableCell>
                  <TableCell>Segment</TableCell>
                  <TableCell align="right">Subscription MRR</TableCell>
                  <TableCell align="right">Annual order volume</TableCell>
                  <TableCell align="right">Connect attach rate</TableCell>
                  <TableCell align="right">{showingProcessing ? 'Connect fee (TTM/yr)' : 'Est. Connect fee @0.5%/yr'}</TableCell>
                  <TableCell align="right">{showingProcessing ? 'Monthly' : 'Est. monthly'}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredCustomers.length === 0 ? (
                  <TableRow><TableCell colSpan={8}><Typography variant="body2" sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>No customers in this set.</Typography></TableCell></TableRow>
                ) : filteredCustomers.slice(0, 30).map((o) => {
                  const fee = o.connect_status === 'processing' ? o.annual_connect_fee : o.est_annual_connect_fee;
                  const id = o.allmoxy_customer_id;
                  const isLapsed = o.connect_status === 'lapsed';
                  const isOpen = id != null && expanded.has(id);
                  const hasNote = !!noteFor(o).trim();
                  return (
                    <Fragment key={id ?? o.name}>
                      <TableRow hover sx={isLapsed ? { '& > *': { borderBottom: isOpen ? 'unset' : undefined } } : undefined}>
                        <TableCell>
                          <Stack direction="row" spacing={0.5} alignItems="center">
                            {isLapsed && (
                              <IconButton size="small" onClick={() => id != null && toggleExpand(id)} sx={{ p: 0.25 }} aria-label="toggle lapsed note">
                                <KeyboardArrowDownIcon fontSize="small" sx={{ transition: 'transform 150ms', transform: isOpen ? 'rotate(180deg)' : 'none', color: hasNote ? 'warning.main' : 'text.disabled' }} />
                              </IconButton>
                            )}
                            {id != null ? <CustomerLink id={id}>{o.name}</CustomerLink> : <span>{o.name}</span>}
                            {isLapsed && hasNote && !isOpen && <Box component="span" sx={{ fontSize: 9, color: 'warning.main' }}>📝</Box>}
                          </Stack>
                        </TableCell>
                        <TableCell><Box component="span" sx={{ fontSize: 9.5, px: 0.6, py: 0.2, borderRadius: 0.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', bgcolor: STATUS_BG[o.connect_status], color: STATUS_FG[o.connect_status] }}>{o.connect_status}</Box></TableCell>
                        <TableCell><Typography variant="caption" sx={{ color: 'text.secondary' }}>{o.primary_segment ?? '—'}</Typography></TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{USD0.format(o.subscription_mrr)}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{o.annual_order_volume > 0 ? USD0.format(o.annual_order_volume) : '—'}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: o.connect_attach_rate ? 'text.primary' : 'text.disabled' }}>{o.connect_attach_rate ? `${(o.connect_attach_rate * 100).toFixed(0)}%` : '—'}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'success.main', fontWeight: 600 }}>{fee ? USD0.format(fee) : '—'}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'success.main' }}>{fee ? `${USD0.format(Math.round(fee / 12))}/mo` : '—'}</TableCell>
                      </TableRow>
                      {isLapsed && (
                        <TableRow>
                          <TableCell colSpan={8} sx={{ py: 0, borderBottom: isOpen ? undefined : 'none' }}>
                            <Collapse in={isOpen} timeout="auto" unmountOnExit>
                              <Box sx={{ py: 2, px: 1 }}>
                                <Typography variant="caption" sx={{ color: 'warning.main', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, fontSize: 10 }}>Why they lapsed</Typography>
                                <TextField
                                  fullWidth multiline minRows={2} size="small" sx={{ mt: 0.75 }}
                                  placeholder="Add a note on why this customer stopped processing on Connect (from HubSpot notes, CS calls, etc.)…"
                                  value={noteFor(o)}
                                  onChange={(e) => setNote(id, e.target.value)}
                                />
                              </Box>
                            </Collapse>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
          {filteredCustomers.length > 30 && <Typography variant="caption" sx={{ color: 'text.secondary', mt: 1, display: 'block' }}>Showing top 30 of {filteredCustomers.length} · full list in CSV.</Typography>}
        </Paper>
      )}

      {/* Top accounts by GMV */}
      <Paper sx={{ p: 0 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Connected accounts by processing volume {snap ? `(${snap.by_account.length})` : ''}</Typography>
          {snap && <CsvExportButton filename="connect_accounts" columns={acctCsv} rows={snap.by_account} />}
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Customer</TableCell>
                <TableCell align="right">GMV (window)</TableCell>
                <TableCell align="right">Take rate</TableCell>
                <TableCell align="right">Fee revenue</TableCell>
                <TableCell align="right">Transactions</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? Array.from({ length: 12 }).map((_, i) => <TableRow key={i}><TableCell colSpan={6}><Skeleton variant="text" /></TableCell></TableRow>)
                : (snap?.by_account ?? []).slice(0, 40).map((r) => (
                  <TableRow key={r.account} hover>
                    <TableCell>
                      {r.allmoxy_customer_id != null
                        ? <CustomerLink id={r.allmoxy_customer_id}>{r.customer_name}</CustomerLink>
                        : <span>{r.customer_name || r.account}</span>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{USD0.format(r.gross_volume)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: r.take_rate != null && r.take_rate >= 0.0099 ? 'success.main' : r.take_rate != null && r.take_rate < 0.0049 ? 'warning.main' : 'text.secondary' }}>{r.take_rate != null ? (r.take_rate * 100).toFixed(2) + '%' : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{USD0.format(r.fee_revenue)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{r.txn_count.toLocaleString()}</TableCell>
                    <TableCell><Typography variant="caption" sx={{ color: r.customer_status === 'active' ? 'success.main' : r.customer_status == null ? 'text.disabled' : 'text.secondary' }}>{r.customer_status ?? 'unmatched'}</Typography></TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </Box>
      </Paper>

      {snap && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
          Live from Stripe {snap.stripe_fetchedAt?.slice(0, 10)} · window: {snap.window?.since} · take-rate spread: {Object.entries(snap.take_rate_distribution).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(' · ')}.
        </Typography>
      )}
    </Box>
  );
}

function Kpi({ label, value, sub, accent, valueColor, loading, info, onClick, selected }: { label: string; value: string | undefined; sub?: string; accent?: string; valueColor?: string; loading: boolean; info: string; onClick?: () => void; selected?: boolean }) {
  return (
    <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
      <Paper
        onClick={onClick}
        sx={{
          p: 2, flexGrow: 1, borderLeft: accent ? '3px solid' : undefined, borderColor: accent,
          ...(onClick && { cursor: 'pointer', transition: 'background-color 120ms, box-shadow 120ms', '&:hover': { bgcolor: 'action.hover' } }),
          ...(selected && { outline: '2px solid', outlineColor: 'primary.main', bgcolor: 'action.selected' }),
        }}
      >
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>{label}</Typography>
          <InfoIcon info={info} />
          {selected && <Box component="span" sx={{ ml: 'auto', fontSize: 9, color: 'primary.main', fontWeight: 700 }}>● filtering</Box>}
        </Stack>
        {loading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
          <>
            <Typography variant="h5" sx={{ fontWeight: 600, color: valueColor }}>{value ?? '—'}</Typography>
            {sub && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{sub}</Typography>}
          </>
        )}
      </Paper>
    </Grid>
  );
}
