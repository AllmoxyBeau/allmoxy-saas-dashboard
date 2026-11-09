/**
 * Data Cleanup on the Allmoxy design system. Data logic is ported verbatim from the classic page
 * (DataCleanup.tsx, kept at /data-cleanup-classic): same data_cleanup snapshot, same KPI numbers
 * (snapshot aggregates), same severity filter, same issue key, and the same accepted-suggestion
 * storage (browser localStorage key 'allmoxy.data_cleanup.accepted', copied as JSON and applied to
 * _etl_scripts/data_cleanup_resolutions.json). Accepted issues drop out of the list immediately,
 * exactly as on the classic page. The CSV export is the classic one (every issue in the snapshot).
 *
 * The page is a fix list: the categories holding the most serious issues come first, and inside
 * each category the issues run high → medium → low, each with its fix and its Accept control.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { DataTable, DsPage, Icon, KpiCard, KpiGrid, MultiSelect, Segmented, downloadCsv } from '../design-system/parts';

type Severity = 'low' | 'medium' | 'high';

type Issue = {
  category: string;
  category_label: string;
  severity: Severity;
  action: string;
  instance_id?: string;
  account_name?: string;
  installer_id?: string | null;
  pay_status?: string | null;
  suggested_aid?: number | null;
  suggested_customer_name?: string | null;
  allmoxy_customer_id?: number | null;
  customer_name?: string | null;
  hubspot_company_id?: string | null;
  connect_name?: string | null;
  hubspot_pay_status?: string | null;
  xlsx_pay_status?: string | null;
};
type Aggregates = {
  total_issues: number;
  by_category: Record<string, { count: number; label: string; severity_counts: Record<Severity, number> }>;
  by_severity: Record<Severity, number>;
};
type Snapshot = { fetchedAt: string; aggregates: Aggregates; issues: Issue[] };

// Severity → word and tone (never color alone); rank puts the most serious first.
const SEV: Record<Severity, { label: string; tone: 'error' | 'warning' | 'neutral'; rank: number }> = {
  high: { label: 'High', tone: 'error', rank: 3 },
  medium: { label: 'Medium', tone: 'warning', rank: 2 },
  low: { label: 'Low', tone: 'neutral', rank: 1 },
};
const SEVERITIES: Severity[] = ['high', 'medium', 'low'];
const sevTag = (s: Severity) => <span className={`am-tag am-tag--${SEV[s].tone}`}>{SEV[s].label}</span>;

// Stable per-issue key — MUST match issueKey() in build_data_cleanup.mjs (and the classic page)
// so an accepted resolution suppresses the right issue on rebuild.
function issueKey(i: Issue): string {
  if (i.category === 'hubspot_instance_missing_aid') return `${i.category}:${i.instance_id}`;
  if (i.category === 'connect_mapping_orphan') return `${i.category}:${i.connect_name}`;
  return `${i.category}:${i.allmoxy_customer_id}`; // pay_status_drift, company_id_ghost
}

// Same key and shape as the classic page, so accepts made on either page are shared.
const ACCEPTED_KEY = 'allmoxy.data_cleanup.accepted';
type Accepted = Record<string, { decision: string; value: string | number | null; label: string }>;
function readAccepted(): Accepted {
  try { const raw = localStorage.getItem(ACCEPTED_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function categoryDescription(cat: string): string {
  switch (cat) {
    case 'hubspot_instance_missing_aid':
      return 'Active HubSpot Instances where the Allmoxy Customer ID field is empty. The dashboard matches these by installer ID today, but filling in the Allmoxy Customer ID on the Instance would simplify every HubSpot-side report.';
    case 'hubspot_company_id_ghost':
      return 'Customer profiles whose HubSpot Company ID points at a HubSpot Company that no longer exists (not merged, not in the live set). Almost certainly a stale ID in column B of the xlsx Sync Sheet.';
    case 'connect_mapping_orphan':
      return 'Entries in src/data/connect_customer_overrides.json that map to a customer name no longer in the Stripe Connect xlsx export. Either the account closed, the customer churned, or the Connect account changed.';
    case 'hubspot_pay_status_drift':
      return 'The HubSpot Instance status disagrees with the pay status in the xlsx Sync Sheet. One side has gone stale: check which, then accept that one.';
    default:
      return 'Data hygiene issue found by the cleanup check.';
  }
}

type AcceptFn = (i: Issue, decision: string, value: string | number | null, label: string) => void;
const LIMIT = 15;

export default function DataCleanupDS() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('data_cleanup');
  const snap = data as Snapshot | undefined;
  const [severityFilter, setSeverityFilter] = useState<Severity[]>([]);
  const [accepted, setAccepted] = useState<Accepted>(() => readAccepted());

  useEffect(() => { try { localStorage.setItem(ACCEPTED_KEY, JSON.stringify(accepted)); } catch { /* ignore */ } }, [accepted]);

  function acceptIssue(i: Issue, decision: string, value: string | number | null, label: string) {
    setAccepted((prev) => ({ ...prev, [issueKey(i)]: { decision, value, label } }));
  }

  // Same filtering as the classic page (accepted issues drop out; severity filter, empty = all).
  // Order: most serious first — categories by their highest severity, then by size (the classic
  // order); issues inside a category high → medium → low, otherwise in snapshot order.
  const issuesByCategory = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const it of snap?.issues ?? []) {
      if (accepted[issueKey(it)]) continue;
      if (severityFilter.length > 0 && !severityFilter.includes(it.severity)) continue;
      if (!m.has(it.category)) m.set(it.category, []);
      m.get(it.category)!.push(it);
    }
    const top = (l: Issue[]) => Math.max(...l.map((i) => SEV[i.severity].rank));
    return [...m.entries()]
      .map(([c, l]) => [c, l.map((x, k) => [x, k] as const).sort((a, b) => SEV[b[0].severity].rank - SEV[a[0].severity].rank || a[1] - b[1]).map(([x]) => x)] as [string, Issue[]])
      .sort((a, b) => top(b[1]) - top(a[1]) || b[1].length - a[1].length);
  }, [snap, severityFilter, accepted]);

  const acceptedEntries = Object.entries(accepted);
  const [copied, setCopied] = useState(false);
  function copyResolutionsJson() {
    const resolved: Record<string, { decision: string; value: string | number | null }> = {};
    for (const [k, v] of acceptedEntries) resolved[k] = { decision: v.decision, value: v.value };
    navigator.clipboard?.writeText(JSON.stringify({ resolved }, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {});
  }

  // Classic CSV: every issue in the snapshot, same columns.
  const exportCsv = () => downloadCsv(`data_cleanup_${new Date().toISOString().slice(0, 10)}`,
    ['Category', 'Severity', 'Customer', 'Allmoxy ID', 'HubSpot Instance ID', 'Installer ID', 'HubSpot Company ID', 'Pay Status', 'Action'],
    (snap?.issues ?? []).map((i) => [i.category_label, i.severity, i.customer_name ?? i.account_name ?? '', i.allmoxy_customer_id ?? i.suggested_aid ?? '',
      i.instance_id ?? '', i.installer_id ?? '', i.hubspot_company_id ?? '', i.pay_status ?? i.hubspot_pay_status ?? '', i.action]));

  const agg = snap?.aggregates;
  const shownN = issuesByCategory.reduce((s, [, l]) => s + l.length, 0);
  const v = (n: number | undefined) => (isLoading ? '…' : String(n ?? 0));

  return (
    <DsPage
      path="/data-cleanup"
      title="Data Cleanup"
      subtitle="Every data problem we can detect across HubSpot, the xlsx Sync Sheet and the Stripe Connect mapping. Fixing these improves every report that joins the sources."
      actions={<button className="am-btn am-btn--outlined" onClick={exportCsv} disabled={!snap?.issues?.length}><Icon name="download" />Export CSV</button>}
    >
      {error ? <p className="am-card__text">Failed to load data_cleanup: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="High severity" value={v(agg?.by_severity.high)} hint="Fix these first"
          tag={(agg?.by_severity.high ?? 0) > 0 ? 'Fix first' : 'None'} tagTone={(agg?.by_severity.high ?? 0) > 0 ? 'error' : 'success'}
          onOpen={() => setSeverityFilter(['high'])} />
        <KpiCard label="Medium severity" value={v(agg?.by_severity.medium)} hint="Fix soon"
          tag={(agg?.by_severity.medium ?? 0) > 0 ? 'Fix soon' : 'None'} tagTone={(agg?.by_severity.medium ?? 0) > 0 ? 'warning' : 'success'}
          onOpen={() => setSeverityFilter(['medium'])} />
        <KpiCard label="Low severity" value={v(agg?.by_severity.low)} hint="Tidy up when convenient"
          tag={(agg?.by_severity.low ?? 0) > 0 ? 'When convenient' : 'None'} tagTone={(agg?.by_severity.low ?? 0) > 0 ? 'neutral' : 'success'}
          onOpen={() => setSeverityFilter(['low'])} />
        <KpiCard label="Total issues" value={v(agg?.total_issues)} hint="All severities, as of the last data refresh"
          tag={(agg?.total_issues ?? 0) > 0 ? 'Open' : 'All clear'} tagTone={(agg?.total_issues ?? 0) > 0 ? 'info' : 'success'}
          onOpen={() => setSeverityFilter([])} />
      </KpiGrid>

      {acceptedEntries.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--success">{acceptedEntries.length} accepted</span>
            <p className="am-card__text" style={{ flex: '1 1 400px' }}>
              <b>{acceptedEntries.length} accepted suggestion{acceptedEntries.length === 1 ? '' : 's'}, saved in this browser only.</b> Copy the JSON and ask
              Claude to apply it to data_cleanup_resolutions.json and rebuild. They then clear for the whole team.
            </p>
            <button className="am-btn am-btn--filled" onClick={copyResolutionsJson}><Icon name="content_copy" />{copied ? 'Copied' : 'Copy JSON'}</button>
            <button className="am-btn am-btn--text" onClick={() => setAccepted({})}>Clear</button>
          </div>
        </section>
      )}

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread am-row--wrap">
          <div className="am-chart__head">
            <span className="am-chart__title">{isLoading ? 'Loading issues…' : `${shownN} issue${shownN === 1 ? '' : 's'} to fix`}</span>
            <span className="am-chart__caption">Most serious first. Accepting a suggestion removes it from this list.</span>
          </div>
          <div className="am-row am-row--wrap">
            <MultiSelect label="Severity" allText="All severities" width={220} value={severityFilter}
              onChange={(x) => setSeverityFilter(x as Severity[])}
              options={SEVERITIES.map((s) => [s, `${SEV[s].label} (${agg?.by_severity[s] ?? 0})`])} />
            {severityFilter.length > 0 && <button className="am-btn am-btn--text" onClick={() => setSeverityFilter([])}>Clear filter</button>}
          </div>
        </div>
      </section>

      {isLoading ? null : issuesByCategory.length === 0 ? (
        <section className="am-card am-card--outlined">
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '16px 0' }}>
            {severityFilter.length > 0 ? <>
              <span className="am-tag am-tag--neutral">None at this severity</span>
              <p className="am-card__text"><b>Nothing to clean up at the chosen severity.</b> All hygiene checks pass with the current filter. Clear the filter to see the rest.</p>
            </> : <>
              <span className="am-tag am-tag--success">All clear</span>
              <p className="am-card__text"><b>Nothing to clean up.</b> All hygiene checks pass.</p>
            </>}
          </div>
        </section>
      ) : issuesByCategory.map(([cat, list]) => (
        <CategoryCard key={cat} category={cat} issues={list} onAccept={acceptIssue} />
      ))}

      <p className="am-card__text">
        Generated {snap?.fetchedAt ? new Date(snap.fetchedAt).toLocaleString() : '—'} · refreshes whenever the data pipeline runs.
      </p>
    </DsPage>
  );
}

