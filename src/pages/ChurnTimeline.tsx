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
import Divider from '@mui/material/Divider';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type Row = {
  allmoxy_customer_id: number; name: string;
  churn_month: string; last_paid_month: string; last_payment_date: string | null;
  sign_up_date: string | null; tenure_years: number | null;
  mrr_at_churn: number; peak_mrr: number; peak_month: string;
  decline_from_peak_pct: number | null; months_declining_before_churn: number; months_paying: number;
  lifetime_subscription: number;
  reason: string | null; reason_source: string; confidence: string | null;
  evidence_quote: string | null; evidence_date: string | null;
  subpattern_label: string | null; subpattern_parent: string | null; subpattern_description: string | null;
  owner: string | null; segment: string | null;
  final_year_orders_usd: number | null; prior_year_orders_usd: number | null; orders_decline_pct: number | null;
  tickets_lifetime: number | null; failed_payments_final_6mo: number;
  orders_comparable?: boolean; orders_suppressed_reason?: string | null;
  hubspot_url: string | null;
};
type Tally = { key: string; customers: number; mrr_lost: number };
type Snap = {
  totals: { churned_customers: number; mrr_lost: number; lifetime_lost: number; with_reason: number; researched: number; unexplained: number };
  ttm: { window_start: string; churned_customers: number; mrr_lost: number; avg_tenure_years: number | null; left_at_full_price: number; declined_first: number };
  monthly: Array<{ month: string; customers: number; mrr_lost: number }>;
  by_reason: Tally[]; by_subpattern: Tally[]; by_segment: Tally[];
  customers: Row[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}
const SOURCE_TONE: Record<string, 'success' | 'info' | 'warning' | 'default'> = {
  research: 'success', inferred: 'info', hubspot: 'warning', none: 'default',
};
const SOURCE_LABEL: Record<string, string> = {
  research: 'researched', inferred: 'inferred', hubspot: 'HubSpot field', none: 'undiagnosed',
};

export default function ChurnTimeline() {
  const { data, isLoading, error } = useSheetTab('churn_timeline');
  const snap = data as unknown as Snap | undefined;
  const [reason, setReason] = useState('');
  const [since, setSince] = useState('ttm');

  const rows = useMemo(() => {
    let r = snap?.customers ?? [];
    if (since === 'ttm' && snap) r = r.filter((x) => x.churn_month >= snap.ttm.window_start);
    else if (since === '24m' && snap) {
      const [y, m] = snap.ttm.window_start.split('-').map(Number);
      const cut = `${y - 1}-${String(m).padStart(2, '0')}`;
      r = r.filter((x) => x.churn_month >= cut);
    }
    if (reason) r = r.filter((x) => (x.reason ?? '(undiagnosed)') === reason);
    return r;
  }, [snap, reason, since]);

  const chart = useMemo(() => (snap?.monthly ?? []).slice(-36).map((m) => ({
    month: monthLabel(m.month).replace(' ', ' '),
    customers: m.customers,
    mrr: m.mrr_lost,
  })), [snap]);

  if (error) {
    return (
      <Box>
        <PageHeader title="Churn Timeline" subtitle="Every churn in the order it happened" />
        <Alert severity="error">Failed to load churn_timeline — {String(error)}</Alert>
      </Box>
    );
  }

  const t = snap?.totals; const ttm = snap?.ttm;

  return (
    <Box>
      <PageHeader
        title="Churn Timeline"
        subtitle="Every churned customer in the order they left, with the run-up that explains why."
        question="durable"
      />

      <Grid container spacing={2} sx={{ mb: 3 }}>
        {[
          { label: 'Churned (TTM)', value: String(ttm?.churned_customers ?? '—'), hint: `${USD0.format(ttm?.mrr_lost ?? 0)} of MRR`, color: 'error.main' },
          { label: 'Avg tenure at churn', value: ttm?.avg_tenure_years != null ? `${ttm.avg_tenure_years.toFixed(1)}y` : '—', hint: 'trailing 12 months' },
          { label: 'Declined before leaving', value: `${ttm?.declined_first ?? 0} of ${ttm?.churned_customers ?? 0}`, hint: `${ttm?.left_at_full_price ?? 0} left at full price`, color: 'warning.main' },
          { label: 'Churned all time', value: String(t?.churned_customers ?? '—'), hint: `${USD0.format(t?.lifetime_lost ?? 0)} lifetime revenue` },
          { label: 'Undiagnosed', value: String(t?.unexplained ?? '—'), hint: `${t?.researched ?? 0} properly researched`, color: (t?.unexplained ?? 0) > 0 ? 'warning.main' : 'success.main' },
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

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Churn by month</Typography>
          <InfoIcon info={<><strong>Churn month</strong> is the first month a customer did not pay for, derived from the last month carrying subscription revenue.<br /><br />That is deliberately not HubSpot's cancellation date, which records when someone closed the record — often months later, sometimes never.<br /><br />Bars are customers lost; the line is the MRR that left with them.</>} />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={240} /> : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} interval="preserveStartEnd" minTickGap={28} />
              <YAxis yAxisId="c" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="m" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
              <RTooltip
                contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 12 }}
                formatter={(v: number, n: string) => (n === 'mrr' ? [USD0.format(v), 'MRR lost'] : [v, 'Customers'])}
              />
              <Bar yAxisId="c" dataKey="customers" fill="#DA3633" name="customers" />
              <Line yAxisId="m" type="monotone" dataKey="mrr" stroke="#D69E2E" strokeWidth={2} dot={false} name="mrr" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Paper>

      <Grid container spacing={3} sx={{ mb: 3 }}>
        {([['Why they left', snap?.by_reason], ['Pattern', snap?.by_subpattern]] as Array<[string, Tally[] | undefined]>).map(([title, list]) => (
          <Grid item xs={12} md={6} key={title}>
            <Paper sx={{ p: 3, height: '100%' }}>
              <Typography variant="h6" sx={{ fontWeight: 500, mb: 1.5 }}>{title}</Typography>
              {(list ?? []).slice(0, 8).map((r) => (
                <Stack key={r.key} direction="row" spacing={1} alignItems="center" sx={{ py: 0.4 }}>
                  <Typography variant="body2" sx={{ flexGrow: 1, color: r.key.startsWith('(') ? 'text.secondary' : 'text.primary' }}>{r.key}</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 500, minWidth: 70, textAlign: 'right' }}>{USD0.format(r.mrr_lost)}</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', minWidth: 30, textAlign: 'right' }}>{r.customers}</Typography>
                </Stack>
              ))}
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>The stories · {rows.length}</Typography>
          <InfoIcon info={<>One card per churn, newest first. The <strong>run-up</strong> line is what turns a one-word reason into a story: how far they had already shrunk from their peak, how many months they were shrinking, whether they stopped ordering, and whether payments were failing.<br /><br />The <strong>source chip</strong> matters — <em>researched</em> means someone read the account, <em>inferred</em> means it was deduced from signals, <em>HubSpot field</em> is a dropdown someone picked, and <em>undiagnosed</em> means nobody has established why.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <TextField select size="small" label="Window" value={since} onChange={(e) => setSince(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="ttm">Last 12 months</MenuItem>
            <MenuItem value="24m">Last 24 months</MenuItem>
            <MenuItem value="all">All time</MenuItem>
          </TextField>
          <TextField select size="small" label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} sx={{ minWidth: 210 }}>
            <MenuItem value="">All reasons</MenuItem>
            {(snap?.by_reason ?? []).map((r) => <MenuItem key={r.key} value={r.key}>{r.key} ({r.customers})</MenuItem>)}
          </TextField>
          <CsvExportButton
            filename="churn_timeline.csv"
            rows={rows}
            columns={[
              { key: 'churn_month', label: 'Churn month' }, { key: 'name', label: 'Customer' },
              { key: 'mrr_at_churn', label: 'MRR at churn' }, { key: 'peak_mrr', label: 'Peak MRR' },
              { key: 'decline_from_peak_pct', label: 'Decline from peak' },
              { key: 'months_declining_before_churn', label: 'Months declining' },
              { key: 'tenure_years', label: 'Tenure (yrs)' }, { key: 'lifetime_subscription', label: 'Lifetime' },
              { key: 'reason', label: 'Reason' }, { key: 'reason_source', label: 'Source' },
              { key: 'subpattern_label', label: 'Pattern' }, { key: 'orders_decline_pct', label: 'Orders decline' },
              { key: 'failed_payments_final_6mo', label: 'Failed payments (final 6mo)' },
              { key: 'evidence_quote', label: 'Evidence' },
            ]}
          />
        </Stack>

        {isLoading && <Skeleton variant="rectangular" height={300} />}
        <Stack spacing={1.5}>
          {rows.map((r) => (
            <Paper key={r.allmoxy_customer_id} variant="outlined" sx={{ p: 2, borderLeft: '3px solid', borderLeftColor: r.reason ? 'error.main' : 'warning.main' }}>
              <Stack direction="row" spacing={1.5} alignItems="baseline" flexWrap="wrap" useFlexGap>
                <Typography variant="caption" sx={{ color: 'text.secondary', minWidth: 78, fontVariantNumeric: 'tabular-nums' }}>{monthLabel(r.churn_month)}</Typography>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}><CustomerLink name={r.name} /></Typography>
                <Chip size="small" label={`${USD0.format(r.mrr_at_churn)}/mo`} color="error" sx={{ height: 18, fontSize: 10 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {r.tenure_years != null ? `${r.tenure_years.toFixed(1)}y` : '—'} · {USD0.format(r.lifetime_subscription)} lifetime
                  {r.segment ? ` · ${r.segment}` : ''}{r.owner ? ` · ${r.owner}` : ''}
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                {r.hubspot_url && <Link href={r.hubspot_url} target="_blank" rel="noopener" variant="caption">HubSpot</Link>}
              </Stack>

              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                <Chip size="small" color={SOURCE_TONE[r.reason_source] ?? 'default'} label={SOURCE_LABEL[r.reason_source] ?? r.reason_source} sx={{ height: 18, fontSize: 10 }} />
                <Typography variant="body2" sx={{ fontWeight: 500, color: r.reason ? 'text.primary' : 'warning.main' }}>
                  {r.reason ?? 'No reason established'}
                </Typography>
                {r.subpattern_label && (
                  <Chip size="small" variant="outlined" label={r.subpattern_parent ? `${r.subpattern_parent} · ${r.subpattern_label}` : r.subpattern_label} sx={{ height: 18, fontSize: 10 }} />
                )}
              </Stack>

              {/* The run-up — what was already happening before they left. */}
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
                {r.decline_from_peak_pct != null && r.decline_from_peak_pct < -0.01 && (
                  <Typography variant="caption" sx={{ color: 'warning.main' }}>
                    shrank {pct(r.decline_from_peak_pct)} from {USD0.format(r.peak_mrr)} peak ({monthLabel(r.peak_month)})
                  </Typography>
                )}
                {r.months_declining_before_churn > 0 && (
                  <Typography variant="caption" sx={{ color: 'warning.main' }}>{r.months_declining_before_churn} months declining first</Typography>
                )}
                {r.months_declining_before_churn === 0 && (r.decline_from_peak_pct ?? 0) >= -0.01 && (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>left at full price — no warning in the revenue</Typography>
                )}
                {r.orders_decline_pct != null ? (
                  <Typography variant="caption" sx={{ color: r.orders_decline_pct < -0.2 ? 'error.main' : 'text.secondary' }}>
                    orders {pct(r.orders_decline_pct)} in final year
                  </Typography>
                ) : r.orders_suppressed_reason ? (
                  <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                    orders: {r.orders_suppressed_reason}
                  </Typography>
                ) : null}
                {r.failed_payments_final_6mo > 0 && (
                  <Typography variant="caption" sx={{ color: 'error.main' }}>{r.failed_payments_final_6mo} failed payments in final 6 months</Typography>
                )}
                {(r.tickets_lifetime ?? 0) > 0 && (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{r.tickets_lifetime} support tickets</Typography>
                )}
              </Stack>

              {r.evidence_quote && (
                <>
                  <Divider sx={{ my: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic', display: 'block' }}>
                    “{r.evidence_quote}”{r.evidence_date ? ` — ${r.evidence_date}` : ''}
                  </Typography>
                </>
              )}
            </Paper>
          ))}
        </Stack>
        {!isLoading && rows.length === 0 && (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>No churns match this filter.</Typography>
        )}
      </Paper>
    </Box>
  );
}
