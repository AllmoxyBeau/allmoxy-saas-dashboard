import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import Chip from '@mui/material/Chip';
import Autocomplete from '@mui/material/Autocomplete';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import TablePagination from '@mui/material/TablePagination';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import PageHeader from '../components/common/PageHeader';
import CustomerLink from '../components/common/CustomerLink';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';
import HubSpotIdLink from '../components/common/HubSpotIdLink';

type Profile = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_company_id: string | null;
  installer_id: string | null;
  installer_directory: string | null;
  status: string;
  pay_status: string | null;
  primary_segment: string | null;
  instance_owner_first_name: string | null;
  instance_owner: string | null;
  current_subscription_mrr: number;
  lifetime_subscription: number;
  lifetime_total: number;
  years_with_us: number | null;
  cohort_year: number | null;
  sign_up_date: string | null;
  first_payment_date: string | null;
  last_payment_date: string | null;
  excluded_from_logo_count?: boolean;
};

type MatrixCustomer = {
  allmoxy_customer_id: number;
  tier: 'red' | 'yellow' | 'green' | 'unscored';
  total_score: number;
  arr_at_risk: number;
};

type MatrixSnap = { customers: MatrixCustomer[] };

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const TIER_COLOR: Record<string, string> = {
  red: '#D63A4D',
  yellow: '#F5A623',
  green: '#2D8F47',
  unscored: '#94a3b8',
};
const TIER_LABEL: Record<string, string> = {
  red: 'Critical',
  yellow: 'Watch',
  green: 'Healthy',
  unscored: '—',
};

function ownerName(p: Profile): string {
  return p.instance_owner_first_name?.trim() || p.instance_owner?.trim() || '';
}

function formatDateMDY(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}

type SortKey =
  | 'name'
  | 'aid'
  | 'installer_id'
  | 'status'
  | 'tier'
  | 'pay_status'
  | 'owner'
  | 'segment'
  | 'mrr'
  | 'lifetime'
  | 'tenure'
  | 'sign_up';

const TIER_RANK = { red: 0, yellow: 1, green: 2, unscored: 3 } as const;

