/**
 * Customer Detail on the Allmoxy design system. Every figure and every saved decision comes from
 * the classic page (CustomerDetail.tsx, kept at /customer-detail-classic): the same snapshots via
 * useSheetTab, the same ?id= / ?name= URL contract (id first, then exact name, else the first
 * customer), and the same four browser-stored decisions under the same localStorage keys:
 *   allmoxy.annual_payers.pending      annual-payer toggle
 *   allmoxy.project_candidate.pending  project-candidate toggle
 *   allmoxy.bid_only.pending           bid-only toggle (Churn risk)
 *   allmoxy.churn_reason.pending       churn-reason override (Churn summary)
 *
 * Layout (designer ranking): status first, with the churn model behind it (churn month, what
 * confirmed it, pause dates and review flag); then the lifetime KPI row; then the classic page's
 * ten tabs folded into five views: Account (information + milestones), Churn risk / summary,
 * Revenue & usage, Renewal (renewal + quotes), Activity (implementation, tickets, transactions).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl, hubspotInstanceUrl } from '../lib/hubspot';
import annualPayersConfig from '../data/annual_payer_ids.json';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, Select, SideSheet, Switch,
  downloadCsv, mlabel, thisMonth, usd, usdk, useMonthRange,
} from '../design-system/parts';

// ---------------------------------------------------------------- types (as the classic page)
type Transaction = { created: string | null; amount: number; type: string | null; status: string | null; description: string };
type MonthlyCell = { subscription: number; services: number; connect: number; total: number };
type Status = 'active' | 'at_risk' | 'non_payment' | 'paused' | 'churned' | 'never_paid';
type ChurnModel = {
  state: string; last_billed_month: string | null; departure_month: string | null; months_unbilled: number;
  churn_triggers: string[]; confirms_by: string | null;
  pause: { start_date: string | null; resume_date: string | null; months_paused: number | null; review_needed: boolean; review_reason: string | null } | null;
};
type Firmographics = {
  components_manufactured: string[];
  software: { accounting: string[]; cam: string[]; design_3d: string[]; crm: string[]; other: string[] };
  revenue_band: string | null; annual_revenue: number | null; employee_band: string | null; headcount: number | null;
  geographic_scope: string | null; city: string | null; state: string | null; country: string | null;
  ownership_type: string | null; founded_year: string | null; business_model: string[]; end_customer_type: string[]; end_market: string[];
  product: { customization_tier: string | null; construction_methods: string[]; assembly_model: string[]; installation_model: string[]; technology_profile: string[] };
};
type CustomerProfile = {
  allmoxy_customer_id: number; name: string; hubspot_company_id: string | null; installer_id: string | null; installer_directory: string | null;
  stripe_customer_ids: string[]; harvest_id: string | null; master_classification_name: string | null;
  sign_up_date: string | null; restart_date: string | null; effective_start_date: string | null; first_payment_date: string | null; last_payment_date: string | null;
  years_with_us: number | null; cohort_year: number | null; status: Status; active_today: boolean;
  lifetime_total: number; lifetime_subscription: number; lifetime_services: number; lifetime_connect: number; lifetime_other: number;
  current_subscription_mrr: number; current_services: number; current_connect: number; latest_month: string;
  failed_3mo_count: number; failed_3mo_amount: number; peak_month: string | null; peak_month_total: number; transaction_count: number;
  stripe_fee_percent?: number | null; pay_status?: string | null; status_conflict?: string | null; contract_status?: string | null; churn_reason?: string | null;
  primary_segment?: string | null; sub_segment?: string | null; customer_health_cs_pulse?: string | null; notes_last_contacted?: string | null; vip_legacy_customer?: string | null;
  stripe_subscription_id?: string | null; custom_domain_stripe_subscription_id?: string | null;
  all_stripe_subscription_ids?: string[]; all_custom_domain_stripe_subscription_ids?: string[];
  hubspot_instance_name?: string | null; hubspot_record_id?: string | null; instance_owner?: string | null; instance_owner_first_name?: string | null; hubspot_owner_name?: string | null;
  firmographics?: Firmographics | null; churn_model?: ChurnModel | null;
  monthly_history: Record<string, MonthlyCell>; transactions: Transaction[];
};
type ChurnInference = {
  allmoxy_customer_id: number; name: string; suggested_reason: string; confidence: 'high' | 'medium' | 'low';
  current_status?: string; evidence_quote?: string; evidence_date?: string | null; recommended_action?: string; signals?: string[];
};
type ChurnSubpatternsSnap = { subpattern_definitions: Record<string, { label: string; parent: string; description: string }>; customer_subpatterns: Record<string, string[]> };
type OrdersVerifiedRecord = {
  allmoxy_customer_id: number; name: string;
  years: Record<string, { order_count: number | null; total_usd: number }>;
  monthly_supplement?: Record<string, number>;
  monthly_verified?: Record<string, { usd: number | null; orders: number | null; even_spread?: boolean; orders_carried_forward?: boolean; usd_pending?: boolean; usd_missing?: boolean }>;
  live_date: string | null; months_to_launch: number | null; total_lifetime_orders: number; total_lifetime_usd: number;
  monthly_avg_current_year: number; monthly_avg_prior_year: number; monthly_avg_yoy_pct: number | null;
};
type RiskEntry = {
  allmoxy_customer_id: number; tier: string; total_score: number; signal_1_orders: number; signal_2_launch: number; signal_3_recency: number;
  signal_4_risk: number; signal_5_tenure: number; signal_6_pulse?: number; pulse_color?: 'green' | 'yellow' | 'red' | null; pulse_detail?: string | null;
  orders_detail: string; signal_2_detail?: string; days_since_last_contact: number | null; launch_status: string; arr_at_risk: number;
  primary_risk_driver?: { key: string; summary?: string | null; expected_value?: string | null; current_state?: string | null; roadblocks?: string | null; source: string; signal_baseline?: string | null; evidence?: string[] | null };
  is_bid_only?: boolean;
};
type Quote = { id: string; title: string | null; status: string | null; amount: number | null; currency: string; created_date: string | null; expiration_date: string | null; hubspot_url: string };
type RenewalRow = {
  allmoxy_customer_id: number; account_name: string; renewal_date: string | null; days_to_renewal: number | null; contract_status: string | null; contract_length_months: number | null;
  monthly_flat_fee_hubspot: number | null; current_mrr: number; arr_up_for_renewal: number; last_renewal_expansion: string | null; last_no_expansion_reason: string | null;
  action_tag: string; action_reason: string; lifetime_subscription: number; lifetime_orders_dollars: number; cost_ratio_lifetime_pct: number | null; cost_ratio_annualized_pct: number | null;
  orders_monthly_avg_current_year: number; orders_monthly_avg_prior_year: number;
  monthly_trend: Array<{ month: string; subscription: number; orders_dollars: number; orders_source?: string; cost_ratio_pct: number | null }>;
  dropoff_pct: number | null; cs_pulse: string | null; implementation_status: string | null; pay_status: string; vip_legacy: string | null; quotes?: Quote[];
  proposed_mrr?: number | null; proposed_arr?: number | null; proposed_uplift_pct?: number | null; proposed_basis?: 'growth' | 'underpriced' | null;
  expansion_rationale?: string | null; expansion_confidence?: 'high' | 'low' | null; current_arr?: number; target_1pct_mrr?: number | null; target_1pct_arr?: number | null;
};
type ImplRow = {
  allmoxy_customer_id: number; has_jira: boolean; has_harvest: boolean; jira_key: string | null; jira_url: string | null; stage: string | null; assignee: string | null;
  billing_method: string | null; hourly_rate: number | null; hours: number; billable_hours: number; billable_amount: number; last_entry: string | null; is_active: boolean;
  launch_status: 'pre_launch' | 'launched' | 'unknown'; implementation_type: string; first_order_year: number | null; time_to_first_order_months: number | null; ttv_category: string | null;
  tasks_done: number; tasks: Array<{ key: string; summary: string; status: string | null; stage_category: string | null; assignee: string | null; created: string | null; due: string | null; url: string }>;
};
type TicketRow = {
  id: string; subject: string | null; priority: string | null; category: string | null; stage_label: string | null; is_closed: boolean;
  created: string | null; updated: string | null; owner_full_name: string | null; associated_company_ids?: string[]; hubspot_url: string;
};
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

// ---------------------------------------------------------------- formatting (as the classic page)
function formatDateMDY(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}
function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
function monthLabelLong(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const signedPts = (v: number) => `${v > 0 ? '+' : ''}${v}`;

// ---------------------------------------------------------------- browser-stored decisions (same keys as classic)
const COMMITTED_ANNUAL_IDS = new Set<number>(annualPayersConfig.annual_payer_ids);
const PENDING_STORAGE_KEY = 'allmoxy.annual_payers.pending';
const BID_ONLY_STORAGE_KEY = 'allmoxy.bid_only.pending';
const PROJECT_CANDIDATE_STORAGE_KEY = 'allmoxy.project_candidate.pending';
const CHURN_OVERRIDE_STORAGE_KEY = 'allmoxy.churn_reason.pending';
type BoolMap = Record<string, boolean>;
type ChurnOverride = { reason: string; evidence: string; updatedAt: string };
type ChurnOverrideMap = Record<string, ChurnOverride>;
function readJson<T>(key: string): T { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : ({} as T); } catch { return {} as T; } }
function writeJson(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* localStorage unavailable */ } }

const HUBSPOT_CHURN_PLAYBOOK = [
  'Failed Implementation', 'Features', 'Business Model Change', 'Moved to Other Solution', 'Paid and Never Used', 'Out of Business',
  'Customer Stakeholder Misalignment', 'Unresponsive', 'Catalog Unidentified', 'Ownership Transition', 'Timing Not Right', 'Pricing', 'Payment Failure',
] as const;

