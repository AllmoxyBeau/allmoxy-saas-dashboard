import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import LinearProgress from '@mui/material/LinearProgress';

import InfoIcon from './InfoIcon';
import CustomerLink from './CustomerLink';
import CsvExportButton from './CsvExportButton';
import { useSheetTab } from '../../hooks/useSheetTab';

type Bucket = { amount: number; customers: number };
type CustRow = {
  allmoxy_customer_id: number; name: string;
  prior_billed: number; billed_so_far: number; upcoming_expected: number; expected: number; delta: number;
  outstanding: number; uncollectible: number; failed_attempts: number;
  expected_billing_day: number | null; next_billing_date: string | null;
  billing_state: string; movement: string;
};
type Snap = {
  month: string; prior_month: string; as_of: string;
  day_of_month: number; days_in_month: number; elapsed_pct: number;
  mrr: { starting: number; expected_ending: number; net_change: number; net_change_pct: number | null; billed_so_far: number; still_to_bill: number };
  movement: Record<'new' | 'expansion' | 'contraction' | 'lost' | 'flat', Bucket>;
  billing: Record<string, Bucket>;
  customers: CustRow[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${USD0.format(Math.abs(v))}`;

// Ordered worst-to-best so the eye lands on what needs working first.
const BILLING_ORDER: Array<{ key: string; label: string; help: string; tone: 'error' | 'warning' | 'info' | 'success' | 'default' }> = [
  { key: 'nothing_scheduled', label: 'Nothing scheduled', tone: 'error', help: 'Billed last month, no invoice issued and no billing date ahead. This is the genuine risk set — the number worth working today.' },
  { key: 'failing', label: 'Payment failing', tone: 'error', help: 'Invoice issued and a charge attempt has already failed. Dunning, not merely unpaid.' },
  { key: 'written_off', label: 'Written off', tone: 'default', help: 'Invoice issued and marked uncollectible.' },
  { key: 'awaiting_payment', label: 'Awaiting payment', tone: 'warning', help: 'Invoice issued, not yet paid, no failure behind it. Usually just early.' },
  { key: 'partially_billed', label: 'Partly billed', tone: 'info', help: 'Some billing has landed and more is still scheduled this month — commonly a small add-on invoice ahead of the main subscription date.' },
  { key: 'not_yet_billed', label: 'Not yet billed', tone: 'info', help: 'Active subscription whose billing day is still ahead this month, valued at what it billed last month. An expectation, not a fact.' },
  { key: 'collected', label: 'Collected', tone: 'success', help: 'Billed and paid.' },
];

export default function AccrualMonthPanel() {
  const { data, isLoading } = useSheetTab('current_month');
  const snap = data as unknown as Snap | undefined;
  const [focus, setFocus] = useState<string | null>(null);

  const shown = useMemo(() => {
    const all = snap?.customers ?? [];
    if (!focus) return all.filter((c) => c.movement !== 'flat').slice(0, 40);
    return all.filter((c) => c.billing_state === focus);
  }, [snap, focus]);

  if (!isLoading && !snap) return null;

  const m = snap?.mrr;
  const pctBilled = m && m.starting > 0 ? Math.min(100, (m.billed_so_far / (m.billed_so_far + m.still_to_bill || 1)) * 100) : 0;

  return (
    <Paper sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'rgba(44,115,255,0.35)' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="h6" sx={{ fontWeight: 500 }}>MRR this month</Typography>
        <Chip size="small" label="accrual" color="primary" sx={{ height: 18, fontSize: 10 }} />
        <InfoIcon info={<><strong>What moved:</strong> each customer's billing this month against last month, measured <strong>billing to billing</strong> — invoices by invoice date plus recurring direct charges. Payment timing cannot create movement here: a late payment is not contraction, a catch-up payment is not growth.<br /><br /><strong>Where the month is up to:</strong> customers bill on their own day, so mid-month the book splits between billed and still-to-come. The <em>not yet billed</em> bucket is invisible to a cash view and is usually the difference between "we are down badly" and "it is the {snap?.day_of_month}th".<br /><br /><strong>Expected ending</strong> assumes anyone still to bill repeats last month. It is a projection for the un-billed part and a fact for the rest.</>} />
        <Box sx={{ flexGrow: 1 }} />
        {snap && <Typography variant="caption" sx={{ color: 'text.secondary' }}>day {snap.day_of_month} of {snap.days_in_month} · vs {snap.prior_month}</Typography>}
      </Stack>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        {[
          { label: 'Starting MRR', value: m ? USD0.format(m.starting) : '—', hint: `billed in ${snap?.prior_month ?? ''}`, color: 'text.primary' },
          { label: 'Expected ending', value: m ? USD0.format(m.expected_ending) : '—', hint: 'billed + still to bill', color: 'text.primary' },
          { label: 'Net change', value: m ? signed(m.net_change) : '—', hint: m?.net_change_pct != null ? `${(m.net_change_pct * 100).toFixed(1)}%` : '', color: (m?.net_change ?? 0) >= 0 ? 'success.main' : 'error.main' },
          { label: 'Billed so far', value: m ? USD0.format(m.billed_so_far) : '—', hint: `${USD0.format(m?.still_to_bill ?? 0)} still to bill`, color: 'text.primary' },
          { label: 'At risk', value: snap ? USD0.format(snap.billing.nothing_scheduled.amount + snap.billing.failing.amount) : '—', hint: 'nothing scheduled + failing', color: (snap && (snap.billing.nothing_scheduled.amount + snap.billing.failing.amount) > 0) ? 'error.main' : 'success.main' },
        ].map((k) => (
          <Grid item xs={12} sm={6} md={2.4} key={k.label}>
            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>{k.label}</Typography>
              {isLoading ? <Skeleton variant="text" width="70%" sx={{ fontSize: 22 }} /> : (
                <Typography variant="h6" sx={{ fontWeight: 600, color: k.color, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}>{k.value}</Typography>
              )}
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>{k.hint}</Typography>
            </Box>
          </Grid>
        ))}
      </Grid>

      {snap && (
        <Box sx={{ mb: 2 }}>
          <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{Math.round(pctBilled)}% of expected billing has been issued</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{Math.round(snap.elapsed_pct * 100)}% of the month elapsed</Typography>
          </Stack>
          <LinearProgress variant="determinate" value={pctBilled} sx={{ height: 6, borderRadius: 3 }} />
        </Box>
      )}

      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>How MRR moved</Typography>
          <Table size="small" sx={{ mt: 0.5 }}>
            <TableBody>
              {snap && ([
                ['New', snap.movement.new, 'success.main'],
                ['Expansion', snap.movement.expansion, 'success.main'],
                ['Contraction', snap.movement.contraction, 'error.main'],
                ['Lost', snap.movement.lost, 'error.main'],
                ['Unchanged', snap.movement.flat, 'text.secondary'],
              ] as Array<[string, Bucket, string]>).map(([label, b, color]) => (
                <TableRow key={label}>
                  <TableCell sx={{ borderBottom: 'none', py: 0.5 }}>{label}</TableCell>
                  <TableCell align="right" sx={{ borderBottom: 'none', py: 0.5, color, fontWeight: 500 }}>
                    {b.amount === 0 ? '—' : signed(b.amount)}
                  </TableCell>
                  <TableCell align="right" sx={{ borderBottom: 'none', py: 0.5, color: 'text.secondary', fontSize: 11, width: 70 }}>{b.customers}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Grid>
        <Grid item xs={12} md={7}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Where the month is up to · click to filter</Typography>
          <Table size="small" sx={{ mt: 0.5 }}>
            <TableBody>
              {snap && BILLING_ORDER.map(({ key, label, help, tone }) => {
                const b = snap.billing[key];
                if (!b || (b.customers === 0 && b.amount === 0)) return null;
                const active = focus === key;
                return (
                  <TableRow
                    key={key}
                    hover
                    onClick={() => setFocus(active ? null : key)}
                    sx={{ cursor: 'pointer', bgcolor: active ? 'rgba(44,115,255,0.10)' : undefined }}
                  >
                    <TableCell sx={{ borderBottom: 'none', py: 0.5 }}>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Chip size="small" color={tone} label={label} sx={{ height: 18, fontSize: 10 }} />
                        <InfoIcon info={help} />
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ borderBottom: 'none', py: 0.5, fontWeight: 500 }}>{USD0.format(b.amount)}</TableCell>
                    <TableCell align="right" sx={{ borderBottom: 'none', py: 0.5, color: 'text.secondary', fontSize: 11, width: 70 }}>{b.customers}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Grid>
      </Grid>

      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2, mb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 500 }}>
          {focus ? `${BILLING_ORDER.find((b) => b.key === focus)?.label} · ${shown.length}` : `Customers that moved · ${shown.length}`}
        </Typography>
        {focus && <Chip size="small" label="clear filter" onClick={() => setFocus(null)} sx={{ height: 18, fontSize: 10 }} />}
        <Box sx={{ flexGrow: 1 }} />
        <CsvExportButton
          filename={`current_month_${snap?.month ?? ''}.csv`}
          rows={snap?.customers ?? []}
          columns={[
            { key: 'name', label: 'Customer' },
            { key: 'prior_billed', label: `Billed ${snap?.prior_month ?? 'prior'}` },
            { key: 'billed_so_far', label: 'Billed so far' },
            { key: 'upcoming_expected', label: 'Still to bill' },
            { key: 'expected', label: 'Expected' },
            { key: 'delta', label: 'Change' },
            { key: 'movement', label: 'Movement' },
            { key: 'billing_state', label: 'Billing state' },
            { key: 'expected_billing_day', label: 'Billing day' },
          ]}
        />
      </Stack>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Customer</TableCell>
            <TableCell align="right">Billed {snap?.prior_month ?? ''}</TableCell>
            <TableCell align="right">Billed so far</TableCell>
            <TableCell align="right">Still to bill</TableCell>
            <TableCell align="right">Change</TableCell>
            <TableCell>State</TableCell>
            <TableCell align="right">Bills on</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.map((c) => (
            <TableRow key={c.allmoxy_customer_id} hover>
              <TableCell><CustomerLink name={c.name} /></TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary' }}>{USD0.format(c.prior_billed)}</TableCell>
              <TableCell align="right">{c.billed_so_far > 0 ? USD0.format(c.billed_so_far) : '—'}</TableCell>
              <TableCell align="right" sx={{ color: 'info.main' }}>{c.upcoming_expected > 0 ? USD0.format(c.upcoming_expected) : '—'}</TableCell>
              <TableCell align="right" sx={{ fontWeight: 500, color: c.delta > 0 ? 'success.main' : c.delta < 0 ? 'error.main' : 'text.secondary' }}>
                {c.delta === 0 ? '—' : signed(c.delta)}
              </TableCell>
              <TableCell>
                <Chip size="small" label={BILLING_ORDER.find((b) => b.key === c.billing_state)?.label ?? c.billing_state} sx={{ height: 18, fontSize: 10 }} />
                {c.failed_attempts > 0 && <Chip size="small" color="error" label={`${c.failed_attempts} failed`} sx={{ ml: 0.5, height: 18, fontSize: 10 }} />}
              </TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary', fontSize: 11 }}>
                {c.next_billing_date ? c.next_billing_date.slice(5) : c.expected_billing_day ? `day ${c.expected_billing_day}` : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}
