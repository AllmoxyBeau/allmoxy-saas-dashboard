/**
 * Revenue Recognition on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (RevenueRecognition.tsx, kept
 * at /revenue-recognition-classic): same snapshot, same month list (reconcile_from up to the
 * last complete month), same New AR split (collected after + still open + not invoiced, the
 * last derived as the leftover when the snapshot lacks it), same journal entry and CSV exports,
 * and the same footnote tying recognized revenue to the Revenue Waterfall's accrual ending MRR.
 *
 * Only the UI changed: the trend is a grouped column chart (recognized, cash received, new AR)
 * instead of lines over bars, and every summable table ends in a Total row that opens its rows.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, Segmented, Select, SideSheet,
  downloadCsv, mlabel, usd, usdk, useMonthRange,
} from '../design-system/parts';

// ---- snapshot shape (identical to the classic page)
type MonthRow = {
  recognized: number; cash: number; collected_in_period: number; outstanding_at_period_end: number;
  collected_after_period: number; still_open: number; unbilled_carry?: number; prior_ar_collected: number; cash_received: number;
};
type ArRow = { allmoxy_customer_id: number | null; name: string; invoice_id: string | null; invoice_date: string; service_month: string; amount: number; status: 'open' | 'uncollectible'; age_days: number; collectible?: boolean };
type DetailRow = { allmoxy_customer_id: number; name: string; month: string; basis: 'invoice' | 'charge'; recognized: number; collected_in_period: number; collected_after_period: number; still_open: number; unbilled_carry?: number; outstanding_at_period_end: number };
type JeLine = { account: string; debit: number | null; credit: number | null; description: string; group: 'cash' | 'tax' | 'accrual' | 'writeoff' };
type BalanceReport = { period_tz: string; starting_balance: number | null; charges_gross: number; refunds: number; connect_earnings: number; connect_refunds: number; stripe_fees: number; other_activity: number; net_activity: number; payouts: number; ending_balance: number | null; anchored: boolean };
type ArDetailRow = { allmoxy_customer_id: number | null; name: string; invoice_id: string | null; invoice_date: string; amount: number; tax: number; status: string; paid_at: string | null; resolution?: string };
type ArOtherRow = { allmoxy_customer_id: number | null; name: string; category: string; label: string; amount: number; invoice_id?: string | null };
type ArDetail = { new_ar_rows: ArDetailRow[]; prior_ar_rows: ArDetailRow[]; other_rows?: ArOtherRow[]; other_total?: number; new_ar_ex_tax: number; new_ar_tax: number; prior_ar_collected: number; residual: number; total: number };
type JournalEntry = {
  lines: JeLine[]; debits: number; credits: number; balanced: boolean; memo: string[];
  balance_report?: BalanceReport; ar_detail?: ArDetail;
  inputs: { recognized_ex_tax: number; accrual_adjustment: number; tax_total_used: number; tax_basis_used: string; balance_txn_rows: number; direct_subscription_charges: number; direct_rows: Array<{ name: string; amount: number; desc: string; mapped: boolean }> };
};
type Snap = {
  fetchedAt: string; invoices_fetched_at: string | null; basis: string; books_go_live: string; reconcile_from: string;
  months: string[]; by_month: Record<string, MonthRow>; ar_aging: ArRow[]; ar_total: number;
  reconciliation_detail: DetailRow[]; orphan_stripe_customers: Array<{ stripe_customer: string; months: string[]; latest_mrr: number }>;
  data_quality?: { invoices_missing_paid_at: number };
  journal_entries?: Record<string, JournalEntry>;
  ar_policy?: { writeoff_after_days: number | null; open_total: number; open_count: number; written_off_total: number; written_off_count: number; bookable_total: number; bookable_count: number; pre_accrual_total: number; pre_accrual_count: number; books_go_live: string; bad_debt_not_recognized?: { from: string; through: string; total: number; invoice_count: number; by_month: Record<string, number> } | null } | null;
};

const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd2 = (v: number) => USD2.format(v);
const money = (v: number, sign = false) => `${sign && v > 0 ? '+' : ''}${v < 0 ? '−' : ''}${USD2.format(Math.abs(v))}`;
const fmtDate = (iso: string | null | undefined) => { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; };
const carryOf = (r: DetailRow) => r.unbilled_carry ?? 0;
const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0);
const tag = (word: string, tone: 'success' | 'warning' | 'error' | 'info' | 'neutral') => <span className={`am-tag am-tag--${tone}`}>{word}</span>;

// Per-subscription money columns, in the classic table's order.
type ColKey = 'recognized' | 'collected_in_period' | 'outstanding_at_period_end' | 'collected_after_period' | 'unbilled_carry' | 'still_open';
const COLS: Array<{ k: ColKey; label: string; get: (r: DetailRow) => number }> = [
  { k: 'recognized', label: 'Recognized', get: (r) => r.recognized },
  { k: 'collected_in_period', label: 'Collected in period', get: (r) => r.collected_in_period },
  { k: 'outstanding_at_period_end', label: 'New AR at month-end', get: (r) => r.outstanding_at_period_end },
  { k: 'collected_after_period', label: 'Collected after', get: (r) => r.collected_after_period },
  { k: 'unbilled_carry', label: 'Not invoiced', get: carryOf },
  { k: 'still_open', label: 'Still open', get: (r) => r.still_open },
];
const statusOf = (r: DetailRow) =>
  r.still_open > 0 ? tag('Still open', 'error')
    : carryOf(r) > 0 ? tag('Not invoiced', 'warning')
      : r.collected_after_period > 0 ? tag('Paid late', 'info')
        : tag('Collected', 'success');

const GROUP_LABEL: Record<JeLine['group'], [string, 'neutral' | 'warning' | 'error' | 'info', string]> = {
  cash: ['Stripe activity', 'neutral', 'Your existing entry, ties to the Stripe API to the penny'],
  tax: ['Sales tax', 'warning', 'Backed out of 4000 into the payable accounts, by state'],
  writeoff: ['Bad debt', 'error', 'Receivables marked uncollectible this month'],
  accrual: ['Accrual adjustment', 'info', 'Invoice basis: 1200 AR against 4000'],
};

type Sheet = { kind: 'col'; key: ColKey | 'all' } | { kind: 'ar' } | { kind: 'arAging' };

export default function RevenueRecognitionDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('revenue_recognition');
  const snap = data as unknown as Snap | undefined;

  const currentMonth = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const reconMonths = useMemo(() => (snap?.months ?? []).filter((m) => m >= (snap?.reconcile_from ?? '2026-01') && m < currentMonth), [snap, currentMonth]);
  const [month, setMonth] = useState('');
  const selMonth = month || reconMonths[reconMonths.length - 1] || '';
  const row = selMonth ? snap?.by_month[selMonth] : undefined;
  // Third component of New AR. Older snapshots lack the field: derive it as the residual
  // (outstanding − collected after − still open).
  const unbilledCarry = row ? (row.unbilled_carry ?? Math.max(0, Math.round((row.outstanding_at_period_end - row.collected_after_period - row.still_open) * 100) / 100)) : 0;

  // Reconciling item vs the Revenue Waterfall's accrual ending MRR (duplicates excluded there).
  const { data: wfData } = useSheetTab('mrr_waterfall');
  const { data: baseData } = useSheetTab('customer_base');
  const wfEnding = useMemo(() => {
    const rows = (wfData as unknown as { monthly_accrual?: Array<{ month: string; ending_mrr: number }> | null } | undefined)?.monthly_accrual ?? [];
    return rows.find((r) => r.month === selMonth)?.ending_mrr ?? null;
  }, [wfData, selMonth]);
  const excludedDupes = (baseData as unknown as { excluded?: Array<{ name: string; mrr: number }> } | undefined)?.excluded ?? [];
  const isPreGoLive = !!(snap && selMonth && selMonth < snap.books_go_live);

  const detailRows = useMemo(() => (snap?.reconciliation_detail ?? []).filter((d) => d.month === selMonth).sort((a, b) => b.outstanding_at_period_end - a.outstanding_at_period_end || b.recognized - a.recognized), [snap, selMonth]);
  const outstandingRows = useMemo(() => detailRows.filter((d) => d.outstanding_at_period_end > 0), [detailRows]);
  const arRows = useMemo(() => (snap?.ar_aging ?? []).slice().sort((a, b) => b.amount - a.amount), [snap]);
  const netAdj = row ? row.recognized - row.cash_received : 0;
  const je = snap?.journal_entries?.[selMonth];

  // Trend: every complete month, range-controlled.
  const trendMonths = useMemo(() => (snap?.months ?? []).filter((m) => m < currentMonth), [snap, currentMonth]);
  const range = useMonthRange(trendMonths);

  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [showAllDetail, setShowAllDetail] = useState(false);
  const [showAllAr, setShowAllAr] = useState(false);
  const [arFilter, setArFilter] = useState<'all' | 'collectible' | 'closed'>('all');
  const arShown = arRows.filter((r) => arFilter === 'all' || (arFilter === 'closed' ? r.collectible === false : r.collectible !== false));

  const custCell = (id: number | null | undefined, name: string): ReactNode => (id != null || name)
    ? <button className="am-btn am-btn--text" onClick={() => navigate(id != null ? `/customer-detail?id=${encodeURIComponent(String(id))}` : `/customer-detail?name=${encodeURIComponent(name)}`)}>{name}</button>
    : name;
  const ml = selMonth ? mlabel(selMonth) : '—';

  // ---- exports (same files as the classic page)
  const exportJe = () => {
    if (!je) return;
    const rows: Array<Array<string | number>> = je.lines.map((l, i) => [String(i + 1), l.account, l.debit != null ? l.debit.toFixed(2) : '', l.credit != null ? l.credit.toFixed(2) : '', l.description]);
    rows.push(['', 'Totals', je.debits.toFixed(2), je.credits.toFixed(2), je.balanced ? 'Balanced' : 'OUT OF BALANCE']);
    downloadCsv(`qb_journal_entry_${selMonth}`, ['#', 'Account', 'Debits', 'Credits', 'Description'], rows);
  };
  const exportAllJe = () => {
    const all = snap?.journal_entries ?? {};
    const months = Object.keys(all).filter((m) => m < currentMonth).sort();
    const rows: Array<Array<string | number>> = [];
    for (const m of months) {
      const e = all[m]; if (!e) continue;
      const [y, mo] = m.split('-').map(Number);
      const dateStr = `${String(mo).padStart(2, '0')}/${new Date(y, mo, 0).getDate()}/${y}`;
      const label = mlabel(m);
      e.lines.forEach((l, i) => rows.push([dateStr, label, String(i + 1), l.account, l.debit != null ? l.debit.toFixed(2) : '', l.credit != null ? l.credit.toFixed(2) : '', l.description]));
      rows.push([dateStr, label, '', 'TOTALS', e.debits.toFixed(2), e.credits.toFixed(2), e.balanced ? 'Balanced' : 'OUT OF BALANCE']);
      rows.push([]);
    }
    downloadCsv(`qb_journal_entries_${months[0]}_to_${months[months.length - 1]}`, ['Date', 'Month', '#', 'Account', 'Debits', 'Credits', 'Description'], rows);
  };
  const exportDetail = () => downloadCsv(`revenue_recognition_${selMonth}`, ['Customer', 'Basis', ...COLS.map((c) => c.label)],
    detailRows.map((r) => [r.name, r.basis, ...COLS.map((c) => c.get(r))]));
  const exportAr = () => downloadCsv('ar_aging_open_invoices', ['Customer', 'Invoice date', 'Service month', 'Amount', 'Status', 'Age (days)', 'Collectible'],
    arRows.map((r) => [r.name, r.invoice_date, r.service_month, r.amount, r.status, r.age_days, r.collectible === false ? 'no' : 'yes']));

  // ---- side sheet content
  const sheetTitle = !sheet ? '' : sheet.kind === 'ar' ? `Accounts receivable line · ${ml}` : sheet.kind === 'arAging' ? 'AR aging · every invoice' : sheet.key === 'all' ? `Every subscription · ${ml}` : `${COLS.find((c) => c.k === sheet.key)!.label} · ${ml}`;
  const sheetBody = (): ReactNode => {
    if (!sheet) return null;
    if (sheet.kind === 'ar') {
      const d = je?.ar_detail;
      if (!d) return <p className="am-card__text">No receivable detail for this month.</p>;
      const bridge: Array<[string, number]> = [
        [`New AR: billed, unpaid at month-end (${d.new_ar_rows.length} invoice${d.new_ar_rows.length === 1 ? '' : 's'})`, d.new_ar_ex_tax],
        ['New AR: sales tax on those invoices', d.new_ar_tax],
        [`Less: prior-month AR collected this month (${d.prior_ar_rows.length})`, -d.prior_ar_collected],
        // Every other item, grouped by what it is (each one is listed below).
        ...Object.entries((d.other_rows ?? []).reduce<Record<string, { label: string; v: number; n: number }>>((acc, r) => {
          const o = acc[r.category] ?? (acc[r.category] = { label: r.label, v: 0, n: 0 }); o.v += r.amount; o.n++; return acc;
        }, {})).map(([, o]) => [`${o.label} (${o.n})`, o.v] as [string, number]),
        ...(Math.abs(d.residual) >= 0.01 ? [['Unreconciled — report this', d.residual] as [string, number]] : []),
      ];
      const invTable = (title: string, rows: ArDetailRow[], negative: boolean) => {
        const s = negative ? -1 : 1;
        return (
          <>
            <div className="am-chart__head"><span className="am-chart__title">{title}</span><span className="am-chart__caption">{rows.length} invoice{rows.length === 1 ? '' : 's'}</span></div>
            <div style={{ overflowX: 'auto' }}><DataTable label={title} cols={[['Customer', false], ['Invoice date', false], ['Amount', true], ['Tax', true], ['Total', true], [negative ? 'Paid' : 'Status', false]]}
              rows={rows.map((r) => [custCell(r.allmoxy_customer_id, r.name), fmtDate(r.invoice_date), money(s * r.amount), r.tax ? money(s * r.tax) : '—', money(s * (r.amount + r.tax)),
                negative ? fmtDate(r.paid_at) : r.resolution === 'still open' ? tag('Still open', 'warning') : r.resolution === 'uncollectible' ? tag('Uncollectible', 'error') : tag(r.resolution ?? r.status, 'success')])}
              foot={[`Total · ${rows.length}`, '', money(s * sum(rows, (r) => r.amount)), money(s * sum(rows, (r) => r.tax)), money(s * sum(rows, (r) => r.amount + r.tax)), '']} /></div>
          </>
        );
      };
      return <>
        <DataTable label="AR bridge" cols={[['Part', false], ['Amount', true]]} rows={bridge.map(([l, v]) => [l, money(v)])} foot={['Δ Accounts Receivable (posted)', money(d.total)]} />
        {invTable(`Billed in ${ml}, unpaid at month-end: new AR`, d.new_ar_rows, false)}
        {!!d.prior_ar_rows.length && invTable('Prior-month invoices collected this month: relieves AR', d.prior_ar_rows, true)}
        {!!d.other_rows?.length && <>
          <div className="am-chart__head"><span className="am-chart__title">Other items that move AR</span><span className="am-chart__caption">{d.other_rows.length} item{d.other_rows.length === 1 ? '' : 's'}</span></div>
          <div style={{ overflowX: 'auto' }}><DataTable label="Other items that move AR" cols={[['Customer', false], ['What it is', false], ['Amount', true]]}
            rows={d.other_rows.map((r) => [r.allmoxy_customer_id != null ? custCell(r.allmoxy_customer_id, r.name) : r.name, <span key="l" style={{ display: 'inline-block', maxWidth: 420, whiteSpace: 'normal' }}>{r.label}</span>, money(r.amount)])}
            foot={[`Total · ${d.other_rows.length}`, '', money(d.other_total ?? sum(d.other_rows, (r) => r.amount))]} /></div>
        </>}
        <p className="am-card__text">Every open invoice across all history is in the AR aging table ({snap ? usd(snap.ar_total) : '—'} collectible).</p>
      </>;
    }
    if (sheet.kind === 'arAging') {
      return <DataTable label="AR aging, all invoices" cols={[['Customer', false], ['Service month', false], ['Amount', true], ['Status', false], ['Age (days)', true]]}
        rows={arShown.map((r) => [custCell(r.allmoxy_customer_id, r.name), mlabel(r.service_month), usd2(r.amount), arStatus(r), r.age_days.toLocaleString()])}
        foot={[`Total · ${arShown.length} invoices`, '', usd2(sum(arShown, (r) => r.amount)), '', '']} />;
    }
    const cols = sheet.key === 'all' ? COLS : COLS.filter((c) => c.k === sheet.key);
    const list = sheet.key === 'all' ? detailRows : detailRows.filter((r) => cols[0].get(r) !== 0).sort((a, b) => cols[0].get(b) - cols[0].get(a));
    if (!list.length) return <p className="am-card__text">No subscriptions in this part for {ml}.</p>;
    return <DataTable label={sheetTitle} cols={[['Customer', false], ...cols.map((c) => [c.label, true] as [string, boolean]), ['Status', false]]}
      rows={list.map((r) => [custCell(r.allmoxy_customer_id, r.name), ...cols.map((c) => usd2(c.get(r))), statusOf(r)])}
      foot={[`Total · ${list.length} subscriptions`, ...cols.map((c) => usd2(sum(list, c.get))), '']} />;
  };
  const arStatus = (r: ArRow) => r.collectible === false ? tag('Written off', 'neutral') : r.status === 'open' ? tag('Open', 'warning') : tag('Uncollectible', 'error');
  const openCol = (key: ColKey | 'all') => setSheet({ kind: 'col', key });

  const detailShown = showAllDetail ? detailRows : detailRows.slice(0, 25);
  const arTable = showAllAr ? arShown : arShown.slice(0, 25);

  return (
    <DsPage
      path="/revenue-recognition"
      title="Revenue Recognition"
      subtitle="Accrual (invoice basis) subscription revenue, billed by service period, with a month-end collection cutoff so Stripe reconciles to the bank. Drives the monthly QuickBooks journal entry and the AR aging you handle case by case."
      actions={
        <div className="am-row am-row--wrap">
          <Select label="Month" value={selMonth} width={170} options={reconMonths.slice().reverse().map((m) => [m, mlabel(m)])} onPick={setMonth} />
          <button className="am-btn am-btn--outlined" onClick={exportJe} disabled={!je}><Icon name="download" />Export this month</button>
          <button className="am-btn am-btn--outlined" onClick={exportAllJe} disabled={!snap?.journal_entries}><Icon name="download" />Export all months</button>
        </div>
      }
      overlays={sheet && <SideSheet open onClose={() => setSheet(null)} title={sheetTitle}
        text={sheet.kind === 'ar' ? `What makes up the 1200 line: invoices billed in ${ml} but unpaid at month-end (with their sales tax), less prior-month invoices collected this month.` : undefined}>{sheetBody()}</SideSheet>}
    >
      {error ? <p className="am-card__text">Could not load revenue recognition: {String(error)}</p> : null}
      {isLoading && <p className="am-card__text">Loading…</p>}

      <div className="am-row am-row--wrap">
        <span className="am-tag am-tag--info">Books basis go-live: {snap ? mlabel(snap.books_go_live) : '—'}</span>
        <span className="am-tag am-tag--neutral">Recognize by invoice date · collected if paid by month-end</span>
        <span className="am-tag am-tag--neutral">Invoices synced {snap?.invoices_fetched_at ? fmtDate(snap.invoices_fetched_at) : '—'}</span>
        {isPreGoLive && <span className="am-tag am-tag--warning">Reference only: {ml} is before the {snap ? mlabel(snap.books_go_live) : ''} go-live</span>}
        {!!snap?.data_quality?.invoices_missing_paid_at && <span className="am-tag am-tag--warning">{snap.data_quality.invoices_missing_paid_at} paid invoice(s) lack a Stripe paid date, assumed collected in their invoice month</span>}
      </div>

      {/* KPI strip: 6 cards → floor(1392/6) − 20 = 212px */}
      <div className="am-grid" style={{ ['--am-grid-min' as string]: '212px' }}>
        {row && <>
          <KpiCard label="Recognized (accrual)" value={usd(row.recognized)} hint="Billed by service period. The revenue to recognize in QuickBooks." onOpen={() => openCol('recognized')} />
          <KpiCard label="Collected in period" value={usd(row.collected_in_period)} hint="Of this month's billings, paid by the last day of the month" onOpen={() => openCol('collected_in_period')} />
          <KpiCard label="New AR at month-end" value={usd(row.outstanding_at_period_end)} hint="Billed, not cleared by cutoff = collected after + still open + not invoiced" onOpen={() => openCol('outstanding_at_period_end')}
            tag={row.outstanding_at_period_end > 0 ? 'Receivable to book' : 'None'} tagTone={row.outstanding_at_period_end > 0 ? 'info' : 'success'} />
          <KpiCard label="Collected after period" value={usd(row.collected_after_period)} hint="Of this month's billings, paid in a later month" onOpen={() => openCol('collected_after_period')} />
          <KpiCard label="Still open" value={usd(row.still_open)} hint="Never collected, as of today" onOpen={() => openCol('still_open')}
            tag={row.still_open > 0 ? 'Needs follow-up' : 'Clear'} tagTone={row.still_open > 0 ? 'error' : 'success'} />
          <KpiCard label="Not invoiced (carried)" value={usd(unbilledCarry)} hint="Live subscription recognized at its last rate, no invoice issued" onOpen={() => openCol('unbilled_carry')}
            tag={unbilledCarry > 0 ? 'No invoice issued' : 'Clear'} tagTone={unbilledCarry > 0 ? 'warning' : 'success'} />
        </>}
      </div>

      {/* Accrual bridge + Stripe balance report: 2 cards → floor(1392/2) − 20 = 676px */}
      {row && (
        <div className="am-grid" style={{ ['--am-grid-min' as string]: '600px' }}>
          <section className="am-card am-card--outlined">
            <div className="am-chart__head">
              <span className="am-chart__title">Accrual bridge · {ml}</span>
              <span className="am-chart__caption">Bank deposits (already in QuickBooks) are cash received; accrual revenue is recognized. The net adjustment is the change in AR.</span>
            </div>
            <div style={{ overflowX: 'auto' }}><DataTable label="Accrual bridge" cols={[['Line', false], ['Amount', true]]}
              rows={[
                ['Recognized subscription revenue (accrual)', usd2(row.recognized)],
                ['Less: cash received this month (bank deposits)', `(${usd2(row.cash_received)})`],
                ['· of which this month\'s billings collected in period', usd2(row.collected_in_period)],
                ['· of which prior-period AR collected this month', usd2(row.prior_ar_collected)],
              ]}
              clickable={(c) => c === 1} onCell={(r) => { if (r === 0) openCol('all'); else if (r === 2) openCol('collected_in_period'); else if (r === 3 && je?.ar_detail) setSheet({ kind: 'ar' }); }}
              foot={['Net accrual adjustment (Δ Accounts Receivable)', money(netAdj, true)]} /></div>
            <p className="am-card__text">= new AR at month-end {usd2(row.outstanding_at_period_end)} − prior AR collected {usd2(row.prior_ar_collected)}</p>
            <div className="am-row am-row--wrap">
              <span className="am-tag am-tag--info">Suggested entry (net)</span>
              {netAdj >= 0
                ? <span className="am-card__text">DR Accounts Receivable {usd2(netAdj)} · CR Subscription Revenue {usd2(netAdj)}</span>
                : <span className="am-card__text">DR Subscription Revenue {usd2(Math.abs(netAdj))} · CR Accounts Receivable {usd2(Math.abs(netAdj))}</span>}
            </div>
            <p className="am-card__text">Or book gross: DR AR / CR Revenue {usd2(row.outstanding_at_period_end)} for new receivables, and DR Cash / CR AR {usd2(row.prior_ar_collected)} for prior receivables collected. Confirm account mapping with your accountant.</p>
          </section>
          {je?.balance_report && (() => {
            const b = je.balance_report;
            const lines: Array<[string, number | null]> = [
              ['Starting balance', b.starting_balance], ['Charges (gross)', b.charges_gross], ['Refunds', b.refunds], ['Connect platform earnings', b.connect_earnings],
              ...(b.connect_refunds !== 0 ? [['Connect refunds', b.connect_refunds] as [string, number]] : []),
              ['Stripe fees', b.stripe_fees],
              ...(b.other_activity !== 0 ? [['Other activity', b.other_activity] as [string, number]] : []),
              ['Net activity', b.net_activity], ['Payouts to bank', -b.payouts],
            ];
            return (
              <section className="am-card am-card--outlined">
                <div className="am-chart__head">
                  <span className="am-chart__title">Stripe balance report · {ml} · US/Mountain</span>
                  <span className="am-chart__caption">Same frame as Stripe Reports, Balance: starting balance + activity − payouts = ending balance. Payouts is the DR 4200 gross-deposits line; ending − starting is the 1003 Stripe Account line.{!b.anchored ? ' Starting and ending balances appear once the sync captures the current Stripe balance.' : ''}</span>
                </div>
                <DataTable label="Stripe balance report" cols={[['Line', false], ['Amount', true]]}
                  rows={lines.map(([l, v]) => [l, v == null ? '—' : money(v)])}
                  foot={['Ending balance', b.ending_balance == null ? '—' : money(b.ending_balance)]} />
              </section>
            );
          })()}
        </div>
      )}

      {/* QuickBooks journal entry */}
      {je && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread">
            <div className="am-chart__head">
              <span className="am-chart__title">QuickBooks journal entry · {ml}</span>
              <span className="am-chart__caption">{je.lines.length} lines · built from {je.inputs.balance_txn_rows.toLocaleString()} Stripe balance transactions · recognized subscription revenue (ex-tax) {usd2(je.inputs.recognized_ex_tax)} · accrual adjustment {money(je.inputs.accrual_adjustment, true)} · sales tax on the {je.inputs.tax_basis_used} basis {usd2(je.inputs.tax_total_used)}</span>
            </div>
            {je.balanced ? tag(`Balanced · ${usd2(je.debits)}`, 'success') : tag(`Out of balance · Dr ${usd2(je.debits)} / Cr ${usd2(je.credits)}`, 'error')}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="QuickBooks journal entry" cols={[['#', false], ['Account', false], ['Debits', true], ['Credits', true], ['Description', false]]}
              rows={je.lines.flatMap((l, i) => {
                const head = i === 0 || je.lines[i - 1].group !== l.group;
                const [word, tone, note] = GROUP_LABEL[l.group];
                const isAr = l.group === 'accrual' && l.account.startsWith('1200');
                const line: ReactNode[] = [String(i + 1),
                  isAr && je.ar_detail ? <button key="ar" className="am-btn am-btn--text" onClick={() => setSheet({ kind: 'ar' })}>{l.account}<Icon name="open_in_new" /></button> : l.account,
                  l.debit != null ? usd2(l.debit) : '', l.credit != null ? usd2(l.credit) : '', l.description];
                return head ? [['', tag(word, tone), '', '', note], line] : [line];
              })}
              foot={['', 'Totals', usd2(je.debits), usd2(je.credits), je.balanced ? tag('Balanced', 'success') : tag(`Off by ${usd2(Math.abs(je.debits - je.credits))}`, 'error')]} />
          </div>
          {je.memo.map((m, i) => <p key={i} className="am-card__text">• {m}</p>)}
          <p className="am-card__text">
            • Direct/legacy subscription charges billed outside Stripe invoices (sandbox instances, extra domains, AI-token upgrades) are included in both MRR and recognized revenue.
            {row && wfEnding != null && (() => {
              const diff = Math.round((row.recognized - wfEnding) * 100) / 100;
              if (Math.abs(diff) < 0.01) return <> Recognized {usd2(row.recognized)} matches the Revenue Waterfall's accrual ending MRR for {ml} exactly.</>;
              return <> Recognized {usd2(row.recognized)} vs the Revenue Waterfall's accrual ending MRR {usd2(wfEnding)}: {money(diff, true)}. Duplicate records excluded from the logo count{excludedDupes.length ? ` (${excludedDupes.map((d) => `${d.name} ${usd(d.mrr)}`).join(', ')})` : ''} are recognized here because they were billed, but dropped from the waterfall so one business counts once.</>;
            })()}
            {je.inputs.direct_subscription_charges > 0 && <> Of these, {usd2(je.inputs.direct_subscription_charges)} is from Stripe customers with no roster record ({je.inputs.direct_rows.filter((d) => !d.mapped).map((d) => `${d.name} ${usd(d.amount)}`).join(', ')}) and is added here only; it can't sit on a per-customer series until those customers exist.</>}
          </p>
          <p className="am-card__text">Not in this entry: 4100 Annual Deferred Monthly is booked separately and shown as a memo so the P&amp;L ties.</p>
        </section>
      )}

      {/* What was supposed to process */}
      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">What was supposed to process · {ml}</span>
            <span className="am-chart__caption">{detailRows.length} subscriptions · {outstandingRows.length} outstanding at month-end ({usd(sum(outstandingRows, (r) => r.outstanding_at_period_end))}) · sorted by outstanding, then recognized · select a total to list its subscriptions</span>
          </div>
          <button className="am-btn am-btn--text" onClick={exportDetail}><Icon name="download" />CSV</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Subscriptions recognized this month"
            cols={[['Customer', false], ['Basis', false], ...COLS.map((c) => [c.label, true] as [string, boolean]), ['Status', false]]}
            rows={detailShown.map((r) => [custCell(r.allmoxy_customer_id, r.name), r.basis === 'invoice' ? tag('Invoice', 'info') : tag('Charge', 'neutral'), ...COLS.map((c) => usd2(c.get(r))), statusOf(r)])}
            foot={[`Total · ${detailRows.length} subscriptions`, '', ...COLS.map((c) => usd2(sum(detailRows, c.get))), '']}
            footClickable={(c) => c === 0 || (c >= 2 && c < 2 + COLS.length)}
            onFoot={(c) => (c === 0 ? openCol('all') : openCol(COLS[c - 2].k))} />
        </div>
        {!showAllDetail && detailRows.length > 25 && <button className="am-btn am-btn--text" onClick={() => setShowAllDetail(true)}>Show all {detailRows.length}</button>}
        {!isLoading && !detailRows.length && <p className="am-card__text">No subscriptions recognized in {ml}.</p>}
      </section>

      {/* AR aging */}
      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">AR aging · open and uncollectible invoices</span>
            <span className="am-chart__caption">{arRows.length} invoices · {snap ? usd(snap.ar_total) : '—'} collectible · {arRows.filter((r) => r.status === 'uncollectible').length} flagged uncollectible in Stripe · sorted by amount</span>
          </div>
          <button className="am-btn am-btn--text" onClick={exportAr}><Icon name="download" />CSV</button>
        </div>
        {snap?.ar_policy && snap.ar_policy.writeoff_after_days == null && (
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--info">Nothing is written off automatically</span>
            <span className="am-card__text">Every invoice stays in AR until it's marked uncollectible on Collections.
              {snap.ar_policy.written_off_total > 0 && <> {usd(snap.ar_policy.written_off_total)} across {snap.ar_policy.written_off_count} invoice{snap.ar_policy.written_off_count === 1 ? '' : 's'} has been marked uncollectible so far; {usd(snap.ar_policy.bookable_total)} of that books to 4950.</>}
              {snap.ar_policy.bad_debt_not_recognized && snap.ar_policy.bad_debt_not_recognized.total > 0 && <> Known bad debt billed {mlabel(snap.ar_policy.bad_debt_not_recognized.from)} to {mlabel(snap.ar_policy.bad_debt_not_recognized.through)} ({usd(snap.ar_policy.bad_debt_not_recognized.total)}, {snap.ar_policy.bad_debt_not_recognized.invoice_count} invoices) is not recognized as revenue at all: it is left out of subscription revenue, AR and sales tax on each month's entry, with no 4950 line.</>}
            </span>
            <button className="am-btn am-btn--text" onClick={() => navigate('/collections')}>Open Collections</button>
          </div>
        )}
        {snap?.ar_policy?.writeoff_after_days != null && (
          <p className="am-card__text">
            Anything past {snap.ar_policy.writeoff_after_days} days is treated as closed. {usd(snap.ar_policy.written_off_total)} across {snap.ar_policy.written_off_count} invoices is written off and excluded from the AR balance, leaving {usd(snap.ar_policy.open_total)} collectible ({snap.ar_policy.open_count} invoices).
            Of that, {usd(snap.ar_policy.bookable_total)} ({snap.ar_policy.bookable_count} invoices) is booked to 4950 Uncollectible Income; the other {usd(snap.ar_policy.pre_accrual_total)} ({snap.ar_policy.pre_accrual_count} invoices) predates the accrual books and is memo only. These invoices are still open in Stripe.
          </p>
        )}
        <Segmented label="Invoices shown" value={arFilter} onChange={(v) => { setArFilter(v); setShowAllAr(false); }}
          options={[['all', `All · ${arRows.length}`], ['collectible', `Collectible · ${arRows.filter((r) => r.collectible !== false).length}`], ['closed', `Written off · ${arRows.filter((r) => r.collectible === false).length}`]]} />
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="AR aging"
            cols={[['Customer', false], ['Invoice date', false], ['Service month', false], ['Amount', true], ['Status', false], ['Age (days)', true]]}
            rows={arTable.map((r) => [custCell(r.allmoxy_customer_id, r.name), fmtDate(r.invoice_date), mlabel(r.service_month), usd2(r.amount), arStatus(r), r.age_days.toLocaleString()])}
            foot={[`Total · ${arShown.length} invoices`, '', '', usd2(sum(arShown, (r) => r.amount)), '', '']}
            footClickable={(c) => c === 0 || c === 3} onFoot={() => setSheet({ kind: 'arAging' })} />
        </div>
        {!showAllAr && arShown.length > 25 && <button className="am-btn am-btn--text" onClick={() => setShowAllAr(true)}>Show all {arShown.length}</button>}
      </section>

      {/* Trend */}
      <ChartCard title="Recognized vs cash received" caption={`Recognized (accrual) against cash that reached the bank, with the new AR each month created (billings not cleared by month-end) · ${range.rangeText} · select a month to open it`}>
        {range.controls}
        <ColumnChart months={range.months} grouped legend fmt={usdk}
          series={[
            { key: 'rec', label: 'Recognized', tone: 'div-1', values: range.months.map((m) => snap!.by_month[m].recognized) },
            { key: 'cash', label: 'Cash received (bank)', tone: 'div-2', values: range.months.map((m) => snap!.by_month[m].cash_received) },
            { key: 'ar', label: 'New AR (uncollected at month-end)', tone: 'div-3', values: range.months.map((m) => snap!.by_month[m].outstanding_at_period_end) },
          ]}
          labelFor={(i) => usdk(snap!.by_month[range.months[i]].recognized)}
          tipRows={(i) => { const b = snap!.by_month[range.months[i]]; return [['Recognized', usd(b.recognized)], ['Cash received (bank)', usd(b.cash_received)], ['New AR', usd(b.outstanding_at_period_end)], ['Net accrual adjustment', money(b.recognized - b.cash_received, true)]]; }}
          onSegment={(i) => { const m = range.months[i]; if (reconMonths.includes(m)) { setMonth(m); window.scrollTo({ top: 0, behavior: 'smooth' }); } }}
          aria={`Recognized revenue, cash received and new AR by month, ${range.rangeText}.`} />
      </ChartCard>

      {!!snap?.orphan_stripe_customers?.length && (
        <div className="am-row am-row--wrap">
          <span className="am-tag am-tag--warning">{snap.orphan_stripe_customers.length} Stripe customer{snap.orphan_stripe_customers.length === 1 ? '' : 's'} with invoices but no customer profile</span>
          <span className="am-card__text">Counted in recognized totals but not in the per-customer table until mapped (stripe_id_overrides.json or a roster record): {snap.orphan_stripe_customers.map((o) => `${o.stripe_customer} (${usd(o.latest_mrr)}/mo)`).join(' · ')}</span>
        </div>
      )}
    </DsPage>
  );
}
