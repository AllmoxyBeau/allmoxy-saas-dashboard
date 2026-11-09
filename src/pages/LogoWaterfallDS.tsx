/**
 * Logo Waterfall on the Allmoxy design system: the Revenue Waterfall's shape counting paying
 * customers instead of dollars. Assembled from the shared certified parts; data logic is the
 * classic page's (LogoWaterfall.tsx, kept at /logo-waterfall-classic): customer_base.logo_flow,
 * which balances by construction (starting + new + reactivated + recovered − churned − lapsed
 * − paused = ending) and follows the churn rule (churn_rules.mjs).
 *
 * Chart stacks on the diverging ramp, matching the Revenue Waterfall: New (div-1), Returning
 * (reactivated + recovered, div-2), Not yet churned (lapsed + paused, div-3), Churned (div-5).
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, Segmented, SideSheet,
  downloadCsv, mlabel, pct, usd, useMonthRange,
} from '../design-system/parts';

type Who = { allmoxy_customer_id: number; name: string; mrr?: number; status?: string | null };
type Flow = {
  month: string; starting_logos: number; ending_logos: number; net_new_logos: number;
  new_logos: number; reactivated_logos: number; recovered_logos?: number;
  churned_logos: number; lapsed_logos: number; paused_logos?: number; gross_logo_churn: number | null;
  details?: Partial<Record<'new' | 'reactivated' | 'recovered' | 'churned' | 'lapsed' | 'paused', Who[]>>;
};
type Bucket = 'new' | 'reactivated' | 'recovered' | 'churned' | 'lapsed' | 'paused';
const BUCKETS: Array<{ k: Bucket; label: string; sign: 1 | -1; field: keyof Flow }> = [
  { k: 'new', label: 'New', sign: 1, field: 'new_logos' },
  { k: 'reactivated', label: 'Reactivated', sign: 1, field: 'reactivated_logos' },
  { k: 'recovered', label: 'Recovered', sign: 1, field: 'recovered_logos' },
  { k: 'churned', label: 'Churned', sign: -1, field: 'churned_logos' },
  { k: 'lapsed', label: 'Lapsed', sign: -1, field: 'lapsed_logos' },
  { k: 'paused', label: 'Paused', sign: -1, field: 'paused_logos' },
];
const val = (r: Flow, b: Bucket) => Number(r[BUCKETS.find((x) => x.k === b)!.field] ?? 0);
const STACKS: Array<{ key: string; label: string; tone: string; parts: Bucket[]; sign: 1 | -1 }> = [
  { key: 'new', label: 'New', tone: 'div-1', parts: ['new'], sign: 1 },
  { key: 'back', label: 'Returning', tone: 'div-2', parts: ['reactivated', 'recovered'], sign: 1 },
  { key: 'pending', label: 'Not yet churned', tone: 'div-3', parts: ['lapsed', 'paused'], sign: -1 },
  { key: 'churn', label: 'Churned', tone: 'div-5', parts: ['churned'], sign: -1 },
];
const signedN = (v: number) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString()}`);

export default function LogoWaterfallDS() {
  const { data: baseData, isLoading, error } = useSheetTab('customer_base');
  const flow = useMemo(() => ((baseData as unknown as { logo_flow?: Flow[] } | undefined)?.logo_flow ?? []), [baseData]);
  const byMonth = useMemo(() => new Map(flow.map((r) => [r.month, r])), [flow]);
  const [windowN, setWindowN] = useState<'3' | '6' | '12'>('12');
  const [drill, setDrill] = useState<{ month: string; buckets: Bucket[]; title: string } | null>(null);
  const range = useMonthRange(flow.map((r) => r.month));
  const visible = range.months.map((m) => byMonth.get(m)!).filter(Boolean);

  // Header cards: same maths as the classic page. Every departure counts as lost (churned +
  // lapsed); pauses leave the count but are not churn; recovered lapses come back.
  const stats = useMemo(() => {
    const N = Number(windowN);
    const rows = flow.slice(-N);
    if (!rows.length) return null;
    const s = Object.fromEntries(BUCKETS.map((b) => [b.k, rows.reduce((a, r) => a + val(r, b.k), 0)])) as Record<Bucket, number>;
    const starting = rows[0].starting_logos, ending = rows[rows.length - 1].ending_logos;
    const departed = s.churned + s.lapsed;
    return {
      start: rows[0].month, end: rows[rows.length - 1].month, starting, ending, s,
      net: s.new + s.reactivated + s.recovered - departed - s.paused,
      grossChurn: starting > 0 ? 1 - Math.pow(1 - departed / starting, 12 / N) : null,
      growth: starting > 0 ? Math.pow(ending / starting, 12 / N) - 1 : null,
      nrr: starting > 0 ? Math.pow((starting - departed - s.paused + s.reactivated + s.recovered) / starting, 12 / N) : null,
    };
  }, [flow, windowN]);

  const tone = (good: boolean, ok: boolean) => (good ? 'success' as const : ok ? 'warning' as const : 'error' as const);
  const word = (good: boolean, ok: boolean) => (good ? 'On target' : ok ? 'Watch' : 'Below target');

  const series = STACKS.map((st) => ({ key: st.key, label: st.label, tone: st.tone, values: visible.map((r) => st.sign * st.parts.reduce((a, b) => a + val(r, b), 0)) }));
  const tableRows = [...visible].reverse();
  const cols: Array<[string, boolean]> = [['Month', false], ['Starting', true], ...BUCKETS.map((b) => [`${b.sign > 0 ? '+' : '−'} ${b.label}`, true] as [string, boolean]), ['Net new', true], ['Ending', true], ['Gross churn (mo)', true]];

  const drillRows = (month: string, buckets: Bucket[]) => {
    const r = byMonth.get(month);
    if (!r) return [];
    return buckets.flatMap((b) => (r.details?.[b] ?? []).map((w) => [w.name, BUCKETS.find((x) => x.k === b)!.label, w.mrr != null ? usd(w.mrr) : '—']));
  };

  return (
    <DsPage
      path="/logo-waterfall"
      title="Logo Waterfall"
      subtitle={stats ? `${mlabel(stats.start)} to ${mlabel(stats.end)} · paying customers on the invoiced basis (the canonical customer base)` : 'Loading…'}
      actions={
        <button className="am-btn am-btn--outlined" onClick={() => downloadCsv(`logo_waterfall_${range.months[0] ?? ''}_to_${range.months[range.months.length - 1] ?? ''}`,
          ['Month', 'Starting', ...BUCKETS.map((b) => b.label), 'Net new', 'Ending', 'Gross churn (mo)'],
          tableRows.map((r) => [r.month, r.starting_logos, ...BUCKETS.map((b) => val(r, b.k)), r.net_new_logos, r.ending_logos, r.gross_logo_churn ?? '']))}>
          <Icon name="download" />Export CSV
        </button>
      }
      overlays={drill && (
        <SideSheet open onClose={() => setDrill(null)} title={`${drill.title} · ${mlabel(drill.month)}`}
          text={drill.buckets.some((b) => b === 'lapsed' || b === 'paused')
            ? 'Stopped billing but not churned: lapsed (under 3 months, may still pay) or paused (pause granted in HubSpot). Churn is confirmed by a cancelled Stripe subscription, HubSpot Cancelled, or 3 months unbilled.'
            : undefined}>
          {(() => {
            const rows = drillRows(drill.month, drill.buckets);
            return rows.length
              ? <DataTable cols={[['Customer', false], ['Movement', false], ['MRR', true]]} rows={rows} label={drill.title} />
              : <p className="am-card__text">No customers in this movement for the month.</p>;
          })()}
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Could not load the customer base: {String(error)}</p> : null}

      <div className="am-row am-row--wrap">
        <span className="am-card__text">Cards cover</span>
        <Segmented label="Cards cover" value={windowN} onChange={setWindowN} options={[['3', '3 mo'], ['6', '6 mo'], ['12', '12 mo']]} />
      </div>

      <div className="am-grid" style={{ ['--am-grid-min' as string]: '300px' }}>
        {stats && !isLoading && <>
          <KpiCard label={`Net new logos · ${windowN} mo`} value={signedN(stats.net)} hint={`${stats.starting} → ${stats.ending} customers`} />
          <KpiCard label={`Annualized logo growth · ${windowN} mo`} value={pct(stats.growth)} hint="Compounded growth in the customer count" />
          <KpiCard label={`Annualized gross churn · ${windowN} mo`} value={pct(stats.grossChurn)}
            hint={`${stats.s.churned} churned + ${stats.s.lapsed} lapsed of ${stats.starting}${stats.s.paused ? ` · ${stats.s.paused} paused, not counted` : ''}`}
            tag={stats.grossChurn == null ? undefined : word(stats.grossChurn <= 0.05, stats.grossChurn <= 0.12)}
            tagTone={stats.grossChurn == null ? undefined : tone(stats.grossChurn <= 0.05, stats.grossChurn <= 0.12)} />
          <KpiCard label={`Annualized logo NRR · ${windowN} mo`} value={pct(stats.nrr)} hint="Customers kept or returned, before new ones"
            tag={stats.nrr == null ? undefined : word(stats.nrr >= 1, stats.nrr >= 0.85)}
            tagTone={stats.nrr == null ? undefined : tone(stats.nrr >= 1, stats.nrr >= 0.85)} />
        </>}
      </div>
      <p className="am-card__text">Logo rates count customers, not dollars: a $200 account leaving weighs the same as a $7,000 one. Paused customers leave the count but are never churn.</p>

      <ChartCard title="Monthly customer movement" caption={`Customers gained above zero, lost below · the figure on each month is its net change · ${range.rangeText}`}>
        {range.controls}
        <ColumnChart months={range.months} series={series} fmt={(v) => Math.round(v).toLocaleString().replace('-', '−')} stacked legend
          labelFor={(i) => (visible[i] ? signedN(visible[i].net_new_logos) : null)}
          tipRows={(i) => {
            const r = visible[i];
            return r ? [...BUCKETS.filter((b) => val(r, b.k) !== 0).map((b) => [b.label, signedN(b.sign * val(r, b.k))] as [string, string]), ['Net', signedN(r.net_new_logos)], ['Ending', r.ending_logos.toLocaleString()]] : [];
          }}
          onSegment={(i, key) => { const st = STACKS.find((s) => s.key === key)!; setDrill({ month: range.months[i], buckets: st.parts, title: st.label }); }}
          aria={`Monthly customer movement, ${range.rangeText}.`} />
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Month by month</span>
          <span className="am-chart__caption">Newest first · select any movement to see the customers behind it</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Month-by-month customer movement" cols={cols}
            rows={tableRows.map((r) => [
              mlabel(r.month), r.starting_logos.toLocaleString(),
              ...BUCKETS.map((b) => (val(r, b.k) ? signedN(b.sign * val(r, b.k)) : '—')),
              signedN(r.net_new_logos), r.ending_logos.toLocaleString(), pct(r.gross_logo_churn),
            ])}
            clickable={(col) => col >= 2 && col < 2 + BUCKETS.length}
            onCell={(row, col) => { const b = BUCKETS[col - 2]; if (b) setDrill({ month: tableRows[row].month, buckets: [b.k], title: b.label }); }} />
        </div>
      </section>
    </DsPage>
  );
}
