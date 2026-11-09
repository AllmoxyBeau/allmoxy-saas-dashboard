/**
 * Payments Opportunity on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (PaymentsOpportunity.tsx,
 * kept at /payments-opportunity-classic): the same snapshots (connect_volume, connect_by_month)
 * and the same maths, including today's fixes:
 *  - Connect revenue headline is the canonical TTM (connect_by_month over the last 12 complete
 *    months), with the gross Stripe application-fee sum shown only as a labelled secondary;
 *  - one attach definition everywhere (any Connect fee in the last 3 complete months, over the
 *    canonical customer base);
 *  - attach fee potential carries its capture factor in the hint;
 *  - take-rate scenarios restated on the canonical revenue basis.
 * Lapsed notes keep the classic mechanism: localStorage key `allmoxy.connect_lapsed_notes`,
 * same shape, plus "Copy notes JSON".
 */
import { useEffect, useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, CustomerLink, DataTable, DsPage, KpiCard, KpiGrid, Icon, Segmented, SideSheet,
  downloadCsv, mlabel, pct, thisMonth, usd, usdk, useMonthRange,
} from '../design-system/parts';

type AccountRow = {
  account: string; customer_name: string | null; allmoxy_customer_id: number | null;
  customer_status: string | null; subscription_mrr: number | null;
  gross_volume: number; fee_revenue: number; txn_count: number; take_rate: number | null;
  first_seen: string; last_seen: string;
  this_month_fee?: number; this_month_gross?: number; last_month_fee?: number; last_month_gross?: number;
};
type MomMover = {
  customer_name: string | null; allmoxy_customer_id: number | null;
  current_fee: number; prior_fee: number; delta_fee: number; pct: number | null;
  current_gross: number; prior_gross: number;
};
type Mom = {
  current_month: string | null; prior_month: string | null;
  total_current_fee: number; total_prior_fee: number; total_delta_fee: number; pct: number | null;
  movers: MomMover[];
};
type Scenario = { take_rate: number; annual_fee_revenue: number; delta_vs_current: number; multiple_vs_current: number | null };
type ConnectStatus = 'processing' | 'lapsed' | 'never';
type CustomerRow = {
  allmoxy_customer_id: number | null; name: string; status: string; primary_segment: string | null;
  subscription_mrr: number; is_launched: string | null; connect_status: ConnectStatus; ever_processed: boolean;
  annual_order_volume: number; connect_gmv_annual?: number; connect_attach_rate?: number | null;
  annual_connect_fee: number; est_annual_connect_fee: number | null;
  lapsed_note?: string | null;
};
type TableFilter = 'processing' | 'lapsed' | 'not_on_connect' | 'targets';
type MonthRow = { month: string; gross_volume: number; fee_revenue: number; txn_count: number; take_rate: number | null };
type Snapshot = {
  stripe_fetchedAt: string;
  window: { since: string };
  currencies: Record<string, number>;
  currency_caveat: string | null;
  annualized: { basis: string; gross_volume: number; fee_revenue: number; txn_count: number; blended_take_rate: number | null };
  attach: { connected_accounts: number; active_customers: number; active_customers_on_connect: number; attach_rate: number | null; customers_with_mapped_account?: number; definition?: string };
  scenarios: Scenario[];
  mom?: Mom;
  take_rate_distribution: Record<string, number>;
  penetration?: {
    active_customers: number; processing_now: number; attach_rate: number | null; lapsed: number; never: number;
    not_processing: number; attach_target_order_volume: number; attach_target_fee_potential: number;
    attach_potential_basis: string; attach_capture_assumption?: number;
  };
  customers?: CustomerRow[];
  monthly: MonthRow[];
  by_account: AccountRow[];
};

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';
const STATUS: Record<ConnectStatus, [string, Tone]> = { processing: ['Processing', 'success'], lapsed: ['Lapsed', 'warning'], never: ['Never on Connect', 'neutral'] };
const FILTERS: Array<[TableFilter, string]> = [['targets', 'Attach targets'], ['processing', 'Processing'], ['lapsed', 'Lapsed'], ['not_on_connect', 'Never on Connect']];
const FILTER_TITLE: Record<TableFilter, string> = {
  processing: 'Customers processing on Connect, by Connect fee',
  lapsed: 'Lapsed customers: processed before, now idle',
  not_on_connect: 'Active customers never on Connect',
  targets: 'Attach targets: not processing, by order volume',
};
const rate = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
const pricing = (r: number | null): [string, Tone] => (r == null ? ['Unknown', 'neutral'] : r >= 0.0099 ? ['1.0% tier', 'info'] : r < 0.0049 ? ['Discounted', 'warning'] : ['Standard', 'neutral']);
const SHOW_N = 25;
const NOTES_KEY = 'allmoxy.connect_lapsed_notes';

