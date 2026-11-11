/**
 * Service Tickets on the Allmoxy design system. Data logic is the classic page's
 * (ServiceTickets.tsx, kept at /service-tickets-classic): same service_tickets snapshot, same
 * TTM header figures straight from snap.ttm (time to close, closed within 7 days and same day
 * all on the TTM created cohort), same month series, owner / channel / customer cuts, open queue
 * and the same four CSV exports.
 *
 * Order follows what someone acts on: the headline cards, the open queue (oldest first), then
 * volume and backlog, time to close, who handles them, where they come from, the heaviest
 * accounts, and the month-by-month table.
 */
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, SideSheet,
  downloadCsv, mlabel, usd, useMonthRange,
} from '../design-system/parts';

type MonthRow = {
  month: string; created: number; closed: number; net: number; open_at_month_end: number;
  median_resolution_days: number | null; p90_resolution_days: number | null;
  instant_close_rate: number | null; same_day_rate: number | null; within_7d_rate: number | null;
  cohort_median_resolution_days: number | null; cohort_p90_resolution_days: number | null;
  cohort_measurable: number; cohort_closed_share: number | null;
  backlog_purge: boolean; partial: boolean;
  by_source: Record<string, number>;
};
type Cut = { key: string; tickets: number; open: number; closed: number; median_resolution_days: number | null; measurable: number };
type CustRow = {
  allmoxy_customer_id: number; name: string; status: string | null; mrr: number;
  tickets: number; open: number; ttm_tickets: number;
  median_resolution_days: number | null; last_ticket: string | null; tickets_per_1k_mrr: number | null;
};
type OpenRow = {
  id: string; subject: string | null; created: string | null; age_days: number | null;
  stage: string | null; owner: string | null; source: string | null; priority: string | null;
  url: string | null; customer: string | null; allmoxy_customer_id: number | null;
};
type Snap = {
  fetchedAt: string; source_fetched_at: string | null;
  window: { first_month: string; last_month: string; ttm_start: string };
  totals: {
    tickets: number; open: number; closed: number; customers_with_tickets: number;
    unattributed_tickets: number; median_resolution_days: number | null; instant_close_rate_all_time: number | null;
  };
  ttm: {
    created: number; closed: number; net: number; per_month: number;
    median_resolution_days: number | null; p90_resolution_days: number | null;
    cohort_median_resolution_days: number | null; cohort_p90_resolution_days: number | null;
    cohort_measurable: number; cohort_closed_share: number | null;
    same_day_rate: number | null; within_7d_rate: number | null; measurable: number;
    purge_months: string[];
  };
  monthly: MonthRow[];
  by_owner: Cut[]; by_source: Cut[]; by_stage: Cut[]; by_category: Cut[]; by_priority: Cut[];
  customers: CustRow[]; open_tickets: OpenRow[];
  data_quality: { instant_close_rate_all_time: number | null; note: string; attribution: string };
};

// Formatters exactly as the classic page.
const N0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const days = (v: number | null | undefined) =>
  v == null ? '—' : v < 1 ? `${Math.round(v * 24)}h` : v < 30 ? `${v.toFixed(1)}d` : `${Math.round(v)}d`;
