/**
 * Stripe Connect Revenue on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (StripeConnectRevenue.tsx, kept
 * at /stripe-connect-revenue-classic): same snapshots (connect_by_month, connect_by_customer_month)
 * and the same maths, including today's fixes: the in-progress month is kept in actual and
 * lifetime totals but never in YTD, complete-month counts, annualization or YoY, and per-customer
 * sums read YYYY-MM keys only.
 *
 * Added for the design-system page (UI only, no new maths): the trailing twelve complete months
 * (the canonical Connect TTM every other page reports), a year-by-year table in place of the
 * yearly chart (the certified column chart labels months, not years), and drill-downs into the
 * customers behind any month, year or total.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, Segmented, Select, SideSheet,
  downloadCsv, mlabel, pct, usd, usdk, useMonthRange,
} from '../design-system/parts';

// Snapshot types: match _etl_scripts/build_connect_by_customer.mjs outputs.
type MonthRow = { month: string; mrr_connect: number };
type CustomerMonthRow = { customer_name: string; [yearMonth: string]: string | number };

type CustomerRow = {
  name: string;
  ytd: number;
  ytd_annualized: number;
  prior_year: number;
  yoy_pct: number | null;
  lifetime: number;
};
type SortKey = 'name' | 'ytd' | 'ytd_annualized' | 'prior_year' | 'yoy_pct' | 'lifetime';
const SORTS: Array<[SortKey, string]> = [
  ['ytd_annualized', 'YTD annualized'], ['ytd', 'YTD'], ['prior_year', 'Prior year'],
  ['yoy_pct', 'Year over year'], ['lifetime', 'Lifetime'], ['name', 'Customer name'],
];

// The in-progress calendar month. Months >= this are partial: kept in "actual" and lifetime
// totals, never in YTD / months loaded / annualization, or a few days of fees would count as a month.
function currentMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const MONTH_KEY = /^\d{4}-\d{2}$/;
const yoyText = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`);

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
// A customer's direction this year against last, as a word and a tone.
function trendOf(r: CustomerRow): [string, Tone] {
  if (r.prior_year > 0 && r.ytd === 0) return ['Stopped', 'error'];
  if (r.prior_year > 0 && r.yoy_pct != null) return r.yoy_pct >= 0 ? ['Growing', 'success'] : ['Declining', 'warning'];
  if (r.prior_year === 0 && r.ytd > 0) return ['New this year', 'info'];
  return ['Inactive', 'neutral'];
}

type Drill = { kind: 'months'; months: string[]; title: string } | { kind: 'customer'; name: string };
const SHOW_N = 25;

export default function StripeConnectRevenueDS() {
  const { data: monthData, isLoading: monthLoading, error: monthError } = useSheetTab<MonthRow>('connect_by_month');
  const { data: custData, isLoading: custLoading } = useSheetTab<CustomerMonthRow>('connect_by_customer_month');
  const isLoading = monthLoading || custLoading;
  const monthRows = useMemo(() => (monthData?.rows ?? []) as MonthRow[], [monthData]);
  const custRows = useMemo(() => (custData?.rows ?? []) as CustomerMonthRow[], [custData]);
  const cm = currentMonthIso();

  const [sortKey, setSortKey] = useState<SortKey>('ytd_annualized');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [showAll, setShowAll] = useState(false);
  const [drill, setDrill] = useState<Drill | null>(null);

  // ---- headline summary (classic maths, verbatim)
  const summary = useMemo(() => {
    const rows = monthRows;
    if (rows.length === 0) {
      return { currentYear: 0, priorYear: 0, ytdAnnualized: 0, yoyPct: null as number | null, monthsLoadedCurrent: 0, lifetime: 0, latestMonth: null as string | null, latestAmount: 0 };
    }
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    let cy = 0, py = 0, lifetime = 0, monthsLoadedCurrent = 0;
    for (const r of rows) {
      const v = Number(r.mrr_connect) || 0;
      lifetime += v;
      const yr = r.month.slice(0, 4);
      if (yr === currentYearStr) {
        if (r.month < cm) { cy += v; if (v > 0) monthsLoadedCurrent++; }
      } else if (yr === priorYearStr) py += v;
    }
    const latest = rows[rows.length - 1];
    const annualized = monthsLoadedCurrent > 0 ? (cy * 12) / monthsLoadedCurrent : cy;
    const yoyPct = py > 0 ? (annualized - py) / py : null;
    return {
      currentYear: cy, priorYear: py, ytdAnnualized: annualized, yoyPct, monthsLoadedCurrent, lifetime,
      latestMonth: latest?.month ?? null, latestAmount: Number(latest?.mrr_connect) || 0,
    };
  }, [monthRows, cm]);

  // ---- trailing twelve complete months (the canonical Connect TTM)
  const ttm = useMemo(() => {
    const rows = monthRows.filter((r) => r.month < cm).slice(-12);
    return { rows, total: rows.reduce((a, r) => a + (Number(r.mrr_connect) || 0), 0) };
  }, [monthRows, cm]);

  // ---- by year (classic yearly-chart maths: actual incl. the in-progress month; projection
  // from complete months only)
  const yearly = useMemo(() => {
    const currentYearStr = String(new Date().getFullYear());
    const byYear = new Map<string, { total: number; completeTotal: number; months: number; all: string[] }>();
    for (const r of monthRows) {
      const yr = r.month.slice(0, 4);
      const v = Number(r.mrr_connect) || 0;
      if (!byYear.has(yr)) byYear.set(yr, { total: 0, completeTotal: 0, months: 0, all: [] });
      const e = byYear.get(yr)!;
      e.total += v;
      e.all.push(r.month);
      if (r.month < cm) { e.completeTotal += v; if (v > 0) e.months++; }
    }
    const out = [...byYear.entries()].map(([year, v]) => {
      const isCurrent = year === currentYearStr && v.months > 0 && v.months < 12;
      const annualized = isCurrent ? (v.completeTotal * 12) / v.months : v.total;
      return {
        year, months: v.all, actual: v.total, completeMonths: v.months, is_partial: isCurrent, annualized,
        projected_extra: Math.max(0, annualized - v.total),
      };
    }).sort((a, b) => a.year.localeCompare(b.year));
    return out.map((y, i) => {
      const prev = out[i - 1];
      return { ...y, vsPrior: prev && prev.actual > 0 ? (y.annualized - prev.actual) / prev.actual : null };
    });
  }, [monthRows, cm]);

  // ---- per customer (classic maths, verbatim: month keys only, complete months only for YTD)
  const customerRows = useMemo<CustomerRow[]>(() => {
    if (!custRows.length) return [];
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    const monthsLoadedCurrent = summary.monthsLoadedCurrent || 1;
    const out: CustomerRow[] = [];
    for (const row of custRows) {
      let cy = 0, py = 0, lifetime = 0;
      for (const [k, v] of Object.entries(row)) {
        if (!MONTH_KEY.test(k)) continue;
        const num = Number(v) || 0;
        if (num === 0) continue;
        lifetime += num;
        const yr = k.slice(0, 4);
        if (yr === currentYearStr) { if (k < cm) cy += num; }
        else if (yr === priorYearStr) py += num;
      }
      if (lifetime === 0) continue;
      const annualized = monthsLoadedCurrent > 0 && monthsLoadedCurrent < 12 ? (cy * 12) / monthsLoadedCurrent : cy;
      const yoyPct = py > 0 ? (annualized - py) / py : (cy > 0 ? null : -1);
      out.push({ name: row.customer_name, ytd: cy, ytd_annualized: annualized, prior_year: py, yoy_pct: yoyPct === -1 ? null : yoyPct, lifetime });
    }
    return out;
  }, [custRows, summary.monthsLoadedCurrent, cm]);

  const sortedCustomers = useMemo(() => {
    const out = [...customerRows];
    out.sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortKey) {
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'ytd': av = a.ytd; bv = b.ytd; break;
        case 'ytd_annualized': av = a.ytd_annualized; bv = b.ytd_annualized; break;
        case 'prior_year': av = a.prior_year; bv = b.prior_year; break;
        case 'yoy_pct': av = a.yoy_pct ?? -999; bv = b.yoy_pct ?? -999; break;
        case 'lifetime': av = a.lifetime; bv = b.lifetime; break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [customerRows, sortKey, sortDir]);

  // ---- month chart
  const byMonth = useMemo(() => new Map(monthRows.map((r) => [r.month, Number(r.mrr_connect) || 0])), [monthRows]);
  const range = useMonthRange(monthRows.map((r) => r.month));
  const inProgress = (m: string) => m >= cm;
  const anyPartialShown = range.months.some(inProgress);
  const series = [
    { key: 'complete', label: 'Connect revenue', tone: 'div-2', values: range.months.map((m) => (inProgress(m) ? 0 : byMonth.get(m) ?? 0)) },
    { key: 'partial', label: 'Month in progress', tone: 'other', values: range.months.map((m) => (inProgress(m) ? byMonth.get(m) ?? 0 : 0)) },
  ];

  // ---- drill helpers: customers behind a set of months
  const customersFor = (months: string[]) => {
    const list = custRows
      .map((row) => ({ name: row.customer_name, amount: months.reduce((a, m) => a + (Number(row[m]) || 0), 0) }))
      .filter((r) => r.amount !== 0)
      .sort((a, b) => b.amount - a.amount);
    return list;
  };
  const openMonths = (months: string[], title: string) => setDrill({ kind: 'months', months, title });
  const span = (months: string[]) => (months.length === 1
    ? `${mlabel(months[0])}${inProgress(months[0]) ? ' (in progress)' : ''}`
    : `${mlabel(months[0])} to ${mlabel(months[months.length - 1])}`);

  // ---- totals for the customer table
  const tot = customerRows.reduce((a, r) => ({ ytd: a.ytd + r.ytd, ann: a.ann + r.ytd_annualized, py: a.py + r.prior_year, life: a.life + r.lifetime }), { ytd: 0, ann: 0, py: 0, life: 0 });
  const totYoy = tot.py > 0 ? (tot.ann - tot.py) / tot.py : null;
  const shownCustomers = showAll ? sortedCustomers : sortedCustomers.slice(0, SHOW_N);

  const exportCsv = () => downloadCsv('stripe_connect_revenue', ['Customer', 'YTD $', 'YTD annualized $', 'Prior year $', 'YoY %', 'Lifetime $'],
    sortedCustomers.map((r) => [r.name, r.ytd, r.ytd_annualized, r.prior_year, r.yoy_pct == null ? '' : Math.round(r.yoy_pct * 100), r.lifetime]));

  const latestPartial = summary.latestMonth != null && summary.latestMonth >= cm;
  const thisYear = String(new Date().getFullYear());

  // ---- drill sheet
  const sheet = (() => {
    if (!drill) return null;
    if (drill.kind === 'customer') {
      const row = custRows.find((r) => r.customer_name === drill.name);
      const months = row ? Object.keys(row).filter((k) => MONTH_KEY.test(k) && (Number(row[k]) || 0) !== 0).sort().reverse() : [];
      const total = months.reduce((a, m) => a + (Number(row![m]) || 0), 0);
      return (
        <SideSheet open onClose={() => setDrill(null)} title={drill.name} text={`Connect revenue by month, newest first · ${months.length} months with fees`}>
          {months.length
            ? <DataTable label={`${drill.name} Connect revenue by month`} cols={[['Month', false], ['Connect revenue', true]]}
                rows={months.map((m) => [`${mlabel(m)}${inProgress(m) ? ' (in progress)' : ''}`, usd(Number(row![m]) || 0)])}
                foot={[`Total · ${months.length} months`, usd(total)]} />
            : <p className="am-card__text">No Connect revenue for this customer.</p>}
        </SideSheet>
      );
    }
    const list = customersFor(drill.months);
    const total = list.reduce((a, r) => a + r.amount, 0);
    return (
      <SideSheet open onClose={() => setDrill(null)} title={`${drill.title} · ${span(drill.months)}`}
        text="Connect fees by customer. From Jun 2026, accounts Stripe cannot name are carried as Unattributed Connect accounts, so the rows add up to the month total.">
        {list.length
          ? <DataTable label={drill.title} cols={[['Customer', false], ['Connect revenue', true], ['Share', true]]}
              rows={list.map((r) => [r.name, usd(r.amount), pct(total ? r.amount / total : null)])}
              clickable={(c) => c === 0} onCell={(i) => setDrill({ kind: 'customer', name: list[i].name })}
              foot={[`Total · ${list.length} customers`, usd(total), total ? '100.0%' : '—']} />
          : <p className="am-card__text">No Connect revenue in this period.</p>}
      </SideSheet>
    );
  })();

  return (
    <DsPage
      path="/stripe-connect-revenue"
      title="Stripe Connect Revenue"
      subtitle={isLoading ? 'Loading…' : 'Connect (affiliate) fees collected from customers’ Stripe payouts · year to date, annualizing and year over year use complete months only'}
      actions={
        <button className="am-btn am-btn--outlined" disabled={!sortedCustomers.length} onClick={exportCsv}>
          <Icon name="download" />Export CSV
        </button>
      }
      overlays={sheet}
    >
      {monthError ? <p className="am-card__text">Could not load Connect revenue: {String(monthError)}</p> : null}

      <div className="am-grid" style={{ ['--am-grid-min' as string]: '240px' }}>
        {!isLoading && monthRows.length > 0 && <>
          <KpiCard label="Latest month" value={usd(summary.latestAmount)}
            hint={summary.latestMonth ? `${mlabel(summary.latestMonth)}${latestPartial ? ' (in progress)' : ''}` : '—'}
            tag={latestPartial ? 'In progress' : 'Complete'} tagTone={latestPartial ? 'info' : 'neutral'}
            onOpen={summary.latestMonth ? () => openMonths([summary.latestMonth!], 'Connect revenue') : undefined} />
          <KpiCard label="Last 12 complete months" value={usd(ttm.total)}
            hint={ttm.rows.length ? `${mlabel(ttm.rows[0].month)} to ${mlabel(ttm.rows[ttm.rows.length - 1].month)}` : undefined}
            spark={ttm.rows.map((r) => Number(r.mrr_connect) || 0)} sparkTone="div-2"
            onOpen={ttm.rows.length ? () => openMonths(ttm.rows.map((r) => r.month), 'Last 12 complete months') : undefined} />
          <KpiCard label="YTD annualized" value={usd(summary.ytdAnnualized)}
            hint={`${usd(summary.currentYear)} over ${summary.monthsLoadedCurrent}/12 complete months`} />
          <KpiCard label="Year over year (annualized)" value={yoyText(summary.yoyPct)}
            hint={`Prior year: ${usd(summary.priorYear)}`}
            tag={summary.yoyPct == null ? undefined : summary.yoyPct >= 0 ? 'Growing' : 'Shrinking'}
            tagTone={summary.yoyPct == null ? undefined : summary.yoyPct >= 0 ? 'success' : 'warning'} />
          <KpiCard label="Lifetime Connect revenue" value={usd(summary.lifetime)} hint={`${customerRows.length} customers contributed`}
            onOpen={() => openMonths(monthRows.map((r) => r.month), 'Lifetime Connect revenue')} />
        </>}
      </div>
      <p className="am-card__text">The month in progress counts in the latest month, the lifetime total and the year’s actual, never in year to date, the annualized pace or year over year.</p>

      <ChartCard title="Monthly Connect revenue" caption={`Select a month to see the customers behind it · ${range.rangeText}${anyPartialShown ? ` · ${mlabel(cm)} is in progress` : ''}`}>
        {range.controls}
        <ColumnChart months={range.months} series={series} fmt={usdk} stacked legend={anyPartialShown}
          labelFor={(i) => usdk(byMonth.get(range.months[i]) ?? 0)}
          tipRows={(i) => {
            const m = range.months[i], v = byMonth.get(m) ?? 0;
            const prev = byMonth.get(monthRows[monthRows.findIndex((r) => r.month === m) - 1]?.month ?? '');
            const ly = byMonth.get(`${Number(m.slice(0, 4)) - 1}${m.slice(4)}`);
            return [
              ['Connect revenue', `${usd(v)}${inProgress(m) ? ' (in progress)' : ''}`],
              ...(prev != null && !inProgress(m) ? [['vs prior month', `${v - prev >= 0 ? '+' : '−'}${usd(Math.abs(v - prev))}`] as [string, string]] : []),
              ...(ly != null ? [['Same month last year', usd(ly)] as [string, string]] : []),
            ];
          }}
          onSegment={(i) => openMonths([range.months[i]], 'Connect revenue')}
          aria={`Monthly Connect revenue, ${range.rangeText}.`} />
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Year by year</span>
          <span className="am-chart__caption">Newest first · the full-year figure for {thisYear} is complete-month year to date × (12 ÷ complete months) · select a year to see its customers</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Connect revenue by year"
            cols={[['Year', false], ['Connect revenue', true], ['Complete months', true], ['Projected rest of year', true], ['Full year (projected)', true], ['vs prior year', true], ['Status', false]]}
            rows={[...yearly].reverse().map((y) => [
              y.year + (y.is_partial ? ' (in progress)' : ''), usd(y.actual), String(y.completeMonths),
              y.projected_extra > 0 ? usd(y.projected_extra) : '—', usd(y.actual + y.projected_extra), yoyText(y.vsPrior),
              <span key="s" className={`am-tag am-tag--${y.is_partial ? 'info' : 'neutral'}`}>{y.is_partial ? 'Projected' : 'Actual'}</span>,
            ])}
            clickable={(c) => c === 1}
            onCell={(row) => { const y = [...yearly].reverse()[row]; openMonths(y.months, `Connect revenue ${y.year}`); }}
            foot={[`Total · ${yearly.length} years`, usd(yearly.reduce((a, y) => a + y.actual, 0)), String(yearly.reduce((a, y) => a + y.completeMonths, 0)), '', '', '', '']}
            footClickable={(c) => c === 1}
            onFoot={() => openMonths(monthRows.map((r) => r.month), 'Lifetime Connect revenue')} />
        </div>
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread am-row--wrap">
          <div className="am-chart__head">
            <span className="am-chart__title">Customers by Connect revenue</span>
            <span className="am-chart__caption">YTD annualized uses the same complete-month divisor as the headline, so customers compare to each other and to the cards · select a customer for their months</span>
          </div>
          <div className="am-row am-row--wrap">
            <span className="am-card__text">Sort by</span>
            <Select label="Sort by" value={sortKey} options={SORTS} width={180}
              onPick={(k) => { setSortKey(k as SortKey); setSortDir(k === 'name' ? 'asc' : 'desc'); }} />
            <Segmented label="Order" value={sortDir} onChange={setSortDir}
              options={sortKey === 'name' ? [['asc', 'A to Z'], ['desc', 'Z to A']] : [['desc', 'Highest first'], ['asc', 'Lowest first']]} />
          </div>
        </div>
        {isLoading ? <p className="am-card__text">Loading…</p> : sortedCustomers.length === 0 ? <p className="am-card__text">No customer data.</p> : <>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Customers by Connect revenue"
              cols={[['Customer', false], ['YTD', true], ['YTD annualized', true], ['Prior year', true], ['Year over year', true], ['Direction', false], ['Lifetime', true]]}
              rows={shownCustomers.map((r) => {
                const [word, tone] = trendOf(r);
                return [r.name, usd(r.ytd), usd(r.ytd_annualized), usd(r.prior_year), yoyText(r.yoy_pct),
                  <span key="t" className={`am-tag am-tag--${tone}`}>{word}</span>, usd(r.lifetime)];
              })}
              clickable={(c) => c === 0}
              onCell={(i) => setDrill({ kind: 'customer', name: shownCustomers[i].name })}
              foot={[`Total · ${customerRows.length} customers`, usd(tot.ytd), usd(tot.ann), usd(tot.py), yoyText(totYoy), '', usd(tot.life)]}
              footClickable={(c) => !showAll && sortedCustomers.length > SHOW_N && c !== 4 && c !== 5}
              onFoot={() => setShowAll(true)} />
          </div>
          <div className="am-row am-row--wrap">
            {sortedCustomers.length > SHOW_N && (showAll
              ? <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show top {SHOW_N}</button>
              : <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {sortedCustomers.length}</button>)}
            <span className="am-card__text">Some Connect accounts could not be matched to a customer{custData && 'unknownAccountsCount' in custData ? ` (${String((custData as unknown as { unknownAccountsCount: number }).unknownAccountsCount)} older accounts were skipped in the source)` : ''}; from Jun 2026 unnamed accounts are carried as Unattributed Connect accounts.</span>
          </div>
        </>}
      </section>
    </DsPage>
  );
}
