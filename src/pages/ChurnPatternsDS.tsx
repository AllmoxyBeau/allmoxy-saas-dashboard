/**
 * Churn Patterns on the Allmoxy design system. Assembled from the shared certified parts
 * (src/design-system/parts.tsx). Data logic is the classic page's (ChurnPatterns.tsx, kept at
 * /churn-patterns-classic): same snapshots (customer_profiles, churn_inferences,
 * churn_subpatterns, churn_research_classifications), the same Churn Investigator localStorage
 * overlay (read-only, polled), the same reason cascade, dollar weighting and clusters.
 *
 * Charts: the classic horizontal bars become column charts with reason categories. The bar
 * colour carries the preventability tier as a stacked series per tier (each bar fills only its
 * own tier), so the legend names every colour. The capture-rate-by-year chart is new: the
 * classic page computed both series but showed them only in the alert and one card.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSheetTab } from '../hooks/useSheetTab';
import { segmentLabel } from '../lib/segmentsRegistry';
import {
  ChartCard, ColumnChart, DataTable, DsPage, Icon, KpiCard, KpiGrid, Segmented, SideSheet,
  downloadCsv, usd,
} from '../design-system/parts';

type ProfileRow = {
  allmoxy_customer_id: number;
  name: string;
  primary_segment: string | null;
  sub_segment: string | null;
  churn_reason: string | null;
  pay_status: string | null;
  last_payment_date: string | null;
  first_payment_date: string | null;
  years_with_us: number | null;
  lifetime_subscription: number | null;
  peak_month_total: number | null;
  current_subscription_mrr: number | null;
  failed_3mo_count: number | null;
  failed_3mo_amount: number | null;
  hubspot_company_id: string | null;
  cohort_year: number | null;
  status?: string;
  excluded_from_logo_count?: boolean;
};

const CANONICAL_CHURN_REASONS = [
  'Failed Implementation', 'Features', 'Pricing', 'Business Model Change', 'Moved to Other Solution',
  'Paid and Never Used', 'Out of Business', 'Customer Stakeholder Misalignment', 'Ownership Transition',
  'Timing Not Right', 'Payment Failure', 'Catalog Unidentified', 'Unresponsive',
] as const;

// Same key as ChurnInvestigator — read only here.
const CLASS_KEY = 'allmoxy:churn-classifications:v1';
type UserClassification = { reasons: string[]; notes: string; classified_at: string; classified_by: string };

type ResearchClassification = {
  allmoxy_customer_id: number;
  proposed_churn_reason: string;
  confidence: 'high' | 'medium' | 'low';
  evidence_quotes?: Array<{ date: string | null; quote: string; interpretation: string }>;
  recommended_action?: string;
  source_batch?: string;
};
type ResearchSnap = { classifications_by_customer_id: Record<string, ResearchClassification> };

function mapProposedToCanonical(proposed: string | null | undefined): string | null {
  if (!proposed) return null;
  if (proposed.includes('FALSE POSITIVE')) return null;
  const p = proposed.toLowerCase();
  if (p.startsWith('features')) return 'Features';
  if (p.startsWith('pricing')) return 'Pricing';
  if (p.startsWith('payment failure')) return 'Payment Failure';
  if (p.startsWith('unresponsive')) return 'Unresponsive';
  if (p.startsWith('catalog unidentified')) return 'Catalog Unidentified';
  if (p.startsWith('out of business')) return 'Out of Business';
  if (p.startsWith('paid and never used')) return 'Paid and Never Used';
  if (p.startsWith('business model change')) return 'Business Model Change';
  if (p.startsWith('moved to other solution')) return 'Moved to Other Solution';
  if (p.startsWith('failed implementation')) return 'Failed Implementation';
  if (p.startsWith('customer stakeholder misalignment')) return 'Customer Stakeholder Misalignment';
  if (p.startsWith('ownership transition')) return 'Ownership Transition';
  if (p.startsWith('timing not right')) return 'Timing Not Right';
  const exact = (CANONICAL_CHURN_REASONS as readonly string[]).find((r) => r.toLowerCase() === p);
  return exact ?? null;
}

type Inference = {
  allmoxy_customer_id: number;
  name: string;
  suggested_reason: string;
  confidence: 'high' | 'medium' | 'low';
  current_status?: string;
  evidence_quote?: string;
  evidence_date?: string | null;
  recommended_action?: string;
};
type InferencesSnap = { customers: Inference[] };

type SubpatternDef = { label: string; parent: string; description: string };
type SubpatternsSnap = { subpattern_definitions: Record<string, SubpatternDef>; customer_subpatterns: Record<string, string[]> };

const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const usdc = (v: number) => USD_COMPACT.format(v);
const NO_REASON = '(no reason recorded)';

type InitiativeTier = 'process' | 'preventable-high' | 'preventable-low' | 'mixed' | 'accept';
const INITIATIVES: Record<string, { initiative: string; tier: InitiativeTier; category: string }> = {
  [NO_REASON]: {
    initiative: "Mandatory Churn Playbook completion before HubSpot cancellation. Until this lands, the rest of this page understates every cluster except this one. Assign to CSM lead — process compliance.",
    tier: 'process', category: 'Process / Compliance',
  },
  'Failed Implementation': {
    initiative: "Onboarding overhaul: productized AI Activation Package, 90-day go-live gate, milestone-paid services. These are high-MRR accounts we lose before they even start paying value.",
    tier: 'preventable-high', category: 'Onboarding',
  },
  'Features': {
    initiative: "Feature-renewal linkage: surface most-cited gaps at QBR, fast-track top 3 to next quarter, ship beta-customer commitments at renewal. These are top-quartile accounts ($2K+ MRR) leaving over product gaps.",
    tier: 'preventable-high', category: 'Product / Roadmap',
  },
  'Business Model Change': {
    initiative: "Accept — non-preventable. Build early-signal detector (industry pivot mentioned in CSM notes) so we stop investing CSM hours into doomed accounts. Goal: faster acceptance, not retention.",
    tier: 'accept', category: 'Accept / Segment',
  },
  'Moved to Other Solution': {
    initiative: "Competitor playbook + structured exit interviews. Track which competitor wins (Microvellum / Cabinet Vision / Closet Pro etc) and feed into competitive moat (data lock-in, integrations).",
    tier: 'mixed', category: 'Competitive',
  },
  'Paid and Never Used': {
    initiative: "Onboarding gate — block recurring billing past 90 days if first-order milestone not reached. Refund-or-extend the few outliers. This is the cleanest immediate win.",
    tier: 'preventable-high', category: 'Onboarding',
  },
  'Out of Business': {
    initiative: "Non-preventable. Track for segment-health analysis (cluster of OOB churns in one segment → industry headwind worth knowing).",
    tier: 'accept', category: 'Accept / Segment',
  },
  'Customer Stakeholder Misalignment': {
    initiative: "Executive-sponsor program — every account ≥ $1K MRR multi-threaded (2+ stakeholders in HubSpot). Single point of contact = single point of churn.",
    tier: 'preventable-low', category: 'Customer Success',
  },
  'Unresponsive': {
    initiative: "Health-score early warning. Auto-flag accounts with no logins / no responses at month 6. Reach-out cadence escalates if no engagement by month 9.",
    tier: 'preventable-low', category: 'Customer Success',
  },
  'Catalog Unidentified': {
    initiative: "Implementation diagnostic — flag any account with no completed catalog within 60 days of signup. Services team intervenes or refund.",
    tier: 'preventable-high', category: 'Onboarding',
  },
  'Ownership Transition': {
    initiative: "M&A radar — track HubSpot company properties for ownership changes; CSM proactively re-engages new owner within 30 days. Small cluster but high-LTV when it works.",
    tier: 'preventable-low', category: 'Customer Success',
  },
  'Timing Not Right': {
    initiative: "Sales qualification — earlier 'not now' filtering pre-onboarding. These customers shouldn't have signed.",
    tier: 'mixed', category: 'Sales / Qualification',
  },
  'Pricing': {
    initiative: "Renewal-time pricing recalibration for long-tenure / under-priced accounts. Only 2 cases recorded — likely under-counted, will grow once 'no reason' bucket gets categorized.",
    tier: 'preventable-low', category: 'Pricing',
  },
  'Payment Failure': {
    initiative: "Dunning-recovery review. Most 'Payment Failure' churns hide an underlying reason (financial distress, unresponsiveness, intentional cancel). Treat as a flag, not a root cause — every Payment Failure account should get a follow-up call to classify properly.",
    tier: 'preventable-low', category: 'Customer Success',
  },
  '(needs review)': {
    initiative: "Manual review required — Claude could not infer a confident reason from CSM notes. Most are pre-CSM-playbook era (last paid 2019-2021) or accounts with zero captured engagement. Defer until CSM compliance restoration is complete.",
    tier: 'process', category: 'Process / Compliance',
  },
  '(not churned — likely annual payer)': {
    initiative: "False positive — these customers pay annually upfront so the underlying data marks them Cancelled despite being active. Add their allmoxy_customer_id to src/data/annual_payers.json to fix the snapshot.",
    tier: 'process', category: 'Data Quality',
  },
  '(not churned — annual payer)': {
    initiative: "False positive — these customers pay annually upfront so the underlying data marks them Cancelled despite being active. Add their allmoxy_customer_id to src/data/annual_payers.json to fix the snapshot.",
    tier: 'process', category: 'Data Quality',
  },
  '(not churned — duplicate / name change)': {
    initiative: "False positive — surfaced by the former CS rep's notes (Churn Details.xlsx). These accounts are still active under a different name or as a different aid. Merge / dedupe in customer_profiles upstream before treating as real churn.",
    tier: 'process', category: 'Data Quality',
  },
};

// Tier: word + tag tone + chart tone. Preventable losses run the bad end of the diverging ramp;
// accept is neutral, process fixes are the plain blue (Revenue Waterfall colours).
const TIERS: Array<{ k: InitiativeTier; label: string; tag: 'error' | 'warning' | 'info' | 'neutral' | 'success'; tone: string }> = [
  { k: 'preventable-high', label: 'Preventable · high impact', tag: 'error', tone: 'div-5' },
  { k: 'preventable-low', label: 'Preventable · low impact', tag: 'warning', tone: 'div-4' },
  { k: 'mixed', label: 'Mixed', tag: 'warning', tone: 'div-3' },
  { k: 'accept', label: 'Accept · non-preventable', tag: 'neutral', tone: 'other' },
  { k: 'process', label: 'Process fix', tag: 'info', tone: 'div-1' },
];
const tierOf = (t: InitiativeTier) => TIERS.find((x) => x.k === t)!;
const TierTag = ({ t }: { t: InitiativeTier }) => <span className={`am-tag am-tag--${tierOf(t).tag}`}>{tierOf(t).label}</span>;

type Cluster = {
  reason: string; count: number; dollars: number; pctOfDollars: number;
  avgTenure: number | null; avgPeakMrr: number | null;
  topSegment: string | null; topSegmentCount: number; topSubSegment: string | null; topSubSegmentCount: number;
  segmentBreakdown: Array<{ name: string; count: number; dollars: number }>;
  subSegmentBreakdown: Array<{ name: string; count: number; dollars: number }>;
  customers: ProfileRow[]; inferredCount: number; initiative: string; tier: InitiativeTier; category: string;
};
type ReasonSource = 'hubspot' | 'user' | 'research-high' | 'research-medium' | 'research-low' | 'ai-high' | 'ai-medium' | 'ai-low' | 'none';
type CaptureYear = { year: string; pct: number; total: number; captured: number; pctWithAi: number; capturedWithAi: number };

const SOURCE_WORD: Record<ReasonSource, string> = {
  hubspot: 'HubSpot', user: 'Your classification', 'research-high': 'Research · high', 'research-medium': 'Research · medium',
  'research-low': 'Research · low', 'ai-high': 'AI · high', 'ai-medium': 'AI · medium', 'ai-low': 'AI · low', none: '—',
};
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const LIST = 25;
// Sheet content stacks with the block gap (layout only).
const SHEET_STACK = { display: 'flex', flexDirection: 'column' as const, gap: 'var(--am-space-block)' };

export default function ChurnPatternsDS() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useSheetTab('customer_profiles');
  const profiles = data as unknown as { rows: ProfileRow[] } | undefined;
  const { data: inferencesData } = useSheetTab('churn_inferences');
  const inferences = inferencesData as unknown as InferencesSnap | undefined;
  const { data: subpatternsData } = useSheetTab('churn_subpatterns');
  const subpatterns = subpatternsData as unknown as SubpatternsSnap | undefined;
  const { data: researchData } = useSheetTab('churn_research_classifications');
  const research = researchData as unknown as ResearchSnap | undefined;

  // Churn Investigator classifications (localStorage) override everything below HubSpot.
  const [userClassifications, setUserClassifications] = useState<Record<string, UserClassification>>(() => {
    try { return JSON.parse(localStorage.getItem(CLASS_KEY) || '{}'); } catch { return {}; }
  });
  useEffect(() => {
    function reload() {
      try { setUserClassifications(JSON.parse(localStorage.getItem(CLASS_KEY) || '{}')); } catch { /* ignore */ }
    }
    window.addEventListener('storage', reload);
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(interval); };
  }, []);

  const [drillReason, setDrillReason] = useState<string | null>(null);
  const [drillSubpattern, setDrillSubpattern] = useState<string | null>(null);
  const [includeInferred, setIncludeInferred] = useState(true);
  const [sheet, setSheet] = useState<null | 'all' | 'capture'>(null);
  const [showAllDrill, setShowAllDrill] = useState(false);
  const [showAllChurned, setShowAllChurned] = useState(false);

  const { churnedAll, totalChurnDollars, captureByYear, clusters, inferenceMap, resolved } = useMemo(() => {
    if (!profiles) return {
      churnedAll: [] as ProfileRow[], totalChurnDollars: 0, captureByYear: [] as CaptureYear[], clusters: [] as Cluster[],
      inferenceMap: new Map<number, Inference>(), resolved: new Map<number, { reason: string; source: ReasonSource }>(),
    };
    const infMap = new Map<number, Inference>();
    for (const inf of inferences?.customers ?? []) infMap.set(inf.allmoxy_customer_id, inf);

    const churned = profiles.rows.filter((r) => {
      if (r.excluded_from_logo_count) return false;
      if (r.status !== 'churned') return false;
      const inf = infMap.get(r.allmoxy_customer_id);
      if (inf?.current_status === 'false_positive_annual_payer') return false;
      return true;
    });

    // HubSpot → your classification → deep research → legacy AI → no reason.
    const resolveReason = (c: ProfileRow): { reason: string; source: ReasonSource } => {
      if (c.churn_reason && c.churn_reason.trim()) return { reason: c.churn_reason, source: 'hubspot' };
      if (!includeInferred) return { reason: NO_REASON, source: 'none' };
      const userClass = userClassifications[String(c.allmoxy_customer_id)];
      if (userClass?.reasons && userClass.reasons.length > 0) return { reason: userClass.reasons.join('; '), source: 'user' };
      const rc = research?.classifications_by_customer_id?.[String(c.allmoxy_customer_id)];
      if (rc) {
        const canonical = mapProposedToCanonical(rc.proposed_churn_reason);
        if (canonical) {
          const src: ReasonSource = rc.confidence === 'high' ? 'research-high' : rc.confidence === 'medium' ? 'research-medium' : 'research-low';
          return { reason: canonical, source: src };
        }
      }
      const inf = infMap.get(c.allmoxy_customer_id);
      if (!inf) return { reason: NO_REASON, source: 'none' };
      if (inf.confidence === 'low' && inf.suggested_reason === 'Unresponsive') return { reason: NO_REASON, source: 'none' };
      if (typeof inf.suggested_reason === 'string' && /^\(.*\)$/.test(inf.suggested_reason.trim())) return { reason: NO_REASON, source: 'none' };
      const src: ReasonSource = inf.confidence === 'high' ? 'ai-high' : inf.confidence === 'medium' ? 'ai-medium' : 'ai-low';
      return { reason: inf.suggested_reason, source: src };
    };

    const byYear: Record<string, { total: number; captured: number; capturedWithAi: number }> = {};
    for (const c of churned) {
      const yr = c.last_payment_date ? c.last_payment_date.slice(0, 4) : 'unknown';
      if (!byYear[yr]) byYear[yr] = { total: 0, captured: 0, capturedWithAi: 0 };
      byYear[yr].total++;
      const hubspotHas = !!(c.churn_reason && c.churn_reason.trim());
      const userHas = !!userClassifications[String(c.allmoxy_customer_id)]?.reasons?.length;
      const rc = research?.classifications_by_customer_id?.[String(c.allmoxy_customer_id)];
      const researchHas = !!(rc && mapProposedToCanonical(rc.proposed_churn_reason));
      const inf = infMap.get(c.allmoxy_customer_id);
      const aiHasUsable = inf && !(inf.confidence === 'low' && inf.suggested_reason === 'Unresponsive');
      if (hubspotHas) byYear[yr].captured++;
      if (hubspotHas || userHas || researchHas || aiHasUsable) byYear[yr].capturedWithAi++;
    }
    const captureByYear: CaptureYear[] = Object.entries(byYear)
      .filter(([y]) => /^\d{4}$/.test(y))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([year, d]) => ({
        year,
        pct: d.total > 0 ? (d.captured / d.total) * 100 : 0,
        pctWithAi: d.total > 0 ? (d.capturedWithAi / d.total) * 100 : 0,
        total: d.total, captured: d.captured, capturedWithAi: d.capturedWithAi,
      }));

    const totalDollars = churned.reduce((s, c) => s + (c.lifetime_subscription || 0), 0);
    type SegBuckets = Record<string, { count: number; dollars: number }>;
    const byReason: Record<string, { count: number; dollars: number; tenureSum: number; tenureN: number; peakSum: number; peakN: number; segments: SegBuckets; subSegments: SegBuckets; customers: ProfileRow[]; inferredCount: number }> = {};
    const resolved = new Map<number, { reason: string; source: ReasonSource }>();
    for (const c of churned) {
      const res = resolveReason(c);
      resolved.set(c.allmoxy_customer_id, res);
      const { reason: rawReason, source } = res;
      const reasons = rawReason.split(';').map((s) => s.trim()).filter(Boolean);
      const weight = (c.lifetime_subscription || 0) / reasons.length;
      const isInferred = source !== 'hubspot' && source !== 'none';
      for (const r of reasons) {
        if (!byReason[r]) byReason[r] = { count: 0, dollars: 0, tenureSum: 0, tenureN: 0, peakSum: 0, peakN: 0, segments: {}, subSegments: {}, customers: [], inferredCount: 0 };
        const b = byReason[r];
        b.count++;
        b.dollars += weight;
        b.customers.push(c);
        if (isInferred) b.inferredCount++;
        if (c.years_with_us != null) { b.tenureSum += c.years_with_us; b.tenureN++; }
        if (c.peak_month_total != null) { b.peakSum += c.peak_month_total; b.peakN++; }
        const seg = c.primary_segment || '(unsegmented)';
        if (!b.segments[seg]) b.segments[seg] = { count: 0, dollars: 0 };
        b.segments[seg].count++;
        b.segments[seg].dollars += weight;
        const sub = c.sub_segment || '(unspecified)';
        if (!b.subSegments[sub]) b.subSegments[sub] = { count: 0, dollars: 0 };
        b.subSegments[sub].count++;
        b.subSegments[sub].dollars += weight;
      }
    }

    const clusters: Cluster[] = Object.entries(byReason).map(([reason, d]) => {
      const init = INITIATIVES[reason] ?? { initiative: 'No mapped initiative for this category — review playbook config.', tier: 'mixed' as InitiativeTier, category: 'Other' };
      const segmentBreakdown = Object.entries(d.segments).map(([name, v]) => ({ name, count: v.count, dollars: v.dollars })).sort((a, b) => b.count - a.count);
      const subSegmentBreakdown = Object.entries(d.subSegments).map(([name, v]) => ({ name, count: v.count, dollars: v.dollars })).sort((a, b) => b.count - a.count);
      const namedSub = subSegmentBreakdown.find((s) => s.name !== '(unspecified)') ?? null;
      return {
        reason, count: d.count, dollars: d.dollars,
        pctOfDollars: totalDollars > 0 ? d.dollars / totalDollars : 0,
        avgTenure: d.tenureN > 0 ? d.tenureSum / d.tenureN : null,
        avgPeakMrr: d.peakN > 0 ? d.peakSum / d.peakN : null,
        topSegment: segmentBreakdown[0]?.name ?? null, topSegmentCount: segmentBreakdown[0]?.count ?? 0,
        topSubSegment: namedSub?.name ?? null, topSubSegmentCount: namedSub?.count ?? 0,
        segmentBreakdown, subSegmentBreakdown, customers: d.customers, inferredCount: d.inferredCount,
        initiative: init.initiative, tier: init.tier, category: init.category,
      };
    }).sort((a, b) => b.dollars - a.dollars);

    return { churnedAll: churned, totalChurnDollars: totalDollars, captureByYear, clusters, inferenceMap: infMap, resolved };
  }, [profiles, inferences, includeInferred, research, userClassifications]);

  const noReasonCluster = clusters.find((c) => c.reason === NO_REASON);
  const biggestRealCluster = clusters.find((c) => c.reason !== NO_REASON);
  const latestCapture = captureByYear[captureByYear.length - 1];
  const peakCapture = captureByYear.reduce<CaptureYear | null>((acc, r) => (acc == null || r.pct > acc.pct ? r : acc), null);
  const drillCluster = drillReason ? clusters.find((c) => c.reason === drillReason) ?? null : null;
  const thisYear = String(new Date().getFullYear());

  const drillSubpatternStats = useMemo(() => {
    if (!drillCluster || !subpatterns) return null;
    const defs = subpatterns.subpattern_definitions || {};
    const tagsByAid = subpatterns.customer_subpatterns || {};
    const validIds = Object.entries(defs).filter(([, def]) => drillCluster.reason.split(';').some((r) => r.trim() === def.parent)).map(([id]) => id);
    if (validIds.length === 0) return null;
    const stats = new Map<string, { count: number; dollars: number }>();
    let anyTaggedCount = 0;
    for (const cust of drillCluster.customers) {
      const tags = tagsByAid[String(cust.allmoxy_customer_id)] || [];
      const matched = tags.filter((t) => validIds.includes(t));
      if (matched.length > 0) anyTaggedCount++;
      for (const t of matched) {
        const s = stats.get(t) || { count: 0, dollars: 0 };
        s.count++;
        s.dollars += cust.lifetime_subscription || 0;
        stats.set(t, s);
      }
    }
    return {
      stats: [...stats.entries()].map(([id, s]) => ({ id, label: defs[id]?.label ?? id, description: defs[id]?.description ?? '', ...s })).sort((a, b) => b.count - a.count),
      taggedCount: anyTaggedCount,
      untaggedCount: drillCluster.customers.length - anyTaggedCount,
    };
  }, [drillCluster, subpatterns]);

  const openReason = (reason: string) => { setDrillReason(reason); setDrillSubpattern(null); setShowAllDrill(false); };
  const closeDrill = () => { setDrillReason(null); setDrillSubpattern(null); };
  const goCustomer = (r: ProfileRow) => navigate(`/customer-detail?id=${encodeURIComponent(String(r.allmoxy_customer_id))}`);

  // Classic drill table's Source / evidence cells (HubSpot vs legacy AI inference).
  const sourceText = (r: ProfileRow) => {
    if (r.churn_reason && r.churn_reason.trim()) return 'HubSpot';
    const inf = inferenceMap.get(r.allmoxy_customer_id);
    return inf ? `AI · ${inf.confidence}` : '—';
  };
  const evidenceText = (r: ProfileRow) => {
    if (r.churn_reason && r.churn_reason.trim()) return r.churn_reason;
    const inf = inferenceMap.get(r.allmoxy_customer_id);
    if (!inf) return '—';
    const quote = inf.evidence_quote ? ` — "${inf.evidence_quote.slice(0, 120)}${inf.evidence_quote.length > 120 ? '…' : ''}"` : '';
    return `${inf.suggested_reason}${quote}`;
  };

  // ---- customer table (cluster drill and "all churned" sheet share it)
  const customerTable = (list: ProfileRow[], showAll: boolean, setShowAll: (v: boolean) => void, label: string, withReason: boolean) => {
    const rows = showAll ? list : list.slice(0, LIST);
    const cols: Array<[string, boolean]> = [['Customer', false], ...(withReason ? [['Reason used', false] as [string, boolean]] : []), ['Segment', false], ['Sub-segment', false], ['Lifetime sub $', true], ['Peak MRR', true], ['Tenure (y)', true], ['Last payment', false], ['Last-3mo failures', true], ['Source', false], ['Full reason / evidence', false]];
    const lifetime = list.reduce((s, r) => s + (r.lifetime_subscription || 0), 0);
    const fails = list.reduce((s, r) => s + (r.failed_3mo_count || 0), 0);
    const more = !showAll && list.length > LIST;
    const reasonCell = (r: ProfileRow) => { const x = resolved.get(r.allmoxy_customer_id); return x ? `${x.reason}${x.source !== 'hubspot' && x.source !== 'none' ? ` (${SOURCE_WORD[x.source]})` : ''}` : '—'; };
    return (
      <>
        <div style={{ overflowX: 'auto' }}>
          <DataTable label={label} cols={cols}
            rows={rows.map((r) => [
              r.name, ...(withReason ? [reasonCell(r)] : []), r.primary_segment ? segmentLabel(r.primary_segment) : '—', r.sub_segment || '—',
              usd(r.lifetime_subscription || 0), r.peak_month_total != null ? usd(r.peak_month_total) : '—',
              r.years_with_us != null ? r.years_with_us.toFixed(1) : '—', r.last_payment_date || '—', String(r.failed_3mo_count || 0),
              sourceText(r) === 'HubSpot' ? <span className="am-tag am-tag--success">HubSpot</span> : sourceText(r) === '—' ? '—' : <span className="am-tag am-tag--info">{sourceText(r)}</span>,
              <span style={{ display: 'block', minWidth: 260 }}>{evidenceText(r)}</span>,
            ])}
            sortValues={rows.map((r) => [
              r.name?.toLowerCase() ?? '', ...(withReason ? [reasonCell(r)] : []), r.primary_segment ?? '', r.sub_segment ?? '', r.lifetime_subscription || 0, r.peak_month_total,
              r.years_with_us, r.last_payment_date ?? '', r.failed_3mo_count || 0, sourceText(r), evidenceText(r),
            ])}
            clickable={(col) => col === 0} onCell={(row) => goCustomer(rows[row])}
            foot={cols.map(([c], j) => (j === 0 ? `Total · ${list.length} customers` : c === 'Lifetime sub $' ? usd(lifetime) : c === 'Last-3mo failures' ? String(fails) : ''))}
            footClickable={(col) => col === 0 && more} onFoot={() => setShowAll(true)} />
        </div>
        {more && <button className="am-btn am-btn--text" onClick={() => setShowAll(true)}>Show all {list.length}</button>}
      </>
    );
  };
  const exportCustomers = (filename: string, list: ProfileRow[]) => downloadCsv(filename,
    ['Customer', 'Customer ID', 'Reason used', 'Reason source', 'Segment', 'Sub-segment', 'Lifetime sub $', 'Peak MRR', 'Tenure (y)', 'Last payment', 'Last-3mo failures', 'Source', 'Full reason / evidence'],
    list.map((r) => {
      const x = resolved.get(r.allmoxy_customer_id);
      return [r.name, r.allmoxy_customer_id, x?.reason ?? '', x ? SOURCE_WORD[x.source] : '', r.primary_segment ? segmentLabel(r.primary_segment) : '', r.sub_segment ?? '',
        r.lifetime_subscription || 0, r.peak_month_total ?? '', r.years_with_us ?? '', r.last_payment_date ?? '', r.failed_3mo_count || 0, sourceText(r), evidenceText(r)];
    }));

  // ---- drill sheet for one reason cluster
  const drillSheet = drillCluster && (() => {
    const tagsByAid = subpatterns?.customer_subpatterns || {};
    const rows = (drillSubpattern
      ? drillCluster.customers.filter((c) => (tagsByAid[String(c.allmoxy_customer_id)] || []).includes(drillSubpattern))
      : drillCluster.customers.slice()
    ).sort((a, b) => (b.lifetime_subscription || 0) - (a.lifetime_subscription || 0));
    const filenameBase = `churn_pattern_${drillCluster.reason.replace(/\W+/g, '_')}` + (drillSubpattern ? `__${drillSubpattern}` : '');
    const segs = drillCluster.segmentBreakdown.filter((s) => s.name !== '(unsegmented)');
    const subs = drillCluster.subSegmentBreakdown.filter((s) => s.name !== '(unspecified)');
    const sp = drillSubpatternStats;
    const subLabel = sp?.stats.find((s) => s.id === drillSubpattern)?.label ?? drillSubpattern;
    const breakdown = (title: string, list: Array<{ name: string; count: number; dollars: number }>, fmtName: (n: string) => string) => (
      <div style={{ overflowX: 'auto' }}>
        <DataTable label={title} cols={[[title, false], ['Customers', true], ['Weighted churn $', true]]}
          rows={list.map((s) => [fmtName(s.name), String(s.count), usd(s.dollars)])}
          sortValues={list.map((s) => [fmtName(s.name), s.count, s.dollars])}
          foot={[`Total · ${list.length}`, String(list.reduce((a, s) => a + s.count, 0)), usd(list.reduce((a, s) => a + s.dollars, 0))]} />
      </div>
    );
    return (
      <SideSheet open onClose={closeDrill}
        title={`${drillCluster.reason} · ${rows.length}${drillSubpattern ? ` of ${drillCluster.customers.length}` : ''} customers${drillCluster.inferredCount > 0 && !drillSubpattern ? ` (${drillCluster.inferredCount} not from HubSpot)` : ''}`}
        text={drillSubpattern
          ? `Filtered to "${subLabel}" · ${usdc(rows.reduce((s, r) => s + (r.lifetime_subscription || 0), 0))} of lifetime $`
          : `${usdc(drillCluster.dollars)} of lifetime $ · ${(drillCluster.pctOfDollars * 100).toFixed(1)}% of total churn $ · sorted by lifetime sub`}>
        <div className="am-sidesheet__body"><div style={SHEET_STACK}>
        <div className="am-row am-row--wrap"><TierTag t={drillCluster.tier} /><span className="am-tag am-tag--neutral">{drillCluster.category}</span></div>
        <p className="am-card__text"><b>Recommended initiative.</b> {drillCluster.initiative}</p>

        {(segs.length > 0 || subs.length > 0) && <>
          <span className="am-chart__title">Where this churn lives · by segment</span>
          {segs.length > 0 && breakdown('Primary segment', segs, segmentLabel)}
          {subs.length > 0 ? breakdown('Sub-segment', subs, (n) => n)
            : <p className="am-card__text">No sub-segment data for this cluster (customers missing HubSpot sub_segment_framework).</p>}
        </>}

        {sp && sp.stats.length > 0 && <>
          <div className="am-row am-row--spread">
            <span className="am-chart__title">Sub-patterns</span>
            <span className="am-chart__caption">{sp.taggedCount}/{drillCluster.customers.length} customers tagged · {sp.untaggedCount} untagged · select a column to filter the list</span>
          </div>
          <ColumnChart months={sp.stats.map((s) => s.id)}
            series={[{ key: 'count', label: 'Customers', tone: 'div-1', values: sp.stats.map((s) => s.count) }]}
            fmt={(v) => String(Math.round(v))} aria="Customers per sub-pattern"
            catLabel={(id) => short(sp.stats.find((s) => s.id === id)?.label ?? id, Math.max(8, Math.floor(110 / sp.stats.length)))}
            catTitle={(id) => sp.stats.find((s) => s.id === id)?.label ?? id}
            tipRows={(i) => { const s = sp.stats[i]; return [['Customers', String(s.count)], ['Lifetime $', usdc(s.dollars)], ...(s.description ? [['About', short(s.description, 100)] as [string, string]] : []), ...(drillSubpattern === s.id ? [['Filter', 'applied · select again to clear'] as [string, string]] : [])]; }}
            onSegment={(i) => { const id = sp.stats[i].id; setDrillSubpattern(drillSubpattern === id ? null : id); setShowAllDrill(false); }} />
          {drillSubpattern && (
            <div className="am-row am-row--wrap">
              <span className="am-tag am-tag--info">Filtered: {subLabel}</span>
              <button className="am-btn am-btn--text" onClick={() => setDrillSubpattern(null)}>Clear filter</button>
            </div>
          )}
        </>}

        <div className="am-row am-row--spread">
          <span className="am-chart__title">Customers</span>
          <button className="am-btn am-btn--text" onClick={() => exportCustomers(filenameBase, rows)}><Icon name="download" />Export CSV</button>
        </div>
        {customerTable(rows, showAllDrill, setShowAllDrill, `${drillCluster.reason} customers`, false)}
        </div></div>
      </SideSheet>
    );
  })();

  const allSheet = sheet === 'all' && (() => {
    const list = [...churnedAll].sort((a, b) => (b.lifetime_subscription || 0) - (a.lifetime_subscription || 0));
    return (
      <SideSheet open onClose={() => setSheet(null)} title={`Every churned customer · ${list.length}`}
        text={`${usdc(totalChurnDollars)} lifetime subscription $. Customers with combined reasons count once here and once in each reason cluster, which is why the cluster counts add up to more.`}>
        <div className="am-sidesheet__body"><div style={SHEET_STACK}>
        <div className="am-row am-row--spread">
          <span className="am-chart__title">Customers</span>
          <button className="am-btn am-btn--text" onClick={() => exportCustomers('churn_patterns_all_churned', list)}><Icon name="download" />Export CSV</button>
        </div>
        {customerTable(list, showAllChurned, setShowAllChurned, 'All churned customers', true)}
        </div></div>
      </SideSheet>
    );
  })();

  const captureSheet = sheet === 'capture' && (
    <SideSheet open onClose={() => setSheet(null)} title="Churn Playbook capture rate by year"
      text="Year of the customer's last payment. Recorded in HubSpot = a CSM filled in the Churn Playbook reason. With all sources also counts your classifications, deep research and usable AI inferences.">
      <DataTable label="Capture rate by year" cols={[['Year', false], ['Churned', true], ['Recorded in HubSpot', true], ['HubSpot rate', true], ['With all sources', true], ['All-sources rate', true]]}
        rows={[...captureByYear].reverse().map((y) => [y.year + (y.year === thisYear ? ' (in progress)' : ''), String(y.total), String(y.captured), `${y.pct.toFixed(0)}%`, String(y.capturedWithAi), `${y.pctWithAi.toFixed(0)}%`])}
        sortValues={[...captureByYear].reverse().map((y) => [y.year, y.total, y.captured, y.pct, y.capturedWithAi, y.pctWithAi])}
        foot={(() => {
          const t = captureByYear.reduce((a, y) => ({ total: a.total + y.total, c: a.c + y.captured, w: a.w + y.capturedWithAi }), { total: 0, c: 0, w: 0 });
          return [`Total · ${captureByYear.length} years`, String(t.total), String(t.c), t.total ? `${((t.c / t.total) * 100).toFixed(0)}%` : '—', String(t.w), t.total ? `${((t.w / t.total) * 100).toFixed(0)}%` : '—'];
        })()} />
    </SideSheet>
  );

  // ---- capture-rate status: word + tone (classic thresholds: 70 / 50)
  const capTone = latestCapture ? (latestCapture.pct >= 70 ? 'success' : latestCapture.pct >= 50 ? 'warning' : 'error') as 'success' | 'warning' | 'error' : undefined;
  const capWord = latestCapture ? (latestCapture.pct >= 70 ? 'On target' : latestCapture.pct >= 50 ? 'Watch' : 'Below target') : undefined;

  // ---- reason chart: one stacked series per tier so the colour names the tier
  const tiersPresent = TIERS.filter((t) => clusters.some((c) => c.tier === t.k));
  const reasonSeries = tiersPresent.map((t) => ({ key: t.k, label: t.label, tone: t.tone, values: clusters.map((c) => (c.tier === t.k ? c.count : 0)) }));
  const catChars = Math.max(6, Math.floor(130 / Math.max(1, clusters.length)));

  const tableCols: Array<[string, boolean]> = [['Reason', false], ['Preventability', false], ['$ at stake', true], ['Customers', true], ['Avg tenure · peak MRR', true], ['Most-hit segment', false], ['Recommended initiative', false]];
  const exportClusters = () => downloadCsv(`churn_patterns_${includeInferred ? 'all_sources' : 'hubspot_only'}`,
    ['Reason', 'Preventability', 'Category', '$ at stake', '% of churn $', 'Customers', 'Not from HubSpot', 'Avg tenure (y)', 'Avg peak MRR', 'Top segment', 'Top segment count', 'Top sub-segment', 'Top sub-segment count', 'Recommended initiative'],
    clusters.map((c) => [c.reason, tierOf(c.tier).label, c.category, Math.round(c.dollars), (c.pctOfDollars * 100).toFixed(1), c.count, c.inferredCount,
      c.avgTenure != null ? c.avgTenure.toFixed(1) : '', c.avgPeakMrr != null ? Math.round(c.avgPeakMrr) : '',
      c.topSegment ? segmentLabel(c.topSegment) : '', c.topSegmentCount, c.topSubSegment ?? '', c.topSubSegmentCount, c.initiative]));

  const layered = `Layered: ${Object.keys(userClassifications).length} user-classified · ${Object.keys(research?.classifications_by_customer_id ?? {}).length} deep-researched · ${(inferenceMap?.size ?? 0).toLocaleString()} legacy AI-inferred.`;

  return (
    <DsPage
      path="/churn-patterns"
      title="Churn Patterns"
      subtitle="Every churned customer grouped by HubSpot Churn Playbook reason, dollar-weighted, with an initiative mapped to each cluster."
      actions={<button className="am-btn am-btn--outlined" onClick={exportClusters} disabled={!clusters.length}><Icon name="download" />Export CSV</button>}
      overlays={<>{drillSheet}{allSheet}{captureSheet}</>}
    >
      {error ? <p className="am-card__text">Could not load customer_profiles: {String(error)}</p> : null}

      {noReasonCluster && noReasonCluster.pctOfDollars > 0.20 && (
        <section className="am-card am-card--outlined">
          <div className="am-row am-row--wrap">
            <span className="am-tag am-tag--warning">Fix first</span>
            <span className="am-chart__title">{(noReasonCluster.pctOfDollars * 100).toFixed(0)}% of churned dollars ({usdc(noReasonCluster.dollars)}) have no recorded reason.</span>
          </div>
          <p className="am-card__text">
            The Churn Playbook capture rate dropped from {peakCapture?.pct.toFixed(0) ?? '—'}% in {peakCapture?.year ?? '—'} to {latestCapture?.pct.toFixed(0) ?? '—'}% in {latestCapture?.year ?? '—'}. Every other initiative on this page is sized off the {(100 - noReasonCluster.pctOfDollars * 100).toFixed(0)}% we do measure — fixing capture is the #1 unlock.
          </p>
          <div className="am-row"><button className="am-btn am-btn--text" onClick={() => openReason(NO_REASON)}>See the {noReasonCluster.count} customers with no reason</button></div>
        </section>
      )}

      <div className="am-row am-row--wrap">
        <span className="am-card__text">Reason source</span>
        <Segmented label="Reason source" value={includeInferred ? 'with-ai' : 'hubspot-only'} onChange={(v) => setIncludeInferred(v === 'with-ai')}
          options={[['hubspot-only', 'HubSpot only'], ['with-ai', '+ user / research / AI']]} />
        <span className="am-tooltip">
          <span className="am-card__text">{includeInferred ? layered : 'Showing only the reasons HubSpot CSMs recorded in the Churn Playbook.'}</span>
          <span className="am-tooltip__tip am-tooltip__tip--rich" style={{ maxWidth: 420 }}>
            <b>HubSpot only</b> uses only the Churn Playbook reason a CSM recorded; anything else falls into "(no reason recorded)".
            <span style={{ display: 'block' }}><b>+ user / research / AI</b> overlays, in priority order: your Churn Investigator classifications, deep-research classifications (mapped to the 13 playbook reasons), then legacy AI inferences. Low-confidence "Unresponsive" AI guesses are left out.</span>
          </span>
        </span>
      </div>

      {!isLoading && profiles && (
        <KpiGrid>
          <KpiCard label="Total churned $" value={usdc(totalChurnDollars)} hint={`Across ${churnedAll.length} accounts`} onOpen={() => { setShowAllChurned(false); setSheet('all'); }} />
          {noReasonCluster
            ? <KpiCard label="Unmeasured churn" value={`${(noReasonCluster.pctOfDollars * 100).toFixed(0)}%`} hint={`${noReasonCluster.count} customers · ${usdc(noReasonCluster.dollars)} unattributed`}
                tag="Needs a reason" tagTone="warning" onOpen={() => openReason(NO_REASON)} />
            : <KpiCard label="Unmeasured churn" value="0%" hint="Every churned customer has a reason" tag="Complete" tagTone="success" />}
          {biggestRealCluster
            ? <KpiCard label="Biggest known cluster" value={biggestRealCluster.reason} hint={`${usdc(biggestRealCluster.dollars)} · ${biggestRealCluster.count} customers · ${(biggestRealCluster.pctOfDollars * 100).toFixed(1)}% of churn $`}
                tag={tierOf(biggestRealCluster.tier).label} tagTone={tierOf(biggestRealCluster.tier).tag} onOpen={() => openReason(biggestRealCluster.reason)} />
            : <KpiCard label="Biggest known cluster" value="—" />}
          <KpiCard label={`Capture rate · ${latestCapture?.year ?? '—'}${latestCapture?.year === thisYear ? ' (in progress)' : ''}`} value={latestCapture ? `${latestCapture.pct.toFixed(0)}%` : '—'}
            hint={`Peak: ${peakCapture?.pct.toFixed(0) ?? '—'}% in ${peakCapture?.year ?? '—'}. Target: 100% — required for diligence.`}
            tag={capWord} tagTone={capTone} onOpen={() => setSheet('capture')} />
        </KpiGrid>
      )}
      {isLoading && <p className="am-card__text">Loading churned customers…</p>}

      {clusters.length > 0 && (
        <ChartCard title="Churn patterns · customer count by reason" caption="Sorted by churn $ at stake · colour is the preventability tier · select a column to open that reason's customers">
          <ColumnChart months={clusters.map((c) => c.reason)} series={reasonSeries} stacked legend
            fmt={(v) => String(Math.round(v))} aria="Churned customers by reason"
            catLabel={(r) => short(r, catChars)} catTitle={(r) => r}
            labelFor={(i) => String(clusters[i].count)}
            tipRows={(i) => { const c = clusters[i]; return [['Customers', String(c.count)], ['$ at stake', usdc(c.dollars)], ['% of churn $', `${(c.pctOfDollars * 100).toFixed(1)}%`], ['Tier', tierOf(c.tier).label], ...(c.inferredCount > 0 ? [['Not from HubSpot', String(c.inferredCount)] as [string, string]] : [])]; }}
            onSegment={(i) => openReason(clusters[i].reason)} />
        </ChartCard>
      )}

      {clusters.length > 0 && (
        <section className="am-card am-card--outlined">
          <div className="am-chart__head">
            <span className="am-chart__title">Patterns</span>
            <span className="am-chart__caption">Sorted by churn $ at stake · combined reasons split their dollars equally · select a reason to see its customers, segments and sub-patterns</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <DataTable label="Churn patterns by reason" cols={tableCols}
              rows={clusters.map((c) => [
                c.reason,
                <div className="am-row am-row--wrap am-row--tight">
                  <TierTag t={c.tier} />
                  {c.inferredCount > 0 && <span className="am-tooltip"><span className="am-tag am-tag--neutral">{c.inferredCount} not from HubSpot</span><span className="am-tooltip__tip">{`${c.inferredCount} of ${c.count} customers in this cluster got their reason from your classification, research or AI (HubSpot didn't record one).`}</span></span>}
                </div>,
                <span>{usdc(c.dollars)}<span className="am-card__text" style={{ display: 'block' }}>{`${(c.pctOfDollars * 100).toFixed(1)}% of churn $`}</span></span>,
                String(c.count),
                `${c.avgTenure != null ? `${c.avgTenure.toFixed(1)}y` : '—'} · ${c.avgPeakMrr != null ? usd(c.avgPeakMrr) : '—'}`,
                <span style={{ display: 'block' }}>
                  {c.topSegment && c.topSegment !== '(unsegmented)' ? `${segmentLabel(c.topSegment)} ${c.topSegmentCount}/${c.count}` : '—'}
                  {c.topSubSegment && <span className="am-card__text" style={{ display: 'block' }}>{`${c.topSubSegment} ${c.topSubSegmentCount}/${c.count}`}</span>}
                  <span className="am-card__text" style={{ display: 'block' }}>{c.category}</span>
                </span>,
                <span style={{ display: 'block', minWidth: 190 }}>{c.initiative}</span>,
              ])}
              sortValues={clusters.map((c) => [c.reason, TIERS.findIndex((t) => t.k === c.tier), c.dollars, c.count, c.avgTenure, c.topSegment ? segmentLabel(c.topSegment) : '', c.category])}
              clickable={(col) => col === 0 || col === 2 || col === 3}
              onCell={(row) => openReason(clusters[row].reason)}
              foot={[`Total · ${clusters.length} reasons`, '', `${usdc(totalChurnDollars)} · 100%`, `${churnedAll.length} accounts`, '', '', '']}
              footClickable={(col) => col === 2 || col === 3}
              onFoot={() => { setShowAllChurned(false); setSheet('all'); }} />
          </div>
        </section>
      )}

      {captureByYear.length > 0 && (
        <ChartCard title="Churn Playbook capture rate by year" caption="Share of churned customers with a reason, by year of last payment · select a year for the counts">
          <ColumnChart months={captureByYear.map((y) => y.year)} grouped legend
            series={[
              { key: 'hubspot', label: 'Recorded in HubSpot', tone: 'div-1', values: captureByYear.map((y) => y.pct) },
              { key: 'all', label: 'With your / research / AI reasons', tone: 'div-2', values: captureByYear.map((y) => y.pctWithAi) },
            ]}
            fmt={(v) => `${Math.round(v)}%`} aria="Churn Playbook capture rate by year"
            catLabel={(y) => (y === thisYear ? `${y}*` : y)} catTitle={(y) => (y === thisYear ? `${y} (in progress)` : y)}
            labelFor={(i) => `${captureByYear[i].pct.toFixed(0)}% · ${captureByYear[i].pctWithAi.toFixed(0)}%`}
            tipRows={(i) => { const y = captureByYear[i]; return [['Churned', String(y.total)], ['Recorded in HubSpot', `${y.captured} · ${y.pct.toFixed(0)}%`], ['With all sources', `${y.capturedWithAi} · ${y.pctWithAi.toFixed(0)}%`]]; }}
            onSegment={() => setSheet('capture')} />
          {captureByYear.some((y) => y.year === thisYear) && <p className="am-card__text">* {thisYear} is in progress.</p>}
        </ChartCard>
      )}
    </DsPage>
  );
}
