/**
 * Collections on the Allmoxy design system. Data logic is ported verbatim from the classic page
 * (Collections.tsx, kept at /collections-classic): same revenue_recognition snapshot, same
 * effective-state rule (pending decision > committed decision > age rule), same totals, same
 * filters and sort, and the same decision storage (browser localStorage key
 * 'allmoxy.ar_collection.pending', applied with _etl_scripts/toggle_ar_collection.mjs).
 *
 * The page is an action list: the invoices still worth chasing, biggest money first, each with
 * its Chase / Write off call.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, Icon, KpiCard, Select, SideSheet, downloadCsv, mlabel, usd } from '../design-system/parts';

type ArRow = {
  allmoxy_customer_id: number | null; name: string; invoice_id: string | null; invoice_date: string;
  service_month: string; amount: number; status: 'open' | 'uncollectible'; age_days: number;
  collectible: boolean; bookable_writeoff?: boolean; writeoff_month?: string | null;
  decision?: 'uncollectible' | 'collectible' | 'collected_manually' | null; decision_note?: string | null; decided_at?: string | null;
  collected_manually?: boolean;
  customer_status?: string | null; customer_mrr?: number; customer_still_paying?: boolean;
  owner?: string | null; owner_email?: string | null;
};
type RowSource = 'auto' | 'decided' | 'pending';
type Effective = 'collectible' | 'uncollectible' | 'collected_manually';
type DecoratedRow = ArRow & { effective: Effective; source: RowSource; pendingNote: string | null };
type Snap = {
  ar_aging: ArRow[]; ar_total: number;
  ar_policy?: { writeoff_after_days: number | null; open_total: number; open_count: number; written_off_total: number; written_off_count: number; bookable_total: number; bookable_count?: number; pre_accrual_total?: number; pre_accrual_count?: number; collected_manually_total?: number; collected_manually_count?: number; books_go_live: string } | null;
};

const USD2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtDate(iso: string | null | undefined) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; }

// Pending decisions live in the browser until they're applied to
// _etl_scripts/ar_collection_overrides.json (the deployed site has no backend).
// Same key and shape as the classic page, so decisions made on either page are shared.
const STORAGE_KEY = 'allmoxy.ar_collection.pending';
type PendingMap = Record<string, { decision: 'uncollectible' | 'collectible' | 'collected_manually'; note?: string | null }>;
const readPending = (): PendingMap => { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; } };
const writePending = (m: PendingMap) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch { /* quota / private mode */ } };

type Filter = 'all' | 'chase' | 'writeoff' | 'collected' | 'decided' | 'undecided';
const matches = (r: DecoratedRow, f: Filter) => {
  if (f === 'chase') return r.effective === 'collectible';
  if (f === 'writeoff') return r.effective === 'uncollectible';
  if (f === 'collected') return r.effective === 'collected_manually';
  if (f === 'decided') return r.source !== 'auto';
  if (f === 'undecided') return r.source === 'auto';
  return true;
};
const FILTER_WORD: Record<Filter, string> = { chase: 'Chasing', writeoff: 'Written off', collected: 'Collected manually', undecided: 'Undecided', decided: 'Decided', all: 'All invoices' };

// Sort keys and values exactly as the classic page; defaults are the direction you want on
// first pick: biggest money and oldest invoices first, names A to Z.
type SortKey = 'name' | 'invoice_date' | 'amount' | 'age_days' | 'customer' | 'owner' | 'source' | 'decision';
const SORTS: Array<{ key: SortKey; label: string; defaultDesc: boolean; value: (r: DecoratedRow) => string | number }> = [
  { key: 'amount', label: 'Amount', defaultDesc: true, value: (r) => r.amount },
  { key: 'age_days', label: 'Age', defaultDesc: true, value: (r) => r.age_days },
  { key: 'name', label: 'Customer', defaultDesc: false, value: (r) => (r.name || '').toLowerCase() },
  { key: 'invoice_date', label: 'Invoice date', defaultDesc: true, value: (r) => r.invoice_date || '' },
  { key: 'customer', label: 'Customer state', defaultDesc: true, value: (r) => (r.customer_still_paying ? 1e9 + (r.customer_mrr ?? 0) : r.customer_status === 'churned' ? -1 : 0) },
  { key: 'owner', label: 'Instance owner', defaultDesc: false, value: (r) => (r.owner || 'zzz').toLowerCase() },
  { key: 'source', label: 'Source', defaultDesc: false, value: (r) => r.source },
  { key: 'decision', label: 'Decision', defaultDesc: false, value: (r) => r.effective },
];

