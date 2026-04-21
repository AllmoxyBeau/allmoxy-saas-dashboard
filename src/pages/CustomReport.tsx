import { useMemo, useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import { useSheetTab } from '../hooks/useSheetTab';
import annualPayersConfig from '../data/annual_payers.json';
import connectOverrides from '../data/connect_customer_overrides.json';

type Profile = {
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
};

type FieldId =
  | 'allmoxy_customer_id' | 'name' | 'master_classification_name'
  | 'hubspot_company_id' | 'installer_id' | 'installer_directory' | 'harvest_id'
  | 'stripe_customer_ids' | 'connect_source_name' | 'stripe_connect_account_id'
  | 'sign_up_date' | 'first_payment_date' | 'last_payment_date' | 'years_with_us' | 'cohort_year'
  | 'status' | 'active_today' | 'annual_payer'
  | 'lifetime_total' | 'lifetime_subscription' | 'lifetime_services' | 'lifetime_connect' | 'lifetime_other'
  | 'current_subscription_mrr' | 'current_services' | 'current_connect'
  | 'transaction_count' | 'peak_month' | 'peak_month_total' | 'failed_3mo_count' | 'failed_3mo_amount'
  | 'stripe_fee_percent';

type Field = { id: FieldId; label: string; group: string; numeric?: boolean; format?: 'usd' | 'pct' | 'date' | 'fee_pct' };

const FIELDS: Field[] = [
  { id: 'allmoxy_customer_id', label: 'Allmoxy ID', group: 'Identity', numeric: true },
  { id: 'name', label: 'Customer name', group: 'Identity' },
  { id: 'master_classification_name', label: 'Master classification name', group: 'Identity' },
  { id: 'hubspot_company_id', label: 'HubSpot company ID', group: 'Identity' },
  { id: 'installer_id', label: 'Installer ID', group: 'Identity' },
  { id: 'installer_directory', label: 'Installer directory', group: 'Identity' },
  { id: 'harvest_id', label: 'Harvest ID', group: 'Identity' },
  { id: 'stripe_customer_ids', label: 'Stripe customer IDs', group: 'Identity' },
  { id: 'connect_source_name', label: 'Connect source name', group: 'Identity' },
  { id: 'stripe_connect_account_id', label: 'Stripe Connect account ID', group: 'Identity' },

  { id: 'sign_up_date', label: 'Sign-up date', group: 'Dates', format: 'date' },
  { id: 'first_payment_date', label: 'First payment', group: 'Dates', format: 'date' },
  { id: 'last_payment_date', label: 'Last payment', group: 'Dates', format: 'date' },
  { id: 'years_with_us', label: 'Years with us', group: 'Dates', numeric: true },
  { id: 'cohort_year', label: 'Cohort year', group: 'Dates', numeric: true },

  { id: 'status', label: 'Status', group: 'Status' },
  { id: 'active_today', label: 'Active today', group: 'Status' },
  { id: 'annual_payer', label: 'Annual payer', group: 'Status' },

  { id: 'lifetime_total', label: 'Lifetime total', group: 'Lifetime revenue', numeric: true, format: 'usd' },
  { id: 'lifetime_subscription', label: 'Lifetime subscription', group: 'Lifetime revenue', numeric: true, format: 'usd' },
  { id: 'lifetime_services', label: 'Lifetime services', group: 'Lifetime revenue', numeric: true, format: 'usd' },
  { id: 'lifetime_connect', label: 'Lifetime Connect fees', group: 'Lifetime revenue', numeric: true, format: 'usd' },
  { id: 'lifetime_other', label: 'Lifetime other', group: 'Lifetime revenue', numeric: true, format: 'usd' },

  { id: 'current_subscription_mrr', label: 'Current MRR', group: 'Current month', numeric: true, format: 'usd' },
  { id: 'current_services', label: 'Current services $', group: 'Current month', numeric: true, format: 'usd' },
  { id: 'current_connect', label: 'Current Connect $', group: 'Current month', numeric: true, format: 'usd' },

  { id: 'transaction_count', label: '# Stripe charges', group: 'Advanced', numeric: true },
  { id: 'peak_month', label: 'Peak month', group: 'Advanced' },
  { id: 'peak_month_total', label: 'Peak month total', group: 'Advanced', numeric: true, format: 'usd' },
  { id: 'failed_3mo_count', label: '# Failed charges (3mo)', group: 'Advanced', numeric: true },
  { id: 'failed_3mo_amount', label: 'Failed charge $ (3mo)', group: 'Advanced', numeric: true, format: 'usd' },
  { id: 'stripe_fee_percent', label: 'Stripe fee %', group: 'Advanced', numeric: true, format: 'fee_pct' },
];

const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));
const GROUP_ORDER = ['Identity', 'Dates', 'Status', 'Lifetime revenue', 'Current month', 'Advanced'];

