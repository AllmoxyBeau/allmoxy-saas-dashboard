import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

// Snapshot written by _etl_scripts/build_revenue_recognition.mjs (accrual / invoice basis).
type MonthRow = { recognized: number; cash: number; ar_open: number; ar_uncollectible: number; recognized_minus_cash: number };
type ArRow = { allmoxy_customer_id: number | null; name: string; invoice_date: string; service_month: string; amount: number; status: 'open' | 'uncollectible'; age_days: number };
type DetailRow = { allmoxy_customer_id: number; name: string; month: string; recognized: number; collected: number; outstanding: number; basis: 'invoice' | 'charge' };
type Snap = {
  fetchedAt: string;
  invoices_fetched_at: string | null;
  basis: string;
  books_go_live: string;
  reconcile_from: string;
  months: string[];
  by_month: Record<string, MonthRow>;
  ar_aging: ArRow[];
  ar_total: number;
  reconciliation_detail: DetailRow[];
  orphan_stripe_customers: Array<{ stripe_customer: string; months: string[]; latest_mrr: number }>;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
function monthLabel(iso: string) { const [y, m] = iso.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }
function fmtDate(iso: string | null | undefined) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; }
const TT = { contentStyle: { background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }, labelStyle: { color: '#FFFFFF' }, itemStyle: { color: '#FFFFFF' } };

