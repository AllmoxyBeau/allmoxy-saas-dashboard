/**
 * Stripe and QuickBooks reconciliation on the Allmoxy design system. Assembled from the shared
 * certified parts (src/design-system/parts.tsx). Data is the classic page's
 * (StripeQBReconciliation.tsx, kept at /stripe-qb-reconciliation-classic): the same
 * stripe_qb_reconciliation snapshot, its own per-month variances and tie-out status, and its
 * summary counts, untouched. Nothing is recomputed except table totals.
 *
 * The QB side comes from the P&L export, which stops at June 2026 (QuickBooks sync not
 * configured), so the reconciliation stops there too.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, SideSheet,
  downloadCsv, mlabel, usd, usdk, useMonthRange,
} from '../design-system/parts';

type Status = 'tight' | 'acceptable' | 'investigate';
type ReconciliationRow = {
  month: string;
  stripe: { subscription: number; subscription_monthly_cash?: number; annual_amortized?: number; services: number; connect: number; other: number; refunds: number; total: number };
  qb: { subscription_revenue: number; annual_deferred: number; subscription_recognized: number; services_revenue: number; affiliate_revenue: number; subscription_tax: number; stripe_fee_income: number; total_income: number };
  variance: { subscription_dollars: number; subscription_pct: number | null; services_dollars: number; services_pct: number | null };
  tie_out_status: Status;
};
type ReconciliationSnap = {
  fetched_at: string; comment: string; rows: ReconciliationRow[];
  reconciling_items: Array<{ label: string; description: string; sign: string }>;
  summary: { n_months: number; n_tight: number; n_acceptable: number; n_investigate: number };
};

const STATUS: Record<Status, { label: string; rule: string; tone: 'success' | 'warning' | 'error'; help: string }> = {
  tight: { label: 'Tight', rule: 'variance 1% or less', tone: 'success', help: 'Ties out to the books; review-grade.' },
  acceptable: { label: 'Acceptable', rule: 'variance over 1%, up to 5%', tone: 'warning', help: 'Explained by routine timing.' },
  investigate: { label: 'Investigate', rule: 'variance over 5%', tone: 'error', help: 'Check against the reconciling items below.' },
};
const ORDER: Status[] = ['investigate', 'acceptable', 'tight'];
const pct2 = (v: number | null) => (v == null ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}%`);
const signed = (v: number) => (Math.abs(v) < 0.5 ? '$0' : `${v > 0 ? '+' : '−'}${usd(Math.abs(v))}`);
const tag = (s: Status) => <span className={`am-tag am-tag--${STATUS[s].tone}`}>{STATUS[s].label}</span>;

export default function StripeQBReconciliationDS() {
  const { data, isLoading, error } = useSheetTab('stripe_qb_reconciliation');
  const snap = data as unknown as ReconciliationSnap | undefined;
  const [filter, setFilter] = useState<Status | 'all'>('all');
  const [detail, setDetail] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<number[] | null>(null);

  const rows = useMemo(() => (snap?.rows ?? []).slice().reverse(), [snap]); // newest first, as the classic page
  const chronological = useMemo(() => snap?.rows ?? [], [snap]);
  const byMonth = useMemo(() => new Map(chronological.map((r) => [r.month, r])), [chronological]);
  const range = useMonthRange(chronological.map((r) => r.month));
  const shown = filter === 'all' ? rows : rows.filter((r) => r.tie_out_status === filter);
  const summary = snap?.summary;
  const first = chronological[0]?.month, last = chronological[chronological.length - 1]?.month;
  const windowText = first && last ? `${mlabel(first)} to ${mlabel(last)}` : '';
  const monthsOf = (s: Status) => rows.filter((r) => r.tie_out_status === s);
  const latestRow = rows[0];

  // CSV: the classic export's columns, all months newest first (or in the table's sort order).
  const exportCsv = () => {
    const ordered = sortOrder && filter === 'all' ? sortOrder.map((i) => rows[i]) : rows;
    downloadCsv('stripe_qb_reconciliation',
      ['Month', 'Stripe sub $', 'QB sub recognized $', 'Sub variance $', 'Sub variance %', 'Stripe svc $', 'QB svc $', 'Svc variance $', 'Svc variance %', 'Status'],
      ordered.map((r) => [r.month, r.stripe.subscription, r.qb.subscription_recognized, r.variance.subscription_dollars, r.variance.subscription_pct ?? '',
        r.stripe.services, r.qb.services_revenue, r.variance.services_dollars, r.variance.services_pct ?? '', r.tie_out_status]));
  };

  const tot = (f: (r: ReconciliationRow) => number) => shown.reduce((a, r) => a + f(r), 0);
  const tSubS = tot((r) => r.stripe.subscription), tSubQ = tot((r) => r.qb.subscription_recognized), tSubV = tot((r) => r.variance.subscription_dollars);
  const tSvcS = tot((r) => r.stripe.services), tSvcQ = tot((r) => r.qb.services_revenue), tSvcV = tot((r) => r.variance.services_dollars);

  const d = detail ? byMonth.get(detail) : null;
  const visible = range.months.map((m) => byMonth.get(m)!).filter(Boolean);

  return (
    <DsPage
      path="/stripe-qb-reconciliation"
      title="Stripe and QuickBooks Reconciliation"
      subtitle={snap
        ? `How Stripe ties to the books, month by month · ${windowText} (${summary?.n_months ?? rows.length} months) · QuickBooks P&L ends ${last ? mlabel(last) : '—'} because the QuickBooks sync is not configured · refreshed ${new Date(snap.fetched_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'Loading…'}
      actions={snap ? <button className="am-btn am-btn--outlined" onClick={exportCsv}><Icon name="download" />Export CSV</button> : undefined}
      overlays={d && (
        <SideSheet open onClose={() => setDetail(null)} title={`${mlabel(d.month)} · tie-out detail`}
          text={<>{tag(d.tie_out_status)} {STATUS[d.tie_out_status].rule}. Variance is Stripe minus QuickBooks recognized: positive means Stripe collected more than the books recognized.</>}>
          <DataTable label="Subscription and services tie-out" cols={[['Line', false], ['Stripe', true], ['QuickBooks', true], ['Variance', true], ['Variance %', true]]}
            rows={[
              ['Subscription', usd(d.stripe.subscription), usd(d.qb.subscription_recognized), signed(d.variance.subscription_dollars), pct2(d.variance.subscription_pct)],
              ['Services', usd(d.stripe.services), usd(d.qb.services_revenue), signed(d.variance.services_dollars), pct2(d.variance.services_pct)],
            ]}
            foot={['Total', usd(d.stripe.subscription + d.stripe.services), usd(d.qb.subscription_recognized + d.qb.services_revenue), signed(d.variance.subscription_dollars + d.variance.services_dollars), '']} />
          <DataTable label="Stripe side" cols={[['Stripe (succeeded, net of refunds)', false], ['Amount', true]]}
            rows={[
              ...(d.stripe.subscription_monthly_cash != null ? [['Subscription, monthly cash', usd(d.stripe.subscription_monthly_cash)]] : []),
              ...(d.stripe.annual_amortized != null ? [['Annual prepay, amortized', usd(d.stripe.annual_amortized)]] : []),
              ['Subscription compared', usd(d.stripe.subscription)],
              ['Services', usd(d.stripe.services)], ['Connect', usd(d.stripe.connect)], ['Other', usd(d.stripe.other)], ['Refunds', usd(d.stripe.refunds)],
            ]}
            foot={['Stripe total', usd(d.stripe.total)]} />
          <DataTable label="QuickBooks side" cols={[['QuickBooks P&L line', false], ['Amount', true]]}
            rows={[
              ['4000 Monthly Subscription', usd(d.qb.subscription_revenue)], ['4100 Annual Deferred Monthly', usd(d.qb.annual_deferred)],
              ['Subscription recognized (4000 + 4100)', usd(d.qb.subscription_recognized)],
              ['4050 Monthly Subscription Tax', usd(d.qb.subscription_tax)], ['4200 Stripe Fee Income', usd(d.qb.stripe_fee_income)],
              ['4300 Services Income', usd(d.qb.services_revenue)], ['4600 Affiliate Referral Income', usd(d.qb.affiliate_revenue)],
            ]}
            foot={['Total income', usd(d.qb.total_income)]} />
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Could not load stripe_qb_reconciliation: {String(error)}</p> : null}
      {isLoading && <p className="am-card__text">Loading the reconciliation…</p>}

      {summary && (
        <KpiGrid>
          {latestRow && (
            <KpiCard label={`Latest month · ${mlabel(latestRow.month)}`} value={signed(latestRow.variance.subscription_dollars)}
              hint={`Subscription variance ${pct2(latestRow.variance.subscription_pct)} · services ${signed(latestRow.variance.services_dollars)}`}
              tag={STATUS[latestRow.tie_out_status].label} tagTone={STATUS[latestRow.tie_out_status].tone}
              onOpen={() => setDetail(latestRow.month)} />
          )}
          {ORDER.map((s) => {
            const n = s === 'tight' ? summary.n_tight : s === 'acceptable' ? summary.n_acceptable : summary.n_investigate;
            const ms = monthsOf(s);
            return (
              <KpiCard key={s} label={`${STATUS[s].label} months · ${windowText}`} value={`${n} of ${summary.n_months}`}
                hint={`${STATUS[s].rule[0].toUpperCase()}${STATUS[s].rule.slice(1)}. ${STATUS[s].help}${s === 'investigate' && ms.length ? ` ${ms.map((r) => mlabel(r.month)).join(', ')}.` : ''}`}
                tag={STATUS[s].label} tagTone={STATUS[s].tone}
                onOpen={n > 0 ? () => setFilter(s) : undefined} />
            );
          })}
        </KpiGrid>
      )}

      {snap && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread">
            <div className="am-chart__head">
              <span className="am-chart__title">Per-month tie-out · {filter === 'all' ? `all ${rows.length} months` : `${STATUS[filter].label} · ${shown.length} months`}</span>
              <span className="am-chart__caption">Newest first · Stripe is succeeded transactions net of refunds; QuickBooks subscription is lines 4000 + 4100 (annual prepay recognized monthly) · variance is Stripe minus QuickBooks · select a month for its detail</span>
            </div>
            <Segmented label="Status filter" value={filter} onChange={setFilter}
              options={[['all', 'All'], ...ORDER.map((s) => [s, STATUS[s].label] as [Status, string])]} />
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Per-month tie-out"
              cols={[['Month', false], ['Status', false], ['Stripe subscription', true], ['QB subscription', true], ['Subscription variance', true],
                ['Stripe services', true], ['QB services', true], ['Services variance', true]]}
              rows={shown.map((r) => [mlabel(r.month), tag(r.tie_out_status), usd(r.stripe.subscription), usd(r.qb.subscription_recognized), `${signed(r.variance.subscription_dollars)} · ${pct2(r.variance.subscription_pct)}`,
                usd(r.stripe.services), usd(r.qb.services_revenue), `${signed(r.variance.services_dollars)} · ${pct2(r.variance.services_pct)}`])}
              sortValues={shown.map((r) => [r.month, ORDER.indexOf(r.tie_out_status), r.stripe.subscription, r.qb.subscription_recognized, r.variance.subscription_dollars,
                r.stripe.services, r.qb.services_revenue, r.variance.services_dollars])}
              onSortChange={(order) => setSortOrder(order)}
              clickable={(col) => col === 0}
              onCell={(row) => setDetail(shown[row].month)}
              foot={[`Total · ${shown.length} months`, '', usd(tSubS), usd(tSubQ), `${signed(tSubV)} · ${pct2(tSubQ ? tSubV / tSubQ : null)}`, usd(tSvcS), usd(tSvcQ), `${signed(tSvcV)} · ${pct2(tSvcQ ? tSvcV / tSvcQ : null)}`]}
              footClickable={(c) => c === 0 && filter !== 'all'}
              onFoot={() => setFilter('all')} />
          </div>
          {filter !== 'all' && <button className="am-btn am-btn--text" onClick={() => setFilter('all')}>Show all {rows.length} months</button>}
          {shown.length === 0 && <p className="am-card__text">No months with this status.</p>}
        </section>
      )}

      {snap?.reconciling_items && (
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Known reconciling items · why variance appears</span>
            <span className="am-chart__caption">Months marked Investigate usually match one of these: annual lump-sum receipts and transaction-stream reclassifications</span>
          </div>
          {/* Full text on purpose: a table cell would cut these explanations short. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--am-space-block)' }}>
          {snap.reconciling_items.map((it) => (
            <div key={it.label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="am-chart__title">{it.label}</span>
              <p className="am-card__text">{it.description}</p>
              <div className="am-row am-row--tight"><span className="am-tag am-tag--neutral">Expected effect</span><span className="am-card__text">{it.sign}</span></div>
            </div>
          ))}
          </div>
        </section>
      )}

      {snap && (
        <ChartCard title="Subscription variance by month" caption={`Stripe minus QuickBooks recognized · above zero means Stripe collected more · ${range.rangeText}`}>
          {range.controls}
          <ColumnChart months={range.months} fmt={usdk}
            series={[{ key: 'var', label: 'Subscription variance', tone: 'div-1', values: visible.map((r) => r.variance.subscription_dollars) }]}
            labelFor={(i) => { const r = visible[i]; return r ? `${r.variance.subscription_dollars >= 0 ? '+' : '−'}${usdk(Math.abs(r.variance.subscription_dollars))}` : null; }}
            tipRows={(i) => { const r = visible[i]; return r ? [
              ['Status', `${STATUS[r.tie_out_status].label} (${STATUS[r.tie_out_status].rule})`],
              ['Stripe subscription', usd(r.stripe.subscription)], ['QB recognized', usd(r.qb.subscription_recognized)],
              ['Variance', `${signed(r.variance.subscription_dollars)} (${pct2(r.variance.subscription_pct)})`],
              ['Services variance', signed(r.variance.services_dollars)],
            ] : []; }}
            onSegment={(i) => setDetail(range.months[i])}
            aria={`Monthly subscription variance, Stripe minus QuickBooks, ${range.rangeText}.`} />
        </ChartCard>
      )}

      {snap && <p className="am-card__text">{snap.comment}</p>}
    </DsPage>
  );
}
