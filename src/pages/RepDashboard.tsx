import { useMemo, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import { useSearchParams } from 'react-router-dom';
import { LineChart, Line, BarChart, Bar, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';
import PageHeader from '../components/common/PageHeader';
import CustomerLink from '../components/common/CustomerLink';
import InfoIcon from '../components/common/InfoIcon';
import HubSpotIdLink from '../components/common/HubSpotIdLink';
import { useSheetTab } from '../hooks/useSheetTab';

type MonthlyCell = { subscription: number; services: number; connect: number; total: number };

type Profile = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_company_id: string | null;
  status: string;
  pay_status: string | null;
  primary_segment: string | null;
  instance_owner_first_name: string | null;
  instance_owner: string | null;
  current_subscription_mrr: number;
  lifetime_subscription: number;
  years_with_us: number | null;
  sign_up_date: string | null;
  last_payment_date: string | null;
  excluded_from_logo_count?: boolean;
  failed_3mo_count?: number;
  monthly_history: Record<string, MonthlyCell>;
};

type MatrixCustomer = {
  allmoxy_customer_id: number;
  name: string;
  owner_name: string | null;
  tier: 'red' | 'yellow' | 'green' | 'unscored';
  current_subscription_mrr: number;
  arr_at_risk: number;
  total_score: number;
  signal_1_orders: number;
  signal_2_launch: number;
  signal_3_recency: number;
  signal_4_risk: number;
  signal_5_tenure: number;
  days_since_last_contact: number | null;
  orders_label: string;
  risk_signals: Array<{ keyword: string; category: string; note_date?: string; snippet?: string }>;
  years_with_us: number | null;
};

type MatrixSnap = { customers: MatrixCustomer[] };

type TtvCustomer = {
  allmoxy_customer_id: number;
  owner_name: string | null;
  category: string;
  months_to_launch: number | null;
  is_launched: boolean;
};

type TtvSnap = { customers: TtvCustomer[] };

// Bid-only overrides live in localStorage (written by the Customer Detail
// toggle). Same key + read pattern as ChurnRiskMatrix and TimeToValue so all
// pages stay consistent when the user flips a customer to bid-only.
const BID_ONLY_STORAGE_KEY = 'allmoxy.bid_only.pending';
function readBidOnlyOverrides(): Record<string, boolean> {
  try { const raw = localStorage.getItem(BID_ONLY_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

const TIER_COLOR: Record<string, string> = {
  red: '#D63A4D', yellow: '#F5A623', green: '#2D8F47', unscored: '#94a3b8',
};
const TIER_LABEL: Record<string, string> = {
  red: 'Critical', yellow: 'Watch', green: 'Healthy', unscored: '—',
};

function repName(p: { instance_owner_first_name: string | null; instance_owner: string | null }): string {
  return p.instance_owner_first_name?.trim() || p.instance_owner?.trim() || '';
}

function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export default function RepDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: profilesData, isLoading: profilesLoading, error: profilesError } = useSheetTab<Profile>('customer_profiles');
  const matrixQuery = useSheetTab<MatrixSnap>('churn_risk_matrix');
  const ttvQuery = useSheetTab<TtvSnap>('time_to_value');
  const matrixRaw = matrixQuery.data as unknown as MatrixSnap | undefined;
  const ttvRaw = ttvQuery.data as unknown as TtvSnap | undefined;

  // Live bid-only overrides from localStorage — same listener pattern as
  // ChurnRiskMatrix + TimeToValue so flipping a customer to bid-only in
  // Customer Detail updates here within ~1.5s without a refresh.
  const [bidOnlyOverrides, setBidOnlyOverrides] = useState<Record<string, boolean>>(() => readBidOnlyOverrides());
  useEffect(() => {
    const reload = () => setBidOnlyOverrides(readBidOnlyOverrides());
    window.addEventListener('storage', reload);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(t); };
  }, []);

  // Apply bid-only overrides to the matrix customers: force S1=+35, S2=+25,
  // recompute total + tier using full-mode thresholds. Mirrors the transform
  // in ChurnRiskMatrix so all pages agree on which customers are healthy.
  const matrixCustomers = useMemo<MatrixCustomer[]>(() => {
    if (!matrixRaw?.customers) return [];
    return matrixRaw.customers.map((c) => {
      const aidKey = String(c.allmoxy_customer_id);
      const localOverride = bidOnlyOverrides[aidKey];
      const effectiveBidOnly = localOverride !== undefined ? localOverride : (c as MatrixCustomer & { is_bid_only?: boolean }).is_bid_only;
      const wasBidOnly = (c as MatrixCustomer & { is_bid_only?: boolean }).is_bid_only;
      if (effectiveBidOnly === wasBidOnly) return c;
      const s1New = effectiveBidOnly ? 35 : (wasBidOnly ? 0 : c.signal_1_orders);
      const s2New = effectiveBidOnly ? 25 : (wasBidOnly ? 0 : c.signal_2_launch);
      const s3 = c.signal_3_recency;
      // bid-only also forces engagement to max (silence = autonomous bid activity)
      const s3Effective = effectiveBidOnly ? 20 : s3;
      const s5 = c.signal_5_tenure;
      // bid-only waives the gym-member penalty
      const s5Effective = effectiveBidOnly && s5 < 0 ? 0 : s5;
      const newTotal = s1New + s2New + s3Effective + c.signal_4_risk + s5Effective;
      let newTier: MatrixCustomer['tier'];
      if (newTotal >= 70) newTier = 'green';
      else if (newTotal >= 40) newTier = 'yellow';
      else newTier = 'red';
      return {
        ...c,
        signal_1_orders: s1New,
        signal_2_launch: s2New,
        signal_3_recency: s3Effective,
        signal_5_tenure: s5Effective,
        total_score: newTotal,
        tier: newTier,
        orders_label: effectiveBidOnly ? 'bid_only' : c.orders_label,
      } as MatrixCustomer;
    });
  }, [matrixRaw, bidOnlyOverrides]);

  const profiles = profilesData?.rows ?? [];

  // Owners sorted by book size (paying-customer count)
  const ownerOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of profiles) {
      if (p.status === 'churned' || p.status === 'never_paid') continue;
      if ((p.lifetime_subscription || 0) <= 0) continue;
      const o = repName(p);
      if (!o) continue;
      m.set(o, (m.get(o) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  }, [profiles]);

  // Rep from URL ?rep= or default to 'all' when data loads.
  // 'all' = roll-up across every rep (no owner filter applied).
  const selectedRep = searchParams.get('rep') ?? '';
  const isAll = selectedRep === 'all';
  useEffect(() => {
    if (!selectedRep && ownerOptions.length > 0) {
      setSearchParams({ rep: 'all' }, { replace: true });
    }
  }, [selectedRep, ownerOptions, setSearchParams]);

  function pickRep(name: string) {
    setSearchParams({ rep: name }, { replace: true });
  }

  // A rep's book = every non-churned account they own that has paid
  // subscription history. This matches the badge count exactly, so accounts
  // whose current pay_status is blank/unset in HubSpot (but who are paying)
  // still show up — rather than only customers whose pay_status is one of the
  // "Active*" values. When 'all', no owner filter.
  const book = useMemo(
    () => profiles.filter((p) => {
      if (p.status === 'churned' || p.status === 'never_paid') return false;
      if ((p.lifetime_subscription || 0) <= 0) return false;
      if (isAll) return true;
      return repName(p) === selectedRep;
    }),
    [profiles, selectedRep, isAll],
  );

  // Card-failure subset — customers a rep should call to get their payment
  // method updated. Separate panel below the attack list.
  const cardFailureBook = useMemo(
    () => book.filter((p) => p.pay_status === 'Active - Card Failure'),
    [book],
  );

  // Sort state for the Card Failure table. Default = MRR desc (biggest $
  // recovery opportunities first).
  type CfSortKey = 'name' | 'owner' | 'mrr' | 'last_payment' | 'failed_3mo' | 'tenure';
  const [cfSortKey, setCfSortKey] = useState<CfSortKey>('mrr');
  const [cfSortDir, setCfSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleCfSort(k: CfSortKey) {
    if (cfSortKey === k) setCfSortDir(cfSortDir === 'asc' ? 'desc' : 'asc');
    else {
      setCfSortKey(k);
      setCfSortDir(k === 'name' || k === 'owner' ? 'asc' : 'desc');
    }
  }
  const cardFailureSorted = useMemo(() => {
    const out = [...cardFailureBook];
    out.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (cfSortKey) {
        case 'name': av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); break;
        case 'owner': av = repName(a).toLowerCase() || '~'; bv = repName(b).toLowerCase() || '~'; break;
        case 'mrr': av = a.current_subscription_mrr || 0; bv = b.current_subscription_mrr || 0; break;
        case 'last_payment': av = a.last_payment_date || ''; bv = b.last_payment_date || ''; break;
        case 'failed_3mo': av = a.failed_3mo_count ?? -1; bv = b.failed_3mo_count ?? -1; break;
        case 'tenure': av = a.years_with_us ?? -1; bv = b.years_with_us ?? -1; break;
      }
      if (av < bv) return cfSortDir === 'asc' ? -1 : 1;
      if (av > bv) return cfSortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [cardFailureBook, cfSortKey, cfSortDir]);
  const bookIds = useMemo(() => new Set(book.map((p) => p.allmoxy_customer_id)), [book]);

  // Filter the (override-adjusted) matrix to their book
  const matrixForRep = useMemo(
    () => matrixCustomers.filter((c) => bookIds.has(c.allmoxy_customer_id)),
    [matrixCustomers, bookIds],
  );

  // Drilldown panel — when the user clicks Book / At Risk / Healthy KPI tiles,
  // a collapsible table opens below the metrics with the matching customers.
  type DrillKey = 'book' | 'at_risk' | 'healthy';
  const [drilldown, setDrilldown] = useState<DrillKey | null>(null);
  function toggleDrilldown(k: DrillKey) {
    setDrilldown(drilldown === k ? null : k);
  }
  type DrillSortKey = 'name' | 'owner' | 'tier' | 'status' | 'pay_status' | 'mrr' | 'arr_at_risk' | 'tenure';
  const [drillSortKey, setDrillSortKey] = useState<DrillSortKey>('mrr');
  const [drillSortDir, setDrillSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleDrillSort(k: DrillSortKey) {
    if (drillSortKey === k) setDrillSortDir(drillSortDir === 'asc' ? 'desc' : 'asc');
    else {
      setDrillSortKey(k);
      setDrillSortDir(k === 'name' || k === 'owner' || k === 'status' || k === 'pay_status' || k === 'tier' ? 'asc' : 'desc');
    }
  }
  const matrixByAid = useMemo(() => {
    const m = new Map<number, MatrixCustomer>();
    for (const c of matrixForRep) m.set(c.allmoxy_customer_id, c);
    return m;
  }, [matrixForRep]);
  type DrillRow = {
    aid: number;
    name: string;
    ownerName: string;
    tier: MatrixCustomer['tier'] | null;
    status: string;
    payStatus: string | null;
    mrr: number;
    arrAtRisk: number;
    daysSinceContact: number | null;
    hubspot_company_id: string | null;
    yearsWithUs: number | null;
  };
  const drillRows = useMemo<DrillRow[]>(() => {
    if (!drilldown) return [];
    let source: Array<{ profile?: Profile; matrix?: MatrixCustomer }> = [];
    if (drilldown === 'book') {
      source = book.map((p) => ({ profile: p, matrix: matrixByAid.get(p.allmoxy_customer_id) }));
    } else {
      const tier = drilldown === 'at_risk' ? 'red' : 'green';
      const profileByAid = new Map<number, Profile>();
      for (const p of book) profileByAid.set(p.allmoxy_customer_id, p);
      source = matrixForRep.filter((c) => c.tier === tier).map((c) => ({ profile: profileByAid.get(c.allmoxy_customer_id), matrix: c }));
    }
    const rows: DrillRow[] = source.map(({ profile, matrix }) => ({
      aid: matrix?.allmoxy_customer_id ?? profile!.allmoxy_customer_id,
      name: matrix?.name ?? profile?.name ?? '',
      ownerName: profile ? repName(profile) : (matrix?.owner_name ?? ''),
      tier: matrix?.tier ?? null,
      status: profile?.status ?? '',
      payStatus: profile?.pay_status ?? null,
      mrr: profile?.current_subscription_mrr ?? matrix?.current_subscription_mrr ?? 0,
      arrAtRisk: matrix?.arr_at_risk ?? 0,
      daysSinceContact: matrix?.days_since_last_contact ?? null,
      hubspot_company_id: profile?.hubspot_company_id ?? null,
      yearsWithUs: profile?.years_with_us ?? matrix?.years_with_us ?? null,
    }));
    const tierRank = { red: 0, yellow: 1, green: 2, unscored: 3 } as const;
    rows.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (drillSortKey) {
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'owner': av = (a.ownerName || '~').toLowerCase(); bv = (b.ownerName || '~').toLowerCase(); break;
        case 'tier': av = tierRank[(a.tier ?? 'unscored') as keyof typeof tierRank] ?? 9; bv = tierRank[(b.tier ?? 'unscored') as keyof typeof tierRank] ?? 9; break;
        case 'status': av = a.status; bv = b.status; break;
        case 'pay_status': av = (a.payStatus || '').toLowerCase(); bv = (b.payStatus || '').toLowerCase(); break;
        case 'mrr': av = a.mrr; bv = b.mrr; break;
        case 'arr_at_risk': av = a.arrAtRisk; bv = b.arrAtRisk; break;
        case 'tenure': av = a.yearsWithUs ?? -1; bv = b.yearsWithUs ?? -1; break;
      }
      if (av < bv) return drillSortDir === 'asc' ? -1 : 1;
      if (av > bv) return drillSortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return rows;
  }, [drilldown, book, matrixForRep, matrixByAid, drillSortKey, drillSortDir]);

  // Top-line KPIs
  const kpis = useMemo(() => {
    // book is already filtered to actively-paying pay_status values
    const totalMrr = book.reduce((s, p) => s + (p.current_subscription_mrr || 0), 0);
    const tierCount = (t: string) => matrixForRep.filter((c) => c.tier === t).length;
    const tierMrr = (t: string) => matrixForRep
      .filter((c) => c.tier === t)
      .reduce((s, c) => s + (c.current_subscription_mrr || 0), 0);
    const arrAtRisk = matrixForRep.reduce((s, c) => s + (c.arr_at_risk || 0), 0);
    // Recently-churned for the "Churned (last 90d)" KPI — pull from the rep's
    // full owner set (not the active-book filter, since book excludes churned).
    const churnedRecent = profiles.filter((p) =>
      p.status === 'churned'
      && (isAll || repName(p) === selectedRep)
      && p.last_payment_date && isWithinDays(p.last_payment_date, 90)
    );
    const churnedMrrLast90 = churnedRecent.reduce((s, p) => {
      // Use their pre-churn MRR — find the last month with subscription > 0 in monthly_history
      const months = Object.keys(p.monthly_history || {}).sort();
      for (let i = months.length - 1; i >= 0; i--) {
        const m = p.monthly_history[months[i]];
        if (m && (m.subscription || 0) > 0) return s + (m.subscription || 0);
      }
      return s;
    }, 0);
    const recencies = matrixForRep
      .map((c) => c.days_since_last_contact)
      .filter((v): v is number => v != null);
    const avgRecency = recencies.length === 0 ? null : Math.round(recencies.reduce((a, b) => a + b, 0) / recencies.length);
    return {
      bookCount: book.length,
      totalMrr,
      arr: totalMrr * 12,
      arrAtRisk,
      redCount: tierCount('red'),
      redMrr: tierMrr('red'),
      yellowCount: tierCount('yellow'),
      yellowMrr: tierMrr('yellow'),
      greenCount: tierCount('green'),
      greenMrr: tierMrr('green'),
      churnedLast90Count: churnedRecent.length,
      churnedLast90Mrr: churnedMrrLast90,
      avgDaysSinceContact: avgRecency,
    };
  }, [book, matrixForRep]);

  // 12-month MRR trend: sum each month's subscription across the rep's customers.
  // IMPORTANT: trend uses the FULL owner set (including churned customers) so
  // that historical months reflect what the rep's book actually looked like
  // back then — excluding churned customers would make their MRR retroactively
  // disappear from prior months and overstate growth.
  // Two corrections from a naive sum:
  //   1. monthly_history extends INTO THE FUTURE for customers on annual
  //      prepayment (amortized forward). Skip months > current month.
  //   2. The current month is PARTIAL — many customers haven't been billed
  //      yet, so it falsely shows a steep drop. End the trend at the LAST
  //      COMPLETE month (current month - 1).
  const historicalSet = useMemo(
    () => profiles.filter((p) => (p.lifetime_subscription || 0) > 0 && (isAll || repName(p) === selectedRep)),
    [profiles, selectedRep, isAll],
  );
  const mrrTrend = useMemo(() => {
    if (historicalSet.length === 0) return [] as Array<{ month: string; mrr: number; logos: number }>;
    const now = new Date();
    const lastCompleteDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastCompleteKey = `${lastCompleteDate.getFullYear()}-${String(lastCompleteDate.getMonth() + 1).padStart(2, '0')}`;
    const monthAgg = new Map<string, { mrr: number; logos: number }>();
    for (const p of historicalSet) {
      for (const [month, cell] of Object.entries(p.monthly_history || {})) {
        if (month > lastCompleteKey) continue;
        const sub = cell?.subscription || 0;
        if (sub <= 0) continue;
        const e = monthAgg.get(month) ?? { mrr: 0, logos: 0 };
        e.mrr += sub;
        e.logos += 1;
        monthAgg.set(month, e);
      }
    }
    const all = [...monthAgg.entries()]
      .map(([month, v]) => ({ month, mrr: Math.round(v.mrr * 100) / 100, logos: v.logos }))
      .sort((a, b) => a.month.localeCompare(b.month));
    return all.slice(-12);
  }, [historicalSet]);

  // Their attack list (red + yellow, sorted by ARR at risk desc)
  const attackList = useMemo(() => {
    return matrixForRep
      .filter((c) => c.tier === 'red' || c.tier === 'yellow')
      .sort((a, b) => (b.arr_at_risk || 0) - (a.arr_at_risk || 0))
      .slice(0, 25);
  }, [matrixForRep]);

  // TTV distribution histogram for their book (launched customers only)
  const ttvBuckets = useMemo(() => {
    const samples = (ttvRaw?.customers ?? [])
      .filter((c) => bookIds.has(c.allmoxy_customer_id) && c.is_launched && c.months_to_launch != null && c.months_to_launch >= 0)
      .map((c) => c.months_to_launch as number)
      .sort((a, b) => a - b);
    const buckets: Record<string, number> = { '0-3': 0, '4-6': 0, '7-12': 0, '13-18': 0, '19-24': 0, '25+': 0 };
    for (const m of samples) {
      if (m <= 3) buckets['0-3']++;
      else if (m <= 6) buckets['4-6']++;
      else if (m <= 12) buckets['7-12']++;
      else if (m <= 18) buckets['13-18']++;
      else if (m <= 24) buckets['19-24']++;
      else buckets['25+']++;
    }
    const median = samples.length === 0
      ? null
      : samples.length % 2 === 1
        ? samples[Math.floor(samples.length / 2)]
        : Math.round((samples[samples.length / 2 - 1] + samples[samples.length / 2]) / 2);
    const p90 = samples.length === 0 ? null : samples[Math.min(samples.length - 1, Math.floor(0.9 * samples.length))];
    return {
      data: Object.entries(buckets).map(([range, count]) => ({ range, count })),
      samples: samples.length,
      median,
      p90,
    };
  }, [ttvRaw, bookIds]);

  // Risk signal breakdown across their book
  const riskBreakdown = useMemo(() => {
    const byCat = new Map<string, number>();
    let totalSignals = 0;
    for (const c of matrixForRep) {
      for (const s of c.risk_signals || []) {
        byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
        totalSignals++;
      }
    }
    return { byCat: [...byCat.entries()].sort((a, b) => b[1] - a[1]), totalSignals };
  }, [matrixForRep]);

  const isLoading = profilesLoading || matrixQuery.isLoading || ttvQuery.isLoading;
  const error = profilesError;

  return (
    <Box>
      <PageHeader
        title="Rep Dashboard"
        subtitle="Customer Success dashboard. Pick a rep to see their book, their churn risk picture, and their top intervention targets — or select All for a rolled-up view."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load customer_profiles: {String(error)}</Alert>}

      {/* Rep picker */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5 }}>Rep</Typography>
          {ownerOptions.length === 0 && !isLoading && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>No reps found in instance_owner data.</Typography>
          )}
          {ownerOptions.length > 0 && (
            <Chip
              label={`All (${ownerOptions.reduce((s, o) => s + o.count, 0)})`}
              size="small"
              onClick={() => pickRep('all')}
              variant={isAll ? 'filled' : 'outlined'}
              color={isAll ? 'primary' : 'default'}
              sx={{ height: 26, fontSize: 12, fontWeight: 600 }}
            />
          )}
          {ownerOptions.map((o) => (
            <Chip
              key={o.name}
              label={`${o.name} (${o.count})`}
              size="small"
              onClick={() => pickRep(o.name)}
              variant={selectedRep === o.name ? 'filled' : 'outlined'}
              color={selectedRep === o.name ? 'primary' : 'default'}
              sx={{ height: 26, fontSize: 12 }}
            />
          ))}
        </Stack>
      </Paper>

      {!selectedRep && !isLoading && (
        <Paper sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
          Pick a rep above (or All) to load the dashboard.
        </Paper>
      )}

      {selectedRep && (
        <>
          {/* KPI strip */}
          <Grid container spacing={2} sx={{ mb: 3 }} alignItems="stretch">
            <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
              <Paper
                onClick={() => toggleDrilldown('book')}
                sx={{ p: 2.5, flexGrow: 1, cursor: 'pointer', transition: 'all 0.15s', outline: drilldown === 'book' ? '2px solid' : 'none', outlineColor: 'primary.main', '&:hover': { bgcolor: 'action.hover' } }}
              >
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Book {drilldown === 'book' ? '▾' : '▸'}</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500 }}>{kpis.bookCount}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {USD0.format(kpis.totalMrr)}/mo · {USD0.format(kpis.arr)} ARR
                    </Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
              <Paper
                onClick={() => toggleDrilldown('at_risk')}
                sx={{ p: 2.5, flexGrow: 1, borderLeft: '3px solid', borderColor: TIER_COLOR.red, cursor: 'pointer', transition: 'all 0.15s', outline: drilldown === 'at_risk' ? '2px solid' : 'none', outlineColor: TIER_COLOR.red, '&:hover': { bgcolor: 'action.hover' } }}
              >
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>🔴 At risk {drilldown === 'at_risk' ? '▾' : '▸'}</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500, color: TIER_COLOR.red }}>{kpis.redCount}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {USD0.format(kpis.redMrr)}/mo · {USD0.format(kpis.redMrr * 12)} ARR
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'warning.main', fontWeight: 600, display: 'block', fontSize: 11 }}>
                      {USD0.format(kpis.arrAtRisk)} ARR exposure
                    </Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
              <Paper
                onClick={() => toggleDrilldown('healthy')}
                sx={{ p: 2.5, flexGrow: 1, borderLeft: '3px solid', borderColor: TIER_COLOR.green, cursor: 'pointer', transition: 'all 0.15s', outline: drilldown === 'healthy' ? '2px solid' : 'none', outlineColor: TIER_COLOR.green, '&:hover': { bgcolor: 'action.hover' } }}
              >
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>🟢 Healthy {drilldown === 'healthy' ? '▾' : '▸'}</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500, color: TIER_COLOR.green }}>{kpis.greenCount}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {USD0.format(kpis.greenMrr)}/mo · {USD0.format(kpis.greenMrr * 12)} ARR
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 11 }}>
                      {kpis.yellowCount} watch · {kpis.greenCount + kpis.yellowCount + kpis.redCount} scored
                    </Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
              <Paper sx={{ p: 2.5, flexGrow: 1 }}>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Time to Value</Typography>
                  <InfoIcon info={`Median months from first payment to Live Date among ${ttvBuckets.samples} launched customers ${isAll ? 'across all reps' : "in this rep's book"}.`} />
                </Stack>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500 }}>{ttvBuckets.median ?? '—'} mo</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      p90: {ttvBuckets.p90 ?? '—'} mo · {ttvBuckets.samples} launched
                    </Typography>
                  </>
                )}
              </Paper>
            </Grid>
          </Grid>

          {/* Second KPI strip — operational. alignItems="stretch" makes the
              wider Risk-signals tile match the height of the two smaller tiles
              to its left (default would be auto-height per content). */}
          <Grid container spacing={2} sx={{ mb: 3 }} alignItems="stretch">
            <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
              <Paper sx={{ p: 2.5, flexGrow: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Avg days since contact</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500 }}>{kpis.avgDaysSinceContact ?? '—'}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>Across {matrixForRep.length} active accounts</Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
              <Paper sx={{ p: 2.5, flexGrow: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Churned (last 90d)</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
                  <>
                    <Typography variant="h4" sx={{ fontWeight: 500, color: kpis.churnedLast90Count > 0 ? 'error.main' : 'text.primary' }}>{kpis.churnedLast90Count}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(kpis.churnedLast90Mrr)}/mo lost</Typography>
                  </>
                )}
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={6} sx={{ display: 'flex' }}>
              <Paper sx={{ p: 2.5, flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Risk signals flagged (in HubSpot notes)</Typography>
                {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : riskBreakdown.totalSignals === 0 ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary', mt: 1 }}>None in last 180 days.</Typography>
                ) : (
                  <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
                    {riskBreakdown.byCat.map(([cat, n]) => {
                      const palette: Record<string, { bg: string; color: string }> = {
                        cancel_intent: { bg: '#fee2e2', color: '#991b1b' },
                        competitor: { bg: '#fef3c7', color: '#92400e' },
                        dissatisfaction: { bg: '#fde2e1', color: '#9b1c1c' },
                        disengagement: { bg: '#fef3c7', color: '#92400e' },
                        pricing_pressure: { bg: '#e0e7ff', color: '#3730a3' },
                      };
                      const c = palette[cat] || { bg: '#e5e7eb', color: '#1f2937' };
                      return (
                        <Chip
                          key={cat}
                          label={`${cat.replace('_', ' ')} · ${n}`}
                          size="small"
                          sx={{ bgcolor: c.bg, color: c.color, fontSize: 11, fontWeight: 600, height: 22 }}
                        />
                      );
                    })}
                  </Stack>
                )}
              </Paper>
            </Grid>
          </Grid>

          {/* Drill-down panel — opens when Book / At risk / Healthy KPI tile is clicked */}
          <Collapse in={drilldown !== null} timeout="auto" unmountOnExit>
            {drilldown && (() => {
              const title = drilldown === 'book' ? 'Book' : drilldown === 'at_risk' ? '🔴 At Risk' : '🟢 Healthy';
              const accent = drilldown === 'at_risk' ? TIER_COLOR.red : drilldown === 'healthy' ? TIER_COLOR.green : 'primary.main';
              const totalMrr = drillRows.reduce((s, r) => s + r.mrr, 0);
              const totalArrAtRisk = drillRows.reduce((s, r) => s + r.arrAtRisk, 0);
              return (
                <Paper sx={{ p: 3, mb: 3, borderTop: '3px solid', borderColor: accent }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{title}{!isAll && ` — ${selectedRep}'s book`}</Typography>
                    <Chip
                      label={`${drillRows.length} customer${drillRows.length === 1 ? '' : 's'} · ${USD0.format(totalMrr)}/mo${drilldown === 'at_risk' ? ` · ${USD0.format(totalArrAtRisk)} ARR at risk` : ''}`}
                      size="small"
                      sx={{ fontWeight: 600, fontSize: 11, height: 22 }}
                    />
                    <Box sx={{ flexGrow: 1 }} />
                    <IconButton size="small" onClick={() => setDrilldown(null)} aria-label="Close drilldown">
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                  {drillRows.length === 0 ? (
                    <Typography variant="body2" sx={{ color: 'text.secondary', py: 2, textAlign: 'center' }}>
                      No customers in this bucket.
                    </Typography>
                  ) : (
                    <Box sx={{ overflowX: 'auto' }}>
                      <Table size="small" sx={{ minWidth: 1000 }}>
                        <TableHead>
                          <TableRow>
                            <DrillSortHead label="Customer" k="name" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} />
                            <DrillSortHead label="Owner" k="owner" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} />
                            <DrillSortHead label="Tier" k="tier" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} />
                            <DrillSortHead label="Status" k="status" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} />
                            <DrillSortHead label="Pay status" k="pay_status" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} />
                            <DrillSortHead label="MRR" k="mrr" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} align="right" />
                            {drilldown === 'at_risk' && (
                              <DrillSortHead label="ARR at risk" k="arr_at_risk" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} align="right" />
                            )}
                            <DrillSortHead label="Tenure" k="tenure" active={drillSortKey} dir={drillSortDir} onClick={toggleDrillSort} align="right" />
                            <TableCell align="right" sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>HubSpot</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {drillRows.map((r) => (
                            <TableRow key={r.aid} hover>
                              <TableCell sx={{ fontWeight: 500 }}>
                                <CustomerLink id={r.aid} name={r.name} />
                              </TableCell>
                              <TableCell sx={{ fontSize: 12 }}>{r.ownerName || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                              <TableCell sx={{ fontSize: 12 }}>
                                {r.tier ? (
                                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: TIER_COLOR[r.tier], fontWeight: 600 }}>
                                    <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: TIER_COLOR[r.tier] }} />
                                    {TIER_LABEL[r.tier]}
                                  </Box>
                                ) : <Typography variant="caption" sx={{ color: 'text.disabled' }}>—</Typography>}
                              </TableCell>
                              <TableCell sx={{ fontSize: 12 }}>{r.status}</TableCell>
                              <TableCell sx={{ fontSize: 12 }}>{r.payStatus || '—'}</TableCell>
                              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(r.mrr)}</TableCell>
                              {drilldown === 'at_risk' && (
                                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: r.arrAtRisk > 0 ? 'warning.main' : 'text.secondary', fontWeight: 600 }}>{USD0.format(r.arrAtRisk)}</TableCell>
                              )}
                              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{r.yearsWithUs != null ? `${r.yearsWithUs.toFixed(1)}y` : '—'}</TableCell>
                              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                                <HubSpotIdLink id={r.hubspot_company_id} showIcon />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Box>
                  )}
                </Paper>
              );
            })()}
          </Collapse>

          {/* MRR trend */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>MRR Trend — last 12 months</Typography>
              <InfoIcon info={`Subscription MRR contributed by ${isAll ? 'every paying customer' : `${selectedRep}'s book`} each month. Sum of per-customer subscription history. Ends at the last COMPLETE month — the current month is excluded because not every customer has been billed yet, which would falsely show a drop.`} />
            </Stack>
            {isLoading ? <Skeleton variant="rectangular" height={260} /> : mrrTrend.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>No MRR history available.</Typography>
            ) : (
              <Box sx={{ height: 260 }}>
                <ResponsiveContainer>
                  <LineChart data={mrrTrend} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(0,0,0,0.06)" />
                    <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => USD_COMPACT.format(v)} />
                    <RTooltip
                      formatter={(value: number, name: string) => name === 'mrr' ? [USD0.format(value), 'MRR'] : [value, 'Logos']}
                      labelFormatter={(l) => monthLabel(String(l))}
                    />
                    <Line type="monotone" dataKey="mrr" stroke="#2C73FF" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </Box>
            )}
          </Paper>

          {/* Attack list */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Today's Call List</Typography>
              <InfoIcon info="Red and yellow customers in this rep's book, sorted by ARR at risk. Start here every morning. Click a name to open the full Customer Detail." />
            </Stack>
            {attackList.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', py: 2, textAlign: 'center' }}>No red or yellow customers {isAll ? 'in the cohort' : "in this rep's book"}. 🎉</Typography>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 900 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Tier</TableCell>
                      <TableCell sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Customer</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>MRR</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ARR at risk</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Score</TableCell>
                      <TableCell align="right" sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Days since contact</TableCell>
                      <TableCell sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Why</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {attackList.map((c) => (
                      <TableRow key={c.allmoxy_customer_id} hover>
                        <TableCell>
                          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: TIER_COLOR[c.tier], fontWeight: 600, fontSize: 12 }}>
                            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: TIER_COLOR[c.tier] }} />
                            {TIER_LABEL[c.tier]}
                          </Box>
                        </TableCell>
                        <TableCell sx={{ fontWeight: 500 }}>
                          <CustomerLink id={c.allmoxy_customer_id} name={c.name} />
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(c.current_subscription_mrr || 0)}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: c.arr_at_risk > 0 ? 'warning.main' : 'text.secondary', fontWeight: 600 }}>{USD0.format(c.arr_at_risk || 0)}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{c.total_score}</TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: (c.days_since_last_contact ?? 0) > 60 ? 'warning.main' : 'text.secondary' }}>{c.days_since_last_contact ?? '—'}</TableCell>
                        <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>
                          {(c.risk_signals && c.risk_signals.length > 0)
                            ? c.risk_signals.slice(0, 2).map((s) => s.keyword).join(', ')
                            : c.orders_label?.replace('_', ' ') || ''}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Paper>

          {/* Card Failure recovery — customers whose payment failed; rep should
              reach out to get a new payment method on file before they churn. */}
          <Paper sx={{ p: 3, mb: 3, borderLeft: '3px solid', borderColor: 'warning.main' }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>💳 Card Failure — Reach out to fix billing</Typography>
              <Chip
                label={`${cardFailureBook.length} customer${cardFailureBook.length === 1 ? '' : 's'} · ${USD0.format(cardFailureBook.reduce((s, p) => s + (p.current_subscription_mrr || 0), 0))}/mo MRR at risk`}
                size="small"
                sx={{ bgcolor: '#fef3c7', color: '#92400e', fontWeight: 600, fontSize: 11, height: 22 }}
              />
              <InfoIcon info="HubSpot pay_status='Active - Card Failure'. Their last charge bounced — call them, get a new card on file. These are easy wins. If you don't fix it, they'll roll into churned status." />
            </Stack>
            {cardFailureBook.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', py: 2, textAlign: 'center' }}>No card failures right now. 💪</Typography>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 800 }}>
                  <TableHead>
                    <TableRow>
                      <CfSortHead label="Customer" k="name" active={cfSortKey} dir={cfSortDir} onClick={toggleCfSort} />
                      <CfSortHead label="Owner" k="owner" active={cfSortKey} dir={cfSortDir} onClick={toggleCfSort} />
                      <CfSortHead label="MRR" k="mrr" active={cfSortKey} dir={cfSortDir} onClick={toggleCfSort} align="right" />
                      <CfSortHead label="Last payment" k="last_payment" active={cfSortKey} dir={cfSortDir} onClick={toggleCfSort} align="right" />
                      <CfSortHead label="Failed 3mo" k="failed_3mo" active={cfSortKey} dir={cfSortDir} onClick={toggleCfSort} align="right" />
                      <CfSortHead label="Tenure" k="tenure" active={cfSortKey} dir={cfSortDir} onClick={toggleCfSort} />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {cardFailureSorted
                      .map((c) => (
                        <TableRow key={c.allmoxy_customer_id} hover>
                          <TableCell sx={{ fontWeight: 500 }}>
                            <CustomerLink id={c.allmoxy_customer_id} name={c.name} />
                          </TableCell>
                          <TableCell sx={{ fontSize: 12 }}>{repName(c) || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(c.current_subscription_mrr || 0)}</TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: 'text.secondary' }}>{c.last_payment_date ?? '—'}</TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: 'warning.main' }}>{c.failed_3mo_count ?? '—'}</TableCell>
                          <TableCell sx={{ fontSize: 12 }}>{c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y` : '—'}</TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Paper>

          {/* TTV histogram */}
          {ttvBuckets.samples > 0 && (
            <Paper sx={{ p: 3, mb: 3 }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Time to Value Distribution — {isAll ? 'all reps combined' : `${selectedRep}'s book`}</Typography>
                <InfoIcon info={`Months between first payment and Live Date for ${ttvBuckets.samples} launched customers ${isAll ? 'across every rep' : `owned by ${selectedRep}`}. Compare with the company-wide TTV page for context.`} />
              </Stack>
              <Box sx={{ height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={ttvBuckets.data} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                    <CartesianGrid stroke="rgba(0,0,0,0.06)" />
                    <XAxis dataKey="range" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <RTooltip />
                    <Bar dataKey="count" fill="#2C73FF" />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
              <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
                Median: <strong>{ttvBuckets.median} months</strong> · p90: <strong>{ttvBuckets.p90} months</strong>.
              </Typography>
            </Paper>
          )}
        </>
      )}
    </Box>
  );
}

