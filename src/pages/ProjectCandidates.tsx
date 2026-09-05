import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

// Snapshot written by _etl_scripts/build_project_candidates.mjs.
type Row = {
  allmoxy_customer_id: number; name: string; status: string | null; pay_status: string | null;
  account_rep: string | null; current_mrr: number; arr: number;
  lifetime_subscription: number; lifetime_services: number; has_bought_services: boolean;
  sign_up_date: string | null; tenure_months: number | null;
  risk_tier: string | null; risk_score: number | null; is_launched: boolean | null;
  lifetime_orders: number | null; hubspot_company_id: string | null; note: string | null;
};
type Snap = {
  fetchedAt: string; updated_at: string | null;
  totals: { count: number; total_mrr: number; total_arr: number; already_bought_services: number; total_prior_services: number };
  customers: Row[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
function fmtDate(iso: string | null | undefined) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; }
const tierColor = (t: string | null) => (t === 'critical' ? '#E5484D' : t === 'high' ? '#F5A623' : t === 'medium' ? '#D9C441' : t === 'low' ? '#2EA043' : '#8B949E');

export default function ProjectCandidates() {
  const { data, isLoading, error } = useSheetTab('project_candidates');
  const snap = data as unknown as Snap | undefined;
  const rows = useMemo(() => snap?.customers ?? [], [snap]);
  const t = snap?.totals;

  return (
    <Box>
      <PageHeader
        title="Project Candidates"
        subtitle="Customers CS has flagged as good fits for a paid project or services engagement — the hand-off list for Sales. Flag a customer from the Company Profile section on their Customer Detail page."
        question="durable"
      />
      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load project_candidates — {String(error)}</Alert>}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Candidates" value={t ? String(t.count) : null} hint="Flagged by CS" color="primary.main" loading={isLoading} /></Grid>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Combined MRR" value={t ? USD0.format(t.total_mrr) : null} hint="Current subscription MRR" loading={isLoading} /></Grid>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Combined ARR" value={t ? USD0.format(t.total_arr) : null} hint="MRR × 12" loading={isLoading} /></Grid>
        <Grid item xs={12} sm={6} md={3}><Kpi label="Bought services before" value={t ? `${t.already_bought_services} of ${t.count}` : null} hint={t ? `${USD0.format(t.total_prior_services)} lifetime services` : ''} color="success.main" loading={isLoading} /></Grid>
      </Grid>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Hand-off list</Typography>
          <InfoIcon info={<><strong>What it is:</strong> Every customer flagged as a project candidate, largest first — the order Sales should work the list.<br /><br /><strong>How a customer gets here:</strong> open their Customer Detail page and switch on "Project candidate" in the Company Profile section. It's an opinion flag: it feeds no revenue, churn or scored metric.<br /><br /><strong>Reading it:</strong> <em>Bought services</em> shows who has already paid for services (warmest leads). <em>Risk</em> is their churn-risk tier — a critical-tier account may need a save conversation before a project pitch.<br /><br />Use Export CSV to hand the list off.</>} />
        </Stack>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 1.5 }}>
          {rows.length} candidate{rows.length === 1 ? '' : 's'}{snap?.updated_at ? ` · list updated ${fmtDate(snap.updated_at)}` : ''} · sorted by current MRR · CSV-exportable
        </Typography>

        {isLoading ? <Skeleton variant="rectangular" height={280} /> : rows.length === 0 ? (
          <Alert severity="info">
            No project candidates flagged yet. Open a customer on the <strong>Customer Detail</strong> page and switch on <strong>“Project candidate”</strong> in the Company Profile section — they'll appear here for the Sales hand-off.
          </Alert>
        ) : (
          <DrillDownPanel<Record<string, unknown>>
            title=""
            rows={rows as unknown as Array<Record<string, unknown>>}
            columns={[
              { key: 'name', label: 'Customer', render: (r: Record<string, unknown>) => { const d = r as unknown as Row; return <CustomerLink id={d.allmoxy_customer_id} name={d.name} />; }, exportValue: (r: Record<string, unknown>) => (r as unknown as Row).name, sortValue: (r: Record<string, unknown>) => (r as unknown as Row).name },
              { key: 'account_rep', label: 'Account rep', render: (r: Record<string, unknown>) => (r as unknown as Row).account_rep || '—' },
              { key: 'current_mrr', label: 'MRR', align: 'right', render: (r: Record<string, unknown>) => USD0.format((r as unknown as Row).current_mrr) },
              { key: 'arr', label: 'ARR', align: 'right', render: (r: Record<string, unknown>) => USD0.format((r as unknown as Row).arr) },
              { key: 'tenure_months', label: 'Tenure', align: 'right', render: (r: Record<string, unknown>) => { const m = (r as unknown as Row).tenure_months; return m == null ? '—' : m >= 12 ? `${(m / 12).toFixed(1)} yr` : `${m} mo`; }, sortValue: (r: Record<string, unknown>) => (r as unknown as Row).tenure_months ?? -1 },
              { key: 'has_bought_services', label: 'Bought services', render: (r: Record<string, unknown>) => { const d = r as unknown as Row; return d.has_bought_services ? <Chip size="small" label={USD0.format(d.lifetime_services)} sx={{ height: 20, fontSize: 11, bgcolor: 'rgba(46,160,67,0.14)', color: 'success.main', fontWeight: 600 }} /> : <span style={{ color: '#8B949E' }}>—</span>; }, exportValue: (r: Record<string, unknown>) => String((r as unknown as Row).lifetime_services), sortValue: (r: Record<string, unknown>) => (r as unknown as Row).lifetime_services },
              { key: 'lifetime_orders', label: 'Orders', align: 'right', render: (r: Record<string, unknown>) => { const v = (r as unknown as Row).lifetime_orders; return v == null ? '—' : v.toLocaleString(); }, sortValue: (r: Record<string, unknown>) => (r as unknown as Row).lifetime_orders ?? -1 },
              { key: 'risk_tier', label: 'Risk', render: (r: Record<string, unknown>) => { const d = r as unknown as Row; return d.risk_tier ? <Chip size="small" label={d.risk_tier} sx={{ height: 20, fontSize: 11, bgcolor: `${tierColor(d.risk_tier)}22`, color: tierColor(d.risk_tier), fontWeight: 600, textTransform: 'capitalize' }} /> : <span style={{ color: '#8B949E' }}>—</span>; }, exportValue: (r: Record<string, unknown>) => (r as unknown as Row).risk_tier ?? '' },
              { key: 'note', label: 'Why', render: (r: Record<string, unknown>) => { const n = (r as unknown as Row).note; return n ? <span>{n}</span> : <span style={{ color: '#8B949E' }}>—</span>; } },
            ]}
            filename="project_candidates"
          />
        )}
      </Paper>
    </Box>
  );
}

function Kpi({ label, value, hint, color = 'text.primary', loading }: { label: string; value: string | null; hint: string; color?: string; loading?: boolean }) {
  return (
    <Paper sx={{ p: 2, height: '100%' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>{label}</Typography>
      {loading || value == null ? <Skeleton variant="text" width="60%" sx={{ fontSize: 24 }} /> : <Typography variant="h6" sx={{ fontWeight: 600, color, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25, fontSize: 10 }}>{hint}</Typography>
    </Paper>
  );
}