// ---------------------------------------------------------------- status words
const STATUS: Record<Status, { word: string; tone: Tone }> = {
  active: { word: 'Active', tone: 'success' },
  at_risk: { word: 'At risk · dunning', tone: 'warning' },
  non_payment: { word: 'Lapsed · stopped billing, churn confirms at 3 months', tone: 'warning' },
  paused: { word: 'Paused · pause granted (not churned)', tone: 'info' },
  churned: { word: 'Churned', tone: 'error' },
  never_paid: { word: 'Never paid', tone: 'neutral' },
};
const MODEL_STATE: Record<string, string> = {
  billing: 'Billing', churned: 'Churned', lapsed: 'Lapsed (stopped billing)', paused: 'Paused', not_evaluated: 'Not evaluated (never billed)',
  non_billing_arrangement: 'Non-billing arrangement',
};
const TRIGGER: Record<string, string> = {
  '3_months_unbilled': '3 months unbilled', hubspot_churn_reason: 'HubSpot churn reason', hubspot_cancelled: 'HubSpot pay status Cancelled',
  stripe_subscription_canceled: 'Stripe subscription canceled',
};
const ACTION: Record<string, Tone> = { 'Expansion Opportunity': 'success', 'Contraction Risk': 'error', Watch: 'warning', Stable: 'neutral', Paused: 'info' };
const TIER: Record<string, { word: string; tone: Tone }> = {
  red: { word: 'Critical', tone: 'error' }, yellow: { word: 'Watch', tone: 'warning' }, green: { word: 'Healthy', tone: 'success' },
};
const quoteTag = (s: string | null): { word: string; tone: Tone } =>
  s === 'APPROVAL_NOT_NEEDED' ? { word: 'Sent', tone: 'success' } : s === 'DRAFT' ? { word: 'Draft', tone: 'warning' } : { word: s || '—', tone: 'neutral' };

