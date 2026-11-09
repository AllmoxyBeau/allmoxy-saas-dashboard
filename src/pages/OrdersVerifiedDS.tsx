/**
 * Orders Verified on the Allmoxy design system. Data logic is ported verbatim from the classic
 * page (OrdersVerified.tsx, kept at /orders-verified-classic): same orders_verified +
 * customer_profiles snapshots joined by Allmoxy ID, same per-row months-loaded rule (months with
 * dollars, falling back to the supplement), same book-level annualization (current-year $ × 12 ÷
 * the number of months of the year that carry revenue across the filtered set), same YoY, same
 * yearly aggregation, same filters (search, segment, status, launched only) and the same CSV.
 *
 * UI changes only: status as a word tag, the yearly chart as stacked columns (invoiced, plus the
 * projected remainder on the in-progress year) with an "Active customers" view in place of the
 * classic line, a year's bar opens its customers, and the table shows the top 25 with a Total row.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, SearchField, Segmented, SideSheet,
  downloadCsv, usd, usdk,
} from '../design-system/parts';

type OrdersYear = { order_count: number | null; total_usd: number; subtotal_usd?: number; b2b_subtotal_usd?: number };
type OrdersRecord = {
  allmoxy_customer_id: number;
  name: string;
  installer_id: string | null;
  subdomain: string | null;
  years: Record<string, OrdersYear>;
  monthly_avg: Record<string, number>;
  monthly_supplement?: Record<string, number>;
  monthly_verified?: Record<string, { usd: number | null; orders: number | null; even_spread?: boolean }>;
  live_date: string | null;
  is_launched: boolean;
  months_to_launch: number | null;
  total_lifetime_orders: number;
  total_lifetime_usd: number;
  monthly_avg_current_year: number;
  monthly_avg_prior_year: number;
  monthly_avg_yoy_pct: number | null;
};
type OrdersSnap = { by_customer: Record<string, OrdersRecord> };
type Profile = {
  allmoxy_customer_id: number;
  hubspot_instance_name?: string | null;
  customer_name?: string | null;
  name?: string | null;
  status: string;
  pay_status: string | null;
  primary_segment: string | null;
  sub_segment: string | null;
  instance_owner_first_name: string | null;
  instance_owner: string | null;
  current_subscription_mrr: number;
};
type Row = {
  aid: number; name: string; segment: string | null; sub_segment: string | null; owner: string; status: string;
  pay_status: string | null; live_date: string | null; months_to_launch: number | null;
  lifetime_orders: number; lifetime_usd: number; current_year_usd: number; current_year_annualized: number;
  prior_year_usd: number; monthly_avg_current: number; monthly_avg_prior: number; yoy_pct: number | null;
  months_loaded: number;
  monthly_verified?: Record<string, { usd: number | null; orders: number | null; even_spread?: boolean }>;
  current_mrr: number;
  years_by_total: Record<string, { order_count: number | null; total_usd: number }>;
};
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const STATUSES: Array<{ key: string; label: string; tone: Tone }> = [
  { key: 'non_payment', label: 'Lapsed', tone: 'error' },
  { key: 'at_risk', label: 'At risk', tone: 'warning' },
  { key: 'paused', label: 'Paused', tone: 'info' },
  { key: 'active', label: 'Active', tone: 'success' },
  { key: 'never_paid', label: 'Never paid', tone: 'neutral' },
  { key: 'churned', label: 'Churned', tone: 'neutral' },
];
const statusOf = (k: string) => STATUSES.find((s) => s.key === k) ?? { key: k, label: k ? k.replace(/_/g, ' ') : 'Unknown', tone: 'neutral' as Tone };
const signedPct = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`);
const LIMIT = 25;
// usdk tops out at millions; lifetime invoicing runs into billions.
const usdb = (v: number) => (Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : usdk(v));

export default function OrdersVerifiedDS() {
  const navigate = useNavigate();
  const { data: ordersData, isLoading: ordersLoading, error: ordersError } = useSheetTab<OrdersSnap>('orders_verified');
  const { data: profilesData, isLoading: profilesLoading } = useSheetTab<Profile>('customer_profiles');
  const isLoading = ordersLoading || profilesLoading;

  const [search, setSearch] = useState('');
  const [segmentFilter, setSegmentFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [launchedOnly, setLaunchedOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [view, setView] = useState<'usd' | 'customers'>('usd');
  const [yearSheet, setYearSheet] = useState<string | null>(null);
  const [yearShowAll, setYearShowAll] = useState(false);
  const [order, setOrder] = useState<number[] | null>(null);
  const reset = () => setShowAll(false);

  const ordersByAid = useMemo(() => (ordersData as unknown as OrdersSnap | undefined)?.by_customer ?? {}, [ordersData]);
  const profileByAid = useMemo(() => {
    const m = new Map<number, Profile>();
    for (const p of (profilesData?.rows ?? [])) m.set(p.allmoxy_customer_id, p);
    return m;
  }, [profilesData]);

  // ---- rows: identical to classic
  const allRows = useMemo<Row[]>(() => {
    const currentYear = new Date().getFullYear();
    const priorYear = currentYear - 1;
    const rows: Row[] = [];
    for (const ov of Object.values(ordersByAid)) {
      const profile = profileByAid.get(ov.allmoxy_customer_id);
      // Months that carry DOLLARS in the current year (not months with any data), falling back
      // to the retired xlsx supplement — the classic page's rule.
      const goldMonths = Object.entries(ov.monthly_verified || {})
        .filter(([m, v]) => m.startsWith(String(currentYear)) && (v?.usd || 0) > 0).length;
      const monthsLoaded = goldMonths || Object.keys(ov.monthly_supplement || {}).length;
      const curYearTotal = ov.years?.[String(currentYear)]?.total_usd || 0;
      const priorYearTotal = ov.years?.[String(priorYear)]?.total_usd || 0;
      const annualized = monthsLoaded > 0 && monthsLoaded < 12 ? (curYearTotal * 12) / monthsLoaded : curYearTotal;
      rows.push({
        aid: ov.allmoxy_customer_id,
        name: profile?.hubspot_instance_name || profile?.customer_name || profile?.name || ov.name,
        segment: profile?.primary_segment ?? null,
        sub_segment: profile?.sub_segment ?? null,
        owner: profile?.instance_owner_first_name?.trim() || profile?.instance_owner?.trim() || '',
        status: profile?.status ?? '',
        pay_status: profile?.pay_status ?? null,
        live_date: ov.live_date,
        months_to_launch: ov.months_to_launch,
        lifetime_orders: ov.total_lifetime_orders || 0,
        lifetime_usd: ov.total_lifetime_usd || 0,
        current_year_usd: curYearTotal,
        current_year_annualized: annualized,
        prior_year_usd: priorYearTotal,
        monthly_avg_current: ov.monthly_avg_current_year || 0,
        monthly_avg_prior: ov.monthly_avg_prior_year || 0,
        yoy_pct: ov.monthly_avg_yoy_pct,
        months_loaded: monthsLoaded,
        monthly_verified: ov.monthly_verified,
        current_mrr: profile?.current_subscription_mrr || 0,
        years_by_total: ov.years || {},
      });
    }
    return rows;
  }, [ordersByAid, profileByAid]);

  const facets = useMemo(() => {
    const segments = new Map<string, number>();
    const statuses = new Map<string, number>();
    for (const r of allRows) {
      if (r.segment) segments.set(r.segment, (segments.get(r.segment) ?? 0) + 1);
      if (r.status) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    }
    return {
      segments: [...segments.entries()].sort((a, b) => b[1] - a[1]),
      statuses: [...statuses.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [allRows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allRows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (segmentFilter.length > 0 && !segmentFilter.includes(r.segment ?? '')) return false;
      if (statusFilter.length > 0 && !statusFilter.includes(r.status)) return false;
      if (launchedOnly && !r.live_date) return false;
      return true;
    });
  }, [allRows, search, segmentFilter, statusFilter, launchedOnly]);

  // ---- summary: identical to classic (book-level annualization, one global denominator)
  const summary = useMemo(() => {
    const currentYearStr = String(new Date().getFullYear());
    const monthsWithRevenue = new Set<string>();
    for (const r of filtered) {
      for (const [m, mv] of Object.entries(r.monthly_verified || {})) {
        if (m.startsWith(currentYearStr) && (mv?.usd || 0) > 0) monthsWithRevenue.add(m);
      }
    }
    const globalMonthsLoaded = monthsWithRevenue.size;
    const totalYtd = filtered.reduce((s, r) => s + r.current_year_usd, 0);
    const totalAnnualized = globalMonthsLoaded > 0 && globalMonthsLoaded < 12 ? (totalYtd * 12) / globalMonthsLoaded : totalYtd;
    const totalPriorYear = filtered.reduce((s, r) => s + r.prior_year_usd, 0);
    const yoyPct = totalPriorYear > 0 ? (totalAnnualized - totalPriorYear) / totalPriorYear : null;
    return {
      count: filtered.length,
      totalAnnualized, totalYtd, globalMonthsLoaded, totalPriorYear,
      totalLifetime: filtered.reduce((s, r) => s + r.lifetime_usd, 0),
      totalLifetimeOrders: filtered.reduce((s, r) => s + r.lifetime_orders, 0),
      totalMrr: filtered.reduce((s, r) => s + r.current_mrr, 0),
      totalMaCurrent: filtered.reduce((s, r) => s + r.monthly_avg_current, 0),
      launchedCount: filtered.filter((r) => r.live_date).length,
      growingCount: filtered.filter((r) => r.yoy_pct != null && r.yoy_pct > 0).length,
      decliningCount: filtered.filter((r) => r.yoy_pct != null && r.yoy_pct < 0).length,
      yoyPct,
    };
  }, [filtered]);

  // ---- yearly chart: identical aggregation to classic
  const yearly = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const totals = new Map<string, { total_usd: number; orders: number; active_customers: number }>();
    for (const r of filtered) {
      for (const [year, y] of Object.entries(r.years_by_total)) {
        const orderCount = y.order_count;
        const usdV = y.total_usd || 0;
        if ((orderCount || 0) === 0 && usdV === 0) continue;
        if (!totals.has(year)) totals.set(year, { total_usd: 0, orders: 0, active_customers: 0 });
        const e = totals.get(year)!;
        e.total_usd += usdV;
        if (orderCount != null) e.orders += orderCount;
        e.active_customers += 1;
      }
    }
    return [...totals.entries()].map(([year, v]) => {
      const isCurrent = Number(year) === currentYear;
      let monthsLoaded = 12;
      if (isCurrent) {
        const monthsWithRevenue = new Set<string>();
        for (const r of filtered) {
          for (const [m, mv] of Object.entries(r.monthly_verified || {})) {
            if (m.startsWith(year) && (mv?.usd || 0) > 0) monthsWithRevenue.add(m);
          }
        }
        if (monthsWithRevenue.size > 0) monthsLoaded = monthsWithRevenue.size;
      }
      const annualized = isCurrent && monthsLoaded > 0 && monthsLoaded < 12 ? (v.total_usd * 12) / monthsLoaded : v.total_usd;
      return {
        year,
        actual_usd: Math.round(v.total_usd * 100) / 100,
        projected_extra: Math.round(Math.max(0, annualized - v.total_usd) * 100) / 100,
        projected_total: Math.round(annualized * 100) / 100,
        orders: v.orders,
        active_customers: v.active_customers,
        is_partial: isCurrent && monthsLoaded < 12,
        months_loaded: isCurrent ? Math.round(monthsLoaded * 10) / 10 : 12,
      };
    }).sort((a, b) => a.year.localeCompare(b.year));
  }, [filtered]);

  const yearKeys = yearly.map((y) => y.year);
  const partialYear = yearly.find((y) => y.is_partial)?.year;
  const series = view === 'usd'
    ? [
      { key: 'actual', label: 'Invoiced $', tone: 'div-1', values: yearly.map((y) => y.actual_usd) },
      { key: 'projected', label: 'Projected remainder (if pace holds)', tone: 'other', values: yearly.map((y) => y.projected_extra) },
    ]
    : [{ key: 'customers', label: 'Active customers', tone: 'div-1', values: yearly.map((y) => y.active_customers) }];

  // ---- table
  const csvCols: Array<[string, (r: Row) => string | number]> = [
    ['Allmoxy ID', (r) => r.aid], ['Customer', (r) => r.name], ['Segment', (r) => r.segment ?? ''], ['Sub-segment', (r) => r.sub_segment ?? ''],
    ['Owner', (r) => r.owner], ['Status', (r) => r.status], ['Pay status', (r) => r.pay_status ?? ''], ['Live date', (r) => r.live_date ?? ''],
    ['Months to launch', (r) => r.months_to_launch ?? ''], ['Lifetime orders', (r) => r.lifetime_orders], ['Lifetime invoice $', (r) => r.lifetime_usd],
    ['YTD invoice $', (r) => r.current_year_usd], ['YTD annualized $', (r) => r.current_year_annualized], ['Prior year invoice $', (r) => r.prior_year_usd],
    ['Monthly avg (current)', (r) => r.monthly_avg_current], ['Monthly avg (prior)', (r) => r.monthly_avg_prior],
    ['YoY %', (r) => (r.yoy_pct == null ? '' : Math.round(r.yoy_pct * 100))], ['Current MRR', (r) => r.current_mrr],
  ];
  const exportCsv = () => {
    const ord = order && order.length === filtered.length ? order : filtered.map((_, i) => i);
    downloadCsv('orders_verified', csvCols.map(([h]) => h), ord.map((i) => csvCols.map(([, f]) => f(filtered[i]))));
  };

  const detailHref = (aid: number) => `/customer-detail?id=${encodeURIComponent(String(aid))}`;
  const nameLink = (aid: number, name: string) => (
    <a className="am-btn am-btn--text" href={detailHref(aid)} style={{ whiteSpace: 'normal', textAlign: 'left', maxWidth: 260 }}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(detailHref(aid)); }}>{name}</a>
  );
  const rowYoy = (r: Row) => (r.yoy_pct == null || r.yoy_pct === -1 ? null : r.yoy_pct);

  const cols: Array<[string, boolean]> = [
    ['Customer', false], ['Status', false], ['YTD annualized', true], ['YTD $', true], ['Prior year $', true], ['YoY', true],
    ['Monthly avg', true], ['Lifetime $', true], ['Lifetime orders', true], ['MRR', true],
    ['Segment', false], ['Sub-segment', false], ['Owner', false], ['Live date', false],
  ];
  // Memoized: DataTable re-sorts (and reports the order for the CSV) whenever rows change.
  const tableRows = useMemo<ReactNode[][]>(() => filtered.map((r) => {
    const s = statusOf(r.status);
    return [
      nameLink(r.aid, r.name),
      r.status ? <span className={`am-tag am-tag--${s.tone}`}>{s.label}</span> : '—',
      usd(r.current_year_annualized),
      r.months_loaded > 0 && r.months_loaded < 12 ? `${usd(r.current_year_usd)} (${r.months_loaded} mo)` : usd(r.current_year_usd),
      usd(r.prior_year_usd),
      signedPct(rowYoy(r)),
      `${usd(r.monthly_avg_current)}/mo`,
      usd(r.lifetime_usd),
      r.lifetime_orders.toLocaleString(),
      usd(r.current_mrr),
      r.segment ?? '—', r.sub_segment ?? '—', r.owner || '—', r.live_date ?? '—',
    ];
  }), [filtered]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortValues = useMemo(() => filtered.map((r) => [
    (r.name || '').toLowerCase(), r.status, r.current_year_annualized, r.current_year_usd, r.prior_year_usd, rowYoy(r),
    r.monthly_avg_current, r.lifetime_usd, r.lifetime_orders, r.current_mrr,
    (r.segment || '').toLowerCase(), (r.sub_segment || '').toLowerCase(), (r.owner || '~').toLowerCase(), r.live_date || '',
  ]), [filtered]);
  const foot: ReactNode[] = [
    `Total · ${summary.count.toLocaleString()} customers`, '',
    usd(summary.totalAnnualized), usd(summary.totalYtd), usd(summary.totalPriorYear), signedPct(summary.yoyPct),
    `${usd(summary.totalMaCurrent)}/mo`, usd(summary.totalLifetime), summary.totalLifetimeOrders.toLocaleString(), usd(summary.totalMrr),
    '', '', '', '',
  ];

  // ---- year drill
  const yearRows = useMemo(() => {
    if (!yearSheet) return [];
    return filtered
      .map((r) => ({ r, y: r.years_by_total[yearSheet] }))
      .filter((e): e is { r: Row; y: { order_count: number | null; total_usd: number } } => !!e.y && !((e.y.order_count || 0) === 0 && (e.y.total_usd || 0) === 0));
  }, [filtered, yearSheet]);
  const yearInfo = yearly.find((y) => y.year === yearSheet);

  const anyFilter = launchedOnly || !!search || segmentFilter.length + statusFilter.length > 0;
  const clearAll = () => { setLaunchedOnly(false); setSearch(''); setSegmentFilter([]); setStatusFilter([]); reset(); };
  const toggleIn = (arr: string[], set: (v: string[]) => void, k: string) => { set(arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]); reset(); };
  const loadingV = (v: string) => (isLoading ? '…' : v);
  const mo = summary.globalMonthsLoaded;

  return (
    <DsPage
      path="/orders-verified"
      title="Orders Verified"
      subtitle="Verified order volume and invoice $ for every customer with order data. Filter by segment to compare books of business. Year-to-date is annualized so a partial year compares with prior full years."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!filtered.length}><Icon name="download" />Export CSV</button>}
      overlays={
        <SideSheet open={!!yearSheet} onClose={() => { setYearSheet(null); setYearShowAll(false); }}
          title={yearSheet ? `${yearSheet}${yearInfo?.is_partial ? ' (in progress)' : ''} · invoiced $ by customer` : ''}
          text={yearInfo ? `${yearRows.length.toLocaleString()} customers invoiced ${usd(yearInfo.actual_usd)}${yearInfo.is_partial ? ` in ${yearInfo.months_loaded} months; at this pace the year ends near ${usd(yearInfo.projected_total)}` : ''}.` : undefined}>
          {yearSheet && (
            <>
              <DataTable label={`Invoiced $ by customer, ${yearSheet}`}
                cols={[['Customer', false], ['Status', false], ['Invoiced $', true], ['Orders', true]]}
                rows={yearRows.map(({ r, y }) => [
                  nameLink(r.aid, r.name),
                  r.status ? <span className={`am-tag am-tag--${statusOf(r.status).tone}`}>{statusOf(r.status).label}</span> : '—',
                  usd(y.total_usd || 0),
                  y.order_count == null ? '—' : y.order_count.toLocaleString(),
                ])}
                sortValues={yearRows.map(({ r, y }) => [r.name.toLowerCase(), r.status, y.total_usd || 0, y.order_count])}
                defaultSort={{ col: 2, dir: 'desc' }}
                limit={yearShowAll ? undefined : LIMIT}
                foot={[`Total · ${yearRows.length.toLocaleString()} customers`, '', usd(yearRows.reduce((s, { y }) => s + (y.total_usd || 0), 0)),
                  yearRows.some(({ y }) => y.order_count != null) ? yearRows.reduce((s, { y }) => s + (y.order_count || 0), 0).toLocaleString() : '—']}
                onFoot={() => setYearShowAll(true)} footClickable={(c) => c >= 2 && !yearShowAll && yearRows.length > LIMIT} />
              {yearRows.length > LIMIT && (
                <div className="am-row">
                  <button className="am-btn am-btn--text" onClick={() => setYearShowAll(!yearShowAll)}>
                    {yearShowAll ? `Show top ${LIMIT}` : `Show all ${yearRows.length.toLocaleString()}`}
                  </button>
                </div>
              )}
            </>
          )}
        </SideSheet>
      }
    >
      {ordersError ? <p className="am-card__text">Failed to load orders_verified: {String(ordersError)}</p> : null}

      <KpiGrid>
        <KpiCard label="YTD annualized" value={loadingV(usdk(summary.totalAnnualized))}
          hint={`${usdk(summary.totalYtd)} invoiced this year × 12 ÷ ${mo || '—'} months with revenue. Prior year: ${usdk(summary.totalPriorYear)}`}
          tag={anyFilter ? 'Filtered' : 'All customers'} tagTone={anyFilter ? 'info' : 'neutral'} />
        <KpiCard label="YoY (cohort)" value={loadingV(signedPct(summary.yoyPct))}
          hint={`${summary.growingCount} growing · ${summary.decliningCount} declining`}
          tag={summary.yoyPct == null ? 'No prior year' : summary.yoyPct >= 0 ? 'Growing' : 'Declining'}
          tagTone={summary.yoyPct == null ? 'neutral' : summary.yoyPct >= 0 ? 'success' : 'error'} />
        <KpiCard label="Customers" value={loadingV(summary.count.toLocaleString())}
          hint={`${summary.launchedCount} launched · ${usd(summary.totalMrr)}/mo MRR`} />
        <KpiCard label="Lifetime invoiced" value={loadingV(usdb(summary.totalLifetime))}
          hint={`${summary.totalLifetimeOrders.toLocaleString()} orders all-time`} />
      </KpiGrid>

      <section className="am-card am-card--outlined" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="am-row am-row--wrap">
          <SearchField value={search} onChange={(v) => { setSearch(v); reset(); }} label="Search by customer name" width={360} />
          <FilterChip checked={launchedOnly} onChange={() => { setLaunchedOnly(!launchedOnly); reset(); }}>Launched only</FilterChip>
          {anyFilter && <button className="am-btn am-btn--text" onClick={clearAll}><Icon name="close" />Clear filters</button>}
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Segment</span>
          {facets.segments.map(([seg, n]) => (
            <FilterChip key={seg} checked={segmentFilter.includes(seg)} onChange={() => toggleIn(segmentFilter, setSegmentFilter, seg)}>{seg} ({n})</FilterChip>
          ))}
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Status</span>
          {facets.statuses.map(([st, n]) => (
            <FilterChip key={st} checked={statusFilter.includes(st)} onChange={() => toggleIn(statusFilter, setStatusFilter, st)}>{statusOf(st).label} ({n})</FilterChip>
          ))}
        </div>
      </section>

      <ChartCard title={`Yearly invoice $ across ${summary.count.toLocaleString()} filtered customer${summary.count === 1 ? '' : 's'}`}
        caption={partialYear
          ? `${partialYear} is in progress: blue is invoiced so far (${mo} months with revenue), gray is the projected remainder if that pace holds; the label is the projected year-end, the same figure as YTD annualized. Select a year to see its customers.`
          : 'Select a year to see its customers.'}>
        <div className="am-row am-row--wrap">
          <Segmented label="Measure" value={view} onChange={setView} options={[['usd', 'Invoice $'], ['customers', 'Active customers']]} />
        </div>
        {isLoading ? <p className="am-card__text">Loading…</p> : (
          <ColumnChart months={yearKeys} series={series} stacked={view === 'usd'} legend={view === 'usd'}
            fmt={view === 'usd' ? usdk : (v) => Math.round(v).toLocaleString()}
            aria={view === 'usd' ? 'Invoiced $ by year, with the in-progress year projected' : 'Active customers by year'}
            catLabel={(y) => (y === partialYear ? `${y} (in progress)` : y)} catTitle={(y) => (y === partialYear ? `${y} (in progress)` : y)}
            labelFor={(i) => (view === 'usd' ? usdk(yearly[i].projected_total) : yearly[i].active_customers.toLocaleString())}
            onSegment={(i) => { setYearSheet(yearly[i].year); setYearShowAll(false); }}
            tipRows={(i) => {
              const d = yearly[i];
              const rows: Array<[string, string]> = d.is_partial
                ? [[`Invoiced YTD (${d.months_loaded} mo)`, usd(d.actual_usd)], ['Projected remainder', usd(d.projected_extra)], ['Projected year-end', usd(d.projected_total)]]
                : [['Invoiced $', usd(d.actual_usd)]];
              rows.push(['Active customers', d.active_customers.toLocaleString()]);
              return rows;
            }} />
        )}
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">{summary.count.toLocaleString()} customers · {usdk(summary.totalAnnualized)} YTD annualized</span>
          <span className="am-chart__caption">Each row annualizes its own months with revenue; the Total row annualizes the book (YTD × 12 ÷ {mo || '—'} months), the same as the KPI, so it is not the sum of the rows. YoY on a row is the monthly-average change. Select a heading to sort the whole list.</span>
        </div>
        {isLoading ? <p className="am-card__text">Loading customers…</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Orders verified by customer" cols={cols} rows={tableRows} sortValues={sortValues}
              defaultSort={{ col: 2, dir: 'desc' }} limit={showAll ? undefined : LIMIT}
              onSortChange={(o) => setOrder(o)}
              foot={foot} onFoot={() => setShowAll(true)} footClickable={(c) => foot[c] !== '' && c > 0 && !showAll && filtered.length > LIMIT} />
          </div>
        )}
        {!isLoading && filtered.length === 0 && <p className="am-card__text">No customers match the current filters.</p>}
        <div className="am-row am-row--wrap">
          {!showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {filtered.length.toLocaleString()}</button>}
          {showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show top {LIMIT}</button>}
          <span className="am-card__text">Showing {Math.min(filtered.length, showAll ? filtered.length : LIMIT).toLocaleString()} of {filtered.length.toLocaleString()}.</span>
        </div>
      </section>
    </DsPage>
  );
}