const signedN = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${N0.format(Math.abs(v))}`;
const ownerKey = (o: string | null) => o ?? '(unassigned)';

const OPEN_LIMIT = 25;
const CUST_LIMIT = 20;

function ageTag(d: number | null) {
  if (d == null) return <span className="am-tag am-tag--neutral">Unknown</span>;
  if (d > 90) return <span className="am-tag am-tag--error">Over 90 days</span>;
  if (d > 30) return <span className="am-tag am-tag--warning">Over 30 days</span>;
  return <span className="am-tag am-tag--neutral">Under 30 days</span>;
}

type Drill =
  | { kind: 'open'; title: string; text?: string; rows: OpenRow[] }
  | { kind: 'channels'; title: string; months: string[] };

export default function ServiceTicketsDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('service_tickets');
  const snap = data as unknown as Snap | undefined;
  const [showAllOpen, setShowAllOpen] = useState(false);
  const [showAllCust, setShowAllCust] = useState(false);
  const [drill, setDrill] = useState<Drill | null>(null);
  const openRef = useRef<HTMLElement>(null);

  const monthly = useMemo(() => snap?.monthly ?? [], [snap]);
  const byMonth = useMemo(() => new Map(monthly.map((r) => [r.month, r])), [monthly]);
  // The classic chart and table include the in-progress month (flagged "partial"); so does this
  // page, labelled "(in progress)". Totals below leave it out.
  const range = useMonthRange(monthly.map((r) => r.month));
  const rows = range.months.map((m) => byMonth.get(m)!).filter(Boolean);
  const complete = rows.filter((r) => !r.partial);
  const partialRow = rows.find((r) => r.partial);

  const t = snap?.ttm;
  const totals = snap?.totals;
  const openAll = snap?.open_tickets ?? [];
  const ttmStart = snap?.window.ttm_start ?? '';
  const purge = (snap?.ttm.purge_months ?? []).map(mlabel).join(', ');
  const mLabel = (r: MonthRow) => `${mlabel(r.month)}${r.partial ? ' (in progress)' : ''}`;

  // ---- open queue (oldest first, as the snapshot orders it)
  const openList = showAllOpen ? openAll : openAll.slice(0, OPEN_LIMIT);
  const openCols: Array<[string, boolean]> = [['Age', true], ['Waiting', false], ['Subject', false], ['Customer', false], ['Owner', false], ['Stage', false], ['Source · priority', false], ['Created', false]];
  const openTable = (list: OpenRow[], label: string, foot?: { all: number; expand?: () => void }) => (
    <div style={{ overflowX: 'auto' }}>
      <DataTable label={label} cols={openCols}
        rows={list.map((o) => [
          o.age_days != null ? `${N0.format(o.age_days)}d` : '—',
          ageTag(o.age_days),
          <span key="s" style={{ display: 'inline-block', minWidth: 220, maxWidth: 300, whiteSpace: 'normal' }}>
            {o.url ? <a className="am-btn am-btn--text" href={o.url} target="_blank" rel="noopener noreferrer" style={{ whiteSpace: 'normal', textAlign: 'left' }}>{o.subject || '(no subject)'}<Icon name="open_in_new" /></a> : (o.subject || '(no subject)')}
          </span>,
          o.customer ?? '—',
          o.owner ?? '—',
          <span key="st" className="am-tag am-tag--neutral">{o.stage ?? '—'}</span>,
          o.source || o.priority ? `${o.source ?? '—'} · ${o.priority ?? '—'}` : '—',
          o.created ?? '—',
        ])}
        sortValues={list.map((o) => [o.age_days, o.age_days, o.subject ?? '', o.customer ?? '', o.owner ?? '', o.stage ?? '', `${o.source ?? ''} ${o.priority ?? ''}`, o.created ?? ''])}
        clickable={(c, r) => c === 3 && !!list[r]?.customer}
        onCell={(r) => {
          const o = list[r];
          navigate(o.allmoxy_customer_id != null ? `/customer-detail?id=${encodeURIComponent(String(o.allmoxy_customer_id))}` : `/customer-detail?name=${encodeURIComponent(o.customer ?? '')}`);
          setDrill(null);
        }}
        foot={foot ? [`Total · ${N0.format(foot.all)}`, '', '', '', '', '', '', ''] : undefined}
        onFoot={foot?.expand} footClickable={(c) => c === 0 && !!foot?.expand} />
    </div>
  );
  const openOwner = (owner: string | null) => {
    // Owner cuts are TTM, so their "still open" is the open tickets created since the TTM start.
    const rows = openAll.filter((o) => (o.created ?? '') >= ttmStart && (owner == null || ownerKey(o.owner) === owner));
    setDrill({ kind: 'open', title: owner == null ? 'Still open · all owners' : `Still open · ${owner}`, text: `Open tickets created since ${mlabel(ttmStart)} (the trailing twelve months), oldest first.`, rows });
  };

  // ---- volume / backlog / time to close series
  const volSeries = [
    { key: 'created', label: 'Created', tone: 'div-1', values: rows.map((r) => r.created) },
    { key: 'closed', label: 'Closed', tone: 'div-2', values: rows.map((r) => -r.closed) },
  ];
  const sum = (k: 'created' | 'closed' | 'net') => complete.reduce((a, r) => a + r[k], 0);

  // ---- owners
  const owners = snap?.by_owner ?? [];
  const sources = snap?.by_source ?? [];
  const customers = snap?.customers ?? [];

  // ---- CSVs (same columns and rows as the classic page)
  const csvOwners = () => downloadCsv('service_tickets_by_owner', ['Owner', 'Tickets (TTM)', 'Open', 'Closed', 'Median close (days)', 'Measurable'],
    owners.map((o) => [o.key, o.tickets, o.open, o.closed, o.median_resolution_days ?? '', o.measurable]));
  const csvCustomers = () => downloadCsv('service_tickets_by_customer', ['Customer', 'Allmoxy ID', 'Status', 'MRR', 'Tickets (TTM)', 'Tickets (all time)', 'Open', 'Tickets per $1K MRR', 'Median close (days)', 'Last ticket'],
    customers.map((c) => [c.name, c.allmoxy_customer_id, c.status ?? '', c.mrr, c.ttm_tickets, c.tickets, c.open, c.tickets_per_1k_mrr ?? '', c.median_resolution_days ?? '', c.last_ticket ?? '']));
  const csvOpen = () => downloadCsv('service_tickets_open', ['Age (days)', 'Subject', 'Customer', 'Owner', 'Stage', 'Source', 'Priority', 'Created', 'HubSpot URL'],
    openAll.map((o) => [o.age_days ?? '', o.subject ?? '', o.customer ?? '', o.owner ?? '', o.stage ?? '', `${o.source ?? ''} ${o.priority ?? ''}`, o.created ?? '', o.url ?? '']));
  const csvMonthly = () => downloadCsv('service_tickets_monthly', ['Month', 'Created', 'Closed', 'Net', 'Backlog', 'Median close (days)', 'p90 close (days)', 'Bulk-close share', 'Backlog clear-out'],
    monthly.map((r) => [r.month, r.created, r.closed, r.net, r.open_at_month_end, r.cohort_median_resolution_days ?? '', r.cohort_p90_resolution_days ?? '', r.instant_close_rate ?? '', String(r.backlog_purge)]));

  // ---- channel-by-month drill (what a month's created count, or the range total, is made of)
  const channelSheet = (months: string[]) => {
    const rs = months.map((m) => byMonth.get(m)!).filter(Boolean);
    const keys = [...new Set(rs.flatMap((r) => Object.keys(r.by_source ?? {})))].sort((a, b) => rs.reduce((s, r) => s + (r.by_source[b] ?? 0), 0) - rs.reduce((s, r) => s + (r.by_source[a] ?? 0), 0));
    const list = [...rs].reverse();
    return (
      <DataTable label="Tickets created by channel" cols={[['Month', false], ...keys.map((k) => [k, true] as [string, boolean]), ['Created', true]]}
        rows={list.map((r) => [mLabel(r), ...keys.map((k) => N0.format(r.by_source[k] ?? 0)), N0.format(r.created)])}
        sortValues={list.map((r) => [r.month, ...keys.map((k) => r.by_source[k] ?? 0), r.created])}
        foot={rs.length > 1 ? [`Total · ${rs.length} months`, ...keys.map((k) => N0.format(rs.reduce((s, r) => s + (r.by_source[k] ?? 0), 0))), N0.format(rs.reduce((s, r) => s + r.created, 0))] : undefined} />
    );
  };

  const headerSub = 'HubSpot Help Desk volume, backlog and responsiveness: how much support the business absorbs, and how fast it clears.';

  return (
    <DsPage
      path="/service-tickets"
      title="Service Tickets"
      subtitle={headerSub}
      actions={<button className="am-btn am-btn--outlined" onClick={csvMonthly} disabled={!monthly.length}><Icon name="download" />Export monthly CSV</button>}
      overlays={drill && (
        <SideSheet open onClose={() => setDrill(null)} title={drill.title} text={drill.kind === 'open' ? drill.text : 'Tickets created each month, split by the channel they arrived through.'}>
          {drill.kind === 'open'
            ? (drill.rows.length ? openTable(drill.rows, drill.title, { all: drill.rows.length }) : <p className="am-card__text">No open tickets here.</p>)
            : channelSheet(drill.months)}
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Failed to load service_tickets: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="Open now" value={isLoading ? '…' : N0.format(totals?.open ?? 0)} hint="In the help desk queue, as HubSpot shows it"
          tag={(totals?.open ?? 0) > 200 ? 'High backlog' : 'Under control'} tagTone={(totals?.open ?? 0) > 200 ? 'warning' : 'success'}
          onOpen={() => openRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
        <KpiCard label="Tickets / month" value={isLoading ? '…' : N0.format(Math.round(t?.per_month ?? 0))} hint="Trailing 12 months" />
        <KpiCard label="Median time to close" value={isLoading ? '…' : days(t?.cohort_median_resolution_days)} hint={`Tickets created in the trailing 12 months · ${N0.format(t?.cohort_measurable ?? 0)} measurable`} />
        <KpiCard label="Closed within 7 days" value={isLoading ? '…' : pct(t?.within_7d_rate)} hint={`${pct(t?.same_day_rate)} same day · same tickets as the median`} />
        <KpiCard label="Net queue change" value={isLoading ? '…' : signedN(t?.net ?? 0)} hint={`${N0.format(t?.created ?? 0)} in · ${N0.format(t?.closed ?? 0)} out (trailing 12 months)`}
          tag={(t?.net ?? 0) > 0 ? 'Queue growing' : 'Queue shrinking'} tagTone={(t?.net ?? 0) > 0 ? 'error' : 'success'} />
      </KpiGrid>

      {snap && (
        <section className="am-card am-card--outlined">
          <div className="am-row" style={{ alignItems: 'flex-start' }}>
            <span className="am-tag am-tag--info" style={{ flexShrink: 0 }}>How times are measured</span>
            <p className="am-card__text">
              <b>Resolution times exclude bulk closes.</b> {pct(snap.data_quality.instant_close_rate_all_time)} of all closed tickets carry a close timestamp identical to their creation, a migration artifact, not handling time. Left in, the median reads 0 days and the team looks instantaneous.
              The rate is falling fast as the desk matures (93% of 2023 tickets, 40% of 2025, 19% of 2026), so recent months carry far more signal.
              {snap.ttm.purge_months.length > 0 && <> One month in the window, <b>{purge}</b>, closed more than three times what it took in: a backlog clear-out, flagged in the month-by-month table.</>}
              {' '}Volume and backlog are unaffected: creation dates are real throughout.
            </p>
          </div>
        </section>
      )}

      <section className="am-card am-card--outlined" ref={openRef}>
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Open tickets · {N0.format(openAll.length)}</span>
            <span className="am-chart__caption">The help desk queue (Customer Success, Solution Architect and CS - Dev tickets since the help desk went live on Oct 22, 2026), oldest first. Implementation (IPA) projects and older unclosed tickets outside the help desk are left out. Age is days since creation.</span>
          </div>
          <button className="am-btn am-btn--text" onClick={csvOpen} disabled={!openAll.length}><Icon name="download" />CSV</button>
        </div>
        {isLoading ? <p className="am-card__text">Loading tickets…</p> : openTable(openList, 'Open tickets', {
          all: openAll.length, expand: !showAllOpen && openAll.length > OPEN_LIMIT ? () => setShowAllOpen(true) : undefined,
        })}
        {!showAllOpen && openAll.length > OPEN_LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAllOpen(true)}>Show all {openAll.length}</button>}
        {showAllOpen && openAll.length > OPEN_LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAllOpen(false)}>Show the oldest {OPEN_LIMIT}</button>}
      </section>

      <ChartCard title="Volume" caption={`Tickets created (up) against tickets closed (down) each month: when the columns balance, the desk is keeping pace · the figure on each month is its net change · ${range.rangeText}`}>
        <div className="am-row am-row--wrap">{range.controls}</div>
        <ColumnChart months={range.months} series={volSeries} fmt={(v) => N0.format(v)} stacked legend
          labelFor={(i) => { const r = rows[i]; return r ? signedN(r.created - r.closed) : null; }}
          catTitle={(m) => `${mlabel(m)}${byMonth.get(m)?.partial ? ' (in progress)' : ''}`}
          tipRows={(i) => { const r = rows[i]; return r ? [['Created', N0.format(r.created)], ['Closed', N0.format(r.closed)], ['Net', signedN(r.net)], ['Open at month end', N0.format(r.open_at_month_end)], ...(r.backlog_purge ? [['Note', 'Backlog clear-out'] as [string, string]] : [])] : []; }}
          onSegment={(i) => setDrill({ kind: 'channels', title: `Tickets by channel · ${mlabel(range.months[i])}`, months: [range.months[i]] })}
          aria={`Tickets created and closed each month, ${range.rangeText}.`} />
      </ChartCard>

      <>
        <ChartCard title="Open at month end" caption={`The running backlog. It is a created-minus-closed balance from the first month on record (${snap?.window.first_month ? mlabel(snap.window.first_month) : '…'}), so it is a trend rather than an audited count.`}>
          <ColumnChart months={range.months} series={[{ key: 'backlog', label: 'Open at month end', tone: 'other', values: rows.map((r) => r.open_at_month_end) }]}
            fmt={(v) => N0.format(v)} catTitle={(m) => `${mlabel(m)}${byMonth.get(m)?.partial ? ' (in progress)' : ''}`}
            aria={`Open tickets at month end, ${range.rangeText}.`} />
        </ChartCard>
        <ChartCard title="Time to close" caption={`Of the tickets created in a month, the median time they took to close. Not "tickets closed this month", which a backlog clear-out distorts (${purge || 'one month in this window'} closed old tickets en masse). Recent months read slightly fast: tickets still open are left out.`}>
          <ColumnChart months={range.months} series={[{ key: 'res', label: 'Median time to close', tone: 'div-1', values: rows.map((r) => r.cohort_median_resolution_days ?? 0) }]}
            fmt={(v) => `${Math.round(v * 10) / 10}d`}
            labelFor={(i) => { const r = rows[i]; return r && r.cohort_median_resolution_days != null ? days(r.cohort_median_resolution_days) : null; }}
            catTitle={(m) => `${mlabel(m)}${byMonth.get(m)?.partial ? ' (in progress)' : ''}`}
            tipRows={(i) => { const r = rows[i]; return r ? [['Median time to close', days(r.cohort_median_resolution_days)], ['90th percentile', days(r.cohort_p90_resolution_days)], ['Measurable tickets', N0.format(r.cohort_measurable)]] : []; }}
            aria={`Median time to close by month created, ${range.rangeText}.`} />
        </ChartCard>
      </>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Who is handling them</span>
            <span className="am-chart__caption">Trailing twelve months, by ticket owner in HubSpot. Median close excludes bulk closes, so an owner who inherited a migration batch is not credited with instant resolutions. Select a still-open count to see those tickets.</span>
          </div>
          <button className="am-btn am-btn--text" onClick={csvOwners} disabled={!owners.length}><Icon name="download" />CSV</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Tickets by owner" cols={[['Owner', false], ['Tickets (TTM)', true], ['Still open', true], ['Closed', true], ['Median close', true], ['Measurable', true]]}
            rows={owners.map((o) => [o.key, N0.format(o.tickets), o.open ? N0.format(o.open) : '—', N0.format(o.closed), days(o.median_resolution_days), N0.format(o.measurable)])}
            sortValues={owners.map((o) => [o.key, o.tickets, o.open, o.closed, o.median_resolution_days, o.measurable])}
            clickable={(c, r) => c === 2 && owners[r]?.open > 0} onCell={(r) => openOwner(owners[r].key)}
            foot={[`Total · ${owners.length} owners`, N0.format(owners.reduce((a, o) => a + o.tickets, 0)), N0.format(owners.reduce((a, o) => a + o.open, 0)), N0.format(owners.reduce((a, o) => a + o.closed, 0)), '', N0.format(owners.reduce((a, o) => a + o.measurable, 0))]}
            footClickable={(c) => c === 2} onFoot={() => openOwner(null)} />
        </div>
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Where tickets come from</span>
          <span className="am-chart__caption">Channel mix across the full history. Chat volume is the lever most worth watching: it is cheaper to serve than email but tends to arrive in bursts. Select the total to see the mix month by month.</span>
        </div>
        <DataTable label="Tickets by channel" cols={[['Channel', false], ['Tickets', true], ['Share', true], ['Median close', true]]}
          rows={sources.map((s) => [s.key, N0.format(s.tickets), pct(s.tickets / (totals?.tickets || 1)), days(s.median_resolution_days)])}
          sortValues={sources.map((s) => [s.key, s.tickets, s.tickets / (totals?.tickets || 1), s.median_resolution_days])}
          foot={[`Total · ${sources.length} channels`, N0.format(sources.reduce((a, s) => a + s.tickets, 0)), pct(sources.reduce((a, s) => a + s.tickets, 0) / (totals?.tickets || 1)), days(totals?.median_resolution_days)]}
          footClickable={(c) => c === 1} onFoot={() => setDrill({ kind: 'channels', title: 'Tickets by channel · all months', months: monthly.map((r) => r.month) })} />
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Heaviest support load</span>
            <span className="am-chart__caption">Tickets per $1K MRR is the ratio worth watching: support cost against what the account actually pays. A high number (over 12) is a margin problem, and in this book it has also run ahead of churn. {snap?.data_quality.attribution}</span>
          </div>
          <button className="am-btn am-btn--text" onClick={csvCustomers} disabled={!customers.length}><Icon name="download" />CSV</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label="Tickets by customer"
            cols={[['Customer', false], ['Tickets (TTM)', true], ['All time', true], ['Open', true], ['MRR', true], ['Per $1K MRR', true], ['Load', false], ['Median close', true], ['Last ticket', false]]}
            rows={customers.map((c) => [
              c.name, N0.format(c.ttm_tickets), N0.format(c.tickets), c.open ? N0.format(c.open) : '—', c.mrr > 0 ? usd(c.mrr) : '—',
              c.tickets_per_1k_mrr == null ? '—' : c.tickets_per_1k_mrr.toFixed(1),
              (c.tickets_per_1k_mrr ?? 0) > 12 ? <span key="l" className="am-tag am-tag--error">Heavy</span> : '',
              days(c.median_resolution_days), c.last_ticket ?? '—',
            ])}
            sortValues={customers.map((c) => [c.name, c.ttm_tickets, c.tickets, c.open, c.mrr, c.tickets_per_1k_mrr, (c.tickets_per_1k_mrr ?? 0) > 12 ? 1 : 0, c.median_resolution_days, c.last_ticket])}
            limit={showAllCust ? undefined : CUST_LIMIT}
            clickable={(c, r) => c === 0 || (c === 3 && customers[r]?.open > 0)}
            onCell={(r, c) => {
              const x = customers[r];
              if (c === 3) setDrill({ kind: 'open', title: `Open tickets · ${x.name}`, text: 'Everything still open for this customer, oldest first.', rows: openAll.filter((o) => o.allmoxy_customer_id === x.allmoxy_customer_id) });
              else navigate(`/customer-detail?id=${encodeURIComponent(String(x.allmoxy_customer_id))}`);
            }}
            foot={[`Total · ${N0.format(customers.length)} customers`, N0.format(customers.reduce((a, c) => a + c.ttm_tickets, 0)), N0.format(customers.reduce((a, c) => a + c.tickets, 0)), N0.format(customers.reduce((a, c) => a + c.open, 0)), usd(customers.reduce((a, c) => a + c.mrr, 0)), '', '', '', '']}
            footClickable={(c) => c === 3 || ((c === 0 || c === 1 || c === 2 || c === 4) && !showAllCust && customers.length > CUST_LIMIT)}
            onFoot={(c) => {
              if (c === 3) setDrill({ kind: 'open', title: 'Open tickets · matched customers', text: 'Every open ticket linked to a customer record, oldest first.', rows: openAll.filter((o) => o.allmoxy_customer_id != null) });
              else setShowAllCust(true);
            }} />
        </div>
        {!showAllCust && customers.length > CUST_LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAllCust(true)}>Show all {N0.format(customers.length)}</button>}
        {showAllCust && <button className="am-btn am-btn--text" onClick={() => setShowAllCust(false)}>Show the top {CUST_LIMIT}</button>}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Month by month</span>
            <span className="am-chart__caption">Newest first · {range.rangeText} · median and 90th percentile are for the tickets created that month · select a created count to see its channels{partialRow ? ` · ${mlabel(partialRow.month)} is in progress and left out of the total` : ''}</span>
          </div>
          <button className="am-btn am-btn--text" onClick={csvMonthly} disabled={!monthly.length}><Icon name="download" />CSV</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {(() => {
            const list = [...rows].reverse();
            return (
              <DataTable label="Service tickets month by month"
                cols={[['Month', false], ['Note', false], ['Created', true], ['Closed', true], ['Net', true], ['Backlog', true], ['Median close', true], ['90th percentile', true], ['Bulk closes', true]]}
                rows={list.map((r) => [
                  mLabel(r),
                  r.backlog_purge ? <span key="n" className="am-tag am-tag--warning">Backlog clear-out</span> : r.partial ? <span key="n" className="am-tag am-tag--neutral">In progress</span> : '',
                  N0.format(r.created), N0.format(r.closed), signedN(r.net), N0.format(r.open_at_month_end),
                  days(r.cohort_median_resolution_days), days(r.cohort_p90_resolution_days), pct(r.instant_close_rate),
                ])}
                sortValues={list.map((r) => [r.month, r.backlog_purge ? 2 : r.partial ? 1 : 0, r.created, r.closed, r.net, r.open_at_month_end, r.cohort_median_resolution_days, r.cohort_p90_resolution_days, r.instant_close_rate])}
                clickable={(c) => c === 2}
                onCell={(r) => setDrill({ kind: 'channels', title: `Tickets by channel · ${mlabel(list[r].month)}`, months: [list[r].month] })}
                foot={[`Total · ${complete.length} complete months`, '', N0.format(sum('created')), N0.format(sum('closed')), signedN(sum('net')), complete.length ? N0.format(complete[complete.length - 1].open_at_month_end) : '—', '', '', '']}
                footClickable={(c) => c === 2}
                onFoot={() => setDrill({ kind: 'channels', title: `Tickets by channel · ${complete.length ? `${mlabel(complete[0].month)} to ${mlabel(complete[complete.length - 1].month)}` : ''}`, months: complete.map((r) => r.month) })} />
            );
          })()}
        </div>
      </section>

      {snap && (
        <p className="am-card__text">
          HubSpot Help Desk · {snap.window.first_month} – {snap.window.last_month} · {N0.format(snap.totals.tickets)} tickets ·
          {' '}{N0.format(snap.totals.customers_with_tickets)} customers matched, {N0.format(snap.totals.unattributed_tickets)} tickets with no matching customer record ·
          {' '}synced {snap.source_fetched_at ? snap.source_fetched_at.slice(0, 10) : '—'}
        </p>
      )}
    </DsPage>
  );
}
