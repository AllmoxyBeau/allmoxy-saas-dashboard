/**
 * Customers on the Allmoxy design system. Data logic is ported verbatim from the classic page
 * (Customers.tsx, kept at /customers-classic): same customer_profiles + churn_risk_matrix
 * snapshots, same "Hide duplicates" default (on), same search haystack, same tier / pay status /
 * owner / segment filters (facet counts from the de-duplicated set), same sort keys and default
 * directions, same KPI maths over the filtered set, and the same CSV columns.
 *
 * Added (UI only, no change to any number): a Status column with a word tag per lifecycle status,
 * and a status chip filter that defaults to every status, so the headline numbers match classic.
 *
 * Sorting is held by this page (not by DataTable) because the list shows the top 25 with
 * "Show all": the sort must run over every filtered customer before the list is cut.
 */
import { useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import { DsPage, FilterChip, Icon, KpiCard, KpiGrid, Switch, downloadCsv, usd } from '../design-system/parts';

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
  active_today?: boolean;
};
type MatrixCustomer = { allmoxy_customer_id: number; tier: 'red' | 'yellow' | 'green' | 'unscored'; total_score: number; arr_at_risk: number };
type MatrixSnap = { customers: MatrixCustomer[] };
type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

// Lifecycle status: a word and a tone, worst first so the chips read as a triage list.
const STATUSES: Array<{ key: string; label: string; tone: Tone }> = [
  { key: 'non_payment', label: 'Lapsed', tone: 'error' },
  { key: 'at_risk', label: 'At risk', tone: 'warning' },
  { key: 'paused', label: 'Paused', tone: 'info' },
  { key: 'active', label: 'Active', tone: 'success' },
  { key: 'never_paid', label: 'Never paid', tone: 'neutral' },
  { key: 'churned', label: 'Churned', tone: 'neutral' },
];
const statusOf = (k: string) => STATUSES.find((s) => s.key === k) ?? { key: k, label: k ? k.replace(/_/g, ' ') : 'Unknown', tone: 'neutral' as Tone };
const STATUS_RANK = (k: string) => { const i = STATUSES.findIndex((s) => s.key === k); return i < 0 ? 99 : i; };

// Churn-risk tier from the Churn Risk Matrix (same words as classic).
const TIERS: Array<{ key: string; label: string; tone: Tone }> = [
  { key: 'red', label: 'Critical', tone: 'error' },
  { key: 'yellow', label: 'Watch', tone: 'warning' },
  { key: 'green', label: 'Healthy', tone: 'success' },
  { key: 'unscored', label: 'Unscored', tone: 'neutral' },
];
const TIER_RANK = { red: 0, yellow: 1, green: 2, unscored: 3 } as const;

function ownerName(p: Profile): string {
  return p.instance_owner_first_name?.trim() || p.instance_owner?.trim() || '';
}
function formatDateMDY(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}

type SortKey = 'name' | 'status' | 'tier' | 'aid' | 'installer_id' | 'hubspot' | 'pay_status' | 'owner' | 'segment' | 'mrr' | 'lifetime' | 'tenure' | 'sign_up';
// Column order: who, how they stand, what they pay, then the reference IDs. HubSpot is a
// narrow icon column right after the name (Beau, 2026-11-09: an icon in its own column, not a
// second line under the name).
const COLS: Array<{ key: SortKey; label: string; num: boolean; sortable: boolean }> = [
  { key: 'name', label: 'Customer', num: false, sortable: true },
  { key: 'hubspot', label: 'HubSpot', num: false, sortable: false },
  { key: 'status', label: 'Status', num: false, sortable: true },
  { key: 'tier', label: 'Risk tier', num: false, sortable: true },
  { key: 'pay_status', label: 'Pay status', num: false, sortable: true },
  { key: 'mrr', label: 'MRR', num: true, sortable: true },
  { key: 'lifetime', label: 'Lifetime sub', num: true, sortable: true },
  { key: 'tenure', label: 'Tenure', num: true, sortable: true },
  { key: 'owner', label: 'Owner', num: false, sortable: true },
  { key: 'segment', label: 'Segment', num: false, sortable: true },
  { key: 'sign_up', label: 'Signed up', num: false, sortable: true },
  { key: 'aid', label: 'Allmoxy ID', num: true, sortable: true },
  { key: 'installer_id', label: 'Installer', num: true, sortable: true },
];
const WRAP: SortKey[] = ['name', 'segment', 'pay_status'];
const ASC_FIRST: SortKey[] = ['name', 'owner', 'segment', 'pay_status'];
const LIMIT = 25;

