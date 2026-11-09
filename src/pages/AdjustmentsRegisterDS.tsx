/**
 * Adjustments Register on the Allmoxy design system. Data logic is ported verbatim from the
 * classic page (AdjustmentsRegister.tsx, kept at /adjustments-register-classic): same
 * adjustments_register snapshot, same severity / category filters, same stats (distinct
 * customers across ALL rows, source files derived from the register itself, sum of |delta|
 * over monetary rows), and the same CSV columns and filename.
 */
import { useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { CustomerLink, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, Select, SideSheet, downloadCsv, usd } from '../design-system/parts';

type Category =
  | 'annual_payer_flag' | 'amortization' | 'variance' | 'reclassification' | 'hygiene_stripe_id'
  | 'hygiene_connect_mapping' | 'synthetic_transaction' | 'status_override' | 'never_paid_classification';
type Adjustment = {
  id: string; category: Category; severity: 'monetary' | 'hygiene';
  customer_name: string | null; customer_id: number | null; period: string | null; txn_date: string | null;
  before: number | null; after: number | null; delta: number | null;
  reason: string; evidence: string | null; source_file: string; added_by: string | null;
};
type RegisterSnapshot = {
  fetched_at: string; comment: string;
  totals: { total: number; by_category: Record<string, number>; by_severity: Record<string, number> };
  adjustments: Adjustment[];
};

const CATEGORY_LABEL: Record<Category, string> = {
  annual_payer_flag: 'Annual payer flag',
  amortization: 'Amortization',
  variance: 'Variance carry-forward',
  reclassification: 'Stream reclassification',
  hygiene_stripe_id: 'Stripe ID hygiene',
  hygiene_connect_mapping: 'Connect mapping hygiene',
  synthetic_transaction: 'Off-Stripe payment',
  status_override: 'Status override',
  never_paid_classification: 'Never-paid auto-classify',
};
const SEVERITY: Record<Adjustment['severity'], { label: string; tone: 'info' | 'neutral' }> = {
  monetary: { label: 'Dollar impact', tone: 'info' },
  hygiene: { label: 'Hygiene only', tone: 'neutral' },
};

const fmtDelta = (d: number | null) => (d == null ? '—' : (d > 0 ? '+' : '') + usd(d));
const shortFile = (f: string) => f.replace('_etl_scripts/', '').replace('src/data/', '');
const LIMIT = 25;
const REASON_PREVIEW = 200;

export default function AdjustmentsRegisterDS() {
  const { data, isLoading, error } = useSheetTab('adjustments_register');
  const snap = data as unknown as RegisterSnapshot | undefined;

  const [filterSeverity, setFilterSeverityRaw] = useState<'all' | 'monetary' | 'hygiene'>('all');
  const [filterCategory, setFilterCategoryRaw] = useState<string>('all');
  const [showAll, setShowAll] = useState(false);
  const [help, setHelp] = useState(false);
  const [detail, setDetail] = useState<Adjustment | null>(null);
  const [deltaSheet, setDeltaSheet] = useState(false);
  const [order, setOrder] = useState<number[] | null>(null);
  const setFilterSeverity = (v: 'all' | 'monetary' | 'hygiene') => { setFilterSeverityRaw(v); setShowAll(false); };
  const setFilterCategory = (v: string) => { setFilterCategoryRaw(v); setShowAll(false); };

  const rows = useMemo(() => snap?.adjustments ?? [], [snap]);

  const filtered = useMemo(() => {
    let out = rows;
    if (filterSeverity !== 'all') out = out.filter((r) => r.severity === filterSeverity);
    if (filterCategory !== 'all') out = out.filter((r) => r.category === filterCategory);
    return out;
  }, [rows, filterSeverity, filterCategory]);

  // Aggregate dollar impact of monetary adjustments (sum of absolute deltas), as the classic page.
  const stats = useMemo(() => {
    const monetary = rows.filter((r) => r.severity === 'monetary');
    let absDelta = 0;
    let nWithDelta = 0;
    for (const r of monetary) {
      if (typeof r.delta === 'number') { absDelta += Math.abs(r.delta); nWithDelta++; }
    }
    // Distinct customers across ALL adjustments (monetary + hygiene).
    const nCustomers = new Set(rows.map((r) => r.customer_name).filter(Boolean));
    // Source files are derived from the register itself, never hard-coded.
    const sourceFiles = [...new Set(rows.map((r) => r.source_file).filter(Boolean))];
    return {
      sourceFiles, total: rows.length, monetary: monetary.length, hygiene: rows.length - monetary.length,
      absDelta, nWithDelta, nCustomers: nCustomers.size, nEvidence: rows.filter((r) => !!r.evidence).length,
    };
  }, [rows]);

  const distinctCategories = useMemo(() => [...new Set(rows.map((r) => r.category))], [rows]);

  const netDelta = filtered.reduce((s, r) => s + (r.delta ?? 0), 0);
  const quantified = filtered.filter((r) => typeof r.delta === 'number');

  const exportCsv = () => {
    // Follows the table's header sort when one is picked.
    const list = order && order.length === filtered.length ? order.map((i) => filtered[i]) : filtered;
    downloadCsv(`adjustments_register${filterSeverity !== 'all' ? `_${filterSeverity}` : ''}${filterCategory !== 'all' ? `_${filterCategory}` : ''}`,
      ['ID', 'Category', 'Severity', 'Customer', 'Allmoxy ID', 'Period', 'Transaction date', 'Before $', 'After $', 'Delta $', 'Reason', 'Source file', 'Added / updated'],
      list.map((r) => [r.id, r.category, r.severity, r.customer_name ?? '', r.customer_id ?? '', r.period ?? '', r.txn_date ?? '',
        r.before == null ? '' : r.before, r.after == null ? '' : r.after, r.delta == null ? '' : r.delta, r.reason, r.source_file, r.added_by ?? '']));
  };

  const customerCell = (r: Adjustment) => r.customer_name
    ? (r.customer_id != null ? <CustomerLink id={r.customer_id} name={r.customer_name} /> : r.customer_name)
    : <span className="am-tag am-tag--neutral">Global</span>;

  return (
    <DsPage
      path="/adjustments-register"
      title="Adjustments Register"
      subtitle="Every override or adjustment made to raw source data, consolidated from the underlying config files. A quality-of-earnings reviewer should be able to answer “give me every adjustment you made to the raw data” from this page alone."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!filtered.length}><Icon name="download" />Export CSV</button>}
      overlays={<>
        <SideSheet open={help} onClose={() => setHelp(false)} title="How to read the register">
          <p className="am-card__text"><b>What it is.</b> Every adjustment made to raw source data, consolidated from {stats.sourceFiles.length} underlying config files into one auditable register.</p>
          <p className="am-card__text"><b>Dollar impact</b> rows move dollars between periods or streams (annual amortization, variance carry-forwards, stream reclassifications). <b>Hygiene only</b> rows fix attribution (which Stripe ID belongs to which customer, and so on) without changing dollar totals.</p>
          <p className="am-card__text"><b>Source file</b> on each row points to the underlying config file in the repo. Open that file to see the raw entry and any change history.</p>
        </SideSheet>
        <SideSheet open={!!detail} onClose={() => setDetail(null)} title={detail ? `${CATEGORY_LABEL[detail.category]} · ${detail.customer_name ?? 'Global'}` : ''}>
          {detail && <>
            <div className="am-row am-row--wrap">
              <span className={`am-tag am-tag--${SEVERITY[detail.severity].tone}`}>{SEVERITY[detail.severity].label}</span>
              <span className={`am-tag am-tag--${detail.evidence ? 'success' : 'warning'}`}>{detail.evidence ? 'Evidence on file' : 'No evidence link'}</span>
            </div>
            <DataTable label="Adjustment detail" cols={[['Field', false], ['Value', false]]} rows={[
              ['ID', detail.id],
              ['Customer', customerCell(detail)],
              ['Allmoxy ID', detail.customer_id ?? '—'],
              ['Period', detail.period ?? '—'],
              ['Transaction date', detail.txn_date ?? '—'],
              ['Before', detail.before != null ? usd(detail.before) : '—'],
              ['After', detail.after != null ? usd(detail.after) : '—'],
              ['Change', fmtDelta(detail.delta)],
              ['Evidence', detail.evidence ?? '—'],
              ['Source file', detail.source_file],
              ['Added / updated', detail.added_by ?? '—'],
            ]} />
            <p className="am-card__text"><b>Reason.</b> {detail.reason}</p>
          </>}
        </SideSheet>
        <SideSheet open={deltaSheet} onClose={() => setDeltaSheet(false)} title={`Quantified adjustments · ${quantified.length}`}
          text={`Every adjustment in this view with a dollar change. Net ${fmtDelta(netDelta)}; absolute shift ${usd(quantified.reduce((s, r) => s + Math.abs(r.delta ?? 0), 0))}.`}>
          <DataTable label="Quantified adjustments" cols={[['Category', false], ['Customer', false], ['Period', false], ['Change', true]]}
            rows={quantified.map((r) => [CATEGORY_LABEL[r.category], customerCell(r), r.period ?? r.txn_date ?? '—', fmtDelta(r.delta)])}
            sortValues={quantified.map((r) => [CATEGORY_LABEL[r.category], r.customer_name ?? '', r.period ?? r.txn_date ?? '', r.delta])}
            foot={[`Net · ${quantified.length}`, '', '', fmtDelta(netDelta)]} />
        </SideSheet>
      </>}
    >
      {error ? <p className="am-card__text">Failed to load adjustments_register: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="Total adjustments" value={isLoading ? '…' : String(stats.total)} hint={`${stats.nCustomers} distinct customers affected`}
          tag={`${stats.nEvidence}/${stats.total} with evidence`} tagTone={stats.nEvidence === stats.total ? 'success' : 'warning'}
          onOpen={() => setFilterSeverity('all')} />
        <KpiCard label="Monetary adjustments" value={isLoading ? '…' : String(stats.monetary)} hint="Move dollars between periods or streams"
          tag="Dollar impact" tagTone="info" onOpen={() => setFilterSeverity('monetary')} />
        <KpiCard label="Total absolute $ shift" value={isLoading ? '…' : usd(stats.absDelta)} hint={`Sum of |change| across ${stats.nWithDelta} quantified adjustments`}
          tag={`${stats.nWithDelta} quantified`} tagTone="neutral" onOpen={() => { setFilterSeverity('monetary'); setFilterCategory('all'); setDeltaSheet(true); }} />
        <KpiCard label="Hygiene adjustments" value={isLoading ? '…' : String(stats.hygiene)} hint="Attribution fixes — no $ impact"
          tag="Hygiene only" tagTone="neutral" onOpen={() => setFilterSeverity('hygiene')} />
      </KpiGrid>

      {snap && (
        <section className="am-card am-card--outlined">
          <div className="am-row">
            <span className="am-tag am-tag--info" style={{ flexShrink: 0 }}>{stats.sourceFiles.length} source file{stats.sourceFiles.length === 1 ? '' : 's'}</span>
            <p className="am-card__text">
              <b>{stats.total} adjustments</b> consolidated from {stats.sourceFiles.length} source file{stats.sourceFiles.length === 1 ? '' : 's'}
              {' '}({stats.sourceFiles.map((f, i) => <span key={f}>{i > 0 ? ', ' : ''}<code>{f.split('/').pop()}</code></span>)}).
              {' '}<b>{stats.monetary}</b> have a dollar impact; <b>{stats.hygiene}</b> are data-hygiene only (no dollar impact, but they affect customer and transaction attribution).
              {' '}Last refreshed: {new Date(snap.fetched_at).toLocaleString()}.
            </p>
            <button className="am-btn am-btn--text" onClick={() => setHelp(true)} style={{ flexShrink: 0 }}><Icon name="info" />How to read</button>
          </div>
        </section>
      )}

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">{filtered.length} {filtered.length === 1 ? 'adjustment' : 'adjustments'}{filterCategory !== 'all' ? ` · ${CATEGORY_LABEL[filterCategory as Category]}` : ''}</span>
          <span className="am-chart__caption">Select a category to see the full entry, including evidence and who added it.</span>
        </div>
        <div className="am-row am-row--wrap">
          <Segmented label="Severity" value={filterSeverity} onChange={setFilterSeverity}
            options={[['all', `All (${rows.length})`], ['monetary', `Monetary (${stats.monetary})`], ['hygiene', `Hygiene (${stats.hygiene})`]]} />
          <span className="am-card__text">Category</span>
          <Select label="Category" width={280} value={filterCategory} onPick={setFilterCategory}
            options={[['all', 'All categories'], ...distinctCategories.map((c) => [c, `${CATEGORY_LABEL[c]} (${rows.filter((r) => r.category === c).length})`] as [string, string])]} />
        </div>

        {isLoading ? <p className="am-card__text">Loading adjustments…</p> : filtered.length === 0 ? (
          <p className="am-card__text">No adjustments match the current filters.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Adjustments register"
              cols={[['Category', false], ['Impact', false], ['Customer', false], ['Period', false], ['Before $', true], ['After $', true], ['Change $', true], ['Reason', false], ['Source file', false]]}
              rows={filtered.map((r) => [
                CATEGORY_LABEL[r.category],
                <span key="s" className={`am-tag am-tag--${SEVERITY[r.severity].tone}`}>{SEVERITY[r.severity].label}</span>,
                customerCell(r),
                r.period ?? r.txn_date ?? '—',
                r.before != null ? usd(r.before) : '—',
                r.after != null ? usd(r.after) : '—',
                fmtDelta(r.delta),
                // Long reasons (some run past 1,000 characters) show a preview; the full text is one click away.
                <span key="r" style={{ display: 'block', minWidth: 260, maxWidth: 380, whiteSpace: 'normal' }}>
                  {r.reason.length > REASON_PREVIEW ? <>{r.reason.slice(0, REASON_PREVIEW).replace(/\s+\S*$/, '')}… <button className="am-btn am-btn--text" onClick={() => setDetail(r)}>Read all</button></> : r.reason}
                </span>,
                <code key="f" style={{ display: 'block', maxWidth: 190, whiteSpace: 'normal' }}>{shortFile(r.source_file).replace(/[_/.]/g, '$&\u200b')}</code>,
              ])}
              sortValues={filtered.map((r) => [CATEGORY_LABEL[r.category], r.severity, r.customer_name ?? '', r.period ?? r.txn_date ?? '', r.before, r.after, r.delta, r.reason, shortFile(r.source_file)])}
              onSortChange={(o) => setOrder(o)}
              limit={showAll ? undefined : LIMIT}
              clickable={(c) => c === 0}
              onCell={(i) => setDetail(filtered[i])}
              foot={[`Total · ${filtered.length} adjustments`, '', '', '', '', '', fmtDelta(netDelta), `${quantified.length} with a dollar change`, '']}
              onFoot={(c) => { if (c === 0) setShowAll(true); else setDeltaSheet(true); }}
              footClickable={(c) => (c === 0 && !showAll && filtered.length > LIMIT) || (c === 6 && quantified.length > 0)} />
          </div>
        )}
        {!showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {filtered.length}</button>}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Adding or editing an adjustment</span>
        </div>
        <p className="am-card__text">
          All adjustments live in their underlying source-file JSONs (see the Source file column).
          Edit there, then re-run <code>node _etl_scripts/refresh_all.mjs</code> (or just{' '}
          <code>node _etl_scripts/build_adjustments_register.mjs</code> if you only changed override files).
          Every entry should carry a <b>reason</b>, and for QoE-grade documentation, an <b>evidence link</b> to the supporting
          contract, invoice, customer email or HubSpot note. {stats.nEvidence === 0 ? <>The <code>evidence</code> column is currently empty across the register — that's the next pass.</> : <>{stats.nEvidence} of {stats.total} entries carry evidence so far.</>}
        </p>
      </section>
    </DsPage>
  );
}
