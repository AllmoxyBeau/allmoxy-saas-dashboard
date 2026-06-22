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
import TableSortLabel from '@mui/material/TableSortLabel';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  Legend,
} from 'recharts';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

// Contracts reads the renewal_management snapshot — one row per active HubSpot
// Instance (sandboxes already excluded upstream), keyed 1:1 to
// allmoxy_customer_id. We reuse it here rather than build a new snapshot
// because it already carries contract_status, health_score(_status), and the
// quotes[] array — exactly the three things this page correlates.
type Quote = {
  id: string;
  title: string | null;
  status: string | null;
  amount: number | null;
  currency: string;
  created_date: string | null;
  expiration_date: string | null;
  last_modified_date: string | null;
  quote_number: string | null;
  payment_status: string | null;
  hubspot_url: string;
};

type RenewalRow = {
  instance_id: string;
  account_name: string;
  allmoxy_customer_id: number;
  contract_status: string | null; // 'Yes' | 'No' | '' | null
  contract_length_months: number | null;
  renewal_date: string | null;
  days_to_renewal: number | null;
  pay_status: string;
  health_score: number | null; // 0–65 scale
  health_score_status: string | null; // 'Healthy' | 'Neutral' | 'At-Risk' | null
  current_mrr: number;
  current_arr: number;
  arr_up_for_renewal: number;
  owner_name: string | null;
  quotes?: Quote[];
};

