/**
 * Custom Report on the Allmoxy design system. Data logic is ported verbatim from the classic page
 * (CustomReport.tsx, kept at /custom-report-classic): same customer_profiles_roster snapshot,
 * same annual-payer and Connect-override lookups, same 34 fields, 8 filters (all must match),
 * 5 presets and the same "Sort by" rule (numbers biggest first, text A to Z, blanks last).
 * The classic page keeps no saved views or localStorage state, so neither does this one.
 *
 * Built from the shared parts: presets are text buttons, filters and the column chooser are
 * filter chips grouped by topic, the sort is the certified Select menu, and the report is a
 * DataTable whose Total row sums every money and count column.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import annualPayersConfig from '../data/annual_payer_ids.json';
import connectOverrides from '../data/connect_customer_overrides.json';
import { DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, Select, downloadCsv, usd } from '../design-system/parts';

type Profile = {
  allmoxy_customer_id: number; name: string; hubspot_company_id: string | null; installer_id: string | null;
  installer_directory: string | null; stripe_customer_ids: string[]; harvest_id: string | null;
  master_classification_name: string | null; sign_up_date: string | null; first_payment_date: string | null;
  last_payment_date: string | null; years_with_us: number | null; cohort_year: number | null;
  status: 'active' | 'at_risk' | 'non_payment' | 'paused' | 'churned' | 'never_paid'; active_today: boolean;
  lifetime_total: number; lifetime_subscription: number; lifetime_services: number; lifetime_connect: number; lifetime_other: number;
  current_subscription_mrr: number; current_services: number; current_connect: number; latest_month: string;
  failed_3mo_count: number; failed_3mo_amount: number; peak_month: string | null; peak_month_total: number; transaction_count: number;
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

// `sum` marks the columns the Total row adds up (money and counts; never IDs, years or rates).
type Field = { id: FieldId; label: string; group: string; numeric?: boolean; format?: 'usd' | 'pct' | 'date' | 'fee_pct'; sum?: boolean };

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

  { id: 'lifetime_total', label: 'Lifetime total', group: 'Lifetime revenue', numeric: true, format: 'usd', sum: true },
  { id: 'lifetime_subscription', label: 'Lifetime subscription', group: 'Lifetime revenue', numeric: true, format: 'usd', sum: true },
  { id: 'lifetime_services', label: 'Lifetime services', group: 'Lifetime revenue', numeric: true, format: 'usd', sum: true },
  { id: 'lifetime_connect', label: 'Lifetime Connect fees', group: 'Lifetime revenue', numeric: true, format: 'usd', sum: true },
  { id: 'lifetime_other', label: 'Lifetime other', group: 'Lifetime revenue', numeric: true, format: 'usd', sum: true },

  { id: 'current_subscription_mrr', label: 'Current MRR', group: 'Current month', numeric: true, format: 'usd', sum: true },
  { id: 'current_services', label: 'Current services $', group: 'Current month', numeric: true, format: 'usd', sum: true },
  { id: 'current_connect', label: 'Current Connect $', group: 'Current month', numeric: true, format: 'usd', sum: true },

  { id: 'transaction_count', label: '# Stripe charges', group: 'Advanced', numeric: true, sum: true },
  { id: 'peak_month', label: 'Peak month', group: 'Advanced' },
  { id: 'peak_month_total', label: 'Peak month total', group: 'Advanced', numeric: true, format: 'usd', sum: true },
  { id: 'failed_3mo_count', label: '# Failed charges (3mo)', group: 'Advanced', numeric: true, sum: true },
  { id: 'failed_3mo_amount', label: 'Failed charge $ (3mo)', group: 'Advanced', numeric: true, format: 'usd', sum: true },
  { id: 'stripe_fee_percent', label: 'Stripe fee %', group: 'Advanced', numeric: true, format: 'fee_pct' },
];

const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));
const GROUP_ORDER = ['Identity', 'Dates', 'Status', 'Lifetime revenue', 'Current month', 'Advanced'];

type FilterId = 'active' | 'has_subscription' | 'has_connect' | 'has_services' | 'has_installer' | 'has_hubspot' | 'annual_payers' | 'with_failed';
type Ctx = { annualIds: Set<number>; connectSourceById: Map<number, string>; connectAcctById: Map<number, string> };

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

type Preset = { id: string; label: string; description: string; fields: FieldId[]; filters: FilterId[] };

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
    description: 'Every customer in the canonical customer base (active today — duplicates excluded) with MRR, lifetime, tenure. Ties to the headline customer count and MRR.',
    fields: ['allmoxy_customer_id', 'name', 'current_subscription_mrr', 'lifetime_total', 'years_with_us', 'sign_up_date', 'cohort_year'],
    // active_today = customer_base membership. 'MRR > 0' also matched a duplicate
    // profile row (excluded_from_logo_count) carrying MRR, giving 199 vs the base's 198.
    filters: ['active'],
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

const STATUS_TAG: Record<string, { label: string; tone: 'success' | 'warning' | 'error' | 'info' | 'neutral' }> = {
  active: { label: 'Active', tone: 'success' },
  at_risk: { label: 'At risk', tone: 'warning' },
  non_payment: { label: 'Not paying', tone: 'error' },
  paused: { label: 'Paused', tone: 'info' },
  churned: { label: 'Churned', tone: 'error' },
  never_paid: { label: 'Never paid', tone: 'neutral' },
};

function formatDateMDY(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}

function renderCell(field: Field, value: unknown): ReactNode {
  if (value == null || value === '') return '—';
  if (field.id === 'stripe_customer_ids' && Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ');
  if (field.format === 'usd' && typeof value === 'number') return usd(value);
  if (field.format === 'fee_pct' && typeof value === 'number') return `${value.toFixed(2)}%`;
  if (field.format === 'date' && typeof value === 'string') return formatDateMDY(value);
  if (field.id === 'active_today' || field.id === 'annual_payer') return value ? 'Yes' : 'No';
  if (field.id === 'status' && typeof value === 'string') {
    const s = STATUS_TAG[value];
    return s ? <span className={`am-tag am-tag--${s.tone}`}>{s.label}</span> : value;
  }
  // IDs and years read as plain numbers (no thousands separator).
  if (typeof value === 'number') return field.id === 'allmoxy_customer_id' || field.id === 'cohort_year' ? String(value) : value.toLocaleString();
  return String(value);
}

function exportCell(field: Field, value: unknown): string | number {
  if (field.id === 'stripe_customer_ids' && Array.isArray(value)) return value.join('; ');
  if (field.id === 'active_today' || field.id === 'annual_payer') return value ? 'Yes' : 'No';
  if (value == null) return '';
  return typeof value === 'number' ? value : String(value);
}

function sortValue(v: unknown): string | number | null {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v == null || v === '') return null;
  return typeof v === 'number' ? v : String(v).toLowerCase();
}

const LIMIT = 25;
type Decorated = Profile & { annual_payer: boolean; connect_source_name: string; stripe_connect_account_id: string };

export default function CustomReportDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('customer_profiles_roster');
  const snap = data as unknown as { rows: Profile[] } | undefined;
  const profiles = useMemo(() => snap?.rows ?? [], [snap]);

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
  const [presetId, setPresetId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  function toggleField(id: FieldId) {
    const next = new Set(selectedFields);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedFields(next); setPresetId(null);
  }
  function toggleFilter(id: FilterId) {
    const next = new Set(activeFilters);
    if (next.has(id)) next.delete(id); else next.add(id);
    setActiveFilters(next); setPresetId(null); setShowAll(false);
  }
  function setGroup(group: string, on: boolean) {
    const next = new Set(selectedFields);
    for (const f of FIELDS) if (f.group === group) { if (on) next.add(f.id); else next.delete(f.id); }
    setSelectedFields(next); setPresetId(null);
  }
  function applyPreset(preset: Preset) {
    setSelectedFields(new Set(preset.fields));
    setActiveFilters(new Set(preset.filters));
    setSortField(preset.fields.find((f) => FIELD_BY_ID.get(f)?.numeric) ?? preset.fields[0] ?? '');
    setPresetId(preset.id); setShowAll(false);
  }
  function clearAll() {
    setSelectedFields(new Set());
    setActiveFilters(new Set());
    setPresetId(null); setShowAll(false);
  }

  const orderedFieldIds = FIELDS.filter((f) => selectedFields.has(f.id)).map((f) => f.id);
  const orderedFields = orderedFieldIds.map((id) => FIELD_BY_ID.get(id)!);

  const rows = useMemo(() => {
    const ctx: Ctx = { annualIds, connectSourceById, connectAcctById };
    const filters = FILTERS.filter((f) => activeFilters.has(f.id));
    return profiles.filter((p) => filters.every((f) => f.predicate(p, ctx)));
  }, [profiles, activeFilters, annualIds, connectSourceById, connectAcctById]);

  const decoratedRows = useMemo<Decorated[]>(() => rows.map((p) => ({
    ...p,
    annual_payer: annualIds.has(p.allmoxy_customer_id),
    connect_source_name: connectSourceById.get(p.allmoxy_customer_id) ?? '',
    stripe_connect_account_id: connectAcctById.get(p.allmoxy_customer_id) ?? '',
  })), [rows, annualIds, connectSourceById, connectAcctById]);

  // The classic "Sort by" rule, verbatim: numeric fields biggest first, text A to Z, blanks last.
  const sortedRows = useMemo(() => {
    if (!sortField || !selectedFields.has(sortField)) return decoratedRows;
    const field = FIELD_BY_ID.get(sortField);
    const copy = [...decoratedRows];
    copy.sort((a, b) => {
      const va = a[sortField as keyof Decorated] as unknown;
      const vb = b[sortField as keyof Decorated] as unknown;
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

  const get = (r: Decorated, id: FieldId) => (r as unknown as Record<string, unknown>)[id];
  const sums = useMemo(() => {
    const m = new Map<FieldId, number>();
    for (const f of orderedFields) if (f.sum) m.set(f.id, sortedRows.reduce((s, r) => s + (Number(get(r, f.id)) || 0), 0));
    return m;
  }, [orderedFields, sortedRows]);
  const kpi = useMemo(() => ({
    mrr: sortedRows.reduce((s, r) => s + (r.current_subscription_mrr || 0), 0),
    life: sortedRows.reduce((s, r) => s + (r.lifetime_total || 0), 0),
  }), [sortedRows]);

  const list = showAll ? sortedRows : sortedRows.slice(0, LIMIT);
  const filename = `custom_report_${new Date().toISOString().slice(0, 10)}`;
  const exportCsv = () => downloadCsv(filename, orderedFields.map((f) => f.label),
    sortedRows.map((r) => orderedFields.map((f) => exportCell(f, get(r, f.id)))));

  const fmtSum = (f: Field, v: number) => (f.format === 'usd' ? usd(v) : v.toLocaleString());
  const foot = orderedFields.map((f, j) => {
    const s = sums.get(f.id);
    const val = s != null ? fmtSum(f, s) : '';
    if (j === 0) return s != null ? `Total ${val}` : `Total · ${sortedRows.length} customers`;
    return val;
  });
  const nameCol = orderedFieldIds.indexOf('name');
  const preset = PRESETS.find((p) => p.id === presetId);
  const canExpand = !showAll && sortedRows.length > LIMIT;

  return (
    <DsPage
      path="/custom-report"
      title="Custom Report"
      subtitle="Build your own view of the customer roster: start from a preset or pick the columns and filters, then sort, scan and export to CSV for spreadsheet work."
      actions={<>
        <button className="am-btn am-btn--text" onClick={clearAll}><Icon name="close" />Clear</button>
        <button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!sortedRows.length || !orderedFields.length}><Icon name="download" />Export CSV</button>
      </>}
    >
      {error ? <p className="am-card__text">Failed to load customer_profiles_roster: {String(error)}</p> : null}

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Quick presets</span>
          <span className="am-chart__caption">{preset ? preset.description : 'Each preset sets the columns, filters and sort in one click.'}</span>
        </div>
        <div className="am-row am-row--wrap">
          {PRESETS.map((p) => (
            <button key={p.id} className={`am-btn ${p.id === presetId ? 'am-btn--filled' : 'am-btn--outlined'}`} aria-pressed={p.id === presetId}
              title={p.description} onClick={() => applyPreset(p)}>{p.label}</button>
          ))}
        </div>
      </section>

      <KpiGrid max={3}>
        <KpiCard label="Customers in this report" value={isLoading ? '…' : sortedRows.length.toLocaleString()}
          hint={`of ${profiles.length.toLocaleString()} in the roster · ${activeFilters.size} filter${activeFilters.size === 1 ? '' : 's'} on`} />
        <KpiCard label="Current MRR of these customers" value={isLoading ? '…' : usd(kpi.mrr)} hint="Sum of current subscription MRR" />
        <KpiCard label="Lifetime revenue of these customers" value={isLoading ? '…' : usd(kpi.life)} hint="Sum of lifetime total" />
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Filters ({activeFilters.size} active)</span>
          <span className="am-chart__caption">A customer must match every filter that is on.</span>
        </div>
        <div className="am-row am-row--wrap">
          {FILTERS.map((f) => <FilterChip key={f.id} checked={activeFilters.has(f.id)} onChange={() => toggleFilter(f.id)}>{f.label}</FilterChip>)}
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Sort by</span>
          <Select label="Sort by" width={260} value={sortField} onPick={(v) => setSortField(v as FieldId | '')}
            options={[['', 'None'], ...orderedFieldIds.map((id) => [id, FIELD_BY_ID.get(id)!.label] as [string, string])]} />
          <span className="am-card__text">{isLoading ? 'Loading…' : `${sortedRows.length} row${sortedRows.length === 1 ? '' : 's'} match`}</span>
        </div>
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Columns ({selectedFields.size} selected)</span>
          <span className="am-chart__caption">Columns appear in the order listed here.</span>
        </div>
        {GROUP_ORDER.map((group) => {
          const fs = FIELDS.filter((f) => f.group === group);
          const allOn = fs.every((f) => selectedFields.has(f.id));
          return (
            <div key={group} className="am-row" style={{ alignItems: 'flex-start' }}>
              <span className="am-card__text" style={{ width: 130, flexShrink: 0, paddingTop: 6 }}><b>{group}</b></span>
              <div className="am-row am-row--wrap" style={{ flex: 1, minWidth: 0 }}>
                {fs.map((f) => <FilterChip key={f.id} checked={selectedFields.has(f.id)} onChange={() => toggleField(f.id)}>{f.label}</FilterChip>)}
                <button className="am-btn am-btn--text" onClick={() => setGroup(group, !allOn)}>{allOn ? 'None' : 'All'}</button>
              </div>
            </div>
          );
        })}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">Custom report</span>
            <span className="am-chart__caption">
              {sortedRows.length} customer{sortedRows.length === 1 ? '' : 's'} · {orderedFieldIds.length} column{orderedFieldIds.length === 1 ? '' : 's'} · click a header to re-sort{nameCol >= 0 ? ', a name to open the customer' : ''}
            </span>
          </div>
          <button className="am-btn am-btn--text" onClick={exportCsv} disabled={!sortedRows.length || !orderedFields.length}><Icon name="download" />Export CSV</button>
        </div>
        {isLoading ? <p className="am-card__text">Loading the roster…</p>
          : selectedFields.size === 0 ? <p className="am-card__text">Pick at least one column above, or click a preset, to start building your report.</p>
          : sortedRows.length === 0 ? <p className="am-card__text">No rows to show.</p>
          : (
            <div style={{ overflowX: 'auto' }}>
              <DataTable key={orderedFieldIds.join(',')} label="Custom report"
                cols={orderedFields.map((f) => [f.label, !!f.numeric] as [string, boolean])}
                rows={list.map((r) => orderedFields.map((f) => renderCell(f, get(r, f.id))))}
                sortValues={list.map((r) => orderedFields.map((f) => sortValue(get(r, f.id))))}
                clickable={(c) => c === nameCol}
                onCell={(i) => navigate(`/customer-detail?id=${encodeURIComponent(String(list[i].allmoxy_customer_id))}`)}
                foot={foot}
                onFoot={() => setShowAll(true)}
                footClickable={(c) => canExpand && (c === 0 || sums.has(orderedFieldIds[c]))} />
            </div>
          )}
        {canExpand && orderedFields.length > 0 && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {sortedRows.length}</button>}
        {showAll && sortedRows.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show top {LIMIT}</button>}
      </section>
    </DsPage>
  );
}
