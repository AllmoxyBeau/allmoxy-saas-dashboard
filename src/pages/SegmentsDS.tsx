/**
 * Segments on the Allmoxy design system. Data logic is the classic page's (Segments.tsx, kept at
 * /segments-classic): same customer_profiles + customer_base snapshots, duplicates
 * (customer_base.excluded) dropped, "active" = customer_base membership (falls back to billing
 * subscription MRR > 0 until customer_base loads), same TTM / new-logo / retention maths and the
 * same All / Active / Cancelled filter.
 *
 * Layout: headline cards, the filter, the segment scorecard (select a segment to open its
 * sub-segments and customers in a side sheet; the classic page's inline sub-segment expansion and
 * drill-down card both live there), then the segment mix as category column charts, then the
 * monthly subscription MRR trend (the classic page's stacked 24-month chart, one segment or all
 * named segments at a time, with every segment's figure in the hover).
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { segmentLabel } from '../lib/segmentsRegistry';
import {
  ChartCard, ColumnChart, CustomerLink, DataTable, DsPage, Icon, KpiCard, KpiGrid, SearchField, Segmented, Select, SideSheet,
  downloadCsv, mlabel, pct, usd, usdk, useMonthRange,
} from '../design-system/parts';

type MonthlyCell = { subscription: number; services: number; connect: number; total: number };
type ProfileRow = {
  allmoxy_customer_id: number;
  name: string;
  primary_segment: string | null;
  sub_segment: string | null;
  pay_status: string | null;
  current_subscription_mrr: number;
  lifetime_total: number;
  lifetime_subscription: number;
  first_payment_date: string | null;
  last_payment_date?: string | null;
  monthly_history: Record<string, MonthlyCell>;
  latest_month: string;
};
type SubSegmentRow = { name: string; customerCount: number; activeCount: number; currentMrr: number };
type SegmentRow = {
  name: string; isUnsegmented: boolean; customers: ProfileRow[];
  customerCount: number; activeCount: number; cancelledCount: number; retentionPct: number | null;
  currentMrr: number; servicesTTM: number; connectTTM: number; avgMrr: number | null;
  newLogos12m: number; lifetimeRevenue: number; subSegments: SubSegmentRow[];
};
type Filter = 'all' | 'active' | 'cancelled';
type CustomerBaseIds = { members: Array<{ allmoxy_customer_id: number }>; excluded?: Array<{ allmoxy_customer_id: number }> };

function shiftMonth(iso: string, delta: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function makeIsActive(memberIds: Set<number> | null) {
  return (c: ProfileRow): boolean => (memberIds ? memberIds.has(c.allmoxy_customer_id) : (c.current_subscription_mrr ?? 0) > 0);
}
const fmtPct0 = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const num = (v: number) => v.toLocaleString();
const ALL = '__all__';
const NULL_PAY = '__null__';
const payWord = (v: string | null) => (v == null ? 'No HubSpot match' : v);
const payTone = (v: string | null) => (v === 'Cancelled' ? 'error' : v?.startsWith('Active') ? 'success' : 'neutral');
const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export default function SegmentsDS() {
  const { data: profilesData, isLoading, error } = useSheetTab('customer_profiles');
  const snap = profilesData as unknown as { rows: ProfileRow[] } | undefined;
  const { data: baseData } = useSheetTab('customer_base');
  const base = baseData as unknown as CustomerBaseIds | undefined;
  const memberIds = useMemo(() => (base?.members ? new Set(base.members.map((m) => m.allmoxy_customer_id)) : null), [base]);
  const excludedIds = useMemo(() => new Set((base?.excluded ?? []).map((m) => m.allmoxy_customer_id)), [base]);
  const profiles = useMemo(() => (snap?.rows ?? []).filter((r) => !excludedIds.has(r.allmoxy_customer_id)), [snap, excludedIds]);
  const isActive = useMemo(() => makeIsActive(memberIds), [memberIds]);

  const [filter, setFilter] = useState<Filter>('all');
  const [drill, setDrill] = useState<string | null>(null);
  const [drillSearch, setDrillSearch] = useState('');
  const [drillPay, setDrillPay] = useState('all');
  const [drillShowAll, setDrillShowAll] = useState(false);
  const [trendSeg, setTrendSeg] = useState(ALL);
  const [mixMeasure, setMixMeasure] = useState<'mrr' | 'customers'>('mrr');

  const view = useMemo(() => {
    if (profiles.length === 0) return null;
    const latestMonth = profiles[0]?.latest_month ?? '';
    if (!latestMonth) return null;
    const ttmMonths: string[] = [];
    for (let i = 11; i >= 0; i--) ttmMonths.push(shiftMonth(latestMonth, -i));
    const today = new Date();

    const bySegment = new Map<string, ProfileRow[]>();
    for (const p of profiles) {
      const seg = (p.primary_segment ?? '').trim() || 'Unsegmented';
      if (!bySegment.has(seg)) bySegment.set(seg, []);
      bySegment.get(seg)!.push(p);
    }
    const sumOver = (months: string[], customers: ProfileRow[], stream: keyof MonthlyCell) => {
      let total = 0;
      for (const c of customers) for (const m of months) { const cell = c.monthly_history[m]; if (cell) total += cell[stream] ?? 0; }
      return total;
    };
    const isCancelled = (c: ProfileRow) => !isActive(c);
    const isWithinLast12Months = (iso: string | null | undefined) => {
      if (!iso) return false;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return false;
      const cutoff = new Date(today);
      cutoff.setMonth(cutoff.getMonth() - 12);
      return d >= cutoff;
    };

    const segments: SegmentRow[] = [];
    for (const [name, customers] of bySegment) {
      const active = customers.filter((c) => !isCancelled(c));
      const cancelled = customers.filter(isCancelled);
      const currentMrr = customers.reduce((s, c) => s + (c.current_subscription_mrr ?? 0), 0);
      const billingCustomers = customers.filter((c) => (c.current_subscription_mrr ?? 0) > 0).length;
      const subBuckets = new Map<string, ProfileRow[]>();
      for (const c of customers) {
        const s = (c.sub_segment ?? '').trim() || '(unspecified)';
        if (!subBuckets.has(s)) subBuckets.set(s, []);
        subBuckets.get(s)!.push(c);
      }
      const subSegments: SubSegmentRow[] = [];
      for (const [subName, subCustomers] of subBuckets) {
        subSegments.push({
          name: subName,
          customerCount: subCustomers.length,
          activeCount: subCustomers.filter((c) => !isCancelled(c)).length,
          currentMrr: subCustomers.reduce((s, c) => s + (c.current_subscription_mrr ?? 0), 0),
        });
      }
      subSegments.sort((a, b) => {
        const aUnk = a.name === '(unspecified)', bUnk = b.name === '(unspecified)';
        if (aUnk !== bUnk) return aUnk ? 1 : -1;
        return b.currentMrr - a.currentMrr;
      });
      segments.push({
        name, isUnsegmented: name === 'Unsegmented', customers,
        customerCount: customers.length, activeCount: active.length, cancelledCount: cancelled.length,
        retentionPct: customers.length > 0 ? active.length / customers.length : null,
        currentMrr,
        servicesTTM: sumOver(ttmMonths, customers, 'services'),
        connectTTM: sumOver(ttmMonths, customers, 'connect'),
        avgMrr: billingCustomers > 0 ? currentMrr / billingCustomers : null,
        newLogos12m: customers.filter((c) => isWithinLast12Months(c.first_payment_date)).length,
        lifetimeRevenue: customers.reduce((s, c) => s + (c.lifetime_total ?? 0), 0),
        subSegments,
      });
    }
    segments.sort((a, b) => {
      if (a.isUnsegmented !== b.isUnsegmented) return a.isUnsegmented ? 1 : -1;
      return b.currentMrr - a.currentMrr;
    });

    // Monthly subscription MRR per named segment (the classic chart leaves Unsegmented out).
    const chartSegments = segments.filter((s) => !s.isUnsegmented);
    const monthSet = new Set<string>();
    for (const c of profiles) for (const m of Object.keys(c.monthly_history ?? {})) if (m <= latestMonth) monthSet.add(m);
    const allMonths = [...monthSet].sort();
    const bySegMonth = new Map<string, number[]>();
    for (const seg of chartSegments) {
      bySegMonth.set(seg.name, allMonths.map((month) => {
        let sub = 0;
        for (const c of seg.customers) { const cell = c.monthly_history[month]; if (cell) sub += cell.subscription ?? 0; }
        return Math.round(sub * 100) / 100;
      }));
    }

    const totalCustomers = profiles.length;
    const totalActive = profiles.filter((c) => !isCancelled(c)).length;
    const totalCancelled = profiles.filter(isCancelled).length;
    const totalSegmented = profiles.filter((c) => (c.primary_segment ?? '').trim()).length;
    const totalCurrentMrr = profiles.filter((c) => !isCancelled(c)).reduce((s, c) => s + (c.current_subscription_mrr ?? 0), 0);
    return {
      latestMonth, segments, chartSegments, allMonths, bySegMonth,
      kpi: {
        totalCustomers, totalActive, totalCancelled, totalSegmented,
        segmentedPct: totalCustomers > 0 ? totalSegmented / totalCustomers : 0,
        totalCurrentMrr, segmentCount: segments.filter((s) => !s.isUnsegmented).length,
      },
    };
  }, [profiles, isActive]);

  const range = useMonthRange(view?.allMonths ?? []);

  const inFilter = (c: ProfileRow) => (filter === 'all' ? true : filter === 'cancelled' ? !isActive(c) : isActive(c));
  const visibleSegments: SegmentRow[] = (view?.segments ?? []).map((s) => {
    if (filter === 'all') return s;
    const filtered = s.customers.filter(inFilter);
    const billing = filtered.filter((c) => (c.current_subscription_mrr ?? 0) > 0);
    const mrr = filtered.reduce((sum, c) => sum + (c.current_subscription_mrr ?? 0), 0);
    return {
      ...s, customers: filtered, customerCount: filtered.length,
      activeCount: filter === 'active' ? filtered.length : 0,
      cancelledCount: filter === 'cancelled' ? filtered.length : 0,
      currentMrr: mrr, avgMrr: billing.length > 0 ? mrr / billing.length : null,
    };
  });

  const exportScorecard = () => downloadCsv(`segments_scorecard_${filter}`,
    ['Segment', 'Customers', 'Active', 'Cancelled', 'Retention', 'Current MRR', 'Avg MRR', 'Services TTM', 'Connect TTM', 'New logos 12mo', 'Lifetime revenue'],
    visibleSegments.map((r) => [r.name, r.customerCount, r.activeCount, r.cancelledCount, r.retentionPct == null ? '' : (r.retentionPct * 100).toFixed(1) + '%',
      r.currentMrr, r.avgMrr ?? '', r.servicesTTM, r.connectTTM, r.newLogos12m, r.lifetimeRevenue]));

  const openDrill = (name: string) => { setDrill(name); setDrillSearch(''); setDrillPay('all'); setDrillShowAll(false); };

  if (isLoading || !view) {
    return (
      <DsPage path="/segments" title="Segments" subtitle="Customer mix, revenue, and retention by primary segment.">
        <p className="am-card__text">{error ? `Could not load customer profiles: ${String(error)}` : 'Loading…'}</p>
      </DsPage>
    );
  }

  const k = view.kpi;
  const s0 = view.segments[0], s1 = view.segments[1];
  const label = (s: SegmentRow) => (s.isUnsegmented ? s.name : segmentLabel(s.name));

  // ---- scorecard totals (sum of the rows shown under the current filter)
  const tot = visibleSegments.reduce((a, s) => ({
    customers: a.customers + s.customerCount, active: a.active + s.activeCount, cancelled: a.cancelled + s.cancelledCount,
    mrr: a.mrr + s.currentMrr, services: a.services + s.servicesTTM, connect: a.connect + s.connectTTM, logos: a.logos + s.newLogos12m,
    billing: a.billing + s.customers.filter((c) => (c.current_subscription_mrr ?? 0) > 0).length,
    allCustomers: a.allCustomers + (view.segments.find((x) => x.name === s.name)?.customerCount ?? 0),
    allActive: a.allActive + (view.segments.find((x) => x.name === s.name)?.activeCount ?? 0),
  }), { customers: 0, active: 0, cancelled: 0, mrr: 0, services: 0, connect: 0, logos: 0, billing: 0, allCustomers: 0, allActive: 0 });

  // ---- segment mix charts: the top named segments, the rest folded into one column
  const named = visibleSegments.filter((s) => !s.isUnsegmented);
  const TOP = 9;
  const mixSegs = [...named].sort((a, b) => b.currentMrr - a.currentMrr);
  const mixTop = mixSegs.slice(0, TOP);
  const mixRest = mixSegs.slice(TOP);
  const mixCats = [...mixTop.map((s) => s.name), ...(mixRest.length ? ['__rest__'] : [])];
  const mixOf = (key: string, f: (s: SegmentRow) => number) => (key === '__rest__' ? mixRest.reduce((a, s) => a + f(s), 0) : f(mixTop.find((s) => s.name === key)!));
  const mixTitle = (key: string) => (key === '__rest__' ? `${mixRest.length} other segments` : segmentLabel(key));
  const unseg = visibleSegments.find((s) => s.isUnsegmented);

  // ---- monthly trend
  const trendIdx = range.months.map((m) => view.allMonths.indexOf(m));
  const segMonth = (name: string, i: number) => view.bySegMonth.get(name)?.[trendIdx[i]] ?? 0;
  const allNamedMonth = (i: number) => view.chartSegments.reduce((a, s) => a + segMonth(s.name, i), 0);
  const trendValues = range.months.map((_, i) => (trendSeg === ALL ? allNamedMonth(i) : segMonth(trendSeg, i)));

  // ---- drill sheet
  const drillSeg = drill && drill !== ALL ? view.segments.find((s) => s.name === drill) ?? null : null;
  const drillAllCustomers = drill === ALL ? profiles : drillSeg?.customers ?? [];
  const drillStatusRows = drillAllCustomers.filter(inFilter);
  const payCounts = new Map<string, number>();
  for (const c of drillAllCustomers) { const v = c.pay_status ?? NULL_PAY; payCounts.set(v, (payCounts.get(v) ?? 0) + 1); }
  const payOptions = [...payCounts.entries()].sort((a, b) => (a[0] === NULL_PAY ? 1 : b[0] === NULL_PAY ? -1 : a[0].localeCompare(b[0])));
  const search = drillSearch.trim().toLowerCase();
  const drillRows = drillStatusRows
    .filter((c) => drillPay === 'all' || (c.pay_status ?? NULL_PAY) === drillPay)
    .filter((c) => !search || (c.name ?? '').toLowerCase().includes(search))
    .sort((a, b) => (a.name ?? '').toLowerCase().localeCompare((b.name ?? '').toLowerCase()));
  const drillTitle = drill === ALL ? 'All segments' : drillSeg ? label(drillSeg) : '';
  const hasSubs = !!drillSeg && (drillSeg.subSegments.length > 1 || (drillSeg.subSegments.length === 1 && drillSeg.subSegments[0].name !== '(unspecified)'));

  return (
    <DsPage
      path="/segments"
      title="Segments"
      subtitle={`Customer mix, revenue, and retention by primary segment. ${k.segmentCount} segments · ${k.totalSegmented} of ${k.totalCustomers} customers tagged (${fmtPct0(k.segmentedPct)}).`}
      actions={<button className="am-btn am-btn--outlined" onClick={exportScorecard}><Icon name="download" />Export scorecard CSV</button>}
      overlays={drill && (
        <SideSheet open onClose={() => setDrill(null)} title={`Customers · ${drillTitle}`}
          text={`${num(drillStatusRows.length)} ${filter === 'all' ? 'total' : filter} customer${drillStatusRows.length === 1 ? '' : 's'}${filter !== 'all' ? ` of ${num(drillAllCustomers.length)}` : ''}. Active means a member of the customer base (the Overview count).`}>
          {hasSubs && drillSeg && (
            <>
              <span className="am-chart__title">Sub-segments</span>
              <div style={{ overflowX: 'auto' }}>
              <DataTable label={`Sub-segments of ${drillTitle}`}
                cols={[['Sub-segment', false], ['Customers', true], ['Active', true], ['Cancelled', true], ['Retention', true], ['Current MRR', true]]}
                rows={drillSeg.subSegments.map((sub) => [sub.name, num(sub.customerCount), num(sub.activeCount), num(sub.customerCount - sub.activeCount),
                  pct(sub.customerCount > 0 ? sub.activeCount / sub.customerCount : null), usd(sub.currentMrr)])}
                sortValues={drillSeg.subSegments.map((sub) => [sub.name, sub.customerCount, sub.activeCount, sub.customerCount - sub.activeCount,
                  sub.customerCount > 0 ? sub.activeCount / sub.customerCount : null, sub.currentMrr])}
                foot={[`Total · ${drillSeg.subSegments.length} sub-segments`, num(drillSeg.customerCount), num(drillSeg.activeCount), num(drillSeg.cancelledCount),
                  pct(drillSeg.retentionPct), usd(drillSeg.currentMrr)]} />
              </div>
              <p className="am-card__text">Sub-segment figures cover every customer in the segment, whatever the filter above.</p>
            </>
          )}
          <div className="am-row am-row--wrap am-row--spread">
            <div className="am-row am-row--wrap">
              <SearchField label="Customer name" value={drillSearch} onChange={(v) => { setDrillSearch(v); setDrillShowAll(false); }} width={240} />
              <div className="am-row am-row--tight">
                <span className="am-card__text">Pay status</span>
                <Select label="Pay status" width={230} value={drillPay} onPick={(v) => { setDrillPay(v); setDrillShowAll(false); }}
                  options={[['all', `All (${num(drillAllCustomers.length)})`], ...payOptions.map(([v, n]) => [v, `${v === NULL_PAY ? 'No HubSpot match' : v} (${num(n)})`] as [string, string])]} />
              </div>
            </div>
            <button className="am-btn am-btn--text" disabled={!drillAllCustomers.length}
              onClick={() => downloadCsv(drill === ALL ? 'segment_all_customers' : `segment_${drill.replace(/\s+/g, '_').toLowerCase()}_customers`,
                ['Allmoxy ID', 'Customer', 'Pay status', 'Current MRR', 'Lifetime revenue', 'First payment', 'Last payment'],
                drillAllCustomers.map((c) => [c.allmoxy_customer_id, c.name, c.pay_status ?? '', c.current_subscription_mrr, c.lifetime_total, c.first_payment_date ?? '', c.last_payment_date ?? '']))}>
              <Icon name="download" />Export CSV
            </button>
          </div>
          {(search || filter !== 'all' || drillPay !== 'all') && (
            <p className="am-card__text">
              Showing {num(drillRows.length)} of {num(drillAllCustomers.length)} customer{drillAllCustomers.length === 1 ? '' : 's'}
              {filter !== 'all' ? ` · ${filter}` : ''}{drillPay !== 'all' ? ` · ${drillPay === NULL_PAY ? 'No HubSpot match' : drillPay}` : ''}{search ? ` · matching "${drillSearch}"` : ''}
            </p>
          )}
          {drillRows.length === 0 ? (
            <p className="am-card__text">{search || drillPay !== 'all' ? 'No customers in this segment match the current filters.' : 'No customers match the active filter in this segment.'}</p>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
              <DataTable label={`Customers in ${drillTitle}`}
                cols={[['Customer', false], ['Pay status', false], ['Current MRR', true], ['Lifetime revenue', true], ['First payment', false]]}
                rows={drillRows.map((c) => [<CustomerLink key="n" id={c.allmoxy_customer_id} name={c.name} />,
                  <span key="p" className={`am-tag am-tag--${payTone(c.pay_status)}`}>{payWord(c.pay_status)}</span>,
                  usd(c.current_subscription_mrr ?? 0), usd(c.lifetime_total ?? 0), c.first_payment_date ?? '—'])}
                sortValues={drillRows.map((c) => [(c.name ?? '').toLowerCase(), c.pay_status == null ? null : c.pay_status.toLowerCase(), c.current_subscription_mrr ?? 0, c.lifetime_total ?? 0, c.first_payment_date ?? null])}
                defaultSort={{ col: 2, dir: 'desc' }}
                limit={drillShowAll ? undefined : 25}
                foot={[`Total · ${num(drillRows.length)} customers`, '', usd(drillRows.reduce((a, c) => a + (c.current_subscription_mrr ?? 0), 0)), usd(drillRows.reduce((a, c) => a + (c.lifetime_total ?? 0), 0)), '']}
                onFoot={() => setDrillShowAll(true)} footClickable={(col) => !drillShowAll && drillRows.length > 25 && (col === 0 || col === 2 || col === 3)} />
              </div>
              {!drillShowAll && drillRows.length > 25 && <button className="am-btn am-btn--text" onClick={() => setDrillShowAll(true)}>Show all {num(drillRows.length)}</button>}
            </>
          )}
        </SideSheet>
      )}
    >
      <KpiGrid max={4}>
        <KpiCard label="Active customers" value={num(k.totalActive)} hint={`of ${k.totalCustomers} total · ${k.totalCancelled} cancelled`}
          onOpen={() => { setFilter('active'); openDrill(ALL); }} />
        <KpiCard label="Subscription MRR" value={usd(k.totalCurrentMrr)} hint={`Active customers · latest complete month: ${mlabel(view.latestMonth)}`} />
        <KpiCard label="Largest segment" value={s0 ? label(s0) : '—'} hint={`${s0?.customerCount ?? 0} customers · ${usd(s0?.currentMrr ?? 0)} MRR`}
          onOpen={s0 ? () => openDrill(s0.name) : undefined} />
        <KpiCard label="Top 2 share of MRR" value={fmtPct0(((s0?.currentMrr ?? 0) + (s1?.currentMrr ?? 0)) / Math.max(k.totalCurrentMrr, 1))}
          hint={`Concentration in ${s0?.name?.slice(0, 18) ?? ''}${s1 ? ' + ' + s1.name.slice(0, 18) : ''}`} />
      </KpiGrid>

      <div className="am-row am-row--wrap">
        <span className="am-card__text">Show</span>
        <Segmented label="Customer filter" value={filter} onChange={setFilter}
          options={[['all', `All · ${k.totalCustomers}`], ['active', `Active · ${k.totalActive}`], ['cancelled', `Cancelled · ${k.totalCancelled}`]]} />
      </div>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Segment scorecard</span>
          <span className="am-chart__caption">
            Largest current subscription MRR first; Unsegmented (no Primary Segment in HubSpot) last. Retention = active ÷ customers in the segment.
            Avg MRR = current subscription MRR ÷ customers billing now. Select a segment to see its sub-segments and customers.
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Segment scorecard"
            cols={[['Segment', false], ['Customers', true], ['Active', true], ['Cancelled', true], ['Retention', true], ['Current MRR', true], ['Avg MRR', true], ['Services TTM', true], ['Connect TTM', true], ['New logos 12mo', true]]}
            rows={visibleSegments.map((s) => [label(s), num(s.customerCount), filter === 'cancelled' ? '—' : num(s.activeCount), filter === 'active' ? '—' : num(s.cancelledCount),
              pct(s.retentionPct), usd(s.currentMrr), s.avgMrr != null ? usd(s.avgMrr) : '—', usd(s.servicesTTM), usd(s.connectTTM), num(s.newLogos12m)])}
            sortValues={visibleSegments.map((s) => [label(s), s.customerCount, s.activeCount, s.cancelledCount, s.retentionPct, s.currentMrr, s.avgMrr, s.servicesTTM, s.connectTTM, s.newLogos12m])}
            clickable={(col) => col === 0}
            onCell={(row) => openDrill(visibleSegments[row].name)}
            foot={[`Total · ${visibleSegments.length} segments`, num(tot.customers), filter === 'cancelled' ? '—' : num(tot.active), filter === 'active' ? '—' : num(tot.cancelled),
              pct(tot.allCustomers > 0 ? tot.allActive / tot.allCustomers : null), usd(tot.mrr), tot.billing > 0 ? usd(tot.mrr / tot.billing) : '—',
              usd(tot.services), usd(tot.connect), num(tot.logos)]}
            onFoot={() => openDrill(ALL)}
            footClickable={(col) => col <= 3 || col === 5} />
        </div>
        <p className="am-card__text">Current MRR in this table sums every customer in the segment under the filter; the Subscription MRR card counts active customers only, as on the classic page.</p>
      </section>

      <ChartCard title={mixMeasure === 'mrr' ? 'Segment mix · current subscription MRR' : 'Segment mix · customers'}
        caption={`Top ${Math.min(TOP, mixSegs.length)} named segments by current MRR${mixRest.length ? `, the other ${mixRest.length} in one column` : ''}${unseg ? ` · Unsegmented (${num(unseg.customerCount)} customers, ${usd(unseg.currentMrr)}) not shown` : ''} · follows the filter above · select a column for its customers`}>
        <div className="am-row am-row--wrap">
          <Segmented label="Measure" value={mixMeasure} onChange={setMixMeasure} options={[['mrr', 'Current MRR'], ['customers', 'Customers']]} />
        </div>
        {mixMeasure === 'mrr' ? (
          <ColumnChart months={mixCats} catLabel={(key) => short(mixTitle(key), 16)} catTitle={mixTitle} fmt={usdk}
            series={[{ key: 'mrr', label: 'Current MRR', tone: 'div-1', values: mixCats.map((c) => mixOf(c, (s) => s.currentMrr)) }]}
            tipRows={(i) => {
              const key = mixCats[i];
              const mrr = mixOf(key, (s) => s.currentMrr);
              const rows: Array<[string, string]> = [['Current MRR', usd(mrr)], ['Share of named-segment MRR', pct(mrr / Math.max(named.reduce((a, s) => a + s.currentMrr, 0), 1))], ['Customers', num(mixOf(key, (s) => s.customerCount))]];
              if (key === '__rest__') rows.push(...mixRest.map((s) => [segmentLabel(s.name), usd(s.currentMrr)] as [string, string]));
              return rows;
            }}
            onSegment={(i) => { const key = mixCats[i]; if (key !== '__rest__') openDrill(key); }}
            aria="Current subscription MRR by primary segment." />
        ) : (
          <ColumnChart months={mixCats} catLabel={(key) => short(mixTitle(key), 16)} catTitle={mixTitle} fmt={(v) => num(Math.round(v))} stacked legend
            series={[
              { key: 'active', label: 'Active', tone: 'div-1', values: mixCats.map((c) => mixOf(c, (s) => (filter === 'cancelled' ? 0 : s.activeCount))) },
              { key: 'cancelled', label: 'Cancelled', tone: 'other', values: mixCats.map((c) => mixOf(c, (s) => (filter === 'active' ? 0 : s.cancelledCount))) },
            ]}
            tipRows={(i) => {
              const key = mixCats[i];
              const a = filter === 'cancelled' ? 0 : mixOf(key, (s) => s.activeCount), c = filter === 'active' ? 0 : mixOf(key, (s) => s.cancelledCount);
              const rows: Array<[string, string]> = [['Active', num(a)], ['Cancelled', num(c)], ['Customers', num(a + c)]];
              if (filter === 'all') rows.push(['Retention', pct(a + c > 0 ? a / (a + c) : null)]);
              return rows;
            }}
            onSegment={(i) => { const key = mixCats[i]; if (key !== '__rest__') openDrill(key); }}
            aria="Active and cancelled customers by primary segment." />
        )}
      </ChartCard>

      <ChartCard title="Subscription MRR by month" caption={`${trendSeg === ALL ? `All ${view.chartSegments.length} named segments (Unsegmented left out, as on the classic chart); hover for each segment's figure` : segmentLabel(trendSeg)} · every customer, whatever the filter · ${range.rangeText}`}>
        <div className="am-row am-row--wrap">
          {range.controls}
          <div className="am-row am-row--tight">
            <span className="am-card__text">Segment</span>
            <Select label="Segment" width={260} value={trendSeg} onPick={setTrendSeg}
              options={[[ALL, 'All named segments'], ...view.chartSegments.map((s) => [s.name, segmentLabel(s.name)] as [string, string])]} />
          </div>
        </div>
        <ColumnChart months={range.months} fmt={usdk}
          series={[{ key: 'mrr', label: trendSeg === ALL ? 'All named segments' : segmentLabel(trendSeg), tone: 'div-1', values: trendValues }]}
          tipRows={(i) => {
            if (trendSeg !== ALL) return [[segmentLabel(trendSeg), usd(trendValues[i])]];
            const parts = view.chartSegments.map((s) => [s.name, segMonth(s.name, i)] as [string, number]).filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
            const top = parts.slice(0, 6), rest = parts.slice(6);
            return [...top.map(([n, v]) => [segmentLabel(n), usd(v)] as [string, string]),
              ...(rest.length ? [[`${rest.length} other segments`, usd(rest.reduce((a, [, v]) => a + v, 0))] as [string, string]] : []),
              ['Total', usd(trendValues[i])]];
          }}
          aria={`Monthly subscription MRR, ${trendSeg === ALL ? 'all named segments' : segmentLabel(trendSeg)}, ${range.rangeText}.`} />
      </ChartCard>
    </DsPage>
  );
}
