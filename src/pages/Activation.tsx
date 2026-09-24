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
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type Cohort = { month: string; signups: number; activated: number; churned_never: number; still_stalled: number; mrr_signed: number; activation_rate: number | null };
type Row = {
  allmoxy_customer_id: number; name: string; signup_date: string; cohort_month: string;
  status: string | null; mrr: number; paying_now: boolean;
  activated: boolean | null; order_data_known: boolean;
  first_order_month: string | null; first_order_year: string | null;
  days_to_activate: number | null; days_since_signup: number; state: string;
  owner: string | null; churn_month: string | null; churn_reason: string | null;
  lifetime_subscription: number; hubspot_url: string | null;
};
type Snap = {
  stall_threshold_days: number;
  totals: { customers: number; measurable: number; unknown_no_order_record: number; activated: number; activation_rate: number | null; bid_only_excluded: number };
  now: { stalled: number; stalled_mrr: number; stalled_arr: number; onboarding: number; onboarding_mrr: number; paying_customers: number; stalled_share_of_mrr: number | null };
  cost: { churned_never_activated: number; mrr_lost: number; lifetime_paid: number; median_months_paid_before_quitting: number | null };
  time_to_activate: { measurable: number; median_days: number | null; p75_days: number | null; note: string };
  cohorts: Cohort[];
  stalled_customers: Row[];
  onboarding_customers: Row[];
  customers: Row[];
};

// Every column sorts. `value` returns a number or string; strings compare with
// localeCompare so names order naturally. `defaultDesc` is the direction you actually
// want on the first click — biggest money and longest-waiting first, names A→Z.
type SortKey = 'name' | 'mrr' | 'days_since_signup' | 'lifetime_subscription' | 'owner' | 'status';
const COLUMNS: Array<{ key: SortKey; label: string; align?: 'right'; defaultDesc: boolean; value: (r: Row) => string | number }> = [
  { key: 'name', label: 'Customer', defaultDesc: false, value: (r) => r.name ?? '' },
  { key: 'mrr', label: 'MRR', align: 'right', defaultDesc: true, value: (r) => r.mrr ?? 0 },
  { key: 'days_since_signup', label: 'Days since signup', align: 'right', defaultDesc: true, value: (r) => r.days_since_signup ?? 0 },
  { key: 'lifetime_subscription', label: 'Paid to date', align: 'right', defaultDesc: true, value: (r) => r.lifetime_subscription ?? 0 },
  { key: 'owner', label: 'Owner', defaultDesc: false, value: (r) => r.owner ?? '\uffff' },   // unassigned sorts last
  { key: 'status', label: 'Status', defaultDesc: false, value: (r) => r.status ?? '' },
];

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const pctOf = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const ageTone = (d: number) => (d > 365 ? 'error.main' : d > 180 ? 'warning.main' : 'text.primary');
function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

