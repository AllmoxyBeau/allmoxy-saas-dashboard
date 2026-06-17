import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableSortLabel from '@mui/material/TableSortLabel';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';

type RiskSignal = { type: string; weight: number; quote?: string };

type ScoredCustomer = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_company_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  current_subscription_mrr: number;
  lifetime_subscription: number;
  years_with_us: number | null;
  primary_segment: string | null;
  sub_segment: string | null;
  sign_up_date: string | null;
  failed_3mo_count: number;
  failed_3mo_amount: number;
  signal_1_orders: number;
  orders_label: string;
  orders_detail: string;
  orders_current_year: number;
  orders_prior_year: number;
  orders_lifetime: number;
  signal_2_launch: number;
  signal_3_recency: number;
  signal_4_risk: number;
  signal_5_tenure: number;
  launch_status: string;
  launch_evidence: string | null;
  days_since_last_contact: number | null;
  risk_signals: RiskSignal[];
  gym_member_cliff: boolean;
  total_score: number;
  tier: 'red' | 'yellow' | 'green' | 'unscored';
  arr_at_risk: number;
  has_order_data: boolean;
  has_hubspot_data: boolean;
  scoring_data_status: 'full' | 'orders_only' | 'hubspot_only' | 'no_data';
  is_bid_only: boolean;
  narrative: string;
};

type MatrixCell = {
  tier: string;
  band: string;
  count: number;
  mrr_sum: number;
  arr_at_risk_sum: number;
  customer_ids: number[];
};

