import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';

type PlanRow = {
  month: string; opening_mrr: number; target_closing_mrr: number; target_closing_arr: number;
  net_required: number; expected_losses: number; gross_required: number; new_logos_required: number | null;
  actual_closing_mrr: number | null; actual_gross: number | null; actual_losses: number | null; variance: number | null;
};
type Stream = { key: string; label: string; basis: string; ttm: number; monthly: number; share: number | null };
type Snap = {
  streams: Stream[];
  total_revenue: { ttm: number; monthly: number; target_annual: number; gap: number; note: string };
  connect_opportunity: {
    processing_now: number; active_customers: number; attach_rate: number; not_processing: number;
    fee_potential_annual: number; current_fees_annual: number; basis: string | null;
    covers_pct_of_subscription_gap: number; covers_pct_of_total_gap: number;
  } | null;
  config: { target_annual_growth: number; plan_months: number; churn_improvement: number; editable_at: string };
  baseline: { as_of: string; mrr: number; arr: number; customers: number; arpa: number };
  target: { annual_growth: number; monthly_growth: number; target_arr: number; target_mrr: number; arr_gap: number; end_month: string | null };
  trailing: { gains: number; losses: number; net: number; monthly_gain_rate: number; monthly_loss_rate: number; grr: number | null; nrr: number | null; new_logos_per_month: number | null };
  effort: { run_rate_gross_per_month: number; required_gross_per_month: number; multiple: number | null; net_today_per_month: number };
  plan: PlanRow[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

export default function SalesBudget() {
  const { data, isLoading, error } = useSheetTab('sales_budget');
  const snap = data as unknown as Snap | undefined;
  const [unit, setUnit] = useState<'mrr' | 'arr'>('arr');

  const chart = useMemo(() => (snap?.plan ?? []).map((p) => ({
    month: monthLabel(p.month),
    target: unit === 'arr' ? p.target_closing_arr : p.target_closing_mrr,
    actual: p.actual_closing_mrr == null ? null : (unit === 'arr' ? p.actual_closing_mrr * 12 : p.actual_closing_mrr),
  })), [snap, unit]);

  if (error) {
    return (
      <Box>
        <PageHeader title="Sales Budget" subtitle="Forward growth plan" />
        <Alert severity="error">Failed to load sales_budget — {String(error)}</Alert>
      </Box>
    );
  }

  const b = snap?.baseline; const tg = snap?.target; const tr = snap?.trailing; const ef = snap?.effort;

  return (
    <Box>
      <PageHeader
        title="Sales Budget"
        subtitle="What the growth target requires each month — measured as gross new business, because the book has to be replaced before it can be grown."
        question="durable"
      />

      <Grid container spacing={2} sx={{ mb: 3 }}>
        {[
          { label: 'Current ARR', value: b ? USD0.format(b.arr) : '—', hint: `${b?.customers ?? '—'} customers · ${b ? USD0.format(b.arpa) : '—'} ARPA` },
          { label: `Target ARR (+${Math.round((tg?.annual_growth ?? 0) * 100)}%)`, value: tg ? USD0.format(tg.target_arr) : '—', hint: `by ${tg?.end_month ? monthLabel(tg.end_month) : '—'}`, color: 'primary.main' },
          { label: 'ARR to add', value: tg ? USD0.format(tg.arr_gap) : '—', hint: `${pct1(tg?.monthly_growth)} compounding per month` },
          { label: 'Gross new needed', value: ef ? `${USD0.format(ef.required_gross_per_month)}/mo` : '—', hint: `vs ${ef ? USD0.format(ef.run_rate_gross_per_month) : '—'} today`, color: 'warning.main' },
          { label: 'That is', value: ef?.multiple != null ? `${ef.multiple}× today` : '—', hint: `${snap?.plan[0]?.new_logos_required ?? '—'} new logos/mo if all from new`, color: 'error.main' },
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

      {snap && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <strong>This is a reversal, not an extrapolation.</strong>{' '}
          Over the last twelve months the book added {USD0.format(tr!.gains)} and lost {USD0.format(tr!.losses)} — a net of {USD0.format(tr!.net)}, so it is slightly shrinking.
          Hitting +{Math.round(tg!.annual_growth * 100)}% means replacing those losses <em>and</em> adding {USD0.format(tg!.arr_gap / 12)} of MRR on top, which is why the gross requirement is {ef!.multiple}× the current run rate rather than 1.2×.
          Retention is the cheapest lever here: every point of churn avoided is a point sales does not have to sell twice.
        </Alert>
      )}

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Plan vs actual</Typography>
          <InfoIcon info={<><strong>Target line</strong> compounds {pct1(tg?.monthly_growth)} a month, which lands exactly on +{Math.round((tg?.annual_growth ?? 0) * 100)}% after {snap?.config.plan_months} months.<br /><br /><strong>Actual</strong> appears only for months the accrual waterfall has closed — a partial month would read as a miss it has not had time to be.<br /><br />Baseline is the canonical customer base at {snap?.baseline.as_of}: {snap?.baseline.customers} customers, invoiced basis.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <ToggleButtonGroup size="small" exclusive value={unit} onChange={(_, v) => v && setUnit(v)} sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}>
            <ToggleButton value="arr">ARR</ToggleButton>
            <ToggleButton value="mrr">MRR</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={280} /> : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={chart} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} domain={['dataMin - 50000', 'dataMax + 50000']} />
              <RTooltip
                contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, fontSize: 12 }}
                formatter={(v: number, n: string) => [USD0.format(v), n === 'target' ? 'Target' : 'Actual']}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="target" stroke="#2C73FF" fill="rgba(44,115,255,0.12)" strokeWidth={2} name="target" />
              <Line type="monotone" dataKey="actual" stroke="#1A9E5C" strokeWidth={2} dot={{ r: 3 }} name="actual" connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </Paper>

      {snap?.connect_opportunity && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>Connect attach is the largest single lever, and it is sold to customers you already have.</strong>{' '}
          Only {snap.connect_opportunity.processing_now} of {snap.connect_opportunity.active_customers} active customers process payments through Allmoxy ({(snap.connect_opportunity.attach_rate * 100).toFixed(0)}%).
          Attaching the other {snap.connect_opportunity.not_processing} is worth about {USD0.format(snap.connect_opportunity.fee_potential_annual)} a year —
          <strong> {(snap.connect_opportunity.covers_pct_of_subscription_gap * 100).toFixed(0)}% of the subscription growth gap</strong>, at roughly 99.6% gross margin, without winning a single new logo.
          Six new logos a month is one route to the target; this is another, and it starts from a warm list.
        </Alert>
      )}

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>The whole revenue base</Typography>
          <InfoIcon info={<>The monthly plan above is priced on <strong>subscription only</strong>, which is the recurring line and the one MRR discipline applies to. It is 78% of the business.<br /><br />Connect fees and services are the other 22% and are shown here so the target is set against what the company actually earns.<br /><br /><strong>Bases are not fused.</strong> Subscription is the invoiced (accrual) basis; Connect and services are cash. Adding them gives a useful revenue figure but not a single-basis one, which is why they are listed separately.</>} />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Stream</TableCell>
              <TableCell align="right">TTM</TableCell>
              <TableCell align="right">Per month</TableCell>
              <TableCell align="right">Share</TableCell>
              <TableCell>Basis</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(snap?.streams ?? []).map((st) => (
              <TableRow key={st.key} hover>
                <TableCell sx={{ fontWeight: 500 }}>{st.label}</TableCell>
                <TableCell align="right">{USD0.format(st.ttm)}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{USD0.format(st.monthly)}</TableCell>
                <TableCell align="right">{st.share != null ? `${(st.share * 100).toFixed(1)}%` : '—'}</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontSize: 11 }}>{st.basis}</TableCell>
              </TableRow>
            ))}
            {snap && (
              <TableRow>
                <TableCell sx={{ fontWeight: 600 }}>Total revenue</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600 }}>{USD0.format(snap.total_revenue.ttm)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600, color: 'text.secondary' }}>{USD0.format(snap.total_revenue.monthly)}</TableCell>
                <TableCell align="right">100%</TableCell>
                <TableCell sx={{ color: 'text.secondary', fontSize: 11 }}>mixed</TableCell>
              </TableRow>
            )}
            {snap && (
              <TableRow>
                <TableCell sx={{ color: 'primary.main', fontWeight: 600 }}>Target at +{Math.round(snap.config.target_annual_growth * 100)}%</TableCell>
                <TableCell align="right" sx={{ color: 'primary.main', fontWeight: 600 }}>{USD0.format(snap.total_revenue.target_annual)}</TableCell>
                <TableCell align="right" colSpan={3} sx={{ color: 'text.secondary', fontSize: 11 }}>
                  gap of {USD0.format(snap.total_revenue.gap)} across all streams
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Paper>

      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, height: '100%' }}>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
              <Typography variant="h6" sx={{ fontWeight: 500 }}>The three levers</Typography>
              <InfoIcon info="Each lever closes the same gap, and they are different teams' work. The figures show what today's run rate delivers against what the plan needs." />
            </Stack>
            <Table size="small">
              <TableBody>
                {snap && ([
                  ['Win more', `${snap.plan[0]?.new_logos_required ?? '—'} new logos/mo`, `${tr!.new_logos_per_month ?? '—'}/mo today`, 'error.main'],
                  ['Expand more', `${USD0.format(ef!.required_gross_per_month)}/mo gross`, `${USD0.format(ef!.run_rate_gross_per_month)}/mo today`, 'warning.main'],
                  ['Lose less', `${pct1(tr!.monthly_loss_rate)}/mo leaking`, `GRR ${pct1(tr!.grr)} · NRR ${pct1(tr!.nrr)}`, 'info.main'],
                  ['Attach payments', snap.connect_opportunity ? `${USD0.format(snap.connect_opportunity.fee_potential_annual)}/yr available` : '—', snap.connect_opportunity ? `${snap.connect_opportunity.not_processing} customers not processing` : '—', 'success.main'],
                ] as Array<[string, string, string, string]>).map(([lever, need, now, tone]) => (
                  <TableRow key={lever}>
                    <TableCell sx={{ borderBottom: 'none', py: 0.75, fontWeight: 500 }}>{lever}</TableCell>
                    <TableCell align="right" sx={{ borderBottom: 'none', py: 0.75, color: tone, fontWeight: 500 }}>{need}</TableCell>
                    <TableCell align="right" sx={{ borderBottom: 'none', py: 0.75, color: 'text.secondary', fontSize: 11 }}>{now}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {snap && (
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5 }}>
                Target is set in <code>{snap.config.editable_at}</code>. Set <code>churn_improvement</code> there to model the plan with better retention — at 0.25 the gross requirement falls by a quarter of the loss line.
              </Typography>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 3, height: '100%' }}>
            <Typography variant="h6" sx={{ fontWeight: 500, mb: 1.5 }}>Trailing twelve months</Typography>
            <Table size="small">
              <TableBody>
                {snap && ([
                  ['Added (new + expansion)', USD0.format(tr!.gains), 'success.main'],
                  ['Lost (churn, contraction, delinquency, voids)', USD0.format(tr!.losses), 'error.main'],
                  ['Net', USD0.format(tr!.net), tr!.net >= 0 ? 'success.main' : 'error.main'],
                ] as Array<[string, string, string]>).map(([k, v, tone]) => (
                  <TableRow key={k}>
                    <TableCell sx={{ borderBottom: 'none', py: 0.75 }}>{k}</TableCell>
                    <TableCell align="right" sx={{ borderBottom: 'none', py: 0.75, color: tone, fontWeight: 500 }}>{v}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>Monthly budget</Typography>
          <InfoIcon info={<><strong>Gross required</strong> is the number to manage. It is the net growth step plus the MRR the book is expected to lose that month, because losses have to be replaced before anything counts as growth.<br /><br /><strong>New logos required</strong> assumes every dollar comes from new customers at current ARPA. Expansion reduces it one for one.</>} />
          <Box sx={{ flexGrow: 1 }} />
          <CsvExportButton
            filename="sales_budget.csv"
            rows={snap?.plan ?? []}
            columns={[
              { key: 'month', label: 'Month' }, { key: 'opening_mrr', label: 'Opening MRR' },
              { key: 'target_closing_mrr', label: 'Target closing MRR' }, { key: 'target_closing_arr', label: 'Target ARR' },
              { key: 'net_required', label: 'Net required' }, { key: 'expected_losses', label: 'Expected losses' },
              { key: 'gross_required', label: 'Gross required' }, { key: 'new_logos_required', label: 'New logos required' },
              { key: 'actual_closing_mrr', label: 'Actual closing MRR' }, { key: 'variance', label: 'Variance' },
            ]}
          />
        </Stack>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Month</TableCell>
              <TableCell align="right">Opening</TableCell>
              <TableCell align="right">Target close</TableCell>
              <TableCell align="right">Net needed</TableCell>
              <TableCell align="right">Expected losses</TableCell>
              <TableCell align="right">Gross needed</TableCell>
              <TableCell align="right">Logos</TableCell>
              <TableCell align="right">Actual</TableCell>
              <TableCell align="right">Variance</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(snap?.plan ?? []).map((p) => (
              <TableRow key={p.month} hover>
                <TableCell sx={{ fontWeight: 500 }}>{monthLabel(p.month)}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{USD0.format(p.opening_mrr)}</TableCell>
                <TableCell align="right">{USD0.format(p.target_closing_mrr)}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary' }}>{USD0.format(p.net_required)}</TableCell>
                <TableCell align="right" sx={{ color: 'error.main' }}>{USD0.format(p.expected_losses)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 600, color: 'warning.main' }}>{USD0.format(p.gross_required)}</TableCell>
                <TableCell align="right">{p.new_logos_required ?? '—'}</TableCell>
                <TableCell align="right">{p.actual_closing_mrr != null ? USD0.format(p.actual_closing_mrr) : <Chip size="small" label="ahead" sx={{ height: 16, fontSize: 9 }} />}</TableCell>
                <TableCell align="right" sx={{ color: p.variance == null ? 'text.disabled' : p.variance >= 0 ? 'success.main' : 'error.main', fontWeight: 500 }}>
                  {p.variance == null ? '—' : `${p.variance >= 0 ? '+' : ''}${USD0.format(p.variance)}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
}
