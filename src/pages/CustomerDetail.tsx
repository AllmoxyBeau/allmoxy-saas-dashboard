import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Link from '@mui/material/Link';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Button from '@mui/material/Button';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { ResponsiveContainer, BarChart, Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import HealthScoreInfo from '../components/common/HealthScoreInfo';
import RenewalPanelContent, { type RenewalPanelRow, type RenewalQuote } from '../components/common/RenewalPanelContent';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import annualPayersConfig from '../data/annual_payer_ids.json';

type Transaction = {
  created: string | null;
  amount: number;
  type: string | null;
  status: string | null;
  description: string;
};

type MonthlyCell = { subscription: number; services: number; connect: number; total: number };

type CustomerProfile = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_company_id: string | null;
  installer_id: string | null;
  installer_directory: string | null;
  stripe_customer_ids: string[];
  harvest_id: string | null;
  master_classification_name: string | null;
  sign_up_date: string | null;
  first_payment_date: string | null;
  last_payment_date: string | null;
  years_with_us: number | null;
  cohort_year: number | null;
  status: 'active' | 'at_risk' | 'non_payment' | 'churned' | 'never_paid';
  active_today: boolean;
  lifetime_total: number;
  lifetime_subscription: number;
  lifetime_services: number;
  lifetime_connect: number;
  lifetime_other: number;
  current_subscription_mrr: number;
  current_services: number;
  current_connect: number;
  latest_month: string;
  failed_3mo_count: number;
  failed_3mo_amount: number;
  peak_month: string | null;
  peak_month_total: number;
  transaction_count: number;
  stripe_fee_percent?: number | null;
  // HubSpot Instance Sync Sheet enrichment (null when no match)
  pay_status?: string | null;
  contract_status?: string | null;
  churn_reason?: string | null;
  primary_segment?: string | null;
  sub_segment?: string | null;
  customer_health_cs_pulse?: string | null;
  notes_last_contacted?: string | null;
  vip_legacy_customer?: string | null;
  stripe_subscription_id?: string | null;
  custom_domain_stripe_subscription_id?: string | null;
  all_stripe_subscription_ids?: string[];
  all_custom_domain_stripe_subscription_ids?: string[];
  hubspot_instance_name?: string | null;
  hubspot_record_id?: string | null;
  instance_owner?: string | null;
  instance_owner_first_name?: string | null;
  hubspot_owner_name?: string | null;
  // "Who They Are" firmographics from the HubSpot Company object.
  firmographics?: Firmographics | null;
  monthly_history: Record<string, MonthlyCell>;
  transactions: Transaction[];
};

type Firmographics = {
  components_manufactured: string[];
  software: { accounting: string[]; cam: string[]; design_3d: string[]; crm: string[]; other: string[] };
  revenue_band: string | null;
  annual_revenue: number | null;
  employee_band: string | null;
  headcount: number | null;
  geographic_scope: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  ownership_type: string | null;
  founded_year: string | null;
  business_model: string[];
  end_customer_type: string[];
  end_market: string[];
  product: {
    customization_tier: string | null;
    construction_methods: string[];
    assembly_model: string[];
    installation_model: string[];
    technology_profile: string[];
  };
};


// public/snapshots/churn_inferences.json — Claude-MCP-generated reason fallback for customers
// HubSpot has no recorded churn_reason for. See ChurnPatterns page for the full UI.
type ChurnInference = {
  allmoxy_customer_id: number;
  name: string;
  suggested_reason: string;
  confidence: 'high' | 'medium' | 'low';
  current_status?: string;
  evidence_quote?: string;
  evidence_date?: string | null;
  recommended_action?: string;
  signals?: string[];
};
type ChurnInferencesSnap = { customers: ChurnInference[] };

// public/snapshots/churn_subpatterns.json — finer-grained tags within each parent reason cluster.
type ChurnSubpatternsSnap = {
  subpattern_definitions: Record<string, { label: string; parent: string; description: string }>;
  customer_subpatterns: Record<string, string[]>;
};

