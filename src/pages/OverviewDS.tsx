/**
 * Overview, rebuilt on the Allmoxy design system (pilot, approved by Beau 2026-11-09).
 *
 * Markup is assembled ONLY from certified design-system parts (src/design-system, copied from
 * allmoxy/allmoxy-design-system at the commit in SOURCE_COMMIT): app navigation, page header,
 * interactive outlined cards with sparklines (KPI tiles), column charts (plain and stacked), segmented buttons,
 * selects, filter chips, wide side sheets with data tables. React owns behavior (menus, sheets,
 * range, theme) in place of the showroom's behaviors.js, so the two never fight over the DOM.
 *
 * Data logic is the same as the classic Overview (NorthStar.tsx, still at /overview-classic):
 * headline figures come from customer_base (canonical), stream series from mrr_by_month with
 * the Services/Connect tab totals overriding the stale stacked rows, and the subscription and
 * customer series use the canonical base wherever its accrual window covers the month.
 *
 * Light and dark: the tokens switch on <html data-theme>. Default is dark; the choice is kept
 * per viewer in localStorage.
 */
import '../design-system/tokens/allmoxy-tokens.css';
// Showroom reading order (the design system's render gate refuses any other), frame last.
import '../design-system/components/icon.css';
import '../design-system/components/button.css';
import '../design-system/components/segmented-button.css';
import '../design-system/components/menu.css';
import '../design-system/components/text-field.css';
import '../design-system/components/chip.css';
import '../design-system/components/tag.css';
import '../design-system/components/card.css';
import '../design-system/components/layout.css';
import '../design-system/components/page-header.css';
import '../design-system/components/tooltip.css';
import '../design-system/components/side-sheet.css';
import '../design-system/components/app-navigation.css';
import '../design-system/components/table.css';
import '../design-system/components/summary.css';
import '../design-system/components/chart.css';
import '../design-system/components/select.css';
import '../design-system/templates/frame.css';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { useViewMode } from '../config/features';

