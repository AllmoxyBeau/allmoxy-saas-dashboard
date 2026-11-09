/**
 * Profit & Loss on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (ProfitLoss.tsx, kept at
 * /profit-loss-classic): the same pnl_by_month snapshot, the same "latest complete month" rule
 * (last month with total income AND subscription revenue above zero), the same range presets
 * anchored on that month, the same trailing-12 and year-over-year maths, and the same
 * account tree (children sit above the subtotal they roll into, as QuickBooks prints them).
 *
 * The QuickBooks sync is not configured, so the P&L stops at the last export (June 2026 at
 * the time of writing). Every trailing / year-to-date figure is labelled with its real window.
 *
 * Local part: the statement table. DataTable has no group rows, no subtotal rows inside the
 * body and no expandable rows, so the statement is drawn here with the certified table classes
 * (am-table, am-table__group / __group-tag for section rows, the title-small role for subtotal
 * rows, tfoot for the Net income row, and the wide-table zone with a held first column).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, Select, SideSheet,
  downloadCsv, mlabel, mshort, pct, usd, usdk,
} from '../design-system/parts';

type LineItem = { key: string; label: string; section: string; isTotal?: boolean; parentKey?: string; depth?: number };
type PnlSnap = { fetchedAt: string; months: string[]; lineItems: LineItem[]; data: Record<string, Record<string, number>> };
type RangePreset = '3M' | '6M' | '12M' | '24M' | 'YTD' | 'ALL';

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
/** Accounting format, as the classic page: zero shows as a dash, negatives in parentheses. */
const money = (v: number) => (Math.abs(v) < 0.5 ? '—' : v < 0 ? `(${USD0.format(Math.abs(v))})` : USD0.format(v));
const shiftMonth = (iso: string, delta: number) => {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const mcol = (m: string) => `${mshort(m)} ’${m.slice(2, 4)}`;
const span = (a: string, b: string) => (a === b ? mlabel(a) : `${mlabel(a)} to ${mlabel(b)}`);
const signedPct = (v: number | null) => (v == null ? null : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`);
const shortAccount = (label: string) => { const s = label.replace(/^\d+\s+/, ''); return s.length > 13 ? `${s.slice(0, 12)}…` : s; };

// Section rows above each top-level block of the statement.
const GROUP_BEFORE: Record<string, string> = {
  total_income: 'Revenue',
  total_cogs: 'Cost of goods sold',
  total_expenses: 'Operating expenses',
  other_income_total: 'Other income and expenses',
};
const PRESETS: Array<[RangePreset, string]> = [['3M', '3 mo'], ['6M', '6 mo'], ['12M', '1 yr'], ['24M', '2 yr'], ['YTD', 'Year to date'], ['ALL', 'All']];

/** Marks the wide-table zone `.is-wide` while its table runs past it (behaviors.js does this in
 *  the showroom), so the first column holds and the rest scrolls. */
function useWideZone(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const t = el.querySelector('table');
      setWide(!!t && t.scrollWidth > el.clientWidth + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dep]);
  return { ref, wide };
}

type Sheet =
  | { kind: 'statement'; months: string[]; title: string }
  | { kind: 'ttm' }
  | { kind: 'account'; keys: string[]; title: string };

export default function ProfitLossDS() {
  const { data: pnlData, isLoading, error } = useSheetTab('pnl_by_month');
  const snap = pnlData as unknown as PnlSnap | undefined;
  const [preset, setPreset] = useState<RangePreset | 'CUSTOM'>('12M');
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // The three main sections open by default so the statement reads as a P&L; deeper
  // sub-accounts stay folded as on the classic page.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['total_income', 'total_cogs', 'total_expenses']));
  const toggle = useCallback((key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);

  // ---- the classic page's view maths, unchanged
  const view = useMemo(() => {
    if (!snap) return null;
    const s = snap;
    const allMonths = s.months;
    if (allMonths.length === 0) return null;
    let latestComplete = allMonths[0];
    for (let i = allMonths.length - 1; i >= 0; i--) {
      const m = allMonths[i];
      if ((s.data.total_income?.[m] ?? 0) > 0 && (s.data.subscription_revenue?.[m] ?? 0) > 0) { latestComplete = m; break; }
    }
    const partialMonths = allMonths.filter((m) => m > latestComplete && (s.data.total_income?.[m] ?? 0) > 0);

    let from: string;
    let to = latestComplete;
    switch (preset) {
      case '3M': from = shiftMonth(to, -2); break;
      case '6M': from = shiftMonth(to, -5); break;
      case '24M': from = shiftMonth(to, -23); break;
      case 'YTD': from = `${to.slice(0, 4)}-01`; break;
      case 'ALL': from = allMonths[0]; break;
      case 'CUSTOM': from = custom.from || shiftMonth(to, -11); to = custom.to || to; break;
      case '12M': default: from = shiftMonth(to, -11); break;
    }
    if (from < allMonths[0]) from = allMonths[0];
    const visibleMonths = allMonths.filter((m) => m >= from && m <= to);

    const ttmMonths: string[] = [];
    for (let i = 11; i >= 0; i--) ttmMonths.push(shiftMonth(latestComplete, -i));
    const priorTtmMonths = ttmMonths.map((m) => shiftMonth(m, -12));
    const sumOver = (key: string, list: string[]) => list.reduce((acc, m) => acc + (s.data[key]?.[m] ?? 0), 0);
    const ttmRevenue = sumOver('total_income', ttmMonths);
    const priorTtmRevenue = sumOver('total_income', priorTtmMonths);
    const ttmGrossProfit = sumOver('gross_profit', ttmMonths);
    const ttmNetOp = sumOver('net_op_income', ttmMonths);
    const latestRevenue = s.data.total_income?.[latestComplete] ?? 0;
    const yoyMonth = shiftMonth(latestComplete, -12);
    const yoyRevenue = s.data.total_income?.[yoyMonth] ?? 0;
    return {
      allMonths, visibleMonths, from, to, latestComplete, partialMonths, ttmMonths, priorTtmMonths, yoyMonth,
      ttmRevenue, priorTtmRevenue,
      ttmRevenueDelta: priorTtmRevenue > 0 ? (ttmRevenue - priorTtmRevenue) / priorTtmRevenue : null,
      ttmGrossProfit, ttmGrossMargin: ttmRevenue > 0 ? ttmGrossProfit / ttmRevenue : null,
      ttmNetOp, ttmNetOpMargin: ttmRevenue > 0 ? ttmNetOp / ttmRevenue : null,
      ttmNetIncome: sumOver('net_income', ttmMonths),
      latestRevenue, yoyRevenue, yoyDelta: yoyRevenue > 0 ? (latestRevenue - yoyRevenue) / yoyRevenue : null,
    };
  }, [snap, preset, custom]);

  // ---- the account tree (snapshot order)
  const tree = useMemo(() => {
    const children = new Map<string, LineItem[]>();
    const top: LineItem[] = [];
    for (const li of snap?.lineItems ?? []) {
      if (li.parentKey) { const a = children.get(li.parentKey) ?? []; a.push(li); children.set(li.parentKey, a); } else top.push(li);
    }
    return { children, top };
  }, [snap]);

  const cols = view?.visibleMonths ?? [];
  const zone = useWideZone(cols.length);

  if (isLoading || !snap || !view) {
    return (
      <DsPage path="/profit-loss" title="Profit & Loss" subtitle={error ? 'Could not load the P&L.' : 'Loading…'}>
        <p className="am-card__text">{error ? `Could not load pnl_by_month: ${String(error)}` : 'Loading the QuickBooks P&L…'}</p>
      </DsPage>
    );
  }

  const d = snap.data;
  const v = (key: string, m: string) => d[key]?.[m] ?? 0;
  const sum = (key: string, months: string[]) => months.reduce((a, m) => a + v(key, m), 0);
  // A row "has data" if any of the months is non-zero on itself or a descendant (classic rule).
  const hasData = (key: string, months: string[]): boolean =>
    months.some((m) => Math.abs(v(key, m)) >= 0.5) || (tree.children.get(key) ?? []).some((c) => hasData(c.key, months));
  // Children above their parent subtotal when open, as QuickBooks prints them.
  const flatten = (li: LineItem, depth: number, months: string[], isOpen: (k: string) => boolean): Array<{ li: LineItem; depth: number }> => {
    if (!hasData(li.key, months)) return [];
    const kids = tree.children.get(li.key) ?? [];
    const out: Array<{ li: LineItem; depth: number }> = [];
    if (kids.length && isOpen(li.key)) for (const c of kids) out.push(...flatten(c, depth + 1, months, isOpen));
    out.push({ li, depth });
    return out;
  };

  const expandable = snap.lineItems.filter((li) => (tree.children.get(li.key) ?? []).length > 0 && hasData(li.key, cols)).map((li) => li.key);
  const allExpanded = expandable.length > 0 && expandable.every((k) => expanded.has(k));
  const latest = view.latestComplete;
  const ttmText = span(view.ttmMonths[0], view.ttmMonths[11]);
  const priorTtmText = span(view.priorTtmMonths[0], view.priorTtmMonths[11]);
  const rangeText = cols.length ? span(cols[0], cols[cols.length - 1]) : '';
  const ytd = preset === 'YTD' ? ` (year to date, ${rangeText})` : '';
  const margin = (num: string, m: string) => { const den = v('total_income', m); return den > 0 ? v(num, m) / den : null; };
  const marginAvg = (num: string) => { const vals = cols.map((m) => margin(num, m)).filter((x): x is number => x != null); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; };

  // ---- CSV (the classic export's columns; the classic file left the month cells empty,
  // this one fills them with the amounts that were meant to be there)
  const exportCsv = () => downloadCsv(`pnl_${view.from}_to_${view.to}`, ['Account', 'Section', ...cols, 'Total'],
    snap.lineItems.filter((li) => hasData(li.key, cols)).map((li) => [li.label, li.section, ...cols.map((m) => v(li.key, m)), sum(li.key, cols)]));

  // ---- statement body
  const nCols = cols.length + 2;
  const body: ReactNode[] = [];
  const marginRow = (key: string, label: string, num: string) => (
    <tr key={key}>
      <td><span style={{ paddingLeft: 28 }} className="am-card__text">{label}</span></td>
      {cols.map((m) => <td key={m} className="am-table__num">{pct(margin(num, m))}</td>)}
      <td className="am-table__num">{pct(marginAvg(num))}</td>
    </tr>
  );
  for (const top of tree.top) {
    if (top.key === 'net_income') continue; // the Net income row is the statement's foot
    const rows = flatten(top, 0, cols, (k) => expanded.has(k));
    if (!rows.length) continue;
    if (GROUP_BEFORE[top.key]) {
      body.push(<tr key={`g-${top.key}`} className="am-table__group"><th colSpan={nCols} scope="colgroup"><span className="am-table__group-tag">{GROUP_BEFORE[top.key]}</span></th></tr>);
    }
    for (const { li, depth } of rows) {
      const kids = (tree.children.get(li.key) ?? []).length > 0;
      const strong = !!li.isTotal;
      const wrap = (x: ReactNode) => (strong ? <span className="am-table__group-name">{x}</span> : x);
      const total = sum(li.key, cols);
      body.push(
        <tr key={li.key}>
          <td style={{ whiteSpace: 'nowrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', paddingLeft: depth * 20 }}>
              {kids ? (
                <button className="am-btn am-btn--text" aria-expanded={expanded.has(li.key)} onClick={() => toggle(li.key)}
                  aria-label={`${expanded.has(li.key) ? 'Fold' : 'Open'} ${li.label}`}>
                  <Icon name={expanded.has(li.key) ? 'arrow_drop_down' : 'arrow_right'} />{wrap(li.label)}
                </button>
              ) : <span style={{ paddingLeft: 28 }}>{wrap(li.label)}</span>}
            </span>
          </td>
          {cols.map((m) => <td key={m} className="am-table__num" style={{ whiteSpace: 'nowrap' }}>{wrap(money(v(li.key, m)))}</td>)}
          <td className="am-table__num" style={{ whiteSpace: 'nowrap' }}>{wrap(money(total))}</td>
        </tr>,
      );
    }
    if (top.key === 'gross_profit') body.push(marginRow('m-gross', 'Gross margin', 'gross_profit'));
    if (top.key === 'net_op_income') body.push(marginRow('m-op', 'Operating margin', 'net_op_income'));
  }
  body.push(marginRow('m-net', 'Net margin', 'net_income'));

  // ---- operating expenses by account (range), biggest first, the rest folded into one bar
  const opex = (tree.children.get('total_expenses') ?? [])
    .map((li) => ({ key: li.key, label: li.label, total: sum(li.key, cols) }))
    .filter((x) => Math.abs(x.total) >= 0.5)
    .sort((a, b) => b.total - a.total);
  const TOP = 11;
  const opexBars = opex.length > TOP + 1
    ? [...opex.slice(0, TOP), { key: '__rest', label: `All other (${opex.length - TOP} accounts)`, total: opex.slice(TOP).reduce((a, x) => a + x.total, 0) }]
    : opex;
  const opexTotal = sum('total_expenses', cols);

  // ---- side sheets
  const renderSheet = () => {
    if (!sheet) return null;
    if (sheet.kind === 'ttm') {
      const ms = [...view.ttmMonths].reverse();
      return (
        <SideSheet open onClose={() => setSheet(null)} title={`Last 12 complete months · ${ttmText}`}
          text="The months behind the trailing-12 cards. QuickBooks sync is not configured, so the window ends at the last export.">
          <DataTable label="Trailing 12 months"
            cols={[['Month', false], ['Revenue', true], ['Gross profit', true], ['Gross margin', true], ['Net operating income', true], ['Net income', true]]}
            rows={ms.map((m) => [mlabel(m), money(v('total_income', m)), money(v('gross_profit', m)), pct(margin('gross_profit', m)), money(v('net_op_income', m)), money(v('net_income', m))])}
            sortValues={ms.map((m) => [m, v('total_income', m), v('gross_profit', m), margin('gross_profit', m), v('net_op_income', m), v('net_income', m)])}
            foot={[`Total · 12 months`, money(view.ttmRevenue), money(view.ttmGrossProfit), pct(view.ttmGrossMargin), money(view.ttmNetOp), money(view.ttmNetIncome)]} />
        </SideSheet>
      );
    }
    if (sheet.kind === 'statement') {
      const ms = sheet.months;
      const rows = tree.top.filter((t) => t.key !== 'net_income').flatMap((t) => flatten(t, 0, ms, () => true));
      return (
        <SideSheet open onClose={() => setSheet(null)} title={sheet.title}
          text={ms.length > 1 ? `Every account summed over ${span(ms[0], ms[ms.length - 1])} (${ms.length} months).` : 'Every account with activity this month, sub-accounts above the subtotal they roll into.'}>
          <DataTable label={sheet.title} cols={[['Account', false], [ms.length > 1 ? 'Total' : 'Amount', true]]}
            rows={rows.map(({ li, depth }) => [
              <span key="l" style={{ paddingLeft: depth * 16 }}>{li.isTotal ? <span className="am-table__group-name">{li.label}</span> : li.label}</span>,
              li.isTotal ? <span key="v" className="am-table__group-name">{money(sum(li.key, ms))}</span> : money(sum(li.key, ms)),
            ])}
            foot={['Net income', money(sum('net_income', ms))]} />
        </SideSheet>
      );
    }
    // account (or the folded "all other" accounts): month by month, with its sub-accounts
    const keys = sheet.keys;
    const ms = [...cols].reverse();
    const one = keys.length === 1;
    const subs = one ? (tree.children.get(keys[0]) ?? []).filter((c) => hasData(c.key, cols)) : [];
    return (
      <SideSheet open onClose={() => setSheet(null)} title={sheet.title} text={`${rangeText} · ${cols.length} months, newest first.`}>
        {one ? (
          <DataTable label={`${sheet.title} by month`} cols={[['Month', false], ['Amount', true]]}
            rows={ms.map((m) => [mlabel(m), money(v(keys[0], m))])}
            sortValues={ms.map((m) => [m, v(keys[0], m)])}
            foot={[`Total · ${cols.length} months`, money(sum(keys[0], cols))]} />
        ) : null}
        {(one ? subs : keys.map((k) => snap.lineItems.find((li) => li.key === k)!)).length > 0 && (() => {
          const list = one ? subs : keys.map((k) => snap.lineItems.find((li) => li.key === k)!);
          return (
            <DataTable label="Accounts" cols={[[one ? 'Sub-account' : 'Account', false], ['Total', true], ['Share', true]]}
              rows={list.map((li) => [li.label, money(sum(li.key, cols)), pct(opexTotal ? sum(li.key, cols) / opexTotal : null)])}
              sortValues={list.map((li) => [li.label, sum(li.key, cols), opexTotal ? sum(li.key, cols) / opexTotal : null])}
              defaultSort={{ col: 1, dir: 'desc' }}
              foot={['Total', money(list.reduce((a, li) => a + sum(li.key, cols), 0)), pct(opexTotal ? list.reduce((a, li) => a + sum(li.key, cols), 0) / opexTotal : null)]} />
          );
        })()}
      </SideSheet>
    );
  };

  const presetLabel = (p: RangePreset) => (p === 'YTD' ? `Year to date (${latest.slice(0, 4)})` : PRESETS.find(([k]) => k === p)![1]);
  const selectable = view.allMonths.filter((m) => m <= latest).reverse().map((m) => [m, mlabel(m)] as [string, string]);

  return (
    <DsPage
      path="/profit-loss"
      title="Profit & Loss"
      subtitle={`QuickBooks Profit & Loss export · data through ${mlabel(latest)} · QuickBooks sync is not configured, so months after ${mlabel(latest)} are not in yet · source updated ${new Date(snap.fetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`}
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv}><Icon name="download" />Export CSV</button>}
      overlays={renderSheet()}
    >
      {view.partialMonths.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--warning">Still posting</span>
            <span className="am-card__text">
              QuickBooks data is still posting for {view.partialMonths.map(mlabel).join(', ')}: revenue lines may be incomplete or booked under Stripe Fee Income while the close is in progress. The latest complete month is {mlabel(latest)}; the cards use that.
            </span>
          </div>
        </section>
      )}

      <KpiGrid>
        <KpiCard label={`Revenue · ${mlabel(latest)}`} value={USD0.format(view.latestRevenue)}
          hint={view.yoyDelta != null ? `${mlabel(view.yoyMonth)}: ${USD0.format(view.yoyRevenue)}` : 'No prior-year comparison'}
          tag={view.yoyDelta != null ? `${signedPct(view.yoyDelta)} vs ${mlabel(view.yoyMonth)}` : undefined}
          tagTone={view.yoyDelta == null ? undefined : view.yoyDelta >= 0 ? 'success' : 'warning'}
          onOpen={() => setSheet({ kind: 'statement', months: [latest], title: `P&L · ${mlabel(latest)}` })} />
        <KpiCard label={`Revenue · ${ttmText}`} value={USD0.format(view.ttmRevenue)}
          hint={`Prior 12 months (${priorTtmText}): ${USD0.format(view.priorTtmRevenue)}`}
          tag={view.ttmRevenueDelta != null ? `${signedPct(view.ttmRevenueDelta)} vs prior 12 months` : undefined}
          tagTone={view.ttmRevenueDelta == null ? undefined : view.ttmRevenueDelta >= 0 ? 'success' : 'warning'}
          onOpen={() => setSheet({ kind: 'ttm' })} />
        <KpiCard label={`Gross margin · ${ttmText}`} value={pct(view.ttmGrossMargin)}
          hint={`Gross profit ${USD0.format(view.ttmGrossProfit)} on ${USD0.format(view.ttmRevenue)} revenue`}
          onOpen={() => setSheet({ kind: 'ttm' })} />
        <KpiCard label={`Net operating income · ${ttmText}`} value={USD0.format(view.ttmNetOp)}
          hint={`Operating margin ${pct(view.ttmNetOpMargin)}`}
          tag={view.ttmNetOp >= 0 ? 'Profitable' : 'Operating loss'} tagTone={view.ttmNetOp >= 0 ? 'success' : 'error'}
          onOpen={() => setSheet({ kind: 'ttm' })} />
        <KpiCard label={`Net income · ${ttmText}`} value={USD0.format(view.ttmNetIncome)}
          hint="After other income and expenses"
          onOpen={() => setSheet({ kind: 'statement', months: view.ttmMonths, title: `P&L · ${ttmText}` })} />
      </KpiGrid>

      <div className="am-row am-row--wrap">
        <Segmented label="Range" value={preset === 'CUSTOM' ? null : preset} onChange={setPreset}
          options={PRESETS.map(([k]) => [k, presetLabel(k)] as [RangePreset, string])} />
        {(['From', 'To'] as const).map((w) => (
          <div key={w} className="am-row am-row--tight">
            <span className="am-card__text">{w}</span>
            <Select label={`${w} month`} value={w === 'From' ? view.from : view.to} options={selectable}
              onPick={(m) => {
                const cur = { from: view.from, to: view.to };
                const next = w === 'From' ? { from: m, to: m > cur.to ? m : cur.to } : { to: m, from: m < cur.from ? m : cur.from };
                setCustom(next);
                setPreset('CUSTOM');
              }} />
          </div>
        ))}
      </div>

      <ChartCard title="Revenue, gross profit and operating income by month" caption={`${rangeText}${ytd} · complete months only · hover a month for its margins`}>
        <ColumnChart months={cols} grouped legend fmt={usdk}
          series={[
            { key: 'rev', label: 'Revenue', tone: 'div-1', values: cols.map((m) => v('total_income', m)) },
            { key: 'gp', label: 'Gross profit', tone: 'div-2', values: cols.map((m) => v('gross_profit', m)) },
            { key: 'noi', label: 'Net operating income', tone: 'other', values: cols.map((m) => v('net_op_income', m)) },
          ]}
          labelFor={(i) => usdk(v('total_income', cols[i]))}
          tipRows={(i) => { const m = cols[i]; return [
            ['Revenue', usd(v('total_income', m))], ['Gross profit', `${usd(v('gross_profit', m))} (${pct(margin('gross_profit', m))})`],
            ['Net operating income', `${usd(v('net_op_income', m))} (${pct(margin('net_op_income', m))})`], ['Net income', usd(v('net_income', m))],
          ]; }}
          onSegment={(i) => setSheet({ kind: 'statement', months: [cols[i]], title: `P&L · ${mlabel(cols[i])}` })}
          aria={`Monthly revenue, gross profit and net operating income, ${rangeText}.`} />
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Monthly P&L · {rangeText}{ytd}</span>
            <span className="am-chart__caption">
              Oldest to newest, left to right · negatives in (parentheses), zero as a dash · margin rows' Total column is the average of the monthly margins · select a Net income figure for that month's full statement
            </span>
          </div>
          <button className="am-btn am-btn--text" onClick={() => setExpanded(allExpanded ? new Set() : new Set(expandable))}>
            <Icon name={allExpanded ? 'unfold_less' : 'unfold_more'} />{allExpanded ? 'Fold all' : 'Open all'}
          </button>
        </div>
        <div ref={zone.ref} className={`am-table__zone${zone.wide ? ' is-wide' : ''}`}>
          <div className="am-massgrid__scroller">
            <div className="am-table-shell">
              <table className="am-table" aria-label={`Monthly P&L, ${rangeText}`}>
                <thead>
                  <tr>
                    <th>Account</th>
                    {cols.map((m) => <th key={m} className="am-table__num" style={{ whiteSpace: 'nowrap' }}>{mcol(m)}</th>)}
                    <th className="am-table__num">Total</th>
                  </tr>
                </thead>
                <tbody>{body}</tbody>
                <tfoot>
                  <tr>
                    <td>Net income</td>
                    {cols.map((m) => (
                      <td key={m} className="am-table__num" style={{ whiteSpace: 'nowrap' }}>
                        <button className="am-btn am-btn--text" onClick={() => setSheet({ kind: 'statement', months: [m], title: `P&L · ${mlabel(m)}` })}>{money(v('net_income', m))}</button>
                      </td>
                    ))}
                    <td className="am-table__num" style={{ whiteSpace: 'nowrap' }}>
                      <button className="am-btn am-btn--text" onClick={() => setSheet({ kind: 'statement', months: cols, title: `P&L · ${rangeText}` })}>{money(sum('net_income', cols))}</button>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-tag am-tag--neutral">{cols.length} months</span>
          <span className="am-tag am-tag--neutral">{snap.lineItems.length} accounts</span>
          <span className="am-tag am-tag--neutral">Source updated {new Date(snap.fetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
        </div>
        <p className="am-card__text">Source: the QuickBooks Profit & Loss export (Allmoxy+LLC_Profit+and+Loss.xlsx); categories map one to one from the QuickBooks chart of accounts.</p>
      </section>

      {opexBars.length > 0 && (
        <ChartCard title={`Operating expenses by account · ${rangeText}${ytd}`} caption={`${usd(opexTotal)} in total operating expenses · biggest first · select a bar for its months and sub-accounts`}>
          <ColumnChart months={opexBars.map((x) => x.key)} series={[{ key: 'opex', label: 'Spend', tone: 'div-1', values: opexBars.map((x) => x.total) }]} fmt={usdk}
            catLabel={(k) => (k === '__rest' ? 'All other' : shortAccount(opexBars.find((x) => x.key === k)!.label))}
            catTitle={(k) => opexBars.find((x) => x.key === k)!.label}
            tipRows={(i) => [['Spend', usd(opexBars[i].total)], ['Share of operating expenses', pct(opexTotal ? opexBars[i].total / opexTotal : null)]]}
            onSegment={(i) => {
              const b = opexBars[i];
              setSheet(b.key === '__rest'
                ? { kind: 'account', keys: opex.slice(TOP).map((x) => x.key), title: `Other operating expenses · ${rangeText}` }
                : { kind: 'account', keys: [b.key], title: `${b.label} · ${rangeText}` });
            }}
            aria={`Operating expenses by account, ${rangeText}.`} />
        </ChartCard>
      )}
    </DsPage>
  );
}