export default function PaymentsOpportunityDS() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('connect_volume');
  const snap = data as unknown as Snapshot | undefined;
  const { data: cbmData, isLoading: cbmLoading } = useSheetTab<{ month: string; mrr_connect: number | null }>('connect_by_month');
  const cm = thisMonth();

  // Canonical Connect revenue (classic, verbatim): connect_by_month over the last 12 complete months.
  const canon = useMemo(() => {
    const rows = (cbmData?.rows ?? []).filter((r) => r.month < cm).sort((x, y) => (x.month < y.month ? -1 : 1)).slice(-12);
    if (rows.length === 0) return null;
    return { ttm: rows.reduce((s, r) => s + (r.mrr_connect || 0), 0), from: rows[0].month, to: rows[rows.length - 1].month };
  }, [cbmData, cm]);

  const a = snap?.annualized;
  const at = snap?.attach;
  const pen = snap?.penetration;
  const customers = useMemo(() => snap?.customers ?? [], [snap]);

  // ---- customer table filter (classic: default = attach targets; each KPI toggles its set)
  const [tableFilter, setTableFilter] = useState<TableFilter>('targets');
  const toggleFilter = (f: TableFilter) => setTableFilter((cur) => (cur === f ? 'targets' : f));
  const filteredCustomers = useMemo(() => {
    let rows = customers;
    if (tableFilter === 'processing') rows = customers.filter((c) => c.connect_status === 'processing');
    else if (tableFilter === 'lapsed') rows = customers.filter((c) => c.connect_status === 'lapsed');
    else if (tableFilter === 'not_on_connect') rows = customers.filter((c) => c.connect_status === 'never');
    else rows = customers.filter((c) => c.connect_status !== 'processing' && c.annual_order_volume > 0);
    const processingView = tableFilter === 'processing';
    return [...rows].sort((x, y) => processingView
      ? (y.annual_connect_fee - x.annual_connect_fee) || (y.annual_order_volume - x.annual_order_volume)
      : (y.annual_order_volume - x.annual_order_volume));
  }, [customers, tableFilter]);
  const showingProcessing = tableFilter === 'processing';
  const [custAll, setCustAll] = useState(false);
  const [custOrder, setCustOrder] = useState<number[] | null>(null);

  // ---- lapsed notes (classic mechanism, same key and shape)
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>(() => {
    try { const r = localStorage.getItem(NOTES_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
  });
  useEffect(() => { try { localStorage.setItem(NOTES_KEY, JSON.stringify(noteEdits)); } catch { /* ignore */ } }, [noteEdits]);
  const noteFor = (c: CustomerRow) => {
    const k = String(c.allmoxy_customer_id);
    return (k in noteEdits) ? noteEdits[k] : (c.lapsed_note ?? '');
  };
  const setNote = (id: number | null, v: string) => { if (id == null) return; setNoteEdits((cur) => ({ ...cur, [String(id)]: v })); };
  const hasNoteEdits = Object.keys(noteEdits).length > 0;
  const [copied, setCopied] = useState(false);
  const copyNotesJson = () => {
    const merged: Record<string, string> = {};
    for (const c of customers) if (c.connect_status === 'lapsed' && c.lapsed_note) merged[String(c.allmoxy_customer_id)] = c.lapsed_note;
    for (const [k, v] of Object.entries(noteEdits)) { if (v && v.trim()) merged[k] = v.trim(); else delete merged[k]; }
    navigator.clipboard?.writeText(JSON.stringify({ notes: merged }, null, 2)).then(() => setCopied(true), () => {});
  };
  const [noteFor_, setNoteOpen] = useState<CustomerRow | null>(null);

  // ---- scenarios restated on the canonical revenue basis (classic, verbatim)
  const scenarios = useMemo<Scenario[]>(() => {
    const raw = snap?.scenarios ?? [];
    const blended = a?.blended_take_rate;
    if (!canon || !blended) return raw;
    return raw.map((s) => {
      const rev = Math.round(canon.ttm * (s.take_rate / blended));
      return { ...s, annual_fee_revenue: rev, delta_vs_current: Math.round(rev - canon.ttm), multiple_vs_current: Math.round((s.take_rate / blended) * 100) / 100 };
    });
  }, [snap, a, canon]);
  const current = scenarios.find((s) => Math.abs(s.take_rate - (a?.blended_take_rate ?? 0.005)) < 0.0006) ?? scenarios[0];
  const todayRevenue = canon?.ttm ?? current?.annual_fee_revenue;
  const target1 = scenarios.find((s) => Math.abs(s.take_rate - 0.01) < 0.0001);
  const capturePct = pen?.attach_capture_assumption != null ? Math.round(pen.attach_capture_assumption * 100) : null;

  // ---- monthly chart: complete months only (classic), range-selectable
  const monthly = useMemo(() => (snap?.monthly ?? []).filter((m) => m.month < cm), [snap, cm]);
  const byMonth = useMemo(() => new Map(monthly.map((m) => [m.month, m])), [monthly]);
  const range = useMonthRange(monthly.map((m) => m.month));
  const [chartView, setChartView] = useState<'gmv' | 'take'>('gmv');

  // ---- movers
  const [moverAll, setMoverAll] = useState<{ up: boolean; down: boolean }>({ up: false, down: false });
  // ---- accounts
  const [acctAll, setAcctAll] = useState(false);
  const [acctOrder, setAcctOrder] = useState<number[] | null>(null);
  const accounts = snap?.by_account ?? [];

  const custCsv = () => {
    const rows = custOrder && custOrder.length === filteredCustomers.length ? custOrder.map((i) => filteredCustomers[i]) : filteredCustomers;
    downloadCsv('connect_customers', ['Customer', 'Connect status', 'Customer status', 'Segment', 'Subscription MRR', 'Annual order volume', 'Connect attach rate', 'Connect fee (actual, TTM)', 'Est annual Connect fee @0.5%', 'Est monthly Connect fee @0.5%', 'Lapsed note'],
      rows.map((r) => [r.name, r.connect_status, r.status, r.primary_segment ?? '', r.subscription_mrr, r.annual_order_volume,
        r.connect_attach_rate != null ? (r.connect_attach_rate * 100).toFixed(0) + '%' : '', r.annual_connect_fee, r.est_annual_connect_fee ?? '',
        r.est_annual_connect_fee != null ? Math.round(r.est_annual_connect_fee / 12) : '', r.connect_status === 'lapsed' ? noteFor(r) : '']));
  };
  const acctCsv = () => {
    const rows = acctOrder && acctOrder.length === accounts.length ? acctOrder.map((i) => accounts[i]) : accounts;
    downloadCsv('connect_accounts', ['Customer', 'Stripe account', 'GMV (TTM-window)', 'Fee revenue', 'This month fee', 'Last month fee', 'Take rate', 'Transactions', 'Customer status'],
      rows.map((r) => [r.customer_name ?? r.account, r.account, r.gross_volume, r.fee_revenue, r.this_month_fee ?? '', r.last_month_fee ?? '',
        r.take_rate != null ? (r.take_rate * 100).toFixed(2) + '%' : '', r.txn_count, r.customer_status ?? '']));
  };

  const loading = isLoading || cbmLoading;
  const feeOf = (o: CustomerRow) => (o.connect_status === 'processing' ? o.annual_connect_fee : o.est_annual_connect_fee);

  // ---- lapsed-note sheet (edits save to this browser as typed, as on the classic page)
  const sheet = noteFor_ ? (
    <SideSheet open onClose={() => setNoteOpen(null)} title={`Why ${noteFor_.name} lapsed`}
      text="From HubSpot notes, CS calls and so on. Saved in this browser as you type; use Copy notes JSON to share it with the team.">
      <label className="am-field am-field--outlined am-field--multiline" style={{ width: '100%' }}>
        <textarea className="am-field__input" placeholder=" " rows={5} value={noteFor(noteFor_)}
          onChange={(e) => setNote(noteFor_.allmoxy_customer_id, e.target.value)} aria-label="Why they lapsed" />
        <span className="am-field__label">Why they lapsed</span>
        <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap">Why they lapsed</i><i /></span>
      </label>
      <DataTable label="Lapsed customer" cols={[['Detail', false], ['Value', true]]}
        rows={[['Subscription MRR', usd(noteFor_.subscription_mrr)], ['Annual order volume', noteFor_.annual_order_volume > 0 ? usd(noteFor_.annual_order_volume) : '—'],
          ['Est. Connect fee @0.5%/yr', noteFor_.est_annual_connect_fee ? usd(noteFor_.est_annual_connect_fee) : '—']]} />
    </SideSheet>
  ) : null;

  const mom = snap?.mom;

  return (
    <DsPage
      path="/payments-opportunity"
      title="Payments Opportunity"
      subtitle={loading ? 'Loading…' : 'The embedded-payments thesis: processing volume (GMV) through Stripe Connect, our take rate, and the revenue upside from take-rate and attach expansion. Live from the Stripe application fees API.'}
      overlays={sheet}
    >
      {error ? <p className="am-card__text">Could not load connect_volume: {String(error)}</p> : null}
      {snap?.currency_caveat && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap am-row--tight">
            <span className="am-tag am-tag--info">Currency</span>
            <span className="am-card__text">{snap.currency_caveat} Currency mix: {Object.entries(snap.currencies).map(([c, n]) => `${c} ${n.toLocaleString()}`).join(' · ')}.</span>
          </div>
        </section>
      )}

      {snap && a && <>
        <KpiGrid>
          <KpiCard label="Connect revenue (TTM)" value={canon ? usd(canon.ttm) : '—'}
            hint={canon ? `${mlabel(canon.from)} to ${mlabel(canon.to)} · canonical, the figure Overview and Stripe Connect report. Gross application fees (Stripe): ${usd(a.fee_revenue)}, ${a.fee_revenue - canon.ttm >= 0 ? '+' : '−'}${usd(Math.abs(a.fee_revenue - canon.ttm))} before refunds, reversals and FX, not extra revenue.` : undefined}
            tag="Canonical" tagTone="success" />
          <KpiCard label="Annual processing volume (GMV)" value={usdk(a.gross_volume)}
            hint={`${a.basis} · gross dollars charged across all connected accounts`} />
          <KpiCard label="Blended take rate" value={rate(a.blended_take_rate)}
            hint="Fee ÷ GMV. Nearly the whole book sits at a flat 0.50%, a handful grandfathered at 1.0% and a few discounted." />
          <KpiCard label="Connect attach" value={pen ? pct(pen.attach_rate ?? 0, 0) : '—'}
            hint={pen ? `${pen.processing_now} of ${pen.active_customers} customers processing now (any Connect fee in the last 3 complete months)${at ? ` · ${at.connected_accounts} accounts total` : ''}` : undefined}
            tag={pen ? `${pen.not_processing} not processing` : undefined} tagTone="warning"
            onOpen={pen ? () => setTableFilter('processing') : undefined} />
        </KpiGrid>

        {pen && (
          <section className="am-card am-card--outlined">
            <div className="am-chart__head" style={{ marginBottom: 12 }}>
              <span className="am-chart__title">Attach opportunity</span>
              <span className="am-chart__caption">The second growth lever: monetizing customers not yet on Connect. Processing now means any Connect fee in the last 3 complete months, the same definition as the headline attach. Select a card to list that set. {pen.attach_potential_basis}</span>
            </div>
            <KpiGrid>
              <KpiCard label="Processing now" value={String(pen.processing_now)} hint={`of ${pen.active_customers} customers · ${pct(pen.attach_rate ?? 0, 0)} attach`}
                tag={tableFilter === 'processing' ? 'Listed below' : undefined} tagTone="info" onOpen={() => toggleFilter('processing')} />
              <KpiCard label="Lapsed" value={String(pen.lapsed)} hint="Processed before, idle 3 months or more: reactivation targets"
                tag={tableFilter === 'lapsed' ? 'Listed below' : undefined} tagTone="info" onOpen={() => toggleFilter('lapsed')} />
              <KpiCard label="Never on Connect" value={String(pen.never)} hint="Active customers that have never processed a payment on Connect"
                tag={tableFilter === 'not_on_connect' ? 'Listed below' : undefined} tagTone="info" onOpen={() => toggleFilter('not_on_connect')} />
              <KpiCard label="Attach fee potential" value={`${usd(pen.attach_target_fee_potential)}/yr`}
                hint={`~${usd(Math.round(pen.attach_target_fee_potential / 12))}/mo · 0.5% take × ${capturePct ?? '—'}% capture (median share of order volume current processors run through Connect) on ${usdk(pen.attach_target_order_volume)} orders`}
                tag={tableFilter === 'targets' ? 'Listed below' : undefined} tagTone="info" onOpen={() => toggleFilter('targets')} />
            </KpiGrid>

            <div className="am-row am-row--spread am-row--wrap" style={{ marginTop: 16 }}>
              <div className="am-chart__head">
                <span className="am-chart__title">{FILTER_TITLE[tableFilter]} ({filteredCustomers.length})</span>
                <span className="am-chart__caption">MRR is subscription MRR; orders are annual order volume; attach rate is the share of orders run through Connect. {showingProcessing ? 'Connect fee is the actual trailing-twelve fee.' : `Connect fee is estimated at 0.5% take × ${capturePct ?? '—'}% capture.`}{tableFilter === 'lapsed' || tableFilter === 'targets' ? ' Lapsed customers carry a note on why they stopped.' : ''}</span>
              </div>
              <div className="am-row am-row--wrap">
                <Segmented label="Customer set" value={tableFilter} onChange={(v) => { setTableFilter(v); setCustAll(false); }} options={FILTERS} />
                {hasNoteEdits && <button className="am-btn am-btn--outlined" onClick={copyNotesJson}>{copied ? 'Copied' : 'Copy notes JSON'}</button>}
                <button className="am-btn am-btn--text" disabled={!filteredCustomers.length} onClick={custCsv}><Icon name="download" />CSV</button>
              </div>
            </div>
            {hasNoteEdits && <p className="am-card__text">Note edits are saved in this browser only. Select Copy notes JSON and ask Claude to apply it to <code>connect_lapsed_notes.json</code> and rebuild to share them with the team.</p>}
            {filteredCustomers.length === 0 ? <p className="am-card__text">No customers in this set.</p> : (() => {
              const tot = filteredCustomers.reduce((s, o) => ({ mrr: s.mrr + o.subscription_mrr, vol: s.vol + o.annual_order_volume, fee: s.fee + (feeOf(o) || 0) }), { mrr: 0, vol: 0, fee: 0 });
              return <>
                <div style={{ overflowX: 'auto' }}>
                  <DataTable key={tableFilter} label={FILTER_TITLE[tableFilter]}
                    cols={[['Customer', false], ['Connect', false], ['Segment', false], ['MRR', true], ['Orders/yr', true], ['Attach rate', true],
                      [showingProcessing ? 'Fee (TTM/yr)' : 'Est. fee/yr', true], [showingProcessing ? 'Monthly' : 'Est. monthly', true], ['Note', false]]}
                    rows={filteredCustomers.map((o) => {
                      const fee = feeOf(o);
                      const [w, t] = STATUS[o.connect_status];
                      const note = o.connect_status === 'lapsed' ? noteFor(o).trim() : '';
                      return [
                        o.allmoxy_customer_id != null ? <CustomerLink key="n" id={o.allmoxy_customer_id} name={o.name} /> : o.name,
                        <span key="s" className={`am-tag am-tag--${t}`}>{w}</span>,
                        o.primary_segment ?? '—', usd(o.subscription_mrr),
                        o.annual_order_volume > 0 ? usd(o.annual_order_volume) : '—',
                        o.connect_attach_rate ? pct(o.connect_attach_rate, 0) : '—',
                        fee ? usd(fee) : '—', fee ? `${usd(Math.round(fee / 12))}/mo` : '—',
                        o.connect_status === 'lapsed' && o.allmoxy_customer_id != null
                          ? <button key="b" className="am-btn am-btn--text" onClick={() => setNoteOpen(o)} title={note || undefined}>{note ? 'Read note' : 'Add note'}</button>
                          : '',
                      ];
                    })}
                    sortValues={filteredCustomers.map((o) => [o.name, o.connect_status, o.primary_segment, o.subscription_mrr, o.annual_order_volume, o.connect_attach_rate ?? null, feeOf(o) ?? null, feeOf(o) ?? null, o.connect_status === 'lapsed' ? noteFor(o) : null])}
                    limit={custAll ? undefined : SHOW_N}
                    onSortChange={(order) => setCustOrder(order)}
                    foot={[`Total · ${filteredCustomers.length} customers`, '', '', usd(tot.mrr), usd(tot.vol), '', usd(tot.fee), `${usd(Math.round(tot.fee / 12))}/mo`, '']}
                    footClickable={(c) => !custAll && filteredCustomers.length > SHOW_N && [3, 4, 6, 7].includes(c)}
                    onFoot={() => setCustAll(true)} />
                </div>
                {filteredCustomers.length > SHOW_N && (
                  <div className="am-row">
                    <button className="am-btn am-btn--text" onClick={() => setCustAll(!custAll)}>{custAll ? `Show top ${SHOW_N}` : `Show all ${filteredCustomers.length}`}</button>
                  </div>
                )}
              </>;
            })()}
          </section>
        )}

        <section className="am-card am-card--outlined">
          <div className="am-chart__head" style={{ marginBottom: 12 }}>
            <span className="am-chart__title">Take-rate expansion</span>
            <span className="am-chart__caption">Holding today’s GMV constant ({usdk(a.gross_volume)} a year, blended {rate(a.blended_take_rate)}), what Connect fee revenue would be at higher take rates. Today is the canonical Connect revenue TTM; each other card scales it by take rate ÷ today’s blended take.</span>
          </div>
          <KpiGrid>
            {scenarios.map((s) => {
              const isCurrent = current && s.take_rate === current.take_rate;
              return (
                <KpiCard key={s.take_rate} label={`${(s.take_rate * 100).toFixed(2)}% take`}
                  value={`${usd(isCurrent && todayRevenue != null ? todayRevenue : s.annual_fee_revenue)}/yr`}
                  hint={isCurrent ? 'Today’s Connect revenue' : `${s.delta_vs_current >= 0 ? '+' : '−'}${usd(Math.abs(s.delta_vs_current))}/yr${s.multiple_vs_current ? ` · ${s.multiple_vs_current}× today` : ''}`}
                  tag={isCurrent ? 'Today' : 'Upside'} tagTone={isCurrent ? 'neutral' : 'success'} />
              );
            })}
          </KpiGrid>
          {target1 && (
            <p className="am-card__text" style={{ marginTop: 16 }}>
              Standardizing the book to the 1.0% some accounts already pay would lift Connect fee revenue to {usd(target1.annual_fee_revenue)}/yr ({target1.multiple_vs_current}× today), +{usd(target1.delta_vs_current)}/yr at zero acquisition cost, before any attach growth. This is the lever a buyer underwrites; attach growth compounds on top.
            </p>
          )}
        </section>

        <ChartCard title="Monthly processing volume and take rate"
          caption={`Complete months only · ${range.rangeText} · hover a month for volume, take rate, fees and transactions`}>
          <div className="am-row am-row--wrap am-row--spread">
            {range.controls}
            <Segmented label="Measure" value={chartView} onChange={setChartView} options={[['gmv', 'Processing volume'], ['take', 'Take rate']]} />
          </div>
          <ColumnChart months={range.months}
            series={[chartView === 'gmv'
              ? { key: 'gmv', label: 'GMV', tone: 'div-1', values: range.months.map((m) => byMonth.get(m)?.gross_volume ?? 0) }
              : { key: 'take', label: 'Take rate', tone: 'div-2', values: range.months.map((m) => byMonth.get(m)?.take_rate ?? 0) }]}
            fmt={chartView === 'gmv' ? usdk : (v) => `${(v * 100).toFixed(2)}%`}
            tipRows={(i) => {
              const r = byMonth.get(range.months[i]);
              return r ? [['GMV', usd(r.gross_volume)], ['Take rate', rate(r.take_rate)], ['Fee revenue (gross)', usd(r.fee_revenue)], ['Transactions', r.txn_count.toLocaleString()]] : [];
            }}
            aria={`Monthly ${chartView === 'gmv' ? 'processing volume' : 'take rate'}, ${range.rangeText}.`} />
        </ChartCard>

        {mom && mom.movers.length > 0 && (() => {
          const up = mom.total_delta_fee >= 0;
          const partial = mom.current_month != null && mom.current_month >= cm;
          const gainers = mom.movers.filter((m) => m.delta_fee > 0.5);
          const decliners = mom.movers.filter((m) => m.delta_fee < -0.5).sort((x, y) => x.delta_fee - y.delta_fee);
          const MN = 12;
          const side = (title: string, list: MomMover[], key: 'up' | 'down') => {
            const tot = list.reduce((s, m) => ({ d: s.d + m.delta_fee, p: s.p + m.prior_fee, c: s.c + m.current_fee }), { d: 0, p: 0, c: 0 });
            const all = moverAll[key];
            return (
              <div style={{ flex: '1 1 420px', minWidth: 0 }}>
                <div className="am-row am-row--tight"><span className={`am-tag am-tag--${key === 'up' ? 'success' : 'error'}`}>{title}</span><span className="am-card__text">{list.length} customers</span></div>
                {list.length === 0 ? <p className="am-card__text">None</p> : <>
                  <div style={{ overflowX: 'auto' }}>
                    <DataTable label={title} cols={[['Customer', false], ['Change', true], ['Change %', true], [mom.prior_month ? mlabel(mom.prior_month) : 'Prior', true], [mom.current_month ? mlabel(mom.current_month) : 'Current', true]]}
                      rows={list.map((m) => [
                        m.allmoxy_customer_id != null ? <CustomerLink key="n" id={m.allmoxy_customer_id} name={m.customer_name ?? ''} /> : (m.customer_name ?? ''),
                        `${m.delta_fee >= 0 ? '+' : '−'}${usd(Math.abs(m.delta_fee))}`, m.pct != null ? `${m.pct > 0 ? '+' : ''}${m.pct}%` : '—', usd(m.prior_fee), usd(m.current_fee)])}
                      sortValues={list.map((m) => [m.customer_name ?? '', m.delta_fee, m.pct, m.prior_fee, m.current_fee])}
                      limit={all ? undefined : MN}
                      foot={[`Total · ${list.length}`, `${tot.d >= 0 ? '+' : '−'}${usd(Math.abs(tot.d))}`, '', usd(tot.p), usd(tot.c)]}
                      footClickable={(c) => !all && list.length > MN && c > 0 && c !== 2}
                      onFoot={() => setMoverAll((s) => ({ ...s, [key]: true }))} />
                  </div>
                  {list.length > MN && <button className="am-btn am-btn--text" onClick={() => setMoverAll((s) => ({ ...s, [key]: !all }))}>{all ? `Show top ${MN}` : `Show all ${list.length}`}</button>}
                </>}
              </div>
            );
          };
          return (
            <section className="am-card am-card--outlined">
              <div className="am-chart__head">
                <span className="am-chart__title">Month-over-month movers</span>
                <span className="am-chart__caption">What is driving the Connect fee trend: each customer’s Connect fee this month against last, from live per-account data, ranked by dollar change; the net reconciles to the total. Gross fee in USD (CAD at face).</span>
              </div>
              <div className="am-row am-row--wrap">
                <span className={`am-tag am-tag--${up ? 'success' : 'error'}`}>{up ? 'Up' : 'Down'} {up ? '+' : '−'}{usd(Math.abs(mom.total_delta_fee))}{mom.pct != null ? ` (${mom.pct > 0 ? '+' : ''}${mom.pct}%)` : ''}</span>
                <span className="am-card__text">{mom.current_month ? mlabel(mom.current_month) : '—'}{partial ? ' (in progress)' : ''} vs {mom.prior_month ? mlabel(mom.prior_month) : '—'}: {usd(mom.total_prior_fee)} → {usd(mom.total_current_fee)} in Connect fees{partial ? '. The current month is partial, so most of the drop is days not yet processed.' : '.'}</span>
              </div>
              <div className="am-row am-row--wrap" style={{ alignItems: 'flex-start' }}>
                {side('Gainers', gainers, 'up')}
                {side('Decliners', decliners, 'down')}
              </div>
            </section>
          );
        })()}

        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread am-row--wrap">
            <div className="am-chart__head">
              <span className="am-chart__title">Connected accounts by processing volume ({accounts.length})</span>
              <span className="am-chart__caption">GMV and fee revenue over the snapshot window · this month is {mlabel(cm)} (in progress), with its change against last month</span>
            </div>
            <button className="am-btn am-btn--text" disabled={!accounts.length} onClick={acctCsv}><Icon name="download" />CSV</button>
          </div>
          {(() => {
            const tot = accounts.reduce((s, r) => ({ g: s.g + r.gross_volume, f: s.f + r.fee_revenue, t: s.t + (r.this_month_fee ?? 0), n: s.n + r.txn_count }), { g: 0, f: 0, t: 0, n: 0 });
            return <>
              <div style={{ overflowX: 'auto' }}>
                <DataTable label="Connected accounts"
                  cols={[['Customer', false], ['GMV (window)', true], ['Take rate', true], ['Pricing', false], ['Fee revenue', true], ['This month (fee)', true], ['vs last month', true], ['Transactions', true], ['Status', false]]}
                  rows={accounts.map((r) => {
                    const [pw, pt] = pricing(r.take_rate);
                    const d = (r.this_month_fee ?? 0) - (r.last_month_fee ?? 0);
                    const st = r.customer_status;
                    return [
                      r.allmoxy_customer_id != null ? <CustomerLink key="n" id={r.allmoxy_customer_id} name={r.customer_name ?? r.account} /> : (r.customer_name || r.account),
                      usd(r.gross_volume), rate(r.take_rate), <span key="p" className={`am-tag am-tag--${pt}`}>{pw}</span>, usd(r.fee_revenue),
                      r.this_month_fee != null ? usd(r.this_month_fee) : '—',
                      r.this_month_fee != null && Math.abs(d) >= 1 ? `${d > 0 ? '+' : '−'}${usd(Math.abs(d))}` : '—',
                      r.txn_count.toLocaleString(),
                      <span key="s" className={`am-tag am-tag--${st === 'active' ? 'success' : 'neutral'}`}>{st == null ? 'Unmatched' : st.charAt(0).toUpperCase() + st.slice(1)}</span>,
                    ];
                  })}
                  sortValues={accounts.map((r) => [r.customer_name ?? r.account, r.gross_volume, r.take_rate, pricing(r.take_rate)[0], r.fee_revenue, r.this_month_fee ?? null,
                    r.this_month_fee != null ? (r.this_month_fee ?? 0) - (r.last_month_fee ?? 0) : null, r.txn_count, r.customer_status ?? 'unmatched'])}
                  limit={acctAll ? undefined : SHOW_N}
                  onSortChange={(order) => setAcctOrder(order)}
                  foot={[`Total · ${accounts.length} accounts`, usd(tot.g), tot.g ? rate(tot.f / tot.g) : '—', '', usd(tot.f), usd(tot.t), '', tot.n.toLocaleString(), '']}
                  footClickable={(c) => !acctAll && accounts.length > SHOW_N && [1, 4, 5, 7].includes(c)}
                  onFoot={() => setAcctAll(true)} />
              </div>
              {accounts.length > SHOW_N && (
                <div className="am-row"><button className="am-btn am-btn--text" onClick={() => setAcctAll(!acctAll)}>{acctAll ? `Show top ${SHOW_N}` : `Show all ${accounts.length}`}</button></div>
              )}
            </>;
          })()}
        </section>

        <p className="am-card__text">
          Live from Stripe {snap.stripe_fetchedAt?.slice(0, 10)} · window: {snap.window?.since} · take-rate spread: {Object.entries(snap.take_rate_distribution).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(' · ')}.
          {at?.definition ? ` Attach: ${at.definition}` : ''}
        </p>
      </>}
    </DsPage>
  );
}