type Snapshot = {
  fetchedAt: string;
  rows: RenewalRow[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// Contract buckets. HubSpot's contract_status is a hand-maintained Yes/No flag,
// NOT a date check — so a "Yes" whose renewal date has already passed is flagged
// in-contract while the term has actually lapsed. We keep the flag but split
// those out: Yes + past renewal → Lapsed; Yes + future/no renewal date → In
// contract. Anything that isn't an explicit Yes/No (null or '') is "Unknown" —
// a data-hygiene bucket, not a real state.
type Contract = 'In contract' | 'Lapsed / overdue' | 'Not in contract' | 'Unknown';
const CONTRACT_ORDER: Contract[] = ['In contract', 'Lapsed / overdue', 'Not in contract', 'Unknown'];
function contractBucket(r: { contract_status: string | null; days_to_renewal: number | null }): Contract {
  if (r.contract_status === 'Yes') {
    return r.days_to_renewal != null && r.days_to_renewal < 0 ? 'Lapsed / overdue' : 'In contract';
  }
  if (r.contract_status === 'No') return 'Not in contract';
  return 'Unknown';
}
const CONTRACT_COLOR: Record<Contract, string> = {
  'In contract': '#1A9E5C',
  'Lapsed / overdue': '#E8833A',
  'Not in contract': '#D63A4D',
  Unknown: '#8B949E',
};

// Four health buckets ordered worst→best for stacking. 'Unscored' folds in any
// row HubSpot hasn't health-scored yet.
type Health = 'At-Risk' | 'Neutral' | 'Healthy' | 'Unscored';
const HEALTH_ORDER: Health[] = ['At-Risk', 'Neutral', 'Healthy', 'Unscored'];
function healthBucket(s: string | null): Health {
  if (s === 'At-Risk' || s === 'Neutral' || s === 'Healthy') return s;
  return 'Unscored';
}
const HEALTH_COLOR: Record<Health, string> = {
  'At-Risk': '#D63A4D',
  Neutral: '#F5A623',
  Healthy: '#1A9E5C',
  Unscored: '#8B949E',
};

type SortKey = 'name' | 'contract' | 'health' | 'quotes' | 'mrr' | 'arr' | 'renewal';

export default function Contracts() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('renewal_management');
  const snap = data as Snapshot | undefined;
  const rows = snap?.rows ?? [];

  const [contractFilter, setContractFilter] = useState<Contract | null>(null);
  const [healthFilter, setHealthFilter] = useState<Health | null>(null);
  const [quoteFilter, setQuoteFilter] = useState<'with' | 'without' | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('arr');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc'); }
  }

  // Headline counts.
  const stats = useMemo(() => {
    const zero = () => Object.fromEntries(CONTRACT_ORDER.map((c) => [c, 0])) as Record<Contract, number>;
    const byContract = zero();
    let withQuote = 0;
    let quoteTotal = 0;
    // Avg health score per contract bucket — the single-number correlation.
    const hsSum = zero();
    const hsCnt = zero();
    for (const r of rows) {
      const c = contractBucket(r);
      byContract[c] += 1;
      const qn = r.quotes?.length ?? 0;
      if (qn > 0) withQuote += 1;
      quoteTotal += qn;
      if (r.health_score != null) { hsSum[c] += r.health_score; hsCnt[c] += 1; }
    }
    const avg = (c: Contract) => (hsCnt[c] > 0 ? hsSum[c] / hsCnt[c] : null);
    return { byContract, withQuote, quoteTotal, total: rows.length, avg };
  }, [rows]);

  // Correlation chart: x = contract bucket, stacked by health bucket. This is
  // the page's centerpiece — does being in contract track with being healthy?
  const correlation = useMemo(() => {
    return CONTRACT_ORDER.map((c) => {
      const cell: Record<string, number | string> = { contract: c };
      for (const h of HEALTH_ORDER) cell[h] = 0;
      for (const r of rows) {
        if (contractBucket(r) !== c) continue;
        cell[healthBucket(r.health_score_status)] = (cell[healthBucket(r.health_score_status)] as number) + 1;
      }
      return cell;
    });
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (contractFilter && contractBucket(r) !== contractFilter) return false;
    if (healthFilter && healthBucket(r.health_score_status) !== healthFilter) return false;
    const qn = r.quotes?.length ?? 0;
    if (quoteFilter === 'with' && qn === 0) return false;
    if (quoteFilter === 'without' && qn > 0) return false;
    return true;
  }), [rows, contractFilter, healthFilter, quoteFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const contractOrder = (c: Contract) => CONTRACT_ORDER.indexOf(c);
    const healthOrder: Record<Health, number> = { 'At-Risk': 0, Neutral: 1, Healthy: 2, Unscored: 3 };
    out.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case 'name': av = (a.account_name || '').toLowerCase(); bv = (b.account_name || '').toLowerCase(); break;
        case 'contract': av = contractOrder(contractBucket(a)); bv = contractOrder(contractBucket(b)); break;
        // Sort by numeric score; rows with no score sort to the end either way.
        case 'health': av = a.health_score ?? -1; bv = b.health_score ?? -1; break;
        case 'quotes': av = a.quotes?.length ?? 0; bv = b.quotes?.length ?? 0; break;
        case 'mrr': av = a.current_mrr; bv = b.current_mrr; break;
        case 'arr': av = a.current_arr; bv = b.current_arr; break;
        case 'renewal': av = a.renewal_date ?? '9999'; bv = b.renewal_date ?? '9999'; break;
        default: av = 0; bv = 0;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      // Secondary: keep health-status order stable when sorting by contract.
      return healthOrder[healthBucket(a.health_score_status)] - healthOrder[healthBucket(b.health_score_status)];
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  const csvColumns = useMemo(() => ([
    { key: 'customer', label: 'Customer', getValue: (r: RenewalRow) => r.account_name },
    { key: 'aid', label: 'Allmoxy ID', getValue: (r: RenewalRow) => r.allmoxy_customer_id },
    { key: 'contract', label: 'Contract', getValue: (r: RenewalRow) => contractBucket(r) },
    { key: 'contract_raw', label: 'Contract (HubSpot)', getValue: (r: RenewalRow) => r.contract_status ?? '' },
    { key: 'health_status', label: 'Health Status', getValue: (r: RenewalRow) => r.health_score_status ?? '' },
    { key: 'health_score', label: 'Health Score', getValue: (r: RenewalRow) => r.health_score ?? '' },
    { key: 'quote_count', label: 'Quote Count', getValue: (r: RenewalRow) => r.quotes?.length ?? 0 },
    { key: 'latest_quote_status', label: 'Latest Quote Status', getValue: (r: RenewalRow) => r.quotes?.[0]?.status ?? '' },
    { key: 'latest_quote_amount', label: 'Latest Quote Amount', getValue: (r: RenewalRow) => r.quotes?.[0]?.amount ?? '' },
    { key: 'latest_quote_url', label: 'Latest Quote URL', getValue: (r: RenewalRow) => r.quotes?.[0]?.hubspot_url ?? '' },
    { key: 'mrr', label: 'Current MRR', getValue: (r: RenewalRow) => r.current_mrr },
    { key: 'arr', label: 'Current ARR', getValue: (r: RenewalRow) => r.current_arr },
    { key: 'renewal_date', label: 'Renewal Date', getValue: (r: RenewalRow) => r.renewal_date ?? '' },
    { key: 'owner', label: 'Owner', getValue: (r: RenewalRow) => r.owner_name ?? '' },
  ]), []);

  const activeFilter = contractFilter || healthFilter || quoteFilter;

  return (
    <Box>
      <PageHeader
        title="Contracts"
        subtitle="Contract coverage by customer — in contract vs month-to-month — correlated with HubSpot health score. Contract status is HubSpot's hand-set Yes/No flag; 'Yes' customers whose renewal date has already passed are split out as Lapsed / overdue (the flag was never updated). Quotes are the renewal lever: a low health score with no quote and a near renewal is the prep list."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load renewal_management: {String(error)}</Alert>}

      {/* KPI tiles — click a contract tile to filter the table to that bucket. */}
      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <KpiTile
          label="In contract"
          info="HubSpot Contract Status = Yes AND the renewal date hasn't passed (or none is set) — actively under a term agreement. Click to filter the table."
          value={stats.byContract['In contract']}
          sub={stats.avg('In contract') != null ? `Avg health ${stats.avg('In contract')!.toFixed(0)} / 65` : '—'}
          accent="success.main"
          valueColor="success.main"
          active={contractFilter === 'In contract'}
          onClick={() => setContractFilter((p) => (p === 'In contract' ? null : 'In contract'))}
          isLoading={isLoading}
        />
        <KpiTile
          label="Lapsed / overdue"
          info="Contract Status = Yes but the renewal date has already passed — the contract flag was never updated after the term ended. These are flagged in-contract in HubSpot but have effectively lapsed; a renewal-hygiene + re-sign list. Click to filter."
          value={stats.byContract['Lapsed / overdue']}
          sub={stats.avg('Lapsed / overdue') != null ? `Avg health ${stats.avg('Lapsed / overdue')!.toFixed(0)} / 65` : 'Yes flag · renewal passed'}
          accent="#E8833A"
          valueColor="#E8833A"
          active={contractFilter === 'Lapsed / overdue'}
          onClick={() => setContractFilter((p) => (p === 'Lapsed / overdue' ? null : 'Lapsed / overdue'))}
          isLoading={isLoading}
        />
        <KpiTile
          label="Not in contract"
          info="Contract Status = No — month-to-month, no term commitment. The churn-exposed base. Click to filter."
          value={stats.byContract['Not in contract']}
          sub={stats.avg('Not in contract') != null ? `Avg health ${stats.avg('Not in contract')!.toFixed(0)} / 65` : '—'}
          accent="error.main"
          valueColor="error.main"
          active={contractFilter === 'Not in contract'}
          onClick={() => setContractFilter((p) => (p === 'Not in contract' ? null : 'Not in contract'))}
          isLoading={isLoading}
        />
        <KpiTile
          label="Contract unknown"
          info="No explicit Yes/No Contract Status in HubSpot — a data-hygiene bucket. Click to filter and clean up."
          value={stats.byContract.Unknown}
          sub="Unset in HubSpot"
          accent="info.main"
          valueColor="info.main"
          active={contractFilter === 'Unknown'}
          onClick={() => setContractFilter((p) => (p === 'Unknown' ? null : 'Unknown'))}
          isLoading={isLoading}
        />
        <KpiTile
          label="Customers w/ a quote"
          info="Customers with at least one HubSpot Quote on their Company. Click to filter the table to these."
          value={stats.withQuote}
          sub={`${stats.total - stats.withQuote} without`}
          active={quoteFilter === 'with'}
          onClick={() => setQuoteFilter((p) => (p === 'with' ? null : 'with'))}
          isLoading={isLoading}
        />
        <KpiTile
          label="Without a quote"
          info="Customers with zero HubSpot Quotes — the quote-creation backlog. Click to filter."
          value={stats.total - stats.withQuote}
          sub="No quote started"
          accent="warning.main"
          valueColor="warning.main"
          active={quoteFilter === 'without'}
          onClick={() => setQuoteFilter((p) => (p === 'without' ? null : 'without'))}
          isLoading={isLoading}
        />
        <KpiTile
          label="Total quotes"
          info="Sum of all HubSpot Quotes across every customer. Informational — not clickable."
          value={stats.quoteTotal}
          sub={`across ${stats.total} customers`}
          accent="primary.main"
          valueColor="primary.main"
          isLoading={isLoading}
        />
      </Grid>

      {/* Correlation — contract status × health, stacked. */}
      <Paper sx={{ p: 3, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Contract status × health score</Typography>
          <InfoIcon info="Each bar is a contract bucket; segments split it by HubSpot health status. Read it as: of the customers in contract, how many are Healthy vs At-Risk — and how that mix differs for the month-to-month base. Click a segment to filter the table to that exact contract × health slice." />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={300} /> : (
          <Box sx={{ height: 320 }}>
            <ResponsiveContainer>
              <BarChart data={correlation} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                <XAxis dataKey="contract" stroke="#8B949E" fontSize={12} />
                <YAxis stroke="#8B949E" fontSize={11} width={40} allowDecimals={false} />
                <RTooltip
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                  labelStyle={{ color: '#FFFFFF' }}
                  itemStyle={{ color: '#FFFFFF' }}
                  cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: '#8B949E' }} />
                {HEALTH_ORDER.map((h) => (
                  <Bar
                    key={h}
                    dataKey={h}
                    name={h}
                    stackId="health"
                    fill={HEALTH_COLOR[h]}
                    cursor="pointer"
                    onClick={(d: { contract?: Contract }) => {
                      if (d?.contract) setContractFilter((p) => (p === d.contract ? null : d.contract!));
                      setHealthFilter((p) => (p === h ? null : h));
                    }}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Active-filter banner */}
      {activeFilter && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => { setContractFilter(null); setHealthFilter(null); setQuoteFilter(null); }}>
          Filtered to{contractFilter ? ` ${contractFilter}` : ''}{healthFilter ? ` · ${healthFilter}` : ''}{quoteFilter ? ` · ${quoteFilter === 'with' ? 'has quote' : 'no quote'}` : ''} · {sorted.length} customer{sorted.length === 1 ? '' : 's'}. Click the × to clear.
        </Alert>
      )}

      {/* Table */}
      <Paper sx={{ p: 0 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            {sorted.length} customer{sorted.length === 1 ? '' : 's'}
          </Typography>
          <CsvExportButton filename="contracts" columns={csvColumns} rows={sorted} />
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sortDirection={sortKey === 'name' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'name'} direction={sortKey === 'name' ? sortDir : 'asc'} onClick={() => toggleSort('name')}>Customer</TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === 'contract' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'contract'} direction={sortKey === 'contract' ? sortDir : 'asc'} onClick={() => toggleSort('contract')}>Contract</TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === 'health' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'health'} direction={sortKey === 'health' ? sortDir : 'asc'} onClick={() => toggleSort('health')}>Health</TableSortLabel>
                </TableCell>
                <TableCell align="right" sortDirection={sortKey === 'quotes' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'quotes'} direction={sortKey === 'quotes' ? sortDir : 'asc'} onClick={() => toggleSort('quotes')}>Quotes</TableSortLabel>
                </TableCell>
                <TableCell>Latest quote</TableCell>
                <TableCell align="right" sortDirection={sortKey === 'mrr' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'mrr'} direction={sortKey === 'mrr' ? sortDir : 'asc'} onClick={() => toggleSort('mrr')}>MRR</TableSortLabel>
                </TableCell>
                <TableCell align="right" sortDirection={sortKey === 'arr' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'arr'} direction={sortKey === 'arr' ? sortDir : 'asc'} onClick={() => toggleSort('arr')}>ARR</TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === 'renewal' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'renewal'} direction={sortKey === 'renewal' ? sortDir : 'asc'} onClick={() => toggleSort('renewal')}>Renewal</TableSortLabel>
                </TableCell>
                <TableCell>Owner</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 10 }).map((_, i) => (
                  <TableRow key={i}><TableCell colSpan={9}><Skeleton variant="text" /></TableCell></TableRow>
                ))
              ) : sorted.length === 0 ? (
                <TableRow><TableCell colSpan={9}><Typography variant="body2" sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>No customers match the current filters.</Typography></TableCell></TableRow>
              ) : sorted.map((r) => {
                const c = contractBucket(r);
                const h = healthBucket(r.health_score_status);
                const latest = r.quotes?.[0];
                const qn = r.quotes?.length ?? 0;
                return (
                  <TableRow key={r.instance_id} hover>
                    <TableCell sx={{ fontWeight: 500 }}>
                      <CustomerLink id={r.allmoxy_customer_id} name={r.account_name} />
                    </TableCell>
                    <TableCell>
                      <Chip label={c} size="small" sx={{ height: 20, fontSize: 11, fontWeight: 600, bgcolor: CONTRACT_COLOR[c] + '22', color: CONTRACT_COLOR[c] }} />
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.75} alignItems="center">
                        <Chip label={h} size="small" sx={{ height: 20, fontSize: 11, fontWeight: 600, bgcolor: HEALTH_COLOR[h] + '22', color: HEALTH_COLOR[h] }} />
                        {r.health_score != null && (
                          <Typography variant="caption" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{r.health_score}</Typography>
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{qn || '—'}</TableCell>
                    <TableCell>
                      {latest ? (
                        <Box component="a" href={latest.hubspot_url} target="_blank" rel="noopener noreferrer" sx={{ color: 'primary.light', textDecoration: 'none', fontSize: 13, '&:hover': { textDecoration: 'underline' } }}>
                          {latest.status === 'APPROVAL_NOT_NEEDED' ? 'Sent' : (latest.status || '—')}
                          {latest.amount != null ? ` · ${USD0.format(latest.amount)}` : ''} ↗
                        </Box>
                      ) : <Typography variant="caption" sx={{ color: 'text.disabled' }}>none</Typography>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.current_mrr)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.current_arr)}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{r.renewal_date || '—'}</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{r.owner_name || '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      </Paper>
    </Box>
  );
}

function KpiTile({
  label, info, value, sub, accent, valueColor, active, onClick, isLoading,
}: {
  label: string;
  info: string;
  value: number | string | null | undefined;
  sub: string;
  accent?: string;
  valueColor?: string;
  active?: boolean;
  onClick?: () => void;
  isLoading: boolean;
}) {
  const clickable = !!onClick;
  return (
    <Grid item xs={12} sm={6} md={2} sx={{ display: 'flex' }}>
      <Paper
        onClick={onClick}
        sx={{
          p: 2,
          flexGrow: 1,
          cursor: clickable ? 'pointer' : 'default',
          borderLeft: accent ? '3px solid' : undefined,
          borderColor: accent,
          bgcolor: active ? 'action.selected' : undefined,
          outline: active ? '2px solid' : undefined,
          outlineColor: active ? (accent || 'primary.main') : undefined,
          outlineOffset: active ? '-2px' : undefined,
          transition: 'background-color 120ms, outline-color 120ms',
          '&:hover': clickable ? { bgcolor: active ? 'action.selected' : 'action.hover' } : undefined,
        }}
      >
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>{label}</Typography>
          <InfoIcon info={info} />
        </Stack>
        {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
          <>
            <Typography variant="h5" sx={{ fontWeight: 500, color: valueColor }}>{value ?? '—'}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{sub}</Typography>
          </>
        )}
      </Paper>
    </Grid>
  );
}
