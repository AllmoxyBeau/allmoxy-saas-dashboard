import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';
import Chip from '@mui/material/Chip';
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

const STATUS_COLOR: Record<string, { bg: string; color: string }> = {
  active: { bg: '#dcfce7', color: '#166534' },
  at_risk: { bg: '#fef3c7', color: '#92400e' },
  churned: { bg: '#fee2e2', color: '#991b1b' },
  never_paid: { bg: '#e5e7eb', color: '#374151' },
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
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());
  const [tierFilter, setTierFilter] = useState<Set<string>>(new Set());
  const [payStatusFilter, setPayStatusFilter] = useState<Set<string>>(new Set());
  const [ownerFilter, setOwnerFilter] = useState<Set<string>>(new Set());
  const [segmentFilter, setSegmentFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('mrr');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'name' || k === 'owner' || k === 'segment' || k === 'pay_status' ? 'asc' : 'desc');
    }
    setPage(0);
  }

  function toggleSetItem(s: Set<string>, item: string, setter: (n: Set<string>) => void) {
    const next = new Set(s);
    if (next.has(item)) next.delete(item);
    else next.add(item);
    setter(next);
    setPage(0);
  }

  const profiles = profilesData?.rows ?? [];

  // Distinct values for filter chips
  const facets = useMemo(() => {
    const statuses = new Set<string>();
    const payStatuses = new Set<string>();
    const owners = new Set<string>();
    const segments = new Set<string>();
    for (const p of profiles) {
      if (p.status) statuses.add(p.status);
      if (p.pay_status) payStatuses.add(p.pay_status);
      const o = ownerName(p);
      if (o) owners.add(o);
      if (p.primary_segment) segments.add(p.primary_segment);
    }
    return {
      statuses: [...statuses].sort(),
      payStatuses: [...payStatuses].sort(),
      owners: [...owners].sort(),
      segments: [...segments].sort(),
    };
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (q) {
        const hay = `${p.name || ''} ${p.allmoxy_customer_id} ${p.installer_id || ''} ${p.installer_directory || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (statusFilter.size > 0 && !statusFilter.has(p.status)) return false;
      if (payStatusFilter.size > 0 && !payStatusFilter.has(p.pay_status || '')) return false;
      if (tierFilter.size > 0) {
        const t = tierById.get(p.allmoxy_customer_id) ?? 'unscored';
        if (!tierFilter.has(t)) return false;
      }
      if (ownerFilter.size > 0 && !ownerFilter.has(ownerName(p))) return false;
      if (segmentFilter.size > 0 && !segmentFilter.has(p.primary_segment || '')) return false;
      return true;
    });
  }, [profiles, search, statusFilter, payStatusFilter, tierFilter, ownerFilter, segmentFilter, tierById]);

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
      { key: 'status', label: 'Status', getValue: (p: Profile) => p.status },
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

      {/* Summary strip */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" spacing={4} alignItems="center" flexWrap="wrap" useFlexGap>
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>Showing</Typography>
            <Typography variant="h6" sx={{ fontWeight: 500 }}>{summary.count.toLocaleString()} <Box component="span" sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 400 }}>of {profiles.length.toLocaleString()}</Box></Typography>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>Filtered MRR</Typography>
            <Typography variant="h6" sx={{ fontWeight: 500 }}>{USD0.format(summary.mrr)}<Box component="span" sx={{ fontSize: 11, color: 'text.secondary' }}>/mo</Box></Typography>
          </Box>
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5 }}>Filtered Lifetime Sub</Typography>
            <Typography variant="h6" sx={{ fontWeight: 500 }}>{USD0.format(summary.lifetime)}</Typography>
          </Box>
          <Box sx={{ flexGrow: 1 }} />
          <CsvExportButton filename="customers.csv" rows={sorted} columns={csvColumns} />
        </Stack>
      </Paper>

      {/* Filters */}
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

          <FilterRow label="Status" values={facets.statuses} selected={statusFilter} onToggle={(v) => toggleSetItem(statusFilter, v, setStatusFilter)} />
          <FilterRow
            label="Tier"
            values={['red', 'yellow', 'green', 'unscored']}
            selected={tierFilter}
            renderLabel={(v) => `${v === 'red' ? '🔴' : v === 'yellow' ? '🟡' : v === 'green' ? '🟢' : '⚪'} ${TIER_LABEL[v] || v}`}
            onToggle={(v) => toggleSetItem(tierFilter, v, setTierFilter)}
          />
          <FilterRow label="Pay status" values={facets.payStatuses} selected={payStatusFilter} onToggle={(v) => toggleSetItem(payStatusFilter, v, setPayStatusFilter)} />
          <FilterRow label="Owner" values={facets.owners} selected={ownerFilter} onToggle={(v) => toggleSetItem(ownerFilter, v, setOwnerFilter)} />
          <FilterRow label="Segment" values={facets.segments} selected={segmentFilter} onToggle={(v) => toggleSetItem(segmentFilter, v, setSegmentFilter)} />
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
                <SortHead label="Status" active={sortKey === 'status'} dir={sortDir} onClick={() => toggleSort('status')} />
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
                    {Array.from({ length: 13 }).map((__, j) => (
                      <TableCell key={j}><Skeleton variant="text" /></TableCell>
                    ))}
                  </TableRow>
                ))
              )}
              {!isLoading && paged.length === 0 && (
                <TableRow><TableCell colSpan={13} align="center" sx={{ py: 4, color: 'text.secondary' }}>No customers match the current filters.</TableCell></TableRow>
              )}
              {!isLoading && paged.map((p) => {
                const tier = tierById.get(p.allmoxy_customer_id);
                const statusStyle = STATUS_COLOR[p.status] || { bg: '#e5e7eb', color: '#374151' };
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
                      <Chip
                        label={p.status}
                        size="small"
                        sx={{ bgcolor: statusStyle.bg, color: statusStyle.color, fontWeight: 600, fontSize: 11, height: 20 }}
                      />
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

function FilterRow({
  label,
  values,
  selected,
  onToggle,
  renderLabel,
}: {
  label: string;
  values: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  renderLabel?: (v: string) => string;
}) {
  if (values.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5, minWidth: 70 }}>{label}</Typography>
      {values.map((v) => (
        <Chip
          key={v}
          label={renderLabel ? renderLabel(v) : v}
          size="small"
          variant={selected.has(v) ? 'filled' : 'outlined'}
          color={selected.has(v) ? 'primary' : 'default'}
          onClick={() => onToggle(v)}
          sx={{ height: 22, fontSize: 11 }}
        />
      ))}
      {selected.size > 0 && (
        <Chip
          label="clear"
          size="small"
          variant="outlined"
          onClick={() => { selected.forEach((v) => onToggle(v)); }}
          sx={{ height: 22, fontSize: 11, color: 'text.secondary' }}
        />
      )}
    </Stack>
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
