import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';

type StripePayment = {
  created: string;
  amount: number;
  stripe_id: string | null;
  description: string;
};

type SyntheticPayment = {
  created: string;
  amount: number;
  payment_method: string;
  evidence: string | null;
  description: string;
  reason: string;
  added_by: string | null;
};

type Override = {
  origin_month: string;
  start_month: string;
  months: number;
  amount_match_min: number;
  amount_match_max: number;
  monthly_amortized: number;
  reason: string;
};

type AnnualizedMonth = {
  month: string;
  subscription: number;
};

type EvidenceEntry = {
  allmoxy_customer_id: number;
  customer_name: string;
  status: string | null;
  current_subscription_mrr: number | null;
  hubspot_company_id: string | null;
  billing_cadence: string;
  typical_annual_amount: number | null;
  typical_months: number;
  default_amortization_window: string;
  contract_signed_date: string | null;
  contract_link: string | null;
  evidence_files: string[];
  qb_treatment: string | null;
  notes: string | null;
  annualized_months: AnnualizedMonth[];
  annualized_month_count: number;
  total_amortized_dollars: number;
  stripe_payments: StripePayment[];
  stripe_payment_count: number;
  synthetic_payments: SyntheticPayment[];
  synthetic_payment_count: number;
  overrides: Override[];
  override_count: number;
  verified_by: string | null;
  verified_at: string | null;
};

