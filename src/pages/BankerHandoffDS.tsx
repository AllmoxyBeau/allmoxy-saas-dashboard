/**
 * Banker Handoff on the Allmoxy design system. Same snapshots and logic as the classic page
 * (BankerHandoff.tsx, kept at /banker-handoff-classic): invariant_test_results,
 * adjustments_register, ebitda_bridge, annual_amortization_evidence, customer_base and
 * customer_profiles_roster. The punch list is derived from those snapshots, never hand-kept.
 *
 * Order: readiness and the open punch list first (what to resolve before handoff), then the
 * headline figures, the reading order of the diligence stack, and the companion documents.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, KpiCard, KpiGrid, Link, usd } from '../design-system/parts';

type InvariantSummary = { total: number; passed: number; errors: number; warnings: number; status: 'green' | 'yellow' | 'red' };
type AdjustmentsSummary = { totals?: { total: number; by_category: Record<string, number>; by_severity: Record<string, number> } };
type EbitdaBridge = {
  source?: { pnl_window?: string; last_pnl_month?: string; qoe_adjustment_count?: number; qoe_adjustments_placeholder_count?: number };
  bridges?: {
    ytd_current?: { label?: string; end?: string; net_income?: number; gaap_ebitda?: number; adjusted_ebitda?: number; gaap_ebitda_margin?: number | null; adjusted_ebitda_margin?: number | null };
    ttm?: { label?: string; unavailable?: boolean; reason?: string; start?: string; end?: string };
  };
};
type AmortEvidence = {
  summary?: { annual_payer_count: number; total_amortized_dollars: number; recognized_to_date_dollars?: number; as_of_month?: string; payers_verified: number; payers_with_contract_link: number };
  entries?: Array<{ customer_name: string; contract_link: string | null }>;
};
type CustomerBase = { members: Array<{ allmoxy_customer_id: number }> };
type RosterRow = { allmoxy_customer_id: number; status: string | null; sub_segment: string | null; churn_reason: string | null };

const SECTIONS: Array<{ step: number; title: string; path: string; oneLiner: string }> = [
  { step: 1, title: 'Definitions', path: '/definitions', oneLiner: 'Canonical formula + source + window + sign-off for every metric. Read this FIRST.' },
  { step: 2, title: 'Invariant Tests', path: '/invariant-tests', oneLiner: 'Automated self-consistency checks. Green = no blockers. Red = hard QoE failure.' },
  { step: 3, title: 'Adjustments Register', path: '/adjustments-register', oneLiner: 'Every override made to raw source data, consolidated. The single most important QoE artifact.' },
  { step: 4, title: 'Annual Amortization Evidence', path: '/annual-amortization-evidence', oneLiner: 'Per annual-payer: source payment trace, realized amortization, QB treatment, sign-off.' },
  { step: 5, title: 'Adjusted EBITDA Bridge', path: '/ebitda-bridge', oneLiner: 'GAAP NI → standard add-backs → GAAP EBITDA → QoE adjustments → Adjusted EBITDA.' },
  { step: 6, title: 'Stripe ↔ QB Reconciliation', path: '/stripe-qb-reconciliation', oneLiner: 'Per-month tie-out of Stripe payments to QuickBooks revenue. Status tag on every month.' },
];

const DOCS: Array<[string, string]> = [
  ['DATA_ROOM_README.md', 'The first document a banker reads. Cover map of the package, adjustment philosophy, customer-count reconciliation, source data trace, and the punch list.'],
  ['BANKER_METHODOLOGY.md', 'How the numbers are derived. Core principle, raw sources, adjustment pipeline, customer-state taxonomy, EBITDA bridge methodology, churn definition, reconciliation logic, invariant testing, scope limits.'],
  ['REFRESH_RUNBOOK.md', 'How to refresh the data room. Prerequisites, standard refresh, source-data updates, adding new adjustments, troubleshooting, verification checklist, common one-off scripts.'],
];

const STATUS: Record<InvariantSummary['status'], { word: string; tone: 'error' | 'warning' | 'success' }> = {
  red: { word: 'Red · not ready', tone: 'error' },
  yellow: { word: 'Yellow · warnings to review', tone: 'warning' },
  green: { word: 'Green · ready', tone: 'success' },
};

export default function BankerHandoffDS() {
  const navigate = useNavigate();
  const { data: invariantData } = useSheetTab('invariant_test_results');
  const { data: adjData } = useSheetTab('adjustments_register');
  const { data: ebitdaData } = useSheetTab('ebitda_bridge');
  const { data: amortData } = useSheetTab('annual_amortization_evidence');
  const { data: baseData } = useSheetTab('customer_base');
  const { data: rosterData } = useSheetTab('customer_profiles_roster');

  const inv = invariantData as unknown as InvariantSummary | undefined;
  const adj = adjData as unknown as AdjustmentsSummary | undefined;
  const ebitdaSnap = ebitdaData as unknown as EbitdaBridge | undefined;
  const ebitda = ebitdaSnap?.bridges?.ytd_current;
  const amortSnap = amortData as unknown as AmortEvidence | undefined;
  const amort = amortSnap?.summary;
  const base = baseData as unknown as CustomerBase | undefined;
  const roster = (rosterData as unknown as { rows?: RosterRow[] } | undefined)?.rows;
  // The EBITDA window always names its last P&L month (QuickBooks lags the calendar).
  const ytdLabel = ebitda?.label
    ? (ebitda.label.includes('through') ? ebitda.label : `${ebitda.label} through ${ebitda.end ?? ebitdaSnap?.source?.last_pnl_month ?? '—'}`)
    : 'YTD';

  // Punch list: derived from the snapshots (same rules and wording as the classic page), so it
  // can never go stale. Each item also names the page where it is resolved.
  const punchList = useMemo(() => {
    const items: Array<{ text: string; to: string; where: string }> = [];
    const placeholders = ebitdaSnap?.source?.qoe_adjustments_placeholder_count ?? 0;
    if (placeholders > 0) {
      items.push({ text: `EBITDA add-backs: ${placeholders} of ${ebitdaSnap?.source?.qoe_adjustment_count ?? placeholders} QoE adjustments are still placeholders (owner-comp, one-time fees, discretionary perks)`, to: '/ebitda-bridge', where: 'EBITDA Bridge' });
    }
    const unlinked = (amortSnap?.entries ?? []).filter((e) => !e.contract_link).map((e) => e.customer_name);
    if (unlinked.length > 0) items.push({ text: `Annual-payer contracts not linked (${unlinked.join(', ')})`, to: '/annual-amortization-evidence', where: 'Annual Amortization' });
    const ttm = ebitdaSnap?.bridges?.ttm;
    if (ttm?.unavailable) items.push({ text: `TTM EBITDA bridge inactive — ${ttm.reason ?? 'P&L does not yet cover 12 months'}`, to: '/ebitda-bridge', where: 'EBITDA Bridge' });
    if (ebitdaSnap?.source?.last_pnl_month) {
      items.push({ text: `QuickBooks P&L ends ${ebitdaSnap.source.last_pnl_month} — EBITDA, margins, CAC and LTV exclude later months until the P&L export is refreshed`, to: '/profit-loss', where: 'Profit & Loss' });
    }
    if (base?.members && roster) {
      const memberIds = new Set(base.members.map((m) => m.allmoxy_customer_id));
      const members = roster.filter((r) => memberIds.has(r.allmoxy_customer_id));
      const tagged = members.filter((r) => (r.sub_segment ?? '').trim()).length;
      if (members.length > 0 && tagged < members.length) {
        items.push({ text: `Sub-segment backfill ${Math.round((tagged / members.length) * 100)}% complete (${members.length - tagged} of ${members.length} active customers still untagged)`, to: '/sub-segment-backfill', where: 'Sub-segment Backfill' });
      }
      const churned = roster.filter((r) => r.status === 'churned');
      const withReason = churned.filter((r) => (r.churn_reason ?? '').trim()).length;
      if (churned.length > 0 && withReason < churned.length) {
        items.push({ text: `Churn reason backfill ${Math.round((withReason / churned.length) * 100)}% complete (${churned.length - withReason} of ${churned.length} churned customers have no reason recorded)`, to: '/churn-investigator', where: 'Churn Investigator' });
      }
    }
    return items;
  }, [ebitdaSnap, amortSnap, base, roster]);

  const st = inv ? STATUS[inv.status] : null;
  const placeholders = ebitdaSnap?.source?.qoe_adjustments_placeholder_count ?? 0;

  return (
    <DsPage path="/banker-handoff" title="Banker Handoff Package"
      subtitle="The data room's index: everything an investment banker or buyer-side QoE reviewer needs to navigate it, with a one-line summary of each artifact and the current readiness status.">

      {/* 1. Readiness + headline figures */}
      <KpiGrid max={5}>
        <KpiCard label="Data room status" value={inv ? `${inv.passed}/${inv.total} tests pass` : '—'}
          hint={inv ? `${inv.errors} error(s) · ${inv.warnings} warning(s) on the invariant tests` : 'Loading…'}
          tag={st?.word ?? 'Unknown'} tagTone={st?.tone ?? 'neutral'} onOpen={() => navigate('/invariant-tests')} />
        <KpiCard label={`GAAP EBITDA · ${ytdLabel}`} value={ebitda?.gaap_ebitda != null ? usd(ebitda.gaap_ebitda) : '—'}
          hint={ebitda?.gaap_ebitda_margin != null ? (ebitda.gaap_ebitda_margin * 100).toFixed(1) + '% margin' : '—'} onOpen={() => navigate('/ebitda-bridge')} />
        <KpiCard label={`Adjusted EBITDA · ${ytdLabel}`} value={ebitda?.adjusted_ebitda != null ? usd(ebitda.adjusted_ebitda) : '—'}
          hint={`${ebitda?.adjusted_ebitda_margin != null ? (ebitda.adjusted_ebitda_margin * 100).toFixed(1) + '% margin' : '—'} · placeholders pending sign-off`}
          tag={placeholders > 0 ? `${placeholders} placeholders` : 'Signed off'} tagTone={placeholders > 0 ? 'warning' : 'success'} onOpen={() => navigate('/ebitda-bridge')} />
        <KpiCard label="Adjustments on register" value={adj?.totals?.total != null ? String(adj.totals.total) : '—'}
          hint={`${adj?.totals?.by_severity?.monetary ?? 0} monetary · ${adj?.totals?.by_severity?.hygiene ?? 0} hygiene`} onOpen={() => navigate('/adjustments-register')} />
        <KpiCard label="Annual-payer evidence" value={`${amort?.annual_payer_count ?? '—'} payer(s)`}
          hint={`${amort == null ? '—' : amort.recognized_to_date_dollars != null
            ? `${usd(amort.recognized_to_date_dollars)} recognized through ${amort.as_of_month} (${usd(amort.total_amortized_dollars)} scheduled)`
            : `${usd(amort.total_amortized_dollars)} amortized`} · ${amort?.payers_verified ?? 0}/${amort?.annual_payer_count ?? 0} verified`}
          tag={amort ? (amort.payers_verified >= amort.annual_payer_count ? 'All verified' : 'Unverified payers') : undefined}
          tagTone={amort ? (amort.payers_verified >= amort.annual_payer_count ? 'success' : 'warning') : undefined}
          onOpen={() => navigate('/annual-amortization-evidence')} />
      </KpiGrid>

      {/* 2. Open punch list */}
      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Open punch list · {punchList.length} item{punchList.length === 1 ? '' : 's'}</span>
          <span className="am-chart__caption">Items to resolve before final banker handoff. Built live from the snapshots, so it updates with every refresh.</span>
        </div>
        {punchList.length === 0 ? (
          <p className="am-card__text">{ebitdaData && amortData ? 'No open items.' : 'Loading…'}</p>
        ) : (
          <DataTable label="Open punch list" cols={[['#', true], ['Item', false], ['Resolve on', false]]}
            rows={punchList.map((p, i) => [String(i + 1), <span key="t">{p.text}</span>, <Link key="l" to={p.to}>{p.where}</Link>])} />
        )}
      </section>

      {/* 3. Diligence stack */}
      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">The diligence stack</span>
          <span className="am-chart__caption">Read in this order. Each page answers a different diligence question; together they cover every QoE concern.</span>
        </div>
        <DataTable label="The diligence stack" cols={[['Step', true], ['Page', false], ['What it covers', false]]}
          rows={SECTIONS.map((s) => [String(s.step), <Link key="l" to={s.path}>{s.title}</Link>, <span key="t">{s.oneLiner}</span>])} />
      </section>

      {/* 4. Companion documents */}
      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Companion markdown documents</span>
          <span className="am-chart__caption">Three files at the repo root cover everything not in the dashboard pages. Pair them with the dashboard for a complete data room package.</span>
        </div>
        <DataTable label="Companion markdown documents" cols={[['Document', false], ['What it covers', false]]} rows={DOCS.map(([d, t]) => [d, <span key="t">{t}</span>])} />
      </section>

      <p className="am-card__text">Allmoxy — Quality of Earnings dashboard. Sign-off: Beau Lewis (CEO/owner).</p>
    </DsPage>
  );
}