// public/snapshots/orders_verified.json — per-customer year-level verified
// order counts + invoice $. One record per customer keyed by allmoxy_customer_id.
// order_count is null for 2026 (source xlsx has $ only). See memory:
// 2026-order-counts-unavailable.
type OrdersVerifiedYear = {
  order_count: number | null;
  total_usd: number;
  subtotal_usd?: number;
  b2b_subtotal_usd?: number;
};
type OrdersVerifiedRecord = {
  allmoxy_customer_id: number;
  name: string;
  installer_id: string | null;
  subdomain: string | null;
  years: Record<string, OrdersVerifiedYear>;
  monthly_avg: Record<string, number>;
  monthly_supplement?: Record<string, number>;
  live_date: string | null;
  live_date_source: string | null;
  is_launched: boolean;
  months_to_launch: number | null;
  total_lifetime_orders: number;
  total_lifetime_usd: number;
  monthly_avg_current_year: number;
  monthly_avg_prior_year: number;
  monthly_avg_yoy_pct: number | null;
  latest_year_with_orders: string | null;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

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

const COMMITTED_ANNUAL_IDS = new Set<number>(annualPayersConfig.annual_payer_ids);
const PENDING_STORAGE_KEY = 'allmoxy.annual_payers.pending';
const BID_ONLY_STORAGE_KEY = 'allmoxy.bid_only.pending';

// Bid-only override store: aid → boolean. Used by the Customer Detail toggle
// to mark customers who use Allmoxy primarily for bids/quotes (not verified orders).
// Stored in localStorage until exported and committed to _etl_scripts/bid_only_customers.json.
type BidOnlyMap = Record<string, boolean>;
function readBidOnly(): BidOnlyMap {
  try { const raw = localStorage.getItem(BID_ONLY_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function writeBidOnly(next: BidOnlyMap) {
  try { localStorage.setItem(BID_ONLY_STORAGE_KEY, JSON.stringify(next)); } catch {}
}

type PendingMap = Record<string, boolean>; // id -> pending desired state

function readPending(): PendingMap {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function writePending(next: PendingMap) {
  try {
    localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — ignore
  }
}

// Churn-reason pending overrides: lets users update a customer's playbook reason + free-text
// evidence from this page. Stored in localStorage until an ETL pass folds the edits into
// the canonical customer_profiles.churn_reason / churn_inferences.json.
//
// Storage shape: aid → { reason, evidence, updatedAt }.
// `reason` is one of HUBSPOT_CHURN_PLAYBOOK options (or empty for "(no reason)").
// `evidence` is free-text — the CSM-style narrative or any quote.
const CHURN_OVERRIDE_STORAGE_KEY = 'allmoxy.churn_reason.pending';

type ChurnOverride = { reason: string; evidence: string; updatedAt: string };
type ChurnOverrideMap = Record<string, ChurnOverride>;

function readChurnOverrides(): ChurnOverrideMap {
  try {
    const raw = localStorage.getItem(CHURN_OVERRIDE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function writeChurnOverrides(next: ChurnOverrideMap) {
  try {
    localStorage.setItem(CHURN_OVERRIDE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable — ignore
  }
}

// HubSpot Churn Playbook taxonomy — keep aligned with ChurnPatterns.tsx INITIATIVES map.
const HUBSPOT_CHURN_PLAYBOOK = [
  'Failed Implementation',
  'Features',
  'Business Model Change',
  'Moved to Other Solution',
  'Paid and Never Used',
  'Out of Business',
  'Customer Stakeholder Misalignment',
  'Unresponsive',
  'Catalog Unidentified',
  'Ownership Transition',
  'Timing Not Right',
  'Pricing',
  'Payment Failure',
] as const;

function statusChipProps(status: CustomerProfile['status']) {
  if (status === 'active') return { label: 'Active', bgcolor: 'rgba(26, 158, 92, 0.18)', color: 'success.main' } as const;
  if (status === 'at_risk') return { label: 'At risk · dunning', bgcolor: 'rgba(245, 158, 11, 0.18)', color: 'warning.main' } as const;
  if (status === 'non_payment') return { label: 'Non-payment · missed a month', bgcolor: 'rgba(234, 88, 12, 0.20)', color: '#C2410C' } as const;
  if (status === 'never_paid') return { label: 'Never paid', bgcolor: 'rgba(139, 148, 158, 0.20)', color: 'text.secondary' } as const;
  return { label: 'Churned', bgcolor: 'rgba(218, 54, 51, 0.18)', color: 'error.main' } as const;
}

// Customer Detail is organized into tabs; each former section is a tab.
const CUST_TABS: Array<[string, string]> = [
  ['information', 'Information'],
  ['milestones', 'Milestones'],
  ['churn', 'Churn Risk'],
  ['revenue', 'Revenue'],
  ['usage', 'Usage Data'],
  ['renewal', 'Renewal'],
  ['implementation', 'Implementation'],
  ['contracts', 'Contracts'],
  ['transactions', 'Transactions'],
];

export default function CustomerDetail() {
  const { data } = useSheetTab('customer_profiles');
  // Churn classifications: AI inferences cover customers HubSpot has no recorded reason for;
  // sub-patterns tag finer-grained "why" within each reason cluster. Both are optional —
  // the page works without them, that section just won't render.
  const { data: inferencesData } = useSheetTab('churn_inferences');
  const { data: subpatternsData } = useSheetTab('churn_subpatterns');
  // Churn Risk Matrix scoring — surface the customer's 5-signal health score
  // here so the per-customer drill shows what the risk page sees.
  const { data: riskData } = useSheetTab('churn_risk_matrix');
  // Verified orders — per-customer year-level order counts + invoice $. Used
  // for the "Orders Verified Trends" chart under the monthly revenue timeline.
  const { data: ordersVerifiedData } = useSheetTab('orders_verified');
  // Renewal management — per-Instance renewal date, contract, cost-ratio
  // trend, action tag. One renewal row per HubSpot Instance; joined to this
  // customer via allmoxy_customer_id.
  const { data: renewalData } = useSheetTab('renewal_management');
  // Implementation — JIRA stage (IPA epic) + Harvest hours/billable $ for this
  // customer's services-revenue implementation project. One row per customer.
  const { data: implementationData } = useSheetTab('implementation');
  const snap = data as unknown as { rows: CustomerProfile[] } | undefined;
  const inferences = inferencesData as unknown as ChurnInferencesSnap | undefined;
  const subpatterns = subpatternsData as unknown as ChurnSubpatternsSnap | undefined;
  const risk = riskData as unknown as { customers: Array<{ allmoxy_customer_id: number; tier: string; total_score: number; signal_1_orders: number; signal_2_launch: number; signal_3_recency: number; signal_4_risk: number; signal_5_tenure: number; signal_6_pulse?: number; pulse_color?: 'green' | 'yellow' | 'red' | null; pulse_label?: string; pulse_detail?: string | null; orders_detail: string; signal_2_detail?: string; days_since_last_contact: number | null; launch_status: string; is_launched: boolean; live_date: string | null; orders_monthly_avg_current: number; orders_monthly_avg_prior: number; orders_yoy_pct: number | null; arr_at_risk: number; narrative: string; is_bid_only?: boolean }> } | undefined;

  const [pending, setPending] = useState<PendingMap>(() => readPending());
  const [bidOnlyMap, setBidOnlyMap] = useState<BidOnlyMap>(() => readBidOnly());
  // Pending churn-reason overrides — id → { reason, evidence, updatedAt }. Persists locally
  // until an ETL pass folds them into customer_profiles or churn_inferences. While pending,
  // the "Update" UI surfaces a "Pending" chip so the user knows it hasn't landed yet.
  const [churnOverrides, setChurnOverrides] = useState<ChurnOverrideMap>(() => readChurnOverrides());
  const [txnExpanded, setTxnExpanded] = useState(true);
  const [custTab, setCustTab] = useState('information');
  // Firmographics / classification is a heavy chip-wall — collapsed by default so
  // the Information tab leads with account, lifecycle, billing & identity.
  const [firmoOpen, setFirmoOpen] = useState(false);
  // Renewal panel — expanded by default. Reuses the same expansion content
  // from the Renewal Management page, surfaced inline on Customer Detail so
  // the renewal context is visible immediately on any customer view.
  const [renewalExpanded, setRenewalExpanded] = useState(true);
  const [searchParams] = useSearchParams();

  const customers = snap?.rows ?? [];

  // URL is the source of truth for which customer is shown — no separate state.
  // Effect-pair to mirror state ↔ URL had a race: the URL effect would re-read
  // a stale ?id and overwrite the user's pick before the state-effect could
  // push the new id back to the URL. Deriving directly from searchParams
  // eliminates the loop.
  const selected = useMemo<CustomerProfile | null>(() => {
    if (customers.length === 0) return null;
    const idParam = searchParams.get('id');
    if (idParam) {
      const id = Number(idParam);
      if (Number.isFinite(id)) {
        const found = customers.find((c) => c.allmoxy_customer_id === id);
        if (found) return found;
      }
    }
    const nameParam = searchParams.get('name');
    if (nameParam) {
      const target = nameParam.trim().toLowerCase();
      const found = customers.find((c) => (c.name ?? '').trim().toLowerCase() === target);
      if (found) return found;
    }
    return customers[0] ?? null;
  }, [customers, searchParams]);

  const chart = useMemo(() => {
    if (!selected) return [];
    return Object.entries(selected.monthly_history)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, subscription: v.subscription, services: v.services, connect: v.connect }));
  }, [selected]);

  const selectedIsCommittedAnnual = selected ? COMMITTED_ANNUAL_IDS.has(selected.allmoxy_customer_id) : false;
  const selectedPending = selected ? pending[String(selected.allmoxy_customer_id)] : undefined;
  const selectedIsAnnual = selectedPending != null ? selectedPending : selectedIsCommittedAnnual;
  const selectedIsPending = selectedPending != null && selectedPending !== selectedIsCommittedAnnual;

  // Aurora warehouse order data — authoritative cumulative TOTAL order count (the
  // meta xlsx carries $ only, no counts) + verified $ by month. Keyed by
  // allmoxy_customer_id. See sync_aurora.mjs.
  const { data: auroraData } = useSheetTab('aurora_orders');
  const auroraRec = useMemo(() => {
    if (!selected) return null;
    const rows = (auroraData as unknown as { by_customer?: Array<{ allmoxy_customer_id: number; total_orders: number | null; total_orders_asof: string | null }> } | undefined)?.by_customer ?? [];
    return rows.find((c) => c.allmoxy_customer_id === selected.allmoxy_customer_id) ?? null;
  }, [auroraData, selected]);

  function toggleAnnual(next: boolean) {
    if (!selected) return;
    const id = String(selected.allmoxy_customer_id);
    const updated = { ...pending };
    const committed = COMMITTED_ANNUAL_IDS.has(selected.allmoxy_customer_id);
    if (next === committed) delete updated[id];
    else updated[id] = next;
    setPending(updated);
    writePending(updated);
  }

  // Persist a churn-reason override for the selected customer. When `reason` and `evidence` are
  // both empty/blank, the override is cleared (revert to source data). Otherwise the entry is
  // stored with a fresh updatedAt timestamp.
  function setChurnOverride(reason: string, evidence: string) {
    if (!selected) return;
    const id = String(selected.allmoxy_customer_id);
    const updated = { ...churnOverrides };
    const trimmedReason = (reason || '').trim();
    const trimmedEvidence = (evidence || '').trim();
    if (!trimmedReason && !trimmedEvidence) {
      delete updated[id];
    } else {
      updated[id] = { reason: trimmedReason, evidence: trimmedEvidence, updatedAt: new Date().toISOString() };
    }
    setChurnOverrides(updated);
    writeChurnOverrides(updated);
  }

  const pendingEntries = Object.entries(pending);
  const pendingChurnEntries = Object.entries(churnOverrides);

  return (
    <Box>
      <PageHeader
        title={selected ? selected.name : 'Customer Detail'}
        subtitle={selected
          ? `Allmoxy ID ${selected.allmoxy_customer_id}${selected.primary_segment ? ` · ${selected.primary_segment}` : ''}${selected.installer_id ? ` · Installer ${selected.installer_id}` : ''}`
          : 'Pick a customer from the Customers page to see their full profile.'}
        actions={
          <Button component={RouterLink} to="/customers" size="small" variant="outlined" startIcon={<ArrowBackIcon />}>
            All Customers
          </Button>
        }
      />

      {pendingEntries.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>{pendingEntries.length}</strong> pending annual-payer change{pendingEntries.length === 1 ? '' : 's'} — ask Claude to rebuild snapshots to apply.{' '}
          {pendingEntries
            .map(([id, v]) => {
              const c = customers.find((x) => x.allmoxy_customer_id === Number(id));
              return `${c?.name ?? `ID ${id}`} → ${v ? 'annual' : 'not annual'}`;
            })
            .join(', ')}
        </Alert>
      )}

      {pendingChurnEntries.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <strong>{pendingChurnEntries.length}</strong> pending churn-reason override{pendingChurnEntries.length === 1 ? '' : 's'} — ask Claude to fold these into customer_profiles / churn_inferences to make them durable.{' '}
          {pendingChurnEntries
            .slice(0, 6)
            .map(([id, v]) => {
              const c = customers.find((x) => x.allmoxy_customer_id === Number(id));
              return `${c?.name ?? `ID ${id}`} → ${v.reason || '(no taxonomy)'}`;
            })
            .join('; ')}
          {pendingChurnEntries.length > 6 ? ` … (+${pendingChurnEntries.length - 6} more)` : ''}
        </Alert>
      )}

      {!selected ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            No customer selected. Head to the{' '}
            <Link component={RouterLink} to="/customers" underline="hover">Customers</Link>{' '}
            page, filter for the customer, and click their name to open their detail here.
          </Typography>
        </Paper>
      ) : (
        <>
          {/* Metric cards — pinned under the customer name, above the tabs.
              Flex row: the five cards grow equally to fill the full width and
              stretch to equal height, so the bottom-aligned numbers line up. */}
          <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
            <Box sx={{ flex: '1 1 150px' }}>
              <StatCard label="Lifetime revenue" value={USD0.format(selected.lifetime_total)} hint="All streams combined" info={<><strong>What it is:</strong> Total succeeded Stripe revenue from this customer across their entire relationship — subscription + services + connect + other.<br /><br /><strong>Data:</strong> Sum of all succeeded Stripe charges from the Stripe Sync tab, aggregated per customer.</>} />
            </Box>
            <Box sx={{ flex: '1 1 150px' }}>
              <StatCard label="Lifetime subscription" value={USD0.format(selected.lifetime_subscription)} hint={`${((selected.lifetime_subscription / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`} info={<><strong>What it is:</strong> Total subscription dollars this customer has paid.<br /><br /><strong>Data:</strong> Succeeded Stripe charges where transaction_type = "subscription".</>} />
            </Box>
            <Box sx={{ flex: '1 1 150px' }}>
              <StatCard label="Lifetime services" value={USD0.format(selected.lifetime_services)} hint={`${((selected.lifetime_services / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`} info={<><strong>What it is:</strong> Total services/project dollars this customer has paid.<br /><br /><strong>Data:</strong> Succeeded Stripe charges where transaction_type = "services".</>} />
            </Box>
            <Box sx={{ flex: '1 1 150px' }}>
              <StatCard label="Lifetime Connect fees" value={USD0.format(selected.lifetime_connect)} hint={`${((selected.lifetime_connect / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`} info={<><strong>What it is:</strong> Total affiliate/connect fees Allmoxy has earned from this customer's Stripe Connect transactions.<br /><br /><strong>Data:</strong> Sum of per-month fees from the 2024/2025/2026 Stripe Connect Revenue sheets, matched by customer name.</>} />
            </Box>
            <Box sx={{ flex: '1 1 150px' }}>
              <StatCard label={`${monthLabel(selected.latest_month)} MRR`} value={USD0.format(selected.current_subscription_mrr)} hint={selected.current_subscription_mrr > 0 ? 'Currently paying' : 'Not paying this month'} info={<><strong>What it is:</strong> This customer's subscription MRR in the latest complete month.<br /><br /><strong>Data:</strong> Looked up in the MRR by Month tab for the reference month shown.</>} />
            </Box>
            <Box sx={{ flex: '1 1 150px' }}>
              <StatCard label="Total orders" value={auroraRec?.total_orders != null ? auroraRec.total_orders.toLocaleString() : '—'} hint={auroraRec?.total_orders_asof ? `lifetime · as of ${formatDateMDY(auroraRec.total_orders_asof)}` : 'lifetime cumulative'} info={<><strong>What it is:</strong> Cumulative count of all orders this customer has ever placed in Allmoxy.<br /><br /><strong>Data:</strong> Live from the Aurora warehouse (<code>instance_total_orders</code>), mapped by installer&nbsp;ID. This is the authoritative order count — the meta spreadsheet carries dollars only.</>} />
            </Box>
          </Stack>

          {/* Section tabs — each former section is a tab. */}
          <Tabs value={custTab} onChange={(_, v) => setCustTab(v)} variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
            {CUST_TABS.map(([v, l]) => {
              // For churned customers the churn tab becomes a full post-mortem summary.
              const label = v === 'churn' && selected.status === 'churned' ? 'Churn Summary' : l;
              return <Tab key={v} value={v} label={label} sx={{ textTransform: 'none', minHeight: 44 }} />;
            })}
          </Tabs>

          {/* Information tab — identity + firmographics */}
          {custTab === 'information' && (
          <Box>
            {/* Status chip above the section grid */}
            <Box sx={{ mb: 2 }}>
              <Chip label={statusChipProps(selected.status).label} sx={{ bgcolor: statusChipProps(selected.status).bgcolor, color: statusChipProps(selected.status).color, fontWeight: 500 }} />
            </Box>

            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, alignItems: 'start' }}>
              {/* Account — who owns them + where they stand. The first thing you want. */}
              <InfoSection title="Account" info="From the HubSpot Instance Sync. Firmographic segment lives under Classification below.">
                <InfoField label="Account rep" value={selected.instance_owner_first_name?.trim() || selected.instance_owner?.trim() || selected.hubspot_owner_name?.trim() || '—'} />
                <InfoField label="Pay status" value={selected.pay_status || '—'} />
                <InfoField label="Contract" value={selected.contract_status || '—'} />
                <InfoField label="Cohort" value={selected.cohort_year != null ? String(selected.cohort_year) : '—'} />
              </InfoSection>

              <InfoSection title="Lifecycle">
                <InfoField label="Signed up" value={formatDateMDY(selected.sign_up_date)} />
                <InfoField label="First payment" value={formatDateMDY(selected.first_payment_date)} />
                <InfoField label="Last payment" value={formatDateMDY(selected.last_payment_date)} />
                <InfoField label="Tenure" value={selected.years_with_us != null ? `${selected.years_with_us.toFixed(1)} yrs` : '—'} />
              </InfoSection>

              {/* Billing & health — money, order volume, payment risk, annual toggle */}
              <InfoSection title="Billing & health" wide>
                <InfoField label="Transactions" value={selected.transaction_count.toLocaleString()} />
                <InfoField label="Total orders" value={auroraRec?.total_orders != null ? auroraRec.total_orders.toLocaleString() : '—'} hint={auroraRec?.total_orders_asof ? `lifetime · as of ${formatDateMDY(auroraRec.total_orders_asof)}` : undefined} />
                <InfoField label="Stripe fee %" value={selected.stripe_fee_percent != null ? `${selected.stripe_fee_percent.toFixed(2)}%` : '—'} />
                {selected.failed_3mo_count > 0 && (
                  <InfoField label="Failed charges · last 3 mo" value={<Box component="span" sx={{ color: 'error.main', fontWeight: 600 }}>⚠ {selected.failed_3mo_count} · {USD0.format(selected.failed_3mo_amount)}</Box>} />
                )}
                <Box>
                  <FieldLabel>Annual payer</FieldLabel>
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.25 }}>
                    <Switch size="small" sx={{ ml: -0.5 }} checked={selectedIsAnnual} onChange={(_, v) => toggleAnnual(v)} />
                    {selectedIsAnnual && <Chip label={selectedIsPending ? 'pending' : 'amortized'} size="small" sx={{ height: 18, fontSize: 10, bgcolor: selectedIsPending ? 'rgba(245,158,11,0.18)' : 'rgba(44,115,255,0.18)', color: selectedIsPending ? 'warning.main' : 'primary.main' }} />}
                    <InfoIcon info={<><strong>What it does:</strong> Flags this customer as paying annually upfront — the snapshot builder amortizes the annual payment as amount/12 across 12 months so monthly MRR doesn't spike.<br /><br /><strong>Pending changes</strong> live in your browser until Claude rebuilds snapshots.</>} />
                  </Stack>
                </Box>
              </InfoSection>

              {/* Identity & links — demoted plumbing: IDs + external system links */}
              <InfoSection title="Identity & links" wide info="Where to find this customer in other systems.">
                <InfoField label="Allmoxy ID" value={selected.allmoxy_customer_id} />
                {selected.installer_id && <InfoField label="Installer ID" value={selected.installer_id} />}
                {selected.installer_directory && <ExternalLink label="Allmoxy URL" display={`${selected.installer_directory}.allmoxy.com`} href={`https://${selected.installer_directory}.allmoxy.com`} />}
                {selected.hubspot_company_id && <ExternalLink label="HubSpot ID" display={selected.hubspot_company_id} href={hubspotCompanyUrl(selected.hubspot_company_id) ?? '#'} />}
                {selected.stripe_customer_ids[0] && <ExternalLink label="Stripe Customer" display={selected.stripe_customer_ids[0]} href={`https://dashboard.stripe.com/customers/${selected.stripe_customer_ids[0]}`} />}
                {(() => {
                  const customDomainSet = new Set(selected.all_custom_domain_stripe_subscription_ids ?? []);
                  if (selected.custom_domain_stripe_subscription_id) customDomainSet.add(selected.custom_domain_stripe_subscription_id);
                  const allSubsList = [...new Set([
                    ...(selected.all_stripe_subscription_ids ?? []),
                    ...(selected.stripe_subscription_id ? [selected.stripe_subscription_id] : []),
                    ...customDomainSet,
                  ])];
                  return allSubsList.map((subId, i) => {
                    const isCustomDomain = customDomainSet.has(subId);
                    const isPrimary = subId === selected.stripe_subscription_id && !isCustomDomain;
                    const lbl = isCustomDomain
                      ? `Custom Domain Sub${customDomainSet.size > 1 ? ` ${[...customDomainSet].indexOf(subId) + 1}` : ''}`
                      : isPrimary ? 'Stripe Subscription' : `Stripe Sub ${i + 1}`;
                    return <ExternalLink key={subId} label={lbl} display={subId} href={`https://dashboard.stripe.com/subscriptions/${subId}`} emphasize={isCustomDomain} />;
                  });
                })()}
              </InfoSection>

              {/* Who they are — firmographics / classification from the HubSpot
                  Company object. Heavy chip-wall, so collapsed by default behind a
                  toggle. Renders only when HubSpot firmographics are present. */}
              {(() => {
                const f = selected.firmographics;
                if (!f) return null;
                const hasAny = f.components_manufactured.length || f.revenue_band || f.annual_revenue != null
                  || f.employee_band || f.headcount != null || f.geographic_scope || f.city || f.ownership_type
                  || f.founded_year || f.business_model.length || f.end_customer_type.length || f.end_market.length
                  || f.software.accounting.length || f.software.cam.length || f.software.design_3d.length || f.software.crm.length || f.software.other.length
                  || (f.product && (f.product.customization_tier || f.product.construction_methods.length || f.product.assembly_model.length || f.product.installation_model.length || f.product.technology_profile.length));
                if (!hasAny) return null;
                const location = [f.city, f.state, f.country].filter(Boolean).join(', ');
                const sw: Array<[string, string[]]> = [['Accounting', f.software.accounting], ['CAM', f.software.cam], ['3D Design', f.software.design_3d], ['CRM', f.software.crm], ['Other', f.software.other]];
                return (
                  <Box sx={{ gridColumn: '1 / -1' }}>
                    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
                      <Box
                        role="button"
                        tabIndex={0}
                        onClick={() => setFirmoOpen((o) => !o)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFirmoOpen((o) => !o); } }}
                        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
                      >
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <Box sx={{ width: 3, height: 15, borderRadius: 1, bgcolor: 'primary.main', flexShrink: 0 }} />
                          <Typography variant="subtitle2" sx={{ fontWeight: 700, fontSize: 13, color: 'text.primary' }}>Firmographics &amp; classification</Typography>
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: { xs: 'none', sm: 'block' } }}>· what they make, software stack, size, who they serve</Typography>
                          <InfoIcon info={<><strong>Firmographic + classification</strong> profile from the HubSpot Company object — what they make, their software stack, size, geography, ownership, and who they sell to. Blank fields just aren't filled in HubSpot yet.</>} />
                        </Stack>
                        <ExpandMoreIcon sx={{ transform: firmoOpen ? 'rotate(180deg)' : 'none', transition: 'transform .2s', color: 'text.secondary' }} />
                      </Box>
                      <Collapse in={firmoOpen} unmountOnExit>
                        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, p: 2, pt: 0, alignItems: 'start' }}>
                          <InfoSection title="Classification">
                            <InfoField label="Primary segment" value={selected.primary_segment || '—'} />
                            <InfoField label="Sub-segment" value={selected.sub_segment || '—'} />
                            <Box sx={{ maxWidth: 300 }}><InfoField label="Components manufactured" value={<ChipList items={f.components_manufactured} />} /></Box>
                          </InfoSection>

                          <InfoSection title="Current software stack">
                            {sw.map(([name, vals]) => (
                              <Box sx={{ maxWidth: 220 }} key={name}><InfoField label={name} value={<ChipList items={vals} color="#7C5CFF" />} /></Box>
                            ))}
                          </InfoSection>

                          <InfoSection title="Firmographics" wide>
                            <InfoField label="Revenue band" value={f.revenue_band || '—'} hint={f.annual_revenue != null ? `${USD_COMPACT.format(f.annual_revenue)} annual` : undefined} />
                            <InfoField label="Employees" value={f.employee_band || '—'} hint={f.headcount != null ? `${f.headcount.toLocaleString()} headcount` : undefined} />
                            <InfoField label="Geographic scope" value={f.geographic_scope || '—'} hint={location || undefined} />
                            <InfoField label="Ownership" value={f.ownership_type || '—'} hint={f.founded_year ? `Founded ${f.founded_year}` : undefined} />
                            <Box sx={{ maxWidth: 240 }}><InfoField label="Business model" value={<ChipList items={f.business_model} color="#1A9E5C" />} /></Box>
                          </InfoSection>

                          <InfoSection title="Who they serve" wide>
                            <Box sx={{ maxWidth: 340 }}><InfoField label="End customer type" value={<ChipList items={f.end_customer_type} color="#F5A623" />} /></Box>
                            <Box sx={{ maxWidth: 340 }}><InfoField label="End markets" value={<ChipList items={f.end_market} color="#F5A623" />} /></Box>
                          </InfoSection>

                          {f.product && (
                            <InfoSection title="Product offering" wide info="The product itself — what they make, how it's built, and how it arrives ready for the customer.">
                              <InfoField label="Customization tier" value={f.product.customization_tier || '—'} />
                              <Box sx={{ maxWidth: 300 }}><InfoField label="Construction methods" value={<ChipList items={f.product.construction_methods} color="#7C5CFF" />} /></Box>
                              <Box sx={{ maxWidth: 260 }}><InfoField label="Assembly model" value={<ChipList items={f.product.assembly_model} color="#7C5CFF" />} /></Box>
                              <Box sx={{ maxWidth: 260 }}><InfoField label="Installation model" value={<ChipList items={f.product.installation_model} color="#7C5CFF" />} /></Box>
                              <Box sx={{ maxWidth: 340 }}><InfoField label="Technology profile" value={<ChipList items={f.product.technology_profile} color="#2C73FF" />} /></Box>
                            </InfoSection>
                          )}
                        </Box>
                      </Collapse>
                    </Paper>
                  </Box>
                );
              })()}
            </Box>
          </Box>
          )}

          {/* Churn Summary — a full post-mortem shown only for churned customers.
              Composes the existing ChurnAnalysisCard (the "why") with churn-specific
              stat cards, supporting InfoSection facts, and the revenue-decline chart. */}
          {custTab === 'churn' && selected.status === 'churned' && (() => {
            const customerKey = String(selected.allmoxy_customer_id);
            const inf = inferences?.customers.find((c) => c.allmoxy_customer_id === selected.allmoxy_customer_id) ?? null;
            const subTags = subpatterns?.customer_subpatterns?.[customerKey] ?? [];
            const subDefs = subpatterns?.subpattern_definitions ?? {};
            const override = churnOverrides[customerKey];
            // Effective reason picks: override > HubSpot > AI inference > none.
            const baseReason = (selected.churn_reason ?? '').trim();
            const effectiveReason = override?.reason || baseReason || inf?.suggested_reason || '';
            const effectiveEvidence = override?.evidence || inf?.evidence_quote || '';
            const reasonSource: 'override' | 'hubspot' | 'ai' | 'none' = override?.reason
              ? 'override' : baseReason ? 'hubspot' : inf?.suggested_reason ? 'ai' : 'none';
            // Active tenure = signup → last payment (their real lifespan), not to today.
            const su = selected.sign_up_date ? new Date(selected.sign_up_date) : null;
            const lp = selected.last_payment_date ? new Date(selected.last_payment_date) : null;
            const tenureYrs = su && lp && !isNaN(su.getTime()) && !isNaN(lp.getTime())
              ? (lp.getTime() - su.getTime()) / (365.25 * 864e5) : selected.years_with_us;
            const pct = (v: number) => `${((v / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`;
            const statCards: Array<[string, string | null, string]> = [
              ['Churned', formatDateMDY(selected.last_payment_date), 'last payment received'],
              ['Lifetime value', USD0.format(selected.lifetime_total), 'all streams combined'],
              ['Active tenure', tenureYrs != null ? `${tenureYrs.toFixed(1)} yrs` : '—', 'signup → last payment'],
              ['Cohort', selected.cohort_year != null ? String(selected.cohort_year) : '—', 'signup year'],
              ['Peak month', selected.peak_month_total != null ? USD0.format(selected.peak_month_total) : '—', selected.peak_month ? monthLabel(selected.peak_month) : ''],
            ];
            return (
              <Box>
                {/* Churn-specific headline stats */}
                <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
                  {statCards.map(([label, value, hint]) => (
                    <Box key={label} sx={{ flex: '1 1 150px' }}><StatCard label={label} value={value} hint={hint} /></Box>
                  ))}
                </Stack>

                {/* Why they churned — the existing reason analysis card (source, evidence, sub-patterns, editable) */}
                <ChurnAnalysisCard
                  selected={selected}
                  inference={inf}
                  subTags={subTags}
                  subDefs={subDefs}
                  override={override}
                  effectiveReason={effectiveReason}
                  effectiveEvidence={effectiveEvidence}
                  reasonSource={reasonSource}
                  onSave={setChurnOverride}
                />

                {/* Supporting facts */}
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, alignItems: 'start', mt: 2 }}>
                  <InfoSection title="Lifecycle">
                    <InfoField label="Signed up" value={formatDateMDY(selected.sign_up_date)} />
                    <InfoField label="First payment" value={formatDateMDY(selected.first_payment_date)} />
                    <InfoField label="Last payment" value={formatDateMDY(selected.last_payment_date)} />
                    <InfoField label="Active tenure" value={tenureYrs != null ? `${tenureYrs.toFixed(1)} yrs` : '—'} />
                    <InfoField label="Cohort" value={selected.cohort_year != null ? String(selected.cohort_year) : '—'} />
                  </InfoSection>
                  <InfoSection title="Value at churn">
                    <InfoField label="Lifetime total" value={USD0.format(selected.lifetime_total)} />
                    <InfoField label="Subscription" value={USD0.format(selected.lifetime_subscription)} hint={pct(selected.lifetime_subscription)} />
                    <InfoField label="Services" value={USD0.format(selected.lifetime_services)} hint={pct(selected.lifetime_services)} />
                    <InfoField label="Connect" value={USD0.format(selected.lifetime_connect)} hint={pct(selected.lifetime_connect)} />
                    <InfoField label="Peak month" value={selected.peak_month_total != null ? USD0.format(selected.peak_month_total) : '—'} hint={selected.peak_month ? monthLabel(selected.peak_month) : undefined} />
                    <InfoField label="Transactions" value={selected.transaction_count.toLocaleString()} />
                  </InfoSection>
                  <InfoSection title="Account context" wide>
                    <InfoField label="Account rep" value={selected.instance_owner_first_name?.trim() || selected.instance_owner?.trim() || '—'} />
                    <InfoField label="Segment" value={selected.primary_segment || '—'} />
                    <InfoField label="Sub-segment" value={selected.sub_segment || '—'} />
                    <InfoField label="Pay status" value={selected.pay_status || '—'} />
                    <InfoField label="Contract" value={selected.contract_status || '—'} />
                    {selected.customer_health_cs_pulse && <InfoField label="CS health pulse" value={selected.customer_health_cs_pulse} />}
                    {selected.notes_last_contacted && <InfoField label="Last contacted" value={formatDateMDY(selected.notes_last_contacted)} />}
                    {selected.vip_legacy_customer && <InfoField label="VIP / legacy" value={selected.vip_legacy_customer} />}
                  </InfoSection>
                </Box>

                {/* Revenue history — where it wound down */}
                <Paper sx={{ p: 3, mt: 2 }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                    <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Revenue history — where it wound down</Typography>
                    <InfoIcon info="Monthly revenue by stream across the customer's lifetime. The drop-off shows when and how their spend tapered before churn." />
                  </Stack>
                  {chart.length === 0 ? (
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>No monthly revenue history.</Typography>
                  ) : (
                    <Box sx={{ height: 240 }}>
                      <ResponsiveContainer>
                        <BarChart data={chart}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                          <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                          <YAxis stroke="#8B949E" fontSize={11} width={60} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                          <RTooltip labelFormatter={(v) => monthLabelLong(String(v))} formatter={(v: number, name: string) => [USD0.format(v), name]} contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }} cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }} />
                          <Bar name="Subscription" dataKey="subscription" stackId="rev" fill="#2C73FF" />
                          <Bar name="Services" dataKey="services" stackId="rev" fill="#1A9E5C" />
                          <Bar name="Connect" dataKey="connect" stackId="rev" fill="#F59E0B" />
                        </BarChart>
                      </ResponsiveContainer>
                    </Box>
                  )}
                  <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                    <LegendSwatch color="#2C73FF" label="Subscription" />
                    <LegendSwatch color="#1A9E5C" label="Services" />
                    <LegendSwatch color="#F59E0B" label="Connect" />
                  </Stack>
                </Paper>
              </Box>
            );
          })()}

          {/* Milestones tab — full-width timeline. */}
          {custTab === 'milestones' && (
          <Paper sx={{ p: 3, mb: 3 }}>
            <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 2 }}>
              Milestones
            </Typography>
            <MilestoneTimeline
              events={([
                { label: 'Signed up', date: selected.sign_up_date },
                { label: 'First payment', date: selected.first_payment_date },
                selected.peak_month
                  ? {
                      label: 'Peak month',
                      date: `${selected.peak_month}-01`,
                      subtitle: monthLabelLong(selected.peak_month),
                      detail: USD0.format(selected.peak_month_total),
                      accent: true,
                    }
                  : null,
                { label: 'Last payment', date: selected.last_payment_date },
              ] as Array<MilestoneEvent | null>).filter((e): e is MilestoneEvent => e != null)}
            />
          </Paper>
          )}

          {/* Implementation — surfaced high (right under the revenue/MRR stats)
              because the implementation project is a critical part of the
              initial onboarding. This customer's services-revenue implementation
              project: JIRA stage (IPA epic) + Harvest hours / billable $.
              Sourced from the implementation snapshot, keyed by
              allmoxy_customer_id. Hidden when the customer has no implementation
              activity in either system. */}
          {custTab === 'implementation' && (() => {
            const implSnap = implementationData as unknown as { rows: Array<{
              allmoxy_customer_id: number; has_jira: boolean; has_harvest: boolean;
              jira_key: string | null; jira_url: string | null; stage: string | null;
              assignee: string | null; harvest_project_name: string | null;
              billing_method: string | null; hourly_rate: number | null;
              hours: number; billable_hours: number; billable_amount: number;
              last_entry: string | null; is_active: boolean;
              launch_status: 'pre_launch' | 'launched' | 'unknown';
              implementation_type: string; first_order_year: number | null;
              time_to_first_order_months: number | null; ttv_category: string | null;
              task_count: number; tasks_done: number;
              tasks: Array<{ key: string; summary: string; status: string | null; stage_category: string | null; assignee: string | null; created: string | null; due: string | null; url: string }>;
            }> } | undefined;
            const impl = implSnap?.rows?.find((r) => r.allmoxy_customer_id === selected.allmoxy_customer_id);
            if (!impl) return null;
            const stageColor = !impl.stage ? '#8B949E'
              : /discovery/i.test(impl.stage) ? '#2C73FF'
              : /prototyp/i.test(impl.stage) ? '#7C5CFF'
              : /waiting/i.test(impl.stage) ? '#F5A623'
              : /done/i.test(impl.stage) ? '#1A9E5C'
              : /hold|abandon/i.test(impl.stage) ? '#8B949E' : '#2C73FF';
            // Live time-to-first-order clock from sign-up; 90-day target.
            const signupDays = selected.sign_up_date ? Math.floor((Date.now() - new Date(selected.sign_up_date).getTime()) / 86400000) : null;
            const slaColor = signupDays == null ? '#8B949E' : signupDays > 90 ? '#D63A4D' : signupDays >= 60 ? '#F5A623' : '#1A9E5C';
            const typeColor = impl.implementation_type === 'Initial implementation' ? '#2C73FF' : '#8B949E';
            // Ticket list: active work first (In Progress → To Do → other → Done), newest first within.
            const catColor = (c: string | null) => c === 'Done' ? '#1A9E5C' : c === 'In Progress' ? '#2C73FF' : c === 'To Do' ? '#8B949E' : '#F5A623';
            const catRank = (c: string | null) => c === 'In Progress' ? 0 : c === 'To Do' ? 1 : c === 'Done' ? 3 : 2;
            const sortedTasks = [...(impl.tasks ?? [])].sort((a, b) => catRank(a.stage_category) - catRank(b.stage_category) || (b.created ?? '').localeCompare(a.created ?? ''));
            return (
              <Paper sx={{ p: 3, mb: 3 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                  <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Implementation</Typography>
                  <InfoIcon info={<><strong>What it is:</strong> This customer's implementation project — services revenue. The team's goal is <strong>time to first order</strong>: customers with no first verified live order are in <strong>initial implementation</strong>; launched customers are doing <strong>catalog updates</strong>. <strong>Stage</strong> from JIRA, <strong>hours/$</strong> from Harvest.<br /><br />Manage the work on the <a href="/implementation" style={{ color: '#2C73FF' }}>Implementation Overview</a>.</>} />
                  <Chip label={impl.implementation_type === 'Initial implementation' ? 'Initial implementation' : impl.implementation_type === 'Catalog update' ? 'Catalog update' : 'Unknown launch'} size="small" sx={{ height: 18, fontSize: 10, fontWeight: 600, bgcolor: typeColor + '22', color: typeColor }} />
                  {impl.is_active
                    ? <Chip label="Active" size="small" sx={{ height: 18, fontSize: 10, fontWeight: 600, bgcolor: 'rgba(26,158,92,0.18)', color: '#1A9E5C' }} />
                    : <Chip label="Inactive" size="small" sx={{ height: 18, fontSize: 10, bgcolor: 'rgba(139,148,158,0.18)', color: '#8B949E' }} />}
                  {impl.ttv_category === 'gym_member' && <Chip label="Stalled · never launched" size="small" sx={{ height: 18, fontSize: 10, fontWeight: 600, bgcolor: 'rgba(245,166,35,0.18)', color: '#B07206' }} />}
                </Stack>

                {/* Time-to-first-order banner — the headline for this customer. */}
                <Box sx={{ mb: 2, p: 1.5, borderRadius: 1, bgcolor: 'action.hover', display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'baseline' }}>
                  <Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>Signed up</Typography>
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>{selected.sign_up_date ? selected.sign_up_date.slice(0, 10) : '—'}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>First order (value)</Typography>
                    {impl.launch_status === 'launched' ? (
                      <Typography variant="body2" sx={{ fontWeight: 600, color: '#1A9E5C' }}>
                        {impl.first_order_year ? `Live ${impl.first_order_year}` : 'Launched'}{impl.time_to_first_order_months != null ? ` · ~${impl.time_to_first_order_months}mo to first order` : ''}
                      </Typography>
                    ) : impl.launch_status === 'pre_launch' ? (
                      <Typography variant="body2" sx={{ fontWeight: 600, color: slaColor }}>
                        No first order yet{signupDays != null ? ` · ${signupDays}d since sign-up` : ''}{signupDays != null && signupDays > 90 ? ' · overdue (>90d)' : ''}
                      </Typography>
                    ) : <Typography variant="body2" sx={{ color: 'text.disabled' }}>Unknown launch status</Typography>}
                  </Box>
                </Box>
                <Grid container spacing={3}>
                  <Grid item xs={6} sm={3}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>Stage</Typography>
                    <Box sx={{ mt: 0.5 }}>
                      {impl.stage ? <Chip label={impl.stage} size="small" sx={{ height: 22, fontSize: 11, fontWeight: 600, bgcolor: stageColor + '22', color: stageColor }} />
                        : <Typography variant="body2" sx={{ color: 'text.disabled' }}>No JIRA epic</Typography>}
                    </Box>
                    {impl.assignee && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>Owner: {impl.assignee}</Typography>}
                  </Grid>
                  <Grid item xs={6} sm={3}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>Hours logged</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{impl.has_harvest ? impl.hours.toLocaleString() : '—'}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{impl.has_harvest ? `${impl.billable_hours.toLocaleString()} billable` : 'no Harvest project'}</Typography>
                  </Grid>
                  <Grid item xs={6} sm={3}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>Billable services $</Typography>
                    <Typography variant="h6" sx={{ fontWeight: 500, color: 'success.main', fontVariantNumeric: 'tabular-nums' }}>{impl.has_harvest ? USD0.format(impl.billable_amount) : '—'}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{impl.billing_method || '—'}{impl.billing_method === 'Hourly' && impl.hourly_rate ? ` @ $${impl.hourly_rate}/hr` : ''}</Typography>
                  </Grid>
                  <Grid item xs={6} sm={3}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 }}>Last activity</Typography>
                    <Typography variant="body1" sx={{ mt: 0.5 }}>{impl.last_entry || '—'}</Typography>
                    {impl.jira_url && <Box component="a" href={impl.jira_url} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 12, color: 'primary.light', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>{impl.jira_key} in JIRA ↗</Box>}
                  </Grid>
                </Grid>

                {/* Implementation tickets — every JIRA item under this customer's
                    epic, active work first. */}
                {sortedTasks.length > 0 && (
                  <Box sx={{ mt: 3 }}>
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5 }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, fontWeight: 600 }}>
                        Implementation tickets ({sortedTasks.length}{impl.tasks_done ? ` · ${impl.tasks_done} done` : ''})
                      </Typography>
                      <InfoIcon info="Every JIRA ticket under this customer's implementation epic, active items first. Click a ticket to open it in JIRA. Schedule these on the Implementation → Schedule Gantt." />
                    </Stack>
                    <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', '& th, & td': { py: 0.5, fontSize: 12, textAlign: 'left', borderBottom: '1px solid', borderColor: 'divider', verticalAlign: 'top' }, '& th': { fontWeight: 600, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 } }}>
                      <thead>
                        <tr>
                          <th>Ticket</th>
                          <th>Status</th>
                          <th>Owner</th>
                          <th>Created</th>
                          <th>Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTasks.map((t) => (
                          <tr key={t.key}>
                            <td>
                              <Box component="a" href={t.url} target="_blank" rel="noopener noreferrer" sx={{ color: 'text.primary', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                                {t.summary || t.key}
                              </Box>
                              <Typography component="span" variant="caption" sx={{ color: 'text.disabled', ml: 0.5 }}>{t.key}</Typography>
                            </td>
                            <td>
                              <Chip label={t.status || '—'} size="small" sx={{ height: 18, fontSize: 10, fontWeight: 600, bgcolor: catColor(t.stage_category) + '22', color: catColor(t.stage_category) }} />
                            </td>
                            <td style={{ color: '#8B949E' }}>{t.assignee || '—'}</td>
                            <td style={{ color: '#6B7280' }}>{t.created || '—'}</td>
                            <td style={{ color: t.due ? '#6B7280' : '#484F58' }}>{t.due || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Box>
                  </Box>
                )}
              </Paper>
            );
          })()}

          {/* Churn Risk Health Score */}
          {custTab === 'churn' && (() => {
            const riskEntry = risk?.customers?.find((r) => r.allmoxy_customer_id === selected.allmoxy_customer_id);
            if (!riskEntry) return null;
            // Bid-only override (from localStorage) takes precedence over snapshot data.
            // If on, we visually pretend Signals 1 + 2 are maxed (the ETL applies the
            // same logic, but we want immediate visual feedback before the next refresh).
            const aidKey = String(selected.allmoxy_customer_id);
            const localBidOnly = bidOnlyMap[aidKey];
            const isBidOnly = localBidOnly !== undefined ? localBidOnly : !!riskEntry.is_bid_only;
            const persistedBidOnly = !!riskEntry.is_bid_only;
            const bidOnlyPending = localBidOnly !== undefined && localBidOnly !== persistedBidOnly;
            // Synthesize tier when local override differs from snapshot
            const effectiveScore = isBidOnly && !persistedBidOnly
              ? riskEntry.total_score + (35 - riskEntry.signal_1_orders) + (25 - riskEntry.signal_2_launch)
              : riskEntry.total_score;
            const effectiveTier = isBidOnly && !persistedBidOnly && effectiveScore >= 40 ? 'green'
              : (isBidOnly && !persistedBidOnly ? 'yellow' : riskEntry.tier);
            const tierColor = effectiveTier === 'red' ? '#D63A4D' : effectiveTier === 'yellow' ? '#F5A623' : effectiveTier === 'green' ? '#1A9E5C' : '#94a3b8';
            const tierLabel = effectiveTier === 'red' ? 'CRITICAL' : effectiveTier === 'yellow' ? 'WATCH' : effectiveTier === 'green' ? 'HEALTHY' : 'UNSCORED';
            return (
              <Paper sx={{ p: 3, mb: 3 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap">
                  <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                    Churn Risk · Health Score
                  </Typography>
                  <Box sx={{ flexGrow: 1 }} />
                  <FormControlLabel
                    control={
                      <Switch
                        size="small"
                        checked={isBidOnly}
                        onChange={(e) => {
                          const next = { ...bidOnlyMap };
                          if (e.target.checked === persistedBidOnly) {
                            // matches snapshot — clear local override
                            delete next[aidKey];
                          } else {
                            next[aidKey] = e.target.checked;
                          }
                          setBidOnlyMap(next);
                          writeBidOnly(next);
                        }}
                      />
                    }
                    label={
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography variant="caption" sx={{ fontSize: 12 }}>Bid-only customer</Typography>
                        {bidOnlyPending && (
                          <Chip label="pending" size="small" color="warning" sx={{ height: 16, fontSize: 9 }} />
                        )}
                        <InfoIcon info={
                          <>
                            Mark customers who use Allmoxy primarily for <strong>bids/quotes</strong> that never convert to verified orders.
                            They're real paying customers — the order-volume signal just doesn't apply.<br /><br />
                            When ON: Signal 1 (Order Volume) and Signal 2 (Launch Status) are treated as MAX (+60 pts combined), so they aren't penalized for missing order data.
                            Other signals (engagement recency, risk keywords, tenure) still apply.<br /><br />
                            Stored in localStorage until you export the pending overrides and commit to <code>_etl_scripts/bid_only_customers.json</code>.
                          </>
                        } />
                      </Stack>
                    }
                  />
                </Stack>
                <Grid container spacing={2}>
                  <Grid item xs={12} sm={4} md={3}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Tier</Typography>
                    <Typography variant="h4" sx={{ fontWeight: 600, color: tierColor, mt: 0.5 }}>{tierLabel}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      Score: {riskEntry.total_score} · ARR at risk: {USD0.format(riskEntry.arr_at_risk)}
                    </Typography>
                  </Grid>
                  <Grid item xs={12} sm={8} md={9}>
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Signal breakdown</Typography>
                      <HealthScoreInfo />
                    </Stack>
                    <Box component="table" sx={{ mt: 0.5, width: '100%', borderCollapse: 'collapse', '& td, & th': { borderBottom: '1px solid', borderColor: 'divider', py: 0.5, fontSize: 12, textAlign: 'left' } }}>
                      <tbody>
                        <tr><td>1 · Order Volume</td><td style={{ color: '#6B7280' }}>{riskEntry.orders_detail}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{riskEntry.signal_1_orders >= 0 ? '+' : ''}{riskEntry.signal_1_orders}</td></tr>
                        <tr><td>2 · Launch Status</td><td style={{ color: '#6B7280' }}>{riskEntry.signal_2_detail || riskEntry.launch_status}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{riskEntry.signal_2_launch >= 0 ? '+' : ''}{riskEntry.signal_2_launch}</td></tr>
                        <tr><td>3 · Engagement Recency</td><td style={{ color: '#6B7280' }}>{riskEntry.days_since_last_contact != null ? `${riskEntry.days_since_last_contact}d since last contact` : 'No HubSpot recency data'}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{riskEntry.signal_3_recency >= 0 ? '+' : ''}{riskEntry.signal_3_recency}</td></tr>
                        <tr><td>4 · Risk Signals</td><td style={{ color: '#6B7280' }}>{riskEntry.signal_4_risk === 0 ? 'None recorded' : 'See notes scan'}</td><td style={{ textAlign: 'right', fontWeight: 600, color: riskEntry.signal_4_risk < 0 ? '#D63A4D' : undefined }}>{riskEntry.signal_4_risk}</td></tr>
                        <tr><td>5 · Tenure × Launch</td><td style={{ color: '#6B7280' }}>{selected.years_with_us != null ? `${selected.years_with_us.toFixed(1)}y tenure, ${riskEntry.launch_status}` : '—'}</td><td style={{ textAlign: 'right', fontWeight: 600, color: riskEntry.signal_5_tenure < 0 ? '#D63A4D' : undefined }}>{riskEntry.signal_5_tenure}</td></tr>
                        <tr>
                          <td>
                            6 · CS Health Pulse
                            {riskEntry.pulse_color && (
                              <Box component="span" sx={{
                                ml: 0.75,
                                px: 0.75,
                                py: 0.1,
                                fontSize: 10,
                                fontWeight: 600,
                                borderRadius: 0.75,
                                textTransform: 'uppercase',
                                bgcolor:
                                  riskEntry.pulse_color === 'green' ? 'rgba(26, 158, 92, 0.18)' :
                                  riskEntry.pulse_color === 'yellow' ? 'rgba(245, 166, 35, 0.18)' :
                                  'rgba(214, 58, 77, 0.18)',
                                color:
                                  riskEntry.pulse_color === 'green' ? '#1A9E5C' :
                                  riskEntry.pulse_color === 'yellow' ? '#B07206' :
                                  '#D63A4D',
                              }}>{riskEntry.pulse_color}</Box>
                            )}
                          </td>
                          <td style={{ color: '#6B7280' }}>{riskEntry.pulse_detail ?? 'Not set in HubSpot'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: (riskEntry.signal_6_pulse ?? 0) < 0 ? '#D63A4D' : undefined }}>
                            {(riskEntry.signal_6_pulse ?? 0) > 0 ? '+' : ''}{riskEntry.signal_6_pulse ?? 0}
                          </td>
                        </tr>
                        <tr><td colSpan={2} style={{ fontWeight: 700, paddingTop: 6 }}>Total</td><td style={{ textAlign: 'right', fontWeight: 700, color: tierColor, paddingTop: 6 }}>{riskEntry.total_score}</td></tr>
                      </tbody>
                    </Box>
                  </Grid>
                </Grid>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1.5, fontSize: 11 }}>
                  See the full attack list at <a href="/churn-risk-matrix" style={{ color: '#2C73FF' }}>/churn-risk-matrix</a>.
                </Typography>
              </Paper>
            );
          })()}

          {/* Revenue tab — monthly revenue timeline */}
          {custTab === 'revenue' && (
          <Paper sx={{ p: 3, mb: 3 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                Monthly revenue timeline · stacked by stream
              </Typography>
              <InfoIcon info={<><strong>What it is:</strong> Every month this customer has paid, with revenue split by stream (Subscription / Services / Connect).<br /><br /><strong>Data:</strong> Merged from subscription_by_month, services_by_month, and connect_by_customer_month snapshots for this customer.</>} />
            </Stack>
            {chart.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                No monthly revenue history for this customer.
              </Typography>
            ) : (
              <Box sx={{ height: 260 }}>
                <ResponsiveContainer>
                  <BarChart data={chart}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={monthLabel} stroke="#8B949E" fontSize={11} />
                    <YAxis stroke="#8B949E" fontSize={11} width={60} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                    <RTooltip
                      labelFormatter={(v) => monthLabelLong(String(v))}
                      formatter={(v: number, name: string) => [USD0.format(v), name]}
                      contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }} labelStyle={{ color: '#FFFFFF' }} itemStyle={{ color: '#FFFFFF' }}
                      cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                    />
                    <Bar name="Subscription" dataKey="subscription" stackId="rev" fill="#2C73FF" />
                    <Bar name="Services" dataKey="services" stackId="rev" fill="#1A9E5C" />
                    <Bar name="Connect" dataKey="connect" stackId="rev" fill="#F59E0B" />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            )}
            <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
              <LegendSwatch color="#2C73FF" label="Subscription" />
              <LegendSwatch color="#1A9E5C" label="Services" />
              <LegendSwatch color="#F59E0B" label="Connect" />
            </Stack>
          </Paper>
          )}

          {/* Orders Verified Trends — per-year order count + invoice $. Joined
              from orders_verified.json which itself is built from the xlsx
              Raw Data tab. Only renders when this customer has order data. */}
          {custTab === 'usage' && (() => {
            const ovByCustomer = (ordersVerifiedData as unknown as { by_customer?: Record<string, OrdersVerifiedRecord> } | undefined)?.by_customer;
            const ov = ovByCustomer?.[String(selected.allmoxy_customer_id)];
            if (!ov || !ov.years) return null;
            // Year rows for the chart. The current year is partial — we have
            // YTD data through whichever month was last refreshed. We compute
            // an annualized projection (YTD × 12 / months_loaded) so the user
            // can compare 2026 apples-to-apples with prior full years.
            const currentYear = new Date().getFullYear();
            const monthsLoaded = Object.keys(ov.monthly_supplement || {}).length;
            const yearRows = Object.entries(ov.years)
              .map(([year, y]) => {
                const isCurrentYear = Number(year) === currentYear;
                const total = y.total_usd || 0;
                const annualized = isCurrentYear && monthsLoaded > 0 && monthsLoaded < 12
                  ? Math.round((total * 12 / monthsLoaded) * 100) / 100
                  : total;
                return {
                  year,
                  // Pass null through (vs 0) so Recharts skips the point. 2026
                  // source xlsx has $ only — no order counts. See memory:
                  // 2026-order-counts-unavailable.
                  order_count: y.order_count == null ? null : y.order_count,
                  total_usd: total,
                  annualized,
                  is_partial: isCurrentYear && monthsLoaded < 12,
                };
              })
              .filter((r) => (r.order_count ?? 0) > 0 || r.total_usd > 0)
              .sort((a, b) => a.year.localeCompare(b.year));
            if (yearRows.length === 0) return null;
            const lifetimeOrders = ov.total_lifetime_orders || 0;
            const lifetimeUsd = ov.total_lifetime_usd || 0;
            const yoyPct = ov.monthly_avg_yoy_pct;
            const yoyLabel = yoyPct == null
              ? null
              : yoyPct === -1
                ? null
                : (yoyPct >= 0 ? '+' : '') + Math.round(yoyPct * 100) + '%';
            const curMA = ov.monthly_avg_current_year || 0;
            const prevMA = ov.monthly_avg_prior_year || 0;
            // The annualized callout — only meaningful when we have a partial
            // current year AND a prior year to compare against
            const currentYearRow = yearRows.find((r) => Number(r.year) === currentYear);
            const priorYearRow = yearRows.find((r) => Number(r.year) === currentYear - 1);
            const annualizedDiffPct = currentYearRow?.is_partial && priorYearRow && priorYearRow.total_usd > 0
              ? Math.round(((currentYearRow.annualized - priorYearRow.total_usd) / priorYearRow.total_usd) * 100)
              : null;
            return (
              <Paper sx={{ p: 3, mb: 3 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                  <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                    Orders verified trends · by year
                  </Typography>
                  <InfoIcon info={
                    <>
                      <strong>What it is:</strong> Verified order count and invoice $ for each year this customer has run orders through Allmoxy.<br /><br />
                      <strong>Data:</strong> Joined from the "Raw Data" tab of <code>Orders Verified Data.xlsx</code> via the orders_verified snapshot. Bars show invoice dollars (left axis); the line shows order count (right axis).<br /><br />
                      Currently {lifetimeOrders.toLocaleString()} lifetime orders / {USD0.format(lifetimeUsd)} lifetime $.
                    </>
                  } />
                </Stack>
                {/* Annualized callout — shown when current year is partial.
                    Lets the user compare apples-to-apples with prior full years. */}
                {currentYearRow?.is_partial && (
                  <Paper
                    variant="outlined"
                    sx={{
                      p: 1.5,
                      mb: 2,
                      borderColor: 'primary.main',
                      borderLeftWidth: 3,
                      borderLeftStyle: 'solid',
                      bgcolor: 'rgba(44, 115, 255, 0.04)',
                    }}
                  >
                    <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Box>
                        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>
                          {currentYear} YTD ({monthsLoaded}mo) annualized
                        </Typography>
                        <Typography variant="h6" sx={{ fontWeight: 600, color: 'primary.main', lineHeight: 1.2 }}>
                          {USD0.format(currentYearRow.annualized)}
                        </Typography>
                        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
                          actual YTD: {USD0.format(currentYearRow.total_usd)}
                        </Typography>
                      </Box>
                      {priorYearRow && (
                        <Box>
                          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>
                            vs {currentYear - 1} actual
                          </Typography>
                          <Typography variant="h6" sx={{ fontWeight: 500, lineHeight: 1.2 }}>
                            {USD0.format(priorYearRow.total_usd)}
                          </Typography>
                          {annualizedDiffPct != null && (
                            <Typography
                              variant="caption"
                              sx={{
                                color: annualizedDiffPct >= 0 ? 'success.main' : 'error.main',
                                fontWeight: 600,
                                fontSize: 11,
                              }}
                            >
                              {annualizedDiffPct >= 0 ? '+' : ''}{annualizedDiffPct}% if pace holds
                            </Typography>
                          )}
                        </Box>
                      )}
                      <Box sx={{ flexGrow: 1 }} />
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic', fontSize: 10.5, maxWidth: 280 }}>
                        Annualized = YTD ÷ {monthsLoaded} × 12. The lighter bar on the chart shows where {currentYear} would land if this pace continued.
                      </Typography>
                    </Stack>
                  </Paper>
                )}
                <Stack direction="row" spacing={3} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                  <MetaBit label="Lifetime orders" value={lifetimeOrders.toLocaleString()} />
                  <MetaBit label="Lifetime invoice $" value={USD0.format(lifetimeUsd)} />
                  {ov.live_date && <MetaBit label="Live date" value={ov.live_date} />}
                  {ov.months_to_launch != null && <MetaBit label="Months to launch" value={`${ov.months_to_launch} mo`} />}
                  {curMA > 0 && <MetaBit label="Current MA" value={`${USD0.format(curMA)}/mo`} />}
                  {prevMA > 0 && <MetaBit label="Prior year MA" value={`${USD0.format(prevMA)}/mo`} />}
                  {yoyLabel && (
                    <MetaBit
                      label="YoY"
                      value={yoyLabel}
                    />
                  )}
                </Stack>
                <Box sx={{ height: 260 }}>
                  <ResponsiveContainer>
                    <ComposedChart data={yearRows}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(139, 148, 158, 0.12)" vertical={false} />
                      <XAxis dataKey="year" stroke="#8B949E" fontSize={11} />
                      <YAxis yAxisId="left" stroke="#8B949E" fontSize={11} width={60} tickFormatter={(v) => USD_COMPACT.format(Number(v))} />
                      <YAxis yAxisId="right" orientation="right" stroke="#8B949E" fontSize={11} width={45} tickFormatter={(v) => Number(v).toLocaleString()} />
                      <RTooltip
                        formatter={(v: number, name: string) => {
                          if (name === 'Invoice $' || name === 'Annualized (projected)') return [USD0.format(v), name];
                          return [Number(v).toLocaleString(), name];
                        }}
                        contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF' }}
                        labelStyle={{ color: '#FFFFFF' }}
                        itemStyle={{ color: '#FFFFFF' }}
                        cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11, color: '#8B949E' }} />
                      <Bar yAxisId="left" name="Invoice $" dataKey="total_usd" stackId="annualized" fill="#2C73FF" />
                      {currentYearRow?.is_partial && (
                        <Bar
                          yAxisId="left"
                          name="Annualized (projected)"
                          dataKey={(d: { year: string; annualized: number; total_usd: number }) =>
                            d.year === String(currentYear) ? Math.max(0, d.annualized - d.total_usd) : 0
                          }
                          stackId="annualized"
                          fill="#2C73FF"
                          fillOpacity={0.25}
                          stroke="#2C73FF"
                          strokeOpacity={0.4}
                          strokeDasharray="3 3"
                        />
                      )}
                      <Line yAxisId="right" name="Order count" type="monotone" dataKey="order_count" stroke="#F59E0B" strokeWidth={2} dot={{ r: 3, fill: '#F59E0B' }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </Box>
              </Paper>
            );
          })()}

          {/* Renewal — collapsible panel that mirrors what the Renewal
              Management page shows in its row expansion. One row per HubSpot
              Instance keyed by allmoxy_customer_id; if a customer has multiple
              Instances (Production + Sandbox), we surface the Production one
              by preferring rows that have a renewal date. */}
          {custTab === 'renewal' && (() => {
            const renewalSnap = renewalData as unknown as { rows: Array<RenewalPanelRow & { allmoxy_customer_id: number; account_name: string }> } | undefined;
            const renewalCandidates = (renewalSnap?.rows ?? []).filter((r) => r.allmoxy_customer_id === selected.allmoxy_customer_id);
            if (renewalCandidates.length === 0) return null;
            const renewalRow = renewalCandidates.find((r) => r.renewal_date) ?? renewalCandidates[0];
            return (
              <Box sx={{ mt: 3, mb: 3 }}>
                <Paper
                  onClick={() => setRenewalExpanded((v) => !v)}
                  sx={{
                    p: 2,
                    cursor: 'pointer',
                    userSelect: 'none',
                    ...(renewalExpanded && { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottom: 'none' }),
                  }}
                  role="button"
                  aria-expanded={renewalExpanded}
                  aria-controls="customer-renewal-panel"
                >
                  <Stack direction="row" alignItems="center" justifyContent="space-between">
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="h6" sx={{ fontWeight: 500 }}>
                        Renewal · {renewalRow.account_name || selected.name}
                      </Typography>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {renewalRow.renewal_date
                          ? <>Renews <strong>{renewalRow.renewal_date}</strong>{renewalRow.days_to_renewal != null && ` · ${renewalRow.days_to_renewal >= 0 ? `in ${renewalRow.days_to_renewal}d` : `${Math.abs(renewalRow.days_to_renewal)}d ago`}`} · {renewalRow.action_tag} · Cost ratio {renewalRow.cost_ratio_lifetime_pct != null ? `${renewalRow.cost_ratio_lifetime_pct.toFixed(2)}%` : '—'} lifetime</>
                          : <>No renewal date in HubSpot · {renewalRow.action_tag} · Cost ratio {renewalRow.cost_ratio_lifetime_pct != null ? `${renewalRow.cost_ratio_lifetime_pct.toFixed(2)}%` : '—'} lifetime</>}
                      </Typography>
                    </Box>
                    <IconButton
                      size="small"
                      aria-label={renewalExpanded ? 'Collapse renewal panel' : 'Expand renewal panel'}
                      onClick={(e) => { e.stopPropagation(); setRenewalExpanded((v) => !v); }}
                      sx={{ transform: renewalExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
                    >
                      <ExpandMoreIcon />
                    </IconButton>
                  </Stack>
                </Paper>
                <Collapse in={renewalExpanded}>
                  <Paper
                    id="customer-renewal-panel"
                    sx={{
                      p: 3,
                      borderTopLeftRadius: 0,
                      borderTopRightRadius: 0,
                      borderTop: '1px dashed',
                      borderColor: 'divider',
                    }}
                  >
                    <RenewalPanelContent row={renewalRow} hideQuotes showUnderpriced />
                  </Paper>
                </Collapse>
              </Box>
            );
          })()}

          {/* Quotes — dedicated, always-visible card listing every HubSpot
              Quote attached to this customer's Company. Quotes live on the
              renewal_management snapshot rows; we aggregate across all of this
              customer's renewal rows (a customer can have multiple Instances /
              Production+Sandbox pairs), de-dupe by quote id, and sort newest
              first. Surfaced as its own section here so it's not buried inside
              the collapsible Renewal panel — that panel's own quotes block is
              suppressed via hideQuotes to avoid showing the same table twice. */}
          {custTab === 'contracts' && (() => {
            const renewalSnap = renewalData as unknown as { rows: Array<RenewalPanelRow & { allmoxy_customer_id: number }> } | undefined;
            const rows = (renewalSnap?.rows ?? []).filter((r) => r.allmoxy_customer_id === selected.allmoxy_customer_id);
            const byId = new Map<string, RenewalQuote>();
            rows.forEach((r) => (r.quotes ?? []).forEach((q) => byId.set(q.id, q)));
            const quotes = Array.from(byId.values()).sort((a, b) =>
              (b.created_date ?? '').localeCompare(a.created_date ?? ''));
            if (quotes.length === 0) return null;
            return (
              <Box sx={{ mb: 3 }}>
                <Paper sx={{ p: 3 }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                    <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                      Quotes ({quotes.length})
                    </Typography>
                    <InfoIcon info={<><strong>What it is:</strong> Every HubSpot Quote attached to this customer's Company association(s), newest first. Click "Open in HubSpot" to jump to the quote.<br /><br /><strong>Status:</strong> comes from HubSpot's workflow — <code>APPROVAL_NOT_NEEDED</code> is HubSpot's term for "sent/active", <code>DRAFT</code> is in-progress.</>} />
                  </Stack>
                  <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', '& th, & td': { py: 0.75, fontSize: 13, textAlign: 'left', borderBottom: '1px solid', borderColor: 'divider' }, '& th': { fontWeight: 600, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 10 } }}>
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Status</th>
                        <th style={{ textAlign: 'right' }}>Amount</th>
                        <th>Created</th>
                        <th>Expires</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotes.map((q) => (
                        <tr key={q.id}>
                          <td style={{ fontWeight: 500 }}>{q.title || '(untitled)'}</td>
                          <td>
                            <Chip
                              label={q.status === 'APPROVAL_NOT_NEEDED' ? 'SENT' : (q.status || '—')}
                              size="small"
                              sx={{
                                height: 18,
                                fontSize: 10,
                                bgcolor: q.status === 'DRAFT' ? 'rgba(245, 166, 35, 0.18)' : q.status === 'APPROVAL_NOT_NEEDED' ? 'rgba(26, 158, 92, 0.18)' : 'rgba(139, 148, 158, 0.18)',
                                color: q.status === 'DRAFT' ? '#B07206' : q.status === 'APPROVAL_NOT_NEEDED' ? '#1A9E5C' : '#475569',
                                fontWeight: 600,
                              }}
                            />
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {q.amount != null ? `${q.currency === 'USD' ? '$' : (q.currency + ' ')}${Math.round(q.amount).toLocaleString()}` : '—'}
                          </td>
                          <td style={{ color: '#6B7280' }}>{q.created_date ? q.created_date.slice(0, 10) : '—'}</td>
                          <td style={{ color: '#6B7280' }}>{q.expiration_date ? q.expiration_date.slice(0, 10) : '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            <Box
                              component="a"
                              href={q.hubspot_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              sx={{ fontSize: 12, color: 'primary.light', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
                            >
                              Open in HubSpot ↗
                            </Box>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Box>
                </Paper>
              </Box>
            );
          })()}


          {/* Transactions tab (collapsed by default, click header to expand) */}
          {custTab === 'transactions' && (
          <Box sx={{ mt: 3 }}>
            <Paper
              onClick={() => setTxnExpanded((v) => !v)}
              sx={{
                p: 2,
                cursor: 'pointer',
                userSelect: 'none',
                ...(txnExpanded && { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottom: 'none' }),
              }}
              role="button"
              aria-expanded={txnExpanded}
              aria-controls="customer-transactions-panel"
            >
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="h6" sx={{ fontWeight: 500 }}>
                    Transactions · {selected.name}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {selected.transaction_count.toLocaleString()} Stripe charges · sortable, CSV-exportable
                  </Typography>
                </Box>
                <IconButton
                  size="small"
                  aria-label={txnExpanded ? 'Collapse transactions' : 'Expand transactions'}
                  sx={{ transition: 'transform 200ms', transform: txnExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  <ExpandMoreIcon />
                </IconButton>
              </Stack>
            </Paper>
            <Collapse in={txnExpanded} timeout="auto" unmountOnExit>
              <Box id="customer-transactions-panel" sx={{ '& #drill-down-panel': { mt: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 } }}>
                <DrillDownPanel<Record<string, unknown>>
                  title=""
                  rows={selected.transactions as unknown as Array<Record<string, unknown>>}
                  columns={[
                    {
                      key: 'created',
                      label: 'Date',
                      render: (r: Record<string, unknown>) => formatDateMDY(String((r as unknown as Transaction).created ?? '').slice(0, 10)),
                      exportValue: (r: Record<string, unknown>) => String((r as unknown as Transaction).created ?? '').slice(0, 10),
                      sortValue: (r: Record<string, unknown>) => String((r as unknown as Transaction).created ?? ''),
                    },
                    {
                      key: 'amount',
                      label: 'Amount',
                      align: 'right',
                      render: (r: Record<string, unknown>) => USD0.format((r as unknown as Transaction).amount),
                    },
                    { key: 'type', label: 'Type' },
                    {
                      key: 'status',
                      label: 'Status',
                      render: (r: Record<string, unknown>) => {
                        const s = (r as unknown as Transaction).status;
                        const color = s === 'succeeded' ? 'success.main' : s === 'failed' ? 'error.main' : 'text.secondary';
                        return <span style={{ color: color as string }}>{s}</span>;
                      },
                      exportValue: (r: Record<string, unknown>) => (r as unknown as Transaction).status ?? '',
                    },
                    { key: 'description', label: 'Description' },
                  ]}
                  filename={`customer_${selected.allmoxy_customer_id}_transactions`}
                />
              </Box>
            </Collapse>
          </Box>
          )}
        </>
      )}
    </Box>
  );
}

function StatCard({
  label, value, hint, info,
}: { label: string; value: string | null; hint: string; info?: React.ReactNode }) {
  return (
    <Paper sx={{ p: 2.5, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={0.5}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label}
        </Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      {/* Push the number + hint to the bottom so values line up across cards
          regardless of how many lines the label wraps to. */}
      <Box sx={{ mt: 'auto', pt: 1 }}>
        {value == null ? (
          <Skeleton variant="text" width="60%" sx={{ fontSize: 28 }} />
        ) : (
          <Typography variant="h5" sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </Typography>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 11 }}>
          {hint}
        </Typography>
      </Box>
    </Paper>
  );
}


// Left-packed, fixed-width field rows for the Information tab — fields sit
// next to each other on the left and wrap, instead of spreading across the
// full width with big gaps.
const infoRowSx = { display: 'flex', flexWrap: 'wrap', columnGap: 2.5, rowGap: 2 } as const;

// Consistent field renderers for the Information tab — one label/value style,
// matching the "Who they are" firmographics block.
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, fontWeight: 600 }}>{children}</Typography>;
}
function SectionHeading({ children, info }: { children: React.ReactNode; info?: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5, mb: 1.25 }}>
      <Box sx={{ width: 3, height: 15, borderRadius: 1, bgcolor: 'primary.main', flexShrink: 0 }} />
      <Typography variant="subtitle2" sx={{ fontWeight: 700, fontSize: 13, color: 'text.primary' }}>{children}</Typography>
      {info && <InfoIcon info={info} />}
    </Stack>
  );
}
// One boxed section card for the Information tab. `wide` makes it span the full
// grid width (for chip-heavy groups like software stack / firmographics).
function InfoSection({ title, info, wide, children }: { title: React.ReactNode; info?: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, alignSelf: 'start', ...(wide && { gridColumn: '1 / -1' }) }}>
      <SectionHeading info={info}>{title}</SectionHeading>
      <Box sx={infoRowSx}>{children}</Box>
    </Paper>
  );
}
function InfoField({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Box>
      <FieldLabel>{label}</FieldLabel>
      <Typography variant="body1" component="div" sx={{ fontWeight: 500, mt: 0.25, lineHeight: 1.3 }}>{value ?? '—'}</Typography>
      {hint && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{hint}</Typography>}
    </Box>
  );
}
function ChipList({ items, color = '#2C73FF' }: { items: string[]; color?: string }) {
  if (!items.length) return <Typography variant="body1" sx={{ color: 'text.disabled', mt: 0.25 }}>—</Typography>;
  return <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>{items.map((x) => <Chip key={x} label={x} size="small" sx={{ height: 20, fontSize: 11, bgcolor: color + '22', color }} />)}</Stack>;
}

function MetaBit({ label, value }: { label: string; value: string }) {
  return (
    <Stack>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {value}
      </Typography>
    </Stack>
  );
}

function ExternalLink({
  label, display, href, emphasize,
}: { label: string; display: string; href: string; emphasize?: boolean }) {
  const truncated = display.length > 28 ? display.slice(0, 28) + '…' : display;
  return (
    <Stack spacing={0.4}>
      <Typography
        variant="caption"
        sx={{
          color: emphasize ? 'primary.main' : 'text.secondary',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: emphasize ? 600 : 500,
          lineHeight: 1.2,
        }}
      >
        {label}
      </Typography>
      <Box
        component="a"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={display}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          fontSize: 12.5,
          fontFamily: 'monospace',
          color: emphasize ? 'primary.main' : 'primary.light',
          fontWeight: 500,
          lineHeight: 1.4,
          textDecoration: 'none',
          '&:hover': { textDecoration: 'underline' },
        }}
      >
        {truncated}
      </Box>
    </Stack>
  );
}

// ----------------------------------------------------------------------------
// MilestoneTimeline — horizontal date-proportional timeline. Each event gets a dot
// positioned along a track by its date; labels alternate above/below to reduce
// crowding when dates are close. Events missing a date fall to the endpoints.
// ----------------------------------------------------------------------------
type MilestoneEvent = { label: string; date: string | null; subtitle?: string; detail?: string; accent?: boolean };

function MilestoneTimeline({ events }: { events: MilestoneEvent[] }) {
  // Convert YYYY-MM-DD → epoch ms; missing dates become null and get pushed to endpoints.
  function dateMs(s: string | null | undefined): number | null {
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const withMs = events.map((e) => ({ ...e, ms: dateMs(e.date) }));
  const dated = withMs.filter((e) => e.ms != null) as Array<MilestoneEvent & { ms: number }>;
  if (dated.length === 0) {
    return <Typography variant="body2" sx={{ color: 'text.secondary' }}>No milestones recorded.</Typography>;
  }
  // Pad the visible range by ~5% so the endpoint dots aren't flush with the edges.
  const minMs = Math.min(...dated.map((e) => e.ms));
  const maxMs = Math.max(...dated.map((e) => e.ms));
  const span = Math.max(maxMs - minMs, 1);
  const pad = span * 0.05;
  const rangeMin = minMs - pad;
  const rangeMax = maxMs + pad;
  const rangeSpan = rangeMax - rangeMin;
  const pctOf = (ms: number | null) => {
    if (ms == null) return 50;
    return ((ms - rangeMin) / rangeSpan) * 100;
  };
  // Compute label slots to avoid overlap. We have 4 vertical "rows" — two above the line
  // (far, near) and two below (near, far). Walk events left-to-right by date; for each event,
  // pick the first row whose last-used position is at least MIN_GAP_PCT away. This guarantees
  // visual separation even when two milestones land on the same day (e.g., sign_up_date ==
  // first_payment_date), and keeps the dots accurate on the date axis.
  const MIN_GAP_PCT = 18; // tuned so labels (~90-110px @ ~600px width) don't visually crash
  const ROW_ORDER: Array<'above-near' | 'below-near' | 'above-far' | 'below-far'> = [
    'above-near', 'below-near', 'above-far', 'below-far',
  ];
  const sorted = [...withMs].sort((a, b) => pctOf(a.ms) - pctOf(b.ms));
  const lastUsedByRow = new Map<typeof ROW_ORDER[number], number>();
  const slotByEvent = new Map<MilestoneEvent, typeof ROW_ORDER[number]>();
  for (const e of sorted) {
    const p = pctOf(e.ms);
    // First row that hasn't been used within MIN_GAP_PCT of this event.
    const row = ROW_ORDER.find((r) => (p - (lastUsedByRow.get(r) ?? -Infinity)) >= MIN_GAP_PCT)
      ?? ROW_ORDER[0]; // fallback: stack onto row 0 even if it collides
    slotByEvent.set(e, row);
    lastUsedByRow.set(row, p);
  }

  // Pixel offsets per row, relative to the track (middle of the Box).
  // Track y = 50%. Far rows sit further from track so they clear the near-row labels.
  const ROW_OFFSET_PX: Record<typeof ROW_ORDER[number], number> = {
    'above-near': -14,
    'above-far': -52,
    'below-near': 14,
    'below-far': 52,
  };

  // Container needs enough vertical headroom for the "far" rows + label heights (~36px each).
  const containerHeight = 168;

  return (
    <Box sx={{ position: 'relative', height: containerHeight, mt: 2, mb: 1, px: 1.5 }}>
      {/* Track */}
      <Box
        sx={{
          position: 'absolute',
          left: 12,
          right: 12,
          top: '50%',
          height: '2px',
          bgcolor: 'rgba(139, 148, 158, 0.3)',
          borderRadius: 1,
        }}
      />
      {withMs.map((e, idx) => {
        const left = `${pctOf(e.ms)}%`;
        const row = slotByEvent.get(e) ?? 'above-near';
        const isAbove = row.startsWith('above');
        const offsetPx = ROW_OFFSET_PX[row];
        const color = e.accent ? '#F5A623' : e.date ? '#2C73FF' : 'rgba(139, 148, 158, 0.5)';
        return (
          <Box
            key={`${e.label}-${idx}`}
            sx={{ position: 'absolute', left, top: '50%', transform: 'translate(-50%, -50%)' }}
          >
            {/* Optional connector line from the dot to the label, so far-row entries clearly
                belong to their dot rather than appearing to float. */}
            <Box
              sx={{
                position: 'absolute',
                left: '50%',
                top: isAbove ? `${offsetPx + 6}px` : '6px',
                width: '1px',
                height: `${Math.abs(offsetPx) - 6}px`,
                bgcolor: 'rgba(139, 148, 158, 0.25)',
                transform: 'translateX(-50%)',
              }}
            />
            {/* Dot */}
            <Box
              sx={{
                width: e.accent ? 12 : 10,
                height: e.accent ? 12 : 10,
                bgcolor: color,
                borderRadius: '50%',
                border: '2px solid #161B22',
                boxShadow: e.accent ? `0 0 0 3px ${color}33` : 'none',
                position: 'relative',
                zIndex: 1,
              }}
            />
            {/* Label */}
            <Box
              sx={{
                position: 'absolute',
                left: '50%',
                top: isAbove ? `${offsetPx}px` : `${offsetPx}px`,
                transform: isAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
                textAlign: 'center',
                whiteSpace: 'nowrap',
                px: 0.5,
                lineHeight: 1.25,
              }}
            >
              <Typography variant="caption" sx={{ display: 'block', fontWeight: 500, color: 'text.primary' }}>{e.label}</Typography>
              {e.detail && (
                <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontSize: 10.5 }}>
                  {e.detail}
                </Typography>
              )}
              <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontSize: 10.5 }}>
                {e.subtitle ?? (e.date ? formatDateMDY(e.date) : '—')}
              </Typography>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Box sx={{ width: 14, height: 14, bgcolor: color, borderRadius: 0.5 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>
        {label}
      </Typography>
    </Stack>
  );
}

// ----------------------------------------------------------------------------
// ChurnAnalysisCard — surfaces the customer's HubSpot churn_reason, AI-inferred reason +
// confidence + evidence, sub-pattern tags, and provides an inline edit form that writes to
// the local pending-overrides map. Saved override takes precedence over HubSpot and AI.
// ----------------------------------------------------------------------------
function ChurnAnalysisCard({
  selected,
  inference,
  subTags,
  subDefs,
  override,
  effectiveReason,
  effectiveEvidence,
  reasonSource,
  onSave,
}: {
  selected: CustomerProfile;
  inference: ChurnInference | null;
  subTags: string[];
  subDefs: Record<string, { label: string; parent: string; description: string }>;
  override: ChurnOverride | undefined;
  effectiveReason: string;
  effectiveEvidence: string;
  reasonSource: 'override' | 'hubspot' | 'ai' | 'none';
  onSave: (reason: string, evidence: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Draft state mirrors the effective reason so the edit form opens with the current value;
  // resets when the selected customer changes (effectiveReason changes too).
  const [draftReason, setDraftReason] = useState(effectiveReason);
  const [draftEvidence, setDraftEvidence] = useState(effectiveEvidence);

  // Reset drafts whenever the underlying customer or effective values change. Without this,
  // switching customers via the picker would carry the prior customer's edits into the next form.
  useEffect(() => {
    setEditing(false);
    setDraftReason(effectiveReason);
    setDraftEvidence(effectiveEvidence);
  }, [selected.allmoxy_customer_id, effectiveReason, effectiveEvidence]);

  const sourceChip = (() => {
    if (reasonSource === 'override') return { label: 'You · pending', color: '#F5A623', bg: 'rgba(245, 158, 11, 0.16)' };
    if (reasonSource === 'hubspot') return { label: 'HubSpot Churn Playbook', color: '#7AB0FF', bg: 'rgba(44, 115, 255, 0.16)' };
    if (reasonSource === 'ai') return { label: `AI · ${inference?.confidence ?? 'low'}`, color: '#1A9E5C', bg: 'rgba(26, 158, 92, 0.16)' };
    return { label: 'No reason recorded', color: '#8B949E', bg: 'rgba(139, 148, 158, 0.16)' };
  })();

  return (
    <Paper sx={{ p: 3, mb: 3, borderLeft: '3px solid', borderLeftColor: 'rgba(44, 115, 255, 0.6)' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'flex-start' }} justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
            Churn analysis
          </Typography>
          <InfoIcon info={<><strong>Reason</strong>: comes from one of three sources — your local override (orange), HubSpot's recorded Churn Playbook reason (blue), or a Claude-MCP AI inference from CSM notes (green). Override always wins.<br /><br /><strong>Sub-patterns</strong>: finer-grained "why" tags within the parent reason — populated by <code>build_churn_subpatterns.mjs</code>. Drives the chip filters on the Churn Patterns page.<br /><br /><strong>Edit</strong>: pick a reason from the playbook taxonomy and write a free-text evidence quote. Saves to localStorage as a pending override.</>} />
          <Chip
            label={sourceChip.label}
            size="small"
            sx={{ ml: 1, height: 22, fontSize: 11, bgcolor: sourceChip.bg, color: sourceChip.color, fontWeight: 500 }}
          />
        </Stack>
        {!editing && (
          <Button size="small" variant="outlined" onClick={() => setEditing(true)} sx={{ minWidth: 'auto' }}>
            {override ? 'Edit override' : 'Update'}
          </Button>
        )}
      </Stack>

      {!editing ? (
        <Stack spacing={1.5}>
          {/* Effective reason — single big label */}
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>Reason</Typography>
            <Typography variant="body1" sx={{ fontWeight: 500, mt: 0.25 }}>
              {effectiveReason || <Box component="span" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>No reason recorded</Box>}
            </Typography>
          </Box>

          {/* When override is active, show the HubSpot + AI reasons too so the user knows what
              they're overriding. */}
          {override && (
            <Box sx={{ p: 1.25, bgcolor: 'rgba(255, 255, 255, 0.02)', borderRadius: 1 }}>
              {selected.churn_reason && (
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                  HubSpot reason (overridden): <Box component="span" sx={{ color: 'text.primary' }}>{selected.churn_reason}</Box>
                </Typography>
              )}
              {inference?.suggested_reason && (
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
                  AI inference ({inference.confidence}, overridden): <Box component="span" sx={{ color: 'text.primary' }}>{inference.suggested_reason}</Box>
                </Typography>
              )}
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25, fontStyle: 'italic' }}>
                Override saved {new Date(override.updatedAt).toLocaleString()}
              </Typography>
            </Box>
          )}

          {/* Sub-pattern tags */}
          {subTags.length > 0 && (
            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>
                Sub-patterns ({subTags.length})
              </Typography>
              <Stack direction="row" spacing={0.75} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
                {subTags.map((id) => {
                  const def = subDefs[id];
                  return (
                    <Chip
                      key={id}
                      label={def?.label ?? id}
                      size="small"
                      title={def?.description}
                      sx={{ height: 22, fontSize: 11, bgcolor: 'rgba(44, 115, 255, 0.12)', border: '1px solid rgba(44, 115, 255, 0.35)', color: '#7AB0FF' }}
                    />
                  );
                })}
              </Stack>
            </Box>
          )}

          {/* Evidence quote */}
          {effectiveEvidence && (
            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>Full reason / evidence</Typography>
              <Typography variant="body2" sx={{ mt: 0.25, color: 'text.primary', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {effectiveEvidence}
              </Typography>
              {inference?.evidence_date && reasonSource !== 'override' && (
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                  Evidence dated {inference.evidence_date}
                </Typography>
              )}
            </Box>
          )}

          {/* AI recommended action — only shown if there's no override and the inference has one */}
          {!override && inference?.recommended_action && (
            <Box sx={{ p: 1.25, bgcolor: 'rgba(26, 158, 92, 0.06)', borderRadius: 1, borderLeft: '2px solid rgba(26, 158, 92, 0.5)' }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>Recommended action</Typography>
              <Typography variant="body2" sx={{ mt: 0.25 }}>{inference.recommended_action}</Typography>
            </Box>
          )}
        </Stack>
      ) : (
        <Stack spacing={2}>
          <Autocomplete
            freeSolo
            options={HUBSPOT_CHURN_PLAYBOOK as readonly string[] as string[]}
            value={draftReason}
            onChange={(_e, v) => setDraftReason(typeof v === 'string' ? v : (v ?? ''))}
            onInputChange={(_e, v) => setDraftReason(v)}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Reason (Churn Playbook taxonomy)"
                size="small"
                helperText="Pick from the standard taxonomy or type your own. Leave blank to clear the override."
              />
            )}
          />
          <TextField
            label="Full reason / evidence"
            value={draftEvidence}
            onChange={(e) => setDraftEvidence(e.target.value)}
            multiline
            minRows={3}
            maxRows={12}
            size="small"
            placeholder="Quote the CSM note, an email, or whatever supports the reason. Free text — gets stored verbatim."
            helperText="Stored locally until an ETL pass folds it into customer_profiles / churn_inferences."
          />
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            {override && (
              <Button
                size="small"
                color="error"
                variant="text"
                onClick={() => { onSave('', ''); setEditing(false); }}
              >
                Clear override
              </Button>
            )}
            <Button size="small" variant="text" onClick={() => { setEditing(false); setDraftReason(effectiveReason); setDraftEvidence(effectiveEvidence); }}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => { onSave(draftReason, draftEvidence); setEditing(false); }}
              disabled={draftReason.trim() === (override?.reason ?? '') && draftEvidence.trim() === (override?.evidence ?? '')}
            >
              Save override
            </Button>
          </Stack>
        </Stack>
      )}
    </Paper>
  );
}