type EvidenceSnapshot = {
  fetched_at: string;
  comment: string;
  summary: {
    annual_payer_count: number;
    total_amortized_dollars: number;
    total_annualized_months: number;
    payers_with_overrides: number;
    payers_with_synthetic_payments: number;
    payers_with_contract_link: number;
    payers_verified: number;
  };
  entries: EvidenceEntry[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  // YYYY-MM-DD or full ISO — show short form
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) {
    const [, y, m, d] = iso.match(/^(\d{4})-(\d{2})-(\d{2})/) || [];
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return iso;
}

export default function AnnualAmortizationEvidence() {
  const { data, isLoading, error } = useSheetTab('annual_amortization_evidence');
  const snap = data as unknown as EvidenceSnapshot | undefined;

  const entries = snap?.entries ?? [];

  const flatRows = useMemo(() => {
    return entries.flatMap((e) =>
      e.annualized_months.map((m) => ({
        customer_id: e.allmoxy_customer_id,
        customer_name: e.customer_name,
        month: m.month,
        amortized_dollars: m.subscription,
        verified_by: e.verified_by,
        contract_on_file: e.contract_link ? 'yes' : 'no',
      }))
    );
  }, [entries]);

  return (
    <Box>
      <PageHeader
        title="Annual Amortization · Evidence Folder"
        subtitle="Per annual-payer, the source payment trace (Stripe / check), realized amortization on monthly_history, custom override windows, QuickBooks treatment, and verification trail. A QoE reviewer should be able to answer 'prove every annualized dollar' from this page alone."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load annual_amortization_evidence: {String(error)}</Alert>}

      {snap && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>{snap.summary.annual_payer_count} annual payer(s)</strong> · <strong>{USD0.format(snap.summary.total_amortized_dollars)}</strong> total amortized into the MRR series across <strong>{snap.summary.total_annualized_months}</strong> monthly cells.
          {' '}{snap.summary.payers_verified}/{snap.summary.annual_payer_count} verified · {snap.summary.payers_with_contract_link}/{snap.summary.annual_payer_count} have a contract on file.
          Last refreshed: {new Date(snap.fetched_at).toLocaleString()}.
        </Alert>
      )}

      {/* Headline KPIs */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Annual payers</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500 }}>{snap?.summary.annual_payer_count ?? 0}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Customers paying annually upfront</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Dollars amortized</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'primary.main' }}>{USD0.format(snap?.summary.total_amortized_dollars ?? 0)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Across {snap?.summary.total_annualized_months ?? 0} month-cells</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Off-Stripe payments</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500 }}>{snap?.summary.payers_with_synthetic_payments ?? 0}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Payers with checks / wires / ACH</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Verified</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: (snap?.summary.payers_verified ?? 0) === (snap?.summary.annual_payer_count ?? 0) ? 'success.main' : 'warning.main' }}>
                  {snap?.summary.payers_verified ?? 0}/{snap?.summary.annual_payer_count ?? 0}
                </Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>QoE sign-off complete</Typography>
              </>
            )}
          </Paper>
        </Grid>
      </Grid>

      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
        <CsvExportButton
          filename="annual_amortization_realized_months"
          columns={[
            { key: 'customer_id', label: 'Allmoxy ID' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'month', label: 'Month' },
            { key: 'amortized_dollars', label: 'Amortized $' },
            { key: 'verified_by', label: 'Verified by' },
            { key: 'contract_on_file', label: 'Contract on file?' },
          ]}
          rows={flatRows as unknown as Array<Record<string, unknown>>}
        />
      </Stack>

      {isLoading ? (
        <Skeleton variant="rectangular" height={400} />
      ) : (
        <Stack spacing={2}>
          {entries.map((e) => (
            <Paper key={e.allmoxy_customer_id} sx={{ p: 3 }}>
              {/* Header row */}
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6" sx={{ fontWeight: 500 }}>
                      <CustomerLink id={e.allmoxy_customer_id} name={e.customer_name} />
                    </Typography>
                    <Chip
                      label={e.status ?? 'unknown'}
                      size="small"
                      color={e.status === 'active' ? 'success' : e.status === 'churned' ? 'error' : 'default'}
                      sx={{ height: 20, fontSize: 11, textTransform: 'capitalize' }}
                    />
                    {e.verified_by && (
                      <Chip
                        label={`Verified ${e.verified_by}${e.verified_at ? ` · ${fmtDate(e.verified_at)}` : ''}`}
                        size="small"
                        variant="outlined"
                        color="success"
                        sx={{ height: 20, fontSize: 10 }}
                      />
                    )}
                  </Stack>
                  <Typography variant="caption" sx={{ color: 'text.secondary', mt: 0.5, display: 'block' }}>
                    Current MRR (amortized): {USD2.format(e.current_subscription_mrr ?? 0)} ·
                    Billing cadence: {e.billing_cadence} ·
                    Typical annual: {e.typical_annual_amount ? USD0.format(e.typical_annual_amount) : '—'} ·
                    Default window: {e.default_amortization_window}
                  </Typography>
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>
                    Total amortized into MRR
                  </Typography>
                  <Typography variant="h5" sx={{ fontWeight: 500, color: 'primary.main' }}>
                    {USD0.format(e.total_amortized_dollars)}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {e.annualized_month_count} month-cells
                  </Typography>
                </Box>
              </Stack>

              {e.notes && (
                <Alert severity="info" sx={{ mb: 2, fontSize: 12 }}>
                  {e.notes}
                </Alert>
              )}

              {/* QB treatment */}
              {e.qb_treatment && (
                <Box sx={{ mb: 2, p: 2, bgcolor: 'rgba(159, 122, 234, 0.06)', borderLeft: '3px solid', borderColor: '#9F7AEA' }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, display: 'block', mb: 0.5 }}>
                    QuickBooks treatment
                  </Typography>
                  <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.55 }}>
                    {e.qb_treatment}
                  </Typography>
                </Box>
              )}

              <Divider sx={{ my: 2 }} />

              {/* Source payments */}
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  Source payments ({e.stripe_payment_count + e.synthetic_payment_count})
                </Typography>
                <InfoIcon info={
                  <>
                    <strong>Stripe payments</strong> ≥ $3,000 (the amortization threshold) and any{' '}
                    <strong>off-Stripe payments</strong> (mailed checks, wires, ACH) captured via{' '}
                    <code>synthetic_transactions.json</code>. The total of these should ≈ the dollars amortized into the MRR series above.
                  </>
                } />
              </Stack>

              <Accordion sx={{ '&:before': { display: 'none' }, boxShadow: 0, border: '1px solid', borderColor: 'divider' }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 1 } }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    Show {e.stripe_payment_count} Stripe + {e.synthetic_payment_count} off-Stripe payment(s)
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Date</TableCell>
                        <TableCell>Method</TableCell>
                        <TableCell align="right">Amount</TableCell>
                        <TableCell>Stripe ID / evidence</TableCell>
                        <TableCell>Description / reason</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {e.stripe_payments.map((p, i) => (
                        <TableRow key={`stripe-${i}`}>
                          <TableCell sx={{ fontSize: 12 }}>{fmtDate(p.created)}</TableCell>
                          <TableCell><Chip label="Stripe" size="small" sx={{ height: 18, fontSize: 10, bgcolor: '#635bff', color: '#fff' }} /></TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{USD2.format(p.amount)}</TableCell>
                          <TableCell sx={{ fontSize: 11, fontFamily: 'monospace', color: 'text.secondary' }}>{p.stripe_id ?? '—'}</TableCell>
                          <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{p.description}</TableCell>
                        </TableRow>
                      ))}
                      {e.synthetic_payments.map((p, i) => (
                        <TableRow key={`synth-${i}`}>
                          <TableCell sx={{ fontSize: 12 }}>{fmtDate(p.created)}</TableCell>
                          <TableCell><Chip label={p.payment_method ?? 'off-Stripe'} size="small" sx={{ height: 18, fontSize: 10, bgcolor: '#E67E22', color: '#fff' }} /></TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{USD2.format(p.amount)}</TableCell>
                          <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{p.evidence ?? <em>(none on file)</em>}</TableCell>
                          <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{p.reason}</TableCell>
                        </TableRow>
                      ))}
                      {e.stripe_payments.length === 0 && e.synthetic_payments.length === 0 && (
                        <TableRow><TableCell colSpan={5} sx={{ color: 'text.secondary', textAlign: 'center', py: 2 }}>No source payments recorded.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </AccordionDetails>
              </Accordion>

              {/* Overrides */}
              {e.override_count > 0 && (
                <>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2, mb: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                      Custom amortization windows ({e.override_count})
                    </Typography>
                    <InfoIcon info="Custom windows that override the default (12-month-forward) amortization for specific payments. Used when a payment covers a non-standard period (e.g., a 15-month or backdated coverage)." />
                  </Stack>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Origin month</TableCell>
                        <TableCell>Start month</TableCell>
                        <TableCell align="right">Months</TableCell>
                        <TableCell align="right">Amount range</TableCell>
                        <TableCell align="right">$/month</TableCell>
                        <TableCell>Reason</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {e.overrides.map((o, i) => (
                        <TableRow key={`ov-${i}`}>
                          <TableCell sx={{ fontSize: 12 }}>{o.origin_month}</TableCell>
                          <TableCell sx={{ fontSize: 12 }}>{o.start_month}</TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{o.months}</TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{USD0.format(o.amount_match_min)} – {USD0.format(o.amount_match_max)}</TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{USD2.format(o.monthly_amortized)}</TableCell>
                          <TableCell sx={{ fontSize: 11, color: 'text.secondary', maxWidth: 360 }}>{o.reason}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}

              {/* Realized amortization */}
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2, mb: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  Realized amortization on MRR series ({e.annualized_month_count} months)
                </Typography>
                <InfoIcon info="The actual monthly cells in customer_profiles.monthly_history flagged as annualized. These are the dollars flowing into the MRR series. Total should ≈ the source-payment total above." />
              </Stack>
              <Accordion sx={{ '&:before': { display: 'none' }, boxShadow: 0, border: '1px solid', borderColor: 'divider' }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 1 } }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    Show {e.annualized_month_count} monthly cells totaling {USD0.format(e.total_amortized_dollars)}
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ p: 0 }}>
                  <Box sx={{ maxHeight: 320, overflow: 'auto' }}>
                    <Table size="small" stickyHeader>
                      <TableHead>
                        <TableRow>
                          <TableCell>Month</TableCell>
                          <TableCell align="right">Amortized $</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {e.annualized_months.map((m) => (
                          <TableRow key={m.month}>
                            <TableCell sx={{ fontSize: 12 }}>{m.month}</TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{USD2.format(m.subscription)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                </AccordionDetails>
              </Accordion>

              {/* Contract / evidence files */}
              <Box sx={{ mt: 2, p: 1.5, bgcolor: 'rgba(0,0,0,0.02)', borderRadius: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, display: 'block', mb: 0.5 }}>
                  Contract & supporting evidence
                </Typography>
                <Typography variant="body2" sx={{ fontSize: 12 }}>
                  Contract: {e.contract_link ? (
                    <a href={e.contract_link} target="_blank" rel="noreferrer">{e.contract_link}</a>
                  ) : (
                    <em style={{ color: '#94a3b8' }}>(none uploaded yet — add to <code>annual_payers.json</code> → payer_details → contract_link)</em>
                  )}
                  {e.contract_signed_date && ` · signed ${fmtDate(e.contract_signed_date)}`}
                </Typography>
                {e.evidence_files.length > 0 && (
                  <Typography variant="body2" sx={{ fontSize: 12, mt: 0.5 }}>
                    Files: {e.evidence_files.join(', ')}
                  </Typography>
                )}
              </Box>
            </Paper>
          ))}
        </Stack>
      )}

      <Box sx={{ mt: 3, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Adding evidence for a new annual payer
        </Typography>
        <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>
          1. Add the customer's <code>allmoxy_customer_id</code> to <code>src/data/annual_payers.json → annual_payer_ids</code>.<br />
          2. Add a per-customer entry under <code>payer_details</code> in the same file with: <code>typical_annual_amount</code>, <code>typical_months</code>, <code>qb_treatment</code>, <code>contract_link</code>, <code>verified_by</code>, <code>verified_at</code>, and any <code>notes</code>.<br />
          3. If the payment covers a non-standard window, add an override to <code>_etl_scripts/annual_amortization_overrides.json</code>.<br />
          4. If they pay outside Stripe (check/wire/ACH), add a synthetic transaction to <code>_etl_scripts/synthetic_transactions.json</code>.<br />
          5. Re-run <code>node _etl_scripts/refresh_all.mjs</code>.
        </Typography>
      </Box>
    </Box>
  );
}
