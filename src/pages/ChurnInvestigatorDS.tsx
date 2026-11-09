/**
 * Churn Investigator on the Allmoxy design system. Data logic is ported verbatim from the classic
 * page (ChurnInvestigator.tsx, kept at /churn-investigator-classic): the master list is every
 * customer_profiles row with status 'churned' that is not excluded from the logo count, merged
 * with churn_inferences and churn_research_classifications; the same reason cascade (your
 * classification > HubSpot recorded > deep research > usable AI inference), the same stats, the
 * same filters and the same "Export master file" CSV.
 *
 * Your classifications are saved exactly as on the classic page: browser localStorage key
 * 'allmoxy:churn-classifications:v1' (and 'allmoxy:churn-classifier-name' for your name), so a
 * reason confirmed on either page shows on both.
 *
 * The page is a work list: one row per churned customer, biggest lifetime $ first. Selecting a
 * customer opens a side sheet with the evidence, the recommended action and the classify form.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import { segmentLabel, CANONICAL_SEGMENTS } from '../lib/segmentsRegistry';
import { exportRowsAsCsv, type CsvColumn } from '../lib/csvExport';
import { DataTable, DsPage, FilterChip, Icon, KpiCard, KpiGrid, Select, SideSheet, usd } from '../design-system/parts';

// Canonical Allmoxy Churn Playbook reasons (matches ChurnPatterns INITIATIVES). Multi-select.
const CANONICAL_CHURN_REASONS = [
  'Failed Implementation', 'Features', 'Pricing', 'Business Model Change', 'Moved to Other Solution',
  'Paid and Never Used', 'Out of Business', 'Customer Stakeholder Misalignment', 'Ownership Transition',
  'Timing Not Right', 'Payment Failure', 'Catalog Unidentified', 'Unresponsive',
] as const;
type ChurnReason = (typeof CANONICAL_CHURN_REASONS)[number];
type Classification = { reasons: ChurnReason[]; notes: string; classified_at: string; classified_by: string };

// Same keys and shape as the classic page, so classifications are shared between the two.
const CLASSIFICATION_STORAGE_KEY = 'allmoxy:churn-classifications:v1';
const CLASSIFIER_STORAGE_KEY = 'allmoxy:churn-classifier-name';

function useChurnClassifications() {
  const [store, setStore] = useState<Record<string, Classification>>(() => {
    try { const raw = localStorage.getItem(CLASSIFICATION_STORAGE_KEY); return raw ? JSON.parse(raw) as Record<string, Classification> : {}; } catch { return {}; }
  });
  const [classifierName, setClassifierName] = useState<string>(() => {
    try { return localStorage.getItem(CLASSIFIER_STORAGE_KEY) ?? ''; } catch { return ''; }
  });
  useEffect(() => { try { localStorage.setItem(CLASSIFICATION_STORAGE_KEY, JSON.stringify(store)); } catch { /* private mode */ } }, [store]);
  useEffect(() => { try { localStorage.setItem(CLASSIFIER_STORAGE_KEY, classifierName); } catch { /* private mode */ } }, [classifierName]);
  const set = useCallback((customerId: number, c: Omit<Classification, 'classified_at' | 'classified_by'>) => {
    setStore((prev) => ({ ...prev, [String(customerId)]: { ...c, classified_at: new Date().toISOString(), classified_by: classifierName || 'unknown' } }));
  }, [classifierName]);
  const clear = useCallback((customerId: number) => {
    setStore((prev) => { const next = { ...prev }; delete next[String(customerId)]; return next; });
  }, []);
  return { store, set, clear, classifierName, setClassifierName };
}

