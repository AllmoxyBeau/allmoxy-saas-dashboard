/**
 * Sub-segment Backfill on the Allmoxy design system. Data logic and storage are the classic
 * page's (SubSegmentBackfill.tsx, kept at /sub-segment-backfill-classic): customer_profiles minus
 * excluded_from_logo_count records, the same status / primary filters and sort (current MRR, then
 * lifetime subscription), and classifications kept in this browser's localStorage under the SAME
 * keys ('allmoxy:subsegment-classifications:v1' and 'allmoxy:subsegment-classifier-name'), so
 * work done on either page shows on the other. The CSV export has the classic columns and name.
 *
 * Layout: progress cards, your name (needed to classify), filters, then the to-do list as a table
 * with one fixed-width Classify action per row; the form opens in a side sheet.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import segmentFramework from '../data/segment_framework.json';
import {
  CustomerLink, DataTable, DsPage, Icon, KpiCard, KpiGrid, Link, Segmented, Select, SideSheet, Switch, downloadCsv, usd,
} from '../design-system/parts';

type Profile = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_company_id: string | null;
  primary_segment: string | null;
  sub_segment: string | null;
  status: string;
  current_subscription_mrr: number;
  lifetime_subscription: number;
  years_with_us: number | null;
  sign_up_date: string | null;
  excluded_from_logo_count?: boolean;
};
type Classification = {
  customer_id: number;
  primary_segment: string | null;
  sub_segment: string;
  notes: string;
  classified_by: string;
  classified_at: string;
};
type Store = Record<string, Classification>;

const STORAGE_KEY = 'allmoxy:subsegment-classifications:v1';
const NAME_KEY = 'allmoxy:subsegment-classifier-name';
const FRAMEWORK = segmentFramework as { primary_segments: string[]; sub_segments_by_primary: Record<string, string[]> };

function readStore(): Store {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function writeStore(s: Store) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

// The classic page's hook, unchanged: same keys, same write-through on every change.
function useSubSegmentClassifications() {
  const [store, setStore] = useState<Store>(() => readStore());
  const [classifierName, setClassifierNameState] = useState<string>(() => localStorage.getItem(NAME_KEY) || '');
  const setClassifierName = useCallback((n: string) => {
    setClassifierNameState(n);
    localStorage.setItem(NAME_KEY, n);
  }, []);
  useEffect(() => writeStore(store), [store]);
  const save = useCallback((id: number, c: Omit<Classification, 'customer_id' | 'classified_at'> & { classified_at?: string }) => {
    setStore((prev) => ({ ...prev, [String(id)]: { customer_id: id, classified_at: c.classified_at || new Date().toISOString(), ...c } }));
  }, []);
  const remove = useCallback((id: number) => {
    setStore((prev) => { const next = { ...prev }; delete next[String(id)]; return next; });
  }, []);
  return { store, save, remove, classifierName, setClassifierName };
}

/** Plain outlined text field (the certified am-field, as SearchField draws it, without the icon). */
function TextField({ label, value, onChange, width, onEnter }: { label: string; value: string; onChange: (v: string) => void; width?: number | string; onEnter?: () => void }) {
  return (
    <label className="am-field am-field--outlined" style={{ width }}>
      <input className="am-field__input" placeholder=" " value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onEnter) onEnter(); }} />
      <span className="am-field__label">{label}</span>
      <span className="am-field__box" aria-hidden="true"><i /><i className="am-field__gap">{label}</i><i /></span>
    </label>
  );
}

const statusTone = (s: string) => (s === 'active' ? 'success' : s === 'churned' ? 'error' : 'neutral');
const statusWord = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '—');

