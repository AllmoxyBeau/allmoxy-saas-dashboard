/**
 * Renewal Management on the Allmoxy design system. Data logic is ported from the classic page
 * (RenewalManagement.tsx, kept at /renewal-management-classic): same renewal_management
 * snapshot, same tile figures (snapshot aggregates, plus the this-year and no-renewal-date
 * counts computed from rows), same filters (tile, month, action, owner, has-renewal-date), same
 * sort keys and the same CSV columns.
 *
 * One deliberate difference: a KPI tile filter defines its own population, so while a tile is
 * active the "has renewal date" switch is set aside (the classic page already did this for the
 * No-renewal-date tile). That way clicking a tile always lists exactly the number on the tile
 * (Expansion 33, Contraction 70, Drift 25 rather than the dated subset).
 *
 * The expanded row of the classic page (RenewalPanelContent) becomes a side sheet with the
 * same content: proposed price, monthly cost-ratio trend (as columns), renewal context, quotes.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, Segmented, Select, SideSheet, Switch,
  addMonths, downloadCsv, mlabel, thisMonth, usd, usdk,
} from '../design-system/parts';

type ActionTag = 'Expansion Opportunity' | 'Contraction Risk' | 'Watch' | 'Stable' | 'Paused';
type Tier = 'red' | 'yellow' | 'green' | 'unscored' | null;
type MonthlyTrendPoint = { month: string; subscription: number; orders_dollars: number; orders_source: 'supplement' | 'yearly_avg'; cost_ratio_pct: number | null };
type Quote = {
  id: string; title: string | null; status: string | null; amount: number | null; currency: string;
  created_date: string | null; expiration_date: string | null; last_modified_date: string | null;
  quote_number: string | null; payment_status: string | null; hubspot_url: string;
};
type RenewalRow = {
  instance_id: string; account_name: string; allmoxy_customer_id: number; customer_name: string;
  renewal_date: string | null; days_to_renewal: number | null; calculated_renewal_date: string | null; renewal_date_manual: string | null;
  contract_status: string | null; contract_length_months: number | null; monthly_flat_fee_hubspot: number | null;
  arr_up_for_renewal: number; last_renewal_expansion: string | null; last_no_expansion_reason: string | null;
  pay_status: string; cs_pulse: string | null; health_score: number | null; health_score_status: string | null;
  vip_legacy: string | null; implementation_status: string | null; is_launched: string | null; owner_name: string | null;
  current_mrr: number; current_arr: number; lifetime_subscription: number; lifetime_orders_dollars: number;
  orders_monthly_avg_current_year: number; orders_monthly_avg_prior_year: number; orders_yoy_pct: number | null;
  cost_ratio_lifetime_pct: number | null; cost_ratio_annualized_pct: number | null; monthly_trend: MonthlyTrendPoint[];
  dropoff_pct: number | null; risk_tier: Tier; risk_score: number | null; is_bid_only: boolean;
  action_tag: ActionTag; action_reason: string; customer_entered_orders_prev_billing_period: number | null;
  quotes?: Quote[];
  proposed_mrr?: number | null; proposed_arr?: number | null; proposed_uplift_pct?: number | null;
  proposed_basis?: 'growth' | 'underpriced' | null; expansion_rationale?: string | null; expansion_confidence?: 'high' | 'low' | null;
  target_1pct_mrr?: number | null; target_1pct_arr?: number | null;
};
type Aggregates = {
  total_instances: number; customers?: number; base_customers?: number | null; base_as_of?: string | null;
  base_customers_without_instance?: number; active_instances_not_in_base?: number; duplicate_instances_dropped?: number;
  with_renewal_date: number;
  renewals_in_next_90d: number; renewals_in_next_90d_arr: number;
  renewals_in_next_180d: number; renewals_in_next_180d_arr: number;
  renewals_in_next_12mo: number; renewals_in_next_12mo_arr: number;
  expansion_opportunities: number; contraction_risks: number; watch: number; stable: number; paused: number;
  median_cost_ratio_lifetime_pct: number | null; median_cost_ratio_annualized_pct: number | null;
  dropoff_count: number; customers_with_quote?: number; upcoming_renewals_with_quote?: number;
  upcoming_renewals_without_quote?: number; total_quote_count?: number;
};
type Snapshot = { fetchedAt: string; aggregates: Aggregates; rows: RenewalRow[] };

const ACTIONS: ActionTag[] = ['Expansion Opportunity', 'Contraction Risk', 'Watch', 'Stable', 'Paused'];
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
const ACTION: Record<ActionTag, { word: string; tone: Tone }> = {
  'Expansion Opportunity': { word: 'Expansion opportunity', tone: 'success' },
  'Contraction Risk': { word: 'Contraction risk', tone: 'error' },
  Watch: { word: 'Watch', tone: 'warning' },
  Stable: { word: 'Stable', tone: 'neutral' },
  Paused: { word: 'Paused', tone: 'info' },
};
const HEALTH: Record<string, { word: string; tone: Tone }> = {
  red: { word: 'At risk', tone: 'error' }, yellow: { word: 'Fair', tone: 'warning' },
  green: { word: 'Healthy', tone: 'success' }, unscored: { word: 'Unscored', tone: 'neutral' },
};
const TIER_ORDER: Record<string, number> = { red: 0, yellow: 1, unscored: 2, green: 3 };
const quoteStatus = (s: string | null): { word: string; tone: Tone } =>
  s === 'APPROVAL_NOT_NEEDED' ? { word: 'Sent', tone: 'success' } : s === 'DRAFT' ? { word: 'Draft', tone: 'warning' } : { word: s || '—', tone: 'neutral' };
const fmtPct2 = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}%`);
const fmtYoy = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`);
const daysText = (d: number | null) => (d == null ? '' : d >= 0 ? `in ${d}d` : `${Math.abs(d)}d ago`);
const upcoming12 = (r: RenewalRow) => r.days_to_renewal != null && r.days_to_renewal >= 0 && r.days_to_renewal <= 365;
const Tag = ({ t }: { t: { word: string; tone: Tone } }) => <span className={`am-tag am-tag--${t.tone}`}>{t.word}</span>;

// Clickable KPI tile filters (classic semantics): mutually exclusive, click again to clear.
type MetricFilter = 'this_year' | 'next_90d' | 'next_180d' | 'next_12mo' | 'expansion' | 'contraction' | 'dropoff' | 'no_renewal_date' | 'with_quote' | 'no_quote_upcoming' | null;
function metricFilterLabel(m: MetricFilter): string {
  switch (m) {
    case 'this_year': return 'renewals dated this calendar year';
    case 'next_90d': return 'renewals in the next 90 days';
    case 'next_180d': return 'renewals in the next 180 days';
    case 'next_12mo': return 'renewals in the next 12 months';
    case 'expansion': return 'expansion opportunities';
    case 'contraction': return 'contraction risks';
    case 'dropoff': return 'cost-ratio drift (recent 3 months 25%+ worse)';
    case 'no_renewal_date': return 'customers with no renewal date set';
    case 'with_quote': return 'upcoming renewals with at least one HubSpot quote';
    case 'no_quote_upcoming': return 'upcoming renewals with no quote yet';
    default: return '';
  }
}

// Sort keys and first-pick directions exactly as the classic page.
type SortKey = 'days_to_renewal' | 'arr' | 'mrr' | 'cost_ratio_lifetime' | 'cost_ratio_annualized' | 'orders_yoy' | 'name' | 'tier';
const SORTS: Array<[SortKey, string]> = [
  ['days_to_renewal', 'Renewal date'], ['arr', 'ARR'], ['cost_ratio_lifetime', 'Cost % · lifetime'],
  ['cost_ratio_annualized', 'Cost % · annualized'], ['orders_yoy', 'Orders YoY'], ['tier', 'Health'], ['name', 'Customer'],
];
const sortValue = (r: RenewalRow, k: SortKey): number | string => {
  switch (k) {
    case 'days_to_renewal': return r.days_to_renewal ?? 99999;
    case 'arr': return r.arr_up_for_renewal;
    case 'mrr': return r.current_mrr;
    case 'cost_ratio_lifetime': return r.cost_ratio_lifetime_pct ?? 99999;
    case 'cost_ratio_annualized': return r.cost_ratio_annualized_pct ?? 99999;
    case 'orders_yoy': return r.orders_yoy_pct ?? -1;
    case 'name': return (r.account_name || '').toLowerCase();
    case 'tier': return TIER_ORDER[r.risk_tier ?? 'unscored'] ?? 9;
  }
};

type ChartRange = 'next12' | 'year' | 'all';
const LIMIT = 25;

export default function RenewalManagementDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab<Snapshot>('renewal_management');
  const snap = data as unknown as Snapshot | undefined;

  const [actionFilter, setActionFilter] = useState<ActionTag[]>([]);
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [showOnlyWithRenewalDate, setShowOnlyWithRenewalDate] = useState(true);
  const [metricFilter, setMetricFilter] = useState<MetricFilter>(null);
  const [monthFilter, setMonthFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('days_to_renewal');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showAll, setShowAll] = useState(false);
  const [detail, setDetail] = useState<RenewalRow | null>(null);
  const [chartRange, setChartRange] = useState<ChartRange>('next12');

  const toggleMetric = (m: MetricFilter) => { setMetricFilter((p) => (p === m ? null : m)); setShowAll(false); };
  const toggleMonth = (ym: string) => { setMonthFilter((p) => (p === ym ? null : ym)); setShowAll(false); };
  const pickSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'name' || k === 'days_to_renewal' ? 'asc' : 'desc'); }
  };

  const rows = useMemo(() => snap?.rows ?? [], [snap]);
  const agg = snap?.aggregates;

  const noRenewalDateCount = useMemo(() => rows.filter((r) => !r.renewal_date).length, [rows]);
  const currentYear = new Date().getFullYear();
  const thisYear = useMemo(() => {
    const matching = rows.filter((r) => r.renewal_date && r.renewal_date.slice(0, 4) === String(currentYear));
    return { count: matching.length, arr: matching.reduce((s, r) => s + (r.arr_up_for_renewal || 0), 0) };
  }, [rows, currentYear]);

  const ownerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.owner_name || '(unassigned)', (m.get(r.owner_name || '(unassigned)') ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const actionCounts = useMemo(() => {
    const m = new Map<ActionTag, number>();
    for (const r of rows) m.set(r.action_tag, (m.get(r.action_tag) ?? 0) + 1);
    return m;
  }, [rows]);

  // All filters except the month drill (the chart keeps every month visible).
  const filteredForChart = useMemo(() => {
    const actionSet = new Set(actionFilter);
    const ownerSet = new Set(ownerFilter);
    const noDateOnly = metricFilter === 'no_renewal_date';
    return rows.filter((r) => {
      if (noDateOnly) {
        if (r.renewal_date) return false;
      } else if (!metricFilter) {
        // A tile defines its own population, so the switch applies only with no tile active.
        if (showOnlyWithRenewalDate && !r.renewal_date) return false;
      }
      if (actionSet.size > 0 && !actionSet.has(r.action_tag)) return false;
      if (ownerSet.size > 0 && !ownerSet.has(r.owner_name || '(unassigned)')) return false;
      if (metricFilter === 'this_year' && !(r.renewal_date && r.renewal_date.slice(0, 4) === String(currentYear))) return false;
      if (metricFilter === 'next_90d' && (r.days_to_renewal == null || r.days_to_renewal < 0 || r.days_to_renewal > 90)) return false;
      if (metricFilter === 'next_180d' && (r.days_to_renewal == null || r.days_to_renewal < 0 || r.days_to_renewal > 180)) return false;
      if (metricFilter === 'next_12mo' && (r.days_to_renewal == null || r.days_to_renewal < 0 || r.days_to_renewal > 365)) return false;
      if (metricFilter === 'expansion' && r.action_tag !== 'Expansion Opportunity') return false;
      if (metricFilter === 'contraction' && r.action_tag !== 'Contraction Risk') return false;
      // Same rule as the tile (ETL dropoff_count): cost ratio UP 25%+ (dropoff_pct >= +0.25).
      if (metricFilter === 'dropoff' && (r.dropoff_pct == null || r.dropoff_pct < 0.25)) return false;
      // Same window as the tiles (upcoming_renewals_with/without_quote): renewal in 0 to 365 days.
      if (metricFilter === 'with_quote' && !(upcoming12(r) && (r.quotes?.length ?? 0) > 0)) return false;
      if (metricFilter === 'no_quote_upcoming' && !(upcoming12(r) && (r.quotes?.length ?? 0) === 0)) return false;
      return true;
    });
  }, [rows, actionFilter, ownerFilter, showOnlyWithRenewalDate, metricFilter, currentYear]);

  const filtered = useMemo(() => (monthFilter
    ? filteredForChart.filter((r) => r.renewal_date && r.renewal_date.slice(0, 7) === monthFilter)
    : filteredForChart), [filteredForChart, monthFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir]);

  // Pipeline: ARR and count by renewal month, over the filtered set (classic grouping).
  const pipeline = useMemo(() => {
    const m = new Map<string, { count: number; arr: number }>();
    for (const r of filteredForChart) {
      if (!r.renewal_date) continue;
      const ym = r.renewal_date.slice(0, 7);
      const e = m.get(ym) ?? { count: 0, arr: 0 };
      e.count += 1; e.arr += r.arr_up_for_renewal; m.set(ym, e);
    }
    return m;
  }, [filteredForChart]);
  // Category axis: a continuous month run so empty months read as gaps. The range is anchored
  // on today (renewals look forward), so it is a local control rather than useMonthRange.
  const now = thisMonth();
  const chartMonths = useMemo(() => {
    const dated = rows.filter((r) => r.renewal_date).map((r) => r.renewal_date!.slice(0, 7)).sort();
    if (!dated.length) return [];
    const [from, to] = chartRange === 'next12' ? [now, addMonths(now, 11)]
      : chartRange === 'year' ? [`${currentYear}-01`, `${currentYear}-12`]
      : [dated[0], dated[dated.length - 1]];
    const out: string[] = [];
    for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
    return out;
  }, [rows, chartRange, now, currentYear]);
  const pick = (m: string) => pipeline.get(m) ?? { count: 0, arr: 0 };
  const chartSeries = [
    { key: 'past', label: 'Renewal date passed', tone: 'other', values: chartMonths.map((m) => (m < now && m !== monthFilter ? pick(m).arr : 0)) },
    { key: 'upcoming', label: 'Upcoming', tone: 'div-1', values: chartMonths.map((m) => (m >= now && m !== monthFilter ? pick(m).arr : 0)) },
    ...(monthFilter ? [{ key: 'selected', label: 'Selected month (table)', tone: 'div-2', values: chartMonths.map((m) => (m === monthFilter ? pick(m).arr : 0)) }] : []),
  ];
  const inRangeArr = chartMonths.reduce((s, m) => s + pick(m).arr, 0);
  const inRangeCount = chartMonths.reduce((s, m) => s + pick(m).count, 0);

  const list = showAll ? sorted : sorted.slice(0, LIMIT);
  const totalArr = sorted.reduce((s, r) => s + r.arr_up_for_renewal, 0);
  const quotedN = sorted.filter((r) => (r.quotes?.length ?? 0) > 0).length;

  const exportCsv = () => downloadCsv(`renewal_management_${new Date().toISOString().slice(0, 10)}`,
    ['Customer', 'Allmoxy ID', 'Renewal Date', 'Days to Renewal', 'Current MRR', 'ARR up for Renewal', 'Cost Ratio Lifetime (%)', 'Cost Ratio Annualized (%)',
      'Orders YoY %', 'Recent 3mo cost ratio vs trailing 9mo (% change)', 'Risk Tier', 'Action Tag', 'Last Renewal Expansion', 'No Expansion Reason',
      'Pay Status', 'CS Pulse', 'Owner', 'Quote Count', 'Latest Quote Status', 'Latest Quote Amount', 'Latest Quote URL'],
    sorted.map((r) => [r.account_name, r.allmoxy_customer_id, r.renewal_date ?? '', r.days_to_renewal ?? '', r.current_mrr, r.arr_up_for_renewal,
      r.cost_ratio_lifetime_pct ?? '', r.cost_ratio_annualized_pct ?? '', r.orders_yoy_pct == null ? '' : Math.round(r.orders_yoy_pct * 100),
      r.dropoff_pct == null ? '' : Math.round(r.dropoff_pct * 100), r.risk_tier ?? '', r.action_tag, r.last_renewal_expansion ?? '',
      r.last_no_expansion_reason ?? '', r.pay_status, r.cs_pulse ?? '', r.owner_name ?? '', r.quotes?.length ?? 0,
      r.quotes?.[0]?.status ?? '', r.quotes?.[0]?.amount ?? '', r.quotes?.[0]?.hubspot_url ?? '']));

  const v = (x: number | string | null | undefined) => (isLoading ? '…' : x == null ? '—' : String(x));
  const active = (m: MetricFilter) => (metricFilter === m ? { tag: 'Showing in table', tagTone: 'info' as const } : null);
  const withQ = agg?.upcoming_renewals_with_quote, withoutQ = agg?.upcoming_renewals_without_quote;

  const subtitle = 'Upcoming renewals with expansion and contraction signals. Cost ratio is the share of a customer\'s verified order dollars they pay Allmoxy: lower is better, and it is the renewal story.';

  return (
    <DsPage
      path="/renewal-management"
      title="Renewal Management"
      subtitle={subtitle}
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!sorted.length}><Icon name="download" />Export CSV</button>}
      overlays={detail && <RenewalSheet row={detail} onClose={() => setDetail(null)}
        onCustomer={() => navigate(`/customer-detail?id=${encodeURIComponent(String(detail.allmoxy_customer_id))}`)} />}
    >
      {error ? <p className="am-card__text">Failed to load renewal_management: {String(error)}</p> : null}
      {agg?.base_customers != null && (
        <p className="am-card__text">
          {agg.customers ?? agg.total_instances} of {agg.base_customers} customers in the canonical customer base{agg.base_as_of ? ` (${agg.base_as_of})` : ''} · one row per customer
          {(agg.base_customers_without_instance ?? 0) > 0 ? ` · ${agg.base_customers_without_instance} without a HubSpot Instance` : ''}
          {(agg.active_instances_not_in_base ?? 0) > 0 ? ` · ${agg.active_instances_not_in_base} active-status Instance(s) excluded (not in the base: paused, lapsed or not yet billing)` : ''}
        </p>
      )}

      {/* Coming up: what needs preparing, soonest first. Select a card to list those customers. */}
      <KpiGrid max={5}>
        <KpiCard label="Renewals · next 90 days" value={v(agg?.renewals_in_next_90d)} hint={`${usdk(agg?.renewals_in_next_90d_arr ?? 0)} ARR`}
          tag={active('next_90d')?.tag ?? 'Act now'} tagTone={active('next_90d')?.tagTone ?? 'warning'} onOpen={() => toggleMetric('next_90d')} />
        <KpiCard label="Upcoming · no quote" value={v(withoutQ)} hint="Renewing within 12 months, no HubSpot quote started"
          tag={active('no_quote_upcoming')?.tag ?? 'Needs a quote'} tagTone={active('no_quote_upcoming')?.tagTone ?? 'warning'} onOpen={() => toggleMetric('no_quote_upcoming')} />
        <KpiCard label="Upcoming · with quote" value={v(withQ)}
          hint={withQ != null && withoutQ != null ? `of ${withQ + withoutQ} upcoming · ${withoutQ} without` : '—'}
          tag={active('with_quote')?.tag ?? 'Quoted'} tagTone={active('with_quote')?.tagTone ?? 'success'} onOpen={() => toggleMetric('with_quote')} />
        <KpiCard label="Renewals · next 180 days" value={v(agg?.renewals_in_next_180d)} hint={`${usdk(agg?.renewals_in_next_180d_arr ?? 0)} ARR`}
          tag={active('next_180d')?.tag ?? 'Plan ahead'} tagTone={active('next_180d')?.tagTone ?? 'neutral'} onOpen={() => toggleMetric('next_180d')} />
        <KpiCard label={`${currentYear} ARR up for renewal`} value={isLoading ? '…' : usdk(thisYear.arr)}
          hint={`${thisYear.count} renewal${thisYear.count === 1 ? '' : 's'} dated in ${currentYear}, passed and upcoming`}
          tag={active('this_year')?.tag ?? 'This year'} tagTone={active('this_year')?.tagTone ?? 'neutral'} onOpen={() => toggleMetric('this_year')} />
      </KpiGrid>
      {/* Account signals: which way each account is heading. */}
      <KpiGrid max={5}>
        <KpiCard label="Contraction risks" value={v(agg?.contraction_risks)} hint="Health at risk, or orders down 20%+ year on year"
          tag={active('contraction')?.tag ?? 'At risk'} tagTone={active('contraction')?.tagTone ?? 'error'} onOpen={() => toggleMetric('contraction')} />
        <KpiCard label="Cost-ratio drift" value={v(agg?.dropoff_count)} hint="Recent 3 months 25%+ worse than the trailing 9: orders falling faster than the fee"
          tag={active('dropoff')?.tag ?? 'Getting worse'} tagTone={active('dropoff')?.tagTone ?? 'warning'} onOpen={() => toggleMetric('dropoff')} />
        <KpiCard label="Expansion opportunities" value={v(agg?.expansion_opportunities)} hint="Orders up 20%+ year on year, health not at risk"
          tag={active('expansion')?.tag ?? 'Room to grow'} tagTone={active('expansion')?.tagTone ?? 'success'} onOpen={() => toggleMetric('expansion')} />
        <KpiCard label="No renewal date" value={v(noRenewalDateCount)} hint="Month to month, still in trial, or contract not entered in HubSpot"
          tag={active('no_renewal_date')?.tag ?? 'Fix in HubSpot'} tagTone={active('no_renewal_date')?.tagTone ?? 'info'} onOpen={() => toggleMetric('no_renewal_date')} />
        <KpiCard label="Median cost ratio · lifetime" value={isLoading ? '…' : fmtPct2(agg?.median_cost_ratio_lifetime_pct ?? null)}
          hint={`Annualized: ${fmtPct2(agg?.median_cost_ratio_annualized_pct ?? null)} · subscription paid ÷ verified orders`}
          tag="Lower is better" tagTone="neutral" />
      </KpiGrid>

      {metricFilter && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--info">Filtered</span>
            <p className="am-card__text">Showing <b>{metricFilterLabel(metricFilter)}</b> · {filtered.length} customer{filtered.length === 1 ? '' : 's'} match. Select the card again to clear.</p>
            <button className="am-btn am-btn--text" onClick={() => toggleMetric(metricFilter)}><Icon name="close" />Clear</button>
          </div>
        </section>
      )}

      <ChartCard title="Renewal pipeline · ARR by month"
        caption={`ARR coming up for renewal each month · select a month to list its customers below, select it again to clear · ${chartMonths.length ? `${mlabel(chartMonths[0])} to ${mlabel(chartMonths[chartMonths.length - 1])}` : ''} · ${inRangeCount} renewals, ${usd(inRangeArr)} in view`}>
        <div className="am-row am-row--wrap">
          <Segmented label="Months shown" value={chartRange} onChange={setChartRange}
            options={[['next12', 'Next 12 months'], ['year', String(currentYear)], ['all', 'All dates']]} />
          {monthFilter && (
            <>
              <span className="am-tag am-tag--info">Table: {mlabel(monthFilter)}</span>
              <button className="am-btn am-btn--text" onClick={() => setMonthFilter(null)}><Icon name="close" />Clear month</button>
            </>
          )}
        </div>
        {isLoading ? <p className="am-card__text">Loading…</p> : pipeline.size === 0 ? <p className="am-card__text">No renewal dates in the filtered set.</p> : (
          <ColumnChart months={chartMonths} series={chartSeries} fmt={usdk} stacked legend
            labelFor={(i) => { const e = pick(chartMonths[i]); return e.arr ? usdk(e.arr) : null; }}
            tipRows={(i) => {
              const m = chartMonths[i], e = pick(m);
              return [['ARR up for renewal', usd(e.arr)], ['Renewals', String(e.count)], ['Status', m === monthFilter ? 'Selected for the table' : m < now ? 'Renewal date passed' : m === now ? 'This month' : 'Upcoming']];
            }}
            onSegment={(i) => toggleMonth(chartMonths[i])}
            aria="Renewal pipeline, ARR up for renewal by month." />
        )}
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Renewals · {sorted.length} of {rows.length} customers · {usd(totalArr)} ARR</span>
          <span className="am-chart__caption">Select a customer for the renewal detail: proposed price, cost-ratio trend, contract and quotes.</span>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Action</span>
          {ACTIONS.map((a) => (
            <FilterChip key={a} checked={actionFilter.includes(a)}
              onChange={() => { setActionFilter((p) => (p.includes(a) ? p.filter((x) => x !== a) : [...p, a])); setShowAll(false); }}>
              {ACTION[a].word} ({actionCounts.get(a) ?? 0})
            </FilterChip>
          ))}
        </div>
        {ownerCounts.length > 0 && (
          <div className="am-row am-row--wrap">
            <span className="am-card__text">Owner</span>
            {ownerCounts.map(([o, n]) => (
              <FilterChip key={o} checked={ownerFilter.includes(o)}
                onChange={() => { setOwnerFilter((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o])); setShowAll(false); }}>
                {o} ({n})
              </FilterChip>
            ))}
          </div>
        )}
        <div className="am-row am-row--wrap">
          {metricFilter
            ? <span className="am-card__text">The selected card sets which customers show; the renewal-date switch is set aside while it is on.</span>
            : <Switch checked={showOnlyWithRenewalDate} onChange={(c) => { setShowOnlyWithRenewalDate(c); setShowAll(false); }}>Only customers with a renewal date</Switch>}
          <span className="am-card__text">Sort by</span>
          <Select label="Sort by" width={190} value={sortKey} onPick={(k) => pickSort(k as SortKey)} options={SORTS} />
          <button className="am-btn am-btn--text" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))} aria-label="Flip sort direction">
            <Icon name={sortDir === 'desc' ? 'arrow_downward' : 'arrow_upward'} />{sortDir === 'desc' ? 'Descending' : 'Ascending'}
          </button>
        </div>

        {isLoading ? <p className="am-card__text">Loading renewals…</p> : sorted.length === 0 ? <p className="am-card__text">No customers match this filter.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Renewals"
              cols={[['Renews', false], ['Customer', false], ['ARR', true], ['Cost % life', true], ['Cost % annual', true], ['Orders YoY', true], ['Health', false], ['Action', false], ['Quote', false], ['Owner', false]]}
              rows={list.map((r) => {
                const drift = r.dropoff_pct != null && r.dropoff_pct >= 0.25;
                const q = r.quotes ?? [];
                return [
                  r.renewal_date ? <span key="d" style={{ whiteSpace: 'nowrap' }}>{r.renewal_date}<br /><span className="am-card__text">{daysText(r.days_to_renewal)}</span></span> : '—',
                  <span key="c" className="am-row am-row--tight" style={{ maxWidth: 200 }}>
                    <span style={{ whiteSpace: 'normal', textAlign: 'left' }}>{r.account_name || r.customer_name}</span>
                    {r.last_renewal_expansion === 'Yes' && <span className="am-tag am-tag--success">Expanded last renewal</span>}
                    {r.vip_legacy === 'Yes' && <span className="am-tag am-tag--info">VIP</span>}
                  </span>,
                  usd(r.arr_up_for_renewal),
                  fmtPct2(r.cost_ratio_lifetime_pct),
                  fmtPct2(r.cost_ratio_annualized_pct),
                  <span key="y" className="am-row am-row--tight" style={{ justifyContent: 'flex-end', flexDirection: 'column', alignItems: 'flex-end' }}>
                    {fmtYoy(r.orders_yoy_pct)}{drift && <span className="am-tag am-tag--warning">Cost drift</span>}
                  </span>,
                  r.risk_tier ? <Tag key="h" t={HEALTH[r.risk_tier] ?? HEALTH.unscored} /> : '—',
                  <Tag key="a" t={ACTION[r.action_tag] ?? { word: r.action_tag, tone: 'neutral' }} />,
                  q.length === 0
                    ? (upcoming12(r) ? <span key="q" className="am-tag am-tag--warning">No quote</span> : <span key="q" className="am-card__text">None</span>)
                    : <span key="q" className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                        <a className="am-btn am-btn--text" href={q[0].hubspot_url} target="_blank" rel="noopener noreferrer">
                          {q[0].amount != null ? `$${Math.round(q[0].amount).toLocaleString()}` : 'Quote'}<Icon name="open_in_new" />
                        </a>
                        <Tag t={quoteStatus(q[0].status)} />
                        {q.length > 1 && <span className="am-card__text">+{q.length - 1} more</span>}
                      </span>,
                  r.owner_name || <span key="o" className="am-tag am-tag--neutral">Unassigned</span>,
                ];
              })}
              sortValues={list.map((r) => [r.days_to_renewal, (r.account_name || '').toLowerCase(), r.arr_up_for_renewal, r.cost_ratio_lifetime_pct,
                r.cost_ratio_annualized_pct, r.orders_yoy_pct, TIER_ORDER[r.risk_tier ?? 'unscored'] ?? 9, r.action_tag, r.quotes?.length ?? 0, (r.owner_name || '').toLowerCase()])}
              clickable={(c) => c === 1}
              onCell={(i) => setDetail(list[i])}
              foot={['Total', `${sorted.length} customers`, usd(totalArr), '', '', '', '', '', `${quotedN} quoted`, '']}
              onFoot={() => setShowAll(true)} footClickable={(c) => c <= 2 && !showAll && sorted.length > LIMIT} />
          </div>
        )}
        {!showAll && sorted.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {sorted.length}</button>}
        <p className="am-card__text">Showing {list.length} of {sorted.length} in this view. Column headers re-order the rows shown; Sort by orders the whole list. ARR is the HubSpot monthly fee × 12, or current MRR × 12 when HubSpot has none.</p>
      </section>
    </DsPage>
  );
}

