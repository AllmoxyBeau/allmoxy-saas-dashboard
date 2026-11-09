/**
 * Annual Amortization · Evidence Folder on the Allmoxy design system. Data logic is ported
 * verbatim from the classic page (AnnualAmortizationEvidence.tsx, kept at
 * /annual-amortization-evidence-classic): same annual_amortization_evidence snapshot, same
 * summary figures (recognized-to-date vs deferred split as of summary.as_of_month), a month cell
 * is "deferred" when it is later than as_of_month (the classic rule), and the same CSV export.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, CustomerLink, DataTable, DsPage, Icon, KpiCard, KpiGrid, Link, SideSheet,
  downloadCsv, mlabel, usd, usdk, useMonthRange,
} from '../design-system/parts';

type StripePayment = { created: string; amount: number; stripe_id: string | null; description: string };
type SyntheticPayment = { created: string; amount: number; payment_method: string; evidence: string | null; description: string; reason: string; added_by: string | null };
type Override = { origin_month: string; start_month: string; months: number; amount_match_min: number; amount_match_max: number; monthly_amortized: number; reason: string };
type AnnualizedMonth = { month: string; subscription: number };
type EvidenceEntry = {
  allmoxy_customer_id: number; customer_name: string; status: string | null; current_subscription_mrr: number | null;
  hubspot_company_id: string | null; billing_cadence: string; typical_annual_amount: number | null; typical_months: number;
  default_amortization_window: string; contract_signed_date: string | null; contract_link: string | null; evidence_files: string[];
  qb_treatment: string | null; notes: string | null; annualized_months: AnnualizedMonth[]; annualized_month_count: number;
  total_amortized_dollars: number; recognized_to_date_dollars?: number; recognized_month_count?: number;
  deferred_dollars?: number; deferred_month_count?: number;
  stripe_payments: StripePayment[]; stripe_payment_count: number; synthetic_payments: SyntheticPayment[]; synthetic_payment_count: number;
  overrides: Override[]; override_count: number; verified_by: string | null; verified_at: string | null;
};
type EvidenceSnapshot = {
  fetched_at: string; comment: string;
  summary: {
    annual_payer_count: number; total_amortized_dollars: number; total_annualized_months: number; as_of_month?: string;
    recognized_to_date_dollars?: number; recognized_month_count?: number; deferred_dollars?: number; deferred_month_count?: number;
    payers_with_overrides: number; payers_with_synthetic_payments: number; payers_with_contract_link: number; payers_verified: number;
  };
  entries: EvidenceEntry[];
};

const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) {
    const [, y, m, d] = iso.match(/^(\d{4})-(\d{2})-(\d{2})/) || [];
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return iso;
}
const statusTag = (s: string | null) => {
  const tone = s === 'active' ? 'success' : s === 'churned' ? 'error' : 'neutral';
  const word = s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Unknown';
  return <span className={`am-tag am-tag--${tone}`}>{word}</span>;
};
const MONTH_LIMIT = 15;
const TONES = ['div-1', 'div-2', 'other'];

type Cell = { customer_id: number; customer_name: string; month: string; amount: number; deferred: boolean };

function PayerCard({ e, asOf }: { e: EvidenceEntry; asOf?: string }) {
  const [showAllMonths, setShowAllMonths] = useState(false);
  const isDeferred = (m: string) => !!asOf && m > asOf;
  const payments = [
    ...e.stripe_payments.map((p) => ({ date: p.created, method: 'Stripe', stripe: true, amount: p.amount, ref: p.stripe_id ?? '—', text: p.description })),
    ...e.synthetic_payments.map((p) => ({ date: p.created, method: p.payment_method ?? 'off-Stripe', stripe: false, amount: p.amount, ref: p.evidence ?? '(none on file)', text: p.reason })),
  ];
  const payTotal = payments.reduce((s, p) => s + p.amount, 0);
  const recognized = e.recognized_to_date_dollars;
  return (
    <section className="am-card am-card--outlined">
      <div className="am-row am-row--spread" style={{ alignItems: 'flex-start' }}>
        <div className="am-chart__head">
          <span className="am-chart__title"><CustomerLink id={e.allmoxy_customer_id} name={e.customer_name} /></span>
          <span className="am-chart__caption">
            Current MRR (amortized): {USD2.format(e.current_subscription_mrr ?? 0)} · Billing cadence: {e.billing_cadence} · Typical annual: {e.typical_annual_amount ? usd(e.typical_annual_amount) : '—'} · Default window: {e.default_amortization_window}
          </span>
          <div className="am-row am-row--wrap am-row--tight">
            {statusTag(e.status)}
            {e.verified_by
              ? <span className="am-tag am-tag--success">Verified {e.verified_by}{e.verified_at ? ` · ${fmtDate(e.verified_at)}` : ''}</span>
              : <span className="am-tag am-tag--warning">Not verified</span>}
            <span className={`am-tag am-tag--${e.contract_link ? 'success' : 'warning'}`}>{e.contract_link ? 'Contract on file' : 'No contract on file'}</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className="am-card__text">{recognized != null ? `Recognized through ${asOf ? mlabel(asOf) : 'last complete month'}` : 'Total amortized into MRR'}</span>
          <p className="am-summary__value">{usd(recognized ?? e.total_amortized_dollars)}</p>
          <p className="am-card__text">
            {recognized != null
              ? `${e.recognized_month_count} month-cells · + ${usd(e.deferred_dollars ?? 0)} deferred (${e.deferred_month_count} future)`
              : `${e.annualized_month_count} month-cells`}
          </p>
        </div>
      </div>

      {e.notes && <p className="am-card__text"><b>Note.</b> {e.notes}</p>}
      {e.qb_treatment && <p className="am-card__text"><b>QuickBooks treatment.</b> {e.qb_treatment}</p>}

      <div className="am-chart__head">
        <span className="am-chart__title">Source payments ({e.stripe_payment_count + e.synthetic_payment_count})</span>
        <span className="am-chart__caption">{e.stripe_payment_count} Stripe + {e.synthetic_payment_count} off-Stripe. Stripe payments of $3,000 or more (the amortization threshold) and any off-Stripe payments (mailed checks, wires, ACH) captured via synthetic_transactions.json. Their total should roughly equal the dollars amortized into the MRR series.</span>
      </div>
      {payments.length === 0 ? <p className="am-card__text">No source payments recorded.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <DataTable label={`Source payments for ${e.customer_name}`}
            cols={[['Date', false], ['Method', false], ['Amount', true], ['Stripe ID / evidence', false], ['Description / reason', false]]}
            rows={payments.map((p) => [
              fmtDate(p.date),
              <span key="m" className={`am-tag am-tag--${p.stripe ? 'info' : 'neutral'}`}>{p.stripe ? 'Stripe' : p.method.charAt(0).toUpperCase() + p.method.slice(1)}</span>,
              USD2.format(p.amount),
              <code key="r">{p.ref}</code>,
              <span key="t" style={{ display: 'block', minWidth: 280, maxWidth: 520, whiteSpace: 'normal' }}>{p.text}</span>,
            ])}
            sortValues={payments.map((p) => [p.date, p.method, p.amount, p.ref, p.text])}
            foot={[`Total · ${payments.length} payments`, '', USD2.format(payTotal), '', '']} />
        </div>
      )}

      {e.override_count > 0 && <>
        <div className="am-chart__head">
          <span className="am-chart__title">Custom amortization windows ({e.override_count})</span>
          <span className="am-chart__caption">Windows that override the default (12 months forward) for specific payments, used when a payment covers a non-standard period (for example 15 months, or backdated coverage).</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label={`Custom windows for ${e.customer_name}`}
            cols={[['Origin month', false], ['Start month', false], ['Months', true], ['Amount range', true], ['$/month', true], ['Reason', false]]}
            rows={e.overrides.map((o) => [o.origin_month, o.start_month, o.months, `${usd(o.amount_match_min)} – ${usd(o.amount_match_max)}`, USD2.format(o.monthly_amortized),
              <span key="r" style={{ display: 'block', minWidth: 280, maxWidth: 480, whiteSpace: 'normal' }}>{o.reason}</span>])}
            sortValues={e.overrides.map((o) => [o.origin_month, o.start_month, o.months, o.amount_match_min, o.monthly_amortized, o.reason])} />
        </div>
      </>}

      <div className="am-chart__head">
        <span className="am-chart__title">Realized amortization on MRR series ({e.annualized_month_count} months)</span>
        <span className="am-chart__caption">
          {e.annualized_month_count} monthly cells totaling {usd(e.total_amortized_dollars)}{e.deferred_month_count ? ` (${e.deferred_month_count} future months not yet recognized)` : ''}. The cells in monthly_history flagged as annualized: the dollars flowing into the MRR series. Newest first.
        </span>
      </div>
      <DataTable label={`Realized amortization for ${e.customer_name}`}
        cols={[['Month', false], ['Status', false], ['Amortized $', true]]}
        rows={e.annualized_months.map((m) => [mlabel(m.month),
          isDeferred(m.month) ? <span key="s" className="am-tag am-tag--info">Deferred</span> : <span key="s" className="am-tag am-tag--success">Recognized</span>,
          USD2.format(m.subscription)])}
        sortValues={e.annualized_months.map((m) => [m.month, isDeferred(m.month) ? 'deferred' : 'recognized', m.subscription])}
        defaultSort={{ col: 0, dir: 'desc' }}
        limit={showAllMonths ? undefined : MONTH_LIMIT}
        foot={[`Total · ${e.annualized_month_count} months`, recognized != null ? `${usd(recognized)} recognized · ${usd(e.deferred_dollars ?? 0)} deferred` : '', USD2.format(e.total_amortized_dollars)]}
        onFoot={() => setShowAllMonths(true)} footClickable={(c) => (c === 0 || c === 2) && !showAllMonths && e.annualized_months.length > MONTH_LIMIT} />
      {!showAllMonths && e.annualized_months.length > MONTH_LIMIT && (
        <button className="am-btn am-btn--text" onClick={() => setShowAllMonths(true)}>Show all {e.annualized_months.length}</button>
      )}

      <div className="am-chart__head">
        <span className="am-chart__title">Contract and supporting evidence</span>
      </div>
      <p className="am-card__text">
        Contract: {e.contract_link
          ? <Link href={e.contract_link}>{e.contract_link}</Link>
          : <>none uploaded yet — add to <code>annual_payers.json</code> → payer_details → contract_link</>}
        {e.contract_signed_date && ` · signed ${fmtDate(e.contract_signed_date)}`}
      </p>
      {e.evidence_files.length > 0 && <p className="am-card__text">Files: {e.evidence_files.join(', ')}</p>}
    </section>
  );
}

export default function AnnualAmortizationEvidenceDS() {
  const { data, isLoading, error } = useSheetTab('annual_amortization_evidence');
  const snap = data as unknown as EvidenceSnapshot | undefined;
  const entries = useMemo(() => snap?.entries ?? [], [snap]);
  const s = snap?.summary;
  const asOf = s?.as_of_month;
  const hasSplit = s?.recognized_to_date_dollars != null;
  const [sheet, setSheet] = useState<null | 'recognized' | 'deferred' | 'all'>(null);
  const [showAllCells, setShowAllCells] = useState(false);

  // Same flattening as the classic CSV.
  const flatRows = useMemo(() => entries.flatMap((e) => e.annualized_months.map((m) => ({
    customer_id: e.allmoxy_customer_id, customer_name: e.customer_name, month: m.month, amortized_dollars: m.subscription,
    verified_by: e.verified_by, contract_on_file: e.contract_link ? 'yes' : 'no',
  }))), [entries]);
  const exportCsv = () => downloadCsv('annual_amortization_realized_months',
    ['Allmoxy ID', 'Customer', 'Month', 'Amortized $', 'Verified by', 'Contract on file?'],
    flatRows.map((r) => [r.customer_id, r.customer_name, r.month, r.amortized_dollars, r.verified_by ?? '', r.contract_on_file]));

  const cells: Cell[] = useMemo(() => entries.flatMap((e) => e.annualized_months.map((m) => ({
    customer_id: e.allmoxy_customer_id, customer_name: e.customer_name, month: m.month, amount: m.subscription, deferred: !!asOf && m.month > asOf,
  }))), [entries, asOf]);

  // Chart: amortized dollars per month, one series per payer; deferred months are titled as such.
  const allMonths = useMemo(() => [...new Set(cells.map((c) => c.month))].sort(), [cells]);
  const range = useMonthRange(allMonths);
  const series = useMemo(() => entries.map((e, k) => ({
    key: String(e.allmoxy_customer_id), label: e.customer_name, tone: TONES[Math.min(k, TONES.length - 1)],
    values: range.months.map((m) => e.annualized_months.filter((x) => x.month === m).reduce((t, x) => t + x.subscription, 0)),
  })), [entries, range.months]);
  const rangeRec = cells.filter((c) => !c.deferred && range.months.includes(c.month)).reduce((t, c) => t + c.amount, 0);
  const rangeDef = cells.filter((c) => c.deferred && range.months.includes(c.month)).reduce((t, c) => t + c.amount, 0);

  const sheetCells = sheet === 'recognized' ? cells.filter((c) => !c.deferred) : sheet === 'deferred' ? cells.filter((c) => c.deferred) : cells;
  const sheetTotal = sheetCells.reduce((t, c) => t + c.amount, 0);
  const allVerified = (s?.payers_verified ?? 0) === (s?.annual_payer_count ?? 0);
  const allContracts = (s?.payers_with_contract_link ?? 0) === (s?.annual_payer_count ?? 0);

  return (
    <DsPage
      path="/annual-amortization-evidence"
      title="Annual Amortization · Evidence Folder"
      subtitle="Per annual payer: the source payment trace (Stripe or check), realized amortization on the MRR series, custom override windows, QuickBooks treatment, and the verification trail. A quality-of-earnings reviewer should be able to answer “prove every annualized dollar” from this page alone."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!flatRows.length}><Icon name="download" />Export CSV</button>}
      overlays={
        <SideSheet open={!!sheet} onClose={() => setSheet(null)}
          title={sheet === 'recognized' ? `Recognized through ${asOf ? mlabel(asOf) : ''}` : sheet === 'deferred' ? 'Deferred to future months' : 'Every scheduled month-cell'}
          text={`${sheetCells.length} month-cells · ${usd(sheetTotal)}`}>
          <DataTable label="Month-cells"
            cols={[['Customer', false], ['Month', false], ['Status', false], ['Amortized $', true]]}
            rows={sheetCells.map((c) => [<CustomerLink key="c" id={c.customer_id} name={c.customer_name} />, mlabel(c.month),
              c.deferred ? <span key="s" className="am-tag am-tag--info">Deferred</span> : <span key="s" className="am-tag am-tag--success">Recognized</span>,
              USD2.format(c.amount)])}
            sortValues={sheetCells.map((c) => [c.customer_name, c.month, c.deferred ? 'deferred' : 'recognized', c.amount])}
            defaultSort={{ col: 1, dir: 'desc' }}
            limit={showAllCells ? undefined : 25}
            foot={[`Total · ${sheetCells.length} cells`, '', '', USD2.format(sheetTotal)]}
            onFoot={() => setShowAllCells(true)} footClickable={(c) => (c === 0 || c === 3) && !showAllCells && sheetCells.length > 25} />
          {!showAllCells && sheetCells.length > 25 && <button className="am-btn am-btn--text" onClick={() => setShowAllCells(true)}>Show all {sheetCells.length}</button>}
        </SideSheet>
      }
    >
      {error ? <p className="am-card__text">Failed to load annual_amortization_evidence: {String(error)}</p> : null}

      {/* Cards as an array, not a fragment, so KpiGrid counts each one as its own column. */}
      <KpiGrid>
        {hasSplit ? [
          <KpiCard key="rec" label={`Recognized through ${asOf ? mlabel(asOf) : ''}`} value={isLoading ? '…' : usd(s!.recognized_to_date_dollars!)}
            hint={`${s!.recognized_month_count} month-cells · ${usd(s!.total_amortized_dollars)} scheduled in all`}
            tag="Recognized" tagTone="success" onOpen={() => { setShowAllCells(false); setSheet('recognized'); }} />,
          <KpiCard key="def" label="Deferred to future months" value={isLoading ? '…' : usd(s!.deferred_dollars ?? 0)}
            hint={`${s!.deferred_month_count} future month-cells, not yet recognized`}
            tag="Deferred" tagTone="info" onOpen={() => { setShowAllCells(false); setSheet('deferred'); }} />,
        ] : (
          <KpiCard label="Dollars amortized" value={isLoading ? '…' : usd(s?.total_amortized_dollars ?? 0)}
            hint={`Across ${s?.total_annualized_months ?? 0} month-cells`} onOpen={() => { setShowAllCells(false); setSheet('all'); }} />
        )}
        <KpiCard label="Annual payers" value={isLoading ? '…' : String(s?.annual_payer_count ?? 0)} hint="Customers paying annually upfront"
          tag={`${s?.payers_with_overrides ?? 0} with custom window`} tagTone="neutral" />
        <KpiCard label="Verified" value={isLoading ? '…' : `${s?.payers_verified ?? 0}/${s?.annual_payer_count ?? 0}`} hint="QoE sign-off complete"
          tag={allVerified ? 'Complete' : 'Needs sign-off'} tagTone={allVerified ? 'success' : 'warning'} />
        <KpiCard label="Contracts on file" value={isLoading ? '…' : `${s?.payers_with_contract_link ?? 0}/${s?.annual_payer_count ?? 0}`} hint="Signed contract linked as evidence"
          tag={allContracts ? 'Complete' : 'Missing'} tagTone={allContracts ? 'success' : 'warning'} />
        <KpiCard label="Off-Stripe payments" value={isLoading ? '…' : String(s?.payers_with_synthetic_payments ?? 0)} hint="Payers with checks / wires / ACH"
          tag="Manual capture" tagTone="neutral" />
      </KpiGrid>

      {snap && s && (
        <section className="am-card am-card--outlined">
          <div className="am-row">
            <span className={`am-tag am-tag--${allVerified && allContracts ? 'success' : 'warning'}`} style={{ flexShrink: 0 }}>
              {allVerified && allContracts ? 'Evidence complete' : 'Evidence gaps'}
            </span>
            <p className="am-card__text">
              <b>{s.annual_payer_count} annual payer(s)</b> · <b>{usd(s.total_amortized_dollars)}</b> scheduled into the MRR series across <b>{s.total_annualized_months}</b> monthly cells
              {hasSplit && <> — <b>{usd(s.recognized_to_date_dollars!)}</b> recognized through {asOf ? mlabel(asOf) : ''} ({s.recognized_month_count} cells) and <b>{usd(s.deferred_dollars ?? 0)}</b> deferred to future months ({s.deferred_month_count} cells)</>}.
              {' '}{s.payers_verified}/{s.annual_payer_count} verified · {s.payers_with_contract_link}/{s.annual_payer_count} have a contract on file.
              {' '}Last refreshed: {new Date(snap.fetched_at).toLocaleString()}.
            </p>
          </div>
        </section>
      )}

      {!isLoading && allMonths.length > 0 && (
        <ChartCard title="Amortized dollars by month"
          caption={`One column per month, stacked by payer · months after ${asOf ? mlabel(asOf) : 'the last complete month'} are deferred (not yet recognized) · ${range.rangeText}: ${usd(rangeRec)} recognized, ${usd(rangeDef)} deferred`}>
          {range.controls}
          <ColumnChart months={range.months} series={series} fmt={usdk} stacked legend
            aria="Amortized dollars by month, stacked by annual payer"
            catTitle={(m) => `${mlabel(m)}${asOf && m > asOf ? ' (deferred)' : ''}`}
            tipRows={(i) => [
              ...series.map((x) => [x.label, USD2.format(x.values[i])] as [string, string]),
              ['Total', USD2.format(series.reduce((t, x) => t + x.values[i], 0))],
              ['Status', asOf && range.months[i] > asOf ? 'Deferred' : 'Recognized'],
            ]} />
        </ChartCard>
      )}

      {isLoading ? <p className="am-card__text">Loading evidence…</p> : entries.map((e) => <PayerCard key={e.allmoxy_customer_id} e={e} asOf={asOf} />)}

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Adding evidence for a new annual payer</span>
        </div>
        <ol className="am-card__text" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Add the customer's <code>allmoxy_customer_id</code> to <code>src/data/annual_payers.json → annual_payer_ids</code>.</li>
          <li>Add a per-customer entry under <code>payer_details</code> in the same file with: <code>typical_annual_amount</code>, <code>typical_months</code>, <code>qb_treatment</code>, <code>contract_link</code>, <code>verified_by</code>, <code>verified_at</code>, and any <code>notes</code>.</li>
          <li>If the payment covers a non-standard window, add an override to <code>_etl_scripts/annual_amortization_overrides.json</code>.</li>
          <li>If they pay outside Stripe (check, wire, ACH), add a synthetic transaction to <code>_etl_scripts/synthetic_transactions.json</code>.</li>
          <li>Re-run <code>node _etl_scripts/refresh_all.mjs</code>.</li>
        </ol>
      </section>
    </DsPage>
  );
}
