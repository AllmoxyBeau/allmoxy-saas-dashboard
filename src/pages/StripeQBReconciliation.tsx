import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';

type ReconciliationRow = {
  month: string;
  stripe: {
    subscription: number;
    services: number;
    connect: number;
    other: number;
    refunds: number;
    total: number;
  };
  qb: {
    subscription_revenue: number;
    annual_deferred: number;
    subscription_recognized: number;
    services_revenue: number;
    affiliate_revenue: number;
    subscription_tax: number;
    stripe_fee_income: number;
    total_income: number;
  };
  variance: {
    subscription_dollars: number;
    subscription_pct: number | null;
    services_dollars: number;
    services_pct: number | null;
  };
  tie_out_status: 'tight' | 'acceptable' | 'investigate';
};

type ReconciliationSnap = {
  fetched_at: string;
  comment: string;
  rows: ReconciliationRow[];
  reconciling_items: Array<{ label: string; description: string; sign: string }>;
  summary: { n_months: number; n_tight: number; n_acceptable: number; n_investigate: number };
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function monthLabelLong(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function pct(v: number | null, digits = 2): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

const STATUS_COLOR: Record<ReconciliationRow['tie_out_status'], string> = {
  tight: '#1A9E5C',
  acceptable: '#F5A623',
  investigate: '#E53E3E',
};
const STATUS_LABEL: Record<ReconciliationRow['tie_out_status'], string> = {
  tight: 'Tight (≤1%)',
  acceptable: 'Acceptable (≤5%)',
  investigate: 'Investigate (>5%)',
};

export default function StripeQBReconciliation() {
  const { data, isLoading, error } = useSheetTab('stripe_qb_reconciliation');
  const snap = data as unknown as ReconciliationSnap | undefined;

  const rows = useMemo(() => (snap?.rows ?? []).slice().reverse(), [snap]); // newest first
  const summary = snap?.summary;

  return (
    <Box>
      <PageHeader
        title="Stripe ↔ QuickBooks Reconciliation"
        subtitle="Per-month tie-out of Stripe transactions to QuickBooks revenue lines. The first thing a QoE reviewer asks: 'show me how Stripe ties to your books.'"
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load stripe_qb_reconciliation: {String(error)}</Alert>}

      {snap && (
        <Alert severity="info" sx={{ mb: 3 }}>
          Reconciliation built from <strong>{snap.summary.n_months}</strong> months of P&L data.
          {' '}<strong style={{ color: STATUS_COLOR.tight }}>{snap.summary.n_tight} tight</strong> (≤1% variance) ·
          {' '}<strong style={{ color: STATUS_COLOR.acceptable }}>{snap.summary.n_acceptable} acceptable</strong> (≤5%) ·
          {' '}<strong style={{ color: STATUS_COLOR.investigate }}>{snap.summary.n_investigate} to investigate</strong> (&gt;5%).
          {' '}Months flagged "investigate" usually correspond to known reconciling items below — annual lump-sum receipts and transaction-stream reclassifications. Last refreshed: {new Date(snap.fetched_at).toLocaleString()}.
        </Alert>
      )}

      {/* Headline tie-out status */}
      {summary && (
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={12} sm={4}>
            <Paper sx={{ p: 2.5, borderLeft: '4px solid', borderColor: STATUS_COLOR.tight }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Tight tie-out</Typography>
              <Typography variant="h4" sx={{ fontWeight: 500, color: STATUS_COLOR.tight }}>{summary.n_tight}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>Variance ≤1% — QoE-grade</Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Paper sx={{ p: 2.5, borderLeft: '4px solid', borderColor: STATUS_COLOR.acceptable }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Acceptable</Typography>
              <Typography variant="h4" sx={{ fontWeight: 500, color: STATUS_COLOR.acceptable }}>{summary.n_acceptable}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>Variance 1–5% — explained by routine timing</Typography>
            </Paper>
          </Grid>
          <Grid item xs={12} sm={4}>
            <Paper sx={{ p: 2.5, borderLeft: '4px solid', borderColor: STATUS_COLOR.investigate }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Investigate</Typography>
              <Typography variant="h4" sx={{ fontWeight: 500, color: STATUS_COLOR.investigate }}>{summary.n_investigate}</Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>Variance &gt;5% — review against reconciling items below</Typography>
            </Paper>
          </Grid>
        </Grid>
      )}

      {/* Reconciliation table */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Per-month tie-out · newest first</Typography>
            <InfoIcon info={
              <>
                <strong>What it is:</strong> Per-month reconciliation of Stripe transactions to QB revenue lines.
                <br /><br />
                <strong>Stripe side:</strong> Sum of <code>customer_profiles.transactions</code> (status = succeeded), grouped by type. Uses <code>net_amount</code> (post-refund).
                <br /><br />
                <strong>QB side:</strong> <code>pnl_by_month</code> line items. "Subscription recognized" = Line 4000 subscription_revenue + Line 4100 annual_deferred (the deferred-revenue recognition of previously-collected annual lumps).
                <br /><br />
                <strong>Variance = Stripe − QB recognized.</strong> Positive means Stripe collected more than QB recognized (typical for the month an annual lump hits Stripe). Negative is the inverse.
              </>
            } />
          </Stack>
          {snap && (
            <CsvExportButton
              filename="stripe_qb_reconciliation"
              columns={[
                { key: 'month', label: 'Month' },
                { key: 'stripe_subscription', label: 'Stripe sub $', getValue: (r) => (r as unknown as ReconciliationRow).stripe.subscription },
                { key: 'qb_subscription_recognized', label: 'QB sub recognized $', getValue: (r) => (r as unknown as ReconciliationRow).qb.subscription_recognized },
                { key: 'variance_subscription_dollars', label: 'Sub variance $', getValue: (r) => (r as unknown as ReconciliationRow).variance.subscription_dollars },
                { key: 'variance_subscription_pct', label: 'Sub variance %', getValue: (r) => (r as unknown as ReconciliationRow).variance.subscription_pct },
                { key: 'stripe_services', label: 'Stripe svc $', getValue: (r) => (r as unknown as ReconciliationRow).stripe.services },
                { key: 'qb_services_revenue', label: 'QB svc $', getValue: (r) => (r as unknown as ReconciliationRow).qb.services_revenue },
                { key: 'variance_services_dollars', label: 'Svc variance $', getValue: (r) => (r as unknown as ReconciliationRow).variance.services_dollars },
                { key: 'variance_services_pct', label: 'Svc variance %', getValue: (r) => (r as unknown as ReconciliationRow).variance.services_pct },
                { key: 'tie_out_status', label: 'Status', getValue: (r) => (r as unknown as ReconciliationRow).tie_out_status },
              ]}
              rows={rows as unknown as Array<Record<string, unknown>>}
              label="Export CSV"
            />
          )}
        </Stack>

        {isLoading ? (
          <Skeleton variant="rectangular" height={400} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell rowSpan={2} sx={{ verticalAlign: 'bottom' }}>Month</TableCell>
                <TableCell colSpan={2} align="center" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 600 }}>Subscription</TableCell>
                <TableCell colSpan={2} align="center" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 600 }}>Variance</TableCell>
                <TableCell colSpan={2} align="center" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 600 }}>Services</TableCell>
                <TableCell colSpan={2} align="center" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 600 }}>Variance</TableCell>
                <TableCell rowSpan={2} align="center" sx={{ borderLeft: '1px solid', borderColor: 'divider', verticalAlign: 'bottom' }}>Status</TableCell>
              </TableRow>
              <TableRow>
                <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontSize: 11 }}>Stripe</TableCell>
                <TableCell align="right" sx={{ fontSize: 11 }}>QB recog.</TableCell>
                <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontSize: 11 }}>$</TableCell>
                <TableCell align="right" sx={{ fontSize: 11 }}>%</TableCell>
                <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontSize: 11 }}>Stripe</TableCell>
                <TableCell align="right" sx={{ fontSize: 11 }}>QB</TableCell>
                <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontSize: 11 }}>$</TableCell>
                <TableCell align="right" sx={{ fontSize: 11 }}>%</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const subSign = r.variance.subscription_dollars > 0 ? '+' : '';
                const svcSign = r.variance.services_dollars > 0 ? '+' : '';
                return (
                  <TableRow key={r.month} hover>
                    <TableCell sx={{ fontWeight: 500 }}>{monthLabelLong(r.month)}</TableCell>
                    <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.stripe.subscription)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.qb.subscription_recognized)}</TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        borderLeft: '1px solid',
                        borderColor: 'divider',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 500,
                        color: Math.abs(r.variance.subscription_dollars) < 100 ? 'text.secondary' : r.variance.subscription_dollars > 0 ? 'success.main' : 'error.main',
                      }}
                    >
                      {subSign}{USD0.format(r.variance.subscription_dollars)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{pct(r.variance.subscription_pct)}</TableCell>
                    <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.stripe.services)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.qb.services_revenue)}</TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        borderLeft: '1px solid',
                        borderColor: 'divider',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 500,
                        color: Math.abs(r.variance.services_dollars) < 100 ? 'text.secondary' : r.variance.services_dollars > 0 ? 'success.main' : 'error.main',
                      }}
                    >
                      {svcSign}{USD0.format(r.variance.services_dollars)}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{pct(r.variance.services_pct)}</TableCell>
                    <TableCell align="center" sx={{ borderLeft: '1px solid', borderColor: 'divider' }}>
                      <Chip
                        label={STATUS_LABEL[r.tie_out_status]}
                        size="small"
                        variant="outlined"
                        sx={{ height: 20, fontSize: 10.5, color: STATUS_COLOR[r.tie_out_status], borderColor: STATUS_COLOR[r.tie_out_status] }}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>

      {/* Known reconciling items */}
      {snap?.reconciling_items && (
        <Paper sx={{ p: 3 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 2 }}>
            Known reconciling items — why variance appears
          </Typography>
          <Stack spacing={1.5}>
            {snap.reconciling_items.map((item, i) => (
              <Box key={i} sx={{ pl: 2, borderLeft: '3px solid', borderColor: 'primary.main' }}>
                <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 13 }}>{item.label}</Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>{item.description}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontStyle: 'italic' }}>Sign: {item.sign}</Typography>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