export default function Customers() {
  const { data: profilesData, isLoading, error } = useSheetTab<Profile>('customer_profiles');
  const matrixQuery = useSheetTab<MatrixSnap>('churn_risk_matrix');
  // churn_risk_matrix snapshot has a non-rows shape — pull from the raw payload.
  const matrixRaw = matrixQuery.data as unknown as MatrixSnap | undefined;

  const tierById = useMemo(() => {
    const m = new Map<number, MatrixCustomer['tier']>();
    for (const c of matrixRaw?.customers ?? []) m.set(c.allmoxy_customer_id, c.tier);
    return m;
  }, [matrixRaw]);

  const [search, setSearch] = useState('');
  // Multi-select dropdown filter state. Empty array = no filter on that
  // facet. Switched from Set<string> (which was paired with chip strips) so
  // the Autocomplete value prop type matches and the lists are easier to
  // pass around / sort.
  const [tierFilter, setTierFilter] = useState<string[]>([]);
  const [payStatusFilter, setPayStatusFilter] = useState<string[]>([]);
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [segmentFilter, setSegmentFilter] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  // Memoized Sets so the per-row filter check is O(1) instead of O(n) per row.
  const tierSet = useMemo(() => new Set(tierFilter), [tierFilter]);
  const payStatusSet = useMemo(() => new Set(payStatusFilter), [payStatusFilter]);
  const ownerSet = useMemo(() => new Set(ownerFilter), [ownerFilter]);
  const segmentSet = useMemo(() => new Set(segmentFilter), [segmentFilter]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'name' || k === 'owner' || k === 'segment' || k === 'pay_status' ? 'asc' : 'desc');
    }
    setPage(0);
  }

  const profiles = profilesData?.rows ?? [];

  // Distinct values for filter dropdowns + per-value counts. Counts always
  // come from the unfiltered profile set so the dropdown shows the full
  // distribution, not the active-filter slice.
  const facets = useMemo(() => {
    const payStatuses = new Map<string, number>();
    const owners = new Map<string, number>();
    const segments = new Map<string, number>();
    for (const p of profiles) {
      if (p.pay_status) payStatuses.set(p.pay_status, (payStatuses.get(p.pay_status) ?? 0) + 1);
      const o = ownerName(p);
      if (o) owners.set(o, (owners.get(o) ?? 0) + 1);
      if (p.primary_segment) segments.set(p.primary_segment, (segments.get(p.primary_segment) ?? 0) + 1);
    }
    const sortByCount = (m: Map<string, number>) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    return {
      payStatuses: sortByCount(payStatuses),
      owners: sortByCount(owners),
      segments: sortByCount(segments),
    };
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (q) {
        const hay = `${p.name || ''} ${p.allmoxy_customer_id} ${p.installer_id || ''} ${p.installer_directory || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (payStatusSet.size > 0 && !payStatusSet.has(p.pay_status || '')) return false;
      if (tierSet.size > 0) {
        const t = tierById.get(p.allmoxy_customer_id) ?? 'unscored';
        if (!tierSet.has(t)) return false;
      }
      if (ownerSet.size > 0 && !ownerSet.has(ownerName(p))) return false;
      if (segmentSet.size > 0 && !segmentSet.has(p.primary_segment || '')) return false;
      return true;
    });
  }, [profiles, search, payStatusSet, tierSet, ownerSet, segmentSet, tierById]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (sortKey) {
        case 'name': av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); break;
        case 'aid': av = a.allmoxy_customer_id; bv = b.allmoxy_customer_id; break;
        case 'installer_id': av = Number(a.installer_id) || 0; bv = Number(b.installer_id) || 0; break;
        case 'status': av = a.status || ''; bv = b.status || ''; break;
        case 'tier':
          av = TIER_RANK[(tierById.get(a.allmoxy_customer_id) ?? 'unscored') as keyof typeof TIER_RANK] ?? 9;
          bv = TIER_RANK[(tierById.get(b.allmoxy_customer_id) ?? 'unscored') as keyof typeof TIER_RANK] ?? 9;
          break;
        case 'pay_status': av = (a.pay_status || '').toLowerCase(); bv = (b.pay_status || '').toLowerCase(); break;
        case 'owner': av = ownerName(a).toLowerCase() || '~'; bv = ownerName(b).toLowerCase() || '~'; break;
        case 'segment': av = (a.primary_segment || '').toLowerCase(); bv = (b.primary_segment || '').toLowerCase(); break;
        case 'mrr': av = a.current_subscription_mrr || 0; bv = b.current_subscription_mrr || 0; break;
        case 'lifetime': av = a.lifetime_subscription || 0; bv = b.lifetime_subscription || 0; break;
        case 'tenure': av = a.years_with_us ?? -1; bv = b.years_with_us ?? -1; break;
        case 'sign_up': av = a.sign_up_date || ''; bv = b.sign_up_date || ''; break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir, tierById]);

  const paged = useMemo(
    () => sorted.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [sorted, page, rowsPerPage]
  );

  // Totals for the strip
  const summary = useMemo(() => {
    const filteredMrr = filtered.reduce((s, p) => s + (p.current_subscription_mrr || 0), 0);
    const filteredLifetime = filtered.reduce((s, p) => s + (p.lifetime_subscription || 0), 0);
    return { count: filtered.length, mrr: filteredMrr, lifetime: filteredLifetime };
  }, [filtered]);

  const csvColumns = useMemo(
    () => ([
      { key: 'allmoxy_customer_id', label: 'Allmoxy ID', getValue: (p: Profile) => p.allmoxy_customer_id },
      { key: 'name', label: 'Customer', getValue: (p: Profile) => p.name },
      { key: 'installer_id', label: 'Installer ID', getValue: (p: Profile) => p.installer_id ?? '' },
      { key: 'hubspot_company_id', label: 'HubSpot ID', getValue: (p: Profile) => p.hubspot_company_id ?? '' },
      { key: 'tier', label: 'Tier', getValue: (p: Profile) => tierById.get(p.allmoxy_customer_id) ?? '' },
      { key: 'pay_status', label: 'Pay status', getValue: (p: Profile) => p.pay_status ?? '' },
      { key: 'owner', label: 'Owner', getValue: (p: Profile) => ownerName(p) },
      { key: 'segment', label: 'Segment', getValue: (p: Profile) => p.primary_segment ?? '' },
      { key: 'current_mrr', label: 'Current MRR', getValue: (p: Profile) => p.current_subscription_mrr || 0 },
      { key: 'lifetime_subscription', label: 'Lifetime sub', getValue: (p: Profile) => p.lifetime_subscription || 0 },
      { key: 'years_with_us', label: 'Tenure (yrs)', getValue: (p: Profile) => p.years_with_us ?? '' },
      { key: 'cohort_year', label: 'Cohort', getValue: (p: Profile) => p.cohort_year ?? '' },
      { key: 'sign_up_date', label: 'Signed up', getValue: (p: Profile) => p.sign_up_date ?? '' },
      { key: 'first_payment_date', label: 'First payment', getValue: (p: Profile) => p.first_payment_date ?? '' },
      { key: 'last_payment_date', label: 'Last payment', getValue: (p: Profile) => p.last_payment_date ?? '' },
    ]),
    [tierById]
  );

  return (
    <Box>
      <PageHeader
        title="Customers"
        subtitle="Every customer in the system. Filter by status, tier, owner, segment, or pay status. Click a name to open Customer Detail."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load customer_profiles: {String(error)}</Alert>}

      {/* KPI tiles — each metric in its own card to match the rest of the
          dashboard. Tracks the filtered cohort, not the raw cohort. */}
      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Customers</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{summary.count.toLocaleString()}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>of {profiles.length.toLocaleString()} total</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: 'primary.main' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Filtered MRR</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500, color: 'primary.main' }}>{USD0.format(summary.mrr)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Current monthly recurring</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Filtered Lifetime Sub</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <>
                <Typography variant="h5" sx={{ fontWeight: 500 }}>{USD0.format(summary.lifetime)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>All subscription $ to date</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Export</Typography>
            <Box>
              <CsvExportButton filename="customers.csv" rows={sorted} columns={csvColumns} />
            </Box>
          </Paper>
        </Grid>
      </Grid>

      {/* Filters — search + four multi-select dropdowns. Dropdowns take far
          less vertical space than the prior chip strips and behave the same
          as on Churn Risk Matrix / Services / Renewal Management. */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack spacing={1.5}>
          <TextField
            size="small"
            placeholder="Search by name, Allmoxy ID, Installer ID, or subdomain…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
              ),
            }}
            sx={{ maxWidth: 480 }}
          />

          <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
            <MultiFilter
              label="Tier"
              options={[
                { name: 'red', label: '🔴 Critical' },
                { name: 'yellow', label: '🟡 Watch' },
                { name: 'green', label: '🟢 Healthy' },
                { name: 'unscored', label: '⚪ Unscored' },
              ]}
              value={tierFilter}
              onChange={(v) => { setTierFilter(v); setPage(0); }}
              placeholderAll="All tiers"
            />
            <MultiFilter
              label="Pay status"
              options={facets.payStatuses.map((f) => ({ name: f.name, label: `${f.name} (${f.count})` }))}
              value={payStatusFilter}
              onChange={(v) => { setPayStatusFilter(v); setPage(0); }}
              placeholderAll="All pay statuses"
            />
            <MultiFilter
              label="Owner"
              options={facets.owners.map((f) => ({ name: f.name, label: `${f.name} (${f.count})` }))}
              value={ownerFilter}
              onChange={(v) => { setOwnerFilter(v); setPage(0); }}
              placeholderAll="All owners"
            />
            <MultiFilter
              label="Segment"
              options={facets.segments.map((f) => ({ name: f.name, label: `${f.name} (${f.count})` }))}
              value={segmentFilter}
              onChange={(v) => { setSegmentFilter(v); setPage(0); }}
              placeholderAll="All segments"
            />
          </Stack>
        </Stack>
      </Paper>

      {/* Table */}
      <Paper sx={{ p: 0, mb: 2 }}>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 1300 }}>
            <TableHead>
              <TableRow>
                <SortHead label="Customer" active={sortKey === 'name'} dir={sortDir} onClick={() => toggleSort('name')} />
                <SortHead label="Allmoxy ID" active={sortKey === 'aid'} dir={sortDir} onClick={() => toggleSort('aid')} align="right" />
                <SortHead label="Installer ID" active={sortKey === 'installer_id'} dir={sortDir} onClick={() => toggleSort('installer_id')} align="right" />
                <TableCell align="right" sx={{ fontWeight: 600, fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>HubSpot</TableCell>
                <SortHead label="Tier" active={sortKey === 'tier'} dir={sortDir} onClick={() => toggleSort('tier')} />
                <SortHead label="Pay status" active={sortKey === 'pay_status'} dir={sortDir} onClick={() => toggleSort('pay_status')} />
                <SortHead label="Owner" active={sortKey === 'owner'} dir={sortDir} onClick={() => toggleSort('owner')} />
                <SortHead label="Segment" active={sortKey === 'segment'} dir={sortDir} onClick={() => toggleSort('segment')} />
                <SortHead label="MRR" active={sortKey === 'mrr'} dir={sortDir} onClick={() => toggleSort('mrr')} align="right" />
                <SortHead label="Lifetime sub" active={sortKey === 'lifetime'} dir={sortDir} onClick={() => toggleSort('lifetime')} align="right" />
                <SortHead label="Tenure" active={sortKey === 'tenure'} dir={sortDir} onClick={() => toggleSort('tenure')} align="right" />
                <SortHead label="Signed up" active={sortKey === 'sign_up'} dir={sortDir} onClick={() => toggleSort('sign_up')} />
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading && (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {Array.from({ length: 12 }).map((__, j) => (
                      <TableCell key={j}><Skeleton variant="text" /></TableCell>
                    ))}
                  </TableRow>
                ))
              )}
              {!isLoading && paged.length === 0 && (
                <TableRow><TableCell colSpan={12} align="center" sx={{ py: 4, color: 'text.secondary' }}>No customers match the current filters.</TableCell></TableRow>
              )}
              {!isLoading && paged.map((p) => {
                const tier = tierById.get(p.allmoxy_customer_id);
                return (
                  <TableRow key={p.allmoxy_customer_id} hover>
                    <TableCell sx={{ fontWeight: 500 }}>
                      <CustomerLink id={p.allmoxy_customer_id} name={p.name} />
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary', fontSize: 12 }}>{p.allmoxy_customer_id}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary', fontSize: 12 }}>{p.installer_id ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                      <HubSpotIdLink id={p.hubspot_company_id} showIcon />
                    </TableCell>
                    <TableCell>
                      {tier ? (
                        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: TIER_COLOR[tier], fontWeight: 600, fontSize: 12 }}>
                          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: TIER_COLOR[tier] }} />
                          {TIER_LABEL[tier] || tier}
                        </Box>
                      ) : (
                        <Typography variant="caption" sx={{ color: 'text.disabled' }}>—</Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{p.pay_status || '—'}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{ownerName(p) || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</TableCell>
                    <TableCell sx={{ fontSize: 12 }}>{p.primary_segment || '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD0.format(p.current_subscription_mrr || 0)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}>{USD0.format(p.lifetime_subscription || 0)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{p.years_with_us != null ? `${p.years_with_us.toFixed(1)}y` : '—'}</TableCell>
                    <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>{formatDateMDY(p.sign_up_date)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
        <TablePagination
          component="div"
          count={sorted.length}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(e) => { setRowsPerPage(Number(e.target.value)); setPage(0); }}
          rowsPerPageOptions={[25, 50, 100, 200]}
        />
      </Paper>
    </Box>
  );
}

// Compact multi-select dropdown for facet filters. Each option carries an
// internal value (`name`) and a display label (which can include a count).
// When nothing is selected we show the "All X" placeholder; otherwise a
// chip per selected value with an × to remove. Renders nothing when there
// are no options to choose from.
function MultiFilter({
  label,
  options,
  value,
  onChange,
  placeholderAll,
}: {
  label: string;
  options: Array<{ name: string; label: string }>;
  value: string[];
  onChange: (v: string[]) => void;
  placeholderAll: string;
}) {
  if (options.length === 0) return null;
  const labelByName = new Map(options.map((o) => [o.name, o.label]));
  return (
    <Autocomplete
      multiple
      disableCloseOnSelect
      size="small"
      options={options.map((o) => o.name)}
      value={value}
      onChange={(_, v) => onChange(v)}
      getOptionLabel={(n) => labelByName.get(n) ?? n}
      renderTags={(values, getTagProps) =>
        values.map((option, index) => (
          <Chip
            variant="filled"
            label={option}
            size="small"
            {...getTagProps({ index })}
            key={option}
            sx={{ height: 20, fontSize: 11 }}
          />
        ))
      }
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          placeholder={value.length === 0 ? placeholderAll : ''}
          sx={{ '& .MuiInputBase-input': { fontSize: 12 }, '& .MuiFormLabel-root': { fontSize: 12 } }}
        />
      )}
      sx={{ minWidth: 200, maxWidth: 360 }}
    />
  );
}

function SortHead({
  label,
  active,
  dir,
  onClick,
  align,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <TableCell align={align} sx={{ fontWeight: 600, fontSize: 11, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
      <TableSortLabel active={active} direction={dir} onClick={onClick}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
}
