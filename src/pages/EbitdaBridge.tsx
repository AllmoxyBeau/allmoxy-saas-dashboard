import { useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';

type AddBack = { key: string; label: string; amount: number };
type QoeAdjustment = {
  id: string;
  label: string;
  category: string;
  amount: number;
  reason: string;
  evidence: string | null;
  verified_by: string | null;
  verified_at: string | null;
  is_placeholder: boolean;
};
type Bridge = {
  window: string;
  label?: string;
  start?: string;
  end?: string;
  months_in_window?: number;
  total_revenue?: number;
  net_income?: number;
  add_backs_to_ebitda?: AddBack[];
  gaap_ebitda?: number;
  gaap_ebitda_margin?: number | null;
  qoe_adjustments?: QoeAdjustment[];
  qoe_adjustment_total?: number;
  adjusted_ebitda?: number;
  adjusted_ebitda_margin?: number | null;
  placeholder_adjustment_count?: number;
  unavailable?: boolean;
  reason?: string;
};
type BridgeSnapshot = {
  fetched_at: string;
  comment: string;
  source: {
    pnl_months: number;
    pnl_window: string;
    qoe_adjustment_count: number;
    qoe_adjustments_placeholder_count: number;
  };
  bridges: {
    ytd_current: Bridge;
    latest_month: Bridge;
    ttm: Bridge;
  };
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CATEGORY_COLOR: Record<string, string> = {
  owner_compensation: '#2C73FF',
  one_time: '#E67E22',
  discretionary: '#9F7AEA',
  non_operating: '#8B949E',
  other: '#94a3b8',
};

function BridgeRow({ label, amount, bold, signed, color }: { label: string; amount: number; bold?: boolean; signed?: boolean; color?: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ py: 0.75, px: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Typography variant="body2" sx={{ fontSize: 13, fontWeight: bold ? 600 : 400, color: color ?? 'text.primary' }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontSize: 13, fontWeight: bold ? 600 : 500, fontVariantNumeric: 'tabular-nums', color: color ?? (amount < 0 && signed ? 'error.main' : 'text.primary') }}>
        {signed && amount > 0 ? '+' : ''}{USD0.format(amount)}
      </Typography>
    </Stack>
  );
}

export default function EbitdaBridge() {
  const { data, isLoading, error } = useSheetTab('ebitda_bridge');
  const snap = data as unknown as BridgeSnapshot | undefined;

  const [windowKey, setWindowKey] = useState<'ytd_current' | 'latest_month' | 'ttm'>('ytd_current');
  const bridge = snap?.bridges[windowKey];

  return (
    <Box>
      <PageHeader
        title="Adjusted EBITDA Bridge"
        subtitle="GAAP Net Income → standard EBITDA add-backs (interest, tax, D&A) → GAAP EBITDA → QoE adjustments (owner-comp normalization, one-time costs, discretionary perks) → Adjusted EBITDA. The canonical bridge a banker or buyer expects to see."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load ebitda_bridge: {String(error)}</Alert>}

      {snap && (
        <Alert severity="info" sx={{ mb: 3 }}>
          P&L source covers <strong>{snap.source.pnl_months}</strong> month(s) ({snap.source.pnl_window}).
          {' '}<strong>{snap.source.qoe_adjustment_count}</strong> QoE adjustments on file
          {snap.source.qoe_adjustments_placeholder_count > 0 && (
            <> · <strong style={{ color: '#E67E22' }}>{snap.source.qoe_adjustments_placeholder_count} still placeholders</strong> (need owner sign-off + amounts)</>
          )}.
          {' '}Last refreshed: {new Date(snap.fetched_at).toLocaleString()}.
        </Alert>
      )}

      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }} flexWrap="wrap">
        <ToggleButtonGroup
          size="small"
          exclusive
          value={windowKey}
          onChange={(_, v) => v && setWindowKey(v)}
          sx={{ '& .MuiToggleButton-root': { px: 2, py: 0.5, fontSize: 12, textTransform: 'none' } }}
        >
          <ToggleButton value="ytd_current">YTD {snap?.bridges.ytd_current?.label?.replace('YTD ', '') ?? ''}</ToggleButton>
          <ToggleButton value="latest_month">Latest month</ToggleButton>
          <ToggleButton value="ttm" disabled={snap?.bridges.ttm?.unavailable}>TTM {snap?.bridges.ttm?.unavailable ? '(unavailable)' : ''}</ToggleButton>
        </ToggleButtonGroup>
        {bridge && !bridge.unavailable && (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {bridge.start} – {bridge.end} ({bridge.months_in_window} month{bridge.months_in_window !== 1 ? 's' : ''})
          </Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        {bridge?.qoe_adjustments && bridge.qoe_adjustments.length > 0 && (
          <CsvExportButton
            filename={`ebitda_bridge_${windowKey}`}
            columns={[
              { key: 'id', label: 'ID' },
              { key: 'label', label: 'Adjustment' },
              { key: 'category', label: 'Category' },
              { key: 'amount', label: 'Amount $' },
              { key: 'reason', label: 'Reason' },
              { key: 'verified_by', label: 'Verified by' },
              { key: 'is_placeholder', label: 'Placeholder?' },
            ]}
            rows={bridge.qoe_adjustments as unknown as Array<Record<string, unknown>>}
          />
        )}
      </Stack>

      {isLoading ? (
        <Skeleton variant="rectangular" height={400} />
      ) : bridge?.unavailable ? (
        <Alert severity="warning">{bridge.reason}</Alert>
      ) : bridge ? (
        <>
          {/* Headline KPIs */}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Total Revenue</Typography>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD0.format(bridge.total_revenue ?? 0)}</Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Net Income</Typography>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD0.format(bridge.net_income ?? 0)}</Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>GAAP EBITDA</Typography>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD0.format(bridge.gaap_ebitda ?? 0)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {bridge.gaap_ebitda_margin != null ? (bridge.gaap_ebitda_margin * 100).toFixed(1) + '% margin' : '—'}
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper sx={{ p: 2.5, bgcolor: 'rgba(44, 115, 255, 0.06)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Adjusted EBITDA</Typography>
                <Typography variant="h5" sx={{ fontWeight: 600, color: 'primary.main' }}>{USD0.format(bridge.adjusted_ebitda ?? 0)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {bridge.adjusted_ebitda_margin != null ? (bridge.adjusted_ebitda_margin * 100).toFixed(1) + '% margin' : '—'}
                </Typography>
              </Paper>
            </Grid>
          </Grid>

          <Grid container spacing={3}>
            {/* Bridge waterfall */}
            <Grid item xs={12} md={6}>
              <Paper sx={{ p: 3 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Bridge</Typography>
                  <InfoIcon info={
                    <>
                      <strong>Standard EBITDA bridge:</strong> Net Income + Interest + Tax + D&A = GAAP EBITDA.<br /><br />
                      <strong>QoE adjustments:</strong> add-backs a buyer would expect — owner-comp normalization, non-recurring expenses (legal/M&A), discretionary owner perks. Each is positive if it should be added back, negative if removed.
                    </>
                  } />
                </Stack>
                <BridgeRow label="GAAP Net Income" amount={bridge.net_income ?? 0} bold />
                {(bridge.add_backs_to_ebitda ?? []).map((ab) => (
                  <BridgeRow key={ab.key} label={`+ ${ab.label}`} amount={ab.amount} signed color={ab.amount === 0 ? 'text.secondary' : undefined} />
                ))}
                <BridgeRow label="= GAAP EBITDA" amount={bridge.gaap_ebitda ?? 0} bold />
                <Divider sx={{ my: 1 }} />
                {(bridge.qoe_adjustments ?? []).length === 0 && (
                  <Box sx={{ p: 2, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}>
                    No QoE adjustments configured. Add to <code>_etl_scripts/ebitda_adjustments.json</code>.
                  </Box>
                )}
                {(bridge.qoe_adjustments ?? []).map((q) => (
                  <Stack key={q.id} direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.75, px: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip
                        label={q.category.replace(/_/g, ' ')}
                        size="small"
                        variant="outlined"
                        sx={{ height: 18, fontSize: 9.5, color: CATEGORY_COLOR[q.category] ?? '#94a3b8', borderColor: CATEGORY_COLOR[q.category] ?? '#94a3b8', textTransform: 'capitalize' }}
                      />
                      <Typography variant="body2" sx={{ fontSize: 13 }}>{q.label}</Typography>
                      {q.is_placeholder && <Chip label="placeholder" size="small" color="warning" sx={{ height: 16, fontSize: 9 }} />}
                    </Stack>
                    <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: q.amount === 0 ? 'text.secondary' : q.amount < 0 ? 'error.main' : 'text.primary' }}>
                      {q.amount > 0 ? '+' : ''}{USD0.format(q.amount)}
                    </Typography>
                  </Stack>
                ))}
                {(bridge.qoe_adjustments ?? []).length > 0 && (
                  <BridgeRow label="QoE adjustment total" amount={bridge.qoe_adjustment_total ?? 0} signed bold />
                )}
                <Box sx={{ mt: 1, p: 1.5, bgcolor: 'rgba(44, 115, 255, 0.08)', borderRadius: 1 }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                    <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>= Adjusted EBITDA</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 600, color: 'primary.main', fontVariantNumeric: 'tabular-nums' }}>{USD0.format(bridge.adjusted_ebitda ?? 0)}</Typography>
                  </Stack>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {bridge.adjusted_ebitda_margin != null ? (bridge.adjusted_ebitda_margin * 100).toFixed(1) + '% of revenue' : '—'}
                  </Typography>
                </Box>
              </Paper>
            </Grid>

            {/* QoE adjustment detail */}
            <Grid item xs={12} md={6}>
              <Paper sx={{ p: 3 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>QoE Adjustment Detail</Typography>
                  <InfoIcon info="Every QoE add-back with its reason, evidence, and sign-off status. Placeholders need amounts and owner sign-off before banker handoff." />
                </Stack>
                {(bridge.qoe_adjustments ?? []).length === 0 ? (
                  <Box sx={{ p: 2, textAlign: 'center', color: 'text.secondary', fontSize: 12 }}>
                    No adjustments to detail.
                  </Box>
                ) : (
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Adjustment</TableCell>
                        <TableCell align="right">Amount</TableCell>
                        <TableCell>Verified</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {(bridge.qoe_adjustments ?? []).map((q) => (
                        <TableRow key={q.id}>
                          <TableCell sx={{ verticalAlign: 'top' }}>
                            <Stack spacing={0.5}>
                              <Stack direction="row" spacing={1} alignItems="center">
                                <Typography variant="body2" sx={{ fontWeight: 500, fontSize: 13 }}>{q.label}</Typography>
                                {q.is_placeholder && <Chip label="placeholder" size="small" color="warning" sx={{ height: 16, fontSize: 9 }} />}
                              </Stack>
                              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11, lineHeight: 1.5 }}>{q.reason}</Typography>
                            </Stack>
                          </TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, verticalAlign: 'top' }}>
                            {q.amount > 0 ? '+' : ''}{USD2.format(q.amount)}
                          </TableCell>
                          <TableCell sx={{ fontSize: 11, verticalAlign: 'top' }}>
                            {q.verified_by ? <Chip label={q.verified_by} size="small" color="success" sx={{ height: 18, fontSize: 10 }} /> : <span style={{ color: '#94a3b8' }}>—</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Paper>
            </Grid>
          </Grid>

          <Box sx={{ mt: 3, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Adding or editing a QoE add-back
            </Typography>
            <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>
              QoE adjustments live in <code>_etl_scripts/ebitda_adjustments.json</code>. Each entry has either a <code>per_month</code> amount or a <code>ytd_total</code>. Use <strong>positive amounts</strong> to add back (e.g., a one-time legal fee that hit expenses but won't recur); <strong>negative amounts</strong> to remove (e.g., recognizing a future obligation not yet in the P&L). Set <code>is_placeholder: false</code> + populate <code>verified_by</code> / <code>verified_at</code> once owner sign-off is captured. Re-run <code>node _etl_scripts/build_ebitda_bridge.mjs</code>.
            </Typography>
          </Box>
        </>
      ) : null}
    </Box>
  );
}