function isWithinDays(iso: string, days: number): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) / (1000 * 60 * 60 * 24) <= days;
}

type DrillSortKeyOuter = 'name' | 'owner' | 'tier' | 'status' | 'pay_status' | 'mrr' | 'arr_at_risk' | 'tenure';

function DrillSortHead({
  label, k, active, dir, onClick, align,
}: {
  label: string;
  k: DrillSortKeyOuter;
  active: DrillSortKeyOuter;
  dir: 'asc' | 'desc';
  onClick: (k: DrillSortKeyOuter) => void;
  align?: 'left' | 'right';
}) {
  return (
    <TableCell align={align} sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
      <TableSortLabel active={active === k} direction={dir} onClick={() => onClick(k)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
}

type CfSortKey = 'name' | 'owner' | 'mrr' | 'last_payment' | 'failed_3mo' | 'tenure';

function CfSortHead({
  label, k, active, dir, onClick, align,
}: {
  label: string;
  k: CfSortKey;
  active: CfSortKey;
  dir: 'asc' | 'desc';
  onClick: (k: CfSortKey) => void;
  align?: 'left' | 'right';
}) {
  return (
    <TableCell align={align} sx={{ fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
      <TableSortLabel active={active === k} direction={dir} onClick={() => onClick(k)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
}
