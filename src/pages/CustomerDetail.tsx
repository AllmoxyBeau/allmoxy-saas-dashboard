import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import Alert from '@mui/material/Alert';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import { useSheetTab } from '../hooks/useSheetTab';
import annualPayersConfig from '../data/annual_payers.json';

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

function statusChipProps(status: CustomerProfile['status']) {
  if (status === 'active') return { label: 'Active', bgcolor: 'rgba(26, 158, 92, 0.18)', color: 'success.main' } as const;
  if (status === 'at_risk') return { label: 'At risk · dunning', bgcolor: 'rgba(245, 158, 11, 0.18)', color: 'warning.main' } as const;
  return { label: 'Churned', bgcolor: 'rgba(218, 54, 51, 0.18)', color: 'error.main' } as const;
}

export default function CustomerDetail() {
  const { data, isLoading } = useSheetTab('customer_profiles');
  const { data: cohortData } = useSheetTab('cohort_retention');
  const snap = data as unknown as { rows: CustomerProfile[] } | undefined;
  const cohort = cohortData as unknown as CohortSnap | undefined;

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingMap>(() => readPending());

  const customers = snap?.rows ?? [];
  const selected = useMemo(
    () => (selectedId != null ? customers.find((c) => c.allmoxy_customer_id === selectedId) ?? null : null),
    [customers, selectedId]
  );

  useEffect(() => {
    if (selectedId == null && customers.length > 0) {
      setSelectedId(customers[0].allmoxy_customer_id);
    }
  }, [customers, selectedId]);

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

  const pendingEntries = Object.entries(pending);

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

      {/* Search / customer picker */}
      <Paper sx={{ p: 2.5, mb: 3 }}>
        <Autocomplete
          options={sortedForSearch}
          filterOptions={filterCustomers}
          getOptionLabel={(o) => o.name}
          value={selected}
          onChange={(_, v) => setSelectedId(v?.allmoxy_customer_id ?? null)}
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
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  Allmoxy ID {selected.allmoxy_customer_id}
                  {selected.installer_directory ? ` · ${selected.installer_directory}.allmoxy.com` : ''}
                  {selected.hubspot_company_id ? ` · HubSpot ${selected.hubspot_company_id}` : ''}
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
                      contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6 }}
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

          {/* Milestones + cohort context */}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} md={6}>
              <Paper sx={{ p: 3, height: '100%' }}>
                <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 2 }}>
                  Milestones
                </Typography>
                <Stack spacing={1}>
                  <Milestone label="Signed up" date={selected.sign_up_date} />
                  <Milestone label="First payment" date={selected.first_payment_date} />
                  {selected.peak_month && (
                    <Milestone
                      label={`Peak month · ${USD0.format(selected.peak_month_total)}`}
                      date={`${selected.peak_month}-01`}
                      subtitle={monthLabelLong(selected.peak_month)}
                    />
                  )}
                  <Milestone label="Last payment" date={selected.last_payment_date} />
                </Stack>
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

          {/* Transactions table */}
          <DrillDownPanel<Record<string, unknown>>
            title={`Transactions · ${selected.name}`}
            subtitle={`${selected.transaction_count.toLocaleString()} Stripe charges · sortable, CSV-exportable`}
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
            onClose={() => setSelectedId(null)}
          />
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

function Milestone({ label, date, subtitle }: { label: string; date: string | null; subtitle?: string }) {
  return (
    <Stack direction="row" spacing={2} alignItems="center">
      <Box sx={{ width: 6, height: 6, bgcolor: 'primary.main', borderRadius: '50%' }} />
      <Stack>
        <Typography variant="body2">{label}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {subtitle ?? (date ? formatDateMDY(date) : '—')}
        </Typography>
      </Stack>
    </Stack>
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
