import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Link from '@mui/material/Link';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type ArRow = {
  allmoxy_customer_id: number | null; name: string; invoice_id: string | null; invoice_date: string;
  service_month: string; amount: number; status: 'open' | 'uncollectible'; age_days: number;
  collectible: boolean; bookable_writeoff?: boolean; writeoff_month?: string | null;
  decision?: 'uncollectible' | 'collectible' | null; decision_note?: string | null; decided_at?: string | null;
  customer_status?: string | null; customer_mrr?: number; customer_still_paying?: boolean;
};
type Snap = {
  ar_aging: ArRow[]; ar_total: number;
  ar_policy?: { writeoff_after_days: number | null; open_total: number; open_count: number; written_off_total: number; written_off_count: number; bookable_total: number; books_go_live: string } | null;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtDate(iso: string | null | undefined) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; }

// Pending decisions live in the browser until they're applied to
// _etl_scripts/ar_collection_overrides.json (the deployed site has no backend).
const STORAGE_KEY = 'allmoxy.ar_collection.pending';
type PendingMap = Record<string, { decision: 'uncollectible' | 'collectible'; note?: string | null }>;
const readPending = (): PendingMap => { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; } };
const writePending = (m: PendingMap) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch { /* quota / private mode */ } };

type Filter = 'all' | 'chase' | 'writeoff' | 'decided' | 'undecided';

