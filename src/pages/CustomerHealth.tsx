import { useState } from 'react';
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
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import { useSheetTab } from '../hooks/useSheetTab';

type ConcentrationSlice = { n: number; customers: number; mrr: number; pct: number | null };
type DistributionBucket = { bucket: string; customers: number; mrr: number; customers_list?: TopCustomer[] };
type TopCustomer = {
  name: string;
  allmoxy_customer_id: number | null;
  current_mrr: number;
  lifetime_revenue: number;
  years_with_us: number | null;
  failed_3mo: number;
};
type DunningCustomer = {
  name: string;
  allmoxy_customer_id: number | null;
  current_mrr: number;
  failed_3mo: number;
  failed_3mo_amount: number;
};

type CustomerHealthSnapshot = {
  latestMonth: string;
  concentration: {
    total_active_customers: number;
    total_mrr: number;
    top1: ConcentrationSlice;
    top5: ConcentrationSlice;
    top10: ConcentrationSlice;
    top20: ConcentrationSlice;
  };
  distribution: DistributionBucket[];
  top_customers: TopCustomer[];
  all_active_customers?: TopCustomer[];
  dunning_customers: DunningCustomer[];
  dunning_summary: {
    total_dunning_customers: number;
    total_at_risk_amount: number;
  };
  notes: string;
};

type DrillKind =
  | { kind: 'concentration'; n: number; label: string }
  | { kind: 'bucket'; bucket: string }
  | { kind: 'dunning' };

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function pct(v: number | null, digits = 1) {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}
function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function concentrationColor(pctValue: number | null, thresholds: { good: number; caution: number }) {
  if (pctValue == null) return 'text.primary';
  if (pctValue <= thresholds.good) return 'success.main';
  if (pctValue <= thresholds.caution) return 'warning.main';
  return 'error.main';
}

