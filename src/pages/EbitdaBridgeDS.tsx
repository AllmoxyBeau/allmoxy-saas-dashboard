/**
 * Adjusted EBITDA Bridge on the Allmoxy design system. Same snapshot as the classic page
 * (EbitdaBridge.tsx, kept at /ebitda-bridge-classic): ebitda_bridge.json, built by
 * _etl_scripts/build_ebitda_bridge.mjs. Nothing is recomputed: every amount and margin is the
 * snapshot's, margins shown to one decimal from the 4-decimal data, exactly as the classic page.
 *
 * The bridge reads as a table: Net income, the standard add-backs, the GAAP EBITDA subtotal, the
 * QoE adjustments, and a Total row that is Adjusted EBITDA. A column chart draws each step.
 */
import { useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, SideSheet,
  downloadCsv, mlabel, usd, usdk,
} from '../design-system/parts';

type AddBack = { key: string; label: string; amount: number };
type QoeAdjustment = {
  id: string; label: string; category: string; amount: number; reason: string;
  evidence: string | null; verified_by: string | null; verified_at: string | null; is_placeholder: boolean;
};
type Bridge = {
  window: string; label?: string; start?: string; end?: string; months_in_window?: number;
  total_revenue?: number; net_income?: number; add_backs_to_ebitda?: AddBack[];
  gaap_ebitda?: number; gaap_ebitda_margin?: number | null;
  qoe_adjustments?: QoeAdjustment[]; qoe_adjustment_total?: number;
  adjusted_ebitda?: number; adjusted_ebitda_margin?: number | null;
  placeholder_adjustment_count?: number; unavailable?: boolean; reason?: string;
};
type BridgeSnapshot = {
  fetched_at: string; comment: string;
  source: { pnl_months: number; pnl_window: string; qoe_adjustment_count: number; qoe_adjustments_placeholder_count: number };
  bridges: { ytd_current: Bridge; latest_month: Bridge; ttm: Bridge };
};
type WindowKey = 'ytd_current' | 'latest_month' | 'ttm';

const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(Math.abs(v))}`;
const signed2 = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${USD2.format(Math.abs(v))}`;
const margin = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const catName = (c: string) => { const s = c.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };
const ym = (m?: string) => (m && /^\d{4}-\d{2}$/.test(m) ? mlabel(m) : m ?? '');

/** Sign-off status: a word and a tone, never color alone. */
function status(q: QoeAdjustment): { word: string; tone: 'warning' | 'success' | 'neutral' } {
  if (q.is_placeholder) return { word: 'Placeholder', tone: 'warning' };
  if (q.verified_by) return { word: 'Signed off', tone: 'success' };
  return { word: 'Not signed off', tone: 'neutral' };
}

