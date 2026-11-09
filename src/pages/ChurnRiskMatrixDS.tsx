/**
 * Churn Risk Matrix on the Allmoxy design system. Data logic is ported verbatim from the classic
 * page (ChurnRiskMatrix.tsx, kept at /churn-risk-matrix-classic): same churn_risk_matrix and
 * customer_base snapshots, same bid-only overrides (read live from browser localStorage key
 * 'allmoxy.bid_only.pending', written by the Customer Detail toggle; this page only reads it),
 * same re-scoring, matrix cells, owner re-roll, filters and CSV columns.
 *
 * Order on the page: the money at risk and the three tiers first, then the Risk × Impact matrix
 * (click a cell to narrow the list), then the attack list, highest ARR at risk first. The classic
 * page's inline row expansion becomes a side sheet with the score breakdown.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import { DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, SideSheet, downloadCsv, usd } from '../design-system/parts';

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
  signal_6_pulse?: number;
  pulse_color?: 'green' | 'yellow' | 'red' | null;
  pulse_label?: string;
  pulse_detail?: string | null;
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
  primary_risk_driver?: { key: string; summary?: string | null; expected_value?: string | null; current_state?: string | null; roadblocks?: string | null; source: string; signal_baseline?: string | null; evidence?: string[] | null; reviewed_at?: string | null };
};

type MatrixCell = { tier: string; band: string; count: number; mrr_sum: number; arr_at_risk_sum: number; customer_ids: number[] };

type Snapshot = {
  fetched_at: string;
  scoring_mode: 'full' | 'orders_only' | 'hubspot_only' | 'minimal';
  totals: {
    cohort_size: number; total_mrr: number; total_arr_at_risk: number;
    red_count: number; yellow_count: number; green_count: number; unscored_count: number;
    red_mrr: number; yellow_mrr: number; green_mrr: number;
    hubspot_signals_loaded: boolean; order_data_loaded: boolean;
  };
  matrix: Record<string, MatrixCell>;
  customers: ScoredCustomer[];
};

type Tier = ScoredCustomer['tier'];
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
// Tiers are status: always a word and a tone, never color alone.
const TIER: Record<Tier, { word: string; tone: Tone; help: string }> = {
  red: { word: 'Critical', tone: 'error', help: 'Most likely to churn' },
  yellow: { word: 'Watch', tone: 'warning', help: 'Showing warning signs' },
  green: { word: 'Healthy', tone: 'success', help: 'Using Allmoxy well' },
  unscored: { word: 'Unscored', tone: 'neutral', help: 'Not enough data to score' },
};
const TierTag = ({ tier }: { tier: Tier }) => <span className={`am-tag am-tag--${TIER[tier].tone}`}>{TIER[tier].word}</span>;
const BANDS = ['large', 'medium', 'small'] as const;
const BAND_LABEL = { small: 'Small (<$500/mo)', medium: 'Medium ($500–$1.5K/mo)', large: 'Large (>$1.5K/mo)' };
const TIERS3 = ['red', 'yellow', 'green'] as const;

// Bid-only overrides live in localStorage (written by the Customer Detail toggle).
// Read + listen for changes so the matrix updates when the switch is flipped in another tab.
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

function buildMatrix(customers: ScoredCustomer[]) {
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
  return matrix;
}

const LIMIT = 25;
/** Wraps a long text cell so the table shows it in full instead of cutting it. */
const W = ({ children }: { children: React.ReactNode }) => <span style={{ display: 'block', whiteSpace: 'normal', minWidth: 220 }}>{children}</span>;
const signedScore = (v: number) => `${v >= 0 ? '+' : ''}${v}`;

/** Local multi-select (shared parts only have a single-value Select). Same certified classes as
 *  Select: an outlined field opening the menu; items toggle and the menu stays open. */