function CategoryCard({ category, issues, onAccept }: { category: string; issues: Issue[]; onAccept: AcceptFn }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <section className="am-card am-card--outlined">
      <div className="am-row am-row--spread am-row--wrap">
        <div className="am-chart__head">
          <span className="am-chart__title">{issues[0].category_label}</span>
          <span className="am-chart__caption">{categoryDescription(category)}</span>
        </div>
        <div className="am-row am-row--tight">
          <span className="am-tag am-tag--info">{issues.length} issue{issues.length > 1 ? 's' : ''}</span>
          {SEVERITIES.map((s) => {
            const n = issues.filter((i) => i.severity === s).length;
            return n ? <span key={s} className={`am-tag am-tag--${SEV[s].tone}`}>{n} {SEV[s].label.toLowerCase()}</span> : null;
          })}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <CategoryTable category={category} issues={issues} onAccept={onAccept} limit={showAll ? undefined : LIMIT} onShowAll={() => setShowAll(true)} />
      </div>
      {!showAll && issues.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {issues.length}</button>}
    </section>
  );
}

const muted = (s: ReactNode) => <span style={{ display: 'inline-block', maxWidth: 380, whiteSpace: 'normal' }}>{s}</span>;
const custUrl = (id: number) => `/customer-detail?id=${encodeURIComponent(String(id))}`;