// ---------------------------------------------------------------- small local parts (design-system classes only)
function Tag({ word, tone }: { word: string; tone: Tone }) { return <span className={`am-tag am-tag--${tone}`}>{word}</span>; }
function Section({ title, caption, actions, children }: { title: string; caption?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <section className="am-card am-card--outlined" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--am-space-block)' }}>
      <div className="am-row am-row--spread" style={{ alignItems: 'flex-start' }}>
        <div className="am-chart__head">
          <span className="am-chart__title">{title}</span>
          {caption && <span className="am-chart__caption">{caption}</span>}
        </div>
        {actions && <div className="am-row am-row--wrap">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
type Fact = [string, ReactNode, ReactNode?];
function Facts({ items, min = 170 }: { items: Array<Fact | null | false | undefined | '' | 0>; min?: number }) {
  const list = items.filter(Boolean) as Fact[];
  return (
    <div className="am-grid" style={{ ['--am-grid-min' as string]: `${min}px` }}>
      {list.map(([l, v, h]) => (
        <div key={l} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="am-card__text">{l}</span>
          <div>{v ?? '—'}</div>
          {h && <span className="am-card__text">{h}</span>}
        </div>
      ))}
    </div>
  );
}
function Tags({ items, tone = 'neutral' }: { items: string[]; tone?: Tone }) {
  if (!items.length) return <>—</>;
  return <span className="am-row am-row--wrap am-row--tight">{items.map((x) => <Tag key={x} word={x} tone={tone} />)}</span>;
}
function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="am-btn am-btn--text" href={href} target="_blank" rel="noopener noreferrer">{children}<Icon name="open_in_new" /></a>;
}
const short = (s: string) => (s.length > 28 ? `${s.slice(0, 28)}…` : s);

type View = 'account' | 'churn' | 'revenue' | 'renewal' | 'activity';

export default function CustomerDetailDS() {
  const navigate = useNavigate();
  const { data } = useSheetTab('customer_profiles');
  const { data: inferencesData } = useSheetTab('churn_inferences');
  const { data: subpatternsData } = useSheetTab('churn_subpatterns');
  const { data: riskData } = useSheetTab('churn_risk_matrix');
  const { data: ordersVerifiedData } = useSheetTab('orders_verified');
  const { data: renewalData } = useSheetTab('renewal_management');
  const { data: implementationData } = useSheetTab('implementation');
  const { data: hubspotTicketsData } = useSheetTab('hubspot_tickets');
  const { data: pcData } = useSheetTab('project_candidates');
  const { data: auroraData } = useSheetTab('aurora_orders');
  const snap = data as unknown as { rows: CustomerProfile[] } | undefined;
  const inferences = inferencesData as unknown as { customers: ChurnInference[] } | undefined;
  const subpatterns = subpatternsData as unknown as ChurnSubpatternsSnap | undefined;
  const risk = riskData as unknown as { customers: RiskEntry[] } | undefined;

  const [pending, setPending] = useState<BoolMap>(() => readJson<BoolMap>(PENDING_STORAGE_KEY));
  const [bidOnlyMap, setBidOnlyMap] = useState<BoolMap>(() => readJson<BoolMap>(BID_ONLY_STORAGE_KEY));
  const [projectCandidateMap, setProjectCandidateMap] = useState<BoolMap>(() => readJson<BoolMap>(PROJECT_CANDIDATE_STORAGE_KEY));
  const [churnOverrides, setChurnOverrides] = useState<ChurnOverrideMap>(() => readJson<ChurnOverrideMap>(CHURN_OVERRIDE_STORAGE_KEY));
  const committedProjectCandidates = useMemo(() => new Set(
    ((pcData as unknown as { customers?: Array<{ allmoxy_customer_id: number }> } | undefined)?.customers ?? []).map((c) => c.allmoxy_customer_id),
  ), [pcData]);

  const [view, setView] = useState<View>('account');
  const [firmoOpen, setFirmoOpen] = useState(true);
  const [ticketStatusFilter, setTicketStatusFilter] = useState('all');
  const [showAllTxn, setShowAllTxn] = useState(false);
  const [showAllTix, setShowAllTix] = useState(false);
  const [txnOrder, setTxnOrder] = useState<number[] | null>(null);
  const [tixOrder, setTixOrder] = useState<number[] | null>(null);
  const [revSheet, setRevSheet] = useState(false);
  const [searchParams] = useSearchParams();

  const customers = snap?.rows ?? [];
  // URL is the source of truth (same contract as classic): ?id= first, then exact ?name=, else first.
  const selected = useMemo<CustomerProfile | null>(() => {
    if (customers.length === 0) return null;
    const idParam = searchParams.get('id');
    if (idParam) {
      const id = Number(idParam);
      if (Number.isFinite(id)) { const found = customers.find((c) => c.allmoxy_customer_id === id); if (found) return found; }
    }
    const nameParam = searchParams.get('name');
    if (nameParam) {
      const target = nameParam.trim().toLowerCase();
      const found = customers.find((c) => (c.name ?? '').trim().toLowerCase() === target);
      if (found) return found;
    }
    return customers[0] ?? null;
  }, [customers, searchParams]);

  // Reset per-customer view state when the customer changes.
  useEffect(() => { setShowAllTxn(false); setShowAllTix(false); setTicketStatusFilter('all'); }, [selected?.allmoxy_customer_id]);

  const chart = useMemo(() => {
    if (!selected) return [];
    return Object.entries(selected.monthly_history).sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, subscription: v.subscription, services: v.services, connect: v.connect }));
  }, [selected]);
  const rev = useMonthRange(chart.map((r) => r.month));
  const inProgress = thisMonth();

  const auroraRec = useMemo(() => {
    if (!selected) return null;
    const rows = (auroraData as unknown as { by_customer?: Array<{ allmoxy_customer_id: number; total_orders: number | null; total_orders_asof: string | null; verified_by_month?: Record<string, number> }> } | undefined)?.by_customer ?? [];
    return rows.find((c) => c.allmoxy_customer_id === selected.allmoxy_customer_id) ?? null;
  }, [auroraData, selected]);

  const ov = useMemo(() => {
    if (!selected) return null;
    return (ordersVerifiedData as unknown as { by_customer?: Record<string, OrdersVerifiedRecord> } | undefined)?.by_customer?.[String(selected.allmoxy_customer_id)] ?? null;
  }, [ordersVerifiedData, selected]);

  // Orders verified · by month (classic logic, ISO month keys).
  const monthly = useMemo(() => {
    if (!selected) return null;
    const currentYear = String(new Date().getFullYear());
    const gold = ov?.monthly_verified || {};
    const allMonths = Object.entries(gold).filter(([, v]) => Number(v.usd) > 0 || Number(v.orders) > 0).map(([m]) => m).sort();
    const realMonths = allMonths.filter((m) => !gold[m].even_spread);
    let rows: Array<{ month: string; verified: number; orders: number | null; spread?: boolean; pending?: boolean; missing?: boolean }>;
    if (allMonths.length > 0) {
      rows = allMonths.map((m) => {
        const v = gold[m];
        return { month: m, verified: Math.round(Number(v.usd) || 0), orders: v.orders == null || v.orders_carried_forward ? null : Number(v.orders), spread: !!v.even_spread, pending: !!v.usd_pending, missing: !!v.usd_missing };
      });
    } else {
      const map: Record<string, number> = {};
      for (const [m, v] of Object.entries(ov?.monthly_supplement || {})) if (m.startsWith(currentYear)) map[m] = Number(v) || 0;
      for (const [m, v] of Object.entries(auroraRec?.verified_by_month || {})) if (m.startsWith(currentYear)) map[m] = Number(v) || 0;
      rows = Object.keys(map).sort().map((m) => ({ month: m, verified: Math.round(map[m]), orders: null }));
    }
    const ytd = rows.reduce((s, r) => s + r.verified, 0);
    return {
      rows, fallback: allMonths.length === 0, currentYear, firstReal: realMonths[0] ?? null, ytd,
      avg: rows.length ? Math.round(ytd / rows.length) : 0,
      totalOrders: rows.reduce((s, r) => s + (r.orders ?? 0), 0),
      spreadCount: rows.filter((r) => r.spread).length,
    };
  }, [selected, ov, auroraRec]);
  const ordRange = useMonthRange(monthly?.rows.map((r) => r.month) ?? []);

  if (!selected) {
    return (
      <DsPage path="/customer-detail" title="Customer Detail" subtitle={snap ? 'Pick a customer from the Customers page to see their full profile.' : 'Loading…'}
        actions={<button className="am-btn am-btn--outlined" onClick={() => navigate('/customers')}><Icon name="arrow_back" />All customers</button>}>
        <p className="am-card__text">{snap ? 'No customer selected. Open the Customers page, filter for the customer, and select their name to open their detail here.' : 'Loading the customer profiles…'}</p>
      </DsPage>
    );
  }

  const aid = selected.allmoxy_customer_id;
  const aidKey = String(aid);
  const st = STATUS[selected.status] ?? STATUS.churned;
  const cm = selected.churn_model ?? null;

  // ---- decisions (identical maths to classic)
  const committedAnnual = COMMITTED_ANNUAL_IDS.has(aid);
  const annualPending = pending[aidKey];
  const isAnnual = annualPending != null ? annualPending : committedAnnual;
  const annualIsPending = annualPending != null && annualPending !== committedAnnual;
  function toggleAnnual(next: boolean) {
    const updated = { ...pending };
    if (next === committedAnnual) delete updated[aidKey]; else updated[aidKey] = next;
    setPending(updated); writeJson(PENDING_STORAGE_KEY, updated);
  }
  const committedPC = committedProjectCandidates.has(aid);
  const localPC = projectCandidateMap[aidKey];
  const isCandidate = localPC !== undefined ? localPC : committedPC;
  const pcPending = localPC !== undefined && localPC !== committedPC;
  function togglePC(v: boolean) {
    const next = { ...projectCandidateMap };
    if (v === committedPC) delete next[aidKey]; else next[aidKey] = v;
    setProjectCandidateMap(next); writeJson(PROJECT_CANDIDATE_STORAGE_KEY, next);
  }
  function setChurnOverride(reason: string, evidence: string) {
    const updated = { ...churnOverrides };
    const r = (reason || '').trim(), e = (evidence || '').trim();
    if (!r && !e) delete updated[aidKey]; else updated[aidKey] = { reason: r, evidence: e, updatedAt: new Date().toISOString() };
    setChurnOverrides(updated); writeJson(CHURN_OVERRIDE_STORAGE_KEY, updated);
  }
  const pendingEntries = Object.entries(pending);
  const pendingChurnEntries = Object.entries(churnOverrides);
  const nameOf = (id: string) => customers.find((x) => x.allmoxy_customer_id === Number(id))?.name ?? `ID ${id}`;

  const ofLifetime = (v: number) => `${((v / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`;
  const rep = selected.instance_owner_first_name?.trim() || selected.instance_owner?.trim() || selected.hubspot_owner_name?.trim() || '—';
  const totalOrders = auroraRec?.total_orders != null ? auroraRec.total_orders.toLocaleString() : '—';
  const totalOrdersHint = auroraRec?.total_orders_asof ? `lifetime · as of ${formatDateMDY(auroraRec.total_orders_asof)}` : 'lifetime cumulative';
  const isChurned = selected.status === 'churned';

  // ---------------------------------------------------------------- status + churn model
  const statusCard = (
    <Section title="Status" caption={cm ? 'From the churn model: churn is dated to the first month with no invoiced subscription, confirmed by a canceled Stripe subscription, HubSpot Cancelled or churn reason, or 3 months unbilled. A granted pause is never churn.' : undefined}>
      <div className="am-row am-row--wrap">
        <Tag word={st.word} tone={st.tone} />
        {cm?.pause?.review_needed && <Tag word="Pause needs review" tone="warning" />}
        {selected.status_conflict && <Tag word="HubSpot conflict" tone="warning" />}
        {selected.failed_3mo_count > 0 && <Tag word={`${selected.failed_3mo_count} failed charges · last 3 mo`} tone="error" />}
      </div>
      {cm && (
        <Facts items={[
          ['Billing state', MODEL_STATE[cm.state] ?? cm.state],
          ['Last billed month', cm.last_billed_month ? mlabel(cm.last_billed_month) : '—'],
          cm.departure_month && [cm.state === 'churned' ? 'Churn month' : 'First unbilled month', mlabel(cm.departure_month), cm.state === 'churned' ? 'first month with no invoiced subscription' : undefined],
          cm.months_unbilled > 0 && ['Months unbilled', cm.months_unbilled.toLocaleString()],
          cm.churn_triggers.length > 0 && ['Churn confirmed by', <Tags key="t" items={cm.churn_triggers.map((t) => TRIGGER[t] ?? t)} tone="error" />],
          cm.confirms_by && ['Churn confirms', mlabel(cm.confirms_by), 'if still unbilled (3 months)'],
          cm.pause && ['Pause started', formatDateMDY(cm.pause.start_date)],
          cm.pause && ['Pause resume date', cm.pause.resume_date ? formatDateMDY(cm.pause.resume_date) : 'Not set in HubSpot'],
          cm.pause && cm.pause.months_paused != null && ['Months paused', cm.pause.months_paused.toLocaleString()],
          cm.pause && ['Pause review', cm.pause.review_needed ? <Tag key="r" word="Needs review" tone="warning" /> : <Tag key="r" word="No review needed" tone="success" />, cm.pause.review_reason ?? undefined],
          ['Pay status', selected.pay_status || '—'],
        ]} />
      )}
      {selected.status_conflict && (
        <p className="am-card__text"><Tag word="HubSpot conflict" tone="warning" /> {selected.status_conflict}. HubSpot marks this customer churned but they are still paying; cash wins, so the dashboard treats them as live. Fix the HubSpot record (clear the churn reason or correct the pay status); the note clears on the next refresh.</p>
      )}
    </Section>
  );

  const pendingCard = (pendingEntries.length > 0 || pendingChurnEntries.length > 0) && (
    <Section title="Pending changes in this browser" caption="Saved here until Claude rebuilds the snapshots; nothing changes in the data until then.">
      {pendingEntries.length > 0 && (
        <p className="am-card__text"><Tag word={`${pendingEntries.length} annual-payer change${pendingEntries.length === 1 ? '' : 's'}`} tone="warning" />{' '}
          {pendingEntries.map(([id, v]) => `${nameOf(id)} → ${v ? 'annual' : 'not annual'}`).join(', ')}. Ask Claude to rebuild snapshots to apply.</p>
      )}
      {pendingChurnEntries.length > 0 && (
        <p className="am-card__text"><Tag word={`${pendingChurnEntries.length} churn-reason override${pendingChurnEntries.length === 1 ? '' : 's'}`} tone="warning" />{' '}
          {pendingChurnEntries.slice(0, 6).map(([id, v]) => `${nameOf(id)} → ${v.reason || '(no taxonomy)'}`).join('; ')}
          {pendingChurnEntries.length > 6 ? ` … (+${pendingChurnEntries.length - 6} more)` : ''}. Ask Claude to fold these into customer_profiles / churn_inferences to make them durable.</p>
      )}
    </Section>
  );

  // ---------------------------------------------------------------- revenue chart (shared by Revenue and Churn summary)
  const revRows = chart.filter((r) => rev.months.includes(r.month));
  const revComplete = revRows.filter((r) => r.month !== inProgress);
  const revTot = (k: 'subscription' | 'services' | 'connect') => revComplete.reduce((s, r) => s + r[k], 0);
  const revenueChart = (title: string, caption: string) => (
    <ChartCard key="revenue-chart" title={title} caption={caption}>
      {chart.length === 0 ? <p className="am-card__text">No monthly revenue history for this customer.</p> : <>
        {rev.controls}
        <ColumnChart months={revRows.map((r) => r.month)} stacked legend fmt={usdk}
          catTitle={(m) => `${monthLabelLong(m)}${m === inProgress ? ' (in progress)' : ''}`}
          series={[
            { key: 'subscription', label: 'Subscription', tone: 'div-1', values: revRows.map((r) => r.subscription) },
            { key: 'services', label: 'Services', tone: 'div-2', values: revRows.map((r) => r.services) },
            { key: 'connect', label: 'Connect', tone: 'other', values: revRows.map((r) => r.connect) },
          ]}
          tipRows={(i) => { const r = revRows[i]; return [['Subscription', usd(r.subscription)], ['Services', usd(r.services)], ['Connect', usd(r.connect)], ['Total', usd(r.subscription + r.services + r.connect)]]; }}
          aria={`Monthly revenue by stream for ${selected.name}, ${rev.rangeText}.`} />
        <DataTable label="Revenue in range by stream" cols={[['Stream', false], [`Revenue · ${rev.rangeText}`, true]]}
          rows={[['Subscription', usd(revTot('subscription'))], ['Services', usd(revTot('services'))], ['Connect', usd(revTot('connect'))]]}
          foot={[`Total · ${revComplete.length} complete months${revRows.length > revComplete.length ? ' (in-progress month excluded)' : ''}`, usd(revTot('subscription') + revTot('services') + revTot('connect'))]}
          onFoot={() => setRevSheet(true)} footClickable={(c) => c === 1} />
      </>}
    </ChartCard>
  );

  // ---------------------------------------------------------------- views
  const accountView = (() => {
    const customDomainSet = new Set(selected.all_custom_domain_stripe_subscription_ids ?? []);
    if (selected.custom_domain_stripe_subscription_id) customDomainSet.add(selected.custom_domain_stripe_subscription_id);
    const allSubsList = [...new Set([...(selected.all_stripe_subscription_ids ?? []), ...(selected.stripe_subscription_id ? [selected.stripe_subscription_id] : []), ...customDomainSet])];
    const f = selected.firmographics;
    const hasFirmo = !!f && !!(f.components_manufactured.length || f.revenue_band || f.annual_revenue != null || f.employee_band || f.headcount != null || f.geographic_scope || f.city || f.ownership_type
      || f.founded_year || f.business_model.length || f.end_customer_type.length || f.end_market.length
      || f.software.accounting.length || f.software.cam.length || f.software.design_3d.length || f.software.crm.length || f.software.other.length
      || (f.product && (f.product.customization_tier || f.product.construction_methods.length || f.product.assembly_model.length || f.product.installation_model.length || f.product.technology_profile.length)));
    const milestones = ([
      ['Signed up', selected.sign_up_date, formatDateMDY(selected.sign_up_date), ''],
      ['First payment', selected.first_payment_date, formatDateMDY(selected.first_payment_date), ''],
      selected.peak_month ? ['Peak month', `${selected.peak_month}-01`, monthLabelLong(selected.peak_month), usd(selected.peak_month_total)] : null,
      ['Last payment', selected.last_payment_date, formatDateMDY(selected.last_payment_date), ''],
    ].filter(Boolean) as Array<[string, string | null, string, string]>);
    return <>
      <div className="am-grid" style={{ ['--am-grid-min' as string]: 'max(420px, calc((100% - var(--am-space-block)) / 2))' }}>
        <Section title="Account" caption="From the HubSpot Instance Sync. Firmographic segment lives under Classification.">
          <Facts items={[['Account rep', rep], ['Pay status', selected.pay_status || '—'], ['Contract', selected.contract_status || '—'], ['Cohort', selected.cohort_year != null ? String(selected.cohort_year) : '—']]} />
        </Section>
        <Section title="Lifecycle">
          <Facts items={[
            ['Signed up', formatDateMDY(selected.sign_up_date)],
            selected.restart_date && ['Restarted', formatDateMDY(selected.restart_date)],
            ['First payment', formatDateMDY(selected.first_payment_date)],
            ['Last payment', formatDateMDY(selected.last_payment_date)],
            [selected.restart_date ? 'Tenure (from restart)' : 'Tenure', selected.years_with_us != null ? `${selected.years_with_us.toFixed(1)} yrs` : '—'],
          ]} />
        </Section>
      </div>
      <Section title="Billing & health" caption="The two switches save a decision in this browser until Claude rebuilds the snapshots.">
        <Facts items={[
          ['Transactions', selected.transaction_count.toLocaleString()],
          ['Total orders', totalOrders, auroraRec?.total_orders_asof ? totalOrdersHint : undefined],
          ['Stripe fee %', selected.stripe_fee_percent != null ? `${selected.stripe_fee_percent.toFixed(2)}%` : '—'],
          selected.failed_3mo_count > 0 && ['Failed charges · last 3 mo', <Tag key="f" word={`${selected.failed_3mo_count} · ${usd(selected.failed_3mo_amount)}`} tone="error" />],
        ]} />
        <div className="am-grid" style={{ ['--am-grid-min' as string]: '320px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="am-row am-row--wrap">
              <Switch checked={isAnnual} onChange={toggleAnnual}>Annual payer</Switch>
              {isAnnual && <Tag word={annualIsPending ? 'Pending' : 'Amortized'} tone={annualIsPending ? 'warning' : 'info'} />}
            </div>
            <span className="am-card__text">Pays annually upfront: the snapshot builder spreads the payment as amount ÷ 12 so monthly MRR does not spike.</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="am-row am-row--wrap">
              <Switch checked={isCandidate} onChange={togglePC}>Project candidate</Switch>
              {isCandidate && <Tag word={pcPending ? 'Pending' : 'On the list'} tone={pcPending ? 'warning' : 'success'} />}
            </div>
            <span className="am-card__text">A good fit for a paid project. Lists them on Project Candidates for the Sales hand-off; changes no revenue, churn or health figure.</span>
          </div>
        </div>
      </Section>
      <Section title="Identity & links" caption="Where to find this customer in other systems.">
        <Facts min={200} items={[
          ['Allmoxy ID', String(aid)],
          selected.installer_id && ['Installer ID', selected.installer_id],
          selected.installer_directory && ['Allmoxy URL', <ExtLink key="u" href={`https://${selected.installer_directory}.allmoxy.com`}>{short(`${selected.installer_directory}.allmoxy.com`)}</ExtLink>],
          selected.hubspot_company_id && ['HubSpot ID', <ExtLink key="h" href={hubspotCompanyUrl(selected.hubspot_company_id) ?? '#'}>{selected.hubspot_company_id}</ExtLink>],
          selected.hubspot_record_id && ['HubSpot Instance', <ExtLink key="i" href={hubspotInstanceUrl(selected.hubspot_record_id) ?? '#'}>{short(selected.hubspot_instance_name || String(selected.hubspot_record_id))}</ExtLink>],
          selected.stripe_customer_ids[0] && ['Stripe Customer', <ExtLink key="s" href={`https://dashboard.stripe.com/customers/${selected.stripe_customer_ids[0]}`}>{short(selected.stripe_customer_ids[0])}</ExtLink>],
          ...allSubsList.map((subId, i): Fact => {
            const isCD = customDomainSet.has(subId);
            const isPrimary = subId === selected.stripe_subscription_id && !isCD;
            const lbl = isCD ? `Custom Domain Sub${customDomainSet.size > 1 ? ` ${[...customDomainSet].indexOf(subId) + 1}` : ''}` : isPrimary ? 'Stripe Subscription' : `Stripe Sub ${i + 1}`;
            return [lbl, <ExtLink key={subId} href={`https://dashboard.stripe.com/subscriptions/${subId}`}>{short(subId)}</ExtLink>, isCD ? 'custom domain' : undefined];
          }),
        ]} />
      </Section>
      {hasFirmo && f && (
        <Section title="Firmographics & classification" caption="From the HubSpot Company object: what they make, software stack, size, who they serve. Blank fields are not filled in HubSpot yet."
          actions={<button className="am-btn am-btn--text" aria-expanded={firmoOpen} onClick={() => setFirmoOpen((o) => !o)}>{firmoOpen ? 'Hide' : 'Show'}</button>}>
          {firmoOpen && <>
            <Facts min={220} items={[
              ['Primary segment', selected.primary_segment || '—'], ['Sub-segment', selected.sub_segment || '—'],
              ['Components manufactured', <Tags key="c" items={f.components_manufactured} tone="info" />],
            ]} />
            <span className="am-chart__title">Current software stack</span>
            <Facts min={180} items={([['Accounting', f.software.accounting], ['CAM', f.software.cam], ['3D Design', f.software.design_3d], ['CRM', f.software.crm], ['Other', f.software.other]] as Array<[string, string[]]>)
              .map(([n, v]): Fact => [n, <Tags key={n} items={v} />])} />
            <span className="am-chart__title">Firmographics</span>
            <Facts min={180} items={[
              ['Revenue band', f.revenue_band || '—', f.annual_revenue != null ? `${USD_COMPACT.format(f.annual_revenue)} annual` : undefined],
              ['Employees', f.employee_band || '—', f.headcount != null ? `${f.headcount.toLocaleString()} headcount` : undefined],
              ['Geographic scope', f.geographic_scope || '—', [f.city, f.state, f.country].filter(Boolean).join(', ') || undefined],
              ['Ownership', f.ownership_type || '—', f.founded_year ? `Founded ${f.founded_year}` : undefined],
              ['Business model', <Tags key="b" items={f.business_model} />],
            ]} />
            <span className="am-chart__title">Who they serve</span>
            <Facts min={260} items={[['End customer type', <Tags key="e" items={f.end_customer_type} />], ['End markets', <Tags key="m" items={f.end_market} />]]} />
            {f.product && <>
              <span className="am-chart__title">Product offering</span>
              <Facts min={200} items={[
                ['Customization tier', f.product.customization_tier || '—'],
                ['Construction methods', <Tags key="1" items={f.product.construction_methods} />],
                ['Assembly model', <Tags key="2" items={f.product.assembly_model} />],
                ['Installation model', <Tags key="3" items={f.product.installation_model} />],
                ['Technology profile', <Tags key="4" items={f.product.technology_profile} />],
              ]} />
            </>}
          </>}
        </Section>
      )}
      <Section title="Milestones" caption="Signed up, first payment, peak month and last payment, in date order.">
        <DataTable label="Milestones" cols={[['Milestone', false], ['Date', false], ['Detail', true]]}
          rows={milestones.map(([l, , d, x]) => [l, d, x || '—'])}
          sortValues={milestones.map(([l, iso, , x]) => [l, iso ?? '', x])} defaultSort={{ col: 1, dir: 'asc' }} />
      </Section>
    </>;
  })();

  const churnView = (() => {
    const riskEntry = risk?.customers?.find((r) => r.allmoxy_customer_id === aid);
    let summary: ReactNode = null;
    if (isChurned) {
      const inf = inferences?.customers.find((c) => c.allmoxy_customer_id === aid) ?? null;
      const subTags = subpatterns?.customer_subpatterns?.[aidKey] ?? [];
      const subDefs = subpatterns?.subpattern_definitions ?? {};
      const override = churnOverrides[aidKey];
      const baseReason = (selected.churn_reason ?? '').trim();
      const effectiveReason = override?.reason || baseReason || inf?.suggested_reason || '';
      const effectiveEvidence = override?.evidence || inf?.evidence_quote || '';
      const reasonSource: 'override' | 'hubspot' | 'ai' | 'none' = override?.reason ? 'override' : baseReason ? 'hubspot' : inf?.suggested_reason ? 'ai' : 'none';
      const su = selected.sign_up_date ? new Date(selected.sign_up_date) : null;
      const lp = selected.last_payment_date ? new Date(selected.last_payment_date) : null;
      const tenureYrs = su && lp && !isNaN(su.getTime()) && !isNaN(lp.getTime()) ? (lp.getTime() - su.getTime()) / (365.25 * 864e5) : selected.years_with_us;
      summary = <>
        <KpiGrid>
          <KpiCard label="Churned" value={formatDateMDY(selected.last_payment_date)} hint={`last payment received${cm?.departure_month ? ` · churn month ${mlabel(cm.departure_month)}` : ''}`} tag="Churned" tagTone="error" />
          <KpiCard label="Lifetime value" value={usd(selected.lifetime_total)} hint="all streams combined" />
          <KpiCard label="Active tenure" value={tenureYrs != null ? `${tenureYrs.toFixed(1)} yrs` : '—'} hint="signup → last payment" />
          <KpiCard label="Cohort" value={selected.cohort_year != null ? String(selected.cohort_year) : '—'} hint="signup year" />
          <KpiCard label="Peak month" value={selected.peak_month_total != null ? usd(selected.peak_month_total) : '—'} hint={selected.peak_month ? monthLabel(selected.peak_month) : ''} />
        </KpiGrid>
        <ChurnAnalysis key={aid} selected={selected} inference={inf} subTags={subTags} subDefs={subDefs} override={override}
          effectiveReason={effectiveReason} effectiveEvidence={effectiveEvidence} reasonSource={reasonSource} onSave={setChurnOverride} />
        <div className="am-grid" style={{ ['--am-grid-min' as string]: 'max(420px, calc((100% - var(--am-space-block)) / 2))' }}>
          <Section title="Lifecycle">
            <Facts items={[['Signed up', formatDateMDY(selected.sign_up_date)], ['First payment', formatDateMDY(selected.first_payment_date)], ['Last payment', formatDateMDY(selected.last_payment_date)],
              ['Active tenure', tenureYrs != null ? `${tenureYrs.toFixed(1)} yrs` : '—'], ['Cohort', selected.cohort_year != null ? String(selected.cohort_year) : '—']]} />
          </Section>
          <Section title="Value at churn">
            <Facts items={[['Lifetime total', usd(selected.lifetime_total)], ['Subscription', usd(selected.lifetime_subscription), ofLifetime(selected.lifetime_subscription)],
              ['Services', usd(selected.lifetime_services), ofLifetime(selected.lifetime_services)], ['Connect', usd(selected.lifetime_connect), ofLifetime(selected.lifetime_connect)],
              ['Peak month', selected.peak_month_total != null ? usd(selected.peak_month_total) : '—', selected.peak_month ? monthLabel(selected.peak_month) : undefined],
              ['Transactions', selected.transaction_count.toLocaleString()]]} />
          </Section>
        </div>
        <Section title="Account context">
          <Facts items={[
            ['Account rep', selected.instance_owner_first_name?.trim() || selected.instance_owner?.trim() || '—'], ['Segment', selected.primary_segment || '—'], ['Sub-segment', selected.sub_segment || '—'],
            ['Pay status', selected.pay_status || '—'], ['Contract', selected.contract_status || '—'],
            selected.customer_health_cs_pulse && ['CS health pulse', selected.customer_health_cs_pulse],
            selected.notes_last_contacted && ['Last contacted', formatDateMDY(selected.notes_last_contacted)],
            selected.vip_legacy_customer && ['VIP / legacy', selected.vip_legacy_customer],
          ]} />
        </Section>
        {revenueChart('Revenue history · where it wound down', 'Monthly revenue by stream across the customer\'s lifetime. The drop-off shows when and how their spend tapered before churn. Pick All to see the whole relationship.')}
      </>;
    }
    let health: ReactNode = null;
    if (riskEntry) {
      const localBidOnly = bidOnlyMap[aidKey];
      const isBidOnly = localBidOnly !== undefined ? localBidOnly : !!riskEntry.is_bid_only;
      const persistedBidOnly = !!riskEntry.is_bid_only;
      const bidOnlyPending = localBidOnly !== undefined && localBidOnly !== persistedBidOnly;
      const effectiveScore = isBidOnly && !persistedBidOnly ? riskEntry.total_score + (35 - riskEntry.signal_1_orders) + (25 - riskEntry.signal_2_launch) : riskEntry.total_score;
      const effectiveTier = isBidOnly && !persistedBidOnly && effectiveScore >= 40 ? 'green' : (isBidOnly && !persistedBidOnly ? 'yellow' : riskEntry.tier);
      const tier = TIER[effectiveTier] ?? { word: 'Unscored', tone: 'neutral' as Tone };
      const d = riskEntry.primary_risk_driver;
      const pulseTone: Tone = riskEntry.pulse_color === 'green' ? 'success' : riskEntry.pulse_color === 'yellow' ? 'warning' : 'error';
      const signals: Array<[ReactNode, string, number]> = [
        ['1 · Order volume', riskEntry.orders_detail, riskEntry.signal_1_orders],
        ['2 · Launch status', riskEntry.signal_2_detail || riskEntry.launch_status, riskEntry.signal_2_launch],
        ['3 · Engagement recency', riskEntry.days_since_last_contact != null ? `${riskEntry.days_since_last_contact}d since last contact` : 'No HubSpot recency data', riskEntry.signal_3_recency],
        ['4 · Risk signals', riskEntry.signal_4_risk === 0 ? 'None recorded' : 'See notes scan', riskEntry.signal_4_risk],
        ['5 · Tenure × launch', selected.years_with_us != null ? `${selected.years_with_us.toFixed(1)}y tenure, ${riskEntry.launch_status}` : '—', riskEntry.signal_5_tenure],
        [<span key="p" className="am-row am-row--tight">6 · CS health pulse{riskEntry.pulse_color && <Tag word={riskEntry.pulse_color[0].toUpperCase() + riskEntry.pulse_color.slice(1)} tone={pulseTone} />}</span>,
          riskEntry.pulse_detail ?? 'Not set in HubSpot', riskEntry.signal_6_pulse ?? 0],
      ];
      health = (
        <Section title="Churn risk · health score" caption="The customer's six-signal score from the Churn Risk Matrix."
          actions={<>
            <Switch checked={isBidOnly} onChange={(v) => {
              const next = { ...bidOnlyMap };
              if (v === persistedBidOnly) delete next[aidKey]; else next[aidKey] = v;
              setBidOnlyMap(next); writeJson(BID_ONLY_STORAGE_KEY, next);
            }}>Bid-only customer</Switch>
            {bidOnlyPending && <Tag word="Pending" tone="warning" />}
          </>}>
          <KpiGrid>
            <KpiCard label="Tier" value={tier.word} hint={`Score ${riskEntry.total_score}${effectiveScore !== riskEntry.total_score ? ` (${effectiveScore} with bid-only)` : ''}`} tag={tier.word} tagTone={tier.tone} />
            <KpiCard label="ARR at risk" value={usd(riskEntry.arr_at_risk)} hint="From the risk matrix" />
          </KpiGrid>
          <p className="am-card__text">Bid-only marks a customer who uses Allmoxy mainly for bids and quotes that never become verified orders. When on, signals 1 (order volume) and 2 (launch status) count as their maximum (+60 combined); the other signals still apply. Saved in this browser until committed to _etl_scripts/bid_only_customers.json.</p>
          <DataTable label="Signal breakdown" cols={[['Signal', false], ['Detail', false], ['Points', true]]}
            rows={signals.map(([a, b, c]) => [a, b, signedPts(c)])}
            foot={['Total', '', String(riskEntry.total_score)]} />
          {d && (
            <section className="am-card am-card--outlined" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="am-row am-row--wrap">
                <span className="am-chart__title">Primary risk driver</span>
                <Tag word={d.key} tone={tier.tone} />
                <Tag word={d.source === 'signals' ? 'From signals' : 'From calls / notes'} tone="neutral" />
              </div>
              {(d.expected_value || d.current_state || d.roadblocks) ? <>
                {d.expected_value && <p className="am-card__text"><b>Sold on / expected:</b> {d.expected_value}</p>}
                {d.current_state && <p className="am-card__text"><b>Where they are today:</b> {d.current_state}</p>}
                {d.roadblocks && <p className="am-card__text"><b>Roadblocks to value:</b> {d.roadblocks}</p>}
              </> : <p className="am-card__text">{d.summary}</p>}
              {d.evidence && d.evidence.length > 0 && d.evidence.map((e, i) => <p key={i} className="am-card__text">· {e}</p>)}
              {d.source !== 'signals' && d.signal_baseline && <p className="am-card__text">Signal read: {d.signal_baseline}</p>}
            </section>
          )}
          <div><button className="am-btn am-btn--text" onClick={() => navigate('/churn-risk-matrix')}>See the full attack list on Churn Risk Matrix<Icon name="arrow_forward" /></button></div>
        </Section>
      );
    }
    if (!summary && !health) return <p className="am-card__text">This customer has no churn-risk score.</p>;
    return <>{summary}{health}</>;
  })();

  const revenueView = (() => {
    const out: ReactNode[] = [revenueChart('Monthly revenue timeline · stacked by stream', 'Every month this customer has paid, split into Subscription, Services and Connect. The range total excludes the month in progress.')];
    // Orders verified · by year
    if (ov && ov.years) {
      const currentYear = new Date().getFullYear();
      const monthsLoaded = Object.keys(ov.monthly_supplement || {}).length;
      const yearRows = Object.entries(ov.years).map(([year, y]) => {
        const isCurrentYear = Number(year) === currentYear;
        const total = y.total_usd || 0;
        const annualized = isCurrentYear && monthsLoaded > 0 && monthsLoaded < 12 ? Math.round((total * 12 / monthsLoaded) * 100) / 100 : total;
        return { year, order_count: y.order_count == null ? null : y.order_count, total_usd: total, annualized, is_partial: isCurrentYear && monthsLoaded < 12 };
      }).filter((r) => (r.order_count ?? 0) > 0 || r.total_usd > 0).sort((a, b) => a.year.localeCompare(b.year));
      if (yearRows.length > 0) {
        const yoyPct = ov.monthly_avg_yoy_pct;
        const yoyLabel = yoyPct == null || yoyPct === -1 ? null : (yoyPct >= 0 ? '+' : '') + Math.round(yoyPct * 100) + '%';
        const curMA = ov.monthly_avg_current_year || 0, prevMA = ov.monthly_avg_prior_year || 0;
        const cur = yearRows.find((r) => Number(r.year) === currentYear);
        const prior = yearRows.find((r) => Number(r.year) === currentYear - 1);
        const diff = cur?.is_partial && prior && prior.total_usd > 0 ? Math.round(((cur.annualized - prior.total_usd) / prior.total_usd) * 100) : null;
        const proj = (r: typeof yearRows[number]) => (r.year === String(currentYear) && r.is_partial ? Math.max(0, r.annualized - r.total_usd) : 0);
        out.push(
          <ChartCard key="ovy" title="Orders verified · by year" caption={`Verified invoice dollars each year this customer ran orders through Allmoxy; order counts in the hover and the table. ${(ov.total_lifetime_orders || 0).toLocaleString()} lifetime orders / ${usd(ov.total_lifetime_usd || 0)} lifetime.`}>
            {cur?.is_partial && (
              <KpiGrid>
                <KpiCard label={`${currentYear} YTD (${monthsLoaded}mo) annualized`} value={usd(cur.annualized)} hint={`actual YTD: ${usd(cur.total_usd)} · YTD ÷ ${monthsLoaded} × 12`} />
                {prior && <KpiCard label={`vs ${currentYear - 1} actual`} value={usd(prior.total_usd)} hint="full prior year"
                  tag={diff != null ? `${diff >= 0 ? '+' : ''}${diff}% if pace holds` : undefined} tagTone={diff != null ? (diff >= 0 ? 'success' : 'warning') : undefined} />}
              </KpiGrid>
            )}
            <Facts items={[
              ['Lifetime orders', (ov.total_lifetime_orders || 0).toLocaleString()], ['Lifetime invoice $', usd(ov.total_lifetime_usd || 0)],
              ov.live_date && ['Live date', ov.live_date], ov.months_to_launch != null && ['Months to launch', `${ov.months_to_launch} mo`],
              curMA > 0 && ['Current monthly avg', `${usd(curMA)}/mo`], prevMA > 0 && ['Prior-year monthly avg', `${usd(prevMA)}/mo`], yoyLabel && ['Year over year', yoyLabel],
            ]} />
            <ColumnChart months={yearRows.map((r) => r.year)} stacked legend={yearRows.some((r) => proj(r) > 0)} fmt={usdk}
              catLabel={(k) => k} catTitle={(k) => `${k}${Number(k) === currentYear && cur?.is_partial ? ' (in progress)' : ''}`}
              series={[
                { key: 'inv', label: 'Invoice $', tone: 'div-1', values: yearRows.map((r) => r.total_usd) },
                { key: 'proj', label: 'Annualized (projected)', tone: 'other', values: yearRows.map(proj) },
              ]}
              labelFor={(i) => usdk(yearRows[i].total_usd)}
              tipRows={(i) => { const r = yearRows[i]; return [['Invoice $', usd(r.total_usd)], ['Order count', r.order_count == null ? 'not available' : r.order_count.toLocaleString()], ...(proj(r) > 0 ? [['Annualized (projected)', usd(r.annualized)] as [string, string]] : [])]; }}
              aria={`Verified invoice dollars by year for ${selected.name}.`} />
            <DataTable label="Orders verified by year" cols={[['Year', false], ['Orders', true], ['Invoice $', true], ['Annualized', true]]}
              rows={yearRows.map((r) => [`${r.year}${r.is_partial ? ' (in progress)' : ''}`, r.order_count == null ? '—' : r.order_count.toLocaleString(), usd(r.total_usd), r.is_partial ? usd(r.annualized) : '—'])}
              sortValues={yearRows.map((r) => [r.year, r.order_count, r.total_usd, r.is_partial ? r.annualized : null])}
              foot={[`Total · ${yearRows.length} years`, yearRows.reduce((s, r) => s + (r.order_count ?? 0), 0).toLocaleString(), usd(yearRows.reduce((s, r) => s + r.total_usd, 0)), '']} />
          </ChartCard>,
        );
      }
    }
    // Orders verified · by month
    if (monthly && monthly.rows.length > 0) {
      const mr = monthly.rows.filter((r) => ordRange.months.includes(r.month));
      out.push(
        <ChartCard key="ovm" title="Orders verified · by month"
          caption={monthly.fallback ? `Not yet mapped in the warehouse monthly table, so this falls back to the ${monthly.currentYear} spreadsheet supplement.`
            : monthly.spreadCount > 0 ? `Gray months are estimated: the source holds an annual figure divided evenly across twelve, so read them as a level, not a trend.${monthly.firstReal ? ` Measured monthly data begins ${monthLabelLong(monthly.firstReal)}.` : ''}`
              : 'Every month shown is measured.'}>
          <Facts items={[
            ['Verified $ (all months)', usd(monthly.ytd)], ['Monthly average', `${usd(monthly.avg)}/mo`], ['Months', `${monthly.rows.length}`],
            monthly.totalOrders > 0 && ['Orders (all months)', monthly.totalOrders.toLocaleString()],
            monthly.firstReal && ['Measured from', monthLabel(monthly.firstReal)],
            monthly.spreadCount > 0 && ['Estimated months', `${monthly.spreadCount} of ${monthly.rows.length}`],
          ]} />
          {ordRange.controls}
          <ColumnChart months={mr.map((r) => r.month)} stacked legend={mr.some((r) => r.spread)} fmt={usdk}
            catTitle={(m) => `${monthLabelLong(m)}${m === inProgress ? ' (in progress)' : ''}`}
            series={[
              { key: 'measured', label: 'Measured', tone: 'div-1', values: mr.map((r) => (r.spread ? 0 : r.verified)) },
              { key: 'estimated', label: 'Estimated (annual ÷ 12)', tone: 'other', values: mr.map((r) => (r.spread ? r.verified : 0)) },
            ]}
            labelFor={(i) => usdk(mr[i].verified)}
            tipRows={(i) => { const r = mr[i]; return [['Verified $', usd(r.verified)], ['Orders', r.orders == null ? 'no real monthly count' : r.orders.toLocaleString()],
              ...(r.spread ? [['Basis', 'estimated (annual ÷ 12)'] as [string, string]] : []), ...(r.pending ? [['Note', 'not aggregated yet'] as [string, string]] : []), ...(r.missing ? [['Note', 'gap in the warehouse'] as [string, string]] : [])]; }}
            aria={`Verified order dollars by month for ${selected.name}, ${ordRange.rangeText}.`} />
          <p className="am-card__text">Order counts are left out for any month whose count only repeats the prior month (a carry-forward). A month with orders but $0 is a warehouse gap if the month is over, or not aggregated yet if it is the current one.</p>
        </ChartCard>,
      );
    }
    return <>{out}</>;
  })();

  const renewalView = (() => {
    const renewalRows = ((renewalData as unknown as { rows: RenewalRow[] } | undefined)?.rows ?? []).filter((r) => r.allmoxy_customer_id === aid);
    const parts: ReactNode[] = [];
    if (renewalRows.length > 0) {
      const row = renewalRows.find((r) => r.renewal_date) ?? renewalRows[0];
      const showProposed = row.proposed_mrr != null && (row.action_tag === 'Expansion Opportunity' || row.proposed_basis === 'underpriced');
      const dropoffWorse = row.dropoff_pct != null && row.dropoff_pct >= 0.25;
      const dropoffBetter = row.dropoff_pct != null && row.dropoff_pct <= -0.25;
      const pct2 = (v: number | null) => (v != null ? `${v.toFixed(2)}%` : '—');
      const trend = row.monthly_trend ?? [];
      const ctx: Array<[string, ReactNode]> = [
        ['Renewal date', row.renewal_date ? `${row.renewal_date}${row.days_to_renewal != null ? ` · ${row.days_to_renewal >= 0 ? `in ${row.days_to_renewal}d` : `${Math.abs(row.days_to_renewal)}d ago`}` : ''}` : 'Not set in HubSpot'],
        ['Contract', `${row.contract_status || '—'}${row.contract_length_months ? ` · ${row.contract_length_months} mo term` : ''}`],
        ['ARR up for renewal', usd(row.arr_up_for_renewal)],
        ['HubSpot monthly fee', `${row.monthly_flat_fee_hubspot != null ? usd(row.monthly_flat_fee_hubspot) : '—'} (Stripe MRR: ${usd(row.current_mrr)})`],
        ['Cost ratio · lifetime', `${pct2(row.cost_ratio_lifetime_pct)} (${usd(row.lifetime_subscription)} paid / ${usd(row.lifetime_orders_dollars)} verified)`],
        ['Cost ratio · annualized', `${pct2(row.cost_ratio_annualized_pct)} (${usd(row.orders_monthly_avg_current_year)}/mo now vs ${usd(row.orders_monthly_avg_prior_year)}/mo prior year)`],
        ...(row.dropoff_pct != null ? [['Recent 3 mo cost ratio vs trailing 9 mo', <span key="d" className="am-row am-row--tight">{`${row.dropoff_pct >= 0 ? '+' : ''}${Math.round(row.dropoff_pct * 100)}%`}
          {dropoffWorse && <Tag word="Worse: orders falling" tone="warning" />}{dropoffBetter && <Tag word="Better: orders growing" tone="success" />}</span>] as [string, ReactNode]] : []),
        ['Last renewal expansion', `${row.last_renewal_expansion || '—'}${row.last_no_expansion_reason ? ` · reason: ${row.last_no_expansion_reason}` : ''}`],
        ['Action', <span key="a" className="am-row am-row--tight"><Tag word={row.action_tag} tone={ACTION[row.action_tag] ?? 'neutral'} /><span className="am-card__text">{row.action_reason}</span></span>],
        ...(row.cs_pulse ? [['CS pulse', row.cs_pulse] as [string, ReactNode]] : []),
        ...(row.implementation_status ? [['Implementation', row.implementation_status] as [string, ReactNode]] : []),
        ['Pay status', <span key="p" className="am-row am-row--tight">{row.pay_status}{row.vip_legacy === 'Yes' && <Tag word="VIP" tone="info" />}</span>],
      ];
      parts.push(
        <Section key="ren" title={`Renewal · ${row.account_name || selected.name}`}
          caption={`${row.renewal_date ? `Renews ${row.renewal_date}${row.days_to_renewal != null ? ` · ${row.days_to_renewal >= 0 ? `in ${row.days_to_renewal}d` : `${Math.abs(row.days_to_renewal)}d ago`}` : ''}` : 'No renewal date in HubSpot'} · cost ratio ${pct2(row.cost_ratio_lifetime_pct)} lifetime`}
          actions={<Tag word={row.action_tag} tone={ACTION[row.action_tag] ?? 'neutral'} />}>
          {showProposed && (
            <section className="am-card am-card--outlined" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="am-row am-row--wrap">
                <Tag word="Proposed renewal price" tone="success" />
                {row.proposed_basis === 'underpriced' && <Tag word="Underpriced vs peers" tone="success" />}
                {row.expansion_confidence === 'low' && <Tag word="Low confidence" tone="warning" />}
              </div>
              <Facts min={200} items={[
                ['MRR', <p key="m" className="am-summary__value">{usd(row.current_mrr)} → {usd(row.proposed_mrr ?? 0)}</p>, row.proposed_uplift_pct != null ? `${row.proposed_uplift_pct >= 0 ? '+' : ''}${row.proposed_uplift_pct}%` : undefined],
                row.proposed_arr != null && ['ARR', <p key="a" className="am-summary__value">{usd(row.current_arr ?? row.arr_up_for_renewal ?? 0)} → {usd(row.proposed_arr ?? 0)}</p>],
                row.target_1pct_mrr != null && row.target_1pct_mrr > row.current_mrr && ['At a 1% cost ratio (uncapped)', <p key="t" className="am-summary__value">{usd(row.target_1pct_mrr)}/mo</p>, `${usd(row.target_1pct_arr ?? 0)} ARR`],
              ]} />
              {row.expansion_rationale && <p className="am-card__text">{row.expansion_rationale}</p>}
              <p className="am-card__text">Realigns the cost ratio (subscription ÷ verified orders) to the higher of this customer's lifetime ratio or the base median, on today's order run-rate, capped at +15% per renewal. A starting point, not a mandate.</p>
            </section>
          )}
          <span className="am-chart__title">Cost ratio · monthly trend</span>
          <span className="am-card__text">Subscription ÷ verified orders each month; lower is better. Complete months only, so a partial month never looks like a contraction.</span>
          {trend.length === 0 ? <p className="am-card__text">No monthly history.</p> : (
            <ColumnChart months={trend.map((p) => p.month)} fmt={(x) => `${x.toFixed(1)}%`}
              series={[{ key: 'cr', label: 'Cost ratio', tone: 'div-1', values: trend.map((p) => p.cost_ratio_pct ?? 0) }]}
              labelFor={(i) => (trend[i].cost_ratio_pct == null ? null : `${trend[i].cost_ratio_pct!.toFixed(1)}%`)}
              tipRows={(i) => { const p = trend[i]; return [['Cost ratio', pct2(p.cost_ratio_pct)], ['Subscription', usd(p.subscription)], ['Orders verified', `${usd(p.orders_dollars)}${p.orders_source === 'yearly_avg' ? ' (yearly average)' : ''}`]]; }}
              aria={`Monthly cost ratio for ${selected.name}.`} />
          )}
          <DataTable label="Renewal context" cols={[['Item', false], ['Detail', false]]} rows={ctx.map(([a, b]) => [a, b])} />
        </Section>,
      );
    }
    const byId = new Map<string, Quote>();
    renewalRows.forEach((r) => (r.quotes ?? []).forEach((q) => byId.set(q.id, q)));
    const quotes = Array.from(byId.values()).sort((a, b) => (b.created_date ?? '').localeCompare(a.created_date ?? ''));
    if (quotes.length > 0) {
      const qAmt = (q: Quote) => (q.amount != null ? `${q.currency === 'USD' ? '$' : `${q.currency} `}${Math.round(q.amount).toLocaleString()}` : '—');
      parts.push(
        <Section key="q" title={`Quotes (${quotes.length})`} caption="Every HubSpot quote on this customer's company, newest first. Sent means active in HubSpot; Draft is still in progress.">
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Quotes" cols={[['Title', false], ['Status', false], ['Amount', true], ['Created', false], ['Expires', false], ['', false]]}
              rows={quotes.map((q) => { const t = quoteTag(q.status); return [q.title || '(untitled)', <Tag key="s" word={t.word} tone={t.tone} />, qAmt(q),
                q.created_date ? q.created_date.slice(0, 10) : '—', q.expiration_date ? q.expiration_date.slice(0, 10) : '—', <ExtLink key="l" href={q.hubspot_url}>Open in HubSpot</ExtLink>]; })}
              sortValues={quotes.map((q) => [(q.title || '').toLowerCase(), q.status ?? '', q.amount, q.created_date ?? '', q.expiration_date ?? '', null])}
              foot={[`Total · ${quotes.length} quotes`, '', usd(quotes.reduce((s, q) => s + (q.amount ?? 0), 0)), '', '', '']} />
          </div>
        </Section>,
      );
    }
    if (!parts.length) return <p className="am-card__text">No renewal record or quotes for this customer.</p>;
    return <>{parts}</>;
  })();

  const activityView = (() => {
    const parts: ReactNode[] = [];
    // Implementation
    const impl = (implementationData as unknown as { rows: ImplRow[] } | undefined)?.rows?.find((r) => r.allmoxy_customer_id === aid);
    if (impl) {
      const stageTone: Tone = !impl.stage ? 'neutral' : /done/i.test(impl.stage) ? 'success' : /waiting/i.test(impl.stage) ? 'warning' : /hold|abandon/i.test(impl.stage) ? 'neutral' : 'info';
      const signupDays = selected.sign_up_date ? Math.floor((Date.now() - new Date(selected.sign_up_date).getTime()) / 86400000) : null;
      const slaTone: Tone = signupDays == null ? 'neutral' : signupDays > 90 ? 'error' : signupDays >= 60 ? 'warning' : 'success';
      const catTone = (c: string | null): Tone => (c === 'Done' ? 'success' : c === 'In Progress' ? 'info' : c === 'To Do' ? 'neutral' : 'warning');
      const catRank = (c: string | null) => (c === 'In Progress' ? 0 : c === 'To Do' ? 1 : c === 'Done' ? 3 : 2);
      const tasks = [...(impl.tasks ?? [])].sort((a, b) => catRank(a.stage_category) - catRank(b.stage_category) || (b.created ?? '').localeCompare(a.created ?? ''));
      parts.push(
        <Section key="impl" title="Implementation"
          caption="Services revenue. The goal is time to first order: no first verified live order means initial implementation; launched customers are doing catalog updates. Stage from JIRA, hours and dollars from Harvest."
          actions={<>
            <Tag word={impl.implementation_type === 'Initial implementation' ? 'Initial implementation' : impl.implementation_type === 'Catalog update' ? 'Catalog update' : 'Unknown launch'} tone={impl.implementation_type === 'Initial implementation' ? 'info' : 'neutral'} />
            <Tag word={impl.is_active ? 'Active' : 'Inactive'} tone={impl.is_active ? 'success' : 'neutral'} />
            {impl.ttv_category === 'gym_member' && <Tag word="Stalled · never launched" tone="warning" />}
          </>}>
          <Facts items={[
            ['Signed up', selected.sign_up_date ? selected.sign_up_date.slice(0, 10) : '—'],
            ['First order (value)', impl.launch_status === 'launched'
              ? <Tag key="l" word={`${impl.first_order_year ? `Live ${impl.first_order_year}` : 'Launched'}${impl.time_to_first_order_months != null ? ` · ~${impl.time_to_first_order_months}mo to first order` : ''}`} tone="success" />
              : impl.launch_status === 'pre_launch'
                ? <Tag key="l" word={`No first order yet${signupDays != null ? ` · ${signupDays}d since sign-up` : ''}${signupDays != null && signupDays > 90 ? ' · overdue (>90d)' : ''}`} tone={slaTone} />
                : 'Unknown launch status'],
            ['Stage', impl.stage ? <Tag key="s" word={impl.stage} tone={stageTone} /> : 'No JIRA epic', impl.assignee ? `Owner: ${impl.assignee}` : undefined],
            ['Hours logged', impl.has_harvest ? impl.hours.toLocaleString() : '—', impl.has_harvest ? `${impl.billable_hours.toLocaleString()} billable` : 'no Harvest project'],
            ['Billable services $', impl.has_harvest ? usd(impl.billable_amount) : '—', `${impl.billing_method || '—'}${impl.billing_method === 'Hourly' && impl.hourly_rate ? ` @ $${impl.hourly_rate}/hr` : ''}`],
            ['Last activity', impl.last_entry || '—', impl.jira_url ? <a className="am-btn am-btn--text" href={impl.jira_url} target="_blank" rel="noopener noreferrer">{impl.jira_key} in JIRA<Icon name="open_in_new" /></a> : undefined],
          ]} />
          {tasks.length > 0 && <>
            <span className="am-chart__title">Implementation tickets ({tasks.length}{impl.tasks_done ? ` · ${impl.tasks_done} done` : ''})</span>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Implementation tickets" cols={[['Ticket', false], ['Key', false], ['Status', false], ['Owner', false], ['Created', false], ['Due', false]]}
                rows={tasks.map((t) => [<a key="t" className="am-btn am-btn--text" href={t.url} target="_blank" rel="noopener noreferrer">{t.summary || t.key}</a>, t.key,
                  <Tag key="s" word={t.status || '—'} tone={catTone(t.stage_category)} />, t.assignee || '—', t.created || '—', t.due || '—'])}
                sortValues={tasks.map((t) => [t.summary || t.key, t.key, catRank(t.stage_category), t.assignee ?? '', t.created ?? '', t.due ?? ''])} />
            </div>
          </>}
          <div><button className="am-btn am-btn--text" onClick={() => navigate('/implementation')}>Manage the work on Implementation<Icon name="arrow_forward" /></button></div>
        </Section>,
      );
    }
    // Service tickets
    const tixSnap = hubspotTicketsData as unknown as { tickets?: TicketRow[]; fetched_at?: string } | undefined;
    const companyId = selected.hubspot_company_id;
    const synced = !!(tixSnap && Array.isArray(tixSnap.tickets));
    const tickets = (tixSnap?.tickets ?? []).filter((t) => companyId != null && (t.associated_company_ids ?? []).includes(String(companyId))).slice()
      .sort((a, b) => (a.is_closed !== b.is_closed ? (a.is_closed ? 1 : -1) : String(b.updated ?? '').localeCompare(String(a.updated ?? ''))));
    const openCount = tickets.filter((t) => !t.is_closed).length;
    const stageCounts = new Map<string, number>();
    for (const t of tickets) { const s = t.stage_label || '—'; stageCounts.set(s, (stageCounts.get(s) ?? 0) + 1); }
    const visible = tickets.filter((t) => ticketStatusFilter === 'all' ? true : ticketStatusFilter === 'open' ? !t.is_closed : ticketStatusFilter === 'closed' ? t.is_closed : (t.stage_label || '—') === ticketStatusFilter);
    const tixFile = `customer_${aid}_hubspot_tickets`;
    parts.push(
      <Section key="tix" title={`Service tickets · ${selected.name}`}
        caption={`Every HubSpot service ticket on this customer's HubSpot company, open first then newest.${tixSnap?.fetched_at ? ` Synced ${formatDateMDY(String(tixSnap.fetched_at).slice(0, 10))}.` : ''}`}
        actions={synced && tickets.length > 0 ? <button className="am-btn am-btn--text" onClick={() => {
          const order = tixOrder && tixOrder.length === visible.length ? tixOrder : visible.map((_, i) => i);
          downloadCsv(tixFile, ['Subject', 'Stage', 'Priority', 'Category', 'Owner', 'Created', 'Updated'],
            order.map((i) => visible[i]).map((t) => [t.subject ?? '', t.stage_label ?? '', t.priority ?? '', t.category ?? '', t.owner_full_name ?? '', t.created ?? '', t.updated ?? '']));
        }}><Icon name="download" />CSV</button> : undefined}>
        {!synced ? <p className="am-card__text">HubSpot service tickets are not synced yet. Grant the crm.objects.tickets.read scope to the HubSpot private app, then run the HubSpot sync.</p>
          : companyId == null ? <p className="am-card__text">This customer has no linked HubSpot company, so tickets cannot be matched.</p>
            : tickets.length === 0 ? <p className="am-card__text">No HubSpot service tickets are associated to this customer.</p>
              : <>
                <div className="am-row am-row--wrap">
                  <Select label="Status" width={240} value={ticketStatusFilter} onPick={(v) => { setTicketStatusFilter(v); setShowAllTix(false); }}
                    options={[['all', `All statuses (${tickets.length})`], ['open', `Open (${openCount})`], ['closed', `Closed (${tickets.length - openCount})`],
                      ...[...stageCounts.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]): [string, string] => [s, `${s} (${n})`])]} />
                  <span className="am-card__text">Showing {visible.length} of {tickets.length} · {openCount} open</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <DataTable label="Service tickets" key={`tix-${aid}-${ticketStatusFilter}`}
                    cols={[['Subject', false], ['Stage', false], ['Priority', false], ['Category', false], ['Owner', false], ['Created', false], ['Updated', false]]}
                    rows={visible.map((t) => [<ExtLink key="s" href={t.hubspot_url}>{t.subject || `Ticket ${t.id}`}</ExtLink>,
                      <Tag key="g" word={t.stage_label || (t.is_closed ? 'Closed' : 'Open')} tone={t.is_closed ? 'neutral' : 'warning'} />,
                      t.priority || '—', t.category || '—', t.owner_full_name || '—', t.created ? formatDateMDY(String(t.created).slice(0, 10)) : '—', t.updated ? formatDateMDY(String(t.updated).slice(0, 10)) : '—'])}
                    sortValues={visible.map((t) => [t.subject ?? '', t.stage_label ?? '', t.priority ?? '', t.category ?? '', t.owner_full_name ?? '', t.created ?? '', t.updated ?? ''])}
                    limit={showAllTix ? undefined : 25} onSortChange={(o) => setTixOrder(o)} />
                </div>
                {!showAllTix && visible.length > 25 && <div><button className="am-btn am-btn--text" onClick={() => setShowAllTix(true)}>Show all {visible.length}</button></div>}
              </>}
      </Section>,
    );
    // Transactions
    const txns = selected.transactions ?? [];
    const sumAll = txns.reduce((s, t) => s + (t.amount || 0), 0);
    const sumOk = txns.filter((t) => t.status === 'succeeded').reduce((s, t) => s + (t.amount || 0), 0);
    const txTone = (s: string | null): Tone => (s === 'succeeded' ? 'success' : s === 'failed' ? 'error' : 'neutral');
    parts.push(
      <Section key="txn" title={`Transactions · ${selected.name}`}
        caption={`${selected.transaction_count.toLocaleString()} Stripe charges · ${usd(sumOk)} succeeded. Sort any column; the CSV follows the sort.`}
        actions={<button className="am-btn am-btn--text" disabled={txns.length === 0} onClick={() => {
          const order = txnOrder && txnOrder.length === txns.length ? txnOrder : txns.map((_, i) => i);
          downloadCsv(`customer_${aid}_transactions`, ['Date', 'Amount', 'Type', 'Status', 'Description'],
            order.map((i) => txns[i]).map((t) => [String(t.created ?? '').slice(0, 10), t.amount, t.type ?? '', t.status ?? '', t.description ?? '']));
        }}><Icon name="download" />CSV</button>}>
        {txns.length === 0 ? <p className="am-card__text">No rows to show.</p> : <>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Transactions" key={`txn-${aid}`} cols={[['Date', false], ['Amount', true], ['Type', false], ['Status', false], ['Description', false]]}
              rows={txns.map((t) => [formatDateMDY(String(t.created ?? '').slice(0, 10)), usd(t.amount), t.type ?? '—', <Tag key="s" word={t.status ?? '—'} tone={txTone(t.status)} />, t.description || '—'])}
              sortValues={txns.map((t) => [String(t.created ?? ''), t.amount, t.type ?? '', t.status ?? '', t.description ?? ''])}
              limit={showAllTxn ? undefined : 25} onSortChange={(o) => setTxnOrder(o)}
              foot={[`Total · ${txns.length} charges`, usd(sumAll), '', `${usd(sumOk)} succeeded`, '']}
              onFoot={() => setShowAllTxn(true)} footClickable={(c) => c === 1 && !showAllTxn && txns.length > 25} />
          </div>
          {!showAllTxn && txns.length > 25 && <div><button className="am-btn am-btn--text" onClick={() => setShowAllTxn(true)}>Show all {txns.length}</button></div>}
        </>}
      </Section>,
    );
    return <>{parts}</>;
  })();

  const revSheetRows = revComplete;
  return (
    <DsPage path="/customer-detail" title={selected.name}
      subtitle={`Allmoxy ID ${aid}${selected.primary_segment ? ` · ${selected.primary_segment}` : ''}${selected.installer_id ? ` · Installer ${selected.installer_id}` : ''}`}
      actions={<button className="am-btn am-btn--outlined" onClick={() => navigate('/customers')}><Icon name="arrow_back" />All customers</button>}
      overlays={
        <SideSheet open={revSheet} onClose={() => setRevSheet(false)} title={`Revenue by month · ${rev.rangeText}`}
          text={`${selected.name}. Complete months in the selected range; the month in progress is excluded, as in the total.`}>
          <button className="am-btn am-btn--text" onClick={() => downloadCsv(`customer_${aid}_revenue_by_month`, ['Month', 'Subscription', 'Services', 'Connect', 'Total'],
            revSheetRows.map((r) => [r.month, r.subscription, r.services, r.connect, r.subscription + r.services + r.connect]))}><Icon name="download" />CSV</button>
          <DataTable label="Revenue by month" cols={[['Month', false], ['Subscription', true], ['Services', true], ['Connect', true], ['Total', true]]}
            rows={revSheetRows.map((r) => [mlabel(r.month), usd(r.subscription), usd(r.services), usd(r.connect), usd(r.subscription + r.services + r.connect)])}
            sortValues={revSheetRows.map((r) => [r.month, r.subscription, r.services, r.connect, r.subscription + r.services + r.connect])}
            foot={['Total', usd(revTot('subscription')), usd(revTot('services')), usd(revTot('connect')), usd(revTot('subscription') + revTot('services') + revTot('connect'))]} />
        </SideSheet>
      }>
      {statusCard}
      {pendingCard}
      <KpiGrid>
        <KpiCard label="Lifetime revenue" value={usd(selected.lifetime_total)} hint="All streams combined" />
        <KpiCard label="Lifetime subscription" value={usd(selected.lifetime_subscription)} hint={ofLifetime(selected.lifetime_subscription)} />
        <KpiCard label="Lifetime services" value={usd(selected.lifetime_services)} hint={ofLifetime(selected.lifetime_services)} />
        <KpiCard label="Lifetime Connect fees" value={usd(selected.lifetime_connect)} hint={ofLifetime(selected.lifetime_connect)} />
        <KpiCard label={`${monthLabel(selected.latest_month)} MRR`} value={usd(selected.current_subscription_mrr)} hint="Invoiced basis, annual payers amortized"
          tag={selected.current_subscription_mrr > 0 ? 'Currently paying' : 'Not paying this month'} tagTone={selected.current_subscription_mrr > 0 ? 'success' : 'neutral'} />
        <KpiCard label="Total orders" value={totalOrders} hint={totalOrdersHint} />
      </KpiGrid>
      <Segmented label="Customer view" value={view} onChange={setView}
        options={[['account', 'Account'], ['churn', isChurned ? 'Churn summary' : 'Churn risk'], ['revenue', 'Revenue & usage'], ['renewal', 'Renewal & quotes'], ['activity', 'Implementation & activity']]} />
      {view === 'account' && accountView}
      {view === 'churn' && churnView}
      {view === 'revenue' && revenueView}
      {view === 'renewal' && renewalView}
      {view === 'activity' && activityView}
    </DsPage>
  );
}

