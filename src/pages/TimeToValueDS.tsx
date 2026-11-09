/**
 * Time to Value on the Allmoxy design system. Data logic is the classic page's (TimeToValue.tsx,
 * kept at /time-to-value-classic): the same time_to_value snapshot, the same live bid-only
 * overrides read from localStorage (polled, so a Customer Detail toggle shows here at once), the
 * same owner re-roll of every figure, and ONE at-risk category list that drives the burn card,
 * its /mo hint and the At-risk list filter.
 *
 * Cohort = the paying base (canonical customer base) less the labelled exclusions (HubSpot
 * Cancelled / Pause Granted), listed under the cards.
 *
 * Order: the headline money, then the list to work, then the category breakdown that steers the
 * list, then the launch-time distribution.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { exportRowsAsCsv } from '../lib/csvExport';
import { ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Select, usd } from '../design-system/parts';

type Category = 'onboarding' | 'gym_member' | 'never_launched_some_orders' | 'launched_dormant' | 'declining' | 'healthy' | 'bid_only' | 'no_data' | 'unknown';
type TtvCustomer = {
  allmoxy_customer_id: number; name: string; hubspot_company_id: string | null; owner_id: string | null; owner_name: string | null;
  primary_segment: string | null; sub_segment: string | null; first_payment_date: string | null; months_paying: number | null; years_with_us: number | null;
  current_subscription_mrr: number; lifetime_subscription: number; is_launched: boolean; live_date: number | null; months_to_launch: number | null;
  lifetime_orders: number; monthly_avg_current_year: number; monthly_avg_prior_year: number; category: Category; waste_label: string;
  wasted_to_date: number; current_burn_annualized: number; has_order_data: boolean; is_bid_only?: boolean;
};
type Snapshot = {
  fetched_at: string; as_of_year: number; cohort_size: number; cohort_base_size?: number;
  cohort_excluded?: Array<{ allmoxy_customer_id: number; name: string; pay_status: string | null; current_subscription_mrr: number; reason: string }>;
  at_risk_categories?: string[];
  summary: { total_wasted_to_date: number; total_annualized_burn_at_risk: number; gym_member_count: number; launched_dormant_count: number; declining_count: number; healthy_count: number };
  ttv_distribution: { sample_size: number; median_months: number | null; p90_months: number | null; buckets: Record<string, number> };
  by_category: Record<string, { label: string; count: number; current_mrr_sum: number; wasted_to_date_sum: number; annualized_burn_sum: number }>;
  customers: TtvCustomer[];
};

// ONE "at risk" definition for the burn card, its /mo hint and the At-risk filter (the ETL
// writes the same list as at_risk_categories). Includes no_data; excludes healthy, bid-only
// and onboarding. Identical to the classic page.
const AT_RISK_CATEGORIES: ReadonlyArray<string> = ['gym_member', 'never_launched_some_orders', 'launched_dormant', 'declining', 'no_data', 'unknown'];
const isAtRisk = (c: { category: string }) => AT_RISK_CATEGORIES.includes(c.category);

const CAT: Record<Category, { label: string; tone: 'error' | 'warning' | 'info' | 'success' | 'neutral' }> = {
  onboarding: { label: 'Onboarding', tone: 'info' },
  gym_member: { label: 'Never launched', tone: 'error' },
  never_launched_some_orders: { label: 'Hygiene gap', tone: 'warning' },
  launched_dormant: { label: 'Dormant', tone: 'warning' },
  declining: { label: 'Declining', tone: 'warning' },
  healthy: { label: 'Healthy', tone: 'success' },
  bid_only: { label: 'Bid-only', tone: 'info' },
  no_data: { label: 'No order data', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};
const catTag = (k: string) => { const c = CAT[k as Category] ?? { label: k, tone: 'neutral' as const }; return <span className={`am-tag am-tag--${c.tone}`}>{c.label}</span>; };

const BID_ONLY_STORAGE_KEY = 'allmoxy.bid_only.pending';
function readBidOnlyOverrides(): Record<string, boolean> {
  try { const raw = localStorage.getItem(BID_ONLY_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

type Filter = 'all' | 'at_risk' | Category;

export default function TimeToValueDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('time_to_value');
  const rawSnap = data as unknown as Snapshot | undefined;
  const listRef = useRef<HTMLElement>(null);

  // Live bid-only overrides from localStorage, polled exactly as the classic page.
  const [bidOnlyOverrides, setBidOnlyOverrides] = useState<Record<string, boolean>>(() => readBidOnlyOverrides());
  useEffect(() => {
    const reload = () => setBidOnlyOverrides(readBidOnlyOverrides());
    window.addEventListener('storage', reload);
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(t); };
  }, []);

  // ---- classic logic, verbatim: overrides applied, buckets + summary rebuilt
  const snap = useMemo<Snapshot | undefined>(() => {
    if (!rawSnap) return undefined;
    const customers = rawSnap.customers.map((c) => {
      const localOverride = bidOnlyOverrides[String(c.allmoxy_customer_id)];
      if (localOverride === undefined) return c;
      const wasBidOnly = c.category === 'bid_only';
      if (localOverride === wasBidOnly) return c;
      if (localOverride) {
        return { ...c, category: 'bid_only' as const, waste_label: 'Bid-only customer (live override) — uses Allmoxy primarily for quotes/bids that never verify as orders.', wasted_to_date: 0, is_bid_only: true };
      }
      return { ...c, category: 'healthy' as const, waste_label: 'Bid-only flag removed (live override) — health to recompute on next refresh.', is_bid_only: false };
    });
    const by_category: Snapshot['by_category'] = { ...rawSnap.by_category };
    for (const key of Object.keys(by_category)) by_category[key] = { ...by_category[key], count: 0, current_mrr_sum: 0, wasted_to_date_sum: 0, annualized_burn_sum: 0 };
    for (const c of customers) {
      const b = by_category[c.category];
      if (!b) continue;
      b.count++; b.current_mrr_sum += c.current_subscription_mrr; b.wasted_to_date_sum += c.wasted_to_date; b.annualized_burn_sum += c.current_burn_annualized;
    }
    const summary = {
      ...rawSnap.summary,
      total_wasted_to_date: customers.reduce((s, c) => s + c.wasted_to_date, 0),
      total_annualized_burn_at_risk: customers.filter(isAtRisk).reduce((s, c) => s + c.current_burn_annualized, 0),
      gym_member_count: customers.filter((c) => c.category === 'gym_member').length,
      launched_dormant_count: customers.filter((c) => c.category === 'launched_dormant').length,
      declining_count: customers.filter((c) => c.category === 'declining').length,
      healthy_count: customers.filter((c) => c.category === 'healthy').length,
    };
    return { ...rawSnap, customers, by_category, summary };
  }, [rawSnap, bidOnlyOverrides]);

  const [filter, setFilter] = useState<Filter>('at_risk');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [showAll, setShowAll] = useState(false);
  const [csvOrder, setCsvOrder] = useState<number[] | null>(null);

  const ownerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of snap?.customers ?? []) { const key = c.owner_name || '(unassigned)'; m.set(key, (m.get(key) ?? 0) + 1); }
    return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [snap]);

  // Owner slice: re-rolls every card / category / distribution figure, as the classic page.
  const viewSnap = useMemo(() => {
    if (!snap || ownerFilter === 'all') return snap;
    const customers = snap.customers.filter((c) => (c.owner_name || '(unassigned)') === ownerFilter);
    const by_category: Snapshot['by_category'] = { ...snap.by_category };
    for (const key of Object.keys(by_category)) by_category[key] = { ...by_category[key], count: 0, current_mrr_sum: 0, wasted_to_date_sum: 0, annualized_burn_sum: 0 };
    for (const c of customers) {
      const b = by_category[c.category];
      if (!b) continue;
      b.count++; b.current_mrr_sum += c.current_subscription_mrr || 0; b.wasted_to_date_sum += c.wasted_to_date || 0; b.annualized_burn_sum += c.current_burn_annualized || 0;
    }
    const summary: Snapshot['summary'] = {
      total_wasted_to_date: customers.reduce((s, c) => s + (c.wasted_to_date || 0), 0),
      total_annualized_burn_at_risk: customers.filter(isAtRisk).reduce((s, c) => s + (c.current_burn_annualized || 0), 0),
      gym_member_count: customers.filter((c) => c.category === 'gym_member').length,
      launched_dormant_count: customers.filter((c) => c.category === 'launched_dormant').length,
      declining_count: customers.filter((c) => c.category === 'declining').length,
      healthy_count: customers.filter((c) => c.category === 'healthy').length,
    };
    const ttvSamples = customers.filter((c) => c.is_launched && c.months_to_launch != null && c.months_to_launch >= 0).map((c) => c.months_to_launch as number).sort((a, b) => a - b);
    const pickPct = (arr: number[], p: number) => (arr.length === 0 ? null : arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]);
    const median = ttvSamples.length === 0 ? null : ttvSamples.length % 2 === 1
      ? ttvSamples[Math.floor(ttvSamples.length / 2)]
      : Math.round((ttvSamples[ttvSamples.length / 2 - 1] + ttvSamples[ttvSamples.length / 2]) / 2);
    const buckets: Record<string, number> = {};
    for (const k of Object.keys(snap.ttv_distribution.buckets)) buckets[k] = 0;
    for (const m of ttvSamples) {
      const key = m <= 3 ? '0-3' : m <= 6 ? '4-6' : m <= 12 ? '7-12' : m <= 18 ? '13-18' : m <= 24 ? '19-24' : '25+';
      buckets[key] = (buckets[key] ?? 0) + 1;
    }
    const ttv_distribution: Snapshot['ttv_distribution'] = { sample_size: ttvSamples.length, median_months: median, p90_months: pickPct(ttvSamples, 0.9), buckets };
    return { ...snap, customers, by_category, summary, cohort_size: customers.length, ttv_distribution };
  }, [snap, ownerFilter]);

  const filtered = useMemo(() => {
    let rows = snap?.customers ?? [];
    if (filter === 'at_risk') rows = rows.filter(isAtRisk);
    else if (filter !== 'all') rows = rows.filter((c) => c.category === filter);
    if (ownerFilter !== 'all') rows = rows.filter((c) => (c.owner_name || '(unassigned)') === ownerFilter);
    return rows;
  }, [snap, filter, ownerFilter]);
  // A new filter starts collapsed again; the category Total asks for the full list.
  const pickFilter = (f: Filter, all = false) => { setFilter(f); setShowAll(all); listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  const exportCsv = () => {
    const rows = csvOrder && csvOrder.length === filtered.length ? csvOrder.map((i) => filtered[i]) : filtered;
    exportRowsAsCsv(`time_to_value_${new Date().toISOString().slice(0, 10)}`, [
      { key: 'allmoxy_customer_id', label: 'Allmoxy ID' }, { key: 'name', label: 'Customer' }, { key: 'owner_name', label: 'Owner' },
      { key: 'category', label: 'Category' }, { key: 'current_subscription_mrr', label: 'Current MRR' }, { key: 'wasted_to_date', label: '$ Paid w/o Value' },
      { key: 'current_burn_annualized', label: 'Annual Burn' }, { key: 'lifetime_subscription', label: 'Lifetime $' }, { key: 'years_with_us', label: 'Tenure (yrs)' },
      { key: 'months_paying', label: 'Months Paying' }, { key: 'months_to_launch', label: 'Months to Launch' }, { key: 'live_date', label: 'Live Date Year' },
      { key: 'is_launched', label: 'Is Launched' }, { key: 'lifetime_orders', label: 'Lifetime Orders' }, { key: 'monthly_avg_current_year', label: '2026 Monthly Avg $' },
      { key: 'monthly_avg_prior_year', label: '2025 Monthly Avg $' }, { key: 'primary_segment', label: 'Primary Segment' }, { key: 'waste_label', label: 'Detail' },
      { key: 'hubspot_company_id', label: 'HubSpot ID' },
    ], rows as unknown as Array<Record<string, unknown>>);
  };

  const subtitle = 'Are paying customers getting real product value? Read from verified order data: orders flowing through Allmoxy mean value realized, whatever MRR is collected. Cohort = the paying customer base, less customers HubSpot marks Cancelled or Active - Pause Granted (listed under the cards).';

  if (error) {
    return <DsPage path="/time-to-value" title="Time to Value" subtitle={subtitle}><p className="am-card__text"><span className="am-tag am-tag--error">Failed to load</span> time_to_value: {String(error)}</p></DsPage>;
  }
  if (isLoading || !snap || !viewSnap) {
    return <DsPage path="/time-to-value" title="Time to Value" subtitle={subtitle}><p className="am-card__text">Loading time to value…</p></DsPage>;
  }

  // ---- card figures (classic helper maths, owner-sliced)
  const sumMrr = (cats: string[]) => viewSnap.customers.filter((c) => cats.includes(c.category)).reduce((s, c) => s + (c.current_subscription_mrr || 0), 0);
  const wastedMonthlyMrr = sumMrr(['gym_member', 'never_launched_some_orders', 'launched_dormant', 'declining']);
  const atRiskRows = viewSnap.customers.filter(isAtRisk);
  const burnMonthlyMrr = atRiskRows.reduce((s, c) => s + (c.current_subscription_mrr || 0), 0);
  const noDataAtRisk = atRiskRows.filter((c) => c.category === 'no_data').length;
  const healthyMonthlyMrr = sumMrr(['healthy', 'bid_only']);
  const dist = viewSnap.ttv_distribution;

  // ---- category table (classic: categories with a count; burn total leaves out Healthy and Bid-only)
  const cats = Object.entries(viewSnap.by_category).filter(([, b]) => b.count > 0);
  const totalCount = cats.reduce((s, [, b]) => s + b.count, 0);
  const totalMrr = cats.reduce((s, [, b]) => s + b.current_mrr_sum, 0);
  const totalWasted = cats.reduce((s, [, b]) => s + b.wasted_to_date_sum, 0);
  const totalBurn = cats.filter(([k]) => k !== 'healthy' && k !== 'bid_only').reduce((s, [, b]) => s + b.annualized_burn_sum, 0);
  const fmtPct = (v: number, total: number) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '—');

  // ---- list filter options (classic toggles, plus every category the table can select)
  const filterLabel = (f: Filter) => f === 'all' ? `All customers (${viewSnap.customers.length})` : f === 'at_risk' ? `At risk (${atRiskRows.length})` : `${CAT[f]?.label ?? f} (${viewSnap.by_category[f]?.count ?? 0})`;
  const filterOptions: Array<[string, string]> = [['all', filterLabel('all')], ['at_risk', filterLabel('at_risk')],
    ...(Object.keys(CAT) as Category[]).filter((k) => (viewSnap.by_category[k]?.count ?? 0) > 0 || k === filter).map((k) => [k, filterLabel(k)] as [string, string])];
  const ownerOptions: Array<[string, string]> = [['all', `All owners (${snap.customers.length})`], ...ownerCounts.map((o) => [o.name, `${o.name} (${o.count})`] as [string, string])];

  const LIMIT = 25;
  const excluded = snap.cohort_excluded ?? [];

  return (
    <DsPage path="/time-to-value" title="Time to Value" subtitle={subtitle}
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={filtered.length === 0}><Icon name="download" />Export CSV</button>}>

      <KpiGrid>
        <KpiCard label="Paid without value" value={usd(viewSnap.summary.total_wasted_to_date)}
          hint={`Cumulative paid by customers not getting value · ${usd(wastedMonthlyMrr)}/mo continuing`}
          tag={viewSnap.summary.total_wasted_to_date > 0 ? 'Losing value' : 'None'} tagTone={viewSnap.summary.total_wasted_to_date > 0 ? 'error' : 'success'}
          onOpen={() => pickFilter('at_risk')} />
        <KpiCard label="Annualized burn at risk" value={usd(viewSnap.summary.total_annualized_burn_at_risk)}
          hint={`If the ${atRiskRows.length} at-risk customers (never launched, hygiene gap, dormant, declining, no order data${noDataAtRisk > 0 ? `: ${noDataAtRisk} with no order data` : ''}) don't realize value in the next 12 months · ${usd(burnMonthlyMrr)}/mo at risk`}
          tag={atRiskRows.length > 0 ? `${atRiskRows.length} at risk` : 'None at risk'} tagTone={atRiskRows.length > 0 ? 'warning' : 'success'}
          onOpen={() => pickFilter('at_risk')} />
        <KpiCard label="Median time to value" value={`${dist.median_months ?? '—'} mo`}
          hint={`p90: ${dist.p90_months ?? '—'} mo · ${dist.sample_size ?? 0} launched`} />
        <KpiCard label="Healthy" value={String(viewSnap.summary.healthy_count ?? 0)}
          hint={`${ownerFilter === 'all' && viewSnap.cohort_base_size != null
            ? `of ${viewSnap.cohort_size} in cohort (of ${viewSnap.cohort_base_size} paying; ${viewSnap.cohort_excluded?.length ?? 0} excluded: HubSpot Cancelled / Pause Granted)`
            : `of ${viewSnap.cohort_size ?? 0} ${ownerFilter === 'all' ? 'paying customers' : `${ownerFilter}'s customers`}`} · ${usd(healthyMonthlyMrr)}/mo realized`}
          tag="Realizing value" tagTone="success" onOpen={() => pickFilter('healthy')} />
      </KpiGrid>

      {snap.cohort_base_size != null && (
        <p className="am-card__text">
          Cohort: {snap.cohort_base_size} paying customers (canonical customer base) − {excluded.length} excluded = {snap.cohort_size}
          {excluded.length > 0 && <> · excluded: {excluded.map((e) => `${e.name} (${e.pay_status}, ${usd(e.current_subscription_mrr)}/mo)`).join('; ')}</>}
        </p>
      )}

      {/* The list to work */}
      <section className="am-card am-card--outlined" ref={listRef}>
        <div className="am-row am-row--spread am-row--wrap">
          <div className="am-chart__head">
            <span className="am-chart__title">{filter === 'all' ? 'All customers' : filter === 'at_risk' ? 'At-risk customers' : CAT[filter]?.label ?? filter} · {filtered.length}</span>
            <span className="am-chart__caption">{filter === 'at_risk' ? 'Never launched, hygiene gap, dormant, declining and no order data: the same customers as the burn card' : 'Select a category in the breakdown below, or pick one here'}{ownerFilter !== 'all' ? ` · ${ownerFilter}'s book` : ''}</span>
          </div>
          <div className="am-row am-row--wrap">
            <Select label="Show" value={filter} options={filterOptions} onPick={(v) => { setFilter(v as Filter); setShowAll(false); }} width={240} />
            {ownerCounts.length > 0 && <Select label="Owner" value={ownerFilter} options={ownerOptions} onPick={(v) => { setOwnerFilter(v); setShowAll(false); }} width={220} />}
          </div>
        </div>
        {filtered.length === 0 ? <p className="am-card__text">No customers in this category.</p> : <>
          <DataTable label="Time to value by customer"
            cols={[['Customer', false], ['Category', false], ['Owner', false], ['MRR', true], ['Paid without value', true], ['Annual burn', true], ['Months paying', true], ['Launch and orders', false], ['Detail', false]]}
            rows={filtered.map((c) => [
              <span key="n" style={{ display: 'block', minWidth: 160, maxWidth: 250 }}>
                <button className="am-btn am-btn--text" style={{ whiteSpace: 'normal', textAlign: 'left', height: 'auto' }} onClick={() => navigate(`/customer-detail?id=${encodeURIComponent(String(c.allmoxy_customer_id))}`)}>{c.name}</button>
                {c.primary_segment && <span className="am-card__text" style={{ display: 'block' }}>{c.primary_segment}{c.sub_segment ? ` · ${c.sub_segment}` : ''}</span>}
              </span>,
              catTag(c.category),
              c.owner_name || 'Unassigned',
              usd(c.current_subscription_mrr),
              usd(c.wasted_to_date),
              usd(c.current_burn_annualized),
              <span key="m">{c.months_paying != null ? `${c.months_paying} mo` : '—'}{c.months_to_launch != null && <span className="am-card__text" style={{ display: 'block' }}>{c.months_to_launch} mo to launch</span>}</span>,
              <span key="l" style={{ display: 'block', minWidth: 120 }}>
                {c.is_launched ? <span className="am-tag am-tag--success">Live {c.live_date}</span> : <span className="am-tag am-tag--error">No live date</span>}
                <span className="am-card__text" style={{ display: 'block' }}>{c.lifetime_orders} lifetime · {usd(c.monthly_avg_current_year)}/mo (2026)</span>
              </span>,
              <span key="d" className="am-card__text" style={{ display: 'block', minWidth: 160, maxWidth: 240 }}>{c.waste_label}</span>,
            ])}
            sortValues={filtered.map((c) => [c.name, CAT[c.category]?.label ?? c.category, c.owner_name ?? '￿', c.current_subscription_mrr, c.wasted_to_date, c.current_burn_annualized, c.months_paying, c.is_launched ? (c.live_date ?? 0) : -1, c.waste_label])}
            onSortChange={(order) => setCsvOrder(order)}
            limit={showAll ? undefined : LIMIT}
            foot={[`Total · ${filtered.length} customers`, '', '', usd(filtered.reduce((s, c) => s + c.current_subscription_mrr, 0)), usd(filtered.reduce((s, c) => s + c.wasted_to_date, 0)), usd(filtered.reduce((s, c) => s + c.current_burn_annualized, 0)), '', '', '']}
            onFoot={() => setShowAll(true)} footClickable={(c) => [0, 3, 4, 5].includes(c) && !showAll && filtered.length > LIMIT} />
          {!showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {filtered.length}</button>}
        </>}
      </section>

      {/* Category breakdown, steering the list */}
      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">By category</span>
          <span className="am-chart__caption">Select a category to list its customers. Never launched: never went live, never ran a verified order (highest concern). Hygiene gap: has orders but no Live Date in the orders file, likely live but not flagged. Dormant: Live Date present but no orders in {snap.as_of_year} so far. Declining: orders down more than half year over year (monthly average). Healthy: launched, running orders, not declining.</span>
        </div>
        <DataTable label="Customers by category"
          cols={[['Category', false], ['Customers', true], ['% of total', true], ['Current MRR', true], ['% of MRR', true], ['Paid without value', true], ['Annualized burn', true]]}
          rows={cats.map(([key, b]) => [
            <span key="c" className="am-row am-row--tight">{catTag(key)}<span className="am-card__text">{b.label}</span></span>,
            String(b.count), fmtPct(b.count, totalCount), usd(b.current_mrr_sum), fmtPct(b.current_mrr_sum, totalMrr), usd(b.wasted_to_date_sum), usd(b.annualized_burn_sum)])}
          sortValues={cats.map(([key, b]) => [CAT[key as Category]?.label ?? key, b.count, b.count, b.current_mrr_sum, b.current_mrr_sum, b.wasted_to_date_sum, b.annualized_burn_sum])}
          clickable={(c) => c === 1} onCell={(row) => pickFilter(cats[row][0] as Category)}
          foot={['Total', String(totalCount), '100.0%', usd(totalMrr), '100.0%', usd(totalWasted), usd(totalBurn)]}
          onFoot={() => pickFilter('all', true)} footClickable={(c) => c === 1} />
        <p className="am-card__text">The annualized burn total leaves out Healthy and Bid-only, which are realizing value.</p>
      </section>

      {/* Distribution */}
      {(dist.sample_size ?? 0) > 0 && (
        <ChartCard title="Time to value distribution"
          caption={`Months between first payment and Live Date for ${dist.sample_size} launched customers${ownerFilter === 'all' ? '' : ` (${ownerFilter}'s book)`}. Median ${dist.median_months} months · p90 ${dist.p90_months} months. Customers paying for more than ${dist.p90_months} months without launching are outlier risk.`}>
          <ColumnChart months={Object.keys(dist.buckets)} fmt={(v) => Math.round(v).toLocaleString()}
            series={[{ key: 'count', label: 'Customers', tone: 'div-1', values: Object.values(dist.buckets) }]}
            catLabel={(k) => k} catTitle={(k) => `${k} to launch`}
            aria="Launched customers by months from first payment to Live Date." />
        </ChartCard>
      )}

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">How this complements the Churn Risk Matrix</span>
          <span className="am-chart__caption">The Churn Risk Matrix shows the full five-signal health picture. This page zooms into the single strongest signal, verified order volume, to surface customers paying without realizing product value. Closing the Hygiene gap (orders but no Live Date marked) sharpens the rest of the dashboard; closing Dormant and Declining closes real revenue risk.</span>
        </div>
        <div className="am-row"><button className="am-btn am-btn--text" onClick={() => navigate('/churn-risk-matrix')}>Open the Churn Risk Matrix<Icon name="arrow_forward" /></button></div>
      </section>
    </DsPage>
  );
}