function CategoryTable({ category, issues, onAccept, limit, onShowAll }: { category: string; issues: Issue[]; onAccept: AcceptFn; limit?: number; onShowAll: () => void }) {
  const navigate = useNavigate();
  const sevSort = (i: Issue) => SEV[i.severity].rank;
  const footFor = (n: number) => {
    const f: ReactNode[] = new Array(n).fill('');
    f[0] = `Total · ${issues.length} issue${issues.length === 1 ? '' : 's'}`;
    return f;
  };
  const common = {
    label: issues[0]?.category_label ?? category,
    limit,
    onFoot: () => onShowAll(),
    footClickable: (c: number) => c === 0 && limit != null && issues.length > limit,
  };

  if (category === 'hubspot_instance_missing_aid') {
    return (
      <DataTable {...common}
        cols={[['Account name', false], ['Installer ID', false], ['Pay status', false], ['Suggested Allmoxy ID', false], ['Severity', false], ['What to do', false], ['Accept', false]]}
        rows={issues.map((i) => [
          i.account_name || '—',
          i.installer_id ?? '—',
          i.pay_status ?? '—',
          i.suggested_aid
            ? <span key="s" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                <button className="am-btn am-btn--text" onClick={() => navigate(custUrl(i.suggested_aid!))}>{i.suggested_aid}</button>
                {i.suggested_customer_name && <span className="am-card__text">{i.suggested_customer_name}</span>}
              </span>
            : <span key="s" className="am-tag am-tag--warning">Look up by hand</span>,
          sevTag(i.severity),
          muted(i.action),
          <button key="a" className="am-btn am-btn--outlined" disabled={!i.suggested_aid}
            onClick={() => onAccept(i, 'set_instance_aid', i.suggested_aid ?? null, `Set Instance "${i.account_name}" Allmoxy ID → ${i.suggested_aid} (${i.suggested_customer_name})`)}>Accept</button>,
        ])}
        sortValues={issues.map((i) => [i.account_name ?? '', i.installer_id ?? null, i.pay_status ?? null, i.suggested_aid ?? null, sevSort(i), i.action, i.suggested_aid ? 1 : 0])}
        clickable={(c, r) => c === 0 && !!issues[r].suggested_aid}
        onCell={(r) => navigate(custUrl(issues[r].suggested_aid!))}
        foot={footFor(7)} />
    );
  }
  if (category === 'connect_mapping_orphan') {
    return (
      <DataTable {...common}
        cols={[['Customer', false], ['Connect name (no longer in export)', false], ['Pay status', false], ['Severity', false], ['What to do', false], ['Accept', false]]}
        rows={issues.map((i) => [
          i.allmoxy_customer_id ? (i.customer_name || '(unknown)') : (i.customer_name || '—'),
          i.connect_name ?? '—',
          i.pay_status || '—',
          sevTag(i.severity),
          muted(i.action),
          <button key="a" className="am-btn am-btn--outlined"
            onClick={() => onAccept(i, 'remove_connect_mapping', i.connect_name ?? null, `Remove orphaned Connect mapping "${i.connect_name}"`)}>Confirm removal</button>,
        ])}
        sortValues={issues.map((i) => [i.customer_name ?? '', i.connect_name ?? '', i.pay_status ?? null, sevSort(i), i.action, 0])}
        clickable={(c, r) => c === 0 && !!issues[r].allmoxy_customer_id}
        onCell={(r) => navigate(custUrl(issues[r].allmoxy_customer_id!))}
        foot={footFor(6)} />
    );
  }
  if (category === 'hubspot_pay_status_drift') {
    return (
      <DataTable {...common}
        cols={[['Customer', false], ['HubSpot pay status', false], ['xlsx pay status', false], ['Installer ID', false], ['Severity', false], ['Accept which?', false]]}
        rows={issues.map((i) => [
          i.customer_name || '—',
          i.hubspot_pay_status ?? '—',
          i.xlsx_pay_status ?? '—',
          i.installer_id ?? '—',
          sevTag(i.severity),
          // One choice of two, so the certified segmented buttons: same width on every row.
          <Segmented key="a" label={`Which pay status is right for ${i.customer_name}`} value={null}
            options={[['use_hubspot', 'HubSpot'], ['use_xlsx', 'xlsx']]}
            onChange={(d) => d === 'use_hubspot'
              ? onAccept(i, 'use_hubspot', i.hubspot_pay_status ?? null, `${i.customer_name}: pay status → "${i.hubspot_pay_status}" (HubSpot)`)
              : onAccept(i, 'use_xlsx', i.xlsx_pay_status ?? null, `${i.customer_name}: pay status → "${i.xlsx_pay_status}" (xlsx)`)} />,
        ])}
        sortValues={issues.map((i) => [i.customer_name ?? '', i.hubspot_pay_status ?? null, i.xlsx_pay_status ?? null, i.installer_id ?? null, sevSort(i), 0])}
        clickable={(c, r) => c === 0 && !!issues[r].allmoxy_customer_id}
        onCell={(r) => navigate(custUrl(issues[r].allmoxy_customer_id!))}
        foot={footFor(6)} />
    );
  }
  // Generic table (company ID ghosts and any future category).
  return (
    <DataTable {...common}
      cols={[['Customer', false], ['Detail', false], ['Severity', false], ['What to do', false], ['Accept', false]]}
      rows={issues.map((i) => [
        i.customer_name || i.account_name || '—',
        i.hubspot_company_id ?? i.installer_id ?? '—',
        sevTag(i.severity),
        muted(i.action),
        <button key="a" className="am-btn am-btn--outlined"
          onClick={() => onAccept(i, 'acknowledge', null, `${i.category_label}: ${i.customer_name || i.account_name}`)}>Accept</button>,
      ])}
      sortValues={issues.map((i) => [i.customer_name || i.account_name || '', i.hubspot_company_id ?? i.installer_id ?? null, sevSort(i), i.action, 0])}
      clickable={(c, r) => c === 0 && !!issues[r].allmoxy_customer_id}
      onCell={(r) => navigate(custUrl(issues[r].allmoxy_customer_id!))}
      foot={footFor(5)} />
  );
}
