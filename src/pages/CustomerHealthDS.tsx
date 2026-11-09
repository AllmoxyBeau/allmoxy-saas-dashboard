/**
 * Customer Health on the Allmoxy design system. Data logic is the classic page's
 * (CustomerHealth.tsx, kept at /customer-health-classic): same customer_health snapshot, same
 * concentration slices and thresholds, same distribution buckets (customers + customers_list),
 * the same dunning watch list and summary (customer_profiles failed_3mo), and the same CSV
 * exports (concentration, bucket and dunning drill-downs, same columns and file names).
 *
 * Designer ranking: the dunning watch list (customers to call this week) comes first, then
 * concentration risk, then how the base is spread across price bands, then the top-25 roster.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { safeFilename } from '../lib/csv';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, SideSheet,
  downloadCsv, mlabel, usd, usdk,
} from '../design-system/parts';

type ConcentrationSlice = { n: number; customers: number; mrr: number; pct: number | null };
type TopCustomer = { name: string; allmoxy_customer_id: number | null; current_mrr: number; lifetime_revenue: number; years_with_us: number | null; failed_3mo: number };
type DistributionBucket = { bucket: string; customers: number; mrr: number; customers_list?: TopCustomer[] };
type DunningCustomer = { name: string; allmoxy_customer_id: number | null; current_mrr: number; failed_3mo: number; failed_3mo_amount: number };
type Snap = {
  latestMonth: string;
  concentration: { total_active_customers: number; total_mrr: number; top1: ConcentrationSlice; top5: ConcentrationSlice; top10: ConcentrationSlice; top20: ConcentrationSlice };
  distribution: DistributionBucket[];
  top_customers: TopCustomer[];
  all_active_customers?: TopCustomer[];
  dunning_customers: DunningCustomer[];
  dunning_summary: { total_dunning_customers: number; total_at_risk_amount: number; mrr_at_risk?: number; failed_attempts?: number; failed_attempts_amount?: number };
  notes: string;
};

type Drill =
  | { kind: 'concentration'; n: number; label: string }
  | { kind: 'bucket'; bucket: string }
  | { kind: 'all' }
  | { kind: 'dunning' };

type Tone = 'success' | 'warning' | 'error';
// Same thresholds as the classic page's concentration colors, now a word + tone.
const risk = (v: number | null, good: number, caution: number): { tag?: string; tone?: Tone } =>
  v == null ? {} : v <= good ? { tag: 'Low risk', tone: 'success' } : v <= caution ? { tag: 'Caution', tone: 'warning' } : { tag: 'High risk', tone: 'error' };
const pct1 = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const years = (v: number | null) => (v != null ? v.toFixed(1) : '—');
// 3+ failed attempts usually means a dead card that needs CS outreach (classic: red chip at 3+).
const dunningStatus = (n: number) => (n >= 3 ? { word: 'Needs outreach', tone: 'error' as const } : { word: 'Retrying', tone: 'warning' as const });

const DUNNING_LIMIT = 15;
const monthLong = (iso: string) => { const [y, m] = iso.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); };

export default function CustomerHealthDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('customer_health');
  const snap = data as unknown as Snap | undefined;
  const [drill, setDrill] = useState<Drill | null>(null);
  const [showAllDunning, setShowAllDunning] = useState(false);

  const total = snap?.concentration.total_mrr ?? 0;
  const share = (mrr: number) => `${((mrr / total) * 100).toFixed(2)}%`;
  const openCustomer = (c: { allmoxy_customer_id: number | null; name: string }) =>
    navigate(c.allmoxy_customer_id != null ? `/customer-detail?id=${encodeURIComponent(String(c.allmoxy_customer_id))}` : `/customer-detail?name=${encodeURIComponent(c.name)}`);
  const nameCell = (name: string) => <span style={{ display: 'inline-block', maxWidth: 320, whiteSpace: 'normal', textAlign: 'left' }}>{name}</span>;

  const mrrAtRisk = snap ? snap.dunning_summary.mrr_at_risk ?? snap.dunning_summary.total_at_risk_amount : 0;
  const dunning = snap?.dunning_customers ?? [];
  const dunningList = showAllDunning ? dunning : dunning.slice(0, DUNNING_LIMIT);
  const dunningTotals = useMemo(() => ({
    mrr: dunning.reduce((s, d) => s + d.current_mrr, 0),
    attempts: dunning.reduce((s, d) => s + d.failed_3mo, 0),
    amount: dunning.reduce((s, d) => s + d.failed_3mo_amount, 0),
    outreach: dunning.filter((d) => d.failed_3mo >= 3).length,
  }), [dunning]);

  const exportDunning = () => {
    if (!snap) return;
    downloadCsv(safeFilename(`dunning_${snap.latestMonth}`), ['Customer', 'Current MRR', 'Failed attempts', 'Failed attempts $'],
      snap.dunning_customers.map((d) => [d.name, d.current_mrr, d.failed_3mo, d.failed_3mo_amount]));
  };

  // ---------------------------------------------------------------- drill-down sheet
  const sheet = (() => {
    if (!drill || !snap) return null;
    if (drill.kind === 'dunning') {
      return {
        title: 'Dunning watch list · trailing 3 months',
        text: `${snap.dunning_summary.total_dunning_customers} customers · ${usd(mrrAtRisk)}/mo MRR at risk · ${usd(snap.dunning_summary.failed_attempts_amount ?? 0)} failed-attempt $ (incl. retries)`,
        exportCsv: exportDunning,
        body: (
          <DataTable label="Dunning watch list, all customers"
            cols={[['Customer', false], ['Current MRR', true], ['Failed attempts', true], ['Failed attempts $', true], ['Status', false]]}
            rows={dunning.map((d) => [nameCell(d.name), usd(d.current_mrr), String(d.failed_3mo), usd(d.failed_3mo_amount),
              <span key="s" className={`am-tag am-tag--${dunningStatus(d.failed_3mo).tone}`}>{dunningStatus(d.failed_3mo).word}</span>])}
            sortValues={dunning.map((d) => [d.name, d.current_mrr, d.failed_3mo, d.failed_3mo_amount, d.failed_3mo])}
            clickable={(c) => c === 0} onCell={(i) => openCustomer(dunning[i])}
            foot={[`Total · ${dunning.length} customers`, usd(dunningTotals.mrr), String(dunningTotals.attempts), usd(dunningTotals.amount), '']} />
        ),
      };
    }
    let rows: TopCustomer[]; let title: string; let text: string; let file: string; let ranked: boolean;
    if (drill.kind === 'concentration') {
      rows = (snap.all_active_customers ?? snap.top_customers).slice(0, drill.n);
      const sum = rows.reduce((s, r) => s + r.current_mrr, 0);
      title = `${drill.label} · ${usd(sum)}/mo`;
      text = `${((sum / total) * 100).toFixed(2)}% of total subscription MRR · ${mlabel(snap.latestMonth)}`;
      file = `concentration_top_${drill.n}_${snap.latestMonth}`; ranked = true;
    } else if (drill.kind === 'all') {
      rows = snap.all_active_customers ?? snap.top_customers;
      title = `All active customers · ${usd(rows.reduce((s, r) => s + r.current_mrr, 0))}/mo`;
      text = `${rows.length} customers with MRR in ${mlabel(snap.latestMonth)}, largest first`;
      file = `all_active_customers_${snap.latestMonth}`; ranked = true;
    } else {
      const b = snap.distribution.find((x) => x.bucket === drill.bucket);
      rows = b?.customers_list ?? [];
      title = `MRR bucket: ${drill.bucket}`;
      text = b ? `${b.customers} customers · ${usd(b.mrr)}/mo total` : '';
      file = `mrr_bucket_${drill.bucket}_${snap.latestMonth}`; ranked = false;
    }
    const cols: Array<[string, boolean]> = [...(ranked ? [['#', true] as [string, boolean]] : []), ['Customer', false], ['Current MRR', true], ['% of MRR', true], ['Lifetime revenue', true], ['Years', true], ['Failed 3mo', true]];
    const sum = rows.reduce((s, r) => s + r.current_mrr, 0);
    const life = rows.reduce((s, r) => s + r.lifetime_revenue, 0);
    const failed = rows.reduce((s, r) => s + r.failed_3mo, 0);
    return {
      title, text,
      exportCsv: () => downloadCsv(safeFilename(file),
        [...(ranked ? ['#'] : []), 'Customer', 'Current MRR', '% of MRR', 'Lifetime revenue', 'Years', 'Failed 3mo'],
        rows.map((r, i) => [...(ranked ? [i + 1] : []), r.name, r.current_mrr, r.current_mrr / total, r.lifetime_revenue, r.years_with_us ?? '', r.failed_3mo])),
      body: rows.length ? (
        <DataTable label={title} cols={cols}
          rows={rows.map((r, i) => [...(ranked ? [String(i + 1)] : []), nameCell(r.name), usd(r.current_mrr), share(r.current_mrr), usd(r.lifetime_revenue), years(r.years_with_us), String(r.failed_3mo)])}
          sortValues={rows.map((r, i) => [...(ranked ? [i + 1] : []), r.name, r.current_mrr, r.current_mrr, r.lifetime_revenue, r.years_with_us, r.failed_3mo])}
          clickable={(c) => c === (ranked ? 1 : 0)} onCell={(i) => openCustomer(rows[i])}
          foot={[...(ranked ? [''] : []), `Total · ${rows.length} customers`, usd(sum), share(sum), usd(life), '', String(failed)]} />
      ) : <p className="am-card__text">No customers in this bucket.</p>,
    };
  })();

  const c = snap?.concentration;
  const dist = snap?.distribution ?? [];
  const top = snap?.top_customers ?? [];
  const topSum = top.reduce((s, r) => s + r.current_mrr, 0);
  const distCustomers = dist.reduce((s, b) => s + b.customers, 0);
  const distMrr = dist.reduce((s, b) => s + b.mrr, 0);
  const allCount = snap?.all_active_customers?.length ?? 0;

  return (
    <DsPage
      path="/customer-health"
      title="Customer Health"
      subtitle="Who is at risk this week, who drives our MRR, and how the customer base is spread across price bands."
      actions={<button className="am-btn am-btn--outlined" onClick={exportDunning} disabled={!dunning.length}><Icon name="download" />Export dunning list</button>}
      overlays={sheet && (
        <SideSheet open onClose={() => setDrill(null)} title={sheet.title} text={sheet.text}>
          <div className="am-row">
            <button className="am-btn am-btn--text" onClick={sheet.exportCsv}><Icon name="download" />Export CSV</button>
          </div>
          <div style={{ overflowX: 'auto' }}>{sheet.body}</div>
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Failed to load customer_health: {String(error)}</p> : null}
      {snap && c && (
        <p className="am-card__text">
          Reference month: {monthLong(snap.latestMonth)} · {c.total_active_customers} active customers · {usd(c.total_mrr)} subscription MRR
        </p>
      )}

      <KpiGrid>
        <KpiCard label="MRR at risk · failed charges" value={isLoading || !snap ? '…' : usd(mrrAtRisk)}
          hint={snap ? `${snap.dunning_summary.total_dunning_customers} customers with failed charges in the last 3 months` : undefined}
          tag={snap ? (snap.dunning_summary.total_dunning_customers > 0 ? `${dunningTotals.outreach} need outreach` : 'Clear') : undefined}
          tagTone={snap && snap.dunning_summary.total_dunning_customers > 0 ? 'error' : 'success'}
          onOpen={() => setDrill({ kind: 'dunning' })} />
        {([
          ['Top 1 customer', c?.top1, 0.05, 0.10, top[0]?.name ?? '', 1, 'Top 1 customer'],
          ['Top 5 customers', c?.top5, 0.15, 0.30, 'Target 15% or less', 5, 'Top 5 customers'],
          ['Top 10 customers', c?.top10, 0.25, 0.40, 'Target 25% or less', 10, 'Top 10 customers'],
          ['Top 20 customers', c?.top20, 0.40, 0.55, 'Target 40% or less', 20, 'Top 20 customers'],
        ] as Array<[string, ConcentrationSlice | undefined, number, number, string, number, string]>).map(([label, slice, good, caution, sub, n, dl]) => {
          const r = risk(slice?.pct ?? null, good, caution);
          return (
            <KpiCard key={label} label={`${label} · % of MRR`} value={slice ? pct1(slice.pct) : '…'}
              hint={slice ? `${usd(slice.mrr)}/mo${sub ? ` · ${sub}` : ''}` : undefined}
              tag={r.tag} tagTone={r.tone} onOpen={() => setDrill({ kind: 'concentration', n, label: dl })} />
          );
        })}
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Dunning watch list · failed charges in the last 3 months</span>
            <span className="am-chart__caption">
              {snap ? `${snap.dunning_summary.total_dunning_customers} customers · ${usd(mrrAtRisk)}/mo MRR at risk` : 'Loading…'}
              {snap?.dunning_summary.failed_attempts_amount != null ? ` · ${snap.dunning_summary.failed_attempts ?? 0} failed attempts · ${usd(snap.dunning_summary.failed_attempts_amount)} failed-attempt $ (incl. retries)` : ''}
            </span>
          </div>
          {dunning.length > 0 && (
            <div className="am-row am-row--tight">
              <button className="am-btn am-btn--text" onClick={() => setDrill({ kind: 'dunning' })}><Icon name="list_alt" />View all</button>
              <button className="am-btn am-btn--text" onClick={exportDunning}><Icon name="download" />Export CSV</button>
            </div>
          )}
        </div>
        <p className="am-card__text">
          Intervene before they churn. MRR at risk is these customers' MRR, what is lost if they do not recover. Failed attempts $ adds up every retry, so one $3,299 invoice retried five times reads $16,495; it is context, not exposure. Three or more attempts usually means a dead card that needs a call.
        </p>
        {isLoading || !snap ? <p className="am-card__text">Loading…</p> : dunning.length === 0 ? (
          <p className="am-card__text">No customers with failed charges in the last 3 months.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Dunning watch list"
              cols={[['Customer', false], ['Current MRR', true], ['Failed attempts', true], ['Failed attempts $', true], ['Status', false]]}
              rows={dunningList.map((d) => [nameCell(d.name), usd(d.current_mrr), String(d.failed_3mo), usd(d.failed_3mo_amount),
                <span key="s" className={`am-tag am-tag--${dunningStatus(d.failed_3mo).tone}`}>{dunningStatus(d.failed_3mo).word}</span>])}
              sortValues={dunningList.map((d) => [d.name, d.current_mrr, d.failed_3mo, d.failed_3mo_amount, d.failed_3mo])}
              clickable={(col) => col === 0} onCell={(i) => openCustomer(dunningList[i])}
              foot={[`Total · ${dunning.length} customers`, usd(dunningTotals.mrr), String(dunningTotals.attempts), usd(dunningTotals.amount), '']}
              footClickable={(col) => col < 4} onFoot={() => setDrill({ kind: 'dunning' })} />
          </div>
        )}
        {!showAllDunning && dunning.length > DUNNING_LIMIT && (
          <button className="am-btn am-btn--text" onClick={() => setShowAllDunning(true)}>Show all {dunning.length}</button>
        )}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Customer MRR distribution · {c?.total_active_customers ?? '…'} active customers</span>
          <span className="am-chart__caption">Each active customer slotted into a monthly price band for {snap ? monthLong(snap.latestMonth) : '…'} · select a bar or a row to see its customers</span>
        </div>
        {isLoading || !snap ? <p className="am-card__text">Loading…</p> : (
          <>
            <div className="am-grid" style={{ ['--am-grid-min' as string]: 'max(420px, calc((100% - var(--am-space-block)) / 2))' }}>
              <ChartCard title="Customers per band">
                <ColumnChart months={dist.map((b) => b.bucket)} catLabel={(k) => k} catTitle={(k) => `MRR band ${k}`}
                  series={[{ key: 'customers', label: 'Customers', tone: 'div-1', values: dist.map((b) => b.customers) }]}
                  fmt={(v) => Math.round(v).toLocaleString()}
                  tipRows={(i) => [['Customers', String(dist[i].customers)], ['MRR', usd(dist[i].mrr)], ['% of MRR', share(dist[i].mrr)]]}
                  onSegment={(i) => setDrill({ kind: 'bucket', bucket: dist[i].bucket })}
                  aria="Customer count by MRR band." />
              </ChartCard>
              <ChartCard title="Total MRR per band">
                <ColumnChart months={dist.map((b) => b.bucket)} catLabel={(k) => k} catTitle={(k) => `MRR band ${k}`}
                  series={[{ key: 'mrr', label: 'MRR', tone: 'div-2', values: dist.map((b) => b.mrr) }]}
                  fmt={usdk}
                  tipRows={(i) => [['MRR', usd(dist[i].mrr)], ['Customers', String(dist[i].customers)], ['% of MRR', share(dist[i].mrr)]]}
                  onSegment={(i) => setDrill({ kind: 'bucket', bucket: dist[i].bucket })}
                  aria="Total MRR by MRR band." />
              </ChartCard>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="MRR bands"
                cols={[['MRR band', false], ['Customers', true], ['MRR', true], ['% of MRR', true]]}
                rows={dist.map((b) => [b.bucket, String(b.customers), usd(b.mrr), share(b.mrr)])}
                sortValues={dist.map((b, i) => [i, b.customers, b.mrr, b.mrr])}
                clickable={(col) => col <= 2} onCell={(i) => setDrill({ kind: 'bucket', bucket: dist[i].bucket })}
                foot={[`Total · ${dist.length} bands`, String(distCustomers), usd(distMrr), share(distMrr)]}
                footClickable={(col) => col <= 2 && allCount > 0} onFoot={() => setDrill({ kind: 'all' })} />
            </div>
          </>
        )}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Top {top.length || 25} customers by current MRR</span>
            <span className="am-chart__caption">Current MRR from the canonical customer base · lifetime revenue from Stripe Sync succeeded charges · years since first payment · failed charges in the last 3 months from live Stripe</span>
          </div>
          {allCount > 0 && <button className="am-btn am-btn--text" onClick={() => setDrill({ kind: 'all' })}><Icon name="list_alt" />See all {allCount} active customers</button>}
        </div>
        {isLoading || !snap ? <p className="am-card__text">Loading…</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Top customers by current MRR"
              cols={[['#', true], ['Customer', false], ['Current MRR', true], ['% of MRR', true], ['Lifetime revenue', true], ['Years', true], ['Flags', false]]}
              rows={top.map((r, i) => [String(i + 1), nameCell(r.name), usd(r.current_mrr), share(r.current_mrr), usd(r.lifetime_revenue), years(r.years_with_us),
                r.failed_3mo > 0 ? <span key="f" className="am-tag am-tag--error">{r.failed_3mo} failed</span> : <span key="f" className="am-tag am-tag--success">OK</span>])}
              sortValues={top.map((r, i) => [i + 1, r.name, r.current_mrr, r.current_mrr, r.lifetime_revenue, r.years_with_us, r.failed_3mo])}
              clickable={(col) => col === 1} onCell={(i) => openCustomer(top[i])}
              foot={['', `Total · top ${top.length}`, usd(topSum), share(topSum), usd(top.reduce((s, r) => s + r.lifetime_revenue, 0)), '', '']}
              footClickable={(col) => col >= 1 && col <= 4} onFoot={() => setDrill({ kind: 'concentration', n: top.length, label: `Top ${top.length} customers` })} />
          </div>
        )}
      </section>

      {snap?.notes && <p className="am-card__text">{snap.notes}</p>}
    </DsPage>
  );
}
