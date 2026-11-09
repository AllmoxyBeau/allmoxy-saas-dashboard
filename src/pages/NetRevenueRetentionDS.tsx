/**
 * Net Revenue Retention on the Allmoxy design system. Data logic is the classic page's
 * (NetRevenueRetention.tsx, kept at /net-revenue-retention-classic):
 *   - THE retention figures (canonical, used everywhere): mrr_waterfall.ttm_accrual.
 *   - The cohort view: every customer billing at the window start, followed to the anchor
 *     month (subscription_by_month), with its expansion / contraction / churn breakdown and
 *     the customers behind each.
 * Colors follow the Revenue Waterfall: NRR blue (div-1), GRR green (div-2).
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, Segmented,
  downloadCsv, mlabel, pct, usd,
} from '../design-system/parts';

type SubRow = { customer_name: string } & Record<string, number | string | null>;
type SubSnap = { columns: string[]; rows: SubRow[] };
type Canon = { windowStart: string; windowEnd: string; annual_nrr: number; annual_grr: number };
type Anchor = {
  month: string; windowStart: string; cohort: number; starting: number; ending: number;
  expansion: number; contraction: number; churn: number; churnN: number; expandN: number; contractN: number;
  nrr: number | null; grr: number | null;
};
type Mover = { name: string; start: number; end: number; delta: number };

const v = (r: SubRow, m: string) => { const x = r[m]; return typeof x === 'number' && isFinite(x) && x > 0 ? x : 0; };
function anchorAt(rows: SubRow[], months: string[], i: number, n: number): Anchor | null {
  if (i < n) return null;
  const end = months[i], start = months[i - n];
  const a: Anchor = { month: end, windowStart: start, cohort: 0, starting: 0, ending: 0, expansion: 0, contraction: 0, churn: 0, churnN: 0, expandN: 0, contractN: 0, nrr: null, grr: null };
  for (const r of rows) {
    const s = v(r, start); if (s <= 0) continue;
    const e = v(r, end);
    a.cohort++; a.starting += s; a.ending += e;
    if (e === 0) { a.churn += s; a.churnN++; } else if (e > s) { a.expansion += e - s; a.expandN++; } else if (e < s) { a.contraction += s - e; a.contractN++; }
  }
  a.nrr = a.starting > 0 ? a.ending / a.starting : null;
  a.grr = a.starting > 0 ? (a.ending - a.expansion) / a.starting : null;
  return a;
}
const tone = (x: number | null, good: number, ok: number) => (x == null ? undefined : x >= good ? 'success' as const : x >= ok ? 'warning' as const : 'error' as const);
const word = (x: number | null, good: number, ok: number) => (x == null ? undefined : x >= good ? 'On target' : x >= ok ? 'Watch' : 'Below target');

function MoverCard({ title, caption, rows, csv }: { title: string; caption: string; rows: Mover[]; csv: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 10);
  return (
    <section className="am-card am-card--outlined">
      <div className="am-row am-row--spread">
        <div className="am-chart__head">
          <span className="am-chart__title">{title}</span>
          <span className="am-chart__caption">{caption}</span>
        </div>
        <button className="am-btn am-btn--text" onClick={() => downloadCsv(csv, ['Customer', 'MRR at window start', 'MRR at anchor month', 'Change'], rows.map((m) => [m.name, m.start, m.end, m.delta]))}>
          <Icon name="download" />CSV
        </button>
      </div>
      {rows.length ? <DataTable label={title} cols={[['Customer', false], ['Start', true], ['Now', true], ['Change', true]]}
        rows={shown.map((m) => [m.name, usd(m.start), usd(m.end), `${m.delta >= 0 ? '+' : '−'}${usd(Math.abs(m.delta))}`])} />
        : <p className="am-card__text">None in this window.</p>}
      {rows.length > 10 && <button className="am-btn am-btn--text" onClick={() => setAll(!all)}>{all ? 'Show top 10' : `Show all ${rows.length}`}</button>}
    </section>
  );
}

export default function NetRevenueRetentionDS() {
  const { data: subData, isLoading, error } = useSheetTab('subscription_by_month');
  const { data: ueData } = useSheetTab('unit_economics');
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const sub = subData as unknown as SubSnap | undefined;
  const canon = (wfData as unknown as { ttm_accrual?: Canon } | undefined)?.ttm_accrual;
  const ueEnd = (ueData as unknown as { ttm?: { windowEnd?: string } } | undefined)?.ttm?.windowEnd;
  const [n, setN] = useState<'3' | '6' | '12'>('12');
  const [history, setHistory] = useState<'24' | '36' | '60' | 'all'>('60');

  const months = useMemo(() => (sub?.columns ?? []).filter((c) => /^\d{4}-\d{2}$/.test(c)).sort(), [sub]);
  // Anchor at the latest complete month so the partial current month can't drag NRR down.
  const lastIdx = useMemo(() => {
    if (!months.length) return -1;
    return ueEnd && months.includes(ueEnd) ? months.indexOf(ueEnd) : months.length - 2;
  }, [months, ueEnd]);
  const series = useMemo(() => {
    if (!sub || lastIdx < 0) return [] as Anchor[];
    const out: Anchor[] = [];
    for (let i = Number(n); i <= lastIdx; i++) { const a = anchorAt(sub.rows, months, i, Number(n)); if (a) out.push(a); }
    return out;
  }, [sub, months, lastIdx, n]);
  const visible = history === 'all' ? series : series.slice(-Number(history));
  const latest = series[series.length - 1] ?? null;

  const movers = useMemo(() => {
    if (!sub || !latest) return null;
    const expand: Mover[] = [], contract: Mover[] = [], churn: Mover[] = [];
    for (const r of sub.rows) {
      const s = v(r, latest.windowStart); if (s <= 0) continue;
      const e = v(r, latest.month); const name = String(r.customer_name);
      if (e === 0) churn.push({ name, start: s, end: 0, delta: -s });
      else if (e > s) expand.push({ name, start: s, end: e, delta: e - s });
      else if (e < s) contract.push({ name, start: s, end: e, delta: e - s });
    }
    expand.sort((a, b) => b.delta - a.delta); contract.sort((a, b) => a.delta - b.delta); churn.sort((a, b) => a.delta - b.delta);
    return { expand, contract, churn };
  }, [sub, latest]);

  const windowText = latest ? `${mlabel(latest.windowStart)} to ${mlabel(latest.month)}` : '';
  const tableRows = [...visible].reverse();

  return (
    <DsPage
      path="/net-revenue-retention"
      title="Net Revenue Retention"
      subtitle="Of the MRR existing customers paid at the start of a window, how much they pay now · the retention figure buyers look at first"
      actions={
        <button className="am-btn am-btn--outlined" onClick={() => downloadCsv(`nrr_by_anchor_${n}m`,
          ['Anchor month', 'Window start', 'Cohort customers', 'Starting MRR', 'Ending MRR', 'Expansion', 'Contraction', 'Churn', 'Churned customers', 'NRR', 'GRR'],
          series.map((a) => [a.month, a.windowStart, a.cohort, a.starting, a.ending, a.expansion, a.contraction, a.churn, a.churnN, a.nrr ?? '', a.grr ?? '']))}>
          <Icon name="download" />Export series
        </button>
      }
    >
      {error ? <p className="am-card__text">Could not load the subscription series: {String(error)}</p> : null}

      <div className="am-chart__head">
        <span className="am-chart__title">The retention figure</span>
        <span className="am-chart__caption">{canon ? `Trailing 12 complete months, ${mlabel(canon.windowStart)} to ${mlabel(canon.windowEnd)}, on the invoiced basis. The same figure appears on every page and feeds LTV.` : 'Loading…'}</span>
      </div>
      <div className="am-grid" style={{ ['--am-grid-min' as string]: '300px' }}>
        {canon && <>
          <KpiCard label="Net revenue retention · 12 mo" value={pct(canon.annual_nrr)} hint="Target 110% or more. Above 100% means existing customers grow on their own."
            tag={word(canon.annual_nrr, 1.1, 0.9)} tagTone={tone(canon.annual_nrr, 1.1, 0.9)} />
          <KpiCard label="Gross revenue retention · 12 mo" value={pct(canon.annual_grr)} hint={`Target 90% or more. Gross revenue churn = 1 − GRR = ${pct(1 - canon.annual_grr)}, which feeds LTV.`}
            tag={word(canon.annual_grr, 0.9, 0.8)} tagTone={tone(canon.annual_grr, 0.9, 0.8)} />
        </>}
      </div>

      <div className="am-chart__head">
        <span className="am-chart__title">Cohort view</span>
        <span className="am-chart__caption">{latest ? `Every customer billing at the start of the window, followed to ${mlabel(latest.month)}: ${latest.cohort} customers, ${windowText}. Point to point, so it moves more than the figure above.` : 'Loading…'}</span>
      </div>
      <div className="am-row am-row--wrap">
        <span className="am-card__text">Look-back</span>
        <Segmented label="Look-back" value={n} onChange={setN} options={[['3', '3 mo'], ['6', '6 mo'], ['12', '12 mo']]} />
      </div>
      <div className="am-grid" style={{ ['--am-grid-min' as string]: '260px' }}>
        {latest && !isLoading && <>
          <KpiCard label={`Cohort NRR · ${n} mo`} value={pct(latest.nrr)} hint={`${usd(latest.starting)} → ${usd(latest.ending)}`} tag={word(latest.nrr, 1.1, 0.9)} tagTone={tone(latest.nrr, 1.1, 0.9)} />
          <KpiCard label={`Cohort GRR · ${n} mo`} value={pct(latest.grr)} hint="Kept revenue, before any expansion" tag={word(latest.grr, 0.9, 0.8)} tagTone={tone(latest.grr, 0.9, 0.8)} />
          <KpiCard label={`Expansion · ${n} mo`} value={`+${usd(latest.expansion)}`} hint={`${latest.expandN} customers grew`} />
          <KpiCard label={`Contraction · ${n} mo`} value={`−${usd(latest.contraction)}`} hint={`${latest.contractN} customers shrank`} />
          <KpiCard label={`Churn · ${n} mo`} value={`−${usd(latest.churn)}`} hint={`${latest.churnN} customers left entirely`} />
        </>}
      </div>

      <ChartCard title="Cohort NRR and GRR by anchor month" caption={`Each month's cohort, measured over a ${n}-month look-back`}>
        <Segmented label="History" value={history} onChange={setHistory} options={[['24', '2 yr'], ['36', '3 yr'], ['60', '5 yr'], ['all', 'All']]} />
        <ColumnChart months={visible.map((a) => a.month)} grouped legend fmt={(x) => `${Math.round(x * 100)}%`}
          series={[
            { key: 'nrr', label: 'NRR', tone: 'div-1', values: visible.map((a) => a.nrr ?? 0) },
            { key: 'grr', label: 'GRR', tone: 'div-2', values: visible.map((a) => a.grr ?? 0) },
          ]}
          tipRows={(i) => { const a = visible[i]; return a ? [['NRR', pct(a.nrr)], ['GRR', pct(a.grr)], ['Cohort', `${a.cohort} customers`], ['Window', `${mlabel(a.windowStart)} to ${mlabel(a.month)}`]] : []; }}
          aria={`Cohort NRR and GRR by anchor month, ${n}-month look-back.`} />
      </ChartCard>

      {movers && <>
        <MoverCard title="Grew" caption={`Customers billing more in ${latest ? mlabel(latest.month) : ''} than at the window start`} rows={movers.expand} csv={`nrr_expansion_${n}m`} />
        <MoverCard title="Shrank" caption="Still billing, but less" rows={movers.contract} csv={`nrr_contraction_${n}m`} />
        <MoverCard title="Left" caption="Billing at the window start, nothing now" rows={movers.churn} csv={`nrr_churn_${n}m`} />
      </>}

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Retention by anchor month</span>
          <span className="am-chart__caption">Newest first</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Retention by anchor month"
            cols={[['Anchor month', false], ['Window start', false], ['Cohort', true], ['Starting', true], ['Ending', true], ['Expansion', true], ['Contraction', true], ['Churn', true], ['NRR', true], ['GRR', true]]}
            rows={tableRows.map((a) => [mlabel(a.month), mlabel(a.windowStart), a.cohort.toLocaleString(), usd(a.starting), usd(a.ending), `+${usd(a.expansion)}`, `−${usd(a.contraction)}`, `−${usd(a.churn)}`, pct(a.nrr), pct(a.grr)])} />
        </div>
      </section>
    </DsPage>
  );
}
