import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import PageHeader from '../components/common/PageHeader';
import CsvExportButton from '../components/common/CsvExportButton';
import type { CsvColumn } from '../lib/csvExport';
import { useSheetTab } from '../hooks/useSheetTab';

type InferenceCustomer = {
  allmoxy_customer_id: number;
  name: string;
  // Many entries (~33) have no linked HubSpot record and ~31 lack a tenure value, so these
  // fields are nullable. The page must guard `.toFixed`, `<Link>`, etc.
  hubspot_company_id: string | null;
  lifetime_subscription: number;
  years_with_us: number | null;
  current_status: string;
  suggested_reason: string;
  confidence: 'high' | 'medium' | 'low';
  evidence_quote: string;
  evidence_date: string | null;
  signals: string[];
  hubspot_url: string | null;
  recommended_action: string;
};

type InferencesSnapshot = {
  fetchedAt: string;
  generatedBy: string;
  customer_count: number;
  notes: string;
  customers: InferenceCustomer[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function confidenceColor(c: InferenceCustomer['confidence']): string {
  switch (c) {
    case 'high':   return 'success.main';
    case 'medium': return 'warning.main';
    case 'low':    return 'text.secondary';
  }
}

function statusChipColor(status: string): { bg: string; fg: string } {
  if (status === 'false_positive_annual_payer') return { bg: 'rgba(44, 115, 255, 0.18)', fg: '#7AB0FF' };
  if (status === 'at_risk_active_recovery')     return { bg: 'rgba(229, 137, 78, 0.25)',  fg: '#E5894E' };
  if (status === 'paused_escalated')            return { bg: 'rgba(229, 137, 78, 0.25)',  fg: '#E5894E' };
  if (status === 'insufficient_data')           return { bg: 'rgba(139, 148, 158, 0.20)', fg: '#8B949E' };
  return { bg: 'rgba(218, 54, 51, 0.22)', fg: '#FF7B78' };
}

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

export default function ChurnInvestigator() {
  const { data, isLoading, error } = useSheetTab('churn_inferences');
  const snap = data as unknown as InferencesSnapshot | undefined;

  const [filter, setFilter] = useState<'all' | 'classified' | 'false_positive' | 'needs_review'>('all');

  const customers = snap?.customers ?? [];
  const filtered = useMemo(() => {
    if (filter === 'all') return customers;
    if (filter === 'classified') return customers.filter((c) => c.confidence === 'high' || c.confidence === 'medium');
    if (filter === 'false_positive') return customers.filter((c) => c.current_status === 'false_positive_annual_payer');
    return customers.filter((c) => c.current_status === 'insufficient_data');
  }, [customers, filter]);

  // Stats roll-up
  const stats = useMemo(() => {
    let classifiedDollars = 0;
    let falsePositiveDollars = 0;
    let needsReviewDollars = 0;
    let totalDollars = 0;
    for (const c of customers) {
      totalDollars += c.lifetime_subscription;
      if (c.current_status === 'false_positive_annual_payer') falsePositiveDollars += c.lifetime_subscription;
      else if (c.current_status === 'insufficient_data') needsReviewDollars += c.lifetime_subscription;
      else classifiedDollars += c.lifetime_subscription;
    }
    return { classifiedDollars, falsePositiveDollars, needsReviewDollars, totalDollars };
  }, [customers]);

  // CSV columns for bulk HubSpot import
  const csvColumns: CsvColumn<InferenceCustomer>[] = [
    { key: 'name', label: 'Company name' },
    { key: 'hubspot_company_id', label: 'HubSpot Company ID' },
    { key: 'lifetime_subscription', label: 'Lifetime Subscription $' },
    { key: 'suggested_reason', label: 'Suggested Churn Reason' },
    { key: 'confidence', label: 'Confidence' },
    { key: 'current_status', label: 'Status' },
    { key: 'evidence_date', label: 'Evidence Date' },
    { key: 'evidence_quote', label: 'Evidence Quote' },
    { key: 'recommended_action', label: 'Recommended Action' },
    { key: 'hubspot_url', label: 'HubSpot Link' },
  ];

  return (
    <Box>
      <PageHeader
        title="Churn Investigator"
        subtitle="LLM-assisted classification of uncategorized churn accounts. Notes pulled from HubSpot, reasons inferred from CSM-recorded evidence, exportable as CSV for bulk Churn Playbook backfill."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load churn_inferences: {String(error)}</Alert>}

      {snap && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>{customers.length} customers</strong> classified from CSM notes (HubSpot + former-CS-rep xlsx). Combined lifetime $ at stake: {USD0.format(stats.totalDollars)}. Use the toggle below to filter by classification state, or export to CSV for HubSpot Churn Playbook backfill.
        </Alert>
      )}

      {/* Headline cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Customers investigated</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500 }}>{customers.length}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(stats.totalDollars)} lifetime $</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Classified with evidence</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'success.main' }}>{customers.filter((c) => c.confidence === 'high' || c.confidence === 'medium').length}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(stats.classifiedDollars)} attributable to a reason</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>False-positive churns</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'info.main' }}>{customers.filter((c) => c.current_status === 'false_positive_annual_payer').length}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(stats.falsePositiveDollars)} — annual payers, not churned</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Needs human review</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'warning.main' }}>{customers.filter((c) => c.current_status === 'insufficient_data').length}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(stats.needsReviewDollars)} — no/sparse HubSpot notes</Typography>
              </>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Process finding banner */}
      {customers.filter((c) => c.current_status === 'insufficient_data').length >= 3 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <strong>Process finding:</strong> {customers.filter((c) => c.current_status === 'insufficient_data').length} of the top 15 churns have zero or near-zero HubSpot notes (combined {USD0.format(stats.needsReviewDollars)} lifetime $). Long-tenure / high-$ accounts with no CSM documentation is itself a diligence risk — buyers will ask "where's the customer history?"
        </Alert>
      )}

      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="all">All ({customers.length})</ToggleButton>
          <ToggleButton value="classified">Classified ({customers.filter((c) => c.confidence === 'high' || c.confidence === 'medium').length})</ToggleButton>
          <ToggleButton value="false_positive">False positives ({customers.filter((c) => c.current_status === 'false_positive_annual_payer').length})</ToggleButton>
          <ToggleButton value="needs_review">Needs review ({customers.filter((c) => c.current_status === 'insufficient_data').length})</ToggleButton>
        </ToggleButtonGroup>
        <CsvExportButton
          filename="churn_inferences_for_hubspot_backfill"
          columns={csvColumns}
          rows={filtered}
          label="Export CSV for HubSpot backfill"
        />
      </Stack>

      <Stack spacing={2}>
        {isLoading && [1, 2, 3].map((i) => <Skeleton key={i} variant="rectangular" height={140} />)}
        {filtered.map((c) => {
          const statusStyle = statusChipColor(c.current_status);
          return (
            <Paper key={c.allmoxy_customer_id} sx={{ p: 2.5, borderLeft: '3px solid', borderLeftColor: confidenceColor(c.confidence) }}>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{c.name}</Typography>
                    <Chip
                      label={statusLabel(c.current_status)}
                      size="small"
                      sx={{ height: 20, fontSize: 10, bgcolor: statusStyle.bg, color: statusStyle.fg, fontWeight: 500 }}
                    />
                  </Stack>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                    {USD0.format(c.lifetime_subscription)} · {c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y tenure` : 'tenure n/a'} · aid {c.allmoxy_customer_id}
                  </Typography>
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>SUGGESTED REASON · {c.confidence.toUpperCase()} CONFIDENCE</Typography>
                    <Typography variant="body2" sx={{ color: confidenceColor(c.confidence), fontWeight: 600, mt: 0.25 }}>{c.suggested_reason}</Typography>
                  </Box>
                  {c.hubspot_url ? (
                    <Link href={c.hubspot_url} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 11, display: 'inline-block', mt: 1 }}>
                      Open in HubSpot →
                    </Link>
                  ) : (
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11, display: 'inline-block', mt: 1, fontStyle: 'italic' }}>
                      No HubSpot record linked
                    </Typography>
                  )}
                </Grid>
                <Grid item xs={12} md={5}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>EVIDENCE {c.evidence_date && `· ${c.evidence_date}`}</Typography>
                  <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary', mt: 0.5, fontSize: 13, lineHeight: 1.5, borderLeft: '2px solid rgba(139,148,158,0.3)', pl: 1.5 }}>
                    "{c.evidence_quote}"
                  </Typography>
                  {c.signals.length > 0 && (
                    <Box sx={{ mt: 1.5 }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>SIGNALS</Typography>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
                        {c.signals.map((s, i) => (
                          <Chip key={i} label={s} size="small" sx={{ height: 18, fontSize: 10, mb: 0.5 }} variant="outlined" />
                        ))}
                      </Stack>
                    </Box>
                  )}
                </Grid>
                <Grid item xs={12} md={3}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>RECOMMENDED ACTION</Typography>
                  <Typography variant="body2" sx={{ fontSize: 13, lineHeight: 1.5, mt: 0.5 }}>{c.recommended_action}</Typography>
                </Grid>
              </Grid>
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}