export default function Activation() {
  const { data, isLoading, error } = useSheetTab('activation');
  const snap = data as unknown as Snap | undefined;
  const [range, setRange] = useState<'24M' | '48M' | 'ALL'>('24M');
  const [sortKey, setSortKey] = useState<SortKey>('mrr');
  const [sortDesc, setSortDesc] = useState(true);
  const toggleSort = (k: SortKey) => {
    if (k === sortKey) { setSortDesc((d) => !d); return; }
    setSortKey(k);
    setSortDesc(COLUMNS.find((c) => c.key === k)!.defaultDesc);
  };

  const stalled = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sortKey)!;
    // MRR breaks ties so equal-ranked rows still lead with the biggest money at risk.
    return [...(snap?.stalled_customers ?? [])].sort((a, b) => {
      const av = col.value(a), bv = col.value(b);
      let cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv))
        : (av as number) - (bv as number);
      if (cmp === 0) cmp = a.mrr - b.mrr;
      return sortDesc ? -cmp : cmp;
    });
  }, [snap, sortKey, sortDesc]);

  const chart = useMemo(() => {
    const all = (snap?.cohorts ?? []).filter((c) => c.signups > 0);
    if (!all.length) return [];
    let rowsIn = all;
    if (range !== 'ALL') {
      const last = all[all.length - 1].month;
      const [y, m] = last.split('-').map(Number);
      const back = range === '24M' ? 23 : 47;
      const d = new Date(y, m - 1 - back, 1);
      const cut = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      rowsIn = all.filter((c) => c.month >= cut);
    }
    return rowsIn.map((c) => ({
      month: monthLabel(c.month),
      signups: c.signups,
      activated: c.activated,
      rate: c.activation_rate != null ? Math.round(c.activation_rate * 100) : null,
    }));
  }, [snap, range]);

  if (error) {
    return (
      <Box>
        <PageHeader title="Activation" subtitle="Signup to first verified order" />
        <Alert severity="error">Failed to load activation — {String(error)}</Alert>
      </Box>
    );
  }

  const t = snap?.totals; const now = snap?.now; const cost = snap?.cost;

  return (
    <Box>
      <PageHeader
        title="Activation"
        subtitle="Signup to first verified order — the moment a customer either starts using Allmoxy or quietly never does."
        question="durable"
      />

      <Grid container spacing={2} sx={{ mb: 3 }}>
        {[
          { label: 'Stalled now', value: N0.format(now?.stalled ?? 0), hint: `${USD0.format(now?.stalled_mrr ?? 0)}/mo · ${USD0.format(now?.stalled_arr ?? 0)} ARR`, color: 'error.main' },
          { label: 'Stalled share of MRR', value: pctOf(now?.stalled_share_of_mrr), hint: 'paying but never ordered', color: 'warning.main' },
          { label: 'Activation rate', value: pctOf(t?.activation_rate), hint: `${N0.format(t?.activated ?? 0)} of ${N0.format(t?.measurable ?? 0)} measurable`, color: 'success.main' },
          { label: 'Median time to activate', value: snap?.time_to_activate.median_days != null ? `${snap.time_to_activate.median_days}d` : '—', hint: `${snap?.time_to_activate.measurable ?? 0} measurable` },
          { label: 'Never-activated churn', value: N0.format(cost?.churned_never_activated ?? 0), hint: `${USD0.format(cost?.lifetime_paid ?? 0)} paid, never used`, color: 'error.main' },
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

      {snap && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <strong>{now?.stalled} customers are paying {USD0.format(now?.stalled_mrr ?? 0)} a month for something they have never used.</strong>{' '}
          That is {USD0.format(now?.stalled_arr ?? 0)} of ARR and {pctOf(now?.stalled_share_of_mrr)} of MRR sitting on accounts with no verified order, past day {snap.stall_threshold_days}.
          Historically this is where churn comes from: {cost?.churned_never_activated} customers have already left without ever ordering, having paid {USD0.format(cost?.lifetime_paid ?? 0)} over a median of {cost?.median_months_paid_before_quitting} months first.
        </Alert>
      )}

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Activation by signup cohort</Typography>
          <InfoIcon info={<><strong>Bars</strong> are how many signed up that month; the darker bar is how many ever placed a verified order. The <strong>line</strong> is the activation rate.<br /><br />Recent cohorts read low because they have not had time yet — a customer who signed up last month has not failed, they are still onboarding.<br /><br />Customers with no order record at all are excluded from the rate rather than counted as failures. That is {N0.format(snap?.totals.unknown_no_order_record ?? 0)} mostly-historical accounts, and counting them as failures would have reported a 40% activation rate instead of the real {pctOf(snap?.totals.activation_rate)}.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <ToggleButtonGroup size="small" exclusive value={range} onChange={(_, v) => v && setRange(v)} sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}>
            <ToggleButton value="24M">24M</ToggleButton>
            <ToggleButton value="48M">48M</ToggleButton>
            <ToggleButton value="ALL">All time</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={260} /> : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={26} />
              <YAxis yAxisId="n" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
              <RTooltip
                contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 12, color: '#FFFFFF' }}
                labelStyle={{ color: '#FFFFFF' }}
                itemStyle={{ color: '#FFFFFF' }}
                formatter={(v: number, n: string) => (n === 'rate' ? [`${v}%`, 'Activation rate'] : [v, n === 'activated' ? 'Activated' : 'Signed up'])}
              />
              <Bar yAxisId="n" dataKey="signups" fill="rgba(44,115,255,0.30)" name="signups" />
              <Bar yAxisId="n" dataKey="activated" fill="#1A9E5C" name="activated" />
              <Line yAxisId="r" type="monotone" dataKey="rate" stroke="#D69E2E" strokeWidth={2} dot={false} name="rate" connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Work this list · {snap?.stalled_customers.length ?? 0} stalled</Typography>
          <InfoIcon info={<>Paying, past day {snap?.stall_threshold_days}, and no verified order on record. Sorted by MRR, because this is a revenue-at-risk queue rather than a support queue.<br /><br />Bid-only customers are excluded — they use Allmoxy for quotes and never place verified orders by design, so chasing them would be wrong. {snap?.totals.bid_only_excluded} are held out.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <CsvExportButton
            filename="activation_stalled.csv"
            rows={stalled}
            columns={[
              { key: 'name', label: 'Customer' }, { key: 'mrr', label: 'MRR' },
              { key: 'days_since_signup', label: 'Days since signup' }, { key: 'signup_date', label: 'Signed up' },
              { key: 'owner', label: 'Owner' }, { key: 'status', label: 'Status' },
              { key: 'lifetime_subscription', label: 'Paid to date' },
            ]}
          />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              {COLUMNS.map((c) => (
                <TableCell key={c.key} align={c.align} sortDirection={sortKey === c.key ? (sortDesc ? 'desc' : 'asc') : false}>
                  <TableSortLabel
                    active={sortKey === c.key}
                    direction={sortKey === c.key ? (sortDesc ? 'desc' : 'asc') : (c.defaultDesc ? 'desc' : 'asc')}
                    onClick={() => toggleSort(c.key)}
                  >
                    {c.label}
                  </TableSortLabel>
                </TableCell>
              ))}
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {stalled.map((r) => (
              <TableRow key={r.allmoxy_customer_id} hover>
                <TableCell><CustomerLink name={r.name} /></TableCell>
                <TableCell align="right" sx={{ fontWeight: 500 }}>{USD0.format(r.mrr)}</TableCell>
                <TableCell align="right" sx={{ color: ageTone(r.days_since_signup), fontWeight: 500 }}>{N0.format(r.days_since_signup)}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{USD0.format(r.lifetime_subscription)}</TableCell>
                <TableCell sx={{ color: 'text.secondary' }}>{r.owner ?? '—'}</TableCell>
                <TableCell><Chip size="small" label={r.status ?? '—'} sx={{ height: 18, fontSize: 10 }} /></TableCell>
                <TableCell align="right">{r.hubspot_url && <Link href={r.hubspot_url} target="_blank" rel="noopener" variant="caption">HubSpot</Link>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {(snap?.onboarding_customers.length ?? 0) > 0 && (
          <>
            <Typography variant="subtitle2" sx={{ mt: 3, mb: 1, color: 'text.secondary' }}>
              Still inside the window · {snap?.onboarding_customers.length} signed up within {snap?.stall_threshold_days} days
            </Typography>
            <Table size="small">
              <TableBody>
                {(snap?.onboarding_customers ?? []).map((r) => (
                  <TableRow key={r.allmoxy_customer_id} hover>
                    <TableCell><CustomerLink name={r.name} /></TableCell>
                    <TableCell align="right">{USD0.format(r.mrr)}</TableCell>
                    <TableCell align="right" sx={{ color: 'text.secondary' }}>day {r.days_since_signup}</TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{r.owner ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </Paper>

      {snap && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          Activation = has ever placed a verified order. {snap.time_to_activate.note}
        </Typography>
      )}
    </Box>
  );
}