// ---------------------------------------------------------------- types + helpers
type MRRRow = { month: string; logo_qty: number | null; mrr_subscription: number | null; mrr_services: number | null; mrr_connect: number | null };
type PerCustomer = { customer_name: string } & Record<string, number | null>;
type Member = { allmoxy_customer_id: number; name: string; mrr: number; source?: string };
type Base = { customers: number; mrr: number; as_of: string; by_month: Array<{ month: string; customers: number; mrr: number }>; members: Member[] };
type Preset = '12M' | '24M' | '60M' | 'ALL' | 'CUSTOM';
type Theme = 'dark' | 'light';

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd = (v: number) => USD0.format(v);
const usdk = (v: number) => (Math.abs(v) < 0.5 ? '$0' : Math.abs(v) < 1e6 ? `$${Math.round(v / 1000).toLocaleString()}k` : `$${(v / 1e6).toFixed(2)}M`);
const ML = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });
const MS = new Intl.DateTimeFormat('en-US', { month: 'short' });
const MSY = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' });
const toDate = (m: string) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1); };
const mlabel = (m: string) => ML.format(toDate(m));
const mshort = (m: string) => MS.format(toDate(m));
const addMonths = (m: string, d: number) => { const t = toDate(m); t.setMonth(t.getMonth() + d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`; };
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

const THEME_KEY = 'am-theme';
function readTheme(): Theme {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

// The dashboard's own sections. Finance and M&A respect the same view-mode gate as App.tsx.
const SECTIONS: Array<{ name: string; icon: string; financial?: boolean; pages: Array<[string, string]> }> = [
  { name: 'Revenue', icon: 'attach_money', pages: [['Current Month', '/current-month'], ['Revenue Waterfall', '/revenue-waterfall'], ['Revenue Recognition', '/revenue-recognition'], ['Collections', '/collections'], ['Services', '/services'], ['Stripe Connect', '/stripe-connect-revenue'], ['Payments Opportunity', '/payments-opportunity'], ['Sales Budget', '/sales-budget']] },
  { name: 'Retention', icon: 'timeline', pages: [['Logo Waterfall', '/logo-waterfall'], ['Cohort Retention', '/cohort-retention'], ['Net Revenue Retention', '/net-revenue-retention'], ['Churn Timeline', '/churn-timeline'], ['Churn Patterns', '/churn-patterns'], ['Churn Investigator', '/churn-investigator'], ['Churn Risk Matrix', '/churn-risk-matrix']] },
  { name: 'Customers', icon: 'group', pages: [['Customers', '/customers'], ['Customer Detail', '/customer-detail'], ['Customer Health', '/customer-health'], ['Renewal Management', '/renewal-management'], ['Contracts', '/contracts'], ['Time to Value', '/time-to-value'], ['Activation', '/activation'], ['Rep Dashboard', '/rep-dashboard'], ['Custom Report', '/custom-report']] },
  { name: 'Operations', icon: 'construction', pages: [['Implementation', '/implementation'], ['Implementation Schedule', '/implementation-schedule'], ['Service Tickets', '/service-tickets'], ['Orders Verified', '/orders-verified'], ['Features', '/features'], ['Bug Report', '/bug-report'], ['Project Candidates', '/project-candidates'], ['Data Cleanup', '/data-cleanup']] },
  { name: 'Finance', icon: 'insert_chart', financial: true, pages: [['Unit Economics', '/unit-economics'], ['Efficiency', '/efficiency'], ['Segments', '/segments'], ['Profit & Loss', '/profit-loss'], ['EBITDA Bridge', '/ebitda-bridge'], ['Stripe and QB Reconciliation', '/stripe-qb-reconciliation']] },
  { name: 'M&A', icon: 'verified', financial: true, pages: [['Scorecard', '/scorecard'], ['CIM Packet', '/cim-packet'], ['Banker Handoff', '/banker-handoff'], ['Adjustments Register', '/adjustments-register'], ['Annual Amortization', '/annual-amortization-evidence'], ['Definitions', '/definitions'], ['Invariant Tests', '/invariant-tests']] },
];

// ---------------------------------------------------------------- certified-part renderers
function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`am-icon ${className}`.trim()} data-icon={name} aria-hidden="true" />;
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values), rng = hi - lo || 1;
  const pts = values.map((v, i) => [2 + (i * 96) / (values.length - 1), 22 - ((v - lo) / rng) * 16]);
  const p = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  const trend = values[values.length - 1] > values[0] ? 'rising' : values[values.length - 1] < values[0] ? 'easing down' : 'flat';
  return (
    <svg className="am-sparkline" viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label={`Trend over the selected range, ${trend}.`} style={{ width: '100%', height: 40 }}>
      <polygon className="am-line__area am-series--cat-1" points={`${p} 98,24 2,24`} />
      <polyline className="am-line am-series--cat-1" points={p} vectorEffect="non-scaling-stroke" />
      <circle className="am-line__marker am-series--cat-1" cx={lx} cy={ly} r={2.4} />
    </svg>
  );
}

type Series = { label: string; values: number[]; cat: number };
/** Certified column chart: one column per month, or stacked by series with the total above.
 *  Columns anchor at zero. Value labels sit above each column while there is room for them
 *  (24 months or fewer); past that the data table carries the exact figures. */
function ColumnChart({ months, series, fmt, aria, stacked }: { months: string[]; series: Series[]; fmt: (v: number) => string; aria: string; stacked?: boolean }) {
  if (!months.length || !series.length) return <p className="am-card__text">No data for this range.</p>;
  const W = 1200, H = 280, L = 64, R = 16, T = 24, B = 236;
  const totals = months.map((_, i) => series.reduce((s, x) => s + (stacked ? x.values[i] : 0), 0));
  const hiRaw = stacked ? Math.max(...totals) : Math.max(...series[0].values);
  // Clean tick steps (1, 2, 2.5 or 5 times a power of ten), three or four of them.
  const rough = (hiRaw || 1) / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const tick = [1, 2, 2.5, 5, 10].map((k) => k * pow).find((v) => v >= rough) ?? 10 * pow;
  const ticks = Array.from({ length: Math.ceil(hiRaw / tick) }, (_, k) => (k + 1) * tick);
  const hi = Math.max(ticks[ticks.length - 1] ?? 1, hiRaw * 1.08);
  const Y = (v: number) => B - (v / hi) * (B - T);
  const slot = (W - L - R) / months.length;
  const bw = Math.min(56, slot * 0.62);
  const cx = (i: number) => L + slot * i + slot / 2;
  const labels = months.length <= 24;
  const step = Math.max(1, Math.ceil(months.length / 12));
  const longRange = months.length > 14;
  // Hover / focus reveals the month's exact figures in the certified rich tooltip (chart
  // hover ruled 2026-08-15: it adds figures, never replaces the labels on the columns).
  const [tip, setTip] = useState<{ i: number; left: number; top: number } | null>(null);
  const showTip = (i: number, el: SVGRectElement) => {
    const r = el.getBoundingClientRect();
    setTip({ i, left: r.left + r.width / 2, top: Y(stacked ? totals[i] : series[0].values[i]) / H * r.height + r.top - 28 });
  };
  return (
    <>
      <div className="am-tooltip" style={{ display: 'block', width: '100%' }} onMouseLeave={() => setTip(null)}>
      <svg className="am-column-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={aria} style={{ width: '100%' }}>
        <line className="am-chart__axis-line" x1={L} y1={B} x2={W - R} y2={B} />
        <text className="am-chart__tick" x={L - 6} y={B + 3} textAnchor="end">{fmt(0)}</text>
        {ticks.map((v, k) => {
          return (
            <g key={k}>
              <line className="am-chart__gridline" x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} />
              <text className="am-chart__tick" x={L - 6} y={Y(v) + 3} textAnchor="end">{fmt(v)}</text>
            </g>
          );
        })}
        {months.map((m, i) => {
          let acc = 0;
          const top = stacked ? totals[i] : series[0].values[i];
          return (
            <g key={m}>
              {(stacked ? series : [series[0]]).map((s) => {
                const v = s.values[i];
                const y = Y(acc + v);
                const h = Y(acc) - y;
                acc += v;
                return <rect key={s.label} className={`${stacked ? '' : 'am-column '}am-series--cat-${s.cat}`.trim()} x={cx(i) - bw / 2} y={y} width={bw} height={Math.max(0, h)} />;
              })}
              {labels && <text className="am-chart__value" x={cx(i)} y={Y(top) - 6} textAnchor="middle">{fmt(top)}</text>}
              {(i % step === 0 || i === months.length - 1) && (
                <text className="am-chart__cat" x={cx(i)} y={B + 18} textAnchor="middle">{longRange ? MSY.format(toDate(m)) : mshort(m)}</text>
              )}
              {/* the month's hover / focus zone: the full column slot, painted nothing */}
              <rect x={L + slot * i} y={T} width={slot} height={B - T} fillOpacity={0} tabIndex={0}
                aria-label={`${mlabel(m)}: ${stacked ? series.map((s) => `${s.label} ${fmt(s.values[i])}`).join(', ') + `, total ${fmt(totals[i])}` : fmt(series[0].values[i])}`}
                onMouseEnter={(e) => showTip(i, e.currentTarget)} onFocus={(e) => showTip(i, e.currentTarget)} onBlur={() => setTip(null)} />
            </g>
          );
        })}
      </svg>
      {tip && (
        <span className="am-tooltip__tip am-tooltip__tip--rich" role="tooltip" style={{ left: tip.left, top: tip.top }}>
          <b>{mlabel(months[tip.i])}</b>
          {stacked
            ? <>{[...series].reverse().map((s) => <span key={s.label} style={{ display: 'block' }}>{s.label}: {usd(s.values[tip.i])}</span>)}<span style={{ display: 'block' }}>Total: {usd(totals[tip.i])}</span></>
            : <span style={{ display: 'block' }}>{series[0].label}: {series[0].values[tip.i].toLocaleString()}</span>}
        </span>
      )}
      </div>
      {stacked && (
        <ul className="am-chart__legend am-chart__legend--below">
          {series.map((s) => (
            <li key={s.label} className="am-chart__legend-item"><span className={`am-chart__swatch am-series--cat-${s.cat}`} /><span className="am-chart__legend-label">{s.label}</span></li>
          ))}
        </ul>
      )}
      <table className="am-chart__data-table">
        <caption>{aria}</caption>
        <thead><tr><th>Month</th>{series.map((s) => <th key={s.label}>{s.label}</th>)}{stacked && <th>Total</th>}</tr></thead>
        <tbody>{months.map((m, i) => <tr key={m}><td>{mlabel(m)}</td>{series.map((s) => <td key={s.label}>{fmt(s.values[i])}</td>)}{stacked && <td>{fmt(totals[i])}</td>}</tr>)}</tbody>
      </table>
    </>
  );
}

function DataTable({ cols, rows, label }: { cols: Array<[string, boolean]>; rows: Array<Array<string>>; label: string }) {
  return (
    <table className="am-table" aria-label={label}>
      <thead><tr>{cols.map(([c, n]) => <th key={c} className={n ? 'am-table__num' : undefined}>{c}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={cols[j][1] ? 'am-table__num' : undefined}>{v}</td>)}</tr>)}</tbody>
    </table>
  );
}

// ---------------------------------------------------------------- page
export default function OverviewDS() {
  const navigate = useNavigate();
  const { showFinancialTabs } = useViewMode();
  const { data: mrrData, isLoading, error } = useSheetTab<MRRRow>('mrr_by_month');
  const { data: servicesData } = useSheetTab<PerCustomer>('services_by_month');
  const { data: connectData } = useSheetTab('connect_by_month');
  const { data: connectByCustData } = useSheetTab<PerCustomer>('connect_by_customer_month');
  const { data: baseData } = useSheetTab('customer_base');
  const { data: cmData } = useSheetTab('current_month');
  const base = baseData as unknown as Base | undefined;
  const dataThrough = (cmData as unknown as { as_of?: string } | undefined)?.as_of;

  // ---- theme (dark default, light on request), persisted per viewer
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private window */ }
  }, [theme]);
  // The design system's frame sets the page's base text color from the theme. The rest of
  // the app is still the dark MUI theme, so leaving this page hands it the dark tokens;
  // otherwise light mode (or a light OS setting) would put dark text on those dark pages.
  useEffect(() => () => document.documentElement.setAttribute('data-theme', 'dark'), []);

  // ---- transient surfaces: one open menu, one open sheet
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [openSheet, setOpenSheet] = useState<string | null>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!(e.target as Element).closest?.('.am-menu-anchor')) setOpenMenu(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpenMenu(null); setOpenSheet(null); } };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  // ---- month rows: Services/Connect tab totals override the stale stacked rows (as classic)
  const currentMonth = thisMonth();
  const rows = useMemo<MRRRow[]>(() => {
    if (!mrrData?.rows) return [];
    const svcT = (servicesData?.monthlyTotals ?? {}) as Record<string, number>;
    const conT = ((connectData as unknown as { monthlyTotals?: Record<string, number> })?.monthlyTotals ?? {}) as Record<string, number>;
    return mrrData.rows.map((r) => ({ ...r, mrr_services: svcT[r.month] ?? r.mrr_services ?? 0, mrr_connect: conT[r.month] ?? r.mrr_connect ?? 0 }));
  }, [mrrData, servicesData, connectData]);
  const complete = useMemo(() => rows.filter((r) => r.month < currentMonth), [rows, currentMonth]);
  const baseBy = useMemo(() => new Map((base?.by_month ?? []).map((r) => [r.month, r])), [base]);
  const rowBy = useMemo(() => new Map(rows.map((r) => [r.month, r])), [rows]);
  const customersAt = (m: string) => baseBy.get(m)?.customers ?? rowBy.get(m)?.logo_qty ?? 0;
  const subAt = (m: string) => baseBy.get(m)?.mrr ?? rowBy.get(m)?.mrr_subscription ?? 0;
  const svcAt = (m: string) => rowBy.get(m)?.mrr_services ?? 0;
  const conAt = (m: string) => rowBy.get(m)?.mrr_connect ?? 0;
  const totalAt = (m: string) => subAt(m) + svcAt(m) + conAt(m);

  const asOf = base?.as_of ?? complete[complete.length - 1]?.month;
  const prev = asOf ? addMonths(asOf, -1) : undefined;
  const annualAmort = useMemo(() => (base?.members ?? []).filter((x) => x.source === 'annual_amortized').reduce((s, x) => s + x.mrr, 0), [base]);

  // ---- range: presets plus a custom From / To (both charts share it)
  const firstMonth = complete[0]?.month;
  const lastMonth = complete[complete.length - 1]?.month;
  const [preset, setPreset] = useState<Preset>('12M');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  useEffect(() => {
    if (!firstMonth || !lastMonth || preset === 'CUSTOM') return;
    const back = preset === 'ALL' ? Infinity : preset === '60M' ? 59 : preset === '24M' ? 23 : 11;
    const start = back === Infinity ? firstMonth : addMonths(lastMonth, -back);
    setFrom(start < firstMonth ? firstMonth : start);
    setTo(lastMonth);
  }, [preset, firstMonth, lastMonth]);
  const months = useMemo(() => complete.map((r) => r.month).filter((m) => m >= from && m <= to), [complete, from, to]);
  const spark12 = useMemo(() => (lastMonth ? complete.map((r) => r.month).filter((m) => m > addMonths(lastMonth, -12)) : []), [complete, lastMonth]);

  // ---- revenue chart legend: filter chips hide/show a stream
  const [streams, setStreams] = useState({ Subscription: true, Connect: true, Services: true });

  if (error) {
    return <div className="tpl-shell"><main className="tpl-main"><div className="tpl-page"><p className="am-card__text">Could not load the monthly data: {String(error)}</p></div></main></div>;
  }

  const change = (cur: number, before: number, money = true) => {
    const d = cur - before;
    if (!prev) return '';
    if (Math.abs(d) < 0.5) return `Flat vs ${mshort(prev)}`;
    return `${d > 0 ? 'Up' : 'Down'} ${money ? usd(Math.abs(d)) : Math.abs(d).toLocaleString()} from ${mshort(prev)}`;
  };
  const ready = !isLoading && !!asOf && !!prev && !!base;

  const cards = ready ? [
    { id: 'customers', label: 'Active paying customers', value: base!.customers.toLocaleString(), hint: change(base!.customers, customersAt(prev!), false), spark: spark12.map(customersAt) },
    { id: 'subscription', label: 'Subscription MRR', value: usd(base!.mrr), hint: change(base!.mrr, subAt(prev!)), spark: spark12.map(subAt), tag: annualAmort > 0 ? `incl. ${usd(annualAmort)} annual` : undefined },
    { id: 'services', label: 'Services revenue', value: usd(svcAt(asOf!)), hint: change(svcAt(asOf!), svcAt(prev!)), spark: spark12.map(svcAt), tag: 'Not recurring' },
    { id: 'connect', label: 'Connect revenue', value: usd(conAt(asOf!)), hint: change(conAt(asOf!), conAt(prev!)), spark: spark12.map(conAt) },
    { id: 'total', label: 'Total monthly revenue', value: usd(base!.mrr + svcAt(asOf!) + conAt(asOf!)), hint: change(base!.mrr + svcAt(asOf!) + conAt(asOf!), totalAt(prev!)), spark: spark12.map(totalAt) },
  ] : [];

  // ---- drill-down sheets
  const members = [...(base?.members ?? [])].sort((a, b) => b.mrr - a.mrr);
  const memberRows = members.map((x) => [x.name, x.source === 'annual_amortized' ? 'Annual (amortized)' : 'Monthly', usd(x.mrr)]);
  const perCustomer = (d: { rows?: PerCustomer[] } | undefined) =>
    asOf ? (d?.rows ?? []).map((r) => [r.customer_name, Number(r[asOf] ?? 0)] as [string, number]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([n, v]) => [n, usd(v)]) : [];
  const m = asOf ? mlabel(asOf) : '';
  const total = ready ? base!.mrr + svcAt(asOf!) + conAt(asOf!) : 0;
  const sheets: Record<string, { title: string; text: string; body: ReactNode }> = ready ? {
    customers: { title: `Active paying customers · ${m}`, text: `${members.length} customers billed for a subscription in ${m} (invoiced basis). Annual payers count at their amortized monthly amount; duplicate records count once.`, body: <DataTable cols={[['Customer', false], ['Billing', false], ['MRR', true]]} rows={memberRows} label="Active paying customers" /> },
    subscription: { title: `Subscription MRR · ${m}`, text: `${usd(base!.mrr)} a month from the same ${members.length} customers: what was invoiced in ${m}, plus ${usd(annualAmort)} of annual payments spread across their twelve months.`, body: <DataTable cols={[['Customer', false], ['Billing', false], ['MRR', true]]} rows={memberRows} label="Subscription MRR by customer" /> },
    services: { title: `Services revenue · ${m}`, text: `Implementation and support work billed in ${m}. Project revenue, not recurring, so it is kept out of MRR.`, body: <DataTable cols={[['Customer', false], ['Billed', true]]} rows={perCustomer(servicesData as never)} label="Services revenue by customer" /> },
    connect: { title: `Connect revenue · ${m}`, text: `Platform fees Allmoxy earned on payments customers processed through Stripe Connect in ${m}.`, body: <DataTable cols={[['Customer', false], ['Fees', true]]} rows={perCustomer(connectByCustData as never)} label="Connect revenue by customer" /> },
    total: { title: `Total monthly revenue · ${m}`, text: 'Subscription MRR plus Services plus Connect. Services is not recurring, so this total is revenue, not MRR.', body: <DataTable cols={[['Stream', false], ['Amount', true], ['Share', true]]} rows={[['Subscription MRR', base!.mrr], ['Services revenue', svcAt(asOf!)], ['Connect revenue', conAt(asOf!)]].map(([n, v]) => [String(n), usd(Number(v)), `${((Number(v) / total) * 100).toFixed(1)}%`]).concat([['Total', usd(total), '100%']])} label="Total monthly revenue by stream" /> },
  } : {};

  // ---- range controls (segmented presets + From / To selects), shared by both charts
  const RangeControls = ({ id }: { id: string }) => (
    <div className="am-row am-row--wrap">
      <div className="am-segmented" role="group" aria-label="Range">
        {([['12M', '1 yr'], ['24M', '2 yr'], ['60M', '5 yr'], ['ALL', 'All']] as Array<[Preset, string]>).map(([k, l]) => (
          <button key={k} className="am-segmented__seg" aria-pressed={preset === k} onClick={() => setPreset(k)}>
            <Icon name="check" className="am-seg-check" />{l}
          </button>
        ))}
      </div>
      {(['from', 'to'] as const).map((which) => {
        const value = which === 'from' ? from : to;
        const key = `${id}-${which}`;
        return (
          <div key={which} className="am-row am-row--tight">
            <span className="am-card__text">{which === 'from' ? 'From' : 'To'}</span>
            <div className={`am-menu-anchor am-select${openMenu === key ? ' is-open' : ''}`} style={{ width: 150 }}>
              <label className="am-field am-field--outlined" onClick={() => setOpenMenu(openMenu === key ? null : key)}>
                <input className="am-field__input" placeholder=" " value={value ? mlabel(value) : ''} readOnly aria-label={`${which === 'from' ? 'From' : 'To'} month`} />
                <Icon name="arrow_drop_down" className="am-field__trail" />
                <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap" /><i /></span>
              </label>
              <div className="am-menu" role="menu" style={{ maxHeight: 320, overflowY: 'auto' }}>
                {[...complete].reverse().map((r) => (
                  <button key={r.month} className="am-menu__item" role="menuitem" aria-selected={r.month === value}
                    onClick={() => {
                      setPreset('CUSTOM');
                      if (which === 'from') { setFrom(r.month); if (to && r.month > to) setTo(r.month); }
                      else { setTo(r.month); if (from && r.month < from) setFrom(r.month); }
                      setOpenMenu(null);
                    }}>
                    <span className="am-menu__label">{mlabel(r.month)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  const rangeText = months.length ? `${mlabel(months[0])} to ${mlabel(months[months.length - 1])}` : '';
  const revSeries: Series[] = [
    { label: 'Subscription', values: months.map(subAt), cat: 1 },
    { label: 'Connect', values: months.map(conAt), cat: 2 },
    { label: 'Services', values: months.map(svcAt), cat: 3 },
  ].filter((s) => streams[s.label as keyof typeof streams]);

  return (
    <div className="tpl-shell">
      <header className="am-appnav">
        <nav className="am-appnav__group am-appnav__sections" aria-label="Primary">
          <span className="am-tooltip">
            <a className="am-appnav__btn" href="/overview" aria-current="page" aria-label="Overview" onClick={(e) => e.preventDefault()}>
              <Icon name="dashboard" /><span className="am-appnav__label">Overview</span>
            </a>
            <span className="am-tooltip__tip">Overview</span>
          </span>
          {SECTIONS.filter((s) => !s.financial || showFinancialTabs).map((s) => (
            <div key={s.name} className={`am-menu-anchor${openMenu === `nav-${s.name}` ? ' is-open' : ''}`}>
              <button className="am-appnav__btn" aria-label={s.name} aria-haspopup="true" aria-expanded={openMenu === `nav-${s.name}`}
                onClick={() => setOpenMenu(openMenu === `nav-${s.name}` ? null : `nav-${s.name}`)}>
                <Icon name={s.icon} className="am-appnav__section-icon" /><span className="am-appnav__label">{s.name}</span> <Icon name="arrow_drop_down" className="am-appnav__caret" />
              </button>
              <div className="am-menu" role="menu">
                {s.pages.map(([label, path]) => (
                  <button key={path} className="am-menu__item" role="menuitem" onClick={() => { setOpenMenu(null); navigate(path); }}>
                    <span className="am-menu__label">{label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <span className="am-appnav__spacer" />
        <div className="am-appnav__group">
          <span className="am-tooltip">
            <button className="am-appnav__btn am-appnav__btn--icon" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              <Icon name={theme === 'dark' ? 'light_mode' : 'dark_mode'} />
            </button>
            <span className="am-tooltip__tip">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
          </span>
        </div>
      </header>

      <main className="tpl-main">
        <div className="tpl-page">
          <header className="am-page-header">
            <div className="am-page-header__titlewrap">
              <h1 className="am-page-header__title">Overview</h1>
              <p className="am-page-header__subtitle">
                {asOf ? `${mlabel(asOf)}, the latest complete month` : 'Loading…'}
                {dataThrough ? ` · Stripe data through ${new Date(`${dataThrough}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
              </p>
            </div>
          </header>

          <div className="tpl-regular-body">
            <div className="am-grid" style={{ ['--am-grid-min' as string]: '240px' }}>
              {cards.map((c) => (
                <div key={c.id} className="am-card am-card--outlined am-card--interactive" role="button" tabIndex={0} aria-label={`${c.label}: open the detail`}
                  style={{ display: 'flex', flexDirection: 'column' }}
                  onClick={() => setOpenSheet(c.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenSheet(c.id); } }}>
                  <span className="am-card__text">{c.label}</span>
                  <p className="am-summary__value">{c.value}</p>
                  <div className="am-row am-row--wrap">
                    <span className="am-card__text">{c.hint}</span>
                    {c.tag && <span className="am-tag">{c.tag}</span>}
                  </div>
                  {/* Pinned to the card's foot so every tile's trend sits on one baseline,
                      whether or not the card carries a tag line. */}
                  <div style={{ marginTop: 'auto', paddingTop: 8 }}><Sparkline values={c.spark} /></div>
                </div>
              ))}
            </div>

            <section className="am-card am-card--outlined">
              <figure className="am-chart" aria-label="Active paying customers">
                <div className="am-chart__head">
                  <span className="am-chart__title">Active paying customers</span>
                  <span className="am-chart__caption">Customers billed for a subscription each month · {rangeText}</span>
                </div>
                <RangeControls id="cust" />
                <ColumnChart months={months} series={[{ label: 'Customers', values: months.map(customersAt), cat: 1 }]} fmt={(v) => Math.round(v).toLocaleString()} aria={`Active paying customers by month, ${rangeText}.`} />
              </figure>
            </section>

            <section className="am-card am-card--outlined">
              <figure className="am-chart" aria-label="Revenue by stream">
                <div className="am-chart__head">
                  <span className="am-chart__title">Revenue by stream</span>
                  <span className="am-chart__caption">Monthly revenue in USD; Services is project work, not recurring · {rangeText}</span>
                </div>
                <RangeControls id="rev" />
                <div className="am-row am-row--wrap" role="group" aria-label="Streams shown">
                  {(Object.keys(streams) as Array<keyof typeof streams>).map((k) => (
                    <label key={k} className="am-chip am-chip--filter">
                      <input type="checkbox" checked={streams[k]} onChange={() => setStreams((s) => ({ ...s, [k]: !s[k] }))} />
                      {streams[k] && <Icon name="check" className="am-chip__check" />}
                      <span className="am-chip__label">{k}</span>
                    </label>
                  ))}
                </div>
                <ColumnChart months={months} series={revSeries} fmt={usdk} stacked aria={`Revenue by stream by month, ${rangeText}.`} />
              </figure>
            </section>
          </div>
        </div>
      </main>

      {Object.entries(sheets).map(([id, s]) => (
        <div key={id} className={`am-sheet-host${openSheet === id ? ' is-open' : ''}`}>
          <div className="am-scrim" onClick={() => setOpenSheet(null)} />
          <div className="am-sidesheet am-sidesheet--wide" role="dialog" aria-modal="true" aria-label={s.title}>
            <div className="am-sidesheet__head">
              <h2 className="am-sidesheet__title">{s.title}</h2>
              <button className="am-sidesheet__close" aria-label="Close" onClick={() => setOpenSheet(null)}><Icon name="close" /></button>
            </div>
            <p className="am-sidesheet__text">{s.text}</p>
            {s.body}
          </div>
        </div>
      ))}
    </div>
  );
}