type SegmentLookupRow = {
  allmoxy_customer_id: number; name: string; primary_segment: string | null; sub_segment: string | null; status: string;
  churn_reason: string | null; hubspot_company_id: string | null; lifetime_subscription: number | null; years_with_us: number | null;
  excluded_from_logo_count?: boolean;
};
type InferenceCustomer = {
  allmoxy_customer_id: number; name: string; hubspot_company_id: string | null; lifetime_subscription: number;
  years_with_us: number | null; current_status: string; suggested_reason: string; confidence: 'high' | 'medium' | 'low';
  evidence_quote: string; evidence_date: string | null; signals: string[]; hubspot_url: string | null; recommended_action: string;
  reason_source?: 'inference' | 'hubspot' | 'none';
};
type InferencesSnapshot = { fetchedAt: string; generatedBy: string; customer_count: number; notes: string; customers: InferenceCustomer[] };
type ResearchClassification = {
  allmoxy_customer_id: number; name: string; hubspot_company_id: string | null; hubspot_url: string | null; lifetime_subscription: number;
  proposed_churn_reason: string; confidence: 'high' | 'medium' | 'low';
  evidence_quotes: Array<{ date: string | null; quote: string; interpretation: string }>;
  supporting_facts?: Record<string, string | number | null>; alternative_reasons_considered?: string[];
  recommended_action: string; source_batch?: string;
};
type ResearchSnapshot = { fetched_at: string; total: number; classifications_by_customer_id: Record<string, ResearchClassification> };

function mapProposedToCanonical(proposed: string): ChurnReason[] {
  if (!proposed) return [];
  if (proposed.includes('FALSE POSITIVE')) return [];
  const p = proposed.toLowerCase();
  if (p.startsWith('features')) return ['Features'];
  if (p.startsWith('pricing')) return ['Pricing'];
  if (p.startsWith('payment failure')) return ['Payment Failure'];
  if (p.startsWith('unresponsive')) return ['Unresponsive'];
  if (p.startsWith('catalog unidentified')) return ['Catalog Unidentified'];
  if (p.startsWith('out of business')) return ['Out of Business'];
  if (p.startsWith('paid and never used')) return ['Paid and Never Used'];
  if (p.startsWith('business model change')) return ['Business Model Change'];
  if (p.startsWith('moved to other solution')) return ['Moved to Other Solution'];
  if (p.startsWith('failed implementation')) return ['Failed Implementation'];
  if (p.startsWith('customer stakeholder misalignment')) return ['Customer Stakeholder Misalignment'];
  if (p.startsWith('ownership transition')) return ['Ownership Transition'];
  if (p.startsWith('timing not right')) return ['Timing Not Right'];
  const exact = CANONICAL_CHURN_REASONS.find((r) => r.toLowerCase() === p);
  if (exact) return [exact];
  return [];
}

// Same rule as the classic page (and ChurnPatterns): placeholders and low-confidence default
// "Unresponsive" do not count as a usable proposal.
function isUsableInference(c: InferenceCustomer): boolean {
  if (c.reason_source !== 'inference') return false;
  if (!c.suggested_reason) return false;
  if (/^\(.*\)$/.test(c.suggested_reason.trim())) return false;
  if (c.confidence === 'low' && c.suggested_reason === 'Unresponsive') return false;
  return true;
}

type Filter = 'all' | 'confirmed' | 'needs_review' | 'researched' | 'my_classifications' | 'unclassified';
type Status = 'confirmed' | 'review' | 'unclassified';
const STATUS: Record<Status, { label: string; tone: 'success' | 'warning' | 'error' }> = {
  confirmed: { label: 'Confirmed', tone: 'success' },
  review: { label: 'Needs review', tone: 'warning' },
  unclassified: { label: 'Unclassified', tone: 'error' },
};
const CONF_TONE: Record<'high' | 'medium' | 'low', 'success' | 'warning' | 'neutral'> = { high: 'success', medium: 'warning', low: 'neutral' };
const LIMIT = 25;
const clip = (s: string) => (s.length > 240 ? s.slice(0, 240) + '…' : s);