export default function CustomerHealth() {
  const { data, isLoading, error } = useSheetTab('customer_health');
  const snap = data as unknown as CustomerHealthSnapshot | undefined;

  const [drill, setDrill] = useState<DrillKind | null>(null);
  function openDrill(d: DrillKind) {
    setDrill(d);
    setTimeout(() => {
      document.getElementById('drill-down-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  return (
    <Box>
      <PageHeader
        title="Customer Health"
        subtitle="Who drives our MRR, how our customer base is distributed, and who's at risk this week — the CS and account-management dashboard."
        question="healthy"
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load customer_health — {String(error)}
        </Alert>
      )}

      {snap && (
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
          Reference month: {monthLabel(snap.latestMonth)} · {snap.concentration.total_active_customers} active customers · {USD0.format(snap.concentration.total_mrr)} subscription MRR
        </Typography>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <ConcentrationCard
            label="Top 1 customer"
            slice={snap?.concentration.top1 ?? null}
            thresholds={{ good: 0.05, caution: 0.10 }}
            loading={isLoading}
            subtext={snap?.top_customers[0]?.name}
            onClick={() => openDrill({ kind: 'concentration', n: 1, label: 'Top 1 customer' })}
            info={<><strong>What it is:</strong> % of total subscription MRR contributed by the single largest customer — the "single-point-of-failure" number.<br /><br /><strong>Data:</strong> Largest customer's current MRR ÷ total subscription MRR for the reference month.<br /><br /><strong>Target:</strong> ≤ 5% low risk · ≤ 10% caution · &gt; 10% high-concentration risk.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <ConcentrationCard
            label="Top 5"
            slice={snap?.concentration.top5 ?? null}
            thresholds={{ good: 0.15, caution: 0.30 }}
            loading={isLoading}
            subtext="Target ≤ 15%"
            onClick={() => openDrill({ kind: 'concentration', n: 5, label: 'Top 5 customers' })}
            info={<><strong>What it is:</strong> % of total subscription MRR from the five largest customers.<br /><br /><strong>Data:</strong> Sum of top-5 customer MRR ÷ total subscription MRR for the reference month.<br /><br /><strong>Target:</strong> ≤ 15% low · ≤ 30% caution.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <ConcentrationCard
            label="Top 10"
            slice={snap?.concentration.top10 ?? null}
            thresholds={{ good: 0.25, caution: 0.40 }}
            loading={isLoading}
            subtext="Target ≤ 25%"
            onClick={() => openDrill({ kind: 'concentration', n: 10, label: 'Top 10 customers' })}
            info={<><strong>What it is:</strong> The classic concentration benchmark — what % of MRR is tied up in your top 10 customers. A key risk metric; if the top 10 represent most of your revenue, the business is fragile to any single churn.<br /><br /><strong>Data:</strong> Sum of top-10 customer MRR ÷ total subscription MRR.<br /><br /><strong>Target:</strong> ≤ 25% low (excellent) · 25–40% caution · &gt; 40% high risk.</>}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <ConcentrationCard
            label="Top 20"
            slice={snap?.concentration.top20 ?? null}
            thresholds={{ good: 0.40, caution: 0.55 }}
            loading={isLoading}
            subtext="Target ≤ 40%"
            onClick={() => openDrill({ kind: 'concentration', n: 20, label: 'Top 20 customers' })}
            info={<><strong>What it is:</strong> Broader concentration check — how much of the business is driven by the top 20 customers.<br /><br /><strong>Data:</strong> Sum of top-20 customer MRR ÷ total subscription MRR.<br /><br /><strong>Target:</strong> ≤ 40% healthy for mid-market SaaS.</>}
          />
        </Grid>
      </Grid>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Customer MRR distribution · {snap?.concentration.total_active_customers} active customers
          </Typography>
          <InfoIcon info={<><strong>What it is:</strong> Customer count (blue bars, left axis) and total MRR (green bars, right axis) by subscription price band.<br /><br /><strong>Data:</strong> Each active customer slotted into their MRR bucket for the reference month; MRR summed per bucket.<br /><br /><strong>Click any bar</strong> to drill into the customers in that bucket.</>} />
        </Stack>
        {isLoading || !snap ? (
          <Skeleton variant="rectangular" height={260} />
        ) : (
          <Box sx={{ height: 260 }}>
            <ResponsiveContainer>
              <BarChart data={snap.distribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="bucket" stroke="#8B949E" fontSize={11} />
                <YAxis yAxisId="left" stroke="#8B949E" fontSize={11} width={40} />
                <YAxis yAxisId="right" orientation="right" stroke="#8B949E" fontSize={11} width={55} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                <RTooltip
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6 }}
                  formatter={(v: number, name: string) => {
                    if (name === 'mrr') return [USD0.format(v), 'MRR'];
                    return [v, 'Customers'];
                  }}
                />
                <Bar yAxisId="left" dataKey="customers" fill="#2C73FF" name="customers" cursor="pointer" onClick={(p: { payload?: { bucket: string } }) => p.payload && openDrill({ kind: 'bucket', bucket: p.payload.bucket })} />
                <Bar yAxisId="right" dataKey="mrr" fill="rgba(26, 158, 92, 0.7)" name="mrr" cursor="pointer" onClick={(p: { payload?: { bucket: string } }) => p.payload && openDrill({ kind: 'bucket', bucket: p.payload.bucket })} />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        )}
        <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
          <LegendSwatch color="#2C73FF" label="Customer count (left axis)" />
          <LegendSwatch color="rgba(26, 158, 92, 0.7)" label="Total MRR in bucket (right axis)" />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
            Click a bucket to see its customers.
          </Typography>
        </Stack>
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Top 25 customers by current MRR
          </Typography>
          <InfoIcon info={<><strong>What it is:</strong> Ranked roster of the 25 biggest subscription customers for the reference month, with current MRR, % of total MRR, lifetime revenue, tenure, and a flag column for dunning.<br /><br /><strong>Data:</strong> Current MRR from the MRR by Month tab · lifetime revenue from Stripe Sync succeeded charges · years since first payment · failed-charge count from Stripe Sync in the last 3 months.</>} />
        </Stack>
        {isLoading || !snap ? (
          <Skeleton variant="rectangular" height={400} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell>Customer</TableCell>
                <TableCell align="right">Current MRR</TableCell>
                <TableCell align="right">% of MRR</TableCell>
                <TableCell align="right">Lifetime revenue</TableCell>
                <TableCell align="right">Years</TableCell>
                <TableCell align="center">Flags</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {snap.top_customers.map((c, idx) => (
                <TableRow key={c.allmoxy_customer_id ?? idx}>
                  <TableCell sx={{ color: 'text.secondary' }}>{idx + 1}</TableCell>
                  <TableCell sx={{ fontWeight: 500 }}>{c.name}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 500 }}>
                    {USD0.format(c.current_mrr)}
                  </TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>
                    {((c.current_mrr / snap.concentration.total_mrr) * 100).toFixed(2)}%
                  </TableCell>
                  <TableCell align="right">{USD0.format(c.lifetime_revenue)}</TableCell>
                  <TableCell align="right">{c.years_with_us != null ? c.years_with_us.toFixed(1) : '—'}</TableCell>
                  <TableCell align="center">
                    {c.failed_3mo > 0 ? (
                      <Chip label={`${c.failed_3mo} failed`} size="small" sx={{ bgcolor: 'rgba(218, 54, 51, 0.2)', color: 'error.main', fontSize: 10 }} />
                    ) : (
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>OK</Typography>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Dunning watch list · failed charges in trailing 3 months
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> Customers whose Stripe charges have failed in the last 3 months — the "intervene before they churn" list.<br /><br /><strong>Data:</strong> Aggregated from Stripe Sync (status='failed', created date within trailing 3 months). The "Failed attempts" chip turns red at 3+ attempts — usually a sign of a dead card that needs CS outreach.</>} />
            {snap && snap.dunning_customers.length > 0 && (
              <Typography
                variant="caption"
                sx={{ color: 'primary.main', cursor: 'pointer', textDecoration: 'underline', fontStyle: 'italic' }}
                onClick={() => openDrill({ kind: 'dunning' })}
              >
                view all · export
              </Typography>
            )}
          </Stack>
          {snap && (
            <Typography variant="caption" sx={{ color: 'error.main', fontWeight: 500 }}>
              {snap.dunning_summary.total_dunning_customers} customers · {USD0.format(snap.dunning_summary.total_at_risk_amount)} at risk
            </Typography>
          )}
        </Stack>
        {isLoading || !snap ? (
          <Skeleton variant="rectangular" height={320} />
        ) : snap.dunning_customers.length === 0 ? (
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No customers with failed charges in the last 3 months.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Customer</TableCell>
                <TableCell align="right">Current MRR</TableCell>
                <TableCell align="right">Failed attempts</TableCell>
                <TableCell align="right">Total $ failed</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {snap.dunning_customers.map((d, idx) => (
                <TableRow key={d.allmoxy_customer_id ?? idx}>
                  <TableCell sx={{ fontWeight: 500 }}>{d.name}</TableCell>
                  <TableCell align="right">{USD0.format(d.current_mrr)}</TableCell>
                  <TableCell align="right">
                    <Chip
                      label={d.failed_3mo}
                      size="small"
                      sx={{
                        bgcolor: d.failed_3mo >= 3 ? 'rgba(218, 54, 51, 0.2)' : 'rgba(245, 158, 11, 0.2)',
                        color: d.failed_3mo >= 3 ? 'error.main' : 'warning.main',
                        fontSize: 11,
                      }}
                    />
                  </TableCell>
                  <TableCell align="right" sx={{ color: 'error.main' }}>
                    {USD0.format(d.failed_3mo_amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      {drill && snap && (() => {
        const topCustomerColumns: DrillColumn<TopCustomer>[] = [
          { key: 'rank', label: '#', render: (_r) => '', align: 'left' },
          { key: 'name', label: 'Customer' },
          { key: 'current_mrr', label: 'Current MRR', align: 'right', render: (r) => USD0.format(r.current_mrr) },
          {
            key: 'pct_of_mrr',
            label: '% of MRR',
            align: 'right',
            render: (r) => `${((r.current_mrr / snap.concentration.total_mrr) * 100).toFixed(2)}%`,
            exportValue: (r) => r.current_mrr / snap.concentration.total_mrr,
          },
          { key: 'lifetime_revenue', label: 'Lifetime revenue', align: 'right', render: (r) => USD0.format(r.lifetime_revenue) },
          { key: 'years_with_us', label: 'Years', align: 'right', render: (r) => (r.years_with_us != null ? r.years_with_us.toFixed(1) : '—') },
          { key: 'failed_3mo', label: 'Failed 3mo', align: 'right' },
        ];

        if (drill.kind === 'concentration') {
          const rows = (snap.all_active_customers ?? snap.top_customers).slice(0, drill.n);
          const indexed = rows.map((r, i) => ({ ...r, rank: i + 1 }));
          const totalPct = rows.reduce((s, r) => s + r.current_mrr, 0) / snap.concentration.total_mrr;
          return (
            <DrillDownPanel
              title={`${drill.label} · ${USD0.format(rows.reduce((s, r) => s + r.current_mrr, 0))}/mo`}
              subtitle={`${(totalPct * 100).toFixed(2)}% of total subscription MRR · ${monthLabel(snap.latestMonth)}`}
              rows={indexed as unknown as Array<Record<string, unknown>>}
              columns={[
                { key: 'rank', label: '#', align: 'left' },
                ...topCustomerColumns.slice(1),
              ] as unknown as DrillColumn<Record<string, unknown>>[]}
              filename={`concentration_top_${drill.n}_${snap.latestMonth}`}
              onClose={() => setDrill(null)}
            />
          );
        }

        if (drill.kind === 'bucket') {
          const bucket = snap.distribution.find((b) => b.bucket === drill.bucket);
          const rows = bucket?.customers_list ?? [];
          return (
            <DrillDownPanel
              title={`MRR bucket: ${drill.bucket}`}
              subtitle={bucket ? `${bucket.customers} customers · ${USD0.format(bucket.mrr)}/mo total` : ''}
              rows={rows as unknown as Array<Record<string, unknown>>}
              columns={topCustomerColumns.slice(1) as unknown as DrillColumn<Record<string, unknown>>[]}
              filename={`mrr_bucket_${drill.bucket}_${snap.latestMonth}`}
              onClose={() => setDrill(null)}
            />
          );
        }

        // dunning
        const dunningColumns: DrillColumn<DunningCustomer>[] = [
          { key: 'name', label: 'Customer' },
          { key: 'current_mrr', label: 'Current MRR', align: 'right', render: (r) => USD0.format(r.current_mrr) },
          { key: 'failed_3mo', label: 'Failed attempts', align: 'right' },
          { key: 'failed_3mo_amount', label: 'Total $ failed', align: 'right', render: (r) => USD0.format(r.failed_3mo_amount) },
        ];
        return (
          <DrillDownPanel
            title="Dunning watch list · trailing 3 months"
            subtitle={`${snap.dunning_summary.total_dunning_customers} customers · ${USD0.format(snap.dunning_summary.total_at_risk_amount)} at risk`}
            accent="rgba(218, 54, 51, 0.5)"
            rows={snap.dunning_customers as unknown as Array<Record<string, unknown>>}
            columns={dunningColumns as unknown as DrillColumn<Record<string, unknown>>[]}
            filename={`dunning_${snap.latestMonth}`}
            onClose={() => setDrill(null)}
          />
        );
      })()}
    </Box>
  );
}

function ConcentrationCard({
  label,
  slice,
  thresholds,
  loading,
  subtext,
  onClick,
  info,
}: {
  label: string;
  slice: ConcentrationSlice | null;
  thresholds: { good: number; caution: number };
  loading?: boolean;
  subtext?: string;
  onClick?: () => void;
  info?: React.ReactNode;
}) {
  const color = concentrationColor(slice?.pct ?? null, thresholds);
  return (
    <Paper
      sx={{
        p: 2.5,
        height: '100%',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background-color 120ms',
        '&:hover': onClick ? { bgcolor: 'rgba(44, 115, 255, 0.04)' } : {},
      }}
      onClick={onClick}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label} · % of MRR
        </Typography>
        {info && <Box onClick={(e) => e.stopPropagation()}><InfoIcon info={info} /></Box>}
      </Stack>
      {loading || !slice ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 32 }} />
      ) : (
        <Typography variant="h4" sx={{ fontWeight: 500, color, mt: 0.5 }}>
          {pct(slice.pct)}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 11 }}>
        {slice ? `${USD0.format(slice.mrr)}/mo` : 'loading'}
        {subtext ? ` · ${subtext}` : ''}
      </Typography>
    </Paper>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box sx={{ width: 14, height: 14, bgcolor: color, borderRadius: 0.5 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
        {label}
      </Typography>
    </Stack>
  );
}