export default function RevenueRecognition() {
  const { data, isLoading, error } = useSheetTab('revenue_recognition');
  const snap = data as unknown as Snap | undefined;

  const currentMonth = useMemo(() => new Date().toISOString().slice(0, 7), []);
  // Months available for the reconciliation view: reconcile_from → latest COMPLETE month.
  const reconMonths = useMemo(() => (snap?.months ?? []).filter((m) => m >= (snap?.reconcile_from ?? '2026-01') && m < currentMonth), [snap, currentMonth]);
  const [month, setMonth] = useState<string>('');
  const selMonth = month || reconMonths[reconMonths.length - 1] || '';
  const row = selMonth ? snap?.by_month[selMonth] : undefined;
  const isPreGoLive = !!(snap && selMonth && selMonth < snap.books_go_live);

  const detailRows = useMemo(() => (snap?.reconciliation_detail ?? []).filter((d) => d.month === selMonth).sort((a, b) => b.outstanding - a.outstanding || b.recognized - a.recognized), [snap, selMonth]);
  const outstandingRows = useMemo(() => detailRows.filter((d) => d.outstanding > 0), [detailRows]);
  const arRows = useMemo(() => (snap?.ar_aging ?? []).slice().sort((a, b) => b.amount - a.amount), [snap]);

  // Trend: last 24 complete months, recognized vs cash + AR.
  const trend = useMemo(() => (snap?.months ?? []).filter((m) => m < currentMonth).slice(-24).map((m) => ({ month: m, Recognized: snap!.by_month[m].recognized, Cash: snap!.by_month[m].cash, 'AR (open)': snap!.by_month[m].ar_open })), [snap, currentMonth]);

  const adj = row ? row.recognized_minus_cash : 0;

  return (
    <Box>
      <PageHeader
        title="Revenue Recognition"
        subtitle="Accrual (invoice-basis) subscription revenue — what was billed by service period, regardless of whether the card cleared — alongside the cash basis. Drives the monthly QuickBooks journal entry and the AR aging you handle case-by-case."
        question="durable"
      />
      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load revenue_recognition — {String(error)}</Alert>}

      {/* Basis + coverage chips */}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
        <Chip size="small" label={`Books basis go‑live: ${snap ? monthLabel(snap.books_go_live + '-01') : '—'}`} sx={{ bgcolor: 'rgba(44,115,255,0.12)', color: 'primary.main', fontWeight: 600 }} />
        <Chip size="small" label={`Reconciliation detail from ${snap ? monthLabel(snap.reconcile_from + '-01') : '—'}`} sx={{ bgcolor: 'rgba(139,148,158,0.12)' }} />
        <Chip size="small" label={`Invoices synced ${snap?.invoices_fetched_at ? fmtDate(snap.invoices_fetched_at) : '—'}`} sx={{ bgcolor: 'rgba(139,148,158,0.12)' }} />
        <Box sx={{ flexGrow: 1 }} />
        <TextField select size="small" label="Month" value={selMonth} onChange={(e) => setMonth(e.target.value)} sx={{ minWidth: 170 }} disabled={!reconMonths.length}>
          {reconMonths.slice().reverse().map((m) => <MenuItem key={m} value={m}>{monthLabel(m + '-01')}</MenuItem>)}
        </TextField>
      </Stack>

      {isPreGoLive && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <strong>{selMonth ? monthLabel(selMonth + '-01') : ''} is before the {snap ? monthLabel(snap.books_go_live + '-01') : ''} books go‑live.</strong> These figures are for your manual QuickBooks true‑up of 2026; from {snap ? monthLabel(snap.books_go_live + '-01') : ''} forward this becomes the operating basis.
        </Alert>
      )}

      {/* KPI strip for the selected month */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={2.4}><Kpi label="Recognized (accrual)" value={row ? USD0.format(row.recognized) : null} hint="Billed by service period" color="primary.main" loading={isLoading} info={<><strong>What it is:</strong> Subscription revenue earned in the month on the invoice basis — recurring invoice lines whose service period lands in the month, status paid / open / uncollectible (void excluded). Direct-charge subscribers (no Stripe invoice) fall back to the charge basis.<br /><br /><strong>This is the number to recognize in QuickBooks.</strong></>} /></Grid>
        <Grid item xs={12} sm={6} md={2.4}><Kpi label="Cash collected" value={row ? USD0.format(row.cash) : null} hint="Charge basis (what cleared)" loading={isLoading} info={<><strong>What it is:</strong> Subscription MRR on the current cash/charge basis for the same month — what actually cleared Stripe. Already reflected in your bank / QB deposits.</>} /></Grid>
        <Grid item xs={12} sm={6} md={2.4}><Kpi label="Accrual adjustment" value={row ? `${adj >= 0 ? '+' : '−'}${USD0.format(Math.abs(adj))}` : null} hint={adj >= 0 ? 'Billed > collected → AR increases' : 'Collected > billed → AR decreases'} color={adj >= 0 ? 'success.main' : 'warning.main'} loading={isLoading} info={<><strong>What it is:</strong> Recognized − Cash. Positive = revenue earned but not yet collected (book to Accounts Receivable). Negative = cash collected for prior‑period receivables or prepayments (AR comes down).</>} /></Grid>
        <Grid item xs={12} sm={6} md={2.4}><Kpi label="AR — open" value={row ? USD0.format(row.ar_open) : null} hint="Open invoices, this service month" color="warning.main" loading={isLoading} info={<><strong>What it is:</strong> Finalized, unpaid Stripe invoices whose service period is this month — the genuine receivable to collect. Card failures land here (not in churn).</>} /></Grid>
        <Grid item xs={12} sm={6} md={2.4}><Kpi label="AR — uncollectible" value={row ? USD0.format(row.ar_uncollectible) : null} hint="Flagged in Stripe · your call" color={row && row.ar_uncollectible > 0 ? 'error.main' : 'text.primary'} loading={isLoading} info={<><strong>What it is:</strong> Invoices Stripe has marked uncollectible. Still recognized (earned) but doubtful. No automatic write‑off — you decide case by case; voiding or marking paid in Stripe flows through on the next refresh.</>} /></Grid>
      </Grid>

      {/* QuickBooks journal entry documentation */}
      <Paper sx={{ p: 3, mb: 3, borderLeft: '3px solid', borderColor: 'primary.main' }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>QuickBooks journal entry · {selMonth ? monthLabel(selMonth + '-01') : '—'}</Typography>
          <InfoIcon info={<><strong>What it is:</strong> The documented monthly entry that moves subscription revenue from cash to accrual. Stripe is the system of record; this is the supporting schedule. Cash deposits are already in QB, so the entry books only the <em>difference</em>. The itemized outstanding list below is the audit support.</>} />
        </Stack>
        {!row ? <Skeleton variant="rectangular" height={120} /> : (
          <Grid container spacing={2}>
            <Grid item xs={12} md={7}>
              <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', '& td': { py: 0.6, fontVariantNumeric: 'tabular-nums' } }}>
                <tbody>
                  <tr><td>Recognized subscription revenue (accrual)</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{USD2.format(row.recognized)}</td></tr>
                  <tr><td style={{ color: '#8B949E' }}>Less: cash already recorded (deposits)</td><td style={{ textAlign: 'right', color: '#8B949E' }}>({USD2.format(row.cash)})</td></tr>
                  <tr style={{ borderTop: '1px solid #30363D' }}><td style={{ fontWeight: 700, paddingTop: 8 }}>Accrual adjustment to book</td><td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 8, color: adj >= 0 ? '#2EA043' : '#F5A623' }}>{adj >= 0 ? '' : '−'}{USD2.format(Math.abs(adj))}</td></tr>
                </tbody>
              </Box>
            </Grid>
            <Grid item xs={12} md={5}>
              <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: 'rgba(44,115,255,0.06)', border: '1px solid rgba(44,115,255,0.25)', fontSize: 13 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700, display: 'block', mb: 0.5 }}>Suggested entry</Typography>
                {adj >= 0 ? (
                  <><div><b>DR</b> Accounts Receivable · {USD2.format(adj)}</div><div style={{ paddingLeft: 24 }}><b>CR</b> Subscription Revenue · {USD2.format(adj)}</div></>
                ) : (
                  <><div><b>DR</b> Subscription Revenue · {USD2.format(Math.abs(adj))}</div><div style={{ paddingLeft: 24 }}><b>CR</b> Accounts Receivable · {USD2.format(Math.abs(adj))}</div></>
                )}
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                  {adj >= 0 ? 'Revenue earned this month not yet collected — sets up the receivable.' : 'Net collection of prior receivables / prepayments this month — relieves the receivable.'} Confirm account mapping with your accountant.
                </Typography>
              </Box>
            </Grid>
          </Grid>
        )}
      </Paper>

      {/* Reconciliation — which subscriptions were supposed to process */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>What was supposed to process · {selMonth ? monthLabel(selMonth + '-01') : '—'}</Typography>
          <InfoIcon info={<><strong>What it is:</strong> Every subscription recognized in the month — expected (billed), collected (cash), and outstanding (open AR) — so you can see exactly which subscriptions make up the accrual number and which are still owed.<br /><br /><strong>Basis:</strong> <em>invoice</em> = from Stripe recurring invoices by service period; <em>charge</em> = direct‑charge subscriber with no Stripe invoice (charge basis fallback). CSV‑exportable as audit support for the entry.</>} />
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>
          {detailRows.length} subscriptions · {outstandingRows.length} with outstanding balance ({USD0.format(outstandingRows.reduce((s, r) => s + r.outstanding, 0))}) · sorted by outstanding, then recognized
        </Typography>
        {isLoading ? <Skeleton variant="rectangular" height={300} /> : (
          <DrillDownPanel<Record<string, unknown>>
            title=""
            rows={detailRows as unknown as Array<Record<string, unknown>>}
            columns={[
              { key: 'name', label: 'Customer', render: (r: Record<string, unknown>) => { const d = r as unknown as DetailRow; return <CustomerLink id={d.allmoxy_customer_id} name={d.name} />; }, exportValue: (r: Record<string, unknown>) => (r as unknown as DetailRow).name, sortValue: (r: Record<string, unknown>) => (r as unknown as DetailRow).name },
              { key: 'basis', label: 'Basis', render: (r: Record<string, unknown>) => { const b = (r as unknown as DetailRow).basis; return <Chip size="small" label={b} sx={{ height: 20, fontSize: 11, bgcolor: b === 'invoice' ? 'rgba(44,115,255,0.12)' : 'rgba(245,166,35,0.14)', color: b === 'invoice' ? 'primary.main' : 'warning.main' }} />; } },
              { key: 'recognized', label: 'Recognized', align: 'right', render: (r: Record<string, unknown>) => USD2.format((r as unknown as DetailRow).recognized) },
              { key: 'collected', label: 'Collected', align: 'right', render: (r: Record<string, unknown>) => USD2.format((r as unknown as DetailRow).collected) },
              { key: 'outstanding', label: 'Outstanding (AR)', align: 'right', render: (r: Record<string, unknown>) => { const v = (r as unknown as DetailRow).outstanding; return <span style={{ color: v > 0 ? '#F5A623' : '#8B949E', fontWeight: v > 0 ? 600 : 400 }}>{USD2.format(v)}</span>; } },
            ]}
            filename={`revenue_recognition_${selMonth}`}
          />
        )}
      </Paper>

      {/* AR aging — case-by-case list */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>AR aging · open & uncollectible invoices</Typography>
          <InfoIcon info={<><strong>What it is:</strong> Every finalized‑unpaid Stripe invoice across all history, with its service month and age. This is your case‑by‑case list — retry, void, or mark uncollectible in Stripe and it flows through on the next refresh. No automatic write‑offs.</>} />
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>
          {arRows.length} invoices · {snap ? USD0.format(snap.ar_total) : '—'} total · {arRows.filter((r) => r.status === 'uncollectible').length} flagged uncollectible · sorted by amount
        </Typography>
        {isLoading ? <Skeleton variant="rectangular" height={300} /> : (
          <DrillDownPanel<Record<string, unknown>>
            title=""
            rows={arRows as unknown as Array<Record<string, unknown>>}
            columns={[
              { key: 'name', label: 'Customer', render: (r: Record<string, unknown>) => { const a = r as unknown as ArRow; return a.allmoxy_customer_id != null ? <CustomerLink id={a.allmoxy_customer_id} name={a.name} /> : <span>{a.name}</span>; }, exportValue: (r: Record<string, unknown>) => (r as unknown as ArRow).name, sortValue: (r: Record<string, unknown>) => (r as unknown as ArRow).name },
              { key: 'invoice_date', label: 'Invoice date', render: (r: Record<string, unknown>) => fmtDate((r as unknown as ArRow).invoice_date), sortValue: (r: Record<string, unknown>) => (r as unknown as ArRow).invoice_date },
              { key: 'service_month', label: 'Service month', render: (r: Record<string, unknown>) => monthLabel((r as unknown as ArRow).service_month + '-01'), sortValue: (r: Record<string, unknown>) => (r as unknown as ArRow).service_month },
              { key: 'amount', label: 'Amount', align: 'right', render: (r: Record<string, unknown>) => USD2.format((r as unknown as ArRow).amount) },
              { key: 'status', label: 'Status', render: (r: Record<string, unknown>) => { const s = (r as unknown as ArRow).status; return <Chip size="small" label={s} sx={{ height: 20, fontSize: 11, bgcolor: s === 'open' ? 'rgba(245,166,35,0.14)' : 'rgba(229,72,77,0.14)', color: s === 'open' ? 'warning.main' : 'error.main' }} />; } },
              { key: 'age_days', label: 'Age (days)', align: 'right', render: (r: Record<string, unknown>) => String((r as unknown as ArRow).age_days) },
            ]}
            filename="ar_aging_open_invoices"
          />
        )}
      </Paper>

      {/* Trend */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Recognized vs cash · trailing 24 months</Typography>
          <InfoIcon info={<><strong>What it is:</strong> The two bases side by side. Where the lines diverge, cash is lagging (card failures / timing) or leading (prepayments). Bars show open AR by service month.</>} />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={280} /> : (
          <Box sx={{ height: 280 }}>
            <ResponsiveContainer>
              <ComposedChart data={trend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.12)" vertical={false} />
                <XAxis dataKey="month" tickFormatter={(m) => monthLabel(String(m) + '-01').replace(' 20', ' ’')} stroke="#8B949E" fontSize={10} interval={Math.max(0, Math.floor(trend.length / 8))} />
                <YAxis yAxisId="mrr" stroke="#8B949E" fontSize={10} width={56} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <YAxis yAxisId="ar" orientation="right" stroke="#8B949E" fontSize={10} width={48} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <RTooltip {...TT} labelFormatter={(m) => monthLabel(String(m) + '-01')} formatter={(v: number, n: string) => [USD0.format(v), n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="ar" dataKey="AR (open)" fill="rgba(245,166,35,0.45)" />
                <Line yAxisId="mrr" type="monotone" dataKey="Recognized" stroke="#2C73FF" strokeWidth={2.2} dot={false} />
                <Line yAxisId="mrr" type="monotone" dataKey="Cash" stroke="#8B949E" strokeWidth={1.6} strokeDasharray="4 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {!!snap?.orphan_stripe_customers?.length && (
        <Alert severity="warning">
          <strong>{snap.orphan_stripe_customers.length} Stripe customer{snap.orphan_stripe_customers.length === 1 ? '' : 's'} with invoices but no customer profile</strong> — not included in recognized totals until mapped (add to <code>stripe_id_overrides.json</code>): {snap.orphan_stripe_customers.map((o) => `${o.stripe_customer} (${USD0.format(o.latest_mrr)}/mo)`).join(' · ')}
        </Alert>
      )}
    </Box>
  );
}

function Kpi({ label, value, hint, color = 'text.primary', loading, info }: { label: string; value: string | null; hint: string; color?: string; loading?: boolean; info?: React.ReactNode }) {
  return (
    <Paper sx={{ p: 2, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>{label}</Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      {loading || value == null ? <Skeleton variant="text" width="60%" sx={{ fontSize: 24 }} /> : <Typography variant="h6" sx={{ fontWeight: 600, color, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25, fontSize: 10 }}>{hint}</Typography>
    </Paper>
  );
}
