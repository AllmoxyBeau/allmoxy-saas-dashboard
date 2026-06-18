import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Alert from '@mui/material/Alert';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { ResponsiveContainer, BarChart, Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
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
  status: 'active' | 'at_risk' | 'churned';
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
  stripe_subscription_id?: string | null;
  custom_domain_stripe_subscription_id?: string | null;
  all_stripe_subscription_ids?: string[];
  all_custom_domain_stripe_subscription_ids?: string[];
  hubspot_instance_name?: string | null;
  hubspot_record_id?: string | null;
  instance_owner?: string | null;
  instance_owner_first_name?: string | null;
  hubspot_owner_name?: string | null;
  monthly_history: Record<string, MonthlyCell>;
  transactions: Transaction[];
};

type Cohort = {
  year: number;
  initial: number;
  active: number;
  retentionPct: number | null;
};
type CohortSnap = { cohortSummary: Cohort[] };

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
type OrdersVerifiedYear = {
  order_count: number;
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

const filterCustomers = createFilterOptions<CustomerProfile>({
  matchFrom: 'any',
  stringify: (o) => o.name,
  limit: 40,
});

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
  return { label: 'Churned', bgcolor: 'rgba(218, 54, 51, 0.18)', color: 'error.main' } as const;
}

export default function CustomerDetail() {
  const { data, isLoading } = useSheetTab('customer_profiles');
  const { data: cohortData } = useSheetTab('cohort_retention');
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
  const snap = data as unknown as { rows: CustomerProfile[] } | undefined;
  const cohort = cohortData as unknown as CohortSnap | undefined;
  const inferences = inferencesData as unknown as ChurnInferencesSnap | undefined;
  const subpatterns = subpatternsData as unknown as ChurnSubpatternsSnap | undefined;
  const risk = riskData as unknown as { customers: Array<{ allmoxy_customer_id: number; tier: string; total_score: number; signal_1_orders: number; signal_2_launch: number; signal_3_recency: number; signal_4_risk: number; signal_5_tenure: number; orders_detail: string; signal_2_detail?: string; days_since_last_contact: number | null; launch_status: string; is_launched: boolean; live_date: string | null; orders_monthly_avg_current: number; orders_monthly_avg_prior: number; orders_yoy_pct: number | null; arr_at_risk: number; narrative: string; is_bid_only?: boolean }> } | undefined;

  const [pending, setPending] = useState<PendingMap>(() => readPending());
  const [bidOnlyMap, setBidOnlyMap] = useState<BidOnlyMap>(() => readBidOnly());
  // Pending churn-reason overrides — id → { reason, evidence, updatedAt }. Persists locally
  // until an ETL pass folds them into customer_profiles or churn_inferences. While pending,
  // the "Update" UI surfaces a "Pending" chip so the user knows it hasn't landed yet.
  const [churnOverrides, setChurnOverrides] = useState<ChurnOverrideMap>(() => readChurnOverrides());
  const [txnExpanded, setTxnExpanded] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

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

  function selectCustomer(id: number | null) {
    if (id == null) return;
    const next = new URLSearchParams(searchParams);
    next.set('id', String(id));
    next.delete('name');
    setSearchParams(next, { replace: true });
  }

  // Sort customers alphabetically for the search list; limit display to speed render.
  const sortedForSearch = useMemo(
    () => [...customers].sort((a, b) => a.name.localeCompare(b.name)),
    [customers]
  );

  const chart = useMemo(() => {
    if (!selected) return [];
    return Object.entries(selected.monthly_history)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, subscription: v.subscription, services: v.services, connect: v.connect }));
  }, [selected]);

  const cohortContext = useMemo(() => {
    if (!selected?.cohort_year || !cohort) return null;
    return cohort.cohortSummary.find((c) => c.year === selected.cohort_year) ?? null;
  }, [selected, cohort]);

  const selectedIsCommittedAnnual = selected ? COMMITTED_ANNUAL_IDS.has(selected.allmoxy_customer_id) : false;
  const selectedPending = selected ? pending[String(selected.allmoxy_customer_id)] : undefined;
  const selectedIsAnnual = selectedPending != null ? selectedPending : selectedIsCommittedAnnual;
  const selectedIsPending = selectedPending != null && selectedPending !== selectedIsCommittedAnnual;

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
        title="Customer Detail"
        subtitle="Pick any customer to see their full lifetime — revenue by stream, every transaction, milestones, and how their cohort is performing."
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

      {/* Search / customer picker */}
      <Paper sx={{ p: 2.5, mb: 3 }}>
        <Autocomplete
          options={sortedForSearch}
          filterOptions={filterCustomers}
          getOptionLabel={(o) => o.name}
          value={selected}
          onChange={(_, v) => selectCustomer(v?.allmoxy_customer_id ?? null)}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Search customers"
              placeholder="Start typing a customer name..."
              size="small"
            />
          )}
          renderOption={(props, option) => {
            const { key, ...rest } = props as { key?: React.Key } & React.HTMLAttributes<HTMLLIElement>;
            return (
              <Box component="li" key={key ?? option.allmoxy_customer_id} {...rest}>
                <Stack direction="row" justifyContent="space-between" sx={{ width: '100%' }}>
                  <Typography variant="body2">{option.name}</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {USD_COMPACT.format(option.lifetime_total)} lifetime · {option.cohort_year ?? '—'} cohort
                  </Typography>
                </Stack>
              </Box>
            );
          }}
          isOptionEqualToValue={(a, b) => a.allmoxy_customer_id === b.allmoxy_customer_id}
          loading={isLoading}
        />
      </Paper>

      {!selected ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            Search a customer above to see their full profile.
          </Typography>
        </Paper>
      ) : (
        <>
          {/* Identity card */}
          <Paper sx={{ p: 3, mb: 3 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }}>
              <Stack>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>
                  {selected.name}
                </Typography>
                <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                  <MetaBit label="Signed up" value={formatDateMDY(selected.sign_up_date)} />
                  <MetaBit label="First payment" value={formatDateMDY(selected.first_payment_date)} />
                  <MetaBit label="Last payment" value={formatDateMDY(selected.last_payment_date)} />
                  <MetaBit label="Tenure" value={selected.years_with_us != null ? `${selected.years_with_us.toFixed(1)} yrs` : '—'} />
                  <MetaBit label="Cohort" value={selected.cohort_year != null ? String(selected.cohort_year) : '—'} />
                  <MetaBit label="Transactions" value={selected.transaction_count.toLocaleString()} />
                  <MetaBit label="Stripe fee %" value={selected.stripe_fee_percent != null ? `${selected.stripe_fee_percent.toFixed(2)}%` : '—'} />
                </Stack>
                {/* HubSpot Instance Sync Sheet — only render when at least one field is populated.
                    Churn reason is shown in its own "Churn analysis" panel below, so it isn't
                    duplicated here. */}
                {(() => {
                  const accountRep =
                    selected.instance_owner_first_name?.trim() ||
                    selected.instance_owner?.trim() ||
                    selected.hubspot_owner_name?.trim() ||
                    null;
                  const hasAny = selected.primary_segment || selected.pay_status || selected.contract_status || accountRep;
                  if (!hasAny) return null;
                  return (
                    <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                      {accountRep && <MetaBit label="Account rep" value={accountRep} />}
                      {selected.primary_segment && <MetaBit label="Segment" value={selected.primary_segment} />}
                      {selected.pay_status && <MetaBit label="Pay status" value={selected.pay_status} />}
                      {selected.contract_status && <MetaBit label="Contract" value={selected.contract_status} />}
                    </Stack>
                  );
                })()}
                {/* External links — instance URL, HubSpot, and ALL Stripe IDs */}
                {(() => {
                  // Collect every distinct sub_id we know about (primary + secondary
                  // instances + custom domains). De-dupe in case primary_id appears
                  // in the all-list too. Mark the custom-domain ones for visual emphasis.
                  const customDomainSet = new Set(selected.all_custom_domain_stripe_subscription_ids ?? []);
                  if (selected.custom_domain_stripe_subscription_id) customDomainSet.add(selected.custom_domain_stripe_subscription_id);
                  const allSubsSet = new Set([
                    ...(selected.all_stripe_subscription_ids ?? []),
                    ...(selected.stripe_subscription_id ? [selected.stripe_subscription_id] : []),
                    ...customDomainSet,
                  ]);
                  const allSubsList = [...allSubsSet];
                  const hasAnyExternal =
                    selected.installer_directory ||
                    selected.hubspot_company_id ||
                    selected.stripe_customer_ids.length > 0 ||
                    allSubsList.length > 0;
                  if (!hasAnyExternal) return null;
                  return (
                    <Stack direction="row" spacing={3} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap alignItems="flex-start">
                      {selected.installer_directory && (
                        <ExternalLink
                          label="Allmoxy URL"
                          display={`${selected.installer_directory}.allmoxy.com`}
                          href={`https://${selected.installer_directory}.allmoxy.com`}
                        />
                      )}
                      {selected.hubspot_company_id && (
                        <ExternalLink
                          label="HubSpot ID"
                          display={selected.hubspot_company_id}
                          href={hubspotCompanyUrl(selected.hubspot_company_id) ?? '#'}
                        />
                      )}
                      {selected.stripe_customer_ids[0] && (
                        <ExternalLink
                          label="Stripe Customer"
                          display={selected.stripe_customer_ids[0]}
                          href={`https://dashboard.stripe.com/customers/${selected.stripe_customer_ids[0]}`}
                        />
                      )}
                      {allSubsList.map((subId, i) => {
                        const isCustomDomain = customDomainSet.has(subId);
                        const isPrimary = subId === selected.stripe_subscription_id && !isCustomDomain;
                        const label = isCustomDomain
                          ? `Custom Domain Sub${customDomainSet.size > 1 ? ` ${[...customDomainSet].indexOf(subId) + 1}` : ''}`
                          : isPrimary
                            ? 'Stripe Subscription'
                            : `Stripe Sub ${i + 1}`;
                        return (
                          <ExternalLink
                            key={subId}
                            label={label}
                            display={subId}
                            href={`https://dashboard.stripe.com/subscriptions/${subId}`}
                            emphasize={isCustomDomain}
                          />
                        );
                      })}
                    </Stack>
                  );
                })()}
                {/* Internal IDs row — below the external links so the eye lands
                    on the action links first (URL / HubSpot / Stripe) and the
                    bare identifiers sit below as secondary reference info. */}
                <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                  <MetaBit label="Allmoxy ID" value={String(selected.allmoxy_customer_id)} />
                  {selected.installer_id && (
                    <MetaBit label="Installer ID" value={selected.installer_id} />
                  )}
                  {selected.installer_directory && (
                    <MetaBit label="Installer URL" value={selected.installer_directory} />
                  )}
                </Stack>
              </Stack>
              <Stack direction="column" spacing={1} alignItems={{ xs: 'flex-start', md: 'flex-end' }}>
                <Chip
                  label={statusChipProps(selected.status).label}
                  sx={{
                    bgcolor: statusChipProps(selected.status).bgcolor,
                    color: statusChipProps(selected.status).color,
                    fontWeight: 500,
                  }}
                />
                {selectedIsAnnual && (
                  <Chip
                    label={selectedIsPending ? 'Annual payer (pending)' : 'Annual payer · amortized'}
                    size="small"
                    sx={{
                      bgcolor: selectedIsPending ? 'rgba(245, 158, 11, 0.18)' : 'rgba(44, 115, 255, 0.18)',
                      color: selectedIsPending ? 'warning.main' : 'primary.main',
                      fontWeight: 500,
                    }}
                  />
                )}
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <FormControlLabel
                    sx={{ m: 0 }}
                    control={
                      <Switch
                        size="small"
                        checked={selectedIsAnnual}
                        onChange={(_, v) => toggleAnnual(v)}
                      />
                    }
                    label={
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        Annual payer
                      </Typography>
                    }
                  />
                  <InfoIcon info={<><strong>What it does:</strong> Flags this customer as paying annually upfront. The snapshot builder amortizes their large annual payment as amount/12 across the 12 months starting the payment date, so monthly MRR doesn't spike.<br /><br /><strong>Pending changes</strong> live in your browser until Claude rebuilds snapshots — once applied, this chip turns blue.</>} />
                </Stack>
                {selected.failed_3mo_count > 0 && (
                  <Typography variant="caption" sx={{ color: 'error.main' }}>
                    {selected.failed_3mo_count} failed charge{selected.failed_3mo_count === 1 ? '' : 's'} in last 3 months · {USD0.format(selected.failed_3mo_amount)}
                  </Typography>
                )}
              </Stack>
            </Stack>
          </Paper>

          {/* Churn analysis panel — reads from churn_inferences.json (AI-classified reasons)
              and churn_subpatterns.json (finer-grained tags), plus any local override the user
              has staged. Only renders for churned customers — non-churned have nothing to analyze. */}
          {selected.status === 'churned' && (() => {
            const customerKey = String(selected.allmoxy_customer_id);
            const inf = inferences?.customers.find((c) => c.allmoxy_customer_id === selected.allmoxy_customer_id) ?? null;
            const subTags = subpatterns?.customer_subpatterns?.[customerKey] ?? [];
            const subDefs = subpatterns?.subpattern_definitions ?? {};
            const override = churnOverrides[customerKey];
            // Effective reason picks: override > HubSpot > AI inference > none.
            const baseReason = (selected.churn_reason ?? '').trim();
            const effectiveReason = override?.reason || baseReason || inf?.suggested_reason || '';
            const effectiveEvidence = override?.evidence
              || inf?.evidence_quote
              || '';
            const reasonSource: 'override' | 'hubspot' | 'ai' | 'none' = override?.reason
              ? 'override'
              : baseReason
                ? 'hubspot'
                : inf?.suggested_reason
                  ? 'ai'
                  : 'none';
            return (
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
            );
          })()}

          {/* Lifetime stats */}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={6} md={2.4}>
              <StatCard label="Lifetime revenue" value={USD0.format(selected.lifetime_total)} hint="All streams combined" info={<><strong>What it is:</strong> Total succeeded Stripe revenue from this customer across their entire relationship — subscription + services + connect + other.<br /><br /><strong>Data:</strong> Sum of all succeeded Stripe charges from the Stripe Sync tab, aggregated per customer.</>} />
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <StatCard label="Lifetime subscription" value={USD0.format(selected.lifetime_subscription)} hint={`${((selected.lifetime_subscription / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`} info={<><strong>What it is:</strong> Total subscription dollars this customer has paid.<br /><br /><strong>Data:</strong> Succeeded Stripe charges where transaction_type = "subscription".</>} />
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <StatCard label="Lifetime services" value={USD0.format(selected.lifetime_services)} hint={`${((selected.lifetime_services / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`} info={<><strong>What it is:</strong> Total services/project dollars this customer has paid.<br /><br /><strong>Data:</strong> Succeeded Stripe charges where transaction_type = "services".</>} />
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <StatCard label="Lifetime Connect fees" value={USD0.format(selected.lifetime_connect)} hint={`${((selected.lifetime_connect / Math.max(selected.lifetime_total, 1)) * 100).toFixed(0)}% of lifetime`} info={<><strong>What it is:</strong> Total affiliate/connect fees Allmoxy has earned from this customer's Stripe Connect transactions.<br /><br /><strong>Data:</strong> Sum of per-month fees from the 2024/2025/2026 Stripe Connect Revenue sheets, matched by customer name.</>} />
            </Grid>
            <Grid item xs={12} sm={6} md={2.4}>
              <StatCard label={`${monthLabel(selected.latest_month)} MRR`} value={USD0.format(selected.current_subscription_mrr)} hint={selected.current_subscription_mrr > 0 ? 'Currently paying' : 'Not paying this month'} info={<><strong>What it is:</strong> This customer's subscription MRR in the latest complete month.<br /><br /><strong>Data:</strong> Looked up in the MRR by Month tab for the reference month shown.</>} />
            </Grid>
          </Grid>

          {/* Churn Risk Health Score */}
          {(() => {
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
              <Paper sx={{ p: 3, mb: 3, borderLeft: '4px solid', borderColor: tierColor }}>
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
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10 }}>Signal breakdown</Typography>
                    <Box component="table" sx={{ mt: 0.5, width: '100%', borderCollapse: 'collapse', '& td, & th': { borderBottom: '1px solid', borderColor: 'divider', py: 0.5, fontSize: 12, textAlign: 'left' } }}>
                      <tbody>
                        <tr><td>1 · Order Volume</td><td style={{ color: '#6B7280' }}>{riskEntry.orders_detail}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{riskEntry.signal_1_orders >= 0 ? '+' : ''}{riskEntry.signal_1_orders}</td></tr>
                        <tr><td>2 · Launch Status</td><td style={{ color: '#6B7280' }}>{riskEntry.signal_2_detail || riskEntry.launch_status}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{riskEntry.signal_2_launch >= 0 ? '+' : ''}{riskEntry.signal_2_launch}</td></tr>
                        <tr><td>3 · Engagement Recency</td><td style={{ color: '#6B7280' }}>{riskEntry.days_since_last_contact != null ? `${riskEntry.days_since_last_contact}d since last contact` : 'No HubSpot recency data'}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{riskEntry.signal_3_recency >= 0 ? '+' : ''}{riskEntry.signal_3_recency}</td></tr>
                        <tr><td>4 · Risk Signals</td><td style={{ color: '#6B7280' }}>{riskEntry.signal_4_risk === 0 ? 'None recorded' : 'See notes scan'}</td><td style={{ textAlign: 'right', fontWeight: 600, color: riskEntry.signal_4_risk < 0 ? '#D63A4D' : undefined }}>{riskEntry.signal_4_risk}</td></tr>
                        <tr><td>5 · Tenure × Launch</td><td style={{ color: '#6B7280' }}>{selected.years_with_us != null ? `${selected.years_with_us.toFixed(1)}y tenure, ${riskEntry.launch_status}` : '—'}</td><td style={{ textAlign: 'right', fontWeight: 600, color: riskEntry.signal_5_tenure < 0 ? '#D63A4D' : undefined }}>{riskEntry.signal_5_tenure}</td></tr>
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

          {/* Monthly revenue timeline */}
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

          {/* Orders Verified Trends — per-year order count + invoice $. Joined
              from orders_verified.json which itself is built from the xlsx
              Raw Data tab. Only renders when this customer has order data. */}
          {(() => {
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
                  order_count: y.order_count || 0,
                  total_usd: total,
                  annualized,
                  is_partial: isCurrentYear && monthsLoaded < 12,
                };
              })
              .filter((r) => r.order_count > 0 || r.total_usd > 0)
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

          {/* Milestones + cohort context */}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} md={6}>
              <Paper sx={{ p: 3, height: '100%' }}>
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
            </Grid>
            <Grid item xs={12} md={6}>
              <Paper sx={{ p: 3, height: '100%' }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                    Cohort context
                  </Typography>
                  <InfoIcon info={<><strong>What it is:</strong> How this customer's signup-year cohort as a whole is performing — puts their lifetime in context of peers who joined the same year.<br /><br /><strong>Data:</strong> From the cohort_retention snapshot — counts of customers who joined in this cohort year and what % of them are still active today.</>} />
                </Stack>
                {cohortContext ? (
                  <Stack spacing={1.5}>
                    <Typography variant="body2">
                      <strong>{cohortContext.year} cohort</strong> — {cohortContext.initial} customers signed up, {cohortContext.active} still active today
                      {cohortContext.retentionPct != null ? ` (${cohortContext.retentionPct}% retention)` : ''}.
                    </Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      This customer contributes <strong>{USD0.format(selected.lifetime_total)}</strong> of lifetime revenue — one of {cohortContext.initial} cohort members.
                    </Typography>
                  </Stack>
                ) : (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    Cohort data not available for this customer.
                  </Typography>
                )}
              </Paper>
            </Grid>
          </Grid>

          {/* Transactions table (collapsed by default, click header to expand) */}
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
        </>
      )}
    </Box>
  );
}

function StatCard({
  label, value, hint, info,
}: { label: string; value: string | null; hint: string; info?: React.ReactNode }) {
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
          {label}
        </Typography>
        {info && <InfoIcon info={info} />}
      </Stack>
      {value == null ? (
        <Skeleton variant="text" width="60%" sx={{ fontSize: 28 }} />
      ) : (
        <Typography variant="h5" sx={{ fontWeight: 500, mt: 0.5 }}>
          {value}
        </Typography>
      )}
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 11 }}>
        {hint}
      </Typography>
    </Paper>
  );
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