type FilterId = 'active' | 'has_subscription' | 'has_connect' | 'has_services' | 'has_installer' | 'has_hubspot' | 'annual_payers' | 'with_failed';

const FILTERS: { id: FilterId; label: string; predicate: (p: Profile, ctx: Ctx) => boolean }[] = [
  { id: 'active', label: 'Active today', predicate: (p) => p.active_today },
  { id: 'has_subscription', label: 'Paying MRR right now', predicate: (p) => p.current_subscription_mrr > 0 },
  { id: 'has_connect', label: 'Has Connect fees (lifetime)', predicate: (p) => p.lifetime_connect > 0 },
  { id: 'has_services', label: 'Has Services revenue (lifetime)', predicate: (p) => p.lifetime_services > 0 },
  { id: 'has_installer', label: 'Has installer ID', predicate: (p) => !!p.installer_id },
  { id: 'has_hubspot', label: 'Has HubSpot ID', predicate: (p) => !!p.hubspot_company_id },
  { id: 'annual_payers', label: 'Annual payer', predicate: (p, ctx) => ctx.annualIds.has(p.allmoxy_customer_id) },
  { id: 'with_failed', label: 'Had failed charges (last 3mo)', predicate: (p) => p.failed_3mo_count > 0 },
];

type Ctx = {
  annualIds: Set<number>;
  connectSourceById: Map<number, string>;
  connectAcctById: Map<number, string>;
};

type Preset = {
  id: string;
  label: string;
  description: string;
  fields: FieldId[];
  filters: FilterId[];
};

const PRESETS: Preset[] = [
  {
    id: 'connect_prep',
    label: 'Connect account ID prep',
    description: 'Export installer ID + directory + Connect source name for customers with Connect fees — paste into a sheet to attach acct_ IDs.',
    fields: ['allmoxy_customer_id', 'name', 'installer_id', 'installer_directory', 'connect_source_name', 'stripe_connect_account_id', 'lifetime_connect', 'current_connect'],
    filters: ['has_connect'],
  },
  {
    id: 'active_roster',
    label: 'Active paying roster',
    description: 'Every currently-paying customer with MRR, lifetime, tenure.',
    fields: ['allmoxy_customer_id', 'name', 'current_subscription_mrr', 'lifetime_total', 'years_with_us', 'sign_up_date', 'cohort_year'],
    filters: ['has_subscription'],
  },
  {
    id: 'dunning',
    label: 'Dunning list',
    description: 'Customers with failed charges in the last 3 months.',
    fields: ['allmoxy_customer_id', 'name', 'failed_3mo_count', 'failed_3mo_amount', 'current_subscription_mrr', 'last_payment_date'],
    filters: ['with_failed'],
  },
  {
    id: 'full_identity',
    label: 'Full identity export',
    description: 'Every ID field for every customer — useful for cross-system reconciliation.',
    fields: ['allmoxy_customer_id', 'name', 'hubspot_company_id', 'installer_id', 'installer_directory', 'harvest_id', 'stripe_customer_ids', 'connect_source_name', 'stripe_connect_account_id'],
    filters: [],
  },
  {
    id: 'annual_payers',
    label: 'Annual payers',
    description: 'Customers flagged as annual pre-payers (amortized by the builder).',
    fields: ['allmoxy_customer_id', 'name', 'lifetime_subscription', 'last_payment_date', 'current_subscription_mrr'],
    filters: ['annual_payers'],
  },
];

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function formatDateMDY(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}

function renderCell(field: Field, value: unknown): ReactNode {
  if (value == null || value === '') return '—';
  if (field.id === 'stripe_customer_ids' && Array.isArray(value)) {
    return value.length === 0 ? '—' : value.join(', ');
  }
  if (field.format === 'usd' && typeof value === 'number') return USD0.format(value);
  if (field.format === 'fee_pct' && typeof value === 'number') return `${value.toFixed(2)}%`;
  if (field.format === 'date' && typeof value === 'string') return formatDateMDY(value);
  if (field.id === 'active_today' || field.id === 'annual_payer') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}

