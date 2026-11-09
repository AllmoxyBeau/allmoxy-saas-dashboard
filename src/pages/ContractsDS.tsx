/**
 * Contracts on the Allmoxy design system. Data logic is ported verbatim from the classic page
 * (Contracts.tsx, kept at /contracts-classic): same renewal_management snapshot, same contract
 * buckets (HubSpot Yes/No flag, with "Yes + renewal passed" split out as Lapsed / overdue),
 * same health buckets, same counts and averages, same filters, same default sort (ARR, biggest
 * first, health order as the tie-break) and the same CSV columns.
 *
 * The page leads with the contract coverage cards, then the contract × health chart (click a
 * segment to filter), then the customer list with its Total row.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, downloadCsv, usd,
} from '../design-system/parts';

type Quote = {
  id: string; title: string | null; status: string | null; amount: number | null; currency: string;
  created_date: string | null; expiration_date: string | null; last_modified_date: string | null;
  quote_number: string | null; payment_status: string | null; hubspot_url: string;
};
type RenewalRow = {
  instance_id: string; account_name: string; allmoxy_customer_id: number;
  contract_status: string | null; contract_length_months: number | null; renewal_date: string | null;
  days_to_renewal: number | null; pay_status: string; health_score: number | null;
  health_score_status: string | null; current_mrr: number; current_arr: number; arr_up_for_renewal: number;
  owner_name: string | null; quotes?: Quote[];
};
type Snapshot = {
  fetchedAt: string; rows: RenewalRow[];
  aggregates?: { base_customers?: number | null; base_as_of?: string | null; base_customers_without_instance?: number };
};

type Contract = 'In contract' | 'Lapsed / overdue' | 'Not in contract' | 'Unknown';
const CONTRACT_ORDER: Contract[] = ['In contract', 'Lapsed / overdue', 'Not in contract', 'Unknown'];
function contractBucket(r: { contract_status: string | null; days_to_renewal: number | null }): Contract {
  if (r.contract_status === 'Yes') return r.days_to_renewal != null && r.days_to_renewal < 0 ? 'Lapsed / overdue' : 'In contract';
  if (r.contract_status === 'No') return 'Not in contract';
  return 'Unknown';
}
const CONTRACT_TONE: Record<Contract, 'success' | 'warning' | 'error' | 'neutral'> = {
  'In contract': 'success', 'Lapsed / overdue': 'warning', 'Not in contract': 'error', Unknown: 'neutral',
};

type Health = 'At-Risk' | 'Neutral' | 'Healthy' | 'Unscored';
const HEALTH_ORDER: Health[] = ['At-Risk', 'Neutral', 'Healthy', 'Unscored'];
function healthBucket(s: string | null): Health {
  if (s === 'At-Risk' || s === 'Neutral' || s === 'Healthy') return s;
  return 'Unscored';
}
const HEALTH_TONE: Record<Health, 'success' | 'warning' | 'error' | 'neutral'> = {
  'At-Risk': 'error', Neutral: 'warning', Healthy: 'success', Unscored: 'neutral',
};
// Chart stacks bottom-up, good to bad: Healthy (green), Neutral (yellow), At-Risk (red); unscored neutral.
const HEALTH_SERIES: Array<{ k: Health; tone: string }> = [
  { k: 'Healthy', tone: 'div-2' }, { k: 'Neutral', tone: 'div-3' }, { k: 'At-Risk', tone: 'div-5' }, { k: 'Unscored', tone: 'other' },
];
const HEALTH_RANK: Record<Health, number> = { 'At-Risk': 0, Neutral: 1, Healthy: 2, Unscored: 3 };

const quoteWord = (s: string | null) => (s === 'APPROVAL_NOT_NEEDED' ? 'Sent' : (s || '—'));
const LIMIT = 25;

export default function ContractsDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab<Snapshot>('renewal_management');
  const snap = data as Snapshot | undefined;
  const rows = useMemo(() => snap?.rows ?? [], [snap]);

  const [contractFilter, setContractFilterRaw] = useState<Contract | null>(null);
  const [healthFilter, setHealthFilterRaw] = useState<Health | null>(null);
  const [quoteFilter, setQuoteFilterRaw] = useState<'with' | 'without' | null>(null);
  const [showAll, setShowAll] = useState(false);
  const setContractFilter = (f: (p: Contract | null) => Contract | null) => { setContractFilterRaw(f); setShowAll(false); };
  const setHealthFilter = (f: (p: Health | null) => Health | null) => { setHealthFilterRaw(f); setShowAll(false); };
  const setQuoteFilter = (f: (p: 'with' | 'without' | null) => 'with' | 'without' | null) => { setQuoteFilterRaw(f); setShowAll(false); };
  const clearFilters = () => { setContractFilterRaw(null); setHealthFilterRaw(null); setQuoteFilterRaw(null); setShowAll(false); };

  const stats = useMemo(() => {
    const zero = () => Object.fromEntries(CONTRACT_ORDER.map((c) => [c, 0])) as Record<Contract, number>;
    const byContract = zero();
    let withQuote = 0, quoteTotal = 0;
    const hsSum = zero(), hsCnt = zero();
    for (const r of rows) {
      const c = contractBucket(r);
      byContract[c] += 1;
      const qn = r.quotes?.length ?? 0;
      if (qn > 0) withQuote += 1;
      quoteTotal += qn;
      if (r.health_score != null) { hsSum[c] += r.health_score; hsCnt[c] += 1; }
    }
    const avg = (c: Contract) => (hsCnt[c] > 0 ? hsSum[c] / hsCnt[c] : null);
    return { byContract, withQuote, quoteTotal, total: rows.length, avg };
  }, [rows]);

  // contract bucket × health bucket counts (the chart).
  const correlation = useMemo(() => CONTRACT_ORDER.map((c) => {
    const cell = Object.fromEntries(HEALTH_ORDER.map((h) => [h, 0])) as Record<Health, number>;
    for (const r of rows) if (contractBucket(r) === c) cell[healthBucket(r.health_score_status)] += 1;
    return cell;
  }), [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (contractFilter && contractBucket(r) !== contractFilter) return false;
    if (healthFilter && healthBucket(r.health_score_status) !== healthFilter) return false;
    const qn = r.quotes?.length ?? 0;
    if (quoteFilter === 'with' && qn === 0) return false;
    if (quoteFilter === 'without' && qn > 0) return false;
    return true;
  }), [rows, contractFilter, healthFilter, quoteFilter]);

  // Classic default order: ARR, biggest first; health status order breaks ties.
  const sorted = useMemo(() => [...filtered].sort((a, b) => {
    if (a.current_arr !== b.current_arr) return b.current_arr - a.current_arr;
    return HEALTH_RANK[healthBucket(a.health_score_status)] - HEALTH_RANK[healthBucket(b.health_score_status)];
  }), [filtered]);

  const list = showAll ? sorted : sorted.slice(0, LIMIT);
  const tot = useMemo(() => ({
    quotes: sorted.reduce((s, r) => s + (r.quotes?.length ?? 0), 0),
    mrr: sorted.reduce((s, r) => s + r.current_mrr, 0),
    arr: sorted.reduce((s, r) => s + r.current_arr, 0),
  }), [sorted]);

  const exportCsv = () => downloadCsv('contracts',
    ['Customer', 'Allmoxy ID', 'Contract', 'Contract (HubSpot)', 'Health Status', 'Health Score', 'Quote Count', 'Latest Quote Status', 'Latest Quote Amount', 'Latest Quote URL', 'Current MRR', 'Current ARR', 'Renewal Date', 'Owner'],
    sorted.map((r) => [r.account_name, r.allmoxy_customer_id, contractBucket(r), r.contract_status ?? '', r.health_score_status ?? '', r.health_score ?? '',
      r.quotes?.length ?? 0, r.quotes?.[0]?.status ?? '', r.quotes?.[0]?.amount ?? '', r.quotes?.[0]?.hubspot_url ?? '',
      r.current_mrr, r.current_arr, r.renewal_date ?? '', r.owner_name ?? '']));

  const toggleContract = (c: Contract) => setContractFilter((p) => (p === c ? null : c));
  const avgHint = (c: Contract, fallback: string) => { const a = stats.avg(c); return a != null ? `Avg health ${a.toFixed(0)} / 65` : fallback; };
  const v = (n: number) => (isLoading ? '…' : String(n));
  const activeFilter = !!(contractFilter || healthFilter || quoteFilter);

  return (
    <DsPage
      path="/contracts"
      title="Contracts"
      subtitle="Which customers are under a term agreement and which are month to month, set against their HubSpot health score. A 'Yes' contract whose renewal date has already passed is shown as Lapsed / overdue. Quotes are the renewal lever: a low health score, no quote and a near renewal is the prep list."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!sorted.length}><Icon name="download" />Export CSV</button>}
    >
      {error ? <p className="am-card__text">Failed to load renewal_management: {String(error)}</p> : null}

      <KpiGrid max={4}>
        <KpiCard label="In contract" value={v(stats.byContract['In contract'])} hint={avgHint('In contract', '—')}
          tag={contractFilter === 'In contract' ? 'Filtering the list' : 'Under a term'} tagTone={contractFilter === 'In contract' ? 'info' : 'success'} onOpen={() => toggleContract('In contract')} />
        <KpiCard label="Lapsed / overdue" value={v(stats.byContract['Lapsed / overdue'])} hint={avgHint('Lapsed / overdue', 'Yes flag · renewal passed')}
          tag={contractFilter === 'Lapsed / overdue' ? 'Filtering the list' : 'Re-sign'} tagTone={contractFilter === 'Lapsed / overdue' ? 'info' : 'warning'} onOpen={() => toggleContract('Lapsed / overdue')} />
        <KpiCard label="Not in contract" value={v(stats.byContract['Not in contract'])} hint={avgHint('Not in contract', '—')}
          tag={contractFilter === 'Not in contract' ? 'Filtering the list' : 'Month to month'} tagTone={contractFilter === 'Not in contract' ? 'info' : 'error'} onOpen={() => toggleContract('Not in contract')} />
        <KpiCard label="Contract unknown" value={v(stats.byContract.Unknown)} hint="Unset in HubSpot"
          tag={contractFilter === 'Unknown' ? 'Filtering the list' : 'Fix in HubSpot'} tagTone={contractFilter === 'Unknown' ? 'info' : 'neutral'} onOpen={() => toggleContract('Unknown')} />
      </KpiGrid>
      <KpiGrid max={3}>
        <KpiCard label="Without a quote" value={v(stats.total - stats.withQuote)} hint="No quote started"
          tag={quoteFilter === 'without' ? 'Filtering the list' : 'Quote backlog'} tagTone={quoteFilter === 'without' ? 'info' : 'warning'} onOpen={() => setQuoteFilter((p) => (p === 'without' ? null : 'without'))} />
        <KpiCard label="Customers with a quote" value={v(stats.withQuote)} hint={`${stats.total - stats.withQuote} without`}
          tag={quoteFilter === 'with' ? 'Filtering the list' : 'Quote started'} tagTone="info" onOpen={() => setQuoteFilter((p) => (p === 'with' ? null : 'with'))} />
        <KpiCard label="Total quotes" value={v(stats.quoteTotal)}
          hint={`across ${stats.total}${snap?.aggregates?.base_customers != null ? ` of ${snap.aggregates.base_customers}` : ''} customers (canonical base)`}
          tag="All HubSpot quotes" tagTone="neutral" />
      </KpiGrid>

      <ChartCard title="Contract status × health score"
        caption="Each column is a contract group, split by HubSpot health status. Compare the healthy share of customers in contract with the month-to-month base. Click a segment to filter the list to that contract and health slice.">
        {isLoading ? <p className="am-card__text">Loading…</p> : (
          <ColumnChart
            months={CONTRACT_ORDER} catLabel={(k) => k} catTitle={(k) => k}
            series={HEALTH_SERIES.map((h) => ({ key: h.k, label: h.k, tone: h.tone, values: correlation.map((c) => c[h.k]) }))}
            stacked legend fmt={(n) => Math.round(n).toLocaleString()} aria="Customers by contract status and health"
            tipRows={(i) => [...HEALTH_ORDER.map((h) => [h, correlation[i][h].toLocaleString()] as [string, string]),
              ['Total', String(stats.byContract[CONTRACT_ORDER[i]])]]}
            onSegment={(i, key) => {
              const c = CONTRACT_ORDER[i], h = key as Health;
              setContractFilter((p) => (p === c ? null : c));
              setHealthFilter((p) => (p === h ? null : h));
            }} />
        )}
      </ChartCard>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">{sorted.length} customer{sorted.length === 1 ? '' : 's'}{activeFilter ? ' · filtered' : ''}</span>
            <span className="am-chart__caption">Sorted by ARR, biggest first. Click any header to re-sort, a customer to open their detail.</span>
          </div>
          <button className="am-btn am-btn--text" onClick={exportCsv} disabled={!sorted.length}><Icon name="download" />Export CSV</button>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Contract</span>
          {CONTRACT_ORDER.map((c) => <FilterChip key={c} checked={contractFilter === c} onChange={() => toggleContract(c)}>{c}</FilterChip>)}
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Health</span>
          {HEALTH_ORDER.map((h) => <FilterChip key={h} checked={healthFilter === h} onChange={() => setHealthFilter((p) => (p === h ? null : h))}>{h}</FilterChip>)}
          <span className="am-card__text">Quote</span>
          <FilterChip checked={quoteFilter === 'with'} onChange={() => setQuoteFilter((p) => (p === 'with' ? null : 'with'))}>Has quote</FilterChip>
          <FilterChip checked={quoteFilter === 'without'} onChange={() => setQuoteFilter((p) => (p === 'without' ? null : 'without'))}>No quote</FilterChip>
          {activeFilter && <button className="am-btn am-btn--text" onClick={clearFilters}><Icon name="close" />Clear filters</button>}
        </div>

        {isLoading ? <p className="am-card__text">Loading customers…</p> : sorted.length === 0 ? (
          <p className="am-card__text">No customers match the current filters.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Customers by contract"
              cols={[['Customer', false], ['Contract', false], ['Health', false], ['Quotes', true], ['Latest quote', false], ['MRR', true], ['ARR', true], ['Renewal', false], ['Owner', false]]}
              rows={list.map((r) => {
                const c = contractBucket(r), h = healthBucket(r.health_score_status);
                const latest = r.quotes?.[0], qn = r.quotes?.length ?? 0;
                return [
                  r.account_name,
                  <span key="c" className={`am-tag am-tag--${CONTRACT_TONE[c]}`}>{c}</span>,
                  <span key="h" className="am-row am-row--tight" style={{ flexWrap: 'nowrap' }}>
                    <span className={`am-tag am-tag--${HEALTH_TONE[h]}`}>{h}</span>
                    {r.health_score != null && <span className="am-card__text">{r.health_score}</span>}
                  </span>,
                  qn ? String(qn) : '—',
                  latest
                    ? <a key="q" className="am-btn am-btn--text" href={latest.hubspot_url} target="_blank" rel="noopener noreferrer">
                        {quoteWord(latest.status)}{latest.amount != null ? ` · ${usd(latest.amount)}` : ''}<Icon name="open_in_new" />
                      </a>
                    : <span key="q" className="am-tag am-tag--neutral">None</span>,
                  usd(r.current_mrr),
                  usd(r.current_arr),
                  r.renewal_date || '—',
                  r.owner_name || '—',
                ];
              })}
              sortValues={list.map((r) => [
                (r.account_name || '').toLowerCase(), CONTRACT_ORDER.indexOf(contractBucket(r)), r.health_score ?? -1,
                r.quotes?.length ?? 0, r.quotes?.[0]?.amount ?? null, r.current_mrr, r.current_arr, r.renewal_date ?? '9999', (r.owner_name || '').toLowerCase(),
              ])}
              clickable={(c) => c === 0}
              onCell={(i) => navigate(`/customer-detail?id=${encodeURIComponent(String(list[i].allmoxy_customer_id))}`)}
              foot={[`Total · ${sorted.length} customers`, '', '', tot.quotes.toLocaleString(), '', usd(tot.mrr), usd(tot.arr), '', '']}
              onFoot={() => setShowAll(true)}
              footClickable={(c) => [0, 3, 5, 6].includes(c) && !showAll && sorted.length > LIMIT} />
          </div>
        )}
        {!showAll && sorted.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {sorted.length}</button>}
        {showAll && sorted.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show top {LIMIT}</button>}
      </section>
    </DsPage>
  );
}
