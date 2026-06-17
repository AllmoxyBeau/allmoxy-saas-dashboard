import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import { Link as RouterLink } from 'react-router-dom';

import PageHeader from '../components/common/PageHeader';
import { useSheetTab } from '../hooks/useSheetTab';

type InvariantSummary = {
  total: number;
  passed: number;
  errors: number;
  warnings: number;
  status: 'green' | 'yellow' | 'red';
};
type AdjustmentsSummary = {
  totals?: {
    total: number;
    by_category: Record<string, number>;
    by_severity: Record<string, number>;
  };
};
type EbitdaBridge = {
  bridges?: {
    ytd_current?: { label?: string; net_income?: number; gaap_ebitda?: number; adjusted_ebitda?: number; gaap_ebitda_margin?: number | null; adjusted_ebitda_margin?: number | null };
  };
};
type AmortEvidence = {
  summary?: {
    annual_payer_count: number;
    total_amortized_dollars: number;
    payers_verified: number;
    payers_with_contract_link: number;
  };
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const SECTIONS: Array<{
  step: number;
  title: string;
  path: string;
  oneLiner: string;
}> = [
  {
    step: 1,
    title: 'Definitions',
    path: '/definitions',
    oneLiner: 'Canonical formula + source + window + sign-off for every metric. Read this FIRST.',
  },
  {
    step: 2,
    title: 'Invariant Tests',
    path: '/invariant-tests',
    oneLiner: 'Automated self-consistency checks. Green = no blockers. Red = hard QoE failure.',
  },
  {
    step: 3,
    title: 'Adjustments Register',
    path: '/adjustments-register',
    oneLiner: 'Every override made to raw source data, consolidated. The single most important QoE artifact.',
  },
  {
    step: 4,
    title: 'Annual Amortization Evidence',
    path: '/annual-amortization-evidence',
    oneLiner: 'Per annual-payer: source payment trace, realized amortization, QB treatment, sign-off.',
  },
  {
    step: 5,
    title: 'Adjusted EBITDA Bridge',
    path: '/ebitda-bridge',
    oneLiner: 'GAAP NI → standard add-backs → GAAP EBITDA → QoE adjustments → Adjusted EBITDA.',
  },
  {
    step: 6,
    title: 'Stripe ↔ QB Reconciliation',
    path: '/stripe-qb-reconciliation',
    oneLiner: 'Per-month tie-out of Stripe payments to QuickBooks revenue. Status tag on every month.',
  },
];

const PUNCH_LIST_HINTS = [
  'EBITDA add-backs are placeholders (owner-comp, one-time fees, discretionary perks)',
  'Annual-payer contracts not linked (B&B Door, Mid Michigan Wood)',
  'TTM EBITDA bridge inactive (P&L only 5 months YTD — needs 12+ months)',
  'Sub-segment backfill ~64% complete (49 active customers still untagged)',
  'Churn reason backfill ~25% complete (deep research in batch files)',
];

export default function BankerHandoff() {
  const { data: invariantData } = useSheetTab('invariant_test_results');
  const { data: adjData } = useSheetTab('adjustments_register');
  const { data: ebitdaData } = useSheetTab('ebitda_bridge');
  const { data: amortData } = useSheetTab('annual_amortization_evidence');

  const inv = invariantData as unknown as InvariantSummary | undefined;
  const adj = adjData as unknown as AdjustmentsSummary | undefined;
  const ebitda = (ebitdaData as unknown as EbitdaBridge | undefined)?.bridges?.ytd_current;
  const amort = (amortData as unknown as AmortEvidence | undefined)?.summary;

  const statusColor = useMemo(() => {
    if (!inv) return '#94a3b8';
    if (inv.status === 'red') return '#D63A4D';
    if (inv.status === 'yellow') return '#F5A623';
    return '#1A9E5C';
  }, [inv]);

  return (
    <Box>
      <PageHeader
        title="Banker Handoff Package"
        subtitle="The wrap-around document index. Everything an investment banker / buyer-side QoE reviewer needs to navigate the data room, with one-line summaries of each artifact and the current readiness status."
        question="durable"
      />

      <Alert severity={inv?.status === 'red' ? 'error' : inv?.status === 'yellow' ? 'warning' : 'success'} sx={{ mb: 3 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: statusColor, display: 'inline-block' }} />
          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              Data room status: {inv?.status?.toUpperCase() ?? 'UNKNOWN'}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block', mt: 0.25 }}>
              {inv ? `${inv.passed}/${inv.total} invariant tests pass · ${inv.errors} error(s) · ${inv.warnings} warning(s)` : 'Loading…'}
            </Typography>
          </Box>
        </Stack>
      </Alert>

      {/* Headline figures */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
              {ebitda?.label ?? 'YTD'} GAAP EBITDA
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 500 }}>{ebitda?.gaap_ebitda != null ? USD0.format(ebitda.gaap_ebitda) : '—'}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {ebitda?.gaap_ebitda_margin != null ? (ebitda.gaap_ebitda_margin * 100).toFixed(1) + '% margin' : '—'}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, bgcolor: 'rgba(44, 115, 255, 0.06)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
              {ebitda?.label ?? 'YTD'} Adjusted EBITDA
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 600, color: 'primary.main' }}>{ebitda?.adjusted_ebitda != null ? USD0.format(ebitda.adjusted_ebitda) : '—'}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {ebitda?.adjusted_ebitda_margin != null ? (ebitda.adjusted_ebitda_margin * 100).toFixed(1) + '% margin' : '—'} · placeholders pending sign-off
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
              Adjustments on register
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 500 }}>{adj?.totals?.total ?? '—'}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {adj?.totals?.by_severity?.monetary ?? 0} monetary · {adj?.totals?.by_severity?.hygiene ?? 0} hygiene
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
              Annual-payer evidence
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 500 }}>{amort?.annual_payer_count ?? '—'} payer(s)</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {amort != null ? USD0.format(amort.total_amortized_dollars) : '—'} amortized · {amort?.payers_verified ?? 0}/{amort?.annual_payer_count ?? 0} verified
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* Diligence stack */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>The diligence stack</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
          Read in this order. Each page answers a different diligence question; together they cover every QoE concern.
        </Typography>
        <Stack spacing={1.5}>
          {SECTIONS.map((s) => (
            <Paper key={s.path} variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={2} alignItems="center">
                <Chip
                  label={s.step}
                  size="small"
                  sx={{ height: 24, width: 24, fontSize: 11, fontWeight: 700, bgcolor: 'primary.main', color: '#fff' }}
                />
                <Box sx={{ flexGrow: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 14 }}>
                    <Link component={RouterLink} to={s.path} sx={{ color: 'primary.main' }}>{s.title}</Link>
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11.5 }}>{s.oneLiner}</Typography>
                </Box>
              </Stack>
            </Paper>
          ))}
        </Stack>
      </Paper>

      {/* Open punch list */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>Open punch list</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
          Items to resolve before final banker handoff. Each is surfaced live by the Invariant Tests page.
        </Typography>
        <Stack component="ol" sx={{ pl: 3, m: 0 }} spacing={0.75}>
          {PUNCH_LIST_HINTS.map((p, i) => (
            <Typography key={i} component="li" variant="body2" sx={{ fontSize: 13, lineHeight: 1.6 }}>{p}</Typography>
          ))}
        </Stack>
      </Paper>

      {/* Markdown docs */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 0.5 }}>Companion markdown documents</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
          Three files at the repo root cover everything not in the dashboard pages. Pair them with the dashboard for a complete data room package.
        </Typography>
        <Stack spacing={1.5}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 14, fontFamily: 'monospace' }}>DATA_ROOM_README.md</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11.5, display: 'block', mt: 0.25 }}>
              The first document a banker reads. Cover map of the package, adjustment philosophy, customer-count reconciliation, source data trace, and the punch list.
            </Typography>
          </Paper>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 14, fontFamily: 'monospace' }}>BANKER_METHODOLOGY.md</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11.5, display: 'block', mt: 0.25 }}>
              How the numbers are derived. Core principle, raw sources, adjustment pipeline, customer-state taxonomy, EBITDA bridge methodology, churn definition, reconciliation logic, invariant testing, scope limits.
            </Typography>
          </Paper>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: 14, fontFamily: 'monospace' }}>REFRESH_RUNBOOK.md</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11.5, display: 'block', mt: 0.25 }}>
              How to refresh the data room. Prerequisites, standard refresh, source-data updates, adding new adjustments, troubleshooting, verification checklist, common one-off scripts.
            </Typography>
          </Paper>
        </Stack>
      </Paper>

      <Divider sx={{ my: 3 }} />

      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', textAlign: 'center', fontSize: 11 }}>
        Allmoxy — Quality of Earnings dashboard. Sign-off: Beau Lewis (CEO/owner).
      </Typography>
    </Box>
  );
}
