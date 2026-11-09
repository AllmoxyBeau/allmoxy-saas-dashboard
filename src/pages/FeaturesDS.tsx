/**
 * Features on the Allmoxy design system. Data logic is ported from the classic page
 * (Features.tsx, kept at /features-classic): same `features` snapshot, same open-stake maths
 * (distinct customers on open tickets, each counted once at current MRR, with the
 * ticket-weighted sum as a labelled secondary), same Hide done / Revenue-weighted filters,
 * same default sort (MRR at stake, highest first) and the same CSV columns.
 *
 * The page is a prioritization list: the open tickets with the most revenue waiting on them
 * come first; the customers behind the open-stake figure are one click away.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, SideSheet, downloadCsv, usd } from '../design-system/parts';

type FeatureCustomer = { allmoxy_customer_id: number; name: string; mrr: number; lifetime: number; status: string };
type Row = {
  key: string; summary: string; status: string | null; stage_category: string | null; issue_type: string | null;
  priority: string | null; issue_score: number | null; created: string | null; updated: string | null; url: string;
  customers: FeatureCustomer[]; tag_count: number; customer_count: number; active_customer_count: number;
  total_mrr: number; total_arr: number; total_lifetime: number; unmatched_labels: string[];
};
type Aggregates = {
  total_tickets: number; open_tickets: number; done_tickets: number; tickets_with_matched_customer: number;
  open_mrr_at_stake: number; open_customers_distinct?: number; open_mrr_ticket_weighted?: number;
  distinct_customers_tagged: number; unmatched_labels: string[];
};
type Snapshot = { fetchedAt: string; aggregates: Aggregates; rows: Row[] };

const DEV_BOARD = 'https://allmoxy.atlassian.net/jira/software/c/projects/DEV/boards/2';
const LIMIT = 25;
const CUST_STATUS: Record<string, [string, 'success' | 'warning' | 'error' | 'neutral']> = {
  active: ['Active', 'success'], at_risk: ['At risk', 'warning'], non_payment: ['Not paying', 'error'], paused: ['Paused', 'neutral'],
  churned: ['Churned', 'neutral'], never_paid: ['Never paid', 'neutral'], unknown: ['Unknown', 'neutral'],
};
const stageTone = (c: string | null) => (c === 'Done' ? 'success' : c === 'In Progress' ? 'info' : 'neutral');

export default function FeaturesDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab<Snapshot>('features');
  const snap = data as unknown as Snapshot | undefined;
  const rows = useMemo(() => snap?.rows ?? [], [snap]);
  const agg = snap?.aggregates;

  // Distinct customers with >=1 open ticket, each counted ONCE at current MRR (classic logic).
  // Also keeps each customer's open-ticket count for the drill-down.
  const openStake = useMemo(() => {
    const seen = new Map<number, { c: FeatureCustomer; tickets: number }>();
    let ticketWeighted = 0;
    for (const r of rows) {
      if (r.stage_category === 'Done') continue;
      ticketWeighted += r.total_mrr;
      for (const c of r.customers) {
        const s = seen.get(c.allmoxy_customer_id);
        if (s) s.tickets += 1; else seen.set(c.allmoxy_customer_id, { c, tickets: 1 });
      }
    }
    let mrr = 0;
    for (const v of seen.values()) mrr += v.c.mrr;
    const list = [...seen.values()].sort((a, b) => b.c.mrr - a.c.mrr || b.tickets - a.tickets);
    return { mrr, customers: seen.size, list, ticketWeighted: agg?.open_mrr_ticket_weighted ?? ticketWeighted };
  }, [rows, agg]);

  const [showDone, setShowDone] = useState(false);
  const [withRevenueOnly, setWithRevenueOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [stakeOpen, setStakeOpen] = useState(false);
  const [ticket, setTicket] = useState<Row | null>(null);
  const [unmatchedOpen, setUnmatchedOpen] = useState(false);
  const order = useRef<number[]>([]); // a ref, not state: the table reports its order on every render

  // Same filters as the classic page, pre-sorted by its default (MRR at stake, highest first).
  const filtered = useMemo(() => rows.filter((r) => {
    if (!showDone && r.stage_category === 'Done') return false;
    if (withRevenueOnly && r.total_mrr <= 0) return false;
    return true;
  }).sort((a, b) => b.total_mrr - a.total_mrr), [rows, showDone, withRevenueOnly]);

  const openCustomer = (id: number) => navigate(`/customer-detail?id=${encodeURIComponent(String(id))}`);

  const exportCsv = () => {
    const list = order.current.length === filtered.length ? order.current.map((i) => filtered[i]) : filtered;
    downloadCsv('features', ['Ticket', 'Summary', 'Status', 'Type', 'Customers', 'MRR at stake', 'ARR at stake', 'Dev issue score', 'Customer names', 'Updated', 'URL'],
      list.map((r) => [r.key, r.summary, r.status ?? '', r.issue_type ?? '', r.customer_count, r.total_mrr, r.total_arr, r.issue_score ?? '', r.customers.map((c) => c.name).join('; '), r.updated ?? '', r.url]));
  };

  const distinctShown = useMemo(() => { const s = new Set<number>(); for (const r of filtered) for (const c of r.customers) s.add(c.allmoxy_customer_id); return s.size; }, [filtered]);
  const sumMrr = filtered.reduce((a, r) => a + r.total_mrr, 0);
  const sumArr = filtered.reduce((a, r) => a + r.total_arr, 0);

  const actions = (
    <>
      <a className="am-btn am-btn--outlined" href={DEV_BOARD} target="_blank" rel="noopener noreferrer">Open DEV board<Icon name="open_in_new" /></a>
      <button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!filtered.length}><Icon name="download" />CSV</button>
    </>
  );

  if (error) {
    return <DsPage path="/features" title="Features" subtitle="DEV-board tickets weighted by customer revenue"><p className="am-card__text">Failed to load features: {String(error)}</p></DsPage>;
  }
  if (isLoading || !agg) {
    return <DsPage path="/features" title="Features" subtitle="Loading…"><p className="am-card__text">Loading the DEV-board tickets…</p></DsPage>;
  }

  const unmatched = agg.unmatched_labels;

  return (
    <DsPage
      path="/features"
      title="Features"
      subtitle="DEV-board tickets weighted by the revenue of the customers tagged on them. Each ticket shows how many customers want it and the MRR they represent, so Dev can weight priority by revenue impact."
      actions={actions}
      overlays={<>
        <SideSheet open={stakeOpen} onClose={() => setStakeOpen(false)} title={`Customers waiting on open tickets · ${openStake.customers}`}
          text={`Each customer is counted once at current subscription MRR, however many open tickets they are on. Ticket-weighted, the same customers add up to ${usd(openStake.ticketWeighted)}: a measure of how much demand there is, not revenue.`}>
          <DataTable label="Customers on open tickets" cols={[['Customer', false], ['MRR', true], ['Open tickets', true]]}
            rows={openStake.list.map(({ c, tickets }) => [c.name, usd(c.mrr), tickets.toLocaleString()])}
            sortValues={openStake.list.map(({ c, tickets }) => [c.name, c.mrr, tickets])}
            clickable={(col) => col === 0} onCell={(row) => openCustomer(openStake.list[row].c.allmoxy_customer_id)}
            foot={[`Total · ${openStake.customers} customers`, usd(openStake.mrr), '']} />
        </SideSheet>
        <SideSheet open={!!ticket} onClose={() => setTicket(null)} title={ticket ? `${ticket.key} · ${ticket.customer_count} customers` : ''}
          text={ticket ? <>{ticket.summary} · <a className="am-btn am-btn--text" href={ticket.url} target="_blank" rel="noopener noreferrer">Open in JIRA<Icon name="open_in_new" /></a></> : undefined}>
          {ticket && (
            <DataTable label="Customers tagged on this ticket" cols={[['Customer', false], ['MRR', true], ['Status', false]]}
              rows={ticket.customers.map((c) => [c.name, c.mrr > 0 ? usd(c.mrr) : '—', <span key="s" className={`am-tag am-tag--${(CUST_STATUS[c.status] ?? CUST_STATUS.unknown)[1]}`}>{(CUST_STATUS[c.status] ?? [c.status || 'Unknown'])[0]}</span>])}
              sortValues={ticket.customers.map((c) => [c.name, c.mrr, c.status])}
              defaultSort={{ col: 1, dir: 'desc' }}
              clickable={(col) => col === 0} onCell={(row) => openCustomer(ticket.customers[row].allmoxy_customer_id)}
              foot={[`Total · ${ticket.customers.length} customers`, usd(ticket.customers.reduce((a, c) => a + c.mrr, 0)), '']} />
          )}
          {ticket && ticket.unmatched_labels.length > 0 && <p className="am-card__text">Tags with no roster match (no revenue weight): {ticket.unmatched_labels.join(', ')}</p>}
        </SideSheet>
        <SideSheet open={unmatchedOpen} onClose={() => setUnmatchedOpen(false)} title={`Customer tags with no match · ${unmatched.length}`}
          text="Customer tags on DEV tickets that didn't match a customer in the roster, so no revenue weight is applied to them.">
          <p className="am-card__text">{unmatched.join(', ')}</p>
        </SideSheet>
      </>}
    >
      <KpiGrid>
        <KpiCard label="Open MRR at stake" value={usd(openStake.mrr)}
          hint={`${openStake.customers} customers on at least one open ticket, each counted once · ticket-weighted ${usd(openStake.ticketWeighted)} (demand signal, not revenue)`}
          onOpen={() => setStakeOpen(true)} />
        <KpiCard label="Open tickets" value={agg.open_tickets.toLocaleString()} hint={`${agg.total_tickets.toLocaleString()} total tagged · not Done`} />
        <KpiCard label="Customers driving features" value={agg.distinct_customers_tagged.toLocaleString()} hint="Tagged on at least one ticket" />
        <KpiCard label="Tickets with revenue weight" value={agg.tickets_with_matched_customer.toLocaleString()}
          hint={`of ${agg.total_tickets.toLocaleString()} tagged · the rest tag customers we couldn't match by name`} />
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread am-row--wrap">
          <div className="am-chart__head">
            <span className="am-chart__title">{showDone ? 'All tagged tickets' : 'Open tickets'} · {filtered.length.toLocaleString()}</span>
            <span className="am-chart__caption">Highest revenue at stake first. Select a header to sort; select a ticket's customers or MRR to see who is behind it.</span>
          </div>
          <div className="am-row am-row--wrap" role="group" aria-label="Filters">
            <FilterChip checked={!showDone} onChange={() => setShowDone((v) => !v)}>Hide done</FilterChip>
            <FilterChip checked={withRevenueOnly} onChange={() => setWithRevenueOnly((v) => !v)}>Revenue-weighted only</FilterChip>
          </div>
        </div>
        <p className="am-card__text">Done tickets are hidden by default so the list is open work. Revenue-weighted only hides tickets whose tagged customers have no current MRR.</p>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Tickets by revenue at stake"
            cols={[['Ticket', false], ['Status', false], ['Customers', true], ['MRR at stake', true], ['ARR', true], ['Dev score', true], ['Tagged customers', false]]}
            rows={filtered.map((r) => [
              <div key="t" style={{ maxWidth: 340 }}>
                <a className="am-btn am-btn--text" href={r.url} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: 'normal', textAlign: 'left', height: 'auto' }}>{r.summary || r.key}</a>
                <div className="am-card__text">{r.key}{r.issue_type ? ` · ${r.issue_type}` : ''}</div>
              </div>,
              <span key="s" className={`am-tag am-tag--${stageTone(r.stage_category)}`}>{r.status || '—'}</span>,
              r.customer_count ? r.customer_count.toLocaleString() : '—',
              r.total_mrr > 0 ? usd(r.total_mrr) : '—',
              r.total_arr > 0 ? usd(r.total_arr) : '—',
              r.issue_score ?? '—',
              <span key="c" className="am-card__text" style={{ display: 'block', maxWidth: 360 }}>
                {r.customer_count === 0 ? (r.tag_count > 0 ? 'Tags unmatched' : 'None')
                  : `${r.customers.slice(0, 6).map((c) => `${c.name}${c.mrr > 0 ? ` (${usd(c.mrr)})` : ''}`).join(', ')}${r.customer_count > 6 ? ` +${r.customer_count - 6} more` : ''}`}
              </span>,
            ])}
            sortValues={filtered.map((r) => [r.key, r.status ?? '', r.customer_count, r.total_mrr, r.total_arr, r.issue_score ?? -1, r.customers.map((c) => c.name).join('; ')])}
            defaultSort={{ col: 3, dir: 'desc' }}
            clickable={(col, row) => (col === 2 || col === 3) && filtered[row].customer_count > 0}
            onCell={(row) => setTicket(filtered[row])}
            limit={showAll ? undefined : LIMIT}
            onSortChange={(o) => { order.current = o; }}
            foot={[`Total · ${filtered.length.toLocaleString()} tickets (ticket-weighted)`, '', `${distinctShown.toLocaleString()} distinct`, usd(sumMrr), usd(sumArr), '', '']}
            onFoot={() => setShowAll(true)} footClickable={(c) => !showAll && filtered.length > LIMIT && (c === 0 || c === 3 || c === 4)} />
        </div>
        {!showAll && filtered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {filtered.length.toLocaleString()}</button>}
        {filtered.length === 0 && <p className="am-card__text">No tickets match the current filters.</p>}
        <p className="am-card__text">The Total row adds each ticket's customers again on every ticket they're tagged on, so it overstates revenue. The distinct-customer figure is the Open MRR at stake card.</p>
      </section>

      {unmatched.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--spread">
            <div className="am-chart__head">
              <span className="am-chart__title">Customer tags with no match · {unmatched.length}</span>
              <span className="am-chart__caption">Tags on DEV tickets that didn't match a customer in the roster, so no revenue weight is applied</span>
            </div>
            <span className="am-tag am-tag--warning">Not weighted</span>
          </div>
          <p className="am-card__text">{unmatched.slice(0, 30).join(', ')}{unmatched.length > 30 ? '…' : ''}</p>
          {unmatched.length > 30 && <button className="am-btn am-btn--text" onClick={() => setUnmatchedOpen(true)}>Show all {unmatched.length}</button>}
        </section>
      )}
    </DsPage>
  );
}