// ---------------------------------------------------------------- renewal detail (the classic expanded row)
function RenewalSheet({ row, onClose, onCustomer }: { row: RenewalRow; onClose: () => void; onCustomer: () => void }) {
  const dropoffWorse = row.dropoff_pct != null && row.dropoff_pct >= 0.25;
  const dropoffBetter = row.dropoff_pct != null && row.dropoff_pct <= -0.25;
  // Classic page renders the panel with showUnderpriced=false: proposed price for tagged expansions only.
  const showProposed = row.proposed_mrr != null && row.action_tag === 'Expansion Opportunity';
  const trend = row.monthly_trend ?? [];
  const quotes = row.quotes ?? [];
  const qAmt = (q: Quote) => (q.amount != null ? `${q.currency === 'USD' ? '$' : `${q.currency} `}${Math.round(q.amount).toLocaleString()}` : '—');
  const ctx: Array<[string, ReactNode]> = [
    ['Renewal date', row.renewal_date ? `${row.renewal_date}${row.days_to_renewal != null ? ` · ${daysText(row.days_to_renewal)}` : ''}` : 'Not set in HubSpot'],
    ['Contract', `${row.contract_status || '—'}${row.contract_length_months ? ` · ${row.contract_length_months} mo term` : ''}`],
    ['ARR up for renewal', usd(row.arr_up_for_renewal)],
    ['HubSpot monthly fee', `${row.monthly_flat_fee_hubspot != null ? usd(row.monthly_flat_fee_hubspot) : '—'} (Stripe MRR: ${usd(row.current_mrr)})`],
    ['Cost ratio · lifetime', `${fmtPct2(row.cost_ratio_lifetime_pct)} (${usd(row.lifetime_subscription)} paid / ${usd(row.lifetime_orders_dollars)} verified)`],
    ['Cost ratio · annualized', `${fmtPct2(row.cost_ratio_annualized_pct)} (${usd(row.orders_monthly_avg_current_year)}/mo now vs ${usd(row.orders_monthly_avg_prior_year)}/mo prior year)`],
    ...(row.dropoff_pct != null ? [['Recent 3 mo cost ratio vs trailing 9 mo', <span key="dr" className="am-row am-row--tight">{`${row.dropoff_pct >= 0 ? '+' : ''}${Math.round(row.dropoff_pct * 100)}%`}
      {dropoffWorse && <span className="am-tag am-tag--warning">Worse: orders falling</span>}{dropoffBetter && <span className="am-tag am-tag--success">Better: orders growing</span>}</span>] as [string, ReactNode]] : []),
    ['Last renewal expansion', `${row.last_renewal_expansion || '—'}${row.last_no_expansion_reason ? ` · reason: ${row.last_no_expansion_reason}` : ''}`],
    ['Action', <span key="ac" className="am-row am-row--tight"><Tag t={ACTION[row.action_tag] ?? { word: row.action_tag, tone: 'neutral' }} /><span className="am-card__text">{row.action_reason}</span></span>],
    ...(row.cs_pulse ? [['CS pulse', row.cs_pulse] as [string, ReactNode]] : []),
    ...(row.implementation_status ? [['Implementation', row.implementation_status] as [string, ReactNode]] : []),
    ['Pay status', <span key="ps" className="am-row am-row--tight">{row.pay_status}{row.vip_legacy === 'Yes' && <span className="am-tag am-tag--info">VIP</span>}</span>],
  ];
  return (
    <SideSheet open onClose={onClose} title={row.account_name || row.customer_name}
      text={<>{row.owner_name ? `Owner: ${row.owner_name} · ` : ''}<button className="am-btn am-btn--text" onClick={onCustomer}>Open customer page<Icon name="arrow_forward" /></button></>}>
      {showProposed && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--success">Proposed renewal price</span>
            {row.proposed_basis === 'underpriced' && <span className="am-tag am-tag--success">Underpriced vs peers</span>}
            {row.expansion_confidence === 'low' && <span className="am-tag am-tag--warning">Low confidence</span>}
          </div>
          <div className="am-row am-row--wrap" style={{ alignItems: 'flex-start' }}>
            <div><span className="am-card__text">MRR</span><p className="am-summary__value">{usd(row.current_mrr)} → {usd(row.proposed_mrr ?? 0)}</p>
              {row.proposed_uplift_pct != null && <span className="am-card__text">{row.proposed_uplift_pct >= 0 ? '+' : ''}{row.proposed_uplift_pct}%</span>}</div>
            {row.proposed_arr != null && <div><span className="am-card__text">ARR</span><p className="am-summary__value">{usd(row.current_arr ?? row.arr_up_for_renewal ?? 0)} → {usd(row.proposed_arr)}</p></div>}
            {row.target_1pct_mrr != null && row.target_1pct_mrr > row.current_mrr && (
              <div><span className="am-card__text">At a 1% cost ratio (uncapped target)</span><p className="am-summary__value">{usd(row.target_1pct_mrr)}/mo</p>
                <span className="am-card__text">{usd(row.target_1pct_arr ?? 0)} ARR</span></div>
            )}
          </div>
          {row.expansion_rationale && <p className="am-card__text">{row.expansion_rationale}</p>}
          <p className="am-card__text">Realigns the cost ratio to the higher of this customer's lifetime ratio or the base median, on today's order run-rate, capped at +15% per renewal. A starting point, not a mandate.</p>
        </section>
      )}

      <ChartCard title="Cost ratio · monthly trend" caption="Subscription ÷ verified orders each month; lower is better. Complete months only: the month in progress is excluded so a partial month never looks like a contraction.">
        {trend.length === 0 ? <p className="am-card__text">No monthly history.</p> : (
          <ColumnChart months={trend.map((p) => p.month)} fmt={(x) => `${x.toFixed(1)}%`}
            series={[{ key: 'cr', label: 'Cost ratio', tone: 'div-1', values: trend.map((p) => p.cost_ratio_pct ?? 0) }]}
            labelFor={(i) => (trend[i].cost_ratio_pct == null ? null : `${trend[i].cost_ratio_pct!.toFixed(1)}%`)}
            tipRows={(i) => { const p = trend[i]; return [['Cost ratio', fmtPct2(p.cost_ratio_pct)], ['Subscription', usd(p.subscription)], ['Orders verified', `${usd(p.orders_dollars)}${p.orders_source === 'yearly_avg' ? ' (yearly average)' : ''}`]]; }}
            aria={`Monthly cost ratio for ${row.account_name}.`} />
        )}
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head"><span className="am-chart__title">Renewal context</span></div>
        <DataTable label="Renewal context" cols={[['Item', false], ['Detail', false]]} rows={ctx.map(([a, b]) => [a, b])} />
      </section>

      {quotes.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Quotes ({quotes.length})</span>
            <span className="am-chart__caption">Every HubSpot quote on this customer's company, newest first. Sent means active in HubSpot; Draft is still in progress.</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Quotes" cols={[['Title', false], ['Status', false], ['Amount', true], ['Created', false], ['Expires', false], ['', false]]}
              rows={quotes.map((q) => [q.title || '(untitled)', <Tag key="s" t={quoteStatus(q.status)} />, qAmt(q),
                q.created_date ? q.created_date.slice(0, 10) : '—', q.expiration_date ? q.expiration_date.slice(0, 10) : '—',
                <a key="l" className="am-btn am-btn--text" href={q.hubspot_url} target="_blank" rel="noopener noreferrer">Open in HubSpot<Icon name="open_in_new" /></a>])}
              sortValues={quotes.map((q) => [(q.title || '').toLowerCase(), q.status ?? '', q.amount, q.created_date ?? '', q.expiration_date ?? '', null])}
              foot={[`Total · ${quotes.length} quotes (all versions)`, '', usd(quotes.reduce((s, q) => s + (q.amount ?? 0), 0)), '', '', '']} />
          </div>
        </section>
      )}
    </SideSheet>
  );
}
