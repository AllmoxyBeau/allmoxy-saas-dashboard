/**
 * Project Candidates on the Allmoxy design system. Data logic is ported verbatim from the classic
 * page (ProjectCandidates.tsx, kept at /project-candidates-classic): same project_candidates
 * snapshot, same snapshot totals for the KPI tiles, same row order (the snapshot's, largest MRR
 * first), same columns and the same CSV (filename project_candidates, the classic export values).
 *
 * The page is a hand-off list for Sales: who to call, warmest leads visible at a glance. When no
 * one is flagged yet it says so plainly and tells the reader how a customer gets on the list.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, Icon, KpiCard, KpiGrid, SideSheet, downloadCsv, usd } from '../design-system/parts';

// Snapshot written by _etl_scripts/build_project_candidates.mjs.
type Row = {
  allmoxy_customer_id: number; name: string; status: string | null; pay_status: string | null;
  account_rep: string | null; current_mrr: number; arr: number;
  lifetime_subscription: number; lifetime_services: number; has_bought_services: boolean;
  sign_up_date: string | null; tenure_months: number | null;
  risk_tier: string | null; risk_score: number | null; is_launched: boolean | null;
  lifetime_orders: number | null; hubspot_company_id: string | null; note: string | null;
};
type Snap = {
  fetchedAt: string; updated_at: string | null;
  totals: { count: number; total_mrr: number; total_arr: number; already_bought_services: number; total_prior_services: number };
  customers: Row[];
};

function fmtDate(iso: string | null | undefined) { if (!iso) return '—'; const [y, m, d] = String(iso).slice(0, 10).split('-'); return `${m}/${d}/${y}`; }
const tenure = (m: number | null) => (m == null ? '—' : m >= 12 ? `${(m / 12).toFixed(1)} yr` : `${m} mo`);

// Churn-risk tier → a word and a tone (never color alone).
const RISK: Record<string, { label: string; tone: 'error' | 'warning' | 'info' | 'success' | 'neutral' }> = {
  critical: { label: 'Critical', tone: 'error' },
  high: { label: 'High', tone: 'warning' },
  medium: { label: 'Medium', tone: 'info' },
  low: { label: 'Low', tone: 'success' },
};
const RISK_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

const LIMIT = 25;

export default function ProjectCandidatesDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('project_candidates');
  const snap = data as unknown as Snap | undefined;
  const rows = useMemo(() => snap?.customers ?? [], [snap]);
  const t = snap?.totals;
  const [showAll, setShowAll] = useState(false);
  const [help, setHelp] = useState(false);
  const [order, setOrder] = useState<number[] | null>(null);

  const sums = useMemo(() => ({
    mrr: rows.reduce((s, r) => s + r.current_mrr, 0),
    arr: rows.reduce((s, r) => s + r.arr, 0),
    services: rows.reduce((s, r) => s + r.lifetime_services, 0),
    orders: rows.reduce((s, r) => s + (r.lifetime_orders ?? 0), 0),
  }), [rows]);

  // Same columns and export values as the classic DrillDownPanel; follows the header sort.
  const exportCsv = () => {
    const ordered = (order ?? rows.map((_, i) => i)).map((i) => rows[i]);
    downloadCsv('project_candidates',
      ['Customer', 'Account rep', 'MRR', 'ARR', 'Tenure', 'Bought services', 'Orders', 'Risk', 'Why'],
      ordered.map((r) => [r.name, r.account_rep ?? '', r.current_mrr, r.arr, r.tenure_months ?? '', String(r.lifetime_services),
        r.lifetime_orders ?? '', r.risk_tier ?? '', r.note ?? '']));
  };

  const openCustomer = (r: Row) => navigate(`/customer-detail?id=${encodeURIComponent(String(r.allmoxy_customer_id))}`);
  const loading = isLoading || !t;
  const empty = !isLoading && rows.length === 0;

  return (
    <DsPage
      path="/project-candidates"
      title="Project Candidates"
      subtitle="Customers CS has flagged as good fits for a paid project or services engagement. This is the hand-off list for Sales."
      actions={<>
        <button className="am-btn am-btn--text" onClick={() => setHelp(true)}><Icon name="info" />How this list works</button>
        <button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!rows.length}><Icon name="download" />Export CSV</button>
      </>}
      overlays={
        <SideSheet open={help} onClose={() => setHelp(false)} title="How this list works">
          <p className="am-card__text"><b>What it is.</b> Every customer flagged as a project candidate, largest first: the order Sales should work the list.</p>
          <p className="am-card__text"><b>How a customer gets here.</b> Open their Customer Detail page and switch on "Project candidate" in the Company Profile section. It is an opinion flag: it changes no revenue, churn or scored number.</p>
          <p className="am-card__text"><b>Reading it.</b> Bought services shows who has already paid for services (the warmest leads). Risk is their churn-risk level: a customer at critical risk may need a save conversation before a project pitch.</p>
          <p className="am-card__text">Use Export CSV to hand the list off.</p>
        </SideSheet>
      }
    >
      {error ? <p className="am-card__text">Failed to load project_candidates: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="Candidates" value={loading ? '…' : String(t!.count)} hint="Flagged by CS"
          tag={loading ? undefined : t!.count > 0 ? 'Ready for Sales' : 'None flagged yet'} tagTone={t && t.count > 0 ? 'info' : 'neutral'} />
        <KpiCard label="Combined MRR" value={loading ? '…' : usd(t!.total_mrr)} hint="Current subscription MRR" />
        <KpiCard label="Combined ARR" value={loading ? '…' : usd(t!.total_arr)} hint="MRR × 12" />
        <KpiCard label="Bought services before" value={loading ? '…' : `${t!.already_bought_services} of ${t!.count}`}
          hint={t ? `${usd(t.total_prior_services)} lifetime services` : ''}
          tag={t && t.already_bought_services > 0 ? 'Warmest leads' : undefined} tagTone="success" />
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Hand-off list</span>
          <span className="am-chart__caption">
            {rows.length} candidate{rows.length === 1 ? '' : 's'}{snap?.updated_at ? ` · list updated ${fmtDate(snap.updated_at)}` : ''} · sorted by current MRR
          </span>
        </div>

        {isLoading ? <p className="am-card__text">Loading candidates…</p> : empty ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '24px 0' }}>
            <span className="am-tag am-tag--neutral">No candidates yet</span>
            <p className="am-card__text" style={{ maxWidth: 640 }}>
              <b>Nobody is on the hand-off list right now.</b> When CS thinks a customer is a good fit for a paid project, they open that
              customer's Customer Detail page and switch on "Project candidate" in the Company Profile section. The customer then shows up
              here, with their MRR, services history and churn risk, ready for Sales.
            </p>
            <div className="am-row am-row--wrap">
              <button className="am-btn am-btn--outlined" onClick={() => navigate('/customers')}><Icon name="group" />Find a customer</button>
              <button className="am-btn am-btn--text" onClick={() => setHelp(true)}>How this list works</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Project candidates"
                cols={[['Customer', false], ['Account rep', false], ['MRR', true], ['ARR', true], ['Tenure', true], ['Bought services', true], ['Orders', true], ['Risk', false], ['Why', false]]}
                rows={rows.map((r) => [
                  r.name,
                  r.account_rep || '—',
                  usd(r.current_mrr),
                  usd(r.arr),
                  tenure(r.tenure_months),
                  r.has_bought_services
                    ? <span key="s" className="am-tag am-tag--success">{usd(r.lifetime_services)}</span>
                    : <span key="s" className="am-tag am-tag--neutral">Not yet</span>,
                  r.lifetime_orders == null ? '—' : r.lifetime_orders.toLocaleString(),
                  r.risk_tier
                    ? <span key="r" className={`am-tag am-tag--${RISK[r.risk_tier]?.tone ?? 'neutral'}`}>{RISK[r.risk_tier]?.label ?? r.risk_tier}</span>
                    : '—',
                  <span key="w" style={{ display: 'inline-block', maxWidth: 360, whiteSpace: 'normal' }}>{r.note || '—'}</span>,
                ])}
                sortValues={rows.map((r) => [r.name, r.account_rep ?? null, r.current_mrr, r.arr, r.tenure_months ?? -1, r.lifetime_services,
                  r.lifetime_orders ?? -1, r.risk_tier ? RISK_RANK[r.risk_tier] ?? 0 : null, r.note ?? null])}
                clickable={(c) => c === 0}
                onCell={(i) => openCustomer(rows[i])}
                onSortChange={(o) => setOrder(o)}
                limit={showAll ? undefined : LIMIT}
                foot={[`Total · ${rows.length} candidates`, '', usd(sums.mrr), usd(sums.arr), '', usd(sums.services), sums.orders.toLocaleString(), '', '']}
                onFoot={() => setShowAll(true)} footClickable={(c) => [0, 2, 3, 5, 6].includes(c) && !showAll && rows.length > LIMIT} />
            </div>
            {!showAll && rows.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {rows.length}</button>}
          </>
        )}
      </section>
    </DsPage>
  );
}