function exportCell(field: Field, value: unknown): unknown {
  if (field.id === 'stripe_customer_ids' && Array.isArray(value)) return value.join('; ');
  if (field.id === 'active_today' || field.id === 'annual_payer') return value ? 'Yes' : 'No';
  return value ?? '';
}

export default function CustomReport() {
  const { data, isLoading } = useSheetTab('customer_profiles_roster');
  const snap = data as unknown as { rows: Profile[] } | undefined;
  const profiles = snap?.rows ?? [];

  const annualIds = useMemo(() => new Set<number>(annualPayersConfig.annual_payer_ids), []);
  const connectSourceById = useMemo(() => {
    const m = new Map<number, string>();
    for (const [name, id] of Object.entries(connectOverrides.mapping)) m.set(id as number, name);
    return m;
  }, []);
  const connectAcctById = useMemo(() => {
    const m = new Map<number, string>();
    const src = (connectOverrides as { stripe_connect_account_ids_by_id?: Record<string, string> }).stripe_connect_account_ids_by_id ?? {};
    for (const [id, acct] of Object.entries(src)) {
      if (id.startsWith('_') || !acct || typeof acct !== 'string' || !acct.startsWith('acct_')) continue;
      const n = Number(id);
      if (Number.isFinite(n)) m.set(n, acct);
    }
    return m;
  }, []);

  const [selectedFields, setSelectedFields] = useState<Set<FieldId>>(
    new Set(['allmoxy_customer_id', 'name', 'installer_id', 'installer_directory', 'lifetime_connect'])
  );
  const [activeFilters, setActiveFilters] = useState<Set<FilterId>>(new Set());
  const [sortField, setSortField] = useState<FieldId | ''>('lifetime_total');

  function toggleField(id: FieldId) {
    const next = new Set(selectedFields);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedFields(next);
  }
  function toggleFilter(id: FilterId) {
    const next = new Set(activeFilters);
    if (next.has(id)) next.delete(id); else next.add(id);
    setActiveFilters(next);
  }
  function applyPreset(preset: Preset) {
    setSelectedFields(new Set(preset.fields));
    setActiveFilters(new Set(preset.filters));
    setSortField(preset.fields.find((f) => FIELD_BY_ID.get(f)?.numeric) ?? preset.fields[0] ?? '');
  }
  function clearAll() {
    setSelectedFields(new Set());
    setActiveFilters(new Set());
  }

  const orderedFieldIds = FIELDS.filter((f) => selectedFields.has(f.id)).map((f) => f.id);

  const rows = useMemo(() => {
    const ctx: Ctx = { annualIds, connectSourceById, connectAcctById };
    const filters = FILTERS.filter((f) => activeFilters.has(f.id));
    return profiles.filter((p) => filters.every((f) => f.predicate(p, ctx)));
  }, [profiles, activeFilters, annualIds, connectSourceById]);

  const decoratedRows = useMemo(
    () =>
      rows.map((p) => ({
        ...p,
        annual_payer: annualIds.has(p.allmoxy_customer_id),
        connect_source_name: connectSourceById.get(p.allmoxy_customer_id) ?? '',
        stripe_connect_account_id: connectAcctById.get(p.allmoxy_customer_id) ?? '',
      })),
    [rows, annualIds, connectSourceById, connectAcctById]
  );

  const columns: DrillColumn<Record<string, unknown>>[] = useMemo(() => {
    return orderedFieldIds.map((id) => {
      const field = FIELD_BY_ID.get(id)!;
      return {
        key: id,
        label: field.label,
        align: field.numeric ? 'right' : 'left',
        render: (r: Record<string, unknown>) => renderCell(field, r[id]),
        exportValue: (r: Record<string, unknown>) => exportCell(field, r[id]),
        sortValue: (r: Record<string, unknown>) => {
          const v = r[id];
          if (Array.isArray(v)) return v.length;
          if (typeof v === 'boolean') return v ? 1 : 0;
          return (v as string | number | null | undefined) ?? null;
        },
      };
    });
  }, [orderedFieldIds]);

  const sortedRows = useMemo(() => {
    if (!sortField || !selectedFields.has(sortField)) return decoratedRows;
    const field = FIELD_BY_ID.get(sortField);
    const copy = [...decoratedRows];
    copy.sort((a, b) => {
      const va = a[sortField as keyof typeof a] as unknown;
      const vb = b[sortField as keyof typeof b] as unknown;
      const na = typeof va === 'number' ? va : va == null ? null : String(va).toLowerCase();
      const nb = typeof vb === 'number' ? vb : vb == null ? null : String(vb).toLowerCase();
      if (na == null && nb == null) return 0;
      if (na == null) return 1;
      if (nb == null) return -1;
      if (field?.numeric) return (vb as number) - (va as number);
      return String(na).localeCompare(String(nb));
    });
    return copy;
  }, [decoratedRows, sortField, selectedFields]);

  const groupedFields: Record<string, Field[]> = {};
  for (const g of GROUP_ORDER) groupedFields[g] = [];
  for (const f of FIELDS) groupedFields[f.group].push(f);

  return (
    <Box>
      <PageHeader
        title="Custom Report"
        subtitle="Pick fields and filters to build a custom view of the 600-customer roster. Sort, scan, and export to CSV for spreadsheet work."
      />

      {/* Presets */}
      <Paper sx={{ p: 2.5, mb: 2 }}>
        <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          Quick presets
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {PRESETS.map((p) => (
            <Chip
              key={p.id}
              label={p.label}
              onClick={() => applyPreset(p)}
              title={p.description}
              sx={{ cursor: 'pointer', bgcolor: 'rgba(44, 115, 255, 0.12)', color: 'primary.main', '&:hover': { bgcolor: 'rgba(44, 115, 255, 0.2)' } }}
            />
          ))}
          <Button size="small" onClick={clearAll} sx={{ ml: 1 }}>
            Clear
          </Button>
        </Stack>
      </Paper>

      <Grid container spacing={2}>
        {/* Field picker */}
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 1.5 }}>
              Fields ({selectedFields.size} selected)
            </Typography>
            {GROUP_ORDER.map((group, idx) => (
              <Box key={group} sx={{ mb: 1.5 }}>
                {idx > 0 && <Divider sx={{ my: 1 }} />}
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>
                  {group}
                </Typography>
                <Stack sx={{ mt: 0.5 }}>
                  {groupedFields[group].map((f) => (
                    <FormControlLabel
                      key={f.id}
                      sx={{ m: 0 }}
                      control={
                        <Checkbox
                          size="small"
                          checked={selectedFields.has(f.id)}
                          onChange={() => toggleField(f.id)}
                        />
                      }
                      label={<Typography variant="body2">{f.label}</Typography>}
                    />
                  ))}
                </Stack>
              </Box>
            ))}
          </Paper>
        </Grid>

        {/* Filters + Sort + Table */}
        <Grid item xs={12} md={8}>
          <Stack spacing={2}>
            <Paper sx={{ p: 2.5 }}>
              <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 1.5 }}>
                Filters ({activeFilters.size} active)
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {FILTERS.map((f) => (
                  <Chip
                    key={f.id}
                    label={f.label}
                    onClick={() => toggleFilter(f.id)}
                    color={activeFilters.has(f.id) ? 'primary' : 'default'}
                    variant={activeFilters.has(f.id) ? 'filled' : 'outlined'}
                    sx={{ cursor: 'pointer' }}
                  />
                ))}
              </Stack>
              <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
                <FormControl size="small" sx={{ minWidth: 240 }}>
                  <InputLabel>Sort by</InputLabel>
                  <Select
                    label="Sort by"
                    value={sortField}
                    onChange={(e) => setSortField(e.target.value as FieldId | '')}
                  >
                    <MenuItem value="">None</MenuItem>
                    {orderedFieldIds.map((id) => (
                      <MenuItem key={id} value={id}>
                        {FIELD_BY_ID.get(id)?.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {isLoading ? 'Loading…' : `${sortedRows.length} row${sortedRows.length === 1 ? '' : 's'} match`}
                </Typography>
              </Stack>
            </Paper>

            {isLoading ? (
              <Skeleton variant="rectangular" height={360} />
            ) : selectedFields.size === 0 ? (
              <Paper sx={{ p: 4, textAlign: 'center' }}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Pick at least one field on the left, or click a preset above, to start building your report.
                </Typography>
              </Paper>
            ) : (
              <DrillDownPanel<Record<string, unknown>>
                title="Custom report"
                subtitle={`${sortedRows.length} customer${sortedRows.length === 1 ? '' : 's'} · ${orderedFieldIds.length} column${orderedFieldIds.length === 1 ? '' : 's'} · sortable · export CSV`}
                rows={sortedRows as unknown as Array<Record<string, unknown>>}
                columns={columns}
                filename={`custom_report_${new Date().toISOString().slice(0, 10)}`}
              />
            )}
          </Stack>
        </Grid>
      </Grid>
    </Box>
  );
}
