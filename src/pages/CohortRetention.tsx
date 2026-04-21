import { useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Tooltip from '@mui/material/Tooltip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ReferenceLine, Cell } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import { useSheetTab } from '../hooks/useSheetTab';

type CohortRow = {
  year: number;
  initial: number;
  active: number;
  churned: number;
  retentionPct: number | null;
};

type TriangleCell = {
  yearsSince: number;
  month: string;
  activeLogos: number;
  subscription: number;
  services: number;
  logoRetentionPct: number | null;
  dollarRetentionPct: number | null;
};

type CohortMember = {
  allmoxy_customer_id: number;
  name: string | null;
  first_payment: string | null;
  last_payment: string | null;
  streams: string[];
  lifetime_revenue: number;
  active_today: boolean;
};

type TriangleEntry = {
  baselineMonth: string;
  baselineLogos: number;
  baselineDollar: number;
  initialLogos: number;
  series: TriangleCell[];
  members: CohortMember[];
};

type CohortSnapshot = {
  totalCustomers: number;
  activeToday: number;
  cohortSummary: CohortRow[];
  cohortYears: number[];
  cohortTriangle: Record<string, TriangleEntry>;
  notes: string;
};

type Metric = 'dollar' | 'logo';

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Dollar and logo use slightly different scales (dollar can exceed 100% from expansion;
// logo almost never does) so the color bands differ.
function dollarColor(pct: number | null): { bg: string; fg: string } {
  if (pct == null) return { bg: 'transparent', fg: '#6E7681' };
  if (pct >= 150) return { bg: 'rgba(26, 158, 92, 0.55)', fg: '#E6EDF3' };
  if (pct >= 120) return { bg: 'rgba(26, 158, 92, 0.35)', fg: '#E6EDF3' };
  if (pct >= 100) return { bg: 'rgba(26, 158, 92, 0.18)', fg: '#E6EDF3' };
  if (pct >= 90) return { bg: 'rgba(139, 148, 158, 0.15)', fg: '#E6EDF3' };
  if (pct >= 75) return { bg: 'rgba(229, 137, 78, 0.25)', fg: '#E6EDF3' };
  if (pct >= 50) return { bg: 'rgba(229, 137, 78, 0.40)', fg: '#E6EDF3' };
  return { bg: 'rgba(218, 54, 51, 0.45)', fg: '#E6EDF3' };
}
function logoColor(pct: number | null): { bg: string; fg: string } {
  if (pct == null) return { bg: 'transparent', fg: '#6E7681' };
  if (pct >= 80) return { bg: 'rgba(26, 158, 92, 0.45)', fg: '#E6EDF3' };
  if (pct >= 60) return { bg: 'rgba(26, 158, 92, 0.25)', fg: '#E6EDF3' };
  if (pct >= 40) return { bg: 'rgba(229, 137, 78, 0.25)', fg: '#E6EDF3' };
  if (pct >= 25) return { bg: 'rgba(229, 137, 78, 0.40)', fg: '#E6EDF3' };
  return { bg: 'rgba(218, 54, 51, 0.45)', fg: '#E6EDF3' };
}
function currentRetentionColor(pct: number | null): string {
  if (pct == null) return '#6E7681';
  if (pct >= 80) return '#1A9E5C';
  if (pct >= 50) return '#F59E0B';
  if (pct >= 25) return '#E5894E';
  return '#DA3633';
}

export default function CohortRetention() {
  const { data, isLoading, error } = useSheetTab('cohort_retention');
  const snap = data as unknown as CohortSnapshot | undefined;

  const [metric, setMetric] = useState<Metric>('dollar');
  const [showPre2018, setShowPre2018] = useState(false);
  const [drill, setDrill] = useState<{ cohortYear: number; month?: string } | null>(null);
  function openDrill(cohortYear: number, month?: string) {
    setDrill({ cohortYear, month });
    setTimeout(() => {
      document.getElementById('drill-down-panel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 50);
  }

  const allCohorts = snap?.cohortSummary ?? [];
  const cohorts = showPre2018 ? allCohorts : allCohorts.filter((c) => c.year >= 2018);
  const pre2018Count = allCohorts.filter((c) => c.year < 2018).length;
  const overallRetention =
    snap && snap.totalCustomers > 0 ? Math.round((100 * snap.activeToday) / snap.totalCustomers * 10) / 10 : null;

  const visibleCohortYears = useMemo(
    () => (snap ? (showPre2018 ? snap.cohortYears : snap.cohortYears.filter((y) => y >= 2018)) : []),
    [snap, showPre2018]
  );

  const maxYearsSince = useMemo(() => {
    if (!snap) return 0;
    let max = 0;
    for (const y of visibleCohortYears) {
      const e = snap.cohortTriangle[String(y)];
      if (e && e.series.length > max) max = e.series.length;
    }
    return max;
  }, [snap, visibleCohortYears]);

  return (
    <Box>
      <PageHeader
        title="Cohort Retention"
        subtitle="How customers from each signup year retain and expand over time. Spot which vintages are strongest, where churn kicks in, and which cohorts to learn from."
        question="healthy"
      />

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed to load cohort_retention — {String(error)}
        </Alert>
      )}



      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Customers ever signed up
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> All-time unique customer count — everyone who's ever had a paid relationship with Allmoxy, active or churned.<br /><br /><strong>Data:</strong> Union of allmoxy_core_customer (master roster, 600 customers) and Stripe Sync classified transactions (covers customers not yet in the roster).</>} />
            </Stack>
            <Typography variant="h4" sx={{ fontWeight: 500, mt: 0.5 }}>
              {isLoading || !snap ? <Skeleton width="50%" /> : snap.totalCustomers.toLocaleString()}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
              Merged from allmoxy_core_customer + Stripe Sync
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Active today
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> Customers currently paying — those with at least one succeeded Stripe charge in the current calendar year.<br /><br /><strong>Data:</strong> Count of distinct customers whose most recent succeeded Stripe charge falls in 2026, aggregated from Stripe Sync.</>} />
            </Stack>
            <Typography variant="h4" sx={{ fontWeight: 500, mt: 0.5 }}>
              {isLoading || !snap ? <Skeleton width="50%" /> : snap.activeToday.toLocaleString()}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
              Customer has a 2026 Stripe charge
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Overall logo retention
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> Of every customer who's ever paid, what % are still paying today.<br /><br /><strong>Data:</strong> Active today ÷ Customers ever signed up. A lifetime retention rate across all vintages from 2009 onward.<br /><br /><strong>Note:</strong> A 17-year-old SaaS won't keep every customer forever — look at the per-cohort breakdown below to see retention by vintage year.</>} />
            </Stack>
            <Typography variant="h4" sx={{ fontWeight: 500, mt: 0.5, color: overallRetention != null && overallRetention >= 40 ? 'success.main' : 'warning.main' }}>
              {isLoading || !snap ? <Skeleton width="50%" /> : overallRetention != null ? `${overallRetention}%` : '—'}
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
              Across all signup vintages
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', md: 'center' }}
          spacing={2}
          sx={{ mb: 2 }}
        >
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Retention triangle · baseline = December of cohort year
            </Typography>
            <InfoIcon info={<><strong>What it is:</strong> Each row is a cohort of customers who made their first payment in a given year. Each column is a year after that cohort year — cells show the % retained at that point.<br /><br /><strong>Subscription $ retention</strong> = cohort's share of total subscription MRR at year-N ÷ cohort's share at baseline (Dec of cohort year). Logo-weighted proportional allocation — services revenue is excluded so project-based one-offs don't inflate the NDR story.<br /><br /><strong>Logo retention</strong> = % of the cohort's customers still active at year-N. Exact from Stripe transaction dates.<br /><br /><strong>Click any cell</strong> to drill into the cohort members active in that specific month.</>} />
            {pre2018Count > 0 && (
              <Button
                size="small"
                variant="text"
                onClick={() => setShowPre2018((v) => !v)}
                startIcon={showPre2018 ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                sx={{ textTransform: 'none', fontSize: 11, color: 'text.secondary', py: 0.25, px: 1 }}
              >
                {showPre2018 ? `Collapse pre-2018 (${pre2018Count})` : `Show pre-2018 (${pre2018Count} cohorts)`}
              </Button>
            )}
          </Stack>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={metric}
            onChange={(_, v) => v && setMetric(v as Metric)}
            sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
          >
            <ToggleButton value="dollar">Subscription $ retention</ToggleButton>
            <ToggleButton value="logo">Logo retention</ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {isLoading || !snap ? (
          <Skeleton variant="rectangular" height={360} />
        ) : (
          <Box sx={{ overflowX: 'auto' }}>
            <Box sx={{ display: 'inline-block', minWidth: '100%' }}>
              <Stack direction="row" sx={{ mb: 0.5 }}>
                <Box sx={{ width: 68, flexShrink: 0 }} />
                <Box sx={{ width: 130, flexShrink: 0, px: 1 }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
                    Baseline (Dec)
                  </Typography>
                </Box>
                {Array.from({ length: maxYearsSince }).map((_, i) => (
                  <Box key={i} sx={{ flex: 1, minWidth: 60, textAlign: 'center', px: 0.5 }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
                      Year {i}
                    </Typography>
                  </Box>
                ))}
              </Stack>
              {visibleCohortYears.map((year) => {
                const entry = snap.cohortTriangle[String(year)];
                if (!entry) return null;
                return (
                  <Stack key={year} direction="row" sx={{ mb: 0.5 }}>
                    <Box sx={{ width: 68, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>
                        {year}
                      </Typography>
                    </Box>
                    <Box sx={{ width: 130, flexShrink: 0, px: 1 }}>
                      <Typography variant="caption" sx={{ display: 'block', lineHeight: 1.2 }}>
                        {entry.initialLogos} signed up · {entry.baselineLogos} @ baseline
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, lineHeight: 1.2 }}>
                        {USD0.format(entry.baselineDollar)}/mo baseline
                      </Typography>
                    </Box>
                    {Array.from({ length: maxYearsSince }).map((_, i) => {
                      const cell = entry.series[i];
                      const pct = cell
                        ? metric === 'dollar'
                          ? cell.dollarRetentionPct
                          : cell.logoRetentionPct
                        : null;
                      const color = metric === 'dollar' ? dollarColor(pct) : logoColor(pct);
                      const hoverBody = cell
                        ? `${cell.month} · ${cell.activeLogos} logos · ${USD0.format(cell.subscription)}/mo sub` +
                          (cell.services > 0 ? ` (+ ${USD0.format(cell.services)} services, not counted)` : '')
                        : 'No data';
                      return (
                        <Tooltip key={i} title={hoverBody} arrow placement="top">
                          <Box
                            onClick={() => cell && openDrill(year, cell.month)}
                            sx={{
                              flex: 1,
                              minWidth: 60,
                              mx: 0.25,
                              py: 1,
                              textAlign: 'center',
                              borderRadius: 1,
                              bgcolor: color.bg,
                              color: color.fg,
                              cursor: cell ? 'pointer' : 'default',
                              transition: 'transform 80ms',
                              '&:hover': cell ? { transform: 'scale(1.03)' } : {},
                            }}
                          >
                            <Typography variant="body2" sx={{ fontWeight: 500, fontSize: 12 }}>
                              {pct != null ? `${pct}%` : '—'}
                            </Typography>
                          </Box>
                        </Tooltip>
                      );
                    })}
                  </Stack>
                );
              })}
            </Box>
          </Box>
        )}

        <Stack direction="row" spacing={2} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap alignItems="center">
          {metric === 'dollar' ? (
            <>
              <LegendSwatch color="rgba(26, 158, 92, 0.55)" label="≥ 150% (expansion)" />
              <LegendSwatch color="rgba(26, 158, 92, 0.35)" label="120–150%" />
              <LegendSwatch color="rgba(26, 158, 92, 0.18)" label="100–120%" />
              <LegendSwatch color="rgba(139, 148, 158, 0.15)" label="90–100%" />
              <LegendSwatch color="rgba(229, 137, 78, 0.25)" label="75–90%" />
              <LegendSwatch color="rgba(229, 137, 78, 0.40)" label="50–75%" />
              <LegendSwatch color="rgba(218, 54, 51, 0.45)" label="< 50%" />
            </>
          ) : (
            <>
              <LegendSwatch color="rgba(26, 158, 92, 0.45)" label="≥ 80%" />
              <LegendSwatch color="rgba(26, 158, 92, 0.25)" label="60–80%" />
              <LegendSwatch color="rgba(229, 137, 78, 0.25)" label="40–60%" />
              <LegendSwatch color="rgba(229, 137, 78, 0.40)" label="25–40%" />
              <LegendSwatch color="rgba(218, 54, 51, 0.45)" label="< 25%" />
            </>
          )}
        </Stack>
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Current logo retention by signup cohort · dashed line = 50%
          </Typography>
          <InfoIcon info={<><strong>What it is:</strong> Simplest cohort view — what fraction of each cohort is still paying today.<br /><br /><strong>Data:</strong> For each signup-year cohort, (customers currently active in 2026) ÷ (total customers who made their first payment in that year). Directly computed, not estimated.<br /><br /><strong>Bar color:</strong> Green ≥ 80%, amber ≥ 50%, orange ≥ 25%, red &lt; 25%. Click a bar to drill into that cohort's members.</>} />
        </Stack>
        {isLoading || !snap ? (
          <Skeleton variant="rectangular" height={260} />
        ) : (
          <Box sx={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cohorts} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="year" stroke="#8B949E" fontSize={11} />
                <YAxis stroke="#8B949E" fontSize={11} width={50} tickFormatter={(v) => `${v}%`} />
                <ReferenceLine y={50} stroke="#8B949E" strokeDasharray="4 4" />
                <RTooltip
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6 }}
                  formatter={(v: number, _n: string, payload: { payload?: CohortRow }) => {
                    const row = payload?.payload;
                    if (!row) return [`${v}%`, 'Retention'];
                    return [`${v}% · ${row.active}/${row.initial} active · ${row.churned} churned`, `${row.year} cohort`];
                  }}
                />
                <Bar
                  dataKey="retentionPct"
                  radius={[2, 2, 0, 0]}
                  cursor="pointer"
                  onClick={(p: { payload?: { year: number } }) => p.payload && openDrill(p.payload.year)}
                >
                  {cohorts.map((c) => (
                    <Cell key={c.year} fill={currentRetentionColor(c.retentionPct)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            Cohort detail
          </Typography>
          <InfoIcon info={<><strong>What it is:</strong> Tabular version of the cohort breakdown. Shows signup count, currently-active count, churned count, retention % and age for each cohort year.<br /><br /><strong>Data:</strong> Same source as the bar chart above — computed directly from Stripe Sync transaction dates joined against the customer roster. Click any row to drill into that cohort's members.</>} />
        </Stack>
        {isLoading || !snap ? (
          <Skeleton variant="rectangular" height={400} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Cohort</TableCell>
                <TableCell align="right">Signups</TableCell>
                <TableCell align="right">Active today</TableCell>
                <TableCell align="right">Churned</TableCell>
                <TableCell align="right">Retention</TableCell>
                <TableCell>Age</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {cohorts.map((c) => {
                const color = currentRetentionColor(c.retentionPct);
                const yearsSince = new Date().getFullYear() - c.year;
                return (
                  <TableRow
                    key={c.year}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => openDrill(c.year)}
                  >
                    <TableCell sx={{ fontWeight: 500 }}>{c.year}</TableCell>
                    <TableCell align="right">{c.initial}</TableCell>
                    <TableCell align="right">{c.active}</TableCell>
                    <TableCell align="right">{c.churned}</TableCell>
                    <TableCell align="right" sx={{ color, fontWeight: 500 }}>
                      {c.retentionPct != null ? `${c.retentionPct}%` : '—'}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
                        {yearsSince === 0 ? 'YTD' : `${yearsSince} year${yearsSince === 1 ? '' : 's'} since`}
                      </Typography>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1, fontStyle: 'italic' }}>
          Click a cohort row, a heatmap cell, or a bar to see the underlying customers — export any list to CSV.
        </Typography>
      </Paper>

      {drill && snap && (() => {
        const entry = snap.cohortTriangle[String(drill.cohortYear)];
        if (!entry) return null;

        let members = entry.members;
        let titleSuffix = `· ${entry.initialLogos} signups`;
        let subtitle = `${entry.members.filter((m) => m.active_today).length} still active · ${entry.members.filter((m) => !m.active_today).length} churned · sorted by lifetime revenue`;

        if (drill.month) {
          // Filter to members who were active during the selected cell's month.
          const [y, m] = drill.month.split('-').map(Number);
          const monthStart = new Date(y, m - 1, 1);
          const monthEnd = new Date(y, m, 0, 23, 59, 59);
          members = entry.members.filter((mm) => {
            if (!mm.first_payment || !mm.last_payment) return false;
            const fp = new Date(mm.first_payment);
            const lp = new Date(mm.last_payment);
            return fp <= monthEnd && lp >= monthStart;
          });
          titleSuffix = `· ${drill.month} · ${members.length} active`;
          subtitle = `Members of the ${drill.cohortYear} cohort who were paying in ${drill.month}`;
        }

        const columns: DrillColumn<CohortMember>[] = [
          { key: 'name', label: 'Customer' },
          { key: 'allmoxy_customer_id', label: 'Allmoxy ID', align: 'right' },
          { key: 'first_payment', label: 'First payment' },
          { key: 'last_payment', label: 'Last payment' },
          { key: 'streams', label: 'Streams', render: (r) => r.streams.join(', ') },
          { key: 'lifetime_revenue', label: 'Lifetime revenue', align: 'right', render: (r) => USD0.format(r.lifetime_revenue) },
          {
            key: 'active_today',
            label: 'Active today',
            align: 'center',
            render: (r) => (r.active_today ? '✓' : '—'),
            exportValue: (r) => (r.active_today ? 'yes' : 'no'),
          },
        ];

        return (
          <DrillDownPanel
            title={`${drill.cohortYear} cohort ${titleSuffix}`}
            subtitle={subtitle}
            rows={members as unknown as Array<Record<string, unknown>>}
            columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
            filename={`cohort_${drill.cohortYear}${drill.month ? `_${drill.month}` : ''}`}
            onClose={() => setDrill(null)}
          />
        );
      })()}
    </Box>
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
