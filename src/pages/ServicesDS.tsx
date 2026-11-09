/**
 * Services revenue on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (Services.tsx, kept at
 * /services-classic), ported unchanged: the same services_by_month + customer_profiles
 * snapshots, the same name match for segment, the same segment filter, and the same maths.
 * Annualization uses COMPLETE months only (the in-progress month is left out of both the
 * numerator and the divisor), exactly as the classic page.
 *
 * Services (implementation, support, projects) are one-time revenue, never MRR.
 * Colors follow the Revenue Waterfall: billed blue (div-1), pace still to come gray (other).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, FilterChip, Icon, KpiCard, Select, SideSheet, Switch,
  downloadCsv, mlabel, usd, usdk, useMonthRange,
} from '../design-system/parts';

type CustomerMonthRow = { customer_name: string; [yearMonth: string]: string | number | null };
type ServicesByMonth = { rows: CustomerMonthRow[]; monthlyTotals: Record<string, number>; notes?: string };
type Profile = {
  allmoxy_customer_id: number; name: string; hubspot_instance_name?: string | null;
  customer_name?: string | null; primary_segment: string | null;
};
type CustomerRow = {
  name: string; aid: number | null; segment: string | null;
  ytd: number; ytd_annualized: number; prior_year: number; yoy_pct: number | null; lifetime: number;
};
type SortKey = 'name' | 'ytd' | 'ytd_annualized' | 'prior_year' | 'yoy_pct' | 'lifetime';

const normName = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const yoyTxt = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%`);
const NO_SEG = '(no segment)';
const TOP = 25;

type Drill =
  | { kind: 'months'; title: string; months: string[] }
  | { kind: 'month'; month: string }
  | { kind: 'customer'; name: string };

export default function ServicesDS() {
  const navigate = useNavigate();
  const { data, isLoading: servicesLoading, error } = useSheetTab<ServicesByMonth>('services_by_month');
  const { data: profilesData, isLoading: profilesLoading } = useSheetTab<Profile>('customer_profiles');
  const isLoading = servicesLoading || profilesLoading;
  const snap = data as unknown as ServicesByMonth | undefined;

  const [sortKey, setSortKey] = useState<SortKey>('ytd_annualized');
  const [segmentFilter, setSegmentFilter] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [includePartial, setIncludePartial] = useState(false);
  const [drill, setDrill] = useState<Drill | null>(null);

  const toggleSegment = (seg: string) => {
    const next = new Set(segmentFilter);
    if (next.has(seg)) next.delete(seg); else next.add(seg);
    setSegmentFilter(next);
  };

  // ---- data logic, ported verbatim from the classic page ----
  const profileByName = useMemo(() => {
    const m = new Map<string, { aid: number; segment: string | null }>();
    for (const p of (profilesData?.rows ?? []) as Profile[]) {
      const candidates = [p.hubspot_instance_name, p.customer_name, p.name].filter(Boolean) as string[];
      for (const c of candidates) {
        const k = normName(c);
        if (k && !m.has(k)) m.set(k, { aid: p.allmoxy_customer_id, segment: p.primary_segment ?? null });
      }
    }
    return m;
  }, [profilesData]);

  // Complete months elapsed this calendar year (the in-progress month is excluded).
  const monthsElapsed = useMemo(() => new Date().getMonth(), []);
  const currentMonthKey = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, []);

  const customerRows = useMemo<CustomerRow[]>(() => {
    if (!snap?.rows) return [];
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    const divisor = monthsElapsed || 1;
    const out: CustomerRow[] = [];
    for (const row of snap.rows) {
      let cy = 0, py = 0, lifetime = 0;
      for (const [k, v] of Object.entries(row)) {
        if (k === 'customer_name') continue;
        const num = Number(v) || 0;
        if (num === 0) continue;
        lifetime += num;
        const yr = k.slice(0, 4);
        if (yr === currentYearStr) { if (k < currentMonthKey) cy += num; }
        else if (yr === priorYearStr) py += num;
      }
      if (lifetime === 0) continue;
      const annualized = divisor > 0 && divisor < 12 ? (cy * 12) / divisor : cy;
      const profile = profileByName.get(normName(row.customer_name));
      out.push({
        name: row.customer_name, aid: profile?.aid ?? null, segment: profile?.segment ?? null,
        ytd: cy, ytd_annualized: annualized, prior_year: py, yoy_pct: py > 0 ? (annualized - py) / py : null, lifetime,
      });
    }
    return out;
  }, [snap, monthsElapsed, profileByName, currentMonthKey]);

  const segmentFacets = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of customerRows) { const seg = r.segment ?? NO_SEG; counts.set(seg, (counts.get(seg) ?? 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [customerRows]);

  const filteredCustomers = useMemo(
    () => (segmentFilter.size === 0 ? customerRows : customerRows.filter((r) => segmentFilter.has(r.segment ?? NO_SEG))),
    [customerRows, segmentFilter]);

  // No filter: the sheet's formula-driven summary row. Filter: sum the selected customers.
  const filteredMonthlyTotals = useMemo(() => {
    if (!snap) return {} as Record<string, number>;
    if (segmentFilter.size === 0) return snap.monthlyTotals ?? {};
    const wanted = new Set(filteredCustomers.map((r) => r.name));
    const totals: Record<string, number> = {};
    for (const m of Object.keys(snap.monthlyTotals ?? {})) totals[m] = 0;
    for (const row of snap.rows) {
      if (!wanted.has(row.customer_name)) continue;
      for (const [k, v] of Object.entries(row)) {
        if (k === 'customer_name') continue;
        const num = Number(v) || 0;
        if (num === 0) continue;
        totals[k] = (totals[k] ?? 0) + num;
      }
    }
    return totals;
  }, [snap, segmentFilter, filteredCustomers]);

  const summary = useMemo(() => {
    const mt = filteredMonthlyTotals;
    const months = Object.keys(mt).sort();
    if (months.length === 0) return { latestMonth: null as string | null, latestAmount: 0, currentYear: 0, priorYear: 0, ytdAnnualized: 0, yoyPct: null as number | null, lifetime: 0 };
    const today = new Date();
    const currentYearStr = String(today.getFullYear());
    const priorYearStr = String(today.getFullYear() - 1);
    let cy = 0, py = 0, lifetime = 0;
    for (const m of months) {
      const v = Number(mt[m]) || 0;
      lifetime += v;
      if (m.startsWith(currentYearStr)) { if (m < currentMonthKey) cy += v; }
      else if (m.startsWith(priorYearStr)) py += v;
    }
    const annualized = monthsElapsed > 0 && monthsElapsed < 12 ? (cy * 12) / monthsElapsed : cy;
    const latest = months[months.length - 1];
    return {
      latestMonth: latest, latestAmount: Number(mt[latest]) || 0, currentYear: cy, priorYear: py,
      ytdAnnualized: annualized, yoyPct: py > 0 ? (annualized - py) / py : null, lifetime,
    };
  }, [filteredMonthlyTotals, monthsElapsed, currentMonthKey]);

  const yearly = useMemo(() => {
    const currentYearStr = String(new Date().getFullYear());
    const byYear = new Map<string, { total: number; completeTotal: number; months: number }>();
    for (const [m, v] of Object.entries(filteredMonthlyTotals)) {
      const yr = m.slice(0, 4);
      const num = Number(v) || 0;
      if (!byYear.has(yr)) byYear.set(yr, { total: 0, completeTotal: 0, months: 0 });
      const e = byYear.get(yr)!;
      e.total += num;
      if (m < currentMonthKey) e.completeTotal += num;
      if (num > 0) e.months++;
    }
    return [...byYear.entries()].map(([year, v]) => {
      const isCurrent = year === currentYearStr && monthsElapsed > 0 && monthsElapsed < 12;
      const annualized = isCurrent ? (v.completeTotal * 12) / monthsElapsed : v.total;
      return {
        year, actual_usd: Math.round(v.total * 100) / 100,
        projected_extra: Math.round(Math.max(0, annualized - v.total) * 100) / 100,
        months: v.months, is_partial: isCurrent,
      };
    }).sort((a, b) => a.year.localeCompare(b.year));
  }, [filteredMonthlyTotals, monthsElapsed, currentMonthKey]);

  const sortedCustomers = useMemo(() => {
    const dir = sortKey === 'name' ? 'asc' : 'desc';
    const out = [...filteredCustomers];
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
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filteredCustomers, sortKey]);

  // ---- view ----
  const allMonths = useMemo(() => Object.keys(filteredMonthlyTotals).sort(), [filteredMonthlyTotals]);
  const partialMonth = allMonths.find((m) => m >= currentMonthKey) ?? null;
  const range = useMonthRange(includePartial ? allMonths : allMonths.filter((m) => m < currentMonthKey));
  const mval = (m: string) => Math.round((Number(filteredMonthlyTotals[m]) || 0) * 100) / 100;
  const yearOf = (y: string) => yearly.find((r) => r.year === y);
  const currentYear = String(new Date().getFullYear());
  const priorYear = String(new Date().getFullYear() - 1);
  const filtered = segmentFilter.size > 0;
  const rowByName = useMemo(() => new Map((snap?.rows ?? []).map((r) => [r.customer_name, r])), [snap]);
  const wanted = useMemo(() => new Set(filteredCustomers.map((r) => r.name)), [filteredCustomers]);

  const exportCsv = () => downloadCsv('services_revenue', ['Customer', 'Segment', 'YTD $', 'YTD annualized $', 'Prior year $', 'YoY %', 'Lifetime $'],
    sortedCustomers.map((r) => [r.name, r.segment ?? '', r.ytd, r.ytd_annualized, r.prior_year, r.yoy_pct == null ? '' : Math.round(r.yoy_pct * 100), r.lifetime]));

  const shown = showAll ? sortedCustomers : sortedCustomers.slice(0, TOP);
  const sum = (k: 'ytd' | 'ytd_annualized' | 'prior_year' | 'lifetime') => sortedCustomers.reduce((a, r) => a + r[k], 0);
  const totPy = sum('prior_year'), totAnn = sum('ytd_annualized');

  // ---- drill-down sheet ----
  const sheet = (() => {
    if (!drill || !snap) return null;
    if (drill.kind === 'months') {
      const ms = [...drill.months].reverse();
      const total = ms.reduce((a, m) => a + mval(m), 0);
      return (
        <SideSheet open onClose={() => setDrill(null)} title={drill.title}
          text={`${ms.length} months · ${usd(total)} services revenue${filtered ? ' · segment filter applied' : ''} · select a month for its customers`}>
          <DataTable label={drill.title} cols={[['Month', false], ['Services revenue', true]]}
            rows={ms.map((m) => [mlabel(m) + (m >= currentMonthKey ? ' (in progress)' : ''), mval(m) ? usd(mval(m)) : '—'])}
            onCell={(row) => setDrill({ kind: 'month', month: ms[row] })} clickable={(c) => c === 1}
            foot={[`Total · ${ms.length} months`, usd(total)]} />
        </SideSheet>
      );
    }
    if (drill.kind === 'month') {
      const m = drill.month;
      const list = (snap.rows ?? [])
        .filter((r) => wanted.has(r.customer_name))
        .map((r) => ({ name: r.customer_name, v: Number(r[m]) || 0 }))
        .filter((x) => x.v !== 0)
        .sort((a, b) => b.v - a.v);
      const total = list.reduce((a, x) => a + x.v, 0);
      const sheetTotal = mval(m);
      return (
        <SideSheet open onClose={() => setDrill(null)} title={`Services billed · ${mlabel(m)}${m >= currentMonthKey ? ' (in progress)' : ''}`}
          text={Math.abs(total - sheetTotal) >= 1
            ? `Customers add to ${usd(total)}; the sheet's month total is ${usd(sheetTotal)} (the page's figures use the sheet total).`
            : `${list.length} customers billed for services this month.`}>
          {list.length
            ? <DataTable label={`Services billed in ${mlabel(m)}`} cols={[['Customer', false], ['Services revenue', true]]}
                rows={list.map((x) => [x.name, usd(x.v)])} onCell={(row) => setDrill({ kind: 'customer', name: list[row].name })} clickable={(c) => c === 0}
                foot={[`Total · ${list.length} customers`, usd(total)]} />
            : <p className="am-card__text">No customer billed services this month.</p>}
        </SideSheet>
      );
    }
    const r = rowByName.get(drill.name);
    const c = customerRows.find((x) => x.name === drill.name);
    const ms = r ? Object.keys(r).filter((k) => /^\d{4}-\d{2}$/.test(k) && (Number(r[k]) || 0) !== 0).sort().reverse() : [];
    const total = ms.reduce((a, m) => a + (Number(r![m]) || 0), 0);
    return (
      <SideSheet open onClose={() => setDrill(null)} title={drill.name}
        text={c ? `${c.segment ?? 'No segment'} · ${usd(c.lifetime)} lifetime services · ${usd(c.ytd)} this year (complete months)` : undefined}>
        <div className="am-row">
          <button className="am-btn am-btn--outlined" onClick={() => navigate(c?.aid != null ? `/customer-detail?id=${c.aid}` : `/customer-detail?name=${encodeURIComponent(drill.name)}`)}>
            <Icon name="open_in_new" />Open customer
          </button>
        </div>
        {ms.length
          ? <DataTable label={`Services billed to ${drill.name}`} cols={[['Month', false], ['Services revenue', true]]}
              rows={ms.map((m) => [mlabel(m) + (m >= currentMonthKey ? ' (in progress)' : ''), usd(Number(r![m]) || 0)])}
              foot={[`Total · ${ms.length} months billed`, usd(total)]} />
          : <p className="am-card__text">No services billed.</p>}
      </SideSheet>
    );
  })();

  const last12 = allMonths.filter((m) => m < currentMonthKey).slice(-12).map(mval);
  const yearSpark = yearly.filter((y) => y.year !== currentYear).map((y) => y.actual_usd).concat(yearOf(currentYear) ? [yearOf(currentYear)!.actual_usd + yearOf(currentYear)!.projected_extra] : []);

  return (
    <DsPage
      path="/services"
      title="Services Revenue"
      subtitle="Implementation, support and project work billed to customers. One-time revenue, not MRR. This year is annualized from complete months only."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!sortedCustomers.length}><Icon name="download" />Export CSV</button>}
      overlays={sheet}
    >
      {error ? <p className="am-card__text">Could not load services_by_month: {String(error)}</p> : null}

      {!isLoading && segmentFacets.length > 0 && (
        <div className="am-row am-row--wrap" role="group" aria-label="Segment">
          <span className="am-card__text">Segment</span>
          {segmentFacets.map(([seg, count]) => (
            <FilterChip key={seg} checked={segmentFilter.has(seg)} onChange={() => toggleSegment(seg)}>{seg} · {count}</FilterChip>
          ))}
          {filtered && <button className="am-btn am-btn--text" onClick={() => setSegmentFilter(new Set())}>Clear</button>}
        </div>
      )}

      <div className="am-grid" style={{ ['--am-grid-min' as string]: '258px' }}>
        {isLoading ? <p className="am-card__text">Loading services revenue…</p> : <>
          <KpiCard label="Latest month" value={usd(summary.latestAmount)}
            hint={summary.latestMonth ? mlabel(summary.latestMonth) : '—'}
            tag={summary.latestMonth && summary.latestMonth >= currentMonthKey ? 'In progress' : 'Complete'} tagTone="neutral"
            spark={last12} sparkTone="div-1"
            onOpen={summary.latestMonth ? () => setDrill({ kind: 'month', month: summary.latestMonth! }) : undefined} />
          <KpiCard label={`Year to date · ${currentYear}`} value={usd(summary.currentYear)}
            hint={`${monthsElapsed} complete month${monthsElapsed === 1 ? '' : 's'} · the month in progress is left out`}
            onOpen={() => setDrill({ kind: 'months', title: `${currentYear} by month`, months: allMonths.filter((m) => m.startsWith(currentYear)) })} />
          <KpiCard label="YTD annualized" value={usd(summary.ytdAnnualized)}
            hint={`Year to date × 12 ÷ ${monthsElapsed} complete months`} />
          <KpiCard label="Change vs last year" value={yoyTxt(summary.yoyPct)}
            hint={`Annualized vs ${priorYear}: ${usd(summary.priorYear)}`}
            tag={summary.yoyPct == null ? undefined : summary.yoyPct >= 0 ? 'Growing' : 'Shrinking'}
            tagTone={summary.yoyPct == null ? undefined : summary.yoyPct >= 0 ? 'success' : 'warning'}
            spark={yearSpark.length > 1 ? yearSpark : undefined} sparkTone="div-1"
            onOpen={() => setDrill({ kind: 'months', title: `${priorYear} by month`, months: allMonths.filter((m) => m.startsWith(priorYear)) })} />
          <KpiCard label="Lifetime services" value={usd(summary.lifetime)}
            hint={`${filteredCustomers.length} customer${filteredCustomers.length === 1 ? '' : 's'} billed${filtered ? ` · filtered from ${customerRows.length}` : ''}`}
            onOpen={() => setDrill({ kind: 'months', title: 'All months', months: allMonths })} />
        </>}
      </div>

      <ChartCard title="Services revenue by month" caption={`Hover a month for its exact figure, select a column for the customers billed · ${range.rangeText}`}>
        <div className="am-row am-row--wrap">
          {range.controls}
          {partialMonth && <Switch checked={includePartial} onChange={setIncludePartial}>Include {mlabel(partialMonth)} (in progress)</Switch>}
        </div>
        {isLoading ? <p className="am-card__text">Loading…</p> : (
          <ColumnChart months={range.months} fmt={usdk}
            series={[{ key: 'services', label: 'Services revenue', tone: 'div-1', values: range.months.map(mval) }]}
            tipRows={(i) => { const m = range.months[i]; return [['Services revenue', usd(mval(m))], ...(m >= currentMonthKey ? [['Status', 'in progress'] as [string, string]] : [])]; }}
            onSegment={(i) => setDrill({ kind: 'month', month: range.months[i] })}
            aria={`Monthly services revenue, ${range.rangeText}.`} />
        )}
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">By year</span>
          <span className="am-chart__caption">{`Billed in each calendar year. ${currentYear} also shows its full-year pace: complete months × 12 ÷ ${monthsElapsed}; the month in progress counts as billed but not toward the pace. Select a year for its months.`}</span>
        </div>
        <DataTable label="Services revenue by year"
          cols={[['Year', false], ['Billed', true], ['Full-year pace', true], ['Months billed', true], ['Change vs prior year', true]]}
          rows={[...yearly].reverse().map((y) => {
            const prev = yearOf(String(Number(y.year) - 1));
            const full = y.actual_usd + y.projected_extra;
            const chg = prev && prev.actual_usd > 0 ? full / prev.actual_usd - 1 : null;
            return [
              y.is_partial ? <span key="y" className="am-row am-row--tight">{y.year}<span className="am-tag am-tag--info">In progress</span></span> : y.year,
              usd(y.actual_usd), y.is_partial ? usd(full) : '—', String(y.months),
              chg == null ? '—' : <span key="c" className={`am-tag am-tag--${chg >= 0 ? 'success' : 'warning'}`}>{chg >= 0 ? 'Up' : 'Down'} {yoyTxt(chg).replace(/^[+−]/, '')}</span>,
            ];
          })}
          clickable={(c) => c === 1}
          onCell={(row) => { const y = [...yearly].reverse()[row]; setDrill({ kind: 'months', title: `${y.year} by month`, months: allMonths.filter((m) => m.startsWith(y.year)) }); }}
          foot={[`Total · ${yearly.length} years`, usd(yearly.reduce((a, y) => a + y.actual_usd, 0)), '', String(yearly.reduce((a, y) => a + y.months, 0)), '']}
          footClickable={(c) => c === 1} onFoot={() => setDrill({ kind: 'months', title: 'All months', months: allMonths })} />
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread am-row--wrap">
          <div className="am-chart__head">
            <span className="am-chart__title">Customers by services revenue</span>
            <span className="am-chart__caption">{`${sortedCustomers.length} of ${customerRows.length} customers · annualized on the same ${monthsElapsed} complete months as the cards · select a customer for their months`}</span>
          </div>
          <div className="am-row">
            <span className="am-card__text">Sort by</span>
            <Select label="Sort by" value={sortKey} width={200} onPick={(v) => setSortKey(v as SortKey)}
              options={[['ytd_annualized', 'YTD annualized'], ['ytd', 'Year to date'], ['prior_year', 'Prior year'], ['yoy_pct', 'Change vs last year'], ['lifetime', 'Lifetime'], ['name', 'Customer A to Z']]} />
          </div>
        </div>
        {isLoading ? <p className="am-card__text">Loading…</p> : sortedCustomers.length === 0 ? <p className="am-card__text">No customer data.</p> : <>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Customers by services revenue"
              cols={[['Customer', false], ['Segment', false], ['Year to date', true], ['YTD annualized', true], ['Prior year', true], ['Change vs last year', true], ['Lifetime', true]]}
              rows={shown.map((r) => [
                r.name, r.segment ?? '—', usd(r.ytd), usd(r.ytd_annualized), usd(r.prior_year),
                r.yoy_pct == null
                  ? (r.ytd > 0 ? <span key="t" className="am-tag am-tag--info">New this year</span> : '—')
                  : <span key="t" className={`am-tag am-tag--${r.yoy_pct >= 0 ? 'success' : 'warning'}`}>{r.yoy_pct >= 0 ? 'Up' : 'Down'} {yoyTxt(r.yoy_pct).replace(/^[+−]/, '')}</span>,
                usd(r.lifetime),
              ])}
              clickable={(c) => c === 0}
              onCell={(row) => setDrill({ kind: 'customer', name: shown[row].name })}
              foot={[`Total · ${sortedCustomers.length} customers`, '', usd(sum('ytd')), usd(totAnn), usd(totPy), totPy > 0 ? yoyTxt((totAnn - totPy) / totPy) : '—', usd(sum('lifetime'))]}
              footClickable={(c) => !showAll && sortedCustomers.length > TOP && c !== 1 && c !== 5}
              onFoot={() => setShowAll(true)} />
          </div>
          {sortedCustomers.length > TOP && (
            <button className="am-btn am-btn--text" onClick={() => setShowAll(!showAll)}>{showAll ? `Show top ${TOP}` : `Show all ${sortedCustomers.length}`}</button>
          )}
        </>}
      </section>
    </DsPage>
  );
}