export default function ChurnInvestigatorDS() {
  const { data, isLoading, error } = useSheetTab('churn_inferences');
  const snap = data as unknown as InferencesSnapshot | undefined;
  const { data: profilesData, isLoading: profilesLoading } = useSheetTab('customer_profiles');
  const { data: researchData } = useSheetTab('churn_research_classifications');

  const researchByCustomerId = useMemo(() => {
    const s = researchData as unknown as ResearchSnapshot | undefined;
    const map = new Map<number, ResearchClassification>();
    if (!s?.classifications_by_customer_id) return map;
    for (const [k, v] of Object.entries(s.classifications_by_customer_id)) map.set(Number(k), v);
    return map;
  }, [researchData]);
  const segmentByCustomerId = useMemo(() => {
    const m = new Map<number, { primary: string | null; sub: string | null }>();
    const rows = (profilesData as unknown as { rows: SegmentLookupRow[] } | undefined)?.rows ?? [];
    for (const r of rows) m.set(r.allmoxy_customer_id, { primary: r.primary_segment ?? null, sub: r.sub_segment ?? null });
    return m;
  }, [profilesData]);

  const [filter, setFilterRaw] = useState<Filter>('all');
  const [segmentFilter, setSegmentFilterRaw] = useState<string>('all');
  const [showAll, setShowAll] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const setFilter = (f: Filter) => { setFilterRaw(f); setShowAll(false); };
  const setSegmentFilter = (s: string) => { setSegmentFilterRaw(s); setShowAll(false); };
  const classifications = useChurnClassifications();

  // Master list of every real churn, exactly as the classic page builds it.
  const customers: InferenceCustomer[] = useMemo(() => {
    const profileRows = (profilesData as unknown as { rows: SegmentLookupRow[] } | undefined)?.rows ?? [];
    const inferenceById = new Map<number, InferenceCustomer>();
    for (const c of snap?.customers ?? []) inferenceById.set(c.allmoxy_customer_id, c);
    return profileRows
      .filter((r) => r.status === 'churned' && !r.excluded_from_logo_count)
      .map<InferenceCustomer>((p) => {
        const existing = inferenceById.get(p.allmoxy_customer_id);
        if (existing) return { ...existing, reason_source: 'inference' };
        const hasHubspotReason = !!(p.churn_reason && p.churn_reason.trim());
        return {
          allmoxy_customer_id: p.allmoxy_customer_id,
          name: p.name,
          hubspot_company_id: p.hubspot_company_id,
          lifetime_subscription: p.lifetime_subscription ?? 0,
          years_with_us: p.years_with_us,
          current_status: hasHubspotReason ? 'hubspot_recorded' : 'unclassified',
          suggested_reason: hasHubspotReason ? (p.churn_reason as string) : '(no reason recorded yet)',
          confidence: hasHubspotReason ? 'high' : 'low',
          evidence_quote: hasHubspotReason
            ? `HubSpot Company.churn_reason field: "${p.churn_reason}"`
            : 'No reason recorded from any source yet — needs manual classification.',
          evidence_date: null,
          signals: hasHubspotReason ? ['HubSpot recorded'] : [],
          hubspot_url: hubspotCompanyUrl(p.hubspot_company_id),
          recommended_action: hasHubspotReason
            ? 'Already classified from HubSpot. Confirm or override if you have new information.'
            : 'No source has a reason for this customer. Classify based on what you know.',
          reason_source: hasHubspotReason ? 'hubspot' : 'none',
        };
      });
  }, [profilesData, snap]);

  const isUserClassified = useCallback((c: InferenceCustomer) => !!classifications.store[String(c.allmoxy_customer_id)], [classifications.store]);
  const isConfirmed = useCallback((c: InferenceCustomer) => isUserClassified(c) || c.reason_source === 'hubspot', [isUserClassified]);
  const statusOf = useCallback((c: InferenceCustomer): Status =>
    isConfirmed(c) ? 'confirmed' : (researchByCustomerId.has(c.allmoxy_customer_id) || isUsableInference(c)) ? 'review' : 'unclassified',
  [isConfirmed, researchByCustomerId]);

  // Same filters as the classic page. "Needs review" keeps the classic rule (everything not
  // confirmed, so it includes unclassified rows); "Unclassified" is an added view of just those.
  const filtered = useMemo(() => {
    let rows = customers;
    if (filter === 'confirmed') rows = rows.filter(isConfirmed);
    else if (filter === 'needs_review') rows = rows.filter((c) => !isConfirmed(c));
    else if (filter === 'researched') rows = rows.filter((c) => researchByCustomerId.has(c.allmoxy_customer_id));
    else if (filter === 'my_classifications') rows = rows.filter(isUserClassified);
    else if (filter === 'unclassified') rows = rows.filter((c) => statusOf(c) === 'unclassified');
    if (segmentFilter !== 'all') rows = rows.filter((c) => segmentByCustomerId.get(c.allmoxy_customer_id)?.primary === segmentFilter);
    return rows;
  }, [customers, filter, segmentFilter, segmentByCustomerId, isUserClassified, isConfirmed, researchByCustomerId, statusOf]);

  const segmentOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of customers) {
      const seg = segmentByCustomerId.get(c.allmoxy_customer_id)?.primary;
      if (!seg) continue;
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
    return CANONICAL_SEGMENTS.filter((s) => counts.has(s.value)).map((s) => ({ value: s.value, label: s.label, count: counts.get(s.value)! }));
  }, [customers, segmentByCustomerId]);

  const stats = useMemo(() => {
    let totalDollars = 0, confirmedDollars = 0, needsReviewDollars = 0, unclassifiedDollars = 0;
    let confirmedCount = 0, needsReviewCount = 0, unclassifiedCount = 0, hubspotRecordedCount = 0, userClassifiedCount = 0, researchedCount = 0;
    for (const c of customers) {
      totalDollars += c.lifetime_subscription;
      const userHas = isUserClassified(c);
      const hubspotHas = c.reason_source === 'hubspot';
      const researchHas = researchByCustomerId.has(c.allmoxy_customer_id);
      if (userHas) userClassifiedCount++;
      if (hubspotHas) hubspotRecordedCount++;
      if (researchHas) researchedCount++;
      if (userHas || hubspotHas) { confirmedDollars += c.lifetime_subscription; confirmedCount++; }
      else if (researchHas || isUsableInference(c)) { needsReviewDollars += c.lifetime_subscription; needsReviewCount++; }
      else { unclassifiedDollars += c.lifetime_subscription; unclassifiedCount++; }
    }
    return { totalDollars, confirmedDollars, needsReviewDollars, unclassifiedDollars, confirmedCount, needsReviewCount, unclassifiedCount, hubspotRecordedCount, userClassifiedCount, researchedCount };
  }, [customers, isUserClassified, researchByCustomerId]);

  // Current reason and its source, the same cascade the classic card and CSV use.
  const reasonOf = useCallback((c: InferenceCustomer): { reason: string; source: string; conf?: 'high' | 'medium' | 'low' } => {
    const user = classifications.store[String(c.allmoxy_customer_id)];
    if (user) return { reason: user.reasons.join(' + '), source: 'Your classification' };
    if (c.reason_source === 'hubspot') return { reason: c.suggested_reason, source: 'HubSpot recorded' };
    const res = researchByCustomerId.get(c.allmoxy_customer_id);
    if (res) return { reason: res.proposed_churn_reason, source: 'Research', conf: res.confidence };
    if (isUsableInference(c)) return { reason: c.suggested_reason, source: 'AI inference', conf: c.confidence };
    return { reason: '', source: 'Unclassified' };
  }, [classifications.store, researchByCustomerId]);

  // Work order: biggest lifetime $ first (the list itself keeps every classic row).
  const ordered = useMemo(() => [...filtered].sort((a, b) => b.lifetime_subscription - a.lifetime_subscription), [filtered]);
  const list = showAll ? ordered : ordered.slice(0, LIMIT);
  const filteredTotal = filtered.reduce((s, c) => s + c.lifetime_subscription, 0);

  // Identical columns, values and file name to the classic "Export master file" button.
  const exportMaster = () => {
    const store = classifications.store;
    const columns: CsvColumn<InferenceCustomer>[] = [
      { key: 'allmoxy_customer_id', label: 'Allmoxy ID' },
      { key: 'name', label: 'Company name' },
      { key: 'lifetime_subscription', label: 'Lifetime Subscription $' },
      { key: 'effective_reason', label: 'Churn Reason', getValue: (c) => {
        const user = store[String(c.allmoxy_customer_id)];
        if (user) return user.reasons.join('; ');
        if (c.reason_source === 'hubspot') return c.suggested_reason;
        const res = researchByCustomerId.get(c.allmoxy_customer_id);
        if (res) return res.proposed_churn_reason;
        return isUsableInference(c) ? c.suggested_reason : '';
      } },
      { key: 'reason_source', label: 'Source', getValue: (c) => {
        if (store[String(c.allmoxy_customer_id)]) return 'Your classification';
        if (c.reason_source === 'hubspot') return 'HubSpot recorded';
        if (researchByCustomerId.has(c.allmoxy_customer_id)) return 'Deep research (agent)';
        if (isUsableInference(c)) return 'AI inference';
        return 'Unclassified';
      } },
      { key: 'confirmed', label: 'Confirmed?', getValue: (c) => ((store[String(c.allmoxy_customer_id)] || c.reason_source === 'hubspot') ? 'yes' : 'no') },
      { key: 'my_notes', label: 'Your Notes', getValue: (c) => store[String(c.allmoxy_customer_id)]?.notes ?? '' },
      { key: 'classified_by', label: 'Classified By', getValue: (c) => store[String(c.allmoxy_customer_id)]?.classified_by ?? '' },
      { key: 'classified_at', label: 'Classified At', getValue: (c) => store[String(c.allmoxy_customer_id)]?.classified_at ?? '' },
      { key: 'hubspot_company_id', label: 'HubSpot Company ID' },
      { key: 'hubspot_url', label: 'HubSpot Link' },
    ];
    exportRowsAsCsv(`churn_master_classifications_${new Date().toISOString().slice(0, 10)}`, columns, filtered);
  };

  const open = openId != null ? customers.find((c) => c.allmoxy_customer_id === openId) ?? null : null;
  const loading = isLoading || profilesLoading;
  const pctConfirmed = customers.length > 0 ? Math.round((stats.confirmedCount / customers.length) * 100) : 0;
  const FILTER_WORD: Record<Filter, string> = {
    all: 'All churns', confirmed: 'Confirmed', needs_review: 'Needs review', researched: 'Has research',
    my_classifications: 'My classifications', unclassified: 'Unclassified',
  };

  return (
    <DsPage
      path="/churn-investigator"
      title="Churn Investigator"
      subtitle="The master classification file for every churned customer. Each row carries its current reason from the strongest available source (your classification, then HubSpot recorded, then deep research, then AI inference). Confirm or override any row; this dashboard is the system of record."
      actions={<button className="am-btn am-btn--outlined" onClick={exportMaster} disabled={!filtered.length}><Icon name="download" />Export master file</button>}
      overlays={
        <SideSheet open={!!open} onClose={() => setOpenId(null)} title={open?.name ?? ''}>
          {open && (
            <CustomerDetail
              key={open.allmoxy_customer_id}
              c={open}
              seg={segmentByCustomerId.get(open.allmoxy_customer_id)}
              research={researchByCustomerId.get(open.allmoxy_customer_id)}
              status={statusOf(open)}
              classification={classifications.store[String(open.allmoxy_customer_id)]}
              onSave={(reasons, notes) => classifications.set(open.allmoxy_customer_id, { reasons, notes })}
              onClear={() => classifications.clear(open.allmoxy_customer_id)}
            />
          )}
        </SideSheet>
      }
    >
      {error ? <p className="am-card__text">Failed to load data: {String(error)}</p> : null}

      <KpiGrid>
        <KpiCard label="Needs your review" value={loading ? '…' : stats.needsReviewCount.toLocaleString()}
          hint={`${usd(stats.needsReviewDollars)} lifetime $ · has a proposal (research or AI) awaiting your confirmation. ${stats.researchedCount} have deep-research evidence.`}
          tag={stats.needsReviewCount > 0 ? 'Needs action' : 'Clear'} tagTone={stats.needsReviewCount > 0 ? 'warning' : 'success'}
          onOpen={() => setFilter('needs_review')} />
        <KpiCard label="Unclassified" value={loading ? '…' : stats.unclassifiedCount.toLocaleString()}
          hint={`${usd(stats.unclassifiedDollars)} lifetime $ · no reason from any source. ${stats.unclassifiedCount === 0 ? 'Every churn has a classification.' : 'Needs manual entry.'}`}
          tag={stats.unclassifiedCount > 0 ? 'Needs entry' : 'None'} tagTone={stats.unclassifiedCount > 0 ? 'error' : 'success'}
          onOpen={() => setFilter('unclassified')} />
        <KpiCard label="Confirmed" value={loading ? '…' : `${stats.confirmedCount.toLocaleString()} · ${pctConfirmed}%`}
          hint={`${usd(stats.confirmedDollars)} lifetime $ · ${stats.userClassifiedCount} by you · ${stats.hubspotRecordedCount} from HubSpot`}
          tag="Locked in" tagTone="success" onOpen={() => setFilter('confirmed')} />
        <KpiCard label="Total churns" value={loading ? '…' : customers.length.toLocaleString()}
          hint={`${usd(stats.totalDollars)} lifetime $`} tag="All churned customers" tagTone="neutral" onOpen={() => setFilter('all')} />
      </KpiGrid>

      <section className="am-card am-card--outlined">
        <div className="am-row am-row--spread">
          <div className="am-chart__head">
            <span className="am-chart__title">{FILTER_WORD[filter]}{segmentFilter !== 'all' ? ` · ${segmentLabel(segmentFilter)}` : ''} · {filtered.length} customers · {usd(filteredTotal)}</span>
            <span className="am-chart__caption">Biggest lifetime $ first. Select a customer to see the evidence and confirm or override the reason.</span>
          </div>
        </div>
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Show</span>
          <Select label="Show" width={260} value={filter} onPick={(v) => setFilter(v as Filter)} options={[
            ['all', `All (${customers.length})`],
            ['confirmed', `Confirmed (${stats.confirmedCount})`],
            ['needs_review', `Needs review (${stats.needsReviewCount})`],
            ['unclassified', `Unclassified (${stats.unclassifiedCount})`],
            ['researched', `Has research (${stats.researchedCount})`],
            ['my_classifications', `My classifications (${stats.userClassifiedCount})`],
          ]} />
          {segmentOptions.length > 0 && <>
            <span className="am-card__text">Segment</span>
            <Select label="Segment" width={260} value={segmentFilter} onPick={setSegmentFilter} options={[
              ['all', `All (${customers.length})`], ...segmentOptions.map((s) => [s.value, `${s.label} (${s.count})`] as [string, string]),
            ]} />
          </>}
          <label className="am-field am-field--outlined" style={{ minWidth: 0, width: 220 }}>
            <input className="am-field__input" placeholder=" " value={classifications.classifierName}
              onChange={(e) => classifications.setClassifierName(e.target.value)} aria-label="Your name (stamped on classifications)" />
            <span className="am-field__label">Your name</span>
            <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap">Your name</i><i /></span>
          </label>
        </div>
        {filter === 'needs_review' && stats.unclassifiedCount > 0 && (
          <p className="am-card__text">Needs review lists every customer not yet confirmed, so it includes the {stats.unclassifiedCount} unclassified ones (as on the classic page).</p>
        )}

        {loading ? <p className="am-card__text">Loading churned customers…</p> : (
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Churned customers"
              cols={[['Customer', false], ['Segment', false], ['Lifetime $', true], ['Tenure', true], ['Current reason', false], ['Source', false], ['Status', false]]}
              rows={list.map((c) => {
                const seg = segmentByCustomerId.get(c.allmoxy_customer_id);
                const r = reasonOf(c);
                const st = STATUS[statusOf(c)];
                const research = researchByCustomerId.get(c.allmoxy_customer_id);
                return [
                  <span key="n" style={{ display: 'inline-block', maxWidth: 240, whiteSpace: 'normal', textAlign: 'left' }}>{c.name}</span>,
                  seg?.primary ? segmentLabel(seg.primary) : '—',
                  usd(c.lifetime_subscription),
                  c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y` : 'n/a',
                  <span key="r" className="am-row am-row--tight" style={{ maxWidth: 320, whiteSpace: 'normal' }}>
                    <span>{r.reason || 'No reason yet'}</span>
                    {research?.proposed_churn_reason.includes('FALSE POSITIVE') && <span className="am-tag am-tag--warning">Maybe not a churn</span>}
                  </span>,
                  <span key="s" className="am-row am-row--tight" style={{ flexWrap: 'nowrap' }}>
                    <span className="am-card__text" style={{ whiteSpace: 'nowrap' }}>{r.source}</span>
                    {r.conf && <span className={`am-tag am-tag--${CONF_TONE[r.conf]}`}>{r.conf}</span>}
                  </span>,
                  <span key="t" className={`am-tag am-tag--${st.tone}`}>{st.label}</span>,
                ];
              })}
              sortValues={list.map((c) => {
                const seg = segmentByCustomerId.get(c.allmoxy_customer_id);
                const r = reasonOf(c);
                return [c.name.toLowerCase(), seg?.primary ? segmentLabel(seg.primary) : null, c.lifetime_subscription, c.years_with_us, r.reason || null, r.source, statusOf(c)];
              })}
              clickable={(col) => col === 0}
              onCell={(i) => setOpenId(list[i].allmoxy_customer_id)}
              foot={[`Total · ${filtered.length} customers`, '', usd(filteredTotal), '', '', '', '']}
              onFoot={() => setShowAll(true)} footClickable={(col) => (col === 0 || col === 2) && !showAll && ordered.length > LIMIT} />
          </div>
        )}
        {!loading && filtered.length === 0 && <p className="am-card__text">No customers in this view.</p>}
        {!showAll && ordered.length > LIMIT && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {ordered.length}</button>}
        <p className="am-card__text">
          Showing {list.length} of {filtered.length} in this view ({customers.length} churned customers in all). Your classifications are saved in this browser (shared with the classic page); export the master file when you are ready to push them to HubSpot.
        </p>
      </section>
    </DsPage>
  );
}

// ---------------------------------------------------------------- side sheet: one customer
function CustomerDetail({ c, seg, research, status, classification, onSave, onClear }: {
  c: InferenceCustomer; seg?: { primary: string | null; sub: string | null }; research?: ResearchClassification; status: Status;
  classification: Classification | undefined; onSave: (reasons: ChurnReason[], notes: string) => void; onClear: () => void;
}) {
  const hubspotRecorded = c.reason_source === 'hubspot';
  const usable = isUsableInference(c);
  const accept = research ? mapProposedToCanonical(research.proposed_churn_reason) : [];
  const st = STATUS[status];
  const sourceLabel = classification ? 'Your classification' : hubspotRecorded ? 'HubSpot recorded'
    : research ? `Research · ${research.confidence}` : usable ? `AI inference · ${c.confidence}` : 'Unclassified';

  let headLabel: string, headReason: string;
  if (classification) { headLabel = 'Your classification'; headReason = classification.reasons.join(' + '); }
  else if (hubspotRecorded) { headLabel = 'Recorded in HubSpot'; headReason = c.suggested_reason; }
  else if (research) { headLabel = `Research-proposed · ${research.confidence} confidence`; headReason = research.proposed_churn_reason; }
  else if (usable) { headLabel = `AI inference · ${c.confidence} confidence`; headReason = c.suggested_reason; }
  else { headLabel = 'Unclassified'; headReason = 'No reason from any source. Classify manually below.'; }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="am-row am-row--wrap am-row--tight">
        <span className={`am-tag am-tag--${st.tone}`}>{st.label}</span>
        <span className="am-tag am-tag--neutral">{sourceLabel}</span>
        {seg?.primary && <span className="am-tag am-tag--info" title="Primary segment">{segmentLabel(seg.primary)}</span>}
        {seg?.sub && <span className="am-tag am-tag--neutral" title="Sub-segment">{seg.sub}</span>}
      </div>
      <p className="am-card__text">
        {usd(c.lifetime_subscription)} lifetime · {c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y tenure` : 'tenure n/a'} · Allmoxy ID {c.allmoxy_customer_id}
        {' · '}
        {c.hubspot_url
          ? <a className="am-btn am-btn--text" href={c.hubspot_url} target="_blank" rel="noopener noreferrer">Open in HubSpot<Icon name="open_in_new" /></a>
          : 'No HubSpot record linked'}
      </p>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__caption">{headLabel}</span>
          <span className="am-chart__title">{headReason}</span>
        </div>
        {research && accept.length > 0 && (
          <div className="am-row">
            <button className="am-btn am-btn--outlined" disabled={!!classification}
              onClick={() => onSave(accept, `Auto-accepted from deep HubSpot research (${research.source_batch}). ${research.recommended_action}`)}>
              {classification ? <><Icon name="check" />Already classified</> : `Accept "${accept.join(' + ')}"`}
            </button>
          </div>
        )}
        {research && research.proposed_churn_reason.includes('FALSE POSITIVE') && (
          <div className="am-row am-row--tight">
            <span className="am-tag am-tag--warning">Maybe not a churn</span>
            <span className="am-card__text">The research flagged this as a false positive. See customer_status_overrides.json or adjust manually. Do not classify it as a churn.</span>
          </div>
        )}
      </section>

      <section>
        <div className="am-chart__head"><span className="am-chart__title">Recommended action</span></div>
        <p className="am-card__text">{research?.recommended_action ?? c.recommended_action}</p>
      </section>

      {research && research.evidence_quotes.length > 0 ? (
        <section>
          <div className="am-chart__head">
            <span className="am-chart__title">HubSpot evidence</span>
            <span className="am-chart__caption">{research.evidence_quotes.length} quote(s)</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {research.evidence_quotes.map((eq, i) => (
              <div key={i} className="am-card am-card--outlined">
                {eq.date && <span className="am-chart__caption">{eq.date}</span>}
                <p className="am-card__text">“{clip(eq.quote)}”</p>
                {eq.interpretation && <p className="am-card__text">→ {eq.interpretation}</p>}
              </div>
            ))}
          </div>
          {(research.alternative_reasons_considered?.length ?? 0) > 0 && (
            <>
              <div className="am-chart__head" style={{ marginTop: 12 }}><span className="am-chart__title">Alternative reasons considered and ruled out</span></div>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {research.alternative_reasons_considered!.map((a, i) => <li key={i} className="am-card__text">{a}</li>)}
              </ul>
            </>
          )}
        </section>
      ) : (
        <section>
          <div className="am-chart__head">
            <span className="am-chart__title">Evidence</span>
            {c.evidence_date && <span className="am-chart__caption">{c.evidence_date}</span>}
          </div>
          <p className="am-card__text">“{c.evidence_quote}”</p>
          {c.signals.length > 0 && (
            <div className="am-row am-row--wrap am-row--tight">
              <span className="am-card__text">Signals</span>
              {c.signals.map((s, i) => <span key={i} className="am-tag am-tag--neutral">{s}</span>)}
            </div>
          )}
        </section>
      )}

      <ClassificationForm classification={classification} onSave={onSave} onClear={onClear} />
    </div>
  );
}

// Same behavior as the classic form: multi-select reasons + notes; Save stamps your name and the
// time; Clear asks first. Persists through useChurnClassifications (localStorage).
function ClassificationForm({ classification, onSave, onClear }: {
  classification: Classification | undefined; onSave: (reasons: ChurnReason[], notes: string) => void; onClear: () => void;
}) {
  const [selected, setSelected] = useState<ChurnReason[]>(classification?.reasons ?? []);
  const [notes, setNotes] = useState<string>(classification?.notes ?? '');
  useEffect(() => { setSelected(classification?.reasons ?? []); setNotes(classification?.notes ?? ''); }, [classification]);
  const dirty = JSON.stringify(selected) !== JSON.stringify(classification?.reasons ?? []) || notes !== (classification?.notes ?? '');
  const toggle = (r: ChurnReason) => setSelected((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));
  const save = () => {
    if (selected.length === 0) { alert('Pick at least one churn reason before saving.'); return; }
    onSave(selected, notes.trim());
  };
  const clear = () => { if (confirm('Clear your classification for this customer?')) onClear(); };
  return (
    <section className="am-card am-card--outlined">
      <div className="am-chart__head">
        <span className="am-chart__title">My classification</span>
        <span className="am-chart__caption">
          {classification
            ? `${classification.reasons.join(' + ')} · ${classification.classified_by} · ${new Date(classification.classified_at).toLocaleString()}`
            : 'Not classified by you yet. Pick one or more reasons.'}
        </span>
      </div>
      {classification && <div className="am-row"><span className="am-tag am-tag--success"><Icon name="check" />Saved</span></div>}
      <div className="am-row am-row--wrap am-row--tight">
        {CANONICAL_CHURN_REASONS.map((r) => <FilterChip key={r} checked={selected.includes(r)} onChange={() => toggle(r)}>{r}</FilterChip>)}
      </div>
      <label className="am-field am-field--outlined am-field--multiline" style={{ width: '100%' }}>
        <textarea className="am-field__input" placeholder=" " rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
          aria-label="Notes (optional)" />
        <span className="am-field__label">Notes (optional): what you saw in HubSpot or remember</span>
        <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap">Notes (optional): what you saw in HubSpot or remember</i><i /></span>
      </label>
      <div className="am-row am-row--wrap">
        <button className="am-btn am-btn--filled" onClick={save} disabled={!dirty || selected.length === 0}>Save classification</button>
        {classification && <button className="am-btn am-btn--outlined" onClick={clear}>Clear</button>}
      </div>
    </section>
  );
}