type Snapshot = {
  fetched_at: string;
  scoring_mode: 'full' | 'orders_only' | 'hubspot_only' | 'minimal';
  totals: {
    cohort_size: number;
    total_mrr: number;
    total_arr_at_risk: number;
    red_count: number;
    yellow_count: number;
    green_count: number;
    unscored_count: number;
    red_mrr: number;
    yellow_mrr: number;
    green_mrr: number;
    hubspot_signals_loaded: boolean;
    order_data_loaded: boolean;
  };
  matrix: Record<string, MatrixCell>;
  customers: ScoredCustomer[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const TIER_COLOR = {
  red: '#D63A4D',
  yellow: '#F5A623',
  green: '#1A9E5C',
  unscored: '#94a3b8',
};

const TIER_BG = {
  red: 'rgba(214, 58, 77, 0.12)',
  yellow: 'rgba(245, 166, 35, 0.12)',
  green: 'rgba(26, 158, 92, 0.12)',
  unscored: 'rgba(148, 163, 184, 0.12)',
};

const TIER_LABEL = { red: 'Red · Critical', yellow: 'Yellow · Watch', green: 'Green · Healthy', unscored: 'Unscored' };
const BAND_LABEL = { small: 'Small (<$500/mo)', medium: 'Medium ($500–$1.5K/mo)', large: 'Large (>$1.5K/mo)' };

// Bid-only overrides live in localStorage (written by the Customer Detail toggle).
// We read + listen for changes so the matrix updates instantly when you flip the
// switch on a customer's detail page in another tab.
const BID_ONLY_STORAGE_KEY = 'allmoxy.bid_only.pending';
function readBidOnlyOverrides(): Record<string, boolean> {
  try { const raw = localStorage.getItem(BID_ONLY_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

function bandKey(mrr: number): 'small' | 'medium' | 'large' {
  if (mrr < 500) return 'small';
  if (mrr < 1500) return 'medium';
  return 'large';
}

export default function ChurnRiskMatrix() {
  const { data, isLoading, error } = useSheetTab('churn_risk_matrix');
  const rawSnap = data as unknown as Snapshot | undefined;

  // Live bid-only overrides from localStorage. Polled every 1.5s so changes
  // made on the Customer Detail toggle reflect instantly here.
  const [bidOnlyOverrides, setBidOnlyOverrides] = useState<Record<string, boolean>>(() => readBidOnlyOverrides());
  useEffect(() => {
    const reload = () => setBidOnlyOverrides(readBidOnlyOverrides());
    window.addEventListener('storage', reload);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(t); };
  }, []);

  // Re-derive snap.customers + snap.matrix + snap.totals from raw with localStorage overrides applied.
  // Bid-only override: Signal 1 → +35, Signal 2 → +25, recompute total + tier + matrix cell.
  const snap = useMemo<Snapshot | undefined>(() => {
    if (!rawSnap) return undefined;
    const customers = rawSnap.customers.map((c) => {
      const aidKey = String(c.allmoxy_customer_id);
      const localOverride = bidOnlyOverrides[aidKey];
      const effectiveBidOnly = localOverride !== undefined ? localOverride : c.is_bid_only;
      // If override matches snapshot, no recompute needed
      if (effectiveBidOnly === c.is_bid_only) return c;
      // Otherwise: recompute with bid-only effect (or removal)
      const s1New = effectiveBidOnly ? 35 : (c.is_bid_only ? 0 : c.signal_1_orders);
      const s2New = effectiveBidOnly ? 25 : (c.is_bid_only ? 0 : c.signal_2_launch);
      const newTotal = s1New + s2New + c.signal_3_recency + c.signal_4_risk + c.signal_5_tenure;
      // Tier — use full-mode thresholds when bid-only ON (effectively full data)
      let newTier: typeof c.tier;
      if (effectiveBidOnly) {
        if (newTotal >= 70) newTier = 'green';
        else if (newTotal >= 40) newTier = 'yellow';
        else newTier = 'red';
      } else {
        // Bid-only being turned off: fall back to the original tier logic.
        // Without re-running the full scorer we can't perfectly recompute, so
        // approximate: re-tier from newTotal using the same thresholds.
        if (newTotal >= 70) newTier = 'green';
        else if (newTotal >= 40) newTier = 'yellow';
        else if (newTotal >= 0) newTier = 'yellow';
        else newTier = 'red';
      }
      return {
        ...c,
        signal_1_orders: s1New,
        signal_2_launch: s2New,
        total_score: newTotal,
        tier: newTier,
        is_bid_only: effectiveBidOnly,
        orders_label: effectiveBidOnly ? 'bid_only' : c.orders_label,
        orders_detail: effectiveBidOnly ? 'Marked as bid-only customer — uses Allmoxy primarily for quotes/bids' : c.orders_detail,
        launch_status: effectiveBidOnly ? 'bid_only_launched' : c.launch_status,
      };
    });
    // Rebuild matrix cells from the overridden customer list
    const matrix: Snapshot['matrix'] = {};
    for (const tier of ['red', 'yellow', 'green', 'unscored']) {
      for (const band of ['small', 'medium', 'large']) {
        matrix[`${tier}_${band}`] = { tier, band, count: 0, mrr_sum: 0, arr_at_risk_sum: 0, customer_ids: [] };
      }
    }
    for (const c of customers) {
      const key = `${c.tier}_${bandKey(c.current_subscription_mrr)}`;
      if (!matrix[key]) continue;
      matrix[key].count++;
      matrix[key].mrr_sum += c.current_subscription_mrr;
      matrix[key].arr_at_risk_sum += c.arr_at_risk;
      matrix[key].customer_ids.push(c.allmoxy_customer_id);
    }
    // Re-roll totals
    const totals: Snapshot['totals'] = {
      ...rawSnap.totals,
      red_count: customers.filter((c) => c.tier === 'red').length,
      yellow_count: customers.filter((c) => c.tier === 'yellow').length,
      green_count: customers.filter((c) => c.tier === 'green').length,
      unscored_count: customers.filter((c) => c.tier === 'unscored').length,
      red_mrr: customers.filter((c) => c.tier === 'red').reduce((s, c) => s + c.current_subscription_mrr, 0),
      yellow_mrr: customers.filter((c) => c.tier === 'yellow').reduce((s, c) => s + c.current_subscription_mrr, 0),
      green_mrr: customers.filter((c) => c.tier === 'green').reduce((s, c) => s + c.current_subscription_mrr, 0),
    };
    return { ...rawSnap, customers, matrix, totals };
  }, [rawSnap, bidOnlyOverrides]);

  const [tierFilter, setTierFilter] = useState<'all' | 'red' | 'yellow' | 'green' | 'unscored'>('all');
  const [cellFilter, setCellFilter] = useState<string | null>(null); // e.g. "red_large"
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Sort state for the attack list. Default = ARR at risk desc (highest stakes first).
  type SortKey = 'tier' | 'name' | 'owner' | 'mrr' | 'arr_at_risk' | 'score' | 'tenure';
  const [sortKey, setSortKey] = useState<SortKey>('arr_at_risk');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'name' || k === 'owner' ? 'asc' : 'desc'); }
  }

  // Owner counts for the filter chip strip (always based on the full cohort)
  const ownerCounts = useMemo(() => {
    if (!snap) return [] as Array<{ name: string; count: number }>;
    const m = new Map<string, number>();
    for (const c of snap.customers) {
      const key = c.owner_name || '(unassigned)';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [snap]);

  // Owner-filtered snapshot — re-rolls matrix cells + totals from the subset of
  // customers owned by the selected rep. When ownerFilter === 'all', uses snap
  // as-is. Powers the 3x3 grid, column totals, KPI tiles, and tier toggle counts.
  const viewSnap = useMemo(() => {
    if (!snap || ownerFilter === 'all') return snap;
    const customers = snap.customers.filter((c) => (c.owner_name || '(unassigned)') === ownerFilter);
    const matrix: Snapshot['matrix'] = {};
    for (const tier of ['red', 'yellow', 'green', 'unscored']) {
      for (const band of ['small', 'medium', 'large']) {
        matrix[`${tier}_${band}`] = { tier, band, count: 0, mrr_sum: 0, arr_at_risk_sum: 0, customer_ids: [] };
      }
    }
    for (const c of customers) {
      const key = `${c.tier}_${bandKey(c.current_subscription_mrr)}`;
      if (!matrix[key]) continue;
      matrix[key].count++;
      matrix[key].mrr_sum += c.current_subscription_mrr;
      matrix[key].arr_at_risk_sum += c.arr_at_risk;
      matrix[key].customer_ids.push(c.allmoxy_customer_id);
    }
    const totals: Snapshot['totals'] = {
      ...snap.totals,
      cohort_size: customers.length,
      red_count: customers.filter((c) => c.tier === 'red').length,
      yellow_count: customers.filter((c) => c.tier === 'yellow').length,
      green_count: customers.filter((c) => c.tier === 'green').length,
      unscored_count: customers.filter((c) => c.tier === 'unscored').length,
      red_mrr: customers.filter((c) => c.tier === 'red').reduce((s, c) => s + c.current_subscription_mrr, 0),
      yellow_mrr: customers.filter((c) => c.tier === 'yellow').reduce((s, c) => s + c.current_subscription_mrr, 0),
      green_mrr: customers.filter((c) => c.tier === 'green').reduce((s, c) => s + c.current_subscription_mrr, 0),
      total_mrr: customers.reduce((s, c) => s + c.current_subscription_mrr, 0),
      total_arr_at_risk: customers.reduce((s, c) => s + c.arr_at_risk, 0),
    };
    return { ...snap, customers, matrix, totals };
  }, [snap, ownerFilter]);

  const filtered = useMemo(() => {
    if (!snap) return [];
    let rows = snap.customers;
    if (cellFilter) {
      const ids = new Set(snap.matrix[cellFilter]?.customer_ids ?? []);
      rows = rows.filter((c) => ids.has(c.allmoxy_customer_id));
    } else if (tierFilter !== 'all') {
      rows = rows.filter((c) => c.tier === tierFilter);
    }
    if (ownerFilter !== 'all') {
      rows = rows.filter((c) => (c.owner_name || '(unassigned)') === ownerFilter);
    }
    return rows;
  }, [snap, tierFilter, cellFilter, ownerFilter]);

  // Apply current sort. Tier sorts in semantic risk order (red > yellow > green > unscored).
  const sorted = useMemo(() => {
    const tierRank = { red: 0, yellow: 1, green: 2, unscored: 3 } as const;
    const out = [...filtered];
    out.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case 'tier': av = tierRank[a.tier as keyof typeof tierRank] ?? 9; bv = tierRank[b.tier as keyof typeof tierRank] ?? 9; break;
        case 'name': av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); break;
        case 'owner': av = (a.owner_name || '~').toLowerCase(); bv = (b.owner_name || '~').toLowerCase(); break;
        case 'mrr': av = a.current_subscription_mrr; bv = b.current_subscription_mrr; break;
        case 'arr_at_risk': av = a.arr_at_risk; bv = b.arr_at_risk; break;
        case 'score': av = a.total_score; bv = b.total_score; break;
        case 'tenure': av = a.years_with_us ?? -1; bv = b.years_with_us ?? -1; break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  return (
    <Box>
      <PageHeader
        title="Churn Risk Matrix"
        subtitle="Every paying customer (active + at-risk, lifetime > $0) scored on a 5-signal health model (orders, launch, recency, risk signals, tenure). The matrix and attack list below surface customers most likely to churn — sorted by ARR at risk."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load churn_risk_matrix: {String(error)}</Alert>}

      {snap && snap.scoring_mode !== 'full' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Scoring mode: <strong>{snap.scoring_mode}</strong>. {!snap.totals.hubspot_signals_loaded && 'HubSpot signals not yet pulled (launch status, contact recency, note-based risk signals). '} {!snap.totals.order_data_loaded && 'Order volume data missing. '} Tier thresholds adapt — refresh after pulling HubSpot signals via the at-risk agent.
        </Alert>
      )}

      {/* Headline KPI tiles */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>ARR at risk</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'warning.main' }}>{USD0.format(viewSnap?.totals.total_arr_at_risk ?? 0)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  of {USD0.format((viewSnap?.totals.total_mrr ?? 0) * 12)} {ownerFilter === 'all' ? 'cohort' : `${ownerFilter}'s`} ARR ({viewSnap?.totals.cohort_size ?? 0} customers)
                </Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, borderLeft: '3px solid', borderColor: TIER_COLOR.red }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>🔴 Critical</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: TIER_COLOR.red }}>{viewSnap?.totals.red_count ?? 0}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(viewSnap?.totals.red_mrr ?? 0)}/mo MRR</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, borderLeft: '3px solid', borderColor: TIER_COLOR.yellow }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>🟡 Watch</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: TIER_COLOR.yellow }}>{viewSnap?.totals.yellow_count ?? 0}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(viewSnap?.totals.yellow_mrr ?? 0)}/mo MRR</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, borderLeft: '3px solid', borderColor: TIER_COLOR.green }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>🟢 Healthy</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: TIER_COLOR.green }}>{viewSnap?.totals.green_count ?? 0}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(viewSnap?.totals.green_mrr ?? 0)}/mo MRR</Typography>
              </>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* 3x3 Matrix */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Risk × Impact Matrix</Typography>
          <InfoIcon info={
            <>
              <strong>Y-axis (Impact):</strong> current MRR band — Small (&lt;$500), Medium ($500–$1.5K), Large (&gt;$1.5K).<br /><br />
              <strong>X-axis (Risk):</strong> health tier from the 5-signal scoring model. Thresholds adapt to which data is loaded:<br />
              <Box component="span" sx={{ display: 'inline-block', mt: 0.5, ml: 1, lineHeight: 1.7 }}>
                · <strong>Full</strong> (orders + HubSpot): 🟢 ≥70 · 🟡 40–69 · 🔴 &lt;40<br />
                · <strong>Orders only</strong> (no HubSpot signals): 🟢 ≥45 · 🟡 20–44 · 🔴 &lt;20<br />
                · <strong>HubSpot only</strong> (no order data): 🟢 ≥45 · 🟡 25–44 · 🔴 &lt;25<br />
                · <strong>No data</strong>: default 🟡 (insufficient evidence)
              </Box>
              <br /><br />
              Score is sum of 5 signals — Order Volume (max +35), Launch Status (+25), Engagement Recency (+20), Risk Signals (max −20), Tenure × Launch (max −15).<br /><br />
              Click any cell to drill into the customers in that bucket. Click again to clear the filter.
            </>
          } />
        </Stack>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 700 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ borderBottom: 'none', width: 140, fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>$ Impact ↓ · Risk →</TableCell>
                {(['red', 'yellow', 'green'] as const).map((tier) => (
                  <TableCell key={tier} align="center" sx={{ borderBottom: '2px solid', borderColor: TIER_COLOR[tier], fontWeight: 600, fontSize: 11, color: TIER_COLOR[tier], textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {TIER_LABEL[tier]}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {(['large', 'medium', 'small'] as const).map((band) => (
                <TableRow key={band}>
                  <TableCell sx={{ fontWeight: 600, fontSize: 12, color: 'text.secondary' }}>{BAND_LABEL[band]}</TableCell>
                  {(['red', 'yellow', 'green'] as const).map((tier) => {
                    const key = `${tier}_${band}`;
                    const cell = viewSnap?.matrix[key];
                    const active = cellFilter === key;
                    return (
                      <TableCell
                        key={key}
                        align="center"
                        onClick={() => { if ((cell?.count ?? 0) > 0) setCellFilter(active ? null : key); }}
                        sx={{
                          cursor: (cell?.count ?? 0) > 0 ? 'pointer' : 'default',
                          bgcolor: active ? TIER_COLOR[tier] : TIER_BG[tier],
                          color: active ? '#fff' : 'text.primary',
                          border: '1px solid',
                          borderColor: active ? TIER_COLOR[tier] : 'divider',
                          py: 2,
                          transition: 'all 0.15s',
                          '&:hover': { opacity: (cell?.count ?? 0) > 0 ? 0.85 : 1 },
                        }}
                      >
                        <Typography variant="h5" sx={{ fontWeight: 600, fontSize: 22 }}>{cell?.count ?? 0}</Typography>
                        <Typography variant="caption" sx={{ display: 'block', fontSize: 11, opacity: 0.85 }}>
                          {USD0.format((cell?.mrr_sum ?? 0))}/mo
                        </Typography>
                        {(cell?.arr_at_risk_sum ?? 0) > 0 && (
                          <Typography variant="caption" sx={{ display: 'block', fontSize: 10, opacity: 0.7 }}>
                            {USD0.format(cell?.arr_at_risk_sum ?? 0)} ARR at risk
                          </Typography>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
              {/* Column totals — sum of MRR and counts per tier across all bands */}
              <TableRow>
                <TableCell sx={{ fontWeight: 700, fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', borderTop: '2px solid', borderColor: 'divider' }}>
                  Column total
                </TableCell>
                {(['red', 'yellow', 'green'] as const).map((tier) => {
                  const totalCount = (['large', 'medium', 'small'] as const).reduce((s, band) => s + (viewSnap?.matrix[`${tier}_${band}`]?.count ?? 0), 0);
                  const totalMrr = (['large', 'medium', 'small'] as const).reduce((s, band) => s + (viewSnap?.matrix[`${tier}_${band}`]?.mrr_sum ?? 0), 0);
                  const totalArrAtRisk = (['large', 'medium', 'small'] as const).reduce((s, band) => s + (viewSnap?.matrix[`${tier}_${band}`]?.arr_at_risk_sum ?? 0), 0);
                  return (
                    <TableCell key={`${tier}_total`} align="center" sx={{ bgcolor: TIER_BG[tier], borderTop: '2px solid', borderColor: TIER_COLOR[tier], py: 2 }}>
                      <Typography variant="h6" sx={{ fontWeight: 700, fontSize: 18, color: TIER_COLOR[tier] }}>{USD0.format(totalMrr)}<Box component="span" sx={{ fontSize: 11, fontWeight: 400, color: 'text.secondary' }}>/mo</Box></Typography>
                      <Typography variant="caption" sx={{ display: 'block', fontSize: 11, color: 'text.secondary' }}>
                        {totalCount} customer{totalCount === 1 ? '' : 's'} · {USD0.format(totalMrr * 12)} ARR
                      </Typography>
                      {totalArrAtRisk > 0 && (
                        <Typography variant="caption" sx={{ display: 'block', fontSize: 10, color: 'warning.main' }}>
                          {USD0.format(totalArrAtRisk)} ARR at risk
                        </Typography>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableBody>
          </Table>
        </Box>
        {cellFilter && (
          <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
            Filtered to <strong>{cellFilter.replace('_', ' · ')}</strong> ({viewSnap?.matrix[cellFilter]?.count ?? 0} customers). Click the cell again to clear.
          </Typography>
        )}
      </Paper>

      {/* Filter toggle */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={tierFilter}
          onChange={(_, v) => { if (v) { setTierFilter(v); setCellFilter(null); } }}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="all">All ({viewSnap?.totals.cohort_size ?? 0})</ToggleButton>
          <ToggleButton value="red">🔴 Red ({viewSnap?.totals.red_count ?? 0})</ToggleButton>
          <ToggleButton value="yellow">🟡 Yellow ({viewSnap?.totals.yellow_count ?? 0})</ToggleButton>
          <ToggleButton value="green">🟢 Green ({viewSnap?.totals.green_count ?? 0})</ToggleButton>
        </ToggleButtonGroup>

        {/* Owner filter — chip strip */}
        {ownerCounts.length > 0 && (
          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5 }}>Owner</Typography>
            <Chip
              label={`All (${snap?.totals.cohort_size ?? 0})`}
              size="small"
              variant={ownerFilter === 'all' ? 'filled' : 'outlined'}
              onClick={() => setOwnerFilter('all')}
              sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
            />
            {ownerCounts.map((o) => {
              const isActive = ownerFilter === o.name;
              return (
                <Chip
                  key={o.name}
                  label={`${o.name} (${o.count})`}
                  size="small"
                  variant={isActive ? 'filled' : 'outlined'}
                  onClick={() => setOwnerFilter(isActive ? 'all' : o.name)}
                  sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
                />
              );
            })}
          </Stack>
        )}

        <Box sx={{ flexGrow: 1 }} />
        <CsvExportButton
          filename={`churn_risk_matrix_${new Date().toISOString().slice(0, 10)}`}
          columns={[
            { key: 'allmoxy_customer_id', label: 'Allmoxy ID' },
            { key: 'name', label: 'Customer' },
            { key: 'owner_name', label: 'Owner' },
            { key: 'tier', label: 'Tier' },
            { key: 'total_score', label: 'Score' },
            { key: 'current_subscription_mrr', label: 'Current MRR' },
            { key: 'arr_at_risk', label: 'ARR at Risk' },
            { key: 'lifetime_subscription', label: 'Lifetime $' },
            { key: 'years_with_us', label: 'Tenure (yrs)' },
            { key: 'primary_segment', label: 'Primary Segment' },
            { key: 'sub_segment', label: 'Sub Segment' },
            { key: 'orders_label', label: 'Order State' },
            { key: 'orders_current_year', label: 'Orders YTD' },
            { key: 'orders_prior_year', label: 'Orders Prior Yr' },
            { key: 'launch_status', label: 'Launch Status' },
            { key: 'days_since_last_contact', label: 'Days Since Contact' },
            { key: 'failed_3mo_count', label: 'Failed Charges (3mo)' },
            { key: 'signal_1_orders', label: 'S1 Orders' },
            { key: 'signal_2_launch', label: 'S2 Launch' },
            { key: 'signal_3_recency', label: 'S3 Recency' },
            { key: 'signal_4_risk', label: 'S4 Risk' },
            { key: 'signal_5_tenure', label: 'S5 Tenure' },
            { key: 'narrative', label: 'Narrative' },
            { key: 'hubspot_company_id', label: 'HubSpot ID' },
          ]}
          rows={filtered as unknown as Array<Record<string, unknown>>}
          label="Export risk matrix"
        />
      </Stack>

      {/* Attack list */}
      <Paper sx={{ p: 0 }}>
        {isLoading ? (
          <Skeleton variant="rectangular" height={400} />
        ) : filtered.length === 0 ? (
          <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>No customers match this filter.</Box>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sortDirection={sortKey === 'tier' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'tier'} direction={sortKey === 'tier' ? sortDir : 'desc'} onClick={() => toggleSort('tier')}>Tier</TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === 'name' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'name'} direction={sortKey === 'name' ? sortDir : 'asc'} onClick={() => toggleSort('name')}>Customer</TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === 'owner' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'owner'} direction={sortKey === 'owner' ? sortDir : 'asc'} onClick={() => toggleSort('owner')}>Owner</TableSortLabel>
                </TableCell>
                <TableCell align="right" sortDirection={sortKey === 'mrr' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'mrr'} direction={sortKey === 'mrr' ? sortDir : 'desc'} onClick={() => toggleSort('mrr')}>MRR</TableSortLabel>
                </TableCell>
                <TableCell align="right" sortDirection={sortKey === 'arr_at_risk' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'arr_at_risk'} direction={sortKey === 'arr_at_risk' ? sortDir : 'desc'} onClick={() => toggleSort('arr_at_risk')}>ARR at risk</TableSortLabel>
                </TableCell>
                <TableCell align="center" sortDirection={sortKey === 'score' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'score'} direction={sortKey === 'score' ? sortDir : 'desc'} onClick={() => toggleSort('score')}>Score</TableSortLabel>
                </TableCell>
                <TableCell align="center" sortDirection={sortKey === 'tenure' ? sortDir : false}>
                  <TableSortLabel active={sortKey === 'tenure'} direction={sortKey === 'tenure' ? sortDir : 'desc'} onClick={() => toggleSort('tenure')}>Tenure</TableSortLabel>
                </TableCell>
                <TableCell>Risk drivers</TableCell>
                <TableCell></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((c) => {
                const isExpanded = expandedRow === c.allmoxy_customer_id;
                const tierColor = TIER_COLOR[c.tier];
                return (
                  <>
                    <TableRow
                      key={c.allmoxy_customer_id}
                      hover
                      onClick={() => setExpandedRow(isExpanded ? null : c.allmoxy_customer_id)}
                      sx={{ cursor: 'pointer', '& > td': { borderBottom: isExpanded ? 'none' : undefined } }}
                    >
                      <TableCell>
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: tierColor, display: 'inline-block', mr: 1 }} />
                        <Typography variant="caption" sx={{ fontSize: 11, fontWeight: 600, color: tierColor, textTransform: 'uppercase' }}>
                          {c.tier}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 500 }}>
                        <CustomerLink id={c.allmoxy_customer_id} name={c.name} />
                        {c.primary_segment && (
                          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontSize: 11 }}>
                            {c.primary_segment}{c.sub_segment ? ` · ${c.sub_segment}` : ''}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ fontSize: 12 }}>{c.owner_name || <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>unassigned</Typography>}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(c.current_subscription_mrr)}</TableCell>
                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: c.arr_at_risk > 0 ? 'warning.main' : 'text.secondary' }}>{USD0.format(c.arr_at_risk)}</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 600, color: c.total_score < 0 ? 'error.main' : c.total_score < 25 ? 'warning.main' : 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{c.total_score}</TableCell>
                      <TableCell align="center" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{c.years_with_us != null ? c.years_with_us.toFixed(1) + 'y' : '—'}</TableCell>
                      <TableCell sx={{ fontSize: 11 }}>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {c.scoring_data_status === 'no_data' && <Chip label="Limited data" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(148, 163, 184, 0.25)', color: '#475569' }} title="Customer not in orders xlsx — defaulted to yellow pending verification" />}
                          {c.scoring_data_status === 'orders_only' && <Chip label="Orders only" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(148, 163, 184, 0.18)', color: '#475569' }} title="Scored from order data only — HubSpot signals not yet pulled" />}
                          {c.orders_label === 'gym_member' && <Chip label="Gym member" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(214, 58, 77, 0.18)', color: TIER_COLOR.red }} />}
                          {c.orders_label === 'dropped_off' && <Chip label="No 2026 orders" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(214, 58, 77, 0.18)', color: TIER_COLOR.red }} />}
                          {c.orders_label === 'declining' && <Chip label="Orders declining" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(245, 166, 35, 0.2)', color: TIER_COLOR.yellow }} />}
                          {c.failed_3mo_count > 0 && <Chip label={`${c.failed_3mo_count} failed charges`} size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(214, 58, 77, 0.18)', color: TIER_COLOR.red }} />}
                          {c.gym_member_cliff && <Chip label="24mo+ no launch" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(214, 58, 77, 0.18)', color: TIER_COLOR.red }} />}
                          {c.launch_status === 'not_launched' && <Chip label="Not launched" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(245, 166, 35, 0.2)', color: TIER_COLOR.yellow }} />}
                          {c.launch_status === 'cancelled' && <Chip label="Cancelled launch" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(214, 58, 77, 0.18)', color: TIER_COLOR.red }} />}
                          {c.days_since_last_contact != null && c.days_since_last_contact > 60 && <Chip label={`${c.days_since_last_contact}d no contact`} size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(245, 166, 35, 0.2)', color: TIER_COLOR.yellow }} />}
                          {(c.risk_signals?.length ?? 0) > 0 && <Chip label={`${c.risk_signals.length} risk signal${c.risk_signals.length > 1 ? 's' : ''}`} size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(214, 58, 77, 0.18)', color: TIER_COLOR.red }} />}
                        </Stack>
                      </TableCell>
                      <TableCell sx={{ fontSize: 10, color: 'text.secondary' }}>
                        {isExpanded ? '▲' : '▼'}
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow>
                        <TableCell colSpan={9} sx={{ bgcolor: 'rgba(0,0,0,0.02)', borderTop: '1px dashed', borderColor: tierColor }}>
                          <Stack spacing={1.5} sx={{ p: 1 }}>
                            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Score Breakdown</Typography>
                            <Table size="small" sx={{ '& td, & th': { fontSize: 11, py: 0.5 } }}>
                              <TableHead>
                                <TableRow>
                                  <TableCell>Signal</TableCell>
                                  <TableCell>Value</TableCell>
                                  <TableCell align="right">Score</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                <TableRow>
                                  <TableCell>1 · Order Volume</TableCell>
                                  <TableCell>{c.orders_detail}</TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 600 }}>{c.signal_1_orders >= 0 ? '+' : ''}{c.signal_1_orders}</TableCell>
                                </TableRow>
                                <TableRow>
                                  <TableCell>2 · Launch Status</TableCell>
                                  <TableCell>{c.launch_status}{c.launch_evidence ? `: ${c.launch_evidence.slice(0, 100)}` : ''}</TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 600 }}>{c.signal_2_launch >= 0 ? '+' : ''}{c.signal_2_launch}</TableCell>
                                </TableRow>
                                <TableRow>
                                  <TableCell>3 · Engagement Recency</TableCell>
                                  <TableCell>{c.days_since_last_contact != null ? `${c.days_since_last_contact} days since last contact` : '—'}</TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 600 }}>{c.signal_3_recency >= 0 ? '+' : ''}{c.signal_3_recency}</TableCell>
                                </TableRow>
                                <TableRow>
                                  <TableCell>4 · Risk Signals</TableCell>
                                  <TableCell>
                                    {(c.risk_signals?.length ?? 0) === 0 ? '—' : c.risk_signals.map((s, i) => (
                                      <Box key={i} sx={{ mb: 0.5 }}>
                                        <strong>{s.type}</strong> ({s.weight})
                                        {s.quote && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontStyle: 'italic', fontSize: 10 }}>"{s.quote.slice(0, 120)}"</Typography>}
                                      </Box>
                                    ))}
                                  </TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 600, color: c.signal_4_risk < 0 ? 'error.main' : 'text.secondary' }}>{c.signal_4_risk}</TableCell>
                                </TableRow>
                                <TableRow>
                                  <TableCell>5 · Tenure × Launch</TableCell>
                                  <TableCell>{c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y tenure, ${c.launch_status}` : '—'}</TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 600, color: c.signal_5_tenure < 0 ? 'error.main' : 'text.secondary' }}>{c.signal_5_tenure}</TableCell>
                                </TableRow>
                                <TableRow>
                                  <TableCell colSpan={2} sx={{ fontWeight: 700 }}>Total</TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 700, color: tierColor }}>{c.total_score}</TableCell>
                                </TableRow>
                              </TableBody>
                            </Table>
                            <Box>
                              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Quick Facts</Typography>
                              <Stack direction="row" spacing={2} flexWrap="wrap" sx={{ mt: 0.5 }}>
                                <Typography variant="caption">Lifetime ${c.lifetime_subscription.toLocaleString()}</Typography>
                                <Typography variant="caption">{c.orders_lifetime} lifetime orders</Typography>
                                <Typography variant="caption">Signed up {c.sign_up_date || '—'}</Typography>
                                {c.failed_3mo_count > 0 && <Typography variant="caption" sx={{ color: 'error.main' }}>{c.failed_3mo_count} failed charges (${c.failed_3mo_amount.toFixed(2)})</Typography>}
                                {c.hubspot_company_id && hubspotCompanyUrl(c.hubspot_company_id) && (
                                  <Link href={hubspotCompanyUrl(c.hubspot_company_id) ?? '#'} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 11 }}>
                                    Open in HubSpot →
                                  </Link>
                                )}
                              </Stack>
                            </Box>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Divider sx={{ my: 3 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', textAlign: 'center', fontSize: 11 }}>
        Scoring model from <code>allmoxy-monthly-dashboard</code> skill · 5 signals · Tier thresholds adapt to data availability · Refresh: {snap?.fetched_at ? new Date(snap.fetched_at).toLocaleString() : '—'}
      </Typography>
    </Box>
  );
}
