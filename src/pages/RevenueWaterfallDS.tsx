/**
 * Revenue Waterfall on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (RevenueWaterfall.tsx, kept
 * at /revenue-waterfall-classic): same snapshots, same accrual/cash and QuickBooks/Stripe-txns
 * switches, same header maths (mean monthly rate ^12, exactly build_waterfall.summarize), and
 * the in-progress month never enters the cards.
 *
 * Chart: the nine movement buckets fold into five stacks so the diverging (good to bad) ramp
 * can carry them: New & returning, Expansion, Not yet churned (lapsed + voided + paused),
 * Contraction, Churn. The table, tooltips and drill-downs keep all nine.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, Segmented, SideSheet, Switch,
  downloadCsv, mlabel, pct, usd, usdk, useMonthRange,
} from '../design-system/parts';

type Named = { name: string; id?: number | null; mrr: number; status?: string | null; pay_status?: string | null };
type Change = { name: string; id?: number | null; prev_mrr: number; new_mrr: number; delta: number };
type Row = {
  month: string; partial?: boolean;
  starting_mrr: number; ending_mrr: number; net_new_mrr: number;
  new_mrr: number; reactivated_mrr?: number; recovered_mrr?: number; expansion_mrr: number;
  contraction_mrr: number; churn_mrr: number; delinquent_mrr?: number; voided_mrr?: number; paused_mrr?: number;
  grr_monthly: number | null; nrr_monthly: number | null; gross_churn_rate_monthly: number | null; quick_ratio: number | null;
  details: { new: Named[]; reactivated?: Named[]; recovered?: Named[]; expansion: Change[]; contraction: Change[]; churn: Named[]; delinquent?: Named[]; voided?: Named[]; paused?: Named[] };
};
type Snap = { monthly: Row[]; monthly_accrual?: Row[] | null; accrual_reliable_from?: string | null };

type Bucket = 'new' | 'reactivated' | 'recovered' | 'expansion' | 'contraction' | 'churn' | 'delinquent' | 'voided' | 'paused';
const BUCKETS: Array<{ k: Bucket; label: string; sign: 1 | -1; field: keyof Row }> = [
  { k: 'new', label: 'New', sign: 1, field: 'new_mrr' },
  { k: 'reactivated', label: 'Reactivated', sign: 1, field: 'reactivated_mrr' },
  { k: 'recovered', label: 'Recovered', sign: 1, field: 'recovered_mrr' },
  { k: 'expansion', label: 'Expansion', sign: 1, field: 'expansion_mrr' },
  { k: 'contraction', label: 'Contraction', sign: -1, field: 'contraction_mrr' },
  { k: 'churn', label: 'Churn', sign: -1, field: 'churn_mrr' },
  { k: 'delinquent', label: 'Lapsed', sign: -1, field: 'delinquent_mrr' },
  { k: 'voided', label: 'Voided', sign: -1, field: 'voided_mrr' },
  { k: 'paused', label: 'Paused', sign: -1, field: 'paused_mrr' },
];
const val = (r: Row, b: Bucket) => Number(r[BUCKETS.find((x) => x.k === b)!.field] ?? 0);
// The five chart stacks, drawn gains first (bottom up) then losses (top down).
const STACKS: Array<{ key: string; label: string; tone: string; parts: Bucket[]; sign: 1 | -1 }> = [
  { key: 'gain_new', label: 'New & returning', tone: 'div-1', parts: ['new', 'reactivated', 'recovered'], sign: 1 },
  { key: 'gain_exp', label: 'Expansion', tone: 'div-2', parts: ['expansion'], sign: 1 },
  { key: 'loss_pending', label: 'Not yet churned', tone: 'div-3', parts: ['delinquent', 'voided', 'paused'], sign: -1 },
  { key: 'loss_contr', label: 'Contraction', tone: 'div-4', parts: ['contraction'], sign: -1 },
  { key: 'loss_churn', label: 'Churn', tone: 'div-5', parts: ['churn'], sign: -1 },
];
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${usd(Math.abs(v))}`;

export default function RevenueWaterfallDS() {
  const [source, setSource] = useState<'qb' | 'txns'>('qb');
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');
  const [windowN, setWindowN] = useState<'3' | '6' | '12'>('12');
  const [includePartial, setIncludePartial] = useState(false);
  const [drill, setDrill] = useState<{ month: string; buckets: Bucket[]; title: string } | null>(null);
  const { data: qbData, isLoading: qbLoading, error: qbError } = useSheetTab('mrr_waterfall');
  const { data: txnData, isLoading: txnLoading, error: txnError } = useSheetTab('mrr_waterfall_txns');
  const qb = qbData as unknown as Snap | undefined;
  const txn = txnData as unknown as Snap | undefined;
  const all: Row[] = useMemo(() => {
    if (source === 'txns') return txn?.monthly ?? [];
    return basis === 'accrual' && qb?.monthly_accrual?.length ? qb.monthly_accrual : qb?.monthly ?? [];
  }, [source, basis, qb, txn]);
  const isLoading = source === 'txns' ? txnLoading : qbLoading;
  const error = source === 'txns' ? txnError : qbError;

  // In progress = flagged partial, or at/after the QB snapshot's partial month (else today).
  const currentMonth = useMemo(() => {
    const p = (qb?.monthly ?? []).find((r) => r.partial)?.month;
    if (p) return p;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [qb]);
  const isPartial = (r: Row) => !!r.partial || r.month >= currentMonth;
  const complete = useMemo(() => all.filter((r) => !isPartial(r)), [all, currentMonth]); // eslint-disable-line react-hooks/exhaustive-deps
  const partialRow = all.find(isPartial) ?? null;
  const shown = includePartial ? all : complete;
  const byMonth = useMemo(() => new Map(all.map((r) => [r.month, r])), [all]);
  const range = useMonthRange(shown.map((r) => r.month));
  const visible = range.months.map((m) => byMonth.get(m)!).filter(Boolean);

  // Header cards: trailing window of COMPLETE months, annualized exactly as build_waterfall.summarize.
  const stats = useMemo(() => {
    const rows = complete.slice(-Number(windowN));
    if (!rows.length) return null;
    const sum = (b: Bucket) => rows.reduce((a, r) => a + val(r, b), 0);
    const s = Object.fromEntries(BUCKETS.map((b) => [b.k, sum(b.k)])) as Record<Bucket, number>;
    const net = BUCKETS.reduce((a, b) => a + b.sign * s[b.k], 0);
    const mean = (k: 'grr_monthly' | 'nrr_monthly' | 'gross_churn_rate_monthly') => {
      const v = rows.map((r) => r[k]).filter((x): x is number => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const g = mean('grr_monthly'), n = mean('nrr_monthly'), c = mean('gross_churn_rate_monthly');
    return {
      start: rows[0].month, end: rows[rows.length - 1].month,
      starting: rows[0].starting_mrr, ending: rows[rows.length - 1].ending_mrr, s, net,
      grr: g == null ? null : Math.pow(Math.max(g, 0), 12),
      nrr: n == null ? null : Math.pow(Math.max(n, 0), 12),
      churnRate: c == null ? null : 1 - Math.pow(Math.max(1 - c, 0), 12),
      quick: s.churn + s.contraction > 0 ? (s.new + s.reactivated + s.expansion) / (s.churn + s.contraction) : null,
    };
  }, [complete, windowN]);

  // Status is a tag with its word and tone together, never color alone.
  const tone = (v: number | null, good: number, ok: number) => (v == null ? undefined : v >= good ? 'success' as const : v >= ok ? 'warning' as const : 'error' as const);
  const verdict = (v: number | null, good: number, ok: number) => (v == null ? undefined : v >= good ? 'On target' : v >= ok ? 'Watch' : 'Below target');

  // ---- drill: one or more buckets of one month, as a customer table
  const drillRows = (month: string, buckets: Bucket[]) => {
    const r = byMonth.get(month);
    if (!r) return [];
    return buckets.flatMap((b) => {
      const list = (r.details[b] ?? []) as Array<Named | Change>;
      const label = BUCKETS.find((x) => x.k === b)!.label;
      return list.map((x) => ('delta' in x
        ? [x.name, label, `${usd(x.prev_mrr)} → ${usd(x.new_mrr)}`, signed(b === 'contraction' ? -x.delta : x.delta)]
        : [x.name, label, (x as Named).pay_status || (x as Named).status || '—', signed(BUCKETS.find((y) => y.k === b)!.sign * x.mrr)]));
    });
  };
  const open = (month: string, buckets: Bucket[], title: string) => setDrill({ month, buckets, title });

  const series = STACKS.map((st) => ({ key: st.key, label: st.label, tone: st.tone, values: visible.map((r) => st.sign * st.parts.reduce((a, b) => a + val(r, b), 0)) }));
  const basisLabel = source === 'txns' ? 'Stripe transactions (cash)' : basis === 'accrual' ? 'accrual (billed)' : 'cash (cleared)';

  const tableRows = [...visible].reverse();
  const cols: Array<[string, boolean]> = [['Month', false], ['Starting', true], ...BUCKETS.map((b) => [`${b.sign > 0 ? '+' : '−'} ${b.label}`, true] as [string, boolean]), ['Net new', true], ['Ending', true], ['NRR', true], ['Quick', true]];

  return (
    <DsPage
      path="/revenue-waterfall"
      title="Revenue Waterfall"
      subtitle={stats ? `${mlabel(stats.start)} to ${mlabel(stats.end)} · basis: ${basisLabel} · sales tax excluded` : 'Loading…'}
      actions={
        <button className="am-btn am-btn--outlined" onClick={() => downloadCsv(`revenue_waterfall_${range.months[0] ?? ''}_to_${range.months[range.months.length - 1] ?? ''}`,
          ['Month', 'Starting', ...BUCKETS.map((b) => b.label), 'Net new', 'Ending', 'NRR (mo)', 'GRR (mo)', 'Quick ratio'],
          tableRows.map((r) => [r.month, r.starting_mrr, ...BUCKETS.map((b) => val(r, b.k)), r.net_new_mrr, r.ending_mrr, r.nrr_monthly ?? '', r.grr_monthly ?? '', r.quick_ratio ?? '']))}>
          <Icon name="download" />Export CSV
        </button>
      }
      overlays={drill && (
        <SideSheet open onClose={() => setDrill(null)} title={`${drill.title} · ${mlabel(drill.month)}`}
          text={drill.buckets.some((b) => ['delinquent', 'voided', 'paused'].includes(b))
            ? 'Stopped billing but not churned: lapsed (under 3 months, may still pay), voided (the invoice was cancelled), or paused (pause granted in HubSpot). Churn is confirmed by a cancelled Stripe subscription, HubSpot Cancelled, or 3 months unbilled.'
            : undefined}>
          {(() => {
            const rows = drillRows(drill.month, drill.buckets);
            const hasDetail = rows.some((r) => r[2] !== '—');
            return rows.length
              ? <DataTable cols={hasDetail ? [['Customer', false], ['Movement', false], ['Detail', false], ['MRR change', true]] : [['Customer', false], ['Movement', false], ['MRR change', true]]}
                  rows={hasDetail ? rows : rows.map((r) => [r[0], r[1], r[3]])} label={drill.title} />
              : <p className="am-card__text">No customers in this movement for the month.</p>;
          })()}
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Could not load the waterfall: {String(error)}</p> : null}

      <div className="am-row am-row--wrap">
        <Segmented label="Basis" value={source === 'txns' ? null : basis} onChange={(v) => { setSource('qb'); setBasis(v); }}
          options={[['accrual', 'Accrual (billed)'], ['cash', 'Cash (cleared)']]} />
        <Segmented label="Source" value={source} onChange={setSource} options={[['qb', 'Dashboard data'], ['txns', 'Stripe transactions']]} />
        <span className="am-card__text">Cards cover</span>
        <Segmented label="Cards cover" value={windowN} onChange={setWindowN} options={[['3', '3 mo'], ['6', '6 mo'], ['12', '12 mo']]} />
      </div>

      <div className="am-grid" style={{ ['--am-grid-min' as string]: '200px' }}>
        {stats && !isLoading && <>
          <KpiCard label={`Net new MRR · ${windowN} mo`} value={signed(stats.net)} hint={`${usd(stats.starting)} → ${usd(stats.ending)}`} />
          <KpiCard label={`Annualized NRR · ${windowN} mo`} value={pct(stats.nrr)} hint="Target 110% or more" tag={verdict(stats.nrr, 1.1, 1.0)} tagTone={tone(stats.nrr, 1.1, 1.0)} />
          <KpiCard label={`Annualized GRR · ${windowN} mo`} value={pct(stats.grr)} hint="Target 90% or more" tag={verdict(stats.grr, 0.9, 0.8)} tagTone={tone(stats.grr, 0.9, 0.8)} />
          <KpiCard label={`Quick ratio · ${windowN} mo`} value={stats.quick == null ? '—' : `${stats.quick.toFixed(2)}x`} hint="(New + Reactivated + Expansion) ÷ (Contraction + Churn) · target 4x" tag={verdict(stats.quick, 4, 2)} tagTone={tone(stats.quick, 4, 2)} />
          <KpiCard label={`Annual MRR churn · ${windowN} mo`} value={pct(stats.churnRate)} hint={`${usd(stats.s.churn)} confirmed churn in the window`} />
          <KpiCard label={`Not yet churned · ${windowN} mo`} value={usd(stats.s.delinquent + stats.s.voided + stats.s.paused)}
            hint={`Lapsed ${usd(stats.s.delinquent)} · voided ${usd(stats.s.voided)} · paused ${usd(stats.s.paused)}`} />
        </>}
      </div>
      <p className="am-card__text">Rates are annualized from the monthly average, so 3, 6 and 12 month views compare. Cards never include the month in progress.</p>

      <ChartCard title="Monthly MRR movement" caption={`Gains above zero, losses below · the figure on each month is its net new MRR · ${range.rangeText}`}>
        <div className="am-row am-row--wrap">
          {range.controls}
          {partialRow && <Switch checked={includePartial} onChange={setIncludePartial}>Include {mlabel(partialRow.month)} (in progress)</Switch>}
        </div>
        <ColumnChart months={range.months} series={series} fmt={usdk} stacked legend
          labelFor={(i) => { const r = visible[i]; return r ? `${r.net_new_mrr >= 0 ? '+' : '−'}${usdk(Math.abs(r.net_new_mrr)).replace('−', '')}` : null; }}
          tipRows={(i) => {
            const r = visible[i];
            return r ? [...BUCKETS.filter((b) => val(r, b.k) !== 0).map((b) => [b.label, signed(b.sign * val(r, b.k))] as [string, string]), ['Net new', signed(r.net_new_mrr)], ['Ending MRR', usd(r.ending_mrr)]] : [];
          }}
          onSegment={(i, key) => { const st = STACKS.find((s) => s.key === key)!; open(range.months[i], st.parts, st.label); }}
          aria={`Monthly MRR movement, ${range.rangeText}.`} />
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Month by month</span>
          <span className="am-chart__caption">Newest first · select any movement to see the customers behind it</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Month-by-month MRR movement" cols={cols}
            rows={tableRows.map((r) => [
              mlabel(r.month) + (isPartial(r) ? ' (in progress)' : ''), usd(r.starting_mrr),
              ...BUCKETS.map((b) => (val(r, b.k) ? signed(b.sign * val(r, b.k)) : '—')),
              signed(r.net_new_mrr), usd(r.ending_mrr), pct(r.nrr_monthly, 2), r.quick_ratio == null ? '—' : `${r.quick_ratio.toFixed(2)}x`,
            ])}
            clickable={(col) => col >= 2 && col < 2 + BUCKETS.length}
            onCell={(row, col) => {
              const b = BUCKETS[col - 2];
              if (b) open(tableRows[row].month, [b.k], b.label);
            }} />
        </div>
      </section>
    </DsPage>
  );
}