function MultiSelect({ label, allText, options, value, onChange, width = 240 }: {
  label: string; allText: string; options: Array<{ name: string; count: number }>; value: string[]; onChange: (v: string[]) => void; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const text = value.length === 0 ? allText : value.length === 1 ? value[0] : `${value.length} selected`;
  const toggle = (n: string) => onChange(value.includes(n) ? value.filter((x) => x !== n) : [...value, n]);
  return (
    <div ref={ref} className={`am-menu-anchor am-select${open ? ' is-open' : ''}`} style={{ width }}>
      <label className="am-field am-field--outlined" onClick={() => setOpen(!open)}>
        <input className="am-field__input" placeholder=" " value={text} readOnly aria-label={label} />
        <Icon name="arrow_drop_down" className="am-field__trail" />
        <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap" /><i /></span>
      </label>
      <div className="am-menu" role="menu" aria-multiselectable="true" style={{ maxHeight: 360, overflowY: 'auto' }}>
        <button className="am-menu__item" role="menuitem" aria-selected={value.length === 0} onClick={() => onChange([])}>
          <span style={value.length === 0 ? undefined : { visibility: 'hidden' }}><Icon name="check" /></span>
          <span className="am-menu__label">{allText}</span>
        </button>
        {options.map((o) => (
          <button key={o.name} className="am-menu__item" role="menuitemcheckbox" aria-checked={value.includes(o.name)} aria-selected={value.includes(o.name)} onClick={() => toggle(o.name)}>
            <span style={value.includes(o.name) ? undefined : { visibility: 'hidden' }}><Icon name="check" /></span>
            <span className="am-menu__label">{o.name} ({o.count})</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ChurnRiskMatrixDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('churn_risk_matrix');
  const rawSnap = data as unknown as Snapshot | undefined;

  // Live bid-only overrides from localStorage, polled every 1.5s (as the classic page).
  const [bidOnlyOverrides, setBidOnlyOverrides] = useState<Record<string, boolean>>(() => readBidOnlyOverrides());
  useEffect(() => {
    const reload = () => setBidOnlyOverrides(readBidOnlyOverrides());
    window.addEventListener('storage', reload);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(t); };
  }, []);

  // Re-derive customers + matrix + totals with the overrides applied (verbatim from classic).
  // Bid-only override: Signal 1 → +35, Signal 2 → +25, recompute total + tier + matrix cell.
  const snap = useMemo<Snapshot | undefined>(() => {
    if (!rawSnap) return undefined;
    const customers = rawSnap.customers.map((c) => {
      const aidKey = String(c.allmoxy_customer_id);
      const localOverride = bidOnlyOverrides[aidKey];
      const effectiveBidOnly = localOverride !== undefined ? localOverride : c.is_bid_only;
      if (effectiveBidOnly === c.is_bid_only) return c;
      const s1New = effectiveBidOnly ? 35 : (c.is_bid_only ? 0 : c.signal_1_orders);
      const s2New = effectiveBidOnly ? 25 : (c.is_bid_only ? 0 : c.signal_2_launch);
      const newTotal = s1New + s2New + c.signal_3_recency + c.signal_4_risk + c.signal_5_tenure + (c.signal_6_pulse || 0);
      let newTier: typeof c.tier;
      if (effectiveBidOnly) {
        if (newTotal >= 70) newTier = 'green';
        else if (newTotal >= 40) newTier = 'yellow';
        else newTier = 'red';
      } else {
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
    const matrix = buildMatrix(customers);
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

  // How many customers' bid-only state differs from the snapshot because of a local override.
  const overrideCount = useMemo(() => (rawSnap?.customers ?? []).filter((c) => {
    const o = bidOnlyOverrides[String(c.allmoxy_customer_id)];
    return o !== undefined && o !== c.is_bid_only;
  }).length, [rawSnap, bidOnlyOverrides]);

  // Canonical customer base, to show the matrix covers the same book every page counts.
  const { data: baseData } = useSheetTab('customer_base');
  const baseCustomers = (baseData as unknown as { customers?: number } | undefined)?.customers ?? null;

  const [tierFilter, setTierFilterRaw] = useState<'all' | 'red' | 'yellow' | 'green' | 'unscored'>('all');
  const [cellFilter, setCellFilterRaw] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilterRaw] = useState<string[]>([]);
  const [subSegmentFilter, setSubSegmentFilterRaw] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [help, setHelp] = useState(false);
  const setTierFilter = (v: typeof tierFilter) => { setTierFilterRaw(v); setCellFilterRaw(null); setShowAll(false); };
  const setCellFilter = (v: string | null) => { setCellFilterRaw(v); setShowAll(false); };
  const setOwnerFilter = (v: string[]) => { setOwnerFilterRaw(v); setShowAll(false); };
  const setSubSegmentFilter = (v: string[]) => { setSubSegmentFilterRaw(v); setShowAll(false); };

  const ownerCounts = useMemo(() => {
    if (!snap) return [] as Array<{ name: string; count: number }>;
    const m = new Map<string, number>();
    for (const c of snap.customers) { const key = c.owner_name || '(unassigned)'; m.set(key, (m.get(key) ?? 0) + 1); }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [snap]);
  const subSegmentCounts = useMemo(() => {
    if (!snap) return [] as Array<{ name: string; count: number }>;
    const m = new Map<string, number>();
    for (const c of snap.customers) { const key = c.sub_segment || '(no sub-segment)'; m.set(key, (m.get(key) ?? 0) + 1); }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [snap]);

  const ownerSet = useMemo(() => new Set(ownerFilter), [ownerFilter]);
  const subSegmentSet = useMemo(() => new Set(subSegmentFilter), [subSegmentFilter]);

  // Owner-filtered view: re-rolls matrix + totals (powers matrix, KPI cards, tier counts).
  // Sub-segment narrows the list only, exactly as the classic page.
  const viewSnap = useMemo(() => {
    if (!snap || ownerSet.size === 0) return snap;
    const customers = snap.customers.filter((c) => ownerSet.has(c.owner_name || '(unassigned)'));
    const matrix = buildMatrix(customers);
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
  }, [snap, ownerSet]);

  const filtered = useMemo(() => {
    if (!snap) return [];
    let rows = snap.customers;
    if (cellFilter) {
      const ids = new Set(snap.matrix[cellFilter]?.customer_ids ?? []);
      rows = rows.filter((c) => ids.has(c.allmoxy_customer_id));
    } else if (tierFilter !== 'all') {
      rows = rows.filter((c) => c.tier === tierFilter);
    }
    if (ownerSet.size > 0) rows = rows.filter((c) => ownerSet.has(c.owner_name || '(unassigned)'));
    if (subSegmentSet.size > 0) rows = rows.filter((c) => subSegmentSet.has(c.sub_segment || '(no sub-segment)'));
    return rows;
  }, [snap, tierFilter, cellFilter, ownerSet, subSegmentSet]);

  // Highest stakes first (the classic default sort: ARR at risk, descending). Headers re-sort.
  const ranked = useMemo(() => [...filtered].sort((a, b) => b.arr_at_risk - a.arr_at_risk), [filtered]);
  const list = showAll ? ranked : ranked.slice(0, LIMIT);
  const listMrr = filtered.reduce((s, c) => s + c.current_subscription_mrr, 0);
  const listArr = filtered.reduce((s, c) => s + c.arr_at_risk, 0);

  const T = viewSnap?.totals;
  const tierShare = (mrr: number | undefined) => {
    const total = T?.total_mrr ?? 0;
    return total > 0 ? `${Math.round(((mrr ?? 0) / total) * 100)}%` : '—';
  };
  const whose = ownerFilter.length === 0 ? 'customer-base' : ownerFilter.length === 1 ? `${ownerFilter[0]}'s` : `${ownerFilter.length} owners'`;
  const L = (v: string) => (isLoading ? '…' : v);

  const exportCsv = () => {
    const cols: Array<[keyof ScoredCustomer, string]> = [
      ['allmoxy_customer_id', 'Allmoxy ID'], ['name', 'Customer'], ['owner_name', 'Owner'], ['tier', 'Tier'], ['total_score', 'Score'],
      ['current_subscription_mrr', 'Current MRR'], ['arr_at_risk', 'ARR at Risk'], ['lifetime_subscription', 'Lifetime $'], ['years_with_us', 'Tenure (yrs)'],
      ['primary_segment', 'Primary Segment'], ['sub_segment', 'Sub Segment'], ['orders_label', 'Order State'], ['orders_current_year', 'Orders YTD'],
      ['orders_prior_year', 'Orders Prior Yr'], ['launch_status', 'Launch Status'], ['days_since_last_contact', 'Days Since Contact'],
      ['failed_3mo_count', 'Failed Charges (3mo)'], ['signal_1_orders', 'S1 Orders'], ['signal_2_launch', 'S2 Launch'], ['signal_3_recency', 'S3 Recency'],
      ['signal_4_risk', 'S4 Risk'], ['signal_5_tenure', 'S5 Tenure'], ['narrative', 'Narrative'], ['hubspot_company_id', 'HubSpot ID'],
    ];
    downloadCsv(`churn_risk_matrix_${new Date().toISOString().slice(0, 10)}`, cols.map(([, l]) => l),
      filtered.map((c) => cols.map(([k]) => { const v = c[k]; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : (v as string | number); })));
  };

  const cellLabel = (key: string) => { const [t, b] = key.split('_') as [Tier, keyof typeof BAND_LABEL]; return `${TIER[t].word} · ${BAND_LABEL[b]}`; };
  const listTitle = cellFilter ? cellLabel(cellFilter) : tierFilter === 'all' ? 'All customers' : TIER[tierFilter].word;

  const drivers = (c: ScoredCustomer) => {
    const out: Array<[string, Tone, string?]> = [];
    if (c.scoring_data_status === 'no_data') out.push(['Limited data', 'neutral', 'Customer not in orders xlsx — defaulted to yellow pending verification']);
    if (c.scoring_data_status === 'orders_only') out.push(['Orders only', 'neutral', 'Scored from order data only — HubSpot signals not yet pulled']);
    if (c.is_bid_only) out.push(['Bid-only', 'info', 'Uses Allmoxy mainly for quotes and bids']);
    if (c.orders_label === 'gym_member') out.push(['Gym member', 'error']);
    if (c.orders_label === 'dropped_off') out.push(['No 2026 orders', 'error']);
    if (c.orders_label === 'declining') out.push(['Orders declining', 'warning']);
    if (c.failed_3mo_count > 0) out.push([`${c.failed_3mo_count} failed charges`, 'error']);
    if (c.gym_member_cliff) out.push(['24mo+ no launch', 'error']);
    if (c.launch_status === 'not_launched') out.push(['Not launched', 'warning']);
    if (c.launch_status === 'cancelled') out.push(['Cancelled launch', 'error']);
    if (c.days_since_last_contact != null && c.days_since_last_contact > 60) out.push([`${c.days_since_last_contact}d no contact`, 'warning']);
    if ((c.risk_signals?.length ?? 0) > 0) out.push([`${c.risk_signals.length} risk signal${c.risk_signals.length > 1 ? 's' : ''}`, 'error']);
    return out;
  };

  const detail = detailId != null ? snap?.customers.find((c) => c.allmoxy_customer_id === detailId) ?? null : null;
  const openCustomer = (c: ScoredCustomer) => navigate(`/customer-detail?id=${encodeURIComponent(String(c.allmoxy_customer_id))}`);

  const pulseWord = (p: 'green' | 'yellow' | 'red') => ({ green: ['Green', 'success'], yellow: ['Yellow', 'warning'], red: ['Red', 'error'] } as const)[p];

  const detailSheet = detail && (
    <SideSheet open onClose={() => setDetailId(null)} title={detail.name}
      text={<>{detail.primary_segment ? `${detail.primary_segment}${detail.sub_segment ? ` · ${detail.sub_segment}` : ''} · ` : ''}Owner: {detail.owner_name || 'unassigned'}</>}>
      <div className="am-row am-row--wrap">
        <TierTag tier={detail.tier} />
        <span className="am-card__text">Score {detail.total_score} · {usd(detail.current_subscription_mrr)}/mo · {usd(detail.arr_at_risk)} ARR at risk</span>
      </div>
      {detail.primary_risk_driver && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap">
            <span className="am-chart__title">Primary risk driver: {detail.primary_risk_driver.key}</span>
            <span className={`am-tag am-tag--${detail.primary_risk_driver.source === 'signals' ? 'neutral' : 'info'}`}>{detail.primary_risk_driver.source === 'signals' ? 'From signals' : 'From calls / notes'}</span>
          </div>
          {(detail.primary_risk_driver.expected_value || detail.primary_risk_driver.current_state || detail.primary_risk_driver.roadblocks) ? (
            <>
              {detail.primary_risk_driver.expected_value && <p className="am-card__text"><b>Sold on / expected: </b>{detail.primary_risk_driver.expected_value}</p>}
              {detail.primary_risk_driver.current_state && <p className="am-card__text"><b>Where they are today: </b>{detail.primary_risk_driver.current_state}</p>}
              {detail.primary_risk_driver.roadblocks && <p className="am-card__text"><b>Roadblocks to value: </b>{detail.primary_risk_driver.roadblocks}</p>}
            </>
          ) : <p className="am-card__text">{detail.primary_risk_driver.summary}</p>}
          {detail.primary_risk_driver.evidence?.map((e, i) => <p key={i} className="am-card__text">· <i>{e}</i></p>)}
        </section>
      )}
      <div className="am-row am-row--spread">
        <span className="am-chart__title">Score breakdown</span>
        <button className="am-btn am-btn--text" onClick={() => setHelp(true)}><Icon name="info" />How the score works</button>
      </div>
      <DataTable label={`Score breakdown for ${detail.name}`}
        cols={[['Signal', false], ['Value', false], ['Score', true]]}
        rows={[
          ['1 · Order Volume', <W key="v">{detail.orders_detail}</W>, signedScore(detail.signal_1_orders)],
          ['2 · Launch Status', <W key="v">{`${detail.launch_status}${detail.launch_evidence ? `: ${detail.launch_evidence.slice(0, 100)}` : ''}`}</W>, signedScore(detail.signal_2_launch)],
          ['3 · Engagement Recency', detail.days_since_last_contact != null ? `${detail.days_since_last_contact} days since last contact` : '—', signedScore(detail.signal_3_recency)],
          ['4 · Risk Signals',
            (detail.risk_signals?.length ?? 0) === 0 ? '—' : (
              <span key="rs" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {detail.risk_signals.map((s, i) => (
                  <span key={i}><b>{s.type}</b> ({s.weight}){s.quote && <><br /><i>"{s.quote.slice(0, 120)}"</i></>}</span>
                ))}
              </span>
            ),
            String(detail.signal_4_risk)],
          ['5 · Tenure × Launch', detail.years_with_us != null ? `${detail.years_with_us.toFixed(1)}y tenure, ${detail.launch_status}` : '—', String(detail.signal_5_tenure)],
          [<span key="p" className="am-row am-row--tight">6 · CS Health Pulse{detail.pulse_color && <span className={`am-tag am-tag--${pulseWord(detail.pulse_color)[1]}`}>{pulseWord(detail.pulse_color)[0]}</span>}</span>,
            <W key="v">{detail.pulse_detail ?? 'Not set in HubSpot'}</W>, `${(detail.signal_6_pulse ?? 0) > 0 ? '+' : ''}${detail.signal_6_pulse ?? 0}`],
        ]}
        foot={['Total', '', String(detail.total_score)]} />
      <span className="am-chart__title">Quick facts</span>
      <div className="am-row am-row--wrap">
        <span className="am-card__text">Lifetime ${detail.lifetime_subscription.toLocaleString()}</span>
        <span className="am-card__text">{detail.orders_lifetime} lifetime orders</span>
        <span className="am-card__text">Signed up {detail.sign_up_date || '—'}</span>
        {detail.failed_3mo_count > 0 && <span className="am-tag am-tag--error">{detail.failed_3mo_count} failed charges (${detail.failed_3mo_amount.toFixed(2)})</span>}
      </div>
      <div className="am-row am-row--wrap">
        <button className="am-btn am-btn--outlined" onClick={() => openCustomer(detail)}><Icon name="person" />Open customer detail</button>
        {detail.hubspot_company_id && hubspotCompanyUrl(detail.hubspot_company_id) && (
          <a className="am-btn am-btn--text" href={hubspotCompanyUrl(detail.hubspot_company_id) ?? '#'} target="_blank" rel="noopener noreferrer">Open in HubSpot<Icon name="open_in_new" /></a>
        )}
      </div>
    </SideSheet>
  );

  const helpSheet = (
    <SideSheet open={help} onClose={() => setHelp(false)} title="How the score works">
      <p className="am-card__text"><b>The matrix.</b> Rows are the customer's current MRR band: Small (under $500), Medium ($500–$1.5K), Large (over $1.5K). Columns are the health tier from the scoring model. Click a cell to list the customers in it; click it again to clear.</p>
      <p className="am-card__text"><b>Tier thresholds adapt to the data loaded.</b> Full (orders + HubSpot): Healthy 70+, Watch 40–69, Critical under 40. Orders only: Healthy 45+, Watch 20–44, Critical under 20. HubSpot only: Healthy 45+, Watch 25–44, Critical under 25. No data: Watch by default (not enough evidence).</p>
      <p className="am-card__text"><b>1 · Order Volume</b> (max +35). Current-year $/mo run-rate against prior year (or YTD order count when the monthly average isn't available). Running orders +35; declining over 50% year on year +15; dormant or dropped off 0; never ran an order ("gym member") −10; within the 5-month signup grace period with no orders yet 0; bid-only customers +35 (the signal doesn't apply).</p>
      <p className="am-card__text"><b>2 · Launch Status</b> (max +25). From Live Date in the orders xlsx. Launched and actively running +25; launched but unclear +18; lifetime orders but no Live Date +12; not launched 0.</p>
      <p className="am-card__text"><b>3 · Engagement Recency</b> (max +20). From HubSpot last contacted. 14 days or less +20; 15–30 +15; 31–60 +8; 61–90 +3; over 90 0. Customers running orders with quiet contact are treated as self-sufficient power users (+20: silence is health, not risk).</p>
      <p className="am-card__text"><b>4 · Risk Signals</b> (0 to −20). Keyword scan of HubSpot notes for churn, cancel, refund and similar. Each match subtracts.</p>
      <p className="am-card__text"><b>5 · Tenure × Launch</b> (0 to −15). Long-tenured customers who never launched. Launched or bid-only 0; 6–12 months unlaunched −5; 12–18 −10; 18+ −15.</p>
      <p className="am-card__text"><b>6 · CS Health Pulse</b> (−25 to +25). The CS rep's Customer Health Pulse in HubSpot. Green +25; Yellow 0; Red −25; unset 0.</p>
      <p className="am-card__text"><b>Tier overrides.</b> Hard-override-red, gym-member cliff and cancelled launch force Critical whatever the score. New signups in their 5-month grace period are forced Healthy unless there are concrete negative signals (Pulse red, failed charges, risk keywords).</p>
      <p className="am-card__text"><b>Bid-only.</b> Marking a customer bid-only on Customer Detail (saved in this browser) sets Order Volume to +35 and Launch to +25 and re-tiers them here straight away.</p>
    </SideSheet>
  );

  return (
    <DsPage
      path="/churn-risk-matrix"
      title="Churn Risk Matrix"
      subtitle="Every customer in the canonical customer base (live subscription, scored at current subscription MRR) on a health model built from orders, launch, contact recency, risk signals, tenure and the CS pulse. The customers most likely to churn come first, sorted by ARR at risk."
      actions={<>
        <button className="am-btn am-btn--text" onClick={() => setHelp(true)}><Icon name="info" />How the score works</button>
        <button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!filtered.length}><Icon name="download" />Export risk matrix</button>
      </>}
      overlays={<>{helpSheet}{detailSheet}</>}
    >
      {error ? <p className="am-card__text">Failed to load churn_risk_matrix: {String(error)}</p> : null}

      {snap && snap.scoring_mode !== 'full' && (
        <section className="am-card am-card--outlined">
          <div className="am-row">
            <span className="am-tag am-tag--warning">Partial scoring</span>
            <p className="am-card__text">
              Scoring mode: <b>{snap.scoring_mode}</b>. {!snap.totals.hubspot_signals_loaded && 'HubSpot signals not yet pulled (launch status, contact recency, note-based risk signals). '}{!snap.totals.order_data_loaded && 'Order volume data missing. '}Tier thresholds adapt — refresh after pulling HubSpot signals via the at-risk agent.
            </p>
          </div>
        </section>
      )}

      <KpiGrid>
        <KpiCard label="ARR at risk" value={L(usd(T?.total_arr_at_risk ?? 0))}
          hint={`of ${usd((T?.total_mrr ?? 0) * 12)} ${whose} ARR (${T?.cohort_size ?? 0}${ownerFilter.length === 0 && baseCustomers != null ? ` of ${baseCustomers}` : ''} customers · ${usd(T?.total_mrr ?? 0)}/mo MRR)`}
          tag="At risk" tagTone="warning" onOpen={() => setTierFilter('all')} />
        {TIERS3.map((t) => (
          <KpiCard key={t} label={TIER[t].word} value={L(String(T?.[`${t}_count` as const] ?? 0))}
            hint={`${usd(T?.[`${t}_mrr` as const] ?? 0)}/mo MRR · ${tierShare(T?.[`${t}_mrr` as const])} of cohort MRR`}
            tag={TIER[t].word} tagTone={TIER[t].tone} onOpen={() => setTierFilter(t)} />
        ))}
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Risk × Impact matrix</span>
            <span className="am-chart__caption">Rows: current MRR band. Columns: health tier. Click a cell to list its customers; click a column total for the whole tier.</span>
          </div>
          {cellFilter && <button className="am-btn am-btn--text" onClick={() => setCellFilter(null)}><Icon name="close" />Clear {cellLabel(cellFilter)}</button>}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Risk by impact matrix"
            cols={[['MRR band', false], ...TIERS3.map((t) => [TIER[t].word, true] as [string, boolean])]}
            rows={BANDS.map((band) => [
              BAND_LABEL[band],
              ...TIERS3.map((t) => {
                const key = `${t}_${band}`;
                const cell = viewSnap?.matrix[key];
                const n = cell?.count ?? 0;
                return (
                  <span key={key} className="am-table__multi" style={{ alignItems: 'flex-end' }}>
                    <span className="am-row am-row--tight">
                      {cellFilter === key && <span className="am-tag am-tag--info">Showing</span>}
                      {n > 0
                        ? <button className="am-btn am-btn--text" style={{ height: 28 }} aria-pressed={cellFilter === key} onClick={() => setCellFilter(cellFilter === key ? null : key)}>{n} customer{n === 1 ? '' : 's'}</button>
                        : <span>0 customers</span>}
                    </span>
                    <span className="am-table__muted">{usd(cell?.mrr_sum ?? 0)}/mo</span>
                    {(cell?.arr_at_risk_sum ?? 0) > 0 && <span className="am-table__muted">{usd(cell?.arr_at_risk_sum ?? 0)} ARR at risk</span>}
                  </span>
                );
              }),
            ])}
            foot={['Column total', ...TIERS3.map((t) => {
              const sum = (f: 'count' | 'mrr_sum' | 'arr_at_risk_sum') => BANDS.reduce((s, b) => s + (viewSnap?.matrix[`${t}_${b}`]?.[f] ?? 0), 0);
              const n = sum('count'), mrr = sum('mrr_sum'), risk = sum('arr_at_risk_sum');
              return (
                <span key={t} className="am-table__multi" style={{ alignItems: 'flex-end' }}>
                  <button className="am-btn am-btn--text" style={{ height: 28 }} onClick={() => setTierFilter(t)}>{usd(mrr)}/mo</button>
                  <span className="am-table__muted">{n} customer{n === 1 ? '' : 's'} · {usd(mrr * 12)} ARR</span>
                  {risk > 0 && <span className="am-table__muted">{usd(risk)} ARR at risk</span>}
                </span>
              );
            })]}
          />
        </div>
        {(T?.unscored_count ?? 0) > 0 && <p className="am-card__text">{T?.unscored_count} unscored customer{T?.unscored_count === 1 ? '' : 's'} not in the matrix.</p>}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">{listTitle} · {filtered.length} customers · {usd(listArr)} ARR at risk</span>
            <span className="am-chart__caption">The attack list, highest ARR at risk first. Click a customer to open their record, or Details for the score breakdown.</span>
          </div>
        </div>
        <div className="am-row am-row--wrap">
          <Segmented label="Tier" value={cellFilter ? null : tierFilter} onChange={(v) => setTierFilter(v)} options={[
            ['all', `All (${T?.cohort_size ?? 0})`], ['red', `Critical (${T?.red_count ?? 0})`],
            ['yellow', `Watch (${T?.yellow_count ?? 0})`], ['green', `Healthy (${T?.green_count ?? 0})`],
          ]} />
          {ownerCounts.length > 0 && <>
            <span className="am-card__text">Owner</span>
            <MultiSelect label="Owner" allText="All owners" options={ownerCounts} value={ownerFilter} onChange={setOwnerFilter} width={240} />
          </>}
          {subSegmentCounts.length > 0 && <>
            <span className="am-card__text">Sub-segment</span>
            <MultiSelect label="Sub-segment" allText="All sub-segments" options={subSegmentCounts} value={subSegmentFilter} onChange={setSubSegmentFilter} width={260} />
          </>}
        </div>
        {(cellFilter || ownerFilter.length > 0 || subSegmentFilter.length > 0 || overrideCount > 0) && (
          <div className="am-row am-row--wrap">
            {cellFilter && <span className="am-tag am-tag--info">Cell: {cellLabel(cellFilter)}</span>}
            {ownerFilter.map((o) => <span key={o} className="am-tag am-tag--neutral">Owner: {o}</span>)}
            {subSegmentFilter.map((s) => <span key={s} className="am-tag am-tag--neutral">Sub-segment: {s}</span>)}
            {(cellFilter || ownerFilter.length > 0 || subSegmentFilter.length > 0) && (
              <button className="am-btn am-btn--text" onClick={() => { setCellFilter(null); setOwnerFilter([]); setSubSegmentFilter([]); }}>Clear filters</button>
            )}
            {overrideCount > 0 && <span className="am-tag am-tag--info">{overrideCount} bid-only change{overrideCount === 1 ? '' : 's'} from Customer Detail applied</span>}
          </div>
        )}

        {isLoading ? <p className="am-card__text">Loading customers…</p> : filtered.length === 0 ? <p className="am-card__text">No customers match this filter.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Churn risk attack list"
              cols={[['Tier', false], ['Customer', false], ['Owner', false], ['MRR', true], ['ARR at risk', true], ['Score', true], ['Tenure', true], ['Risk drivers', false], ['', false]]}
              rows={list.map((c) => [
                <TierTag key="t" tier={c.tier} />,
                <span key="n" className="am-table__multi" style={{ alignItems: 'flex-start', maxWidth: 300 }}>
                  <button className="am-btn am-btn--text" style={{ height: 28, maxWidth: '100%' }} onClick={() => openCustomer(c)}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span></button>
                  {c.primary_segment && <span className="am-table__muted" style={{ maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${c.primary_segment}${c.sub_segment ? ` · ${c.sub_segment}` : ''}`}>{c.primary_segment}{c.sub_segment ? ` · ${c.sub_segment}` : ''}</span>}
                </span>,
                c.owner_name || <span key="o" className="am-tag am-tag--neutral">Unassigned</span>,
                usd(c.current_subscription_mrr),
                usd(c.arr_at_risk),
                String(c.total_score),
                c.years_with_us != null ? c.years_with_us.toFixed(1) + 'y' : '—',
                <span key="d" className="am-row am-row--tight am-row--wrap" style={{ maxWidth: 360 }}>
                  {drivers(c).map(([w, tone, title]) => <span key={w} className={`am-tag am-tag--${tone}`} title={title}>{w}</span>)}
                </span>,
                'Details',
              ])}
              sortValues={list.map((c) => [
                { red: 0, yellow: 1, green: 2, unscored: 3 }[c.tier] ?? 9, (c.name || '').toLowerCase(), (c.owner_name || '~').toLowerCase(),
                c.current_subscription_mrr, c.arr_at_risk, c.total_score, c.years_with_us ?? -1, drivers(c).length, null,
              ])}
              defaultSort={{ col: 4, dir: 'desc' }}
              clickable={(col) => col === 5 || col === 8}
              onCell={(i) => setDetailId(list[i].allmoxy_customer_id)}
              foot={[`Total · ${filtered.length} customers`, '', '', usd(listMrr), usd(listArr), '', '', '', '']}
              onFoot={() => setShowAll(true)} footClickable={(col) => (col === 0 || col === 3 || col === 4) && !showAll && filtered.length > LIMIT} />
          </div>
        )}
        {!isLoading && !showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {filtered.length}</button>}
        {!isLoading && filtered.length > 0 && (
          <p className="am-card__text">Showing {list.length} of {filtered.length}{!showAll && filtered.length > LIMIT ? ' (top by ARR at risk; headers sort the rows shown)' : ''}. Totals cover all {filtered.length}.</p>
        )}
      </section>

      <p className="am-card__text">
        Scoring model from the allmoxy-monthly-dashboard skill · 6 signals · Tier thresholds adapt to data availability · Refresh: {snap?.fetched_at ? new Date(snap.fetched_at).toLocaleString() : '—'}
      </p>
    </DsPage>
  );
}