function ClassificationForm({ profile, existing, classifierName, onSave, onClear }: {
  profile: Profile; existing: Classification | null; classifierName: string;
  onSave: (c: Omit<Classification, 'customer_id' | 'classified_at'>) => void; onClear: () => void;
}) {
  const [primarySelected, setPrimarySelected] = useState(existing?.primary_segment ?? profile.primary_segment ?? '');
  const [subSelected, setSubSelected] = useState(existing?.sub_segment ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const subOptions: string[] = useMemo(() => FRAMEWORK.sub_segments_by_primary[primarySelected] || [], [primarySelected]);
  const canSave = !!(primarySelected && subSelected && classifierName);
  const subEmpty = !primarySelected ? 'Pick a primary segment first' : subOptions.length === 0 ? 'No sub-segments under this primary' : 'Select a sub-segment';
  return (
    <>
      <div className="am-row am-row--wrap">
        <div className="am-row am-row--tight">
          <span className="am-card__text">Primary segment</span>
          <Select label="Primary segment" width={300} value={primarySelected} onPick={(v) => { setPrimarySelected(v); setSubSelected(''); }}
            options={[['', 'Select a primary segment'], ...FRAMEWORK.primary_segments.map((p) => [p, p] as [string, string])]} />
        </div>
        <div className="am-row am-row--tight">
          <span className="am-card__text">Sub-segment</span>
          <Select label="Sub-segment" width={300} value={subSelected} onPick={setSubSelected}
            options={[['', subEmpty], ...subOptions.map((s) => [s, s] as [string, string])]} />
        </div>
      </div>
      <TextField label="Notes / evidence (optional)" value={notes} onChange={setNotes} width="100%" />
      <p className="am-card__text">For example: their website shows custom shop work.</p>
      {!classifierName && <p className="am-card__text"><span className="am-tag am-tag--warning">Name needed</span> Enter your name on the page before saving, so each classification is attributed on the export.</p>}
      <div className="am-row am-row--wrap">
        <button className="am-btn am-btn--filled" disabled={!canSave}
          onClick={() => onSave({ primary_segment: primarySelected || null, sub_segment: subSelected, notes, classified_by: classifierName })}>
          {existing ? 'Update classification' : 'Save classification'}
        </button>
        {existing && <button className="am-btn am-btn--outlined" onClick={onClear}>Clear classification</button>}
      </div>
    </>
  );
}

export default function SubSegmentBackfillDS() {
  const { data, isLoading, error } = useSheetTab('customer_profiles');
  const profiles: Profile[] = useMemo(() => {
    const rows = (data as unknown as { rows: Profile[] } | undefined)?.rows ?? [];
    return rows.filter((r) => !r.excluded_from_logo_count);
  }, [data]);
  const classifications = useSubSegmentClassifications();

  const [statusFilter, setStatusFilter] = useState<'active' | 'churned' | 'all'>('active');
  const [primaryFilter, setPrimaryFilter] = useState<string>('all');
  const [showAlreadyTagged, setShowAlreadyTagged] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [changingName, setChangingName] = useState(false);

  const isClassified = useCallback((p: Profile) => !!classifications.store[String(p.allmoxy_customer_id)], [classifications.store]);

  const missing = useMemo(() => {
    let rows = profiles.filter((p) => !p.sub_segment || !p.sub_segment.trim());
    if (!showAlreadyTagged) rows = rows.filter((p) => !isClassified(p));
    if (statusFilter !== 'all') rows = rows.filter((p) => p.status === statusFilter);
    if (primaryFilter !== 'all') rows = rows.filter((p) => (p.primary_segment ?? '') === primaryFilter);
    return rows.sort((a, b) => b.current_subscription_mrr - a.current_subscription_mrr || b.lifetime_subscription - a.lifetime_subscription);
  }, [profiles, statusFilter, primaryFilter, showAlreadyTagged, isClassified]);

  const primaryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of profiles) {
      if (p.sub_segment && p.sub_segment.trim()) continue;
      if (statusFilter !== 'all' && p.status !== statusFilter) continue;
      const key = (p.primary_segment ?? '').trim() || '(no primary segment)';
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [profiles, statusFilter]);

  const coverage = useMemo(() => {
    const total = profiles.length;
    const withSub = profiles.filter((p) => p.sub_segment && p.sub_segment.trim()).length;
    const userClassified = Object.keys(classifications.store).length;
    const active = profiles.filter((p) => p.status === 'active');
    const activeMissing = active.filter((p) => !p.sub_segment || !p.sub_segment.trim());
    const activeMissingClassified = activeMissing.filter(isClassified).length;
    return {
      total, withSub, withSubPct: total > 0 ? withSub / total : 0, userClassified,
      activeMissing: activeMissing.length, activeMissingClassified,
      activeMissingPct: activeMissing.length > 0 ? activeMissingClassified / activeMissing.length : 0,
    };
  }, [profiles, classifications.store, isClassified]);

  const classifiedRows = useMemo(() => Object.values(classifications.store).map((c) => {
    const p = profiles.find((pr) => pr.allmoxy_customer_id === c.customer_id);
    return { ...c, customer_name: p?.name ?? `#${c.customer_id}`, hubspot_company_id: p?.hubspot_company_id ?? '', status: p?.status ?? '', current_mrr: p?.current_subscription_mrr ?? 0 };
  }), [classifications.store, profiles]);

  const exportCsv = () => downloadCsv(`subsegment_backfill_classifications_${new Date().toISOString().slice(0, 10)}`,
    ['Allmoxy ID', 'Customer', 'HubSpot Company ID', 'Primary Segment', 'Sub Segment (for HubSpot push)', 'Status', 'Current MRR', 'Notes', 'Classified by', 'Classified at'],
    classifiedRows.map((r) => [r.customer_id, r.customer_name, r.hubspot_company_id ?? '', r.primary_segment ?? '', r.sub_segment ?? '', r.status, r.current_mrr, r.notes ?? '', r.classified_by ?? '', r.classified_at ?? '']));

  const editProfile = editing != null ? profiles.find((p) => p.allmoxy_customer_id === editing) ?? null : null;
  const editExisting = editProfile ? classifications.store[String(editProfile.allmoxy_customer_id)] || null : null;
  // A primary filter whose bucket vanished under a new status keeps working, as on the classic page.
  const primaryOptions: Array<[string, string]> = [['all', 'All primary segments'],
    ...[...primaryCounts.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => [p, `${p} (${n})`] as [string, string])];
  if (primaryFilter !== 'all' && !primaryCounts.has(primaryFilter)) primaryOptions.push([primaryFilter, `${primaryFilter} (0)`]);
  const subSegCount = Object.values(FRAMEWORK.sub_segments_by_primary).flat().length;
  const saveName = () => { const n = nameDraft.trim(); if (n) { classifications.setClassifierName(n); setChangingName(false); } };

  return (
    <DsPage
      path="/sub-segment-backfill"
      title="Sub-segment Backfill"
      subtitle="QoE-8: give every customer a canonical Primary + Sub Segment in HubSpot. Active customers without a sub-segment come first: buyers want a clean segmentation cut of the book."
      actions={
        <button className="am-btn am-btn--outlined" disabled={classifiedRows.length === 0} onClick={exportCsv}>
          <Icon name="download" />Export my {classifiedRows.length} classifications
        </button>
      }
      overlays={editProfile && (
        <SideSheet open onClose={() => setEditing(null)} title={`Classify · ${editProfile.name}`}
          text={`${statusWord(editProfile.status)} · HubSpot primary: ${editProfile.primary_segment ?? 'none'} · MRR ${usd(editProfile.current_subscription_mrr)} · lifetime ${usd(editProfile.lifetime_subscription)}${editProfile.years_with_us ? ` · ${editProfile.years_with_us.toFixed(1)} yrs` : ''}${editProfile.sign_up_date ? ` · signed up ${editProfile.sign_up_date}` : ''}`}>
          <div className="am-row am-row--wrap">
            <CustomerLink id={editProfile.allmoxy_customer_id} name="Open customer detail" />
            {hubspotCompanyUrl(editProfile.hubspot_company_id) && <Link href={hubspotCompanyUrl(editProfile.hubspot_company_id)!}>Open in HubSpot</Link>}
            {editExisting && <span className="am-tag am-tag--success">Classified: {editExisting.sub_segment}</span>}
          </div>
          <ClassificationForm key={editProfile.allmoxy_customer_id} profile={editProfile} existing={editExisting} classifierName={classifications.classifierName}
            onSave={(c) => { classifications.save(editProfile.allmoxy_customer_id, c); setEditing(null); }}
            onClear={() => { classifications.remove(editProfile.allmoxy_customer_id); setEditing(null); }} />
        </SideSheet>
      )}
    >
      {error ? <p className="am-card__text">Could not load customer profiles: {String(error)}</p> : null}

      <KpiGrid max={4}>
        <KpiCard label="Active missing a sub-segment" value={coverage.activeMissing.toLocaleString()}
          hint={`${coverage.activeMissingClassified} classified by you (${(coverage.activeMissingPct * 100).toFixed(0)}%)`}
          tag={coverage.activeMissing === 0 ? 'Done' : coverage.activeMissingClassified >= coverage.activeMissing ? 'Ready to push' : 'To do'}
          tagTone={coverage.activeMissing === 0 || coverage.activeMissingClassified >= coverage.activeMissing ? 'success' : 'warning'} />
        <KpiCard label="With a sub-segment" value={`${coverage.withSub.toLocaleString()} · ${(coverage.withSubPct * 100).toFixed(0)}%`} hint="Source: HubSpot sub_segment_framework" />
        <KpiCard label="Total customers" value={coverage.total.toLocaleString()} hint="Excludes deduped records (duplicate_of / sub-instance)" />
        <KpiCard label="Classified by you" value={coverage.userClassified.toLocaleString()} hint="Saved in this browser; export the CSV to push to HubSpot" />
      </KpiGrid>
      <p className="am-card__text">Next: work through the active customers below. When done, export the CSV and bulk-update HubSpot's sub_segment_framework property.</p>

      {(!classifications.classifierName || changingName) ? (
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Your name</span>
            <span className="am-chart__caption">Needed before you classify. Saved in this browser so each classification is attributed on the CSV export.</span>
          </div>
          <div className="am-row am-row--wrap">
            <TextField label="Your name" value={nameDraft} onChange={setNameDraft} width={260} onEnter={saveName} />
            <button className="am-btn am-btn--filled" disabled={!nameDraft.trim()} onClick={saveName}>Use this name</button>
            {changingName && <button className="am-btn am-btn--text" onClick={() => setChangingName(false)}>Cancel</button>}
          </div>
        </section>
      ) : (
        <div className="am-row am-row--wrap">
          <span className="am-card__text">Classifying as <b>{classifications.classifierName}</b></span>
          <button className="am-btn am-btn--text" onClick={() => { setNameDraft(classifications.classifierName); setChangingName(true); }}>Change</button>
        </div>
      )}

      <div className="am-row am-row--wrap">
        <Segmented label="Status" value={statusFilter} onChange={(v) => { setStatusFilter(v); setShowAll(false); }}
          options={[['active', `Active (${coverage.activeMissing})`], ['churned', 'Churned'], ['all', 'All']]} />
        <div className="am-row am-row--tight">
          <span className="am-card__text">Primary</span>
          <Select label="Primary segment filter" width={300} value={primaryFilter} onPick={(v) => { setPrimaryFilter(v); setShowAll(false); }} options={primaryOptions} />
        </div>
        <Switch checked={showAlreadyTagged} onChange={(v) => { setShowAlreadyTagged(v); setShowAll(false); }}>Include my {classifiedRows.length} classifications</Switch>
      </div>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Customers without a sub-segment</span>
          <span className="am-chart__caption">Highest current MRR first, then lifetime subscription · {missing.length.toLocaleString()} shown under the filters</span>
        </div>
        {isLoading ? <p className="am-card__text">Loading…</p> : missing.length === 0 ? (
          <p className="am-card__text">
            {showAlreadyTagged && classifiedRows.length > 0 ? 'All matching customers are already classified.'
              : statusFilter === 'active' ? 'No active customers missing sub-segment under the current filter.' : 'No customers match.'}
          </p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <DataTable label="Customers without a sub-segment"
                cols={[['Customer', false], ['Status', false], ['HubSpot primary', false], ['Your classification', false], ['MRR', true], ['Lifetime', true], ['Years', true], ['Signed up', false], ['HubSpot', false], ['Action', false]]}
                rows={missing.map((p) => {
                  const ex = classifications.store[String(p.allmoxy_customer_id)];
                  const hs = hubspotCompanyUrl(p.hubspot_company_id);
                  return [
                    <CustomerLink key="c" id={p.allmoxy_customer_id} name={p.name} />,
                    <span key="s" className={`am-tag am-tag--${statusTone(p.status)}`}>{statusWord(p.status)}</span>,
                    p.primary_segment ? p.primary_segment : <span key="p" className="am-tag am-tag--warning">No primary</span>,
                    ex ? <span key="x" className="am-tag am-tag--success">{ex.sub_segment}</span> : <span key="x" className="am-tag am-tag--neutral">Not yet</span>,
                    usd(p.current_subscription_mrr), usd(p.lifetime_subscription),
                    p.years_with_us ? p.years_with_us.toFixed(1) : '—', p.sign_up_date ?? '—',
                    hs ? <Link key="h" href={hs}>Open</Link> : '—',
                    <button key="a" className="am-btn am-btn--text" style={{ minWidth: 88 }} onClick={() => setEditing(p.allmoxy_customer_id)}>{ex ? 'Edit' : 'Classify'}</button>,
                  ];
                })}
                sortValues={missing.map((p) => {
                  const ex = classifications.store[String(p.allmoxy_customer_id)];
                  return [(p.name ?? '').toLowerCase(), p.status, p.primary_segment ?? null, ex?.sub_segment ?? null, p.current_subscription_mrr, p.lifetime_subscription, p.years_with_us ?? null, p.sign_up_date ?? null, p.hubspot_company_id ? 1 : 0, ex ? 1 : 0];
                })}
                limit={showAll ? undefined : 25}
                foot={[`Total · ${missing.length.toLocaleString()} customers`, '', '', '', usd(missing.reduce((a, p) => a + p.current_subscription_mrr, 0)), usd(missing.reduce((a, p) => a + p.lifetime_subscription, 0)), '', '', '', '']}
                onFoot={() => setShowAll(true)}
                footClickable={(col) => !showAll && missing.length > 25 && (col === 0 || col === 4 || col === 5)} />
            </div>
            {!showAll && missing.length > 25 && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {missing.length.toLocaleString()}</button>}
          </>
        )}
      </section>

      <section className="am-card am-card--outlined">
        <div className="am-chart__head">
          <span className="am-chart__title">Pushing to HubSpot</span>
        </div>
        <p className="am-card__text">
          When you've worked through the active list, export your classifications (button at the top). The CSV is shaped for HubSpot's bulk import: the HubSpot Company ID
          column maps to hs_object_id and the sub-segment column to sub_segment_framework. Settings → Imports → Start an import → Companies. The notes column is for your
          own reference; drop or keep as needed.
        </p>
        <p className="am-card__text">
          Canonical framework: <b>{FRAMEWORK.primary_segments.length} primary segments</b> × <b>{subSegCount} sub segments</b>, sourced from HubSpot.
          Edit the grouping in src/data/segment_framework.json.
        </p>
      </section>
    </DsPage>
  );
}