export default function EbitdaBridgeDS() {
  const { data, isLoading, error } = useSheetTab('ebitda_bridge');
  const snap = data as unknown as BridgeSnapshot | undefined;
  const [windowKey, setWindowKey] = useState<WindowKey>('ytd_current');
  const [sheet, setSheet] = useState<'bridge' | 'qoe' | 'help' | null>(null);
  const bridge = snap?.bridges[windowKey];
  const ok = !!bridge && !bridge.unavailable;
  const addBacks = bridge?.add_backs_to_ebitda ?? [];
  const qoe = bridge?.qoe_adjustments ?? [];
  const placeholders = qoe.filter((q) => q.is_placeholder).length;

  // ---- bridge steps (Change column sums to Adjusted EBITDA; subtotal rows carry no change)
  type Step = { label: string; kind: string; change: number | null; running: number; margin?: number | null; note?: string };
  const steps: Step[] = [];
  if (ok && bridge) {
    let run = bridge.net_income ?? 0;
    steps.push({ label: 'GAAP net income', kind: 'Starting point', change: run, running: run });
    for (const ab of addBacks) { run += ab.amount; steps.push({ label: ab.label, kind: 'EBITDA add-back', change: ab.amount, running: run }); }
    steps.push({ label: 'GAAP EBITDA', kind: 'Subtotal', change: null, running: bridge.gaap_ebitda ?? 0, margin: bridge.gaap_ebitda_margin });
    run = bridge.gaap_ebitda ?? 0;
    for (const q of qoe) { run += q.amount; steps.push({ label: q.label, kind: `QoE · ${catName(q.category)}`, change: q.amount, running: run, note: q.is_placeholder ? 'Placeholder' : undefined }); }
  }
  const changeSum = steps.reduce((a, s) => a + (s.change ?? 0), 0);

  // ---- chart: one column per step; totals in blue, add-backs in green, removals in the loss tone
  const chartSteps = ok && bridge ? [
    { key: 'ni', name: 'Net income', v: bridge.net_income ?? 0, total: true },
    ...addBacks.map((a) => ({ key: `ab_${a.key}`, name: a.label.replace(/\s*\(.*\)$/, ''), v: a.amount, total: false })),
    { key: 'gaap', name: 'GAAP EBITDA', v: bridge.gaap_ebitda ?? 0, total: true },
    ...qoe.map((q) => ({ key: `q_${q.id}`, name: q.label, v: q.amount, total: false })),
    { key: 'adj', name: 'Adjusted EBITDA', v: bridge.adjusted_ebitda ?? 0, total: true },
  ] : [];
  const short = (s: string) => (s.length > 16 ? `${s.slice(0, 15)}…` : s);

  const exportQoe = () => {
    if (!qoe.length) return;
    downloadCsv(`ebitda_bridge_${windowKey}`, ['ID', 'Adjustment', 'Category', 'Amount $', 'Reason', 'Verified by', 'Placeholder?'],
      qoe.map((q) => [q.id, q.label, q.category, q.amount, q.reason, q.verified_by ?? '', String(q.is_placeholder)]));
  };
  const exportBridge = () => downloadCsv(`ebitda_bridge_steps_${windowKey}`, ['Step', 'Type', 'Change $', 'Running total $', 'Margin'],
    [...steps.map((s) => [s.label, s.kind, s.change ?? '', s.running, s.margin != null ? s.margin : '']), ['Adjusted EBITDA', 'Total', changeSum, bridge?.adjusted_ebitda ?? '', bridge?.adjusted_ebitda_margin ?? '']]);

  const qoeTable = (clickTotal: boolean) => (
    qoe.length ? (
      <DataTable label="QoE adjustment detail" cols={[['Adjustment', false], ['Category', false], ['Status', false], ['Amount', true]]}
        rows={qoe.map((q) => {
          const st = status(q);
          return [
            <span key="l"><b>{q.label}</b><br /><span className="am-card__text">{q.reason}</span>{q.evidence ? <><br /><span className="am-card__text">Evidence: {q.evidence}</span></> : null}</span>,
            catName(q.category),
            <span key="s" className={`am-tag am-tag--${st.tone}`}>{q.verified_by && !q.is_placeholder ? `${st.word} · ${q.verified_by}` : st.word}</span>,
            signed2(q.amount),
          ];
        })}
        sortValues={qoe.map((q) => [q.label, q.category, status(q).word, q.amount])}
        foot={[`Total · ${qoe.length} adjustment${qoe.length === 1 ? '' : 's'}`, '', placeholders ? `${placeholders} placeholder${placeholders === 1 ? '' : 's'}` : '', signed2(bridge?.qoe_adjustment_total ?? 0)]}
        onFoot={clickTotal ? () => setSheet('qoe') : undefined} footClickable={(c) => c === 0 || c === 3} />
    ) : <p className="am-card__text">No QoE adjustments configured. Add them to <code>_etl_scripts/ebitda_adjustments.json</code>.</p>
  );

  const windowText = ok && bridge ? `${ym(bridge.start)} to ${ym(bridge.end)} (${bridge.months_in_window} month${bridge.months_in_window !== 1 ? 's' : ''})` : '';

  return (
    <DsPage
      path="/ebitda-bridge"
      title="Adjusted EBITDA Bridge"
      subtitle="GAAP net income, plus the standard EBITDA add-backs (interest, tax, D&A), gives GAAP EBITDA; quality-of-earnings (QoE) adjustments (owner-comp normalization, one-time costs, discretionary perks) then give Adjusted EBITDA. The bridge a banker or buyer expects to see."
      actions={<>
        <button className="am-btn am-btn--outlined" onClick={exportBridge} disabled={!steps.length}><Icon name="download" />Export bridge</button>
        <button className="am-btn am-btn--outlined" onClick={exportQoe} disabled={!qoe.length}><Icon name="download" />Export QoE CSV</button>
      </>}
      overlays={<>
        {sheet === 'bridge' && <SideSheet open onClose={() => setSheet(null)} title={`Adjusted EBITDA bridge · ${windowText}`}
          text={`Every step from GAAP net income to Adjusted EBITDA, with each QoE adjustment's reason and sign-off. Revenue in the window: ${usd(bridge?.total_revenue ?? 0)}.`}>
          <DataTable label="Full bridge" cols={[['Step', false], ['Type', false], ['Change', true], ['Running total', true]]}
            rows={steps.map((s) => [s.label, s.kind + (s.note ? ` · ${s.note}` : ''), s.change == null ? '' : s.kind === 'Starting point' ? usd(s.change) : signed(s.change), usd(s.running)])}
            foot={['Adjusted EBITDA', margin(bridge?.adjusted_ebitda_margin) + ' of revenue', usd(changeSum), usd(bridge?.adjusted_ebitda ?? 0)]} />
          {qoe.length > 0 && <>
            <p className="am-card__text"><b>QoE adjustments</b></p>
            {qoeTable(false)}
          </>}
        </SideSheet>}
        {sheet === 'qoe' && <SideSheet open onClose={() => setSheet(null)} title={`All QoE adjustments · ${windowText}`}
          text="Every QoE add-back with its reason, evidence and sign-off status. Placeholders need amounts and owner sign-off before the banker handoff.">
          {qoeTable(false)}
        </SideSheet>}
        {sheet === 'help' && <SideSheet open onClose={() => setSheet(null)} title="How the bridge works">
          <p className="am-card__text"><b>Standard EBITDA bridge.</b> Net income + interest + tax + depreciation and amortization = GAAP EBITDA.</p>
          <p className="am-card__text"><b>QoE adjustments.</b> Add-backs a buyer would expect: owner-comp normalization, non-recurring expenses (legal, M&A), discretionary owner perks. Each is positive if it should be added back, negative if removed.</p>
          <p className="am-card__text"><b>Adding or editing a QoE add-back.</b> QoE adjustments live in <code>_etl_scripts/ebitda_adjustments.json</code>. Each entry has either a <code>per_month</code> amount or a <code>ytd_total</code>. Use <b>positive amounts</b> to add back (for example, a one-time legal fee that hit expenses but won't recur) and <b>negative amounts</b> to remove (for example, recognizing a future obligation not yet in the P&L). Set <code>is_placeholder: false</code> and fill in <code>verified_by</code> / <code>verified_at</code> once owner sign-off is captured, then re-run <code>node _etl_scripts/build_ebitda_bridge.mjs</code>.</p>
        </SideSheet>}
      </>}
    >
      {error ? <p className="am-card__text">Could not load ebitda_bridge: {String(error)}</p> : null}

      {snap && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap am-row--spread">
            <div className="am-row am-row--wrap" style={{ flex: 1, minWidth: 0 }}>
              {snap.source.qoe_adjustments_placeholder_count > 0
                ? <span className="am-tag am-tag--warning">{snap.source.qoe_adjustments_placeholder_count} still placeholders</span>
                : <span className="am-tag am-tag--success">All adjustments filled in</span>}
              <span className="am-card__text">
                {snap.source.qoe_adjustment_count} QoE adjustments on file{snap.source.qoe_adjustments_placeholder_count > 0 ? '; placeholders need owner sign-off and amounts' : ''}.
                {' '}P&L source covers {snap.source.pnl_months} months ({snap.source.pnl_window}). Last refreshed {new Date(snap.fetched_at).toLocaleString()}.
              </span>
            </div>
            <button className="am-btn am-btn--text" style={{ flexShrink: 0 }} onClick={() => setSheet('help')}><Icon name="info" />How the bridge works</button>
          </div>
        </section>
      )}

      <div className="am-row am-row--wrap">
        <Segmented label="Window" value={windowKey} onChange={setWindowKey} options={[
          ['ytd_current', `YTD ${snap?.bridges.ytd_current?.label?.replace('YTD ', '').replace(/through (\d{4}-\d{2})/, (_, m) => `through ${mlabel(m)}`) ?? ''}`.trim()],
          ['latest_month', 'Latest month'],
          ['ttm', `TTM${snap?.bridges.ttm?.unavailable ? ' (unavailable)' : ''}`],
        ]} />
        {windowText && <span className="am-card__text">{windowText}</span>}
      </div>

      {isLoading ? <p className="am-card__text">Loading…</p>
        : bridge?.unavailable ? (
          <section className="am-card am-card--outlined">
            <div className="am-row"><span className="am-tag am-tag--warning">Unavailable</span><span className="am-card__text">{bridge.reason}</span></div>
          </section>
        ) : ok && bridge ? <>
          <KpiGrid max={4}>
            <KpiCard label="Adjusted EBITDA" value={usd(bridge.adjusted_ebitda ?? 0)} hint={`${margin(bridge.adjusted_ebitda_margin)} margin`}
              tag={placeholders ? `${placeholders} placeholder${placeholders === 1 ? '' : 's'}` : qoe.length ? 'Adjustments filled in' : undefined}
              tagTone={placeholders ? 'warning' : 'success'} onOpen={() => setSheet('bridge')} />
            <KpiCard label="GAAP EBITDA" value={usd(bridge.gaap_ebitda ?? 0)} hint={`${margin(bridge.gaap_ebitda_margin)} margin`} />
            <KpiCard label="Net income" value={usd(bridge.net_income ?? 0)} hint="GAAP, from the QuickBooks P&L" />
            <KpiCard label="Total revenue" value={usd(bridge.total_revenue ?? 0)} hint={windowText} />
          </KpiGrid>

          <section className="am-card am-card--outlined">
            <div className="am-chart__head">
              <span className="am-chart__title">Bridge</span>
              <span className="am-chart__caption">{windowText} · each step's change sums to Adjusted EBITDA · select the total for every step with reasons</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Adjusted EBITDA bridge" cols={[['Step', false], ['Type', false], ['Change', true], ['Running total', true], ['Margin', true]]}
                rows={steps.map((s) => [
                  s.change == null ? <b key="b">= {s.label}</b> : s.label,
                  s.note ? <span key="t" className="am-row am-row--tight">{s.kind}<span className="am-tag am-tag--warning">{s.note}</span></span> : s.kind,
                  s.change == null ? '' : s.kind === 'Starting point' ? usd(s.change) : signed(s.change),
                  s.change == null ? <b key="r">{usd(s.running)}</b> : usd(s.running),
                  s.margin !== undefined ? margin(s.margin) : '',
                ])}
                foot={['= Adjusted EBITDA', qoe.length ? `QoE total ${signed(bridge.qoe_adjustment_total ?? 0)}` : 'No QoE adjustments', usd(changeSum), usd(bridge.adjusted_ebitda ?? 0), margin(bridge.adjusted_ebitda_margin)]}
                onFoot={() => setSheet('bridge')} footClickable={(c) => c === 0 || c === 3} />
            </div>
          </section>

          <ChartCard title="Bridge by step" caption={`${windowText} · totals in blue, add-backs in green, anything removed below zero · hover for the exact amount`}>
            <ColumnChart months={chartSteps.map((s) => s.key)} stacked legend
              catLabel={(k) => short(chartSteps.find((s) => s.key === k)?.name ?? k)}
              catTitle={(k) => chartSteps.find((s) => s.key === k)?.name ?? k}
              series={[
                { key: 'total', label: 'Total', tone: 'div-1', values: chartSteps.map((s) => (s.total ? s.v : 0)) },
                { key: 'add', label: 'Added back', tone: 'div-2', values: chartSteps.map((s) => (!s.total && s.v > 0 ? s.v : 0)) },
                { key: 'remove', label: 'Removed', tone: 'div-5', values: chartSteps.map((s) => (!s.total && s.v < 0 ? s.v : 0)) },
              ]}
              fmt={usdk}
              labelFor={(i) => { const s = chartSteps[i]; return s ? (s.total ? usdk(s.v) : s.v === 0 ? '$0' : `${s.v > 0 ? '+' : ''}${usdk(s.v)}`) : null; }}
              tipRows={(i) => { const s = chartSteps[i]; return s ? [[s.total ? 'Total' : 'Change', s.total ? usd(s.v) : signed(s.v)]] : []; }}
              aria={`Adjusted EBITDA bridge by step, ${windowText}.`} />
          </ChartCard>

          <section className="am-card am-card--outlined">
            <div className="am-chart__head">
              <span className="am-chart__title">QoE adjustment detail</span>
              <span className="am-chart__caption">Every QoE add-back with its reason, evidence and sign-off status. Placeholders need amounts and owner sign-off before the banker handoff.</span>
            </div>
            <div style={{ overflowX: 'auto' }}>{qoeTable(true)}</div>
          </section>
        </> : null}
    </DsPage>
  );
}
