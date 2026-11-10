/**
 * AR Adjustments — every accounts-receivable movement the monthly QuickBooks entry posts,
 * summarized over a chosen period (Beau, 2026-11-09).
 *
 * Reads the same revenue_recognition snapshot as the Revenue Recognition page, so every
 * figure ties to the posted 1200 lines:
 *   accrual   ar_detail.by_account   (4000 / 4300 / 4420 + 4410 add-ons), itemized by
 *             new AR, prior AR collected and other items
 *   write-off the entry's 4950 / 1200 lines (A/R write-offs, November 2026 onward)
 *   memo      known bad debt left out of revenue (Jan–Oct 2026 audit policy) — never in AR
 * The month in progress is shown but kept out of the period totals.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, CustomerLink, DataTable, DsPage, Icon, KpiCard, KpiGrid, SideSheet,
  downloadCsv, mlabel, thisMonth, useMonthRange, usd,
} from '../design-system/parts';

type Acct = 'subscription' | 'services' | 'customdomain' | 'operatortokens';
type Part = { amount: number; tax: number };
type InvRow = { allmoxy_customer_id: number | null; name: string; invoice_id: string | null; invoice_date: string; amount: number; tax: number; by_account?: Partial<Record<Acct, Part>> };
type OtherRow = { allmoxy_customer_id: number | null; name: string; label: string; category: string; amount: number; invoice_id?: string | null; by_account?: Partial<Record<Acct, Part>> };
type ArDetail = { new_ar_rows: InvRow[]; prior_ar_rows: InvRow[]; other_rows?: OtherRow[]; total: number; by_account?: Partial<Record<Acct, number>> };
type JeLine = { account: string; debit: number | null; credit: number | null; group: string };
type Snap = {
  journal_entries?: Record<string, { lines: JeLine[]; ar_detail?: ArDetail }>;
  by_month?: Record<string, { bad_debt_not_recognized?: number }>;
  ar_aging?: Array<{ allmoxy_customer_id: number | null; name: string; invoice_id: string | null; invoice_date: string; amount: number; bookable_writeoff?: boolean; writeoff_month?: string | null }>;
  ar_policy?: { bad_debt_not_recognized?: { invoices: Array<{ allmoxy_customer_id: number | null; name: string; invoice_id: string | null; invoice_date: string; month: string; amount: number }> } | null } | null;
};

// Columns that move AR, plus the memo column (never in AR).
type Col = 'sub' | 'svc' | 'addon' | 'writeoff' | 'memo';
const COL_LABEL: Record<Col, string> = { sub: 'Subscription (4000)', svc: 'Services (4300)', addon: 'Add-ons (4420 / 4410)', writeoff: 'Written off (4950)', memo: 'Bad debt not recognized (memo)' };
type Kind = 'new' | 'prior' | 'other' | 'writeoff' | 'memo';
const KIND_LABEL: Record<Kind, string> = { new: 'Billed, unpaid at month end', prior: 'Earlier invoice collected', other: 'Other item', writeoff: 'Written off to 4950', memo: 'Known bad debt, not recognized' };

type Item = { month: string; kind: Kind; name: string; aid: number | null; invoice_id: string | null; what: string; sub: number; svc: number; addon: number; writeoff: number; memo: number };
type MonthRow = { month: string; sub: number; svc: number; addon: number; accrual: number; writeoff: number; net: number; memo: number; newAr: number; prior: number; other: number };

const r2 = (v: number) => Math.round(v * 100) / 100;
const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v: number) => (Math.abs(v) < 0.005 ? '—' : USD2.format(v));
const net = (i: Item) => r2(i.sub + i.svc + i.addon + i.writeoff);

export default function ArAdjustmentsDS() {
  const { data, isLoading, error } = useSheetTab('revenue_recognition');
  const snap = data as unknown as Snap | undefined;
  const cur = thisMonth();

  // Every itemized movement, every month.
  const { items, rows } = useMemo(() => {
    const items: Item[] = [];
    const rows: MonthRow[] = [];
    const je = snap?.journal_entries ?? {};
    const split = (by: Partial<Record<Acct, Part>> | undefined, fallback: number, sign = 1) => by
      ? { sub: sign * ((by.subscription?.amount ?? 0) + (by.subscription?.tax ?? 0)), svc: sign * ((by.services?.amount ?? 0) + (by.services?.tax ?? 0)),
          addon: sign * ((by.customdomain?.amount ?? 0) + (by.customdomain?.tax ?? 0) + (by.operatortokens?.amount ?? 0) + (by.operatortokens?.tax ?? 0)) }
      : { sub: fallback, svc: 0, addon: 0 };
    for (const m of Object.keys(je).sort()) {
      const d = je[m].ar_detail;
      if (!d) continue;
      const base = { month: m, writeoff: 0, memo: 0 };
      for (const r of d.new_ar_rows) items.push({ ...base, kind: 'new', name: r.name, aid: r.allmoxy_customer_id, invoice_id: r.invoice_id, what: `Invoice ${r.invoice_date}`, ...split(r.by_account, r.amount + r.tax) });
      // prior rows store collected amounts as positives; their by_account is already the (negative) movement
      for (const r of d.prior_ar_rows) items.push({ ...base, kind: 'prior', name: r.name, aid: r.allmoxy_customer_id, invoice_id: r.invoice_id, what: `Invoice ${r.invoice_date} paid`, ...split(r.by_account, -(r.amount + r.tax)) });
      for (const r of d.other_rows ?? []) items.push({ ...base, kind: 'other', name: r.name, aid: r.allmoxy_customer_id, invoice_id: r.invoice_id ?? null, what: r.label, ...split(r.by_account, r.amount) });
      for (const a of snap?.ar_aging ?? []) {
        if (!a.bookable_writeoff || a.writeoff_month !== m) continue;
        items.push({ ...base, kind: 'writeoff', name: a.name, aid: a.allmoxy_customer_id, invoice_id: a.invoice_id, what: `Invoice ${a.invoice_date} written off`, sub: 0, svc: 0, addon: 0, writeoff: -a.amount });
      }
      for (const b of snap?.ar_policy?.bad_debt_not_recognized?.invoices ?? []) {
        if (b.month !== m) continue;
        items.push({ ...base, kind: 'memo', name: b.name, aid: b.allmoxy_customer_id, invoice_id: b.invoice_id, what: `Invoice ${b.invoice_date} marked Write off`, sub: 0, svc: 0, addon: 0, memo: b.amount });
      }
      const ba = d.by_account ?? {};
      // Write-offs as posted: the 1200 credit on the entry's write-off lines.
      const wo = je[m].lines.filter((l) => l.group === 'writeoff' && l.account.startsWith('1200')).reduce((s, l) => s + (l.credit ?? 0) - (l.debit ?? 0), 0);
      const mItems = items.filter((i) => i.month === m);
      rows.push({
        month: m, sub: r2(ba.subscription ?? d.total), svc: r2(ba.services ?? 0), addon: r2((ba.customdomain ?? 0) + (ba.operatortokens ?? 0)),
        accrual: r2(d.total), writeoff: r2(-wo), net: r2(d.total - wo), memo: r2(snap?.by_month?.[m]?.bad_debt_not_recognized ?? 0),
        newAr: r2(mItems.filter((i) => i.kind === 'new').reduce((s, i) => s + net(i), 0)),
        prior: r2(mItems.filter((i) => i.kind === 'prior').reduce((s, i) => s + net(i), 0)),
        other: r2(mItems.filter((i) => i.kind === 'other').reduce((s, i) => s + net(i), 0)),
      });
    }
    return { items, rows };
  }, [snap]);

  const range = useMonthRange(rows.map((r) => r.month));
  const shown = rows.filter((r) => range.months.includes(r.month));
  const complete = shown.filter((r) => r.month < cur);         // the month in progress stays out of totals
  const tot = (k: keyof Omit<MonthRow, 'month'>) => r2(complete.reduce((s, r) => s + r[k], 0));
  const inProgress = shown.some((r) => r.month >= cur);

  // Drill-down: months × (column | kind)
  const [sheet, setSheet] = useState<{ title: string; months: string[]; col?: Col; kind?: Kind } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const open = (title: string, months: string[], f: { col?: Col; kind?: Kind } = {}) => { setShowAll(false); setSheet({ title, months, ...f }); };
  const sheetItems = useMemo(() => {
    if (!sheet) return [];
    const col = sheet.col;
    return items.filter((i) => sheet.months.includes(i.month)
      && (sheet.kind ? i.kind === sheet.kind : col === 'memo' ? i.kind === 'memo' : i.kind !== 'memo')
      && (!col || Math.abs(i[col]) >= 0.005))
      // One account clicked: show only that account's share of each item.
      .map((i) => (col && col !== 'memo'
        ? { ...i, sub: col === 'sub' ? i.sub : 0, svc: col === 'svc' ? i.svc : 0, addon: col === 'addon' ? i.addon : 0, writeoff: col === 'writeoff' ? i.writeoff : 0 }
        : i));
  }, [items, sheet]);
  const completeMonths = complete.map((r) => r.month);
  // Drill-downs from totals cover complete months only, so their titles say so.
  const completeText = completeMonths.length ? `${mlabel(completeMonths[0])} to ${mlabel(completeMonths[completeMonths.length - 1])}` : range.rangeText;

  const exportCsv = (list: Item[], name: string) => downloadCsv(name,
    ['Month', 'What moved AR', 'Customer', 'Allmoxy ID', 'Stripe invoice', 'Detail', 'Subscription (4000)', 'Services (4300)', 'Add-ons (4420/4410)', 'Written off (4950)', 'Net change in AR', 'Bad debt not recognized (memo)'],
    list.map((i) => [i.month, KIND_LABEL[i.kind], i.name, i.aid ?? '', i.invoice_id ?? '', i.what, i.sub, i.svc, i.addon, i.writeoff, net(i), i.memo]));

  const sheetCols: Array<[string, boolean]> = sheet?.col === 'memo' || sheet?.kind === 'memo'
    ? [['Month', false], ['Customer', false], ['What it is', false], ['Not recognized', true]]
    : [['Month', false], ['Customer', false], ['What it is', false], ['Subscription', true], ['Services', true], ['Add-ons', true], ['Written off', true], ['Net change in AR', true]];
  const isMemoSheet = sheetCols.length === 4;
  const cellsFor = (i: Item): ReactNode[] => {
    const head: ReactNode[] = [mlabel(i.month), i.aid != null ? <CustomerLink key="c" id={i.aid} name={i.name} /> : i.name,
      <span key="w" style={{ display: 'inline-block', maxWidth: 380, whiteSpace: 'normal' }}>{i.kind === 'other' ? i.what : `${KIND_LABEL[i.kind]} · ${i.what}`}</span>];
    return isMemoSheet ? [...head, money(i.memo)] : [...head, money(i.sub), money(i.svc), money(i.addon), money(i.writeoff), money(net(i))];
  };
  const sumOf = (list: Item[], f: (i: Item) => number) => r2(list.reduce((s, i) => s + f(i), 0));

  // Chart: AR movement per month by account; write-offs below zero.
  const chartSeries = [
    { key: 'sub', label: 'Subscription', tone: 'div-1', values: shown.map((r) => r.sub) },
    { key: 'svc', label: 'Services', tone: 'div-2', values: shown.map((r) => r.svc) },
    { key: 'addon', label: 'Add-ons', tone: 'other', values: shown.map((r) => r.addon) },
    { key: 'writeoff', label: 'Written off', tone: 'div-5', values: shown.map((r) => r.writeoff) },
  ];

  const tableCols: Array<[string, boolean]> = [['Month', false], ['Subscription', true], ['Services', true], ['Add-ons', true], ['Written off', true], ['Net change', true], ['New AR', true], ['Collected', true], ['Other', true], ['Not recog. (memo)', true]];
  const colKey: Array<Col | 'net' | 'newAr' | 'prior' | 'other' | null> = [null, 'sub', 'svc', 'addon', 'writeoff', 'net', 'newAr', 'prior', 'other', 'memo'];
  const openCell = (months: string[], c: number, label: string) => {
    const k = colKey[c];
    if (!k) return open(`Every AR movement · ${label}`, months);
    if (k === 'net') return open(`Net change in AR · ${label}`, months);
    if (k === 'newAr') return open(`New AR · ${label}`, months, { kind: 'new' });
    if (k === 'prior') return open(`Earlier AR collected · ${label}`, months, { kind: 'prior' });
    if (k === 'other') return open(`Other items · ${label}`, months, { kind: 'other' });
    return open(`${COL_LABEL[k]} · ${label}`, months, { col: k });
  };

  return (
    <DsPage
      path="/ar-adjustments"
      title="AR Adjustments"
      subtitle="Every accounts-receivable movement the monthly QuickBooks entry posts, by revenue account, for the period you choose. Ties to the 1200 lines on Revenue Recognition."
      actions={<button className="am-btn am-btn--outlined" onClick={() => exportCsv(items.filter((i) => range.months.includes(i.month)), `ar_adjustments_${range.months[0] ?? ''}_to_${range.months[range.months.length - 1] ?? ''}`)}><Icon name="download" />Export CSV</button>}
      overlays={sheet && (
        <SideSheet open onClose={() => setSheet(null)} title={sheet.title}>
          <p className="am-card__text">{sheetItems.length} item{sheetItems.length === 1 ? '' : 's'}{isMemoSheet ? ' · never posted to AR: left out of revenue under the Jan–Oct 2026 audit policy' : ''}.</p>
          <button className="am-btn am-btn--text" onClick={() => exportCsv(sheetItems, `ar_adjustments_detail_${sheet.months[0] ?? ''}_to_${sheet.months[sheet.months.length - 1] ?? ''}`)}><Icon name="download" />CSV</button>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label={sheet.title} cols={sheetCols}
              rows={sheetItems.map(cellsFor)}
              sortValues={sheetItems.map((i) => isMemoSheet ? [i.month, i.name, i.what, i.memo] : [i.month, i.name, i.what, i.sub, i.svc, i.addon, i.writeoff, net(i)])}
              limit={showAll ? undefined : 50}
              foot={isMemoSheet
                ? [`Total · ${sheetItems.length}`, '', '', money(sumOf(sheetItems, (i) => i.memo))]
                : [`Total · ${sheetItems.length}`, '', '', money(sumOf(sheetItems, (i) => i.sub)), money(sumOf(sheetItems, (i) => i.svc)), money(sumOf(sheetItems, (i) => i.addon)), money(sumOf(sheetItems, (i) => i.writeoff)), money(sumOf(sheetItems, net))]}
              onFoot={() => setShowAll(true)} footClickable={(c) => c === 0 && !showAll && sheetItems.length > 50} />
          </div>
          {!showAll && sheetItems.length > 50 && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {sheetItems.length}</button>}
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Failed to load revenue_recognition: {String(error)}</p> : null}
      <div className="am-row am-row--wrap">{range.controls}</div>

      <KpiGrid>
        <KpiCard label="Net change in AR" value={isLoading ? '…' : usd(tot('net'))} hint={`${range.rangeText}${inProgress ? ' · month in progress excluded' : ''}`}
          tag={tot('net') >= 0 ? 'AR grew' : 'AR shrank'} tagTone={tot('net') > 0 ? 'warning' : 'success'} onOpen={() => open(`Net change in AR · ${completeText}`, completeMonths)} />
        <KpiCard label="New AR" value={isLoading ? '…' : usd(tot('newAr'))} hint="Billed, unpaid at month end"
          tag="Added" tagTone="info" onOpen={() => open(`New AR · ${completeText}`, completeMonths, { kind: 'new' })} />
        <KpiCard label="Earlier AR collected" value={isLoading ? '…' : usd(tot('prior'))} hint="Earlier invoices paid in the period"
          tag="Cleared" tagTone="success" onOpen={() => open(`Earlier AR collected · ${completeText}`, completeMonths, { kind: 'prior' })} />
        <KpiCard label="Other items" value={isLoading ? '…' : usd(tot('other'))} hint="Catch-up payments, prepayments, carried-forward subscriptions"
          tag="Itemized" tagTone="neutral" onOpen={() => open(`Other items · ${completeText}`, completeMonths, { kind: 'other' })} />
        <KpiCard label="Written off (4950)" value={isLoading ? '…' : usd(tot('writeoff'))} hint="A/R write-offs, Nov 2026 onward"
          tag={tot('writeoff') < 0 ? 'Bad debt' : 'None'} tagTone={tot('writeoff') < 0 ? 'error' : 'neutral'} onOpen={() => open(`Written off · ${completeText}`, completeMonths, { col: 'writeoff' })} />
        <KpiCard label="Not recognized (memo)" value={isLoading ? '…' : usd(tot('memo'))} hint="Known bad debt kept out of revenue, never in AR"
          tag="Jan–Oct 2026" tagTone="neutral" onOpen={() => open(`Bad debt not recognized · ${completeText}`, completeMonths, { col: 'memo' })} />
      </KpiGrid>

      <ChartCard title="AR movement by account" caption={`${range.rangeText} · above zero adds to AR, below zero clears it · click a bar for its items`}>
        <ColumnChart months={shown.map((r) => r.month)} series={chartSeries} fmt={(v) => usd(v)} stacked legend aria="AR movement by account per month"
          tipRows={(i) => [['Net change in AR', money(shown[i].net)], ['New AR', money(shown[i].newAr)], ['Earlier AR collected', money(shown[i].prior)], ['Other items', money(shown[i].other)], ...(shown[i].month >= cur ? [['Status', 'In progress'] as [string, string]] : [])]}
          onSegment={(i, key) => openCell([shown[i].month], colKey.indexOf(key as Col), mlabel(shown[i].month))} />
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">By month</span>
          <span className="am-chart__caption">{range.rangeText} · click any amount for the invoices and items behind it{inProgress ? ' · the month in progress is shown but not in the total' : ''}</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="AR adjustments by month" cols={tableCols}
            rows={shown.map((r) => [r.month >= cur ? `${mlabel(r.month)} (in progress)` : mlabel(r.month), money(r.sub), money(r.svc), money(r.addon), money(r.writeoff), money(r.net), money(r.newAr), money(r.prior), money(r.other), money(r.memo)])}
            sortValues={shown.map((r) => [r.month, r.sub, r.svc, r.addon, r.writeoff, r.net, r.newAr, r.prior, r.other, r.memo])}
            clickable={(c) => c > 0} onCell={(i, c) => openCell([shown[i].month], c, mlabel(shown[i].month))}
            foot={[`Total · ${complete.length} mo`, money(tot('sub')), money(tot('svc')), money(tot('addon')), money(tot('writeoff')), money(tot('net')), money(tot('newAr')), money(tot('prior')), money(tot('other')), money(tot('memo'))]}
            onFoot={(c) => openCell(completeMonths, c, completeText)} footClickable={() => true} />
        </div>
      </section>
    </DsPage>
  );
}