export default function CustomersDS() {
  const navigate = useNavigate();
  const { data: profilesData, isLoading, error } = useSheetTab<Profile>('customer_profiles');
  const matrixQuery = useSheetTab<MatrixSnap>('churn_risk_matrix');
  const matrixRaw = matrixQuery.data as unknown as MatrixSnap | undefined;

  const tierById = useMemo(() => {
    const m = new Map<number, MatrixCustomer['tier']>();
    for (const c of matrixRaw?.customers ?? []) m.set(c.allmoxy_customer_id, c.tier);
    return m;
  }, [matrixRaw]);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [tierFilter, setTierFilter] = useState<string[]>([]);
  const [payStatusFilter, setPayStatusFilter] = useState<string[]>([]);
  const [ownerFilter, setOwnerFilter] = useState<string[]>([]);
  const [segmentFilter, setSegmentFilter] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [showAll, setShowAll] = useState(false);
  // Duplicate profile rows (excluded_from_logo_count: the same customer under a second AID) are
  // hidden by default, exactly as classic: left in, they inflate the count and double the MRR.
  const [hideDuplicates, setHideDuplicates] = useState(true);
  // Paying customers = the canonical customer base (active_today), the same 198 as Overview.
  const [payingOnly, setPayingOnly] = useState(false);
  const reset = () => setShowAll(false);

  const statusSet = useMemo(() => new Set(statusFilter), [statusFilter]);
  const tierSet = useMemo(() => new Set(tierFilter), [tierFilter]);
  const payStatusSet = useMemo(() => new Set(payStatusFilter), [payStatusFilter]);
  const ownerSet = useMemo(() => new Set(ownerFilter), [ownerFilter]);
  const segmentSet = useMemo(() => new Set(segmentFilter), [segmentFilter]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(ASC_FIRST.includes(k) ? 'asc' : 'desc'); }
  }

  const allProfiles = useMemo(() => profilesData?.rows ?? [], [profilesData]);
  const duplicateCount = useMemo(() => allProfiles.filter((p) => p.excluded_from_logo_count).length, [allProfiles]);
  const profiles = useMemo(
    () => (hideDuplicates ? allProfiles.filter((p) => !p.excluded_from_logo_count) : allProfiles),
    [allProfiles, hideDuplicates],
  );

  // Facet counts come from the de-duplicated, unfiltered set (as classic).
  const facets = useMemo(() => {
    const payStatuses = new Map<string, number>(), owners = new Map<string, number>(), segments = new Map<string, number>();
    const statuses = new Map<string, number>(), tiers = new Map<string, number>();
    for (const p of profiles) {
      if (p.pay_status) payStatuses.set(p.pay_status, (payStatuses.get(p.pay_status) ?? 0) + 1);
      const o = ownerName(p);
      if (o) owners.set(o, (owners.get(o) ?? 0) + 1);
      if (p.primary_segment) segments.set(p.primary_segment, (segments.get(p.primary_segment) ?? 0) + 1);
      statuses.set(p.status || '', (statuses.get(p.status || '') ?? 0) + 1);
      const t = tierById.get(p.allmoxy_customer_id) ?? 'unscored';
      tiers.set(t, (tiers.get(t) ?? 0) + 1);
    }
    const sortByCount = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    return { payStatuses: sortByCount(payStatuses), owners: sortByCount(owners), segments: sortByCount(segments), statuses, tiers };
  }, [profiles, tierById]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (q) {
        const hay = `${p.name || ''} ${p.allmoxy_customer_id} ${p.installer_id || ''} ${p.installer_directory || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (payingOnly && !p.active_today) return false;
      if (statusSet.size > 0 && !statusSet.has(p.status || '')) return false;
      if (payStatusSet.size > 0 && !payStatusSet.has(p.pay_status || '')) return false;
      if (tierSet.size > 0) {
        const t = tierById.get(p.allmoxy_customer_id) ?? 'unscored';
        if (!tierSet.has(t)) return false;
      }
      if (ownerSet.size > 0 && !ownerSet.has(ownerName(p))) return false;
      if (segmentSet.size > 0 && !segmentSet.has(p.primary_segment || '')) return false;
      return true;
    });
  }, [profiles, payingOnly, search, statusSet, payStatusSet, tierSet, ownerSet, segmentSet, tierById]);

  // Same comparators as classic, plus status (worst first).
  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => {
      let av: number | string = 0, bv: number | string = 0;
      switch (sortKey) {
        case 'name': av = (a.name || '').toLowerCase(); bv = (b.name || '').toLowerCase(); break;
        case 'aid': av = a.allmoxy_customer_id; bv = b.allmoxy_customer_id; break;
        case 'installer_id': av = Number(a.installer_id) || 0; bv = Number(b.installer_id) || 0; break;
        case 'status': av = -STATUS_RANK(a.status || ''); bv = -STATUS_RANK(b.status || ''); break;
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
        default: break;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return out;
  }, [filtered, sortKey, sortDir, tierById]);

  const summary = useMemo(() => ({
    count: filtered.length,
    mrr: filtered.reduce((s, p) => s + (p.current_subscription_mrr || 0), 0),
    lifetime: filtered.reduce((s, p) => s + (p.lifetime_subscription || 0), 0),
  }), [filtered]);

  // Customers to act on now: lapsed (non-payment) or at risk, inside the current filters.
  const attention = useMemo(() => {
    const rows = filtered.filter((p) => p.status === 'non_payment' || p.status === 'at_risk');
    return { n: rows.length, mrr: rows.reduce((s, p) => s + (p.current_subscription_mrr || 0), 0) };
  }, [filtered]);

  const list = showAll ? sorted : sorted.slice(0, LIMIT);

  const exportCsv = () => downloadCsv('customers',
    ['Allmoxy ID', 'Customer', 'Installer ID', 'HubSpot ID', 'Tier', 'Pay status', 'Owner', 'Segment', 'Current MRR', 'Lifetime sub', 'Tenure (yrs)', 'Cohort', 'Signed up', 'First payment', 'Last payment', 'Status'],
    sorted.map((p) => [p.allmoxy_customer_id, p.name, p.installer_id ?? '', p.hubspot_company_id ?? '', tierById.get(p.allmoxy_customer_id) ?? '',
      p.pay_status ?? '', ownerName(p), p.primary_segment ?? '', p.current_subscription_mrr || 0, p.lifetime_subscription || 0,
      p.years_with_us ?? '', p.cohort_year ?? '', p.sign_up_date ?? '', p.first_payment_date ?? '', p.last_payment_date ?? '', p.status ?? '']));

  const toggleIn = (arr: string[], set: (v: string[]) => void, k: string) => { set(arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]); reset(); };
  const anyFilter = payingOnly || !!search || statusFilter.length + tierFilter.length + payStatusFilter.length + ownerFilter.length + segmentFilter.length > 0;
  const clearAll = () => { setPayingOnly(false); setSearch(''); setStatusFilter([]); setTierFilter([]); setPayStatusFilter([]); setOwnerFilter([]); setSegmentFilter([]); reset(); };
  const detailHref = (p: Profile) => `/customer-detail?id=${encodeURIComponent(String(p.allmoxy_customer_id))}`;
  const dash = <span className="am-card__text">—</span>;

  const cell = (p: Profile, k: SortKey): ReactNode => {
    switch (k) {
      case 'name': {
        return (
          <a className="am-btn am-btn--text" href={detailHref(p)} style={{ whiteSpace: 'normal', textAlign: 'left', maxWidth: 240 }}
            onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(detailHref(p)); }}>{p.name}</a>
        );
      }
      case 'hubspot': {
        const hs = hubspotCompanyUrl(p.hubspot_company_id);
        return hs ? (
          <span className="am-tooltip">
            <a className="am-icon-btn" href={hs} target="_blank" rel="noopener noreferrer" aria-label={`Open ${p.name} in HubSpot (company ${p.hubspot_company_id})`}>
              <Icon name="open_in_new" />
            </a>
            <span className="am-tooltip__tip">Open in HubSpot</span>
          </span>
        ) : dash;
      }
      case 'status': {
        const s = statusOf(p.status || '');
        // Active but not yet in the paying count can only mean billing started after the latest
        // complete month: a brand-new customer that joins the count when this month closes.
        const newThisMonth = !p.active_today && p.status === 'active';
        return (
          <span className="am-row am-row--tight" style={{ flexWrap: 'nowrap' }}>
            <span className={`am-tag am-tag--${s.tone}`}>{s.label}</span>
            {newThisMonth && <span className="am-tooltip"><span className="am-tag am-tag--info">New this month</span><span className="am-tooltip__tip">Started billing after the latest complete month, so it joins the paying count when this month closes.</span></span>}
          </span>
        );
      }
      case 'tier': {
        const t = tierById.get(p.allmoxy_customer_id);
        const d = t ? TIERS.find((x) => x.key === t) : undefined;
        return d ? <span className={`am-tag am-tag--${d.tone}`}>{d.label}</span> : dash;
      }
      case 'pay_status': return p.pay_status || '—';
      case 'mrr': return usd(p.current_subscription_mrr || 0);
      case 'lifetime': return usd(p.lifetime_subscription || 0);
      case 'tenure': return p.years_with_us != null ? `${p.years_with_us.toFixed(1)}y` : '—';
      case 'owner': return ownerName(p) || '—';
      case 'segment': return p.primary_segment || '—';
      case 'sign_up': return formatDateMDY(p.sign_up_date);
      case 'aid': return p.allmoxy_customer_id;
      case 'installer_id': return p.installer_id ?? '—';
      default: return null;
    }
  };

  return (
    <DsPage
      path="/customers"
      title="Customers"
      subtitle="Every customer in the system. Filter by status, risk tier, owner, segment or pay status. Select a name to open Customer Detail."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!sorted.length}><Icon name="download" />Export CSV</button>}
    >
      {error ? <p className="am-card__text">Failed to load customer_profiles: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="Need attention" value={isLoading ? '…' : attention.n.toLocaleString()}
          hint={`Lapsed or at risk · ${usd(attention.mrr)} MRR`}
          tag={attention.n > 0 ? 'Act now' : 'Clear'} tagTone={attention.n > 0 ? 'warning' : 'success'}
          onOpen={() => { setStatusFilter(['non_payment', 'at_risk']); reset(); }} />
        <KpiCard label="Customers" value={isLoading ? '…' : summary.count.toLocaleString()}
          hint={`of ${profiles.length.toLocaleString()} total${hideDuplicates && duplicateCount > 0 ? ` · ${duplicateCount} duplicate rows hidden` : ''}`}
          tag={anyFilter ? 'Filtered' : 'All'} tagTone={anyFilter ? 'info' : 'neutral'} />
        <KpiCard label="Filtered MRR" value={isLoading ? '…' : usd(summary.mrr)} hint="Current monthly recurring" />
        <KpiCard label="Filtered lifetime sub" value={isLoading ? '…' : usd(summary.lifetime)} hint="All subscription $ to date" />
      </KpiGrid>

      <section className="am-card am-card--outlined" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="am-row am-row--wrap">
          <label className="am-field am-field--outlined" style={{ width: 420 }}>
            <Icon name="search" className="am-field__lead" />
            <input className="am-field__input" placeholder=" " value={search} aria-label="Search customers"
              onChange={(e) => { setSearch(e.target.value); reset(); }} />
            <span className="am-field__label">Search name, Allmoxy ID, Installer ID or subdomain</span>
            <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap" /><i /></span>
          </label>
          <Switch checked={hideDuplicates} onChange={(v) => { setHideDuplicates(v); reset(); }}>
            Hide duplicates{duplicateCount > 0 ? ` (${duplicateCount})` : ''}
          </Switch>
          {anyFilter && <button className="am-btn am-btn--text" onClick={clearAll}><Icon name="close" />Clear filters</button>}
        </div>
        <div className="am-row am-row--wrap">
          <FilterChip checked={payingOnly} onChange={() => { setPayingOnly(!payingOnly); reset(); }}>
            Paying customers ({profiles.filter((p) => p.active_today).length})
          </FilterChip>
          <span className="am-card__text">The same customers as Overview: billed for a subscription in the latest complete month. Status below is each customer's standing, so Active and At risk together make up the paying customers.</span>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Status</span>
          {STATUSES.filter((s) => facets.statuses.has(s.key)).map((s) => (
            <FilterChip key={s.key} checked={statusFilter.includes(s.key)} onChange={() => toggleIn(statusFilter, setStatusFilter, s.key)}>
              {s.label} ({facets.statuses.get(s.key)})
            </FilterChip>
          ))}
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Risk tier</span>
          {TIERS.map((t) => (
            <FilterChip key={t.key} checked={tierFilter.includes(t.key)} onChange={() => toggleIn(tierFilter, setTierFilter, t.key)}>
              {t.label} ({facets.tiers.get(t.key) ?? 0})
            </FilterChip>
          ))}
        </div>
        <div className="am-row am-row--wrap">
          <MultiSelect label="Pay status" allText="All pay statuses" value={payStatusFilter} onChange={(v) => { setPayStatusFilter(v); reset(); }}
            options={facets.payStatuses.map((f) => [f.name, `${f.name} (${f.count})`])} />
          <MultiSelect label="Owner" allText="All owners" value={ownerFilter} onChange={(v) => { setOwnerFilter(v); reset(); }}
            options={facets.owners.map((f) => [f.name, `${f.name} (${f.count})`])} />
          <MultiSelect label="Segment" allText="All segments" value={segmentFilter} onChange={(v) => { setSegmentFilter(v); reset(); }} width={300}
            options={facets.segments.map((f) => [f.name, `${f.name} (${f.count})`])} />
        </div>
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">{summary.count.toLocaleString()} customers · {usd(summary.mrr)} MRR</span>
          <span className="am-chart__caption">Select a name to open Customer Detail. Select a column heading to sort the whole list.</span>
        </div>
        {isLoading ? <p className="am-card__text">Loading customers…</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="am-table" aria-label="Customers">
              <thead><tr>{COLS.map((c) => (
                <th key={c.key} className={c.num ? 'am-table__num' : undefined} style={{ whiteSpace: 'nowrap' }}
                  aria-sort={sortKey === c.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sortable ? (
                    <span className="am-table__sort" role="button" tabIndex={0} onClick={() => toggleSort(c.key)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(c.key); } }}>
                      {c.label}<span className="am-table__sortarrow" aria-hidden="true">{sortKey === c.key && sortDir === 'asc' ? '▲' : '▼'}</span>
                    </span>
                  ) : c.label}
                </th>
              ))}</tr></thead>
              <tbody>{list.map((p) => (
                <tr key={p.allmoxy_customer_id}>{COLS.map((c) => (
                  <td key={c.key} className={c.num ? 'am-table__num' : undefined} style={{ whiteSpace: WRAP.includes(c.key) ? 'normal' : 'nowrap' }}>{cell(p, c.key)}</td>
                ))}</tr>
              ))}</tbody>
              <tfoot><tr>{COLS.map((c) => {
                const v = c.key === 'name' ? `Total · ${summary.count.toLocaleString()} customers` : c.key === 'mrr' ? usd(summary.mrr) : c.key === 'lifetime' ? usd(summary.lifetime) : '';
                const canOpen = v !== '' && !showAll && sorted.length > LIMIT;
                return (
                  <td key={c.key} className={c.num ? 'am-table__num' : undefined} style={{ whiteSpace: 'nowrap' }}>
                    {canOpen ? <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>{v}</button> : v}
                  </td>
                );
              })}</tr></tfoot>
            </table>
          </div>
        )}
        {!isLoading && sorted.length === 0 && <p className="am-card__text">No customers match the current filters.</p>}
        <div className="am-row am-row--wrap">
          {!showAll && sorted.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {sorted.length.toLocaleString()}</button>}
          {showAll && sorted.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(false)}>Show top {LIMIT}</button>}
          <span className="am-card__text">Showing {list.length.toLocaleString()} of {sorted.length.toLocaleString()}.</span>
        </div>
      </section>
    </DsPage>
  );
}

/** Local multi-select (the shared Select is single-value): the certified field + menu, each item
 *  toggling a checked state; the menu stays open while picking. Empty value = no filter. */
function MultiSelect({ label, allText, options, value, onChange, width = 240 }: {
  label: string; allText: string; options: Array<[string, string]>; value: string[]; onChange: (v: string[]) => void; width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!options.length) return null;
  const shown = value.length === 0 ? allText : value.length === 1 ? value[0] : `${value.length} selected`;
  return (
    <div ref={ref} className={`am-menu-anchor am-select${open ? ' is-open' : ''}`} style={{ width }}>
      <label className="am-field am-field--outlined" style={{ width: '100%', minWidth: 0 }} onClick={() => setOpen(!open)}>
        <input className="am-field__input" placeholder=" " value={shown} readOnly aria-label={label} />
        <span className="am-field__label">{label}</span>
        <Icon name="arrow_drop_down" className="am-field__trail" />
        <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap" /><i /></span>
      </label>
      <div className="am-menu" role="menu" style={{ maxHeight: 320, overflowY: 'auto' }}>
        {value.length > 0 && (
          <button className="am-menu__item" role="menuitem" onClick={() => onChange([])}>
            <span className="am-menu__label">{allText}</span>
          </button>
        )}
        {options.map(([k, l]) => {
          const on = value.includes(k);
          return (
            <button key={k} className="am-menu__item" role="menuitemcheckbox" aria-checked={on} aria-selected={on}
              onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}>
              <span style={on ? undefined : { visibility: 'hidden' }}><Icon name="check" /></span>
              <span className="am-menu__label">{l}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