const EFFECTIVE: Record<Effective, { label: string; tone: 'success' | 'error' | 'info' }> = {
  collectible: { label: 'Chasing', tone: 'success' },
  uncollectible: { label: 'Written off', tone: 'error' },
  collected_manually: { label: 'Collected manually', tone: 'info' },
};
const SOURCE: Record<RowSource, { label: string; tone: 'neutral' | 'info' | 'warning'; help: string }> = {
  auto: { label: 'Automatic', tone: 'neutral', help: 'No decision yet: the age rule decides.' },
  decided: { label: 'Decided', tone: 'info', help: 'A committed decision.' },
  pending: { label: 'Pending', tone: 'warning', help: 'Your decision, saved in this browser, not yet applied.' },
};

const LIMIT = 25;

export default function CollectionsDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('revenue_recognition');
  const snap = data as unknown as Snap | undefined;
  const [pending, setPending] = useState<PendingMap>(() => readPending());
  const [filter, setFilterRaw] = useState<Filter>('chase');
  const [ownerFilter, setOwnerFilterRaw] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('amount');
  const [sortDesc, setSortDesc] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [help, setHelp] = useState(false);
  const setFilter = (f: Filter) => { setFilterRaw(f); setShowAll(false); };
  const setOwnerFilter = (o: string) => { setOwnerFilterRaw(o); setShowAll(false); };
  const pickSort = (key: SortKey) => {
    const col = SORTS.find((c) => c.key === key)!;
    if (key === sortKey) setSortDesc((d) => !d);
    else { setSortKey(key); setSortDesc(col.defaultDesc); }
  };

  const threshold = snap?.ar_policy?.writeoff_after_days ?? null;
  // Effective state = pending decision > committed decision > age rule.
  const rows = useMemo<DecoratedRow[]>(() => (snap?.ar_aging ?? []).map((r) => {
    const p = r.invoice_id ? pending[r.invoice_id] : undefined;
    const effective: Effective = p ? p.decision
      : r.collected_manually ? 'collected_manually'
      : (r.collectible ? 'collectible' : 'uncollectible');
    const source: RowSource = p ? 'pending' : r.decision ? 'decided' : 'auto';
    return { ...r, effective, source, pendingNote: p?.note ?? null };
  }), [snap, pending]);

  const shown = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (ownerFilter && (r.owner || '(unassigned)') !== ownerFilter) return false;
      return matches(r, filter);
    });
    const col = SORTS.find((c) => c.key === sortKey)!;
    // Amount breaks ties so equal-ranked rows still lead with the biggest money.
    return filtered.sort((a, b) => {
      const av = col.value(a), bv = col.value(b);
      let cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv))
        : (av as number) - (bv as number);
      if (cmp === 0) cmp = a.amount - b.amount;
      return sortDesc ? -cmp : cmp;
    });
  }, [rows, filter, ownerFilter, sortKey, sortDesc]);

  // Only write-offs whose revenue was recognized on the accrual books (service month on/after
  // books go-live) reach 4950. Earlier ones ran on cash: no receivable was ever booked, so
  // writing them off makes no journal entry.
  const goLive = snap?.ar_policy?.books_go_live ?? '2026-01';
  const t = useMemo(() => ({
    writeoffBookable: rows.filter((r) => r.effective === 'uncollectible' && r.service_month >= goLive).reduce((s, r) => s + r.amount, 0),
    writeoffBookableN: rows.filter((r) => r.effective === 'uncollectible' && r.service_month >= goLive).length,
    writeoffPreN: rows.filter((r) => r.effective === 'uncollectible' && r.service_month < goLive).length,
    chase: rows.filter((r) => r.effective === 'collectible').reduce((s, r) => s + r.amount, 0),
    chaseN: rows.filter((r) => r.effective === 'collectible').length,
    writeoff: rows.filter((r) => r.effective === 'uncollectible').reduce((s, r) => s + r.amount, 0),
    writeoffN: rows.filter((r) => r.effective === 'uncollectible').length,
    collected: rows.filter((r) => r.effective === 'collected_manually').reduce((s, r) => s + r.amount, 0),
    collectedN: rows.filter((r) => r.effective === 'collected_manually').length,
    live: rows.filter((r) => r.effective === 'collectible' && r.customer_still_paying).reduce((s, r) => s + r.amount, 0),
    liveN: rows.filter((r) => r.effective === 'collectible' && r.customer_still_paying).length,
    undecidedN: rows.filter((r) => r.source === 'auto').length,
    decidedN: rows.filter((r) => r.source !== 'auto').length,
    pendingN: Object.keys(pending).length,
  }), [rows, pending, goLive]);

  // Owner options with their count and $, computed off the status filter so the numbers
  // match what selecting that owner would show.
  const ownerOptions = useMemo(() => {
    const m = new Map<string, { n: number; amt: number }>();
    for (const r of rows.filter((x) => matches(x, filter))) {
      const k = r.owner || '(unassigned)';
      const e = m.get(k) || { n: 0, amt: 0 };
      e.n += 1; e.amt += r.amount; m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].amt - a[1].amt);
  }, [rows, filter]);

  const setDecision = (inv: string | null, decision: 'uncollectible' | 'collectible' | 'collected_manually' | null) => {
    if (!inv) return;
    const next = { ...pending };
    if (decision == null) delete next[inv]; else next[inv] = { decision };
    setPending(next); writePending(next);
  };
  const copyPending = () => {
    const payload = JSON.stringify(pending);
    navigator.clipboard?.writeText(payload);
    // eslint-disable-next-line no-alert
    alert(`Copied ${Object.keys(pending).length} decision(s).\n\nApply with:\nnode _etl_scripts/toggle_ar_collection.mjs apply '${payload.length > 400 ? payload.slice(0, 400) + '…' : payload}'`);
  };

  const cards = 4 + (t.collectedN > 0 ? 1 : 0);
  const gridMin = `${Math.floor(1392 / cards) - 20}px`;
  const list = showAll ? shown : shown.slice(0, LIMIT);
  const shownTotal = shown.reduce((s, r) => s + r.amount, 0);

  const exportCsv = () => downloadCsv(`collections_${filter}${ownerFilter ? `_${ownerFilter.replace(/\W+/g, '_')}` : ''}`,
    ['Customer', 'Allmoxy ID', 'Invoice', 'Invoice date', 'Service month', 'Amount', 'Age (days)', 'Customer state', 'Customer MRR', 'Instance owner', 'Owner email', 'Source', 'Decision', 'Stripe status'],
    shown.map((r) => [r.name, r.allmoxy_customer_id ?? '', r.invoice_id ?? '', r.invoice_date, r.service_month, r.amount, r.age_days,
      r.customer_still_paying ? 'paying' : r.customer_status === 'churned' ? 'churned' : 'not billing', r.customer_mrr ?? '',
      r.owner ?? '', r.owner_email ?? '', SOURCE[r.source].label, EFFECTIVE[r.effective].label, r.status]));

  return (
    <DsPage
      path="/collections"
      title="Collections"
      subtitle="Every unpaid invoice, who owes it, how old it is, and whether the customer is still with you. Decide invoice by invoice what to keep chasing and what to write off."
      actions={<>
        <button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!shown.length}><Icon name="download" />Export CSV</button>
        {t.pendingN > 0 && <button className="am-btn am-btn--filled" onClick={copyPending}><Icon name="content_copy" />Copy pending decisions ({t.pendingN})</button>}
      </>}
      overlays={
        <SideSheet open={help} onClose={() => setHelp(false)} title="How decisions work">
          <p className="am-card__text"><b>Reading a row.</b> Customer state shows whether the relationship is alive: a customer still paying monthly is far more likely to settle an old balance. Age is days since the invoice date. Source is how the current call was made: Automatic (the age rule), Decided (committed), or Pending (yours, not yet applied).</p>
          <p className="am-card__text"><b>Making a call.</b> Chase keeps the invoice in AR; Write off books it to 4950 Uncollectible Income. Only balances whose revenue was recognized from {mlabel(goLive)} onward hit the books. Earlier years ran on cash, so no receivable was ever recorded and writing them off makes no entry.</p>
          <p className="am-card__text"><b>Saving.</b> Decisions are saved in your browser (shared with the classic Collections page). Use Copy pending decisions and give them to Claude to commit with node _etl_scripts/toggle_ar_collection.mjs apply.</p>
          <p className="am-card__text">Marking an invoice here changes the dashboard only. It does not touch Stripe: void it or mark it uncollectible in Stripe to make it official.</p>
        </SideSheet>
      }
    >
      {error ? <p className="am-card__text">Failed to load revenue_recognition: {String(error)}</p> : null}

      <div className="am-grid" style={{ ['--am-grid-min' as string]: gridMin }}>
        <KpiCard label="Chasing" value={isLoading ? '…' : usd(t.chase)} hint={`${t.chaseN} invoices still collectible`}
          tag={t.chaseN > 0 ? 'Needs action' : 'Clear'} tagTone={t.chaseN > 0 ? 'warning' : 'success'} onOpen={() => setFilter('chase')} />
        <KpiCard label="Writing off" value={isLoading ? '…' : usd(t.writeoff)}
          hint={`${t.writeoffBookableN} invoices / ${usd(t.writeoffBookable)} → 4950 · ${t.writeoffPreN} pre-go-live (no entry)`}
          tag="Bad debt" tagTone="error" onOpen={() => setFilter('writeoff')} />
        <KpiCard label="Owed by live customers" value={isLoading ? '…' : usd(t.live)} hint="Still paying you — best odds"
          tag={`${t.liveN} invoices`} tagTone="info" />
        {t.collectedN > 0 && (
          <KpiCard label="Collected manually" value={usd(t.collected)} hint={`${t.collectedN} paid outside the invoice — no bad debt`}
            tag="Settled" tagTone="success" onOpen={() => setFilter('collected')} />
        )}
        <KpiCard label="Pending decisions" value={String(t.pendingN)} hint={t.pendingN ? 'Not yet applied' : 'None'}
          tag={t.pendingN ? 'Copy to apply' : 'Up to date'} tagTone={t.pendingN ? 'warning' : 'neutral'} />
      </div>

      <section className="am-card am-card--outlined">
        <div className="am-row">
          <span className={`am-tag am-tag--${threshold == null ? 'success' : 'info'}`}>{threshold == null ? 'Manual write-offs only' : `Age rule: ${threshold} days`}</span>
          <p className="am-card__text">
            {threshold == null
              ? <><b>Nothing is written off automatically.</b> Every invoice stays in AR until you mark it uncollectible here. Age never decides on its own, because it can't tell an account that's gone from one that's merely behind. Work the Undecided list and call each one: Write off books it to 4950 Uncollectible Income, Chase keeps it in AR.</>
              : <><b>Undecided invoices fall back to an age rule:</b> older than {threshold} days counts as written off. Any decision you make here overrides it in either direction.</>}
          </p>
          <button className="am-btn am-btn--text" onClick={() => setHelp(true)} style={{ flexShrink: 0 }}><Icon name="info" />How decisions work</button>
        </div>
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">{FILTER_WORD[filter]}{ownerFilter ? ` · ${ownerFilter}` : ''} · {shown.length} invoices · {usd(shownTotal)}</span>
            <span className="am-chart__caption">{filter === 'chase' ? 'The invoices still worth chasing. Make the call on each one.' : 'Select Chasing to go back to the working list.'}</span>
          </div>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Show</span>
          <Select label="Show" width={230} value={filter} onPick={(v) => setFilter(v as Filter)} options={[
            ['chase', `Chasing (${t.chaseN})`], ['writeoff', `Written off (${t.writeoffN})`], ['collected', `Collected manually (${t.collectedN})`],
            ['undecided', `Undecided (${t.undecidedN})`], ['decided', `Decided (${t.decidedN})`], ['all', `All (${rows.length})`],
          ]} />
          <span className="am-card__text">Instance owner</span>
          <Select label="Instance owner" width={300} value={ownerFilter} onPick={setOwnerFilter} options={[
            ['', `All owners (${rows.length})`], ...ownerOptions.map(([name, v]) => [name, `${name} — ${v.n} · ${usd(v.amt)}`] as [string, string]),
          ]} />
          <span className="am-card__text">Sort by</span>
          <Select label="Sort by" width={180} value={sortKey} onPick={(v) => pickSort(v as SortKey)} options={SORTS.map((s) => [s.key, s.label])} />
          <button className="am-btn am-btn--text" onClick={() => setSortDesc((d) => !d)} aria-label="Flip sort direction">
            <Icon name={sortDesc ? 'arrow_downward' : 'arrow_upward'} />{sortDesc ? 'Descending' : 'Ascending'}
          </button>
        </div>

        {filter === 'chase' && t.writeoffN > 0 && (
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--neutral">{t.writeoffN} written off hidden</span>
            <span className="am-card__text">{t.writeoffN} written-off invoice{t.writeoffN === 1 ? '' : 's'} ({usd(t.writeoff)}) not shown.</span>
            <button className="am-btn am-btn--text" onClick={() => setFilter('writeoff')}>Show them</button>
            <button className="am-btn am-btn--text" onClick={() => setFilter('all')}>Show everything</button>
          </div>
        )}
        {filter !== 'chase' && (
          <div className="am-row am-row--wrap">
            <span className="am-card__text">Viewing {FILTER_WORD[filter].toLowerCase()}.</span>
            <button className="am-btn am-btn--text" onClick={() => setFilter('chase')}>Back to chasing</button>
          </div>
        )}

        {isLoading ? <p className="am-card__text">Loading invoices…</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Open invoices"
              cols={[['Customer', false], ['Invoice', false], ['Amount', true], ['Age', true], ['Customer state', false], ['Instance owner', false], ['Decision', false]]}
              rows={list.map((r) => {
                const off = r.effective === 'uncollectible';
                const old = r.age_days > (threshold ?? 90);
                return [
                  <span key="n" style={{ display: 'inline-block', maxWidth: 260, whiteSpace: 'normal', textAlign: 'left' }}>{r.name}</span>,
                  <span key="i" className="am-row am-row--tight" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                    {r.invoice_id
                      ? <a className="am-btn am-btn--text" href={`https://dashboard.stripe.com/invoices/${r.invoice_id}`} target="_blank" rel="noopener noreferrer">{fmtDate(r.invoice_date)}<Icon name="open_in_new" /></a>
                      : fmtDate(r.invoice_date)}
                    {r.status === 'uncollectible' && <span className="am-tag am-tag--error">Uncollectible in Stripe</span>}
                  </span>,
                  USD2.format(r.amount),
                  old ? <span key="a" className="am-tag am-tag--warning">{r.age_days}d</span> : `${r.age_days}d`,
                  r.customer_still_paying
                    ? <span key="c" className="am-tag am-tag--success">Paying {usd(r.customer_mrr ?? 0)}/mo</span>
                    : <span key="c" className="am-tag am-tag--neutral">{r.customer_status === 'churned' ? 'Churned' : 'Not billing'}</span>,
                  r.owner
                    ? (r.owner_email ? <a key="o" className="am-btn am-btn--text" href={`mailto:${r.owner_email}`} title={r.owner_email}>{r.owner}</a> : r.owner)
                    : <span key="o" className="am-tag am-tag--neutral">Unassigned</span>,
                  <span key="d" className="am-row am-row--tight" style={{ flexWrap: 'nowrap' }}>
                    <span className="am-tooltip"><span className={`am-tag am-tag--${SOURCE[r.source].tone}`}>{SOURCE[r.source].label}</span><span className="am-tooltip__tip">{SOURCE[r.source].help}</span></span>
                    {r.effective === 'collected_manually' && <span className={`am-tag am-tag--${EFFECTIVE[r.effective].tone}`}>{EFFECTIVE[r.effective].label}</span>}
                    <button className={`am-btn ${r.effective === 'collectible' ? 'am-btn--filled' : 'am-btn--outlined'}`} aria-pressed={r.effective === 'collectible'} onClick={() => setDecision(r.invoice_id, 'collectible')}>Chase</button>
                    <button className={`am-btn ${off ? 'am-btn--filled' : 'am-btn--outlined'}`} aria-pressed={off} onClick={() => setDecision(r.invoice_id, 'uncollectible')}>Write off</button>
                    {r.source === 'pending' && <button className="am-btn am-btn--text" onClick={() => setDecision(r.invoice_id, null)}>Undo</button>}
                  </span>,
                ];
              })}
              clickable={(c) => c === 0}
              onCell={(i) => {
                const r = list[i];
                navigate(r.allmoxy_customer_id != null ? `/customer-detail?id=${encodeURIComponent(String(r.allmoxy_customer_id))}` : `/customer-detail?name=${encodeURIComponent(r.name)}`);
              }}
              foot={[`Total · ${shown.length} invoices`, '', USD2.format(shownTotal), '', '', '', '']}
              onFoot={() => setShowAll(true)} footClickable={(c) => (c === 0 || c === 2) && !showAll && shown.length > LIMIT} />
          </div>
        )}
        {!isLoading && shown.length === 0 && <p className="am-card__text">No invoices in this view.</p>}
        {!showAll && shown.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {shown.length}</button>}
        <p className="am-card__text">
          Showing {list.length} of {shown.length} in this view ({rows.length} invoices in all). Marking an invoice here changes the dashboard only — it does not touch Stripe. Void it or mark it uncollectible in Stripe to make it official.
        </p>
      </section>
    </DsPage>
  );
}