export default function Collections() {
  const { data, isLoading, error } = useSheetTab('revenue_recognition');
  const snap = data as unknown as Snap | undefined;
  const [pending, setPending] = useState<PendingMap>(() => readPending());
  const [filter, setFilter] = useState<Filter>('all');

  const threshold = snap?.ar_policy?.writeoff_after_days ?? null;
  // Effective state = pending decision > committed decision > age rule.
  const rows = useMemo(() => (snap?.ar_aging ?? []).map((r) => {
    const p = r.invoice_id ? pending[r.invoice_id] : undefined;
    const effective: 'collectible' | 'uncollectible' = p ? p.decision : (r.collectible ? 'collectible' : 'uncollectible');
    const source = p ? 'pending' : r.decision ? 'decided' : 'auto';
    return { ...r, effective, source, pendingNote: p?.note ?? null };
  }).sort((a, b) => b.amount - a.amount), [snap, pending]);

  const shown = useMemo(() => rows.filter((r) => {
    if (filter === 'chase') return r.effective === 'collectible';
    if (filter === 'writeoff') return r.effective === 'uncollectible';
    if (filter === 'decided') return r.source !== 'auto';
    if (filter === 'undecided') return r.source === 'auto';
    return true;
  }), [rows, filter]);

  const t = useMemo(() => ({
    chase: rows.filter((r) => r.effective === 'collectible').reduce((s, r) => s + r.amount, 0),
    chaseN: rows.filter((r) => r.effective === 'collectible').length,
    writeoff: rows.filter((r) => r.effective === 'uncollectible').reduce((s, r) => s + r.amount, 0),
    writeoffN: rows.filter((r) => r.effective === 'uncollectible').length,
    live: rows.filter((r) => r.effective === 'collectible' && r.customer_still_paying).reduce((s, r) => s + r.amount, 0),
    pendingN: Object.keys(pending).length,
  }), [rows, pending]);

  const setDecision = (inv: string | null, decision: 'uncollectible' | 'collectible' | null) => {
    if (!inv) return;
    const next = { ...pending };
    if (decision == null) delete next[inv]; else next[inv] = { decision };
    setPending(next); writePending(next);
  };
  const copyPending = () => {
    const payload = JSON.stringify(pending);
    navigator.clipboard?.writeText(payload);
    // eslint-disable-next-line no-alert
    alert(`Copied ${Object.keys(pending).length} decision(s).\n\nApply with:\nnode _etl_scripts/toggle_ar_collection.mjs apply '${payload.length > 400 ? payload.slice(0, 400) + '…' : payload}'`);
  };

  const cell = { py: 0.7, px: 1, fontSize: 13, borderBottom: '1px solid rgba(139,148,158,0.15)', fontVariantNumeric: 'tabular-nums' } as const;

  return (
    <Box>
      <PageHeader
        title="Collections"
        subtitle="Every unpaid invoice, who owes it, how old it is — and whether the customer is still with you. Decide invoice by invoice what to keep chasing and what to write off."
        question="durable"
      />
      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load revenue_recognition — {String(error)}</Alert>}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Chasing" value={USD0.format(t.chase)} hint={`${t.chaseN} invoices still collectible`} color="success.main" loading={isLoading} /></Grid>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Writing off" value={USD0.format(t.writeoff)} hint={`${t.writeoffN} invoices → 4950`} color="error.main" loading={isLoading} /></Grid>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Owed by live customers" value={USD0.format(t.live)} hint="Still paying you — best odds" color="primary.main" loading={isLoading} /></Grid>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Pending decisions" value={String(t.pendingN)} hint={t.pendingN ? 'Not yet applied' : 'None'} color={t.pendingN ? 'warning.main' : 'text.primary'} loading={isLoading} /></Grid>
      </Grid>

      <Alert severity="info" sx={{ mb: 2 }}>
        <strong>How an invoice becomes bad debt.</strong> By default it's automatic and blunt: anything older than{' '}
        <strong>{threshold ?? '—'} days</strong> from its invoice date is written off, with no regard for whether the customer is still with you.
        That's why some balances from customers who pay you every month get written off. <strong>Any decision you make here overrides that rule</strong>, in
        either direction — keep chasing an old invoice, or write off a young one that's clearly dead.
      </Alert>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Open invoices</Typography>
          <InfoIcon info={<><strong>Reading a row:</strong> <em>Customer</em> shows whether the relationship is alive — a customer still paying monthly is far more likely to settle an old balance. <em>Age</em> is days since the invoice date. <em>Source</em> is how the current call was made: <strong>auto</strong> (the age rule), <strong>decided</strong> (committed), or <strong>pending</strong> (yours, not yet applied).<br /><br /><strong>Making a call:</strong> "Chase" keeps it in AR; "Write off" books it to 4950 Uncollectible Income. Only balances whose revenue was recognized from {snap?.ar_policy?.books_go_live ?? '2026-01'} onward hit the books — earlier years ran on cash, so no receivable was ever recorded.<br /><br />Decisions are saved in your browser; use <strong>Copy pending decisions</strong> and give them to Claude to commit.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <TextField select size="small" label="Show" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} sx={{ minWidth: 190 }}>
            <MenuItem value="all">All ({rows.length})</MenuItem>
            <MenuItem value="chase">Chasing ({t.chaseN})</MenuItem>
            <MenuItem value="writeoff">Writing off ({t.writeoffN})</MenuItem>
            <MenuItem value="undecided">Undecided — auto only ({rows.filter((r) => r.source === 'auto').length})</MenuItem>
            <MenuItem value="decided">Decided ({rows.filter((r) => r.source !== 'auto').length})</MenuItem>
          </TextField>
          {t.pendingN > 0 && <Button size="small" variant="contained" onClick={copyPending}>Copy pending decisions ({t.pendingN})</Button>}
        </Stack>

        {isLoading ? <Skeleton variant="rectangular" height={340} /> : (
          <Box sx={{ overflowX: 'auto' }}>
            <Box component="table" sx={{ borderCollapse: 'collapse', width: '100%', minWidth: 900 }}>
              <thead><tr>
                {['Customer', 'Invoice', 'Amount', 'Age', 'Customer state', 'Source', 'Decision'].map((h, i) => (
                  <Box key={h} component="th" sx={{ ...cell, textAlign: i === 2 || i === 3 ? 'right' : 'left', color: 'text.secondary', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</Box>
                ))}
              </tr></thead>
              <tbody>
                {shown.map((r) => {
                  const off = r.effective === 'uncollectible';
                  return (
                    <tr key={r.invoice_id ?? `${r.name}-${r.invoice_date}-${r.amount}`}>
                      <Box component="td" sx={{ ...cell }}>
                        {r.allmoxy_customer_id != null ? <CustomerLink id={r.allmoxy_customer_id} name={r.name} /> : r.name}
                      </Box>
                      <Box component="td" sx={{ ...cell, color: 'text.secondary', fontSize: 12 }}>
                        {r.invoice_id ? <Link href={`https://dashboard.stripe.com/invoices/${r.invoice_id}`} target="_blank" rel="noopener noreferrer" sx={{ color: 'text.secondary' }}>{fmtDate(r.invoice_date)}</Link> : fmtDate(r.invoice_date)}
                        {r.status === 'uncollectible' && <Chip size="small" label="uncollectible in Stripe" sx={{ ml: 0.5, height: 16, fontSize: 9, bgcolor: 'rgba(229,72,77,0.14)', color: 'error.main' }} />}
                      </Box>
                      <Box component="td" sx={{ ...cell, textAlign: 'right', fontWeight: 600, textDecoration: off ? 'line-through' : undefined, color: off ? 'text.secondary' : undefined }}>{USD2.format(r.amount)}</Box>
                      <Box component="td" sx={{ ...cell, textAlign: 'right', color: r.age_days > (threshold ?? 90) ? 'warning.main' : 'text.secondary' }}>{r.age_days}d</Box>
                      <Box component="td" sx={{ ...cell, fontSize: 12 }}>
                        {r.customer_still_paying
                          ? <span style={{ color: '#2EA043' }}>paying {USD0.format(r.customer_mrr ?? 0)}/mo</span>
                          : <span style={{ color: '#8B949E' }}>{r.customer_status === 'churned' ? 'churned' : 'not billing'}</span>}
                      </Box>
                      <Box component="td" sx={{ ...cell }}>
                        <Chip size="small" label={r.source} sx={{ height: 18, fontSize: 10, textTransform: 'capitalize', bgcolor: r.source === 'pending' ? 'rgba(245,166,35,0.16)' : r.source === 'decided' ? 'rgba(44,115,255,0.14)' : 'rgba(139,148,158,0.12)', color: r.source === 'pending' ? 'warning.main' : r.source === 'decided' ? 'primary.main' : 'text.secondary' }} />
                      </Box>
                      <Box component="td" sx={{ ...cell }}>
                        <Stack direction="row" spacing={0.5}>
                          <Button size="small" variant={r.effective === 'collectible' ? 'contained' : 'outlined'} color="success" sx={{ minWidth: 0, px: 1, py: 0, fontSize: 11, textTransform: 'none' }} onClick={() => setDecision(r.invoice_id, 'collectible')}>Chase</Button>
                          <Button size="small" variant={off ? 'contained' : 'outlined'} color="error" sx={{ minWidth: 0, px: 1, py: 0, fontSize: 11, textTransform: 'none' }} onClick={() => setDecision(r.invoice_id, 'uncollectible')}>Write off</Button>
                          {r.source === 'pending' && <Button size="small" sx={{ minWidth: 0, px: 0.5, py: 0, fontSize: 11, textTransform: 'none' }} onClick={() => setDecision(r.invoice_id, null)}>undo</Button>}
                        </Stack>
                      </Box>
                    </tr>
                  );
                })}
              </tbody>
            </Box>
          </Box>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5 }}>
          Showing {shown.length} of {rows.length}. Marking an invoice here changes the dashboard only — it does <strong>not</strong> touch Stripe. Void it or mark it uncollectible in Stripe to make it official.
        </Typography>
      </Paper>
    </Box>
  );
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