// ---------------------------------------------------------------- churn analysis (classic ChurnAnalysisCard, same save rules)
function ChurnAnalysis({ selected, inference, subTags, subDefs, override, effectiveReason, effectiveEvidence, reasonSource, onSave }: {
  selected: CustomerProfile; inference: ChurnInference | null; subTags: string[];
  subDefs: Record<string, { label: string; parent: string; description: string }>; override: ChurnOverride | undefined;
  effectiveReason: string; effectiveEvidence: string; reasonSource: 'override' | 'hubspot' | 'ai' | 'none'; onSave: (reason: string, evidence: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftReason, setDraftReason] = useState(effectiveReason);
  const [draftEvidence, setDraftEvidence] = useState(effectiveEvidence);
  useEffect(() => { setEditing(false); setDraftReason(effectiveReason); setDraftEvidence(effectiveEvidence); }, [selected.allmoxy_customer_id, effectiveReason, effectiveEvidence]);
  const source: { word: string; tone: Tone } = reasonSource === 'override' ? { word: 'You · pending', tone: 'warning' }
    : reasonSource === 'hubspot' ? { word: 'HubSpot Churn Playbook', tone: 'info' }
      : reasonSource === 'ai' ? { word: `AI · ${inference?.confidence ?? 'low'}`, tone: 'neutral' } : { word: 'No reason recorded', tone: 'neutral' };
  const listId = `churn-playbook-${selected.allmoxy_customer_id}`;
  return (
    <Section title="Churn analysis"
      caption="The reason comes from your saved override (wins), HubSpot's Churn Playbook reason, or an AI inference from CSM notes. Sub-patterns are finer-grained tags within the reason."
      actions={<>
        <Tag word={source.word} tone={source.tone} />
        {!editing && <button className="am-btn am-btn--outlined" onClick={() => setEditing(true)}><Icon name="edit" />{override ? 'Edit override' : 'Update'}</button>}
      </>}>
      {!editing ? <>
        <Facts min={260} items={[['Reason', effectiveReason || 'No reason recorded']]} />
        {override && (
          <p className="am-card__text">
            {selected.churn_reason && <>HubSpot reason (overridden): {selected.churn_reason}<br /></>}
            {inference?.suggested_reason && <>AI inference ({inference.confidence}, overridden): {inference.suggested_reason}<br /></>}
            Override saved {new Date(override.updatedAt).toLocaleString()}
          </p>
        )}
        {subTags.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="am-card__text">Sub-patterns ({subTags.length})</span>
            <span className="am-row am-row--wrap am-row--tight">{subTags.map((id) => <span key={id} className="am-tag am-tag--info" title={subDefs[id]?.description}>{subDefs[id]?.label ?? id}</span>)}</span>
          </div>
        )}
        {effectiveEvidence && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="am-card__text">Full reason / evidence</span>
            <div style={{ whiteSpace: 'pre-wrap' }}>{effectiveEvidence}</div>
            {inference?.evidence_date && reasonSource !== 'override' && <span className="am-card__text">Evidence dated {inference.evidence_date}</span>}
          </div>
        )}
        {!override && inference?.recommended_action && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="am-card__text">Recommended action</span>
            <div>{inference.recommended_action}</div>
          </div>
        )}
      </> : <>
        <label className="am-field am-field--outlined" style={{ width: '100%', maxWidth: 520 }}>
          <input className="am-field__input" placeholder=" " list={listId} value={draftReason} onChange={(e) => setDraftReason(e.target.value)} aria-label="Reason (Churn Playbook taxonomy)" />
          <span className="am-field__label">Reason (Churn Playbook taxonomy)</span>
          <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap">Reason (Churn Playbook taxonomy)</i><i /></span>
        </label>
        <datalist id={listId}>{HUBSPOT_CHURN_PLAYBOOK.map((r) => <option key={r} value={r} />)}</datalist>
        <span className="am-card__text">Pick from the standard taxonomy or type your own. Leave both blank to clear the override.</span>
        <label className="am-field am-field--outlined am-field--multiline" style={{ width: '100%' }}>
          <textarea className="am-field__input" placeholder=" " rows={4} value={draftEvidence} onChange={(e) => setDraftEvidence(e.target.value)} aria-label="Full reason / evidence" />
          <span className="am-field__label">Full reason / evidence</span>
          <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap">Full reason / evidence</i><i /></span>
        </label>
        <span className="am-card__text">Stored in this browser until an ETL pass folds it into customer_profiles / churn_inferences.</span>
        <div className="am-row am-row--wrap" style={{ justifyContent: 'flex-end' }}>
          {override && <button className="am-btn am-btn--text" onClick={() => { onSave('', ''); setEditing(false); }}>Clear override</button>}
          <button className="am-btn am-btn--text" onClick={() => { setEditing(false); setDraftReason(effectiveReason); setDraftEvidence(effectiveEvidence); }}>Cancel</button>
          <button className="am-btn am-btn--filled" onClick={() => { onSave(draftReason, draftEvidence); setEditing(false); }}
            disabled={draftReason.trim() === (override?.reason ?? '') && draftEvidence.trim() === (override?.evidence ?? '')}>Save override</button>
        </div>
      </>}
    </Section>
  );
}
