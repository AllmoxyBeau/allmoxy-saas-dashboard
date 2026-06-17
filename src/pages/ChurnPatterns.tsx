import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, BarChart, Bar, Cell } from 'recharts';

import PageHeader from '../components/common/PageHeader';
import DrillDownPanel, { DrillColumn } from '../components/common/DrillDownPanel';
import InfoIcon from '../components/common/InfoIcon';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';
import { segmentColor, segmentLabel } from '../lib/segmentsRegistry';

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

// Canonical 13 Allmoxy Churn Playbook reasons. The user-classification UI
// (Churn Investigator) emits only these values; the deep-research agent's
// proposed_churn_reason is mapped onto these via mapProposedToCanonical.
const CANONICAL_CHURN_REASONS = [
  'Failed Implementation',
  'Features',
  'Pricing',
  'Business Model Change',
  'Moved to Other Solution',
  'Paid and Never Used',
  'Out of Business',
  'Customer Stakeholder Misalignment',
  'Ownership Transition',
  'Timing Not Right',
  'Payment Failure',
  'Catalog Unidentified',
  'Unresponsive',
] as const;

// User-classification store written by the Churn Investigator. Same key as
// ChurnInvestigator.tsx — `allmoxy:churn-classifications:v1`. Each entry is a
// per-customer record with reasons[] + notes + timestamp + classifier name.
type UserClassification = {
  reasons: string[];
  notes: string;
  classified_at: string;
  classified_by: string;
};

// Deep-research classification (public/snapshots/churn_research_classifications.json).
// Keyed by allmoxy_customer_id. Lives in churn_research_batches/ batch files in
// the repo; consolidated by _etl_scripts/consolidate_churn_research.mjs.
type ResearchClassification = {
  allmoxy_customer_id: number;
  proposed_churn_reason: string;
  confidence: 'high' | 'medium' | 'low';
  evidence_quotes?: Array<{ date: string | null; quote: string; interpretation: string }>;
  recommended_action?: string;
  source_batch?: string;
};
type ResearchSnap = {
  classifications_by_customer_id: Record<string, ResearchClassification>;
};

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

// Shape of each entry in public/snapshots/churn_inferences.json.
// We treat the inference as a fallback when HubSpot has no recorded reason.
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

// Sub-pattern overlay (public/snapshots/churn_subpatterns.json). Built by
// _etl_scripts/build_churn_subpatterns.mjs — tags each customer with one or more sub-pattern
// IDs within their parent reason cluster (e.g. "Failed Implementation" → "fi_bandwidth_stalled").
type SubpatternDef = { label: string; parent: string; description: string };
type SubpatternsSnap = {
  subpattern_definitions: Record<string, SubpatternDef>;
  // aid (as string key in JSON) → array of subpattern ids
  customer_subpatterns: Record<string, string[]>;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

const NO_REASON = '(no reason recorded)';

// Initiative + preventability map per HubSpot Churn Playbook category.
// Edit here to update the cluster narrative.
type InitiativeTier = 'process' | 'preventable-high' | 'preventable-low' | 'mixed' | 'accept';
const INITIATIVES: Record<string, { initiative: string; tier: InitiativeTier; category: string }> = {
  [NO_REASON]: {
    initiative:
      "Mandatory Churn Playbook completion before HubSpot cancellation. Until this lands, the rest of this page understates every cluster except this one. Assign to CSM lead — process compliance.",
    tier: 'process',
    category: 'Process / Compliance',
  },
  'Failed Implementation': {
    initiative:
      "Onboarding overhaul: productized AI Activation Package, 90-day go-live gate, milestone-paid services. These are high-MRR accounts we lose before they even start paying value.",
    tier: 'preventable-high',
    category: 'Onboarding',
  },
  'Features': {
    initiative:
      "Feature-renewal linkage: surface most-cited gaps at QBR, fast-track top 3 to next quarter, ship beta-customer commitments at renewal. These are top-quartile accounts ($2K+ MRR) leaving over product gaps.",
    tier: 'preventable-high',
    category: 'Product / Roadmap',
  },
  'Business Model Change': {
    initiative:
      "Accept — non-preventable. Build early-signal detector (industry pivot mentioned in CSM notes) so we stop investing CSM hours into doomed accounts. Goal: faster acceptance, not retention.",
    tier: 'accept',
    category: 'Accept / Segment',
  },
  'Moved to Other Solution': {
    initiative:
      "Competitor playbook + structured exit interviews. Track which competitor wins (Microvellum / Cabinet Vision / Closet Pro etc) and feed into competitive moat (data lock-in, integrations).",
    tier: 'mixed',
    category: 'Competitive',
  },
  'Paid and Never Used': {
    initiative:
      "Onboarding gate — block recurring billing past 90 days if first-order milestone not reached. Refund-or-extend the few outliers. This is the cleanest immediate win.",
    tier: 'preventable-high',
    category: 'Onboarding',
  },
  'Out of Business': {
    initiative:
      "Non-preventable. Track for segment-health analysis (cluster of OOB churns in one segment → industry headwind worth knowing).",
    tier: 'accept',
    category: 'Accept / Segment',
  },
  'Customer Stakeholder Misalignment': {
    initiative:
      "Executive-sponsor program — every account ≥ $1K MRR multi-threaded (2+ stakeholders in HubSpot). Single point of contact = single point of churn.",
    tier: 'preventable-low',
    category: 'Customer Success',
  },
  'Unresponsive': {
    initiative:
      "Health-score early warning. Auto-flag accounts with no logins / no responses at month 6. Reach-out cadence escalates if no engagement by month 9.",
    tier: 'preventable-low',
    category: 'Customer Success',
  },
  'Catalog Unidentified': {
    initiative:
      "Implementation diagnostic — flag any account with no completed catalog within 60 days of signup. Services team intervenes or refund.",
    tier: 'preventable-high',
    category: 'Onboarding',
  },
  'Ownership Transition': {
    initiative:
      "M&A radar — track HubSpot company properties for ownership changes; CSM proactively re-engages new owner within 30 days. Small cluster but high-LTV when it works.",
    tier: 'preventable-low',
    category: 'Customer Success',
  },
  'Timing Not Right': {
    initiative:
      "Sales qualification — earlier 'not now' filtering pre-onboarding. These customers shouldn't have signed.",
    tier: 'mixed',
    category: 'Sales / Qualification',
  },
  'Pricing': {
    initiative:
      "Renewal-time pricing recalibration for long-tenure / under-priced accounts. Only 2 cases recorded — likely under-counted, will grow once 'no reason' bucket gets categorized.",
    tier: 'preventable-low',
    category: 'Pricing',
  },
  // Added to support reasons emitted by churn_inferences.json that don't appear in the original
  // HubSpot Churn Playbook taxonomy. Keep tiers/categories aligned to the original framework.
  'Payment Failure': {
    initiative:
      "Dunning-recovery review. Most 'Payment Failure' churns hide an underlying reason (financial distress, unresponsiveness, intentional cancel). Treat as a flag, not a root cause — every Payment Failure account should get a follow-up call to classify properly.",
    tier: 'preventable-low',
    category: 'Customer Success',
  },
  '(needs review)': {
    initiative:
      "Manual review required — Claude could not infer a confident reason from CSM notes. Most are pre-CSM-playbook era (last paid 2019-2021) or accounts with zero captured engagement. Defer until CSM compliance restoration is complete.",
    tier: 'process',
    category: 'Process / Compliance',
  },
  '(not churned — likely annual payer)': {
    initiative:
      "False positive — these customers pay annually upfront so the underlying data marks them Cancelled despite being active. Add their allmoxy_customer_id to src/data/annual_payers.json to fix the snapshot.",
    tier: 'process',
    category: 'Data Quality',
  },
  '(not churned — annual payer)': {
    initiative:
      "False positive — these customers pay annually upfront so the underlying data marks them Cancelled despite being active. Add their allmoxy_customer_id to src/data/annual_payers.json to fix the snapshot.",
    tier: 'process',
    category: 'Data Quality',
  },
  '(not churned — duplicate / name change)': {
    initiative:
      "False positive — surfaced by the former CS rep's notes (Churn Details.xlsx). These accounts are still active under a different name or as a different aid. Merge / dedupe in customer_profiles upstream before treating as real churn.",
    tier: 'process',
    category: 'Data Quality',
  },
};

function tierColor(t: InitiativeTier): string {
  switch (t) {
    case 'preventable-high': return 'error.main';
    case 'preventable-low':  return 'warning.main';
    case 'mixed':            return 'warning.main';
    case 'accept':           return 'success.main';
    case 'process':          return 'info.main';
  }
}
function tierLabel(t: InitiativeTier): string {
  switch (t) {
    case 'preventable-high': return 'Preventable · high impact';
    case 'preventable-low':  return 'Preventable · low impact';
    case 'mixed':            return 'Mixed';
    case 'accept':           return 'Accept · non-preventable';
    case 'process':          return 'Process fix';
  }
}

type Cluster = {
  reason: string;
  count: number;
  dollars: number;
  pctOfDollars: number;
  avgTenure: number | null;
  avgPeakMrr: number | null;
  topSegment: string | null;
  topSegmentCount: number;
  topSubSegment: string | null;
  topSubSegmentCount: number;
  segmentBreakdown: Array<{ name: string; count: number; dollars: number }>;
  subSegmentBreakdown: Array<{ name: string; count: number; dollars: number }>;
  customers: ProfileRow[];
  inferredCount: number;  // how many of `customers` got their reason from churn_inferences vs HubSpot
  initiative: string;
  tier: InitiativeTier;
  category: string;
};

type ReasonSource = 'hubspot' | 'user' | 'research-high' | 'research-medium' | 'research-low' | 'ai-high' | 'ai-medium' | 'ai-low' | 'none';

export default function ChurnPatterns() {
  const { data, isLoading, error } = useSheetTab('customer_profiles');
  const profiles = data as unknown as { rows: ProfileRow[] } | undefined;
  // churn_inferences is the Claude-MCP-generated suggested-reason layer. We treat it as a fallback
  // when HubSpot has no churn_reason recorded. Loaded in parallel with customer_profiles.
  const { data: inferencesData } = useSheetTab('churn_inferences');
  const inferences = inferencesData as unknown as InferencesSnap | undefined;
  // churn_subpatterns gives finer-grained tags within each parent reason cluster (e.g. WHY
  // implementations failed). Used in the drill-down for filter chips. Optional — page works
  // without it; chips just don't appear.
  const { data: subpatternsData } = useSheetTab('churn_subpatterns');
  const subpatterns = subpatternsData as unknown as SubpatternsSnap | undefined;

  // Deep-research classifications from the agent (127 customers across 13 batch files).
  // Higher quality than the AI inferences — used as a fallback BEFORE the inferences.
  const { data: researchData } = useSheetTab('churn_research_classifications');
  const research = researchData as unknown as ResearchSnap | undefined;

  // Per-customer user classifications written by the Churn Investigator (localStorage).
  // These OVERRIDE everything else when present — the user is the source of truth.
  // We listen to a window 'storage' event to pick up changes from the Investigator tab.
  const [userClassifications, setUserClassifications] = useState<Record<string, UserClassification>>(() => {
    try { return JSON.parse(localStorage.getItem('allmoxy:churn-classifications:v1') || '{}'); }
    catch { return {}; }
  });
  useEffect(() => {
    function reload() {
      try { setUserClassifications(JSON.parse(localStorage.getItem('allmoxy:churn-classifications:v1') || '{}')); }
      catch {}
    }
    window.addEventListener('storage', reload);
    // Also poll once a second when this tab is visible — the storage event only fires
    // for CROSS-tab changes; same-tab edits in the Investigator wouldn't fire it.
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') reload(); }, 1500);
    return () => { window.removeEventListener('storage', reload); window.clearInterval(interval); };
  }, []);

  const [drillReason, setDrillReason] = useState<string | null>(null);
  // Selected sub-pattern filter inside the drill panel. Null = show all rows.
  const [drillSubpattern, setDrillSubpattern] = useState<string | null>(null);
  // Default ON because the inferences cover ~38% of total churned $ that was previously unattributed.
  // Toggle OFF to see the HubSpot-only view (the original behavior).
  const [includeInferred, setIncludeInferred] = useState(true);

  const { churnedAll, totalChurnDollars, captureByYear, clusters, inferenceMap } = useMemo(() => {
    if (!profiles) return {
      churnedAll: [] as ProfileRow[],
      totalChurnDollars: 0,
      captureByYear: [] as Array<{ year: string; pct: number; total: number; captured: number; pctWithAi: number; capturedWithAi: number }>,
      clusters: [] as Cluster[],
      inferenceMap: new Map<number, Inference>(),
    };

    // Build aid → inference lookup for fast fallback resolution.
    const infMap = new Map<number, Inference>();
    for (const inf of inferences?.customers ?? []) infMap.set(inf.allmoxy_customer_id, inf);

    // Filter to actual churns. Rules:
    // 1. status === 'churned' — the canonical lifecycle flag (post-amortization,
    //    post-status-overrides). This is what the rest of the dashboard uses;
    //    using a different definition here would create headline-number drift.
    // 2. NOT excluded_from_logo_count — drops dedupes, sub-instances, test
    //    artifacts, affiliate-not-customer, false-positive-needs-review, and
    //    never_paid records (lifetime ≤ $0). These all carry the flag set by
    //    apply_customer_status_overrides / apply_never_paid_classification.
    // 3. NOT flagged by old inference as false_positive_annual_payer (legacy
    //    backstop; annual_payer false positives should already be handled by
    //    rule 1 + amortization, but keeping this for safety).
    const churned = profiles.rows.filter((r) => {
      if (r.excluded_from_logo_count) return false;
      if (r.status !== 'churned') return false;
      const inf = infMap.get(r.allmoxy_customer_id);
      if (inf?.current_status === 'false_positive_annual_payer') return false;
      return true;
    });

    // Resolve each customer's effective reason string + source.
    // Priority cascade (highest authority first):
    //   1. HubSpot recorded churn_reason — authoritative
    //   2. User classification (Churn Investigator localStorage) — owner's call
    //   3. Deep-research classification (agent batch files) — high-quality CSM
    //      evidence research, mapped to the canonical 13
    //   4. AI inference (legacy churn_inferences.json)
    //   5. NO_REASON
    // Steps 2-4 are gated on the "+ AI inferences" toggle (the page semantic is
    // "show HubSpot only" vs "include everything else"). User classifications
    // get included on the toggle as well, because they are explicit overrides.
    const resolveReason = (c: ProfileRow): { reason: string; source: ReasonSource } => {
      // 1. HubSpot is authoritative
      if (c.churn_reason && c.churn_reason.trim()) return { reason: c.churn_reason, source: 'hubspot' };
      if (!includeInferred) return { reason: NO_REASON, source: 'none' };

      // 2. User classification (Churn Investigator localStorage)
      const userClass = userClassifications[String(c.allmoxy_customer_id)];
      if (userClass?.reasons && userClass.reasons.length > 0) {
        return { reason: userClass.reasons.join('; '), source: 'user' };
      }

      // 3. Deep-research classification (agent work)
      const rc = research?.classifications_by_customer_id?.[String(c.allmoxy_customer_id)];
      if (rc) {
        const canonical = mapProposedToCanonical(rc.proposed_churn_reason);
        if (canonical) {
          const src: ReasonSource =
            rc.confidence === 'high' ? 'research-high' :
            rc.confidence === 'medium' ? 'research-medium' : 'research-low';
          return { reason: canonical, source: src };
        }
      }

      // 4. AI inference (legacy)
      const inf = infMap.get(c.allmoxy_customer_id);
      if (!inf) return { reason: NO_REASON, source: 'none' };
      // Skip low-confidence default-Unresponsive for customers with $0 lifetime / pre-CSM-era — these
      // would just dilute the real signal. Threshold: only carry inferred reasons for medium/high
      // confidence, OR low-confidence non-Unresponsive (those are real CSM evidence, just thin).
      if (inf.confidence === 'low' && inf.suggested_reason === 'Unresponsive') {
        return { reason: NO_REASON, source: 'none' };
      }
      // Placeholder reasons (any parenthesized "we couldn't find evidence" marker)
      // aren't real cluster values — they come from extend_churn_inferences.mjs
      // placeholder entries. Map to NO_REASON so they don't pollute the clusters.
      if (typeof inf.suggested_reason === 'string' && /^\(.*\)$/.test(inf.suggested_reason.trim())) {
        return { reason: NO_REASON, source: 'none' };
      }
      const src: ReasonSource = inf.confidence === 'high' ? 'ai-high' : inf.confidence === 'medium' ? 'ai-medium' : 'ai-low';
      return { reason: inf.suggested_reason, source: src };
    };

    // Capture-rate by year of last payment. Track HubSpot-only AND HubSpot+AI separately so the
    // chart can show both lines — the gap is the value the AI inferences + research + user
    // classifications collectively add.
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
    const captureByYear = Object.entries(byYear)
      .filter(([y]) => /^\d{4}$/.test(y))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([year, d]) => ({
        year,
        pct: d.total > 0 ? (d.captured / d.total) * 100 : 0,
        pctWithAi: d.total > 0 ? (d.capturedWithAi / d.total) * 100 : 0,
        total: d.total,
        captured: d.captured,
        capturedWithAi: d.capturedWithAi,
      }));
    // Cluster by reason. Split combo reasons (semicolon-separated) and weight $ equally.
    const totalDollars = churned.reduce((s, c) => s + (c.lifetime_subscription || 0), 0);
    type SegBuckets = Record<string, { count: number; dollars: number }>;
    const byReason: Record<string, { count: number; dollars: number; tenureSum: number; tenureN: number; peakSum: number; peakN: number; segments: SegBuckets; subSegments: SegBuckets; customers: ProfileRow[]; inferredCount: number }> = {};
    for (const c of churned) {
      const { reason: rawReason, source } = resolveReason(c);
      const reasons = rawReason.split(';').map((s) => s.trim()).filter(Boolean);
      const weight = (c.lifetime_subscription || 0) / reasons.length;
      // "Inferred" = anything non-HubSpot. Used by the cluster to show what
      // share of its $ comes from the inference layer vs authoritative HubSpot.
      const isInferred = source !== 'hubspot' && source !== 'none';
      for (const r of reasons) {
        if (!byReason[r]) byReason[r] = { count: 0, dollars: 0, tenureSum: 0, tenureN: 0, peakSum: 0, peakN: 0, segments: {}, subSegments: {}, customers: [], inferredCount: 0 };
        byReason[r].count++;
        byReason[r].dollars += weight;
        byReason[r].customers.push(c);
        if (isInferred) byReason[r].inferredCount++;
        if (c.years_with_us != null) { byReason[r].tenureSum += c.years_with_us; byReason[r].tenureN++; }
        if (c.peak_month_total != null) { byReason[r].peakSum += c.peak_month_total; byReason[r].peakN++; }
        const seg = c.primary_segment || '(unsegmented)';
        if (!byReason[r].segments[seg]) byReason[r].segments[seg] = { count: 0, dollars: 0 };
        byReason[r].segments[seg].count++;
        byReason[r].segments[seg].dollars += weight;
        const sub = c.sub_segment || '(unspecified)';
        if (!byReason[r].subSegments[sub]) byReason[r].subSegments[sub] = { count: 0, dollars: 0 };
        byReason[r].subSegments[sub].count++;
        byReason[r].subSegments[sub].dollars += weight;
      }
    }

    const clusters: Cluster[] = Object.entries(byReason).map(([reason, d]) => {
      const init = INITIATIVES[reason] ?? { initiative: 'No mapped initiative for this category — review playbook config.', tier: 'mixed' as InitiativeTier, category: 'Other' };
      const segmentBreakdown = Object.entries(d.segments)
        .map(([name, v]) => ({ name, count: v.count, dollars: v.dollars }))
        .sort((a, b) => b.count - a.count);
      const subSegmentBreakdown = Object.entries(d.subSegments)
        .map(([name, v]) => ({ name, count: v.count, dollars: v.dollars }))
        .sort((a, b) => b.count - a.count);
      const namedSub = subSegmentBreakdown.find((s) => s.name !== '(unspecified)') ?? null;
      return {
        reason,
        count: d.count,
        dollars: d.dollars,
        pctOfDollars: totalDollars > 0 ? d.dollars / totalDollars : 0,
        avgTenure: d.tenureN > 0 ? d.tenureSum / d.tenureN : null,
        avgPeakMrr: d.peakN > 0 ? d.peakSum / d.peakN : null,
        topSegment: segmentBreakdown[0]?.name ?? null,
        topSegmentCount: segmentBreakdown[0]?.count ?? 0,
        topSubSegment: namedSub?.name ?? null,
        topSubSegmentCount: namedSub?.count ?? 0,
        segmentBreakdown,
        subSegmentBreakdown,
        customers: d.customers,
        inferredCount: d.inferredCount,
        initiative: init.initiative,
        tier: init.tier,
        category: init.category,
      };
    }).sort((a, b) => b.dollars - a.dollars);

    return { churnedAll: churned, totalChurnDollars: totalDollars, captureByYear, clusters, inferenceMap: infMap };
  }, [profiles, inferences, includeInferred, research, userClassifications]);

  const noReasonCluster = clusters.find((c) => c.reason === NO_REASON);
  const biggestRealCluster = clusters.find((c) => c.reason !== NO_REASON);
  const latestCapture = captureByYear[captureByYear.length - 1];
  const peakCapture = captureByYear.reduce<typeof latestCapture | null>((acc, r) => (acc == null || r.pct > acc.pct ? r : acc), null);

  const drillCluster = drillReason ? clusters.find((c) => c.reason === drillReason) : null;

  // Compute the sub-pattern breakdown for the currently-drilled cluster. We re-aggregate here
  // (rather than inside the main useMemo) because it depends on drillCluster and we don't want
  // to recompute for every cluster on every render. Each sub-pattern shows the count of cluster
  // customers tagged with it and the $ at stake among those tagged customers.
  const drillSubpatternStats = useMemo(() => {
    if (!drillCluster || !subpatterns) return null;
    const defs = subpatterns.subpattern_definitions || {};
    const tagsByAid = subpatterns.customer_subpatterns || {};
    // Which sub-pattern ids belong to this parent reason?
    const validIds = Object.entries(defs)
      .filter(([, def]) => drillCluster.reason.split(';').some((r) => r.trim() === def.parent))
      .map(([id]) => id);
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
      stats: [...stats.entries()]
        .map(([id, s]) => ({ id, label: defs[id]?.label ?? id, description: defs[id]?.description ?? '', ...s }))
        .sort((a, b) => b.count - a.count),
      taggedCount: anyTaggedCount,
      untaggedCount: drillCluster.customers.length - anyTaggedCount,
    };
  }, [drillCluster, subpatterns]);

  return (
    <Box>
      <PageHeader
        title="Churn Patterns"
        subtitle="Every churned customer grouped by HubSpot Churn Playbook reason, dollar-weighted, with an initiative mapped to each cluster."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load customer_profiles: {String(error)}</Alert>}

      {/* Reason-source toggle. AI-inferred reasons come from public/snapshots/churn_inferences.json
          (generated by build_churn_corpus + Claude HubSpot MCP analysis). Default ON because the
          inferences typically lift capture rate from ~50% to ~80%. */}
      <Paper sx={{ p: 2, mb: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid #2C73FF' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ xs: 'flex-start', md: 'center' }} justifyContent="space-between">
          <Box>
            <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              Reason source
              <InfoIcon info={<>
                <strong>HubSpot only:</strong> uses ONLY the Churn Playbook reason a CSM recorded in HubSpot. Anything without a recorded reason falls into "(no reason recorded)".<br /><br />
                <strong>+ AI inferences:</strong> overlays four sources, in priority order:<br />
                1. <strong>Your classifications</strong> from the Churn Investigator (localStorage, owner's final answer).<br />
                2. <strong>Deep-research classifications</strong> from <code>churn_research_classifications.json</code> — 127 customers researched by an agent pulling HubSpot company + notes + deals + tickets, mapped to the canonical 13 reasons.<br />
                3. <strong>Legacy AI inferences</strong> from <code>churn_inferences.json</code> — original Claude-generated suggestions for customers research/user haven't reached yet.<br />
                4. Falls back to "(no reason recorded)".<br /><br />
                Low-confidence Unresponsive entries from the legacy AI layer are filtered out to avoid diluting signal.
              </>} />
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.25 }}>
              {includeInferred
                ? `Layered: ${Object.keys(userClassifications).length} user-classified · ${Object.keys(research?.classifications_by_customer_id ?? {}).length} deep-researched · ${(inferenceMap?.size ?? 0).toLocaleString()} legacy AI-inferred.`
                : 'Showing only the reasons HubSpot CSMs recorded in the Churn Playbook.'}
            </Typography>
          </Box>
          <ToggleButtonGroup
            value={includeInferred ? 'with-ai' : 'hubspot-only'}
            exclusive
            size="small"
            onChange={(_e, v) => { if (v !== null) setIncludeInferred(v === 'with-ai'); }}
          >
            <ToggleButton value="hubspot-only">HubSpot only</ToggleButton>
            <ToggleButton value="with-ai">+ user / research / AI</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
      </Paper>

      {noReasonCluster && noReasonCluster.pctOfDollars > 0.20 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <strong>{(noReasonCluster.pctOfDollars * 100).toFixed(0)}% of churned dollars ({USD_COMPACT.format(noReasonCluster.dollars)}) have no recorded reason.</strong>{' '}
          The Churn Playbook capture rate dropped from {peakCapture?.pct.toFixed(0) ?? '—'}% in {peakCapture?.year ?? '—'} to {latestCapture?.pct.toFixed(0) ?? '—'}% in {latestCapture?.year ?? '—'}. Every other initiative on this page is sized off the {(100 - noReasonCluster.pctOfDollars * 100).toFixed(0)}% we do measure — fixing capture is the #1 unlock.
        </Alert>
      )}

      {/* Headline cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Total churned $</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32, width: '60%' }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500 }}>{USD_COMPACT.format(totalChurnDollars)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Across {churnedAll.length} accounts</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Unmeasured churn</Typography>
            {isLoading || !noReasonCluster ? <Skeleton variant="text" sx={{ fontSize: 32, width: '60%' }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'warning.main' }}>{(noReasonCluster.pctOfDollars * 100).toFixed(0)}%</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{noReasonCluster.count} customers · {USD_COMPACT.format(noReasonCluster.dollars)} unattributed</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Biggest known cluster</Typography>
            {isLoading || !biggestRealCluster ? <Skeleton variant="text" sx={{ fontSize: 32, width: '60%' }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500 }}>{biggestRealCluster.reason}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>{USD_COMPACT.format(biggestRealCluster.dollars)} · {biggestRealCluster.count} customers · {(biggestRealCluster.pctOfDollars * 100).toFixed(1)}% of churn $</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5, height: '100%' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Capture rate · {latestCapture?.year ?? '—'}</Typography>
            {isLoading || !latestCapture ? <Skeleton variant="text" sx={{ fontSize: 32, width: '60%' }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: latestCapture.pct >= 70 ? 'success.main' : latestCapture.pct >= 50 ? 'warning.main' : 'error.main' }}>{latestCapture.pct.toFixed(0)}%</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Peak: {peakCapture?.pct.toFixed(0)}% in {peakCapture?.year}. Target: 100% — required for diligence.</Typography>
              </>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Top-level pattern bar chart. Mirrors the sub-pattern chart in the drill-down: horizontal
          bars sorted by customer count, tier-colored, clickable to open that cluster's drill-down.
          The active cluster gets a brighter highlight; once a cluster is open, others dim. */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Churn patterns · customer count by reason</Typography>
          <InfoIcon info={<><strong>What it is:</strong> Horizontal bar per Churn Playbook reason, sized by customer count. Bar color is the preventability tier (red = preventable-high, orange = mixed/preventable-low, green = accept, blue = process). Click a bar to open the cluster drill-down — equivalent to clicking the cluster row below.</>} />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={300} /> : (
          <Box sx={{ height: Math.min(clusters.length * 26 + 28, 480) }}>
            <ResponsiveContainer>
              <BarChart
                data={clusters.map((c) => ({
                  reason: c.reason,
                  count: c.count,
                  dollars: c.dollars,
                  pct: c.pctOfDollars,
                  tier: c.tier,
                  tierLabel: tierLabel(c.tier),
                  color: tierColor(c.tier),
                  inferredCount: c.inferredCount,
                }))}
                layout="vertical"
                margin={{ top: 4, right: 60, bottom: 4, left: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.08)" horizontal={false} />
                <XAxis type="number" stroke="#8B949E" fontSize={10} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="reason"
                  stroke="#8B949E"
                  fontSize={11}
                  width={210}
                  tick={{ fill: '#C9D1D9' }}
                  interval={0}
                />
                <RTooltip
                  cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                  formatter={(_v: number, _n, ctx) => {
                    const p = ctx.payload as { count: number; dollars: number; pct: number; tierLabel: string; inferredCount: number };
                    return [`${p.count} customers · ${USD_COMPACT.format(p.dollars)} (${(p.pct * 100).toFixed(1)}% of churn $)${p.inferredCount > 0 ? ` · ${p.inferredCount} AI-inferred` : ''}`, p.tierLabel];
                  }}
                  contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF', maxWidth: 380 }}
                  labelStyle={{ color: '#FFFFFF', whiteSpace: 'normal' }}
                  itemStyle={{ color: '#FFFFFF' }}
                />
                <Bar
                  dataKey="count"
                  onClick={(payload: unknown) => {
                    const reason = (payload as { reason?: string })?.reason;
                    if (reason) { setDrillReason(drillReason === reason ? null : reason); setDrillSubpattern(null); }
                  }}
                  cursor="pointer"
                  label={{ position: 'right', fill: '#C9D1D9', fontSize: 10, formatter: (v: number) => v }}
                >
                  {clusters.map((c) => {
                    const isActive = drillReason === c.reason;
                    const baseColor = tierColor(c.tier);
                    // Recharts' tierColor returns MUI palette tokens (e.g. 'error.main') for some
                    // tiers — those don't render directly in SVG, so map to explicit hex per tier.
                    const explicit = {
                      'preventable-high': '#E53E3E',
                      'preventable-low': '#F5A623',
                      'mixed': '#F5A623',
                      'accept': '#1A9E5C',
                      'process': '#2C73FF',
                    }[c.tier] || '#2C73FF';
                    return (
                      <Cell
                        key={c.reason}
                        fill={isActive ? explicit : drillReason ? `${explicit}66` : explicit}
                        // 66 = 40% alpha — dims non-selected bars when one is active.
                        // Keep baseColor referenced to silence unused-var warnings while
                        // documenting the source of the explicit map.
                        data-base-color={baseColor}
                      />
                    );
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Box>
        )}
      </Paper>

      {/* Pattern grid */}
      <Paper sx={{ p: 3, mb: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>Patterns · sorted by churn $ at stake · click a row to drill into customer list</Typography>
          <InfoIcon info={<><strong>What it is:</strong> Every HubSpot Churn Playbook category, dollar-weighted. Combo reasons (semicolon-separated) split equally across categories.<br /><br /><strong>How to read:</strong> "Preventable · high impact" clusters are where engineering / CS investment yields the most preserved LTV. "Accept" clusters are non-preventable — track for trend, don't burn CSM hours saving.</>} />
        </Stack>
        {isLoading ? <Skeleton variant="rectangular" height={400} /> : (
          <Stack spacing={1.5}>
            {clusters.map((c) => (
              <Paper
                key={c.reason}
                variant="outlined"
                onClick={() => { setDrillReason(c.reason); setDrillSubpattern(null); }}
                sx={{
                  p: 2,
                  cursor: 'pointer',
                  transition: 'background-color 120ms',
                  borderLeft: '3px solid',
                  borderLeftColor: tierColor(c.tier),
                  '&:hover': { bgcolor: 'rgba(44, 115, 255, 0.04)' },
                }}
              >
                <Grid container spacing={2} alignItems="center">
                  <Grid item xs={12} md={3}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{c.reason}</Typography>
                      <Chip label={tierLabel(c.tier)} size="small" sx={{ height: 20, fontSize: 10, color: tierColor(c.tier), borderColor: tierColor(c.tier) }} variant="outlined" />
                      {c.inferredCount > 0 && (
                        <Chip
                          label={`${c.inferredCount} AI`}
                          size="small"
                          variant="outlined"
                          sx={{ height: 20, fontSize: 10, color: '#1A9E5C', borderColor: 'rgba(26, 158, 92, 0.5)' }}
                          title={`${c.inferredCount} of ${c.count} customers in this cluster have an AI-inferred reason (HubSpot didn't record one).`}
                        />
                      )}
                    </Stack>
                    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" sx={{ mt: 0.75 }}>
                      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        {c.category}
                      </Typography>
                      {c.topSegment && c.topSegment !== '(unsegmented)' && (
                        <Chip
                          label={`${segmentLabel(c.topSegment)} ${c.topSegmentCount}/${c.count}`}
                          size="small"
                          variant="outlined"
                          sx={{ height: 18, fontSize: 10, ml: 0.5, color: segmentColor(c.topSegment), borderColor: segmentColor(c.topSegment) }}
                          title={`Most-impacted primary segment in this cluster: ${segmentLabel(c.topSegment)} (${c.topSegmentCount} of ${c.count} customers).`}
                        />
                      )}
                      {c.topSubSegment && (
                        <Chip
                          label={`${c.topSubSegment} ${c.topSubSegmentCount}/${c.count}`}
                          size="small"
                          variant="outlined"
                          sx={{ height: 18, fontSize: 10, color: 'text.secondary', borderColor: 'rgba(139,148,158,0.5)' }}
                          title={`Most-impacted sub-segment in this cluster.`}
                        />
                      )}
                    </Stack>
                  </Grid>
                  <Grid item xs={6} md={1.5}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>$ AT STAKE</Typography>
                    <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>{USD_COMPACT.format(c.dollars)}</Typography>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{(c.pctOfDollars * 100).toFixed(1)}% of churn $</Typography>
                  </Grid>
                  <Grid item xs={6} md={1}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>CUSTOMERS</Typography>
                    <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>{c.count}</Typography>
                  </Grid>
                  <Grid item xs={6} md={1.5}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>AVG TENURE / PEAK MRR</Typography>
                    <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {c.avgTenure != null ? `${c.avgTenure.toFixed(1)}y` : '—'} · {c.avgPeakMrr != null ? USD0.format(c.avgPeakMrr) : '—'}
                    </Typography>
                  </Grid>
                  <Grid item xs={12} md={5}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>RECOMMENDED INITIATIVE</Typography>
                    <Typography variant="body2" sx={{ fontSize: 13 }}>{c.initiative}</Typography>
                  </Grid>
                </Grid>
              </Paper>
            ))}
          </Stack>
        )}
      </Paper>

      {/* Drill-down panel for selected cluster. Reason source column shows whether each customer's
          reason came from HubSpot (authoritative) or the AI overlay (inferred from CSM notes).
          When sub-patterns are available for this cluster, a chip strip at the top filters the
          customer table to only those tagged with the selected sub-pattern. */}
      {drillCluster && (() => {
        const tagsByAid = subpatterns?.customer_subpatterns || {};
        const allRows = drillCluster.customers.slice();
        // Apply sub-pattern filter when one is selected.
        const rows = (drillSubpattern
          ? allRows.filter((c) => (tagsByAid[String(c.allmoxy_customer_id)] || []).includes(drillSubpattern))
          : allRows
        ).sort((a, b) => (b.lifetime_subscription || 0) - (a.lifetime_subscription || 0));
        const columns: DrillColumn<ProfileRow>[] = [
          {
            key: 'name',
            label: 'Customer',
            render: (r) => <CustomerLink id={r.allmoxy_customer_id} name={r.name} />,
            // Export the plain name string, not the React element.
            exportValue: (r) => r.name,
            sortValue: (r) => r.name?.toLowerCase() ?? '',
          },
          {
            key: 'primary_segment',
            label: 'Segment',
            render: (r) => {
              if (!r.primary_segment) return '—';
              const color = segmentColor(r.primary_segment);
              return (
                <Chip
                  label={segmentLabel(r.primary_segment)}
                  size="small"
                  variant="outlined"
                  sx={{ height: 20, fontSize: 11, color, borderColor: color }}
                />
              );
            },
            exportValue: (r) => (r.primary_segment ? segmentLabel(r.primary_segment) : ''),
            sortValue: (r) => r.primary_segment ?? '',
          },
          { key: 'sub_segment', label: 'Sub-segment', render: (r) => r.sub_segment || '—' },
          { key: 'lifetime_subscription', label: 'Lifetime sub $', align: 'right', render: (r) => USD0.format(r.lifetime_subscription || 0) },
          { key: 'peak_month_total', label: 'Peak MRR', align: 'right', render: (r) => r.peak_month_total != null ? USD0.format(r.peak_month_total) : '—' },
          { key: 'years_with_us', label: 'Tenure (y)', align: 'right', render: (r) => r.years_with_us != null ? r.years_with_us.toFixed(1) : '—' },
          { key: 'last_payment_date', label: 'Last payment', render: (r) => r.last_payment_date || '—' },
          { key: 'failed_3mo_count', label: 'Last-3mo failures', align: 'right', render: (r) => r.failed_3mo_count || 0 },
          {
            key: 'churn_reason',
            label: 'Source',
            render: (r) => {
              if (r.churn_reason && r.churn_reason.trim()) return 'HubSpot';
              const inf = inferenceMap.get(r.allmoxy_customer_id);
              if (!inf) return '—';
              return `AI · ${inf.confidence}`;
            },
          },
          {
            key: 'evidence',
            label: 'Full reason / evidence',
            render: (r) => {
              if (r.churn_reason && r.churn_reason.trim()) return r.churn_reason;
              const inf = inferenceMap.get(r.allmoxy_customer_id);
              if (!inf) return '—';
              const quote = inf.evidence_quote ? ` — "${inf.evidence_quote.slice(0, 120)}${inf.evidence_quote.length > 120 ? '…' : ''}"` : '';
              return `${inf.suggested_reason}${quote}`;
            },
          },
        ];
        const filenameBase = `churn_pattern_${drillCluster.reason.replace(/\W+/g, '_')}` + (drillSubpattern ? `__${drillSubpattern}` : '');
        const namedSegmentBreakdown = drillCluster.segmentBreakdown.filter((s) => s.name !== '(unsegmented)');
        const namedSubSegmentBreakdown = drillCluster.subSegmentBreakdown.filter((s) => s.name !== '(unspecified)');
        return (
          <>
            {/* Segment + sub-segment breakdown for this cluster. Shows how the churn $
                in this reason cluster distributes across the canonical Allmoxy segments
                (Lens 1 from segmentation framework) — answers "which segments are hit
                hardest by this churn reason?". */}
            {(namedSegmentBreakdown.length > 0 || namedSubSegmentBreakdown.length > 0) && (
              <Paper sx={{ p: 2, mb: 1.5, bgcolor: 'rgba(255,255,255,0.02)' }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.25 }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                    Where this churn lives · by segment
                  </Typography>
                </Stack>
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, mb: 0.5 }}>PRIMARY SEGMENT</Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {namedSegmentBreakdown.map((s) => {
                        const color = segmentColor(s.name);
                        return (
                          <Chip
                            key={s.name}
                            label={`${segmentLabel(s.name)} · ${s.count} · ${USD_COMPACT.format(s.dollars)}`}
                            size="small"
                            variant="outlined"
                            sx={{ height: 22, fontSize: 11, color, borderColor: color, mb: 0.5 }}
                            title={`${s.count} customers · ${USD0.format(s.dollars)} weighted churn $`}
                          />
                        );
                      })}
                    </Stack>
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, mb: 0.5 }}>SUB-SEGMENT</Typography>
                    {namedSubSegmentBreakdown.length === 0 ? (
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                        No sub-segment data for this cluster (customers missing HubSpot sub_segment_framework).
                      </Typography>
                    ) : (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {namedSubSegmentBreakdown.map((s) => (
                          <Chip
                            key={s.name}
                            label={`${s.name} · ${s.count} · ${USD_COMPACT.format(s.dollars)}`}
                            size="small"
                            variant="outlined"
                            sx={{ height: 22, fontSize: 11, color: 'text.secondary', borderColor: 'rgba(139,148,158,0.5)', mb: 0.5 }}
                            title={`${s.count} customers · ${USD0.format(s.dollars)} weighted churn $`}
                          />
                        ))}
                      </Stack>
                    )}
                  </Grid>
                </Grid>
              </Paper>
            )}
            {/* Sub-pattern filter chips. Rendered as a separate Paper above DrillDownPanel.
                Clicking a chip toggles the filter; clicking the active one clears it.
                "Untagged" chip filters to customers in this cluster who didn't match any
                sub-pattern keyword — these are the ones that need manual review to refine
                the keyword rules in build_churn_subpatterns.mjs. */}
            {drillSubpatternStats && drillSubpatternStats.stats.length > 0 && (
              <Paper sx={{ p: 2, mb: 1.5, bgcolor: 'rgba(255,255,255,0.02)' }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.25 }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                    Sub-patterns
                  </Typography>
                  <InfoIcon info={<><strong>What it is:</strong> Finer-grained tags within this reason cluster. Customer can have multiple tags. Click a bar to filter the table; click the active bar again to clear.<br /><br /><strong>Source:</strong> keyword detection over HubSpot churn_reason + AI evidence + former-CS-rep notes (Churn Details.xlsx). See <code>_etl_scripts/build_churn_subpatterns.mjs</code> to add or refine sub-patterns.</>} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', ml: 1, flexGrow: 1 }}>
                    {drillSubpatternStats.taggedCount}/{drillCluster.customers.length} customers tagged · {drillSubpatternStats.untaggedCount} untagged
                  </Typography>
                  {drillSubpattern && (
                    <Chip
                      label="Clear filter"
                      size="small"
                      onClick={() => setDrillSubpattern(null)}
                      sx={{ height: 22, fontSize: 11, bgcolor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.15)' }}
                    />
                  )}
                </Stack>

                {/* Horizontal bar chart — customer count per sub-pattern, with $ at stake on hover.
                    Clicking a bar applies the same filter as the chip below; clicking the active
                    bar clears it. Active bar gets a brighter blue so the selection is obvious in
                    both the chart and the chip strip. */}
                <Box
                  sx={{
                    height: Math.min(drillSubpatternStats.stats.length * 26 + 28, 320),
                  }}
                >
                  <ResponsiveContainer>
                    <BarChart
                      data={drillSubpatternStats.stats}
                      layout="vertical"
                      margin={{ top: 4, right: 60, bottom: 4, left: 4 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(139,148,158,0.08)" horizontal={false} />
                      <XAxis type="number" stroke="#8B949E" fontSize={10} allowDecimals={false} />
                      <YAxis
                        type="category"
                        dataKey="label"
                        stroke="#8B949E"
                        fontSize={11}
                        width={210}
                        tick={{ fill: '#C9D1D9' }}
                        interval={0}
                      />
                      <RTooltip
                        cursor={{ fill: 'rgba(44, 115, 255, 0.06)' }}
                        formatter={(_v: number, _n, ctx) => {
                          const p = ctx.payload as { count: number; dollars: number; description?: string };
                          return [`${p.count} customers · ${USD_COMPACT.format(p.dollars)}`, 'In sub-pattern'];
                        }}
                        labelFormatter={(label, items) => {
                          const desc = (items[0]?.payload as { description?: string })?.description;
                          return desc ? `${label} — ${desc.slice(0, 100)}${desc.length > 100 ? '…' : ''}` : String(label);
                        }}
                        contentStyle={{ background: '#161B22', border: '1px solid #21262D', borderRadius: 6, color: '#FFFFFF', maxWidth: 340 }}
                        labelStyle={{ color: '#FFFFFF', whiteSpace: 'normal' }}
                        itemStyle={{ color: '#FFFFFF' }}
                      />
                      <Bar
                        dataKey="count"
                        onClick={(payload: unknown) => {
                          const id = (payload as { id?: string })?.id;
                          if (id) setDrillSubpattern(drillSubpattern === id ? null : id);
                        }}
                        cursor="pointer"
                        label={{ position: 'right', fill: '#C9D1D9', fontSize: 10, formatter: (v: number) => v }}
                      >
                        {drillSubpatternStats.stats.map((s) => (
                          <Cell
                            key={s.id}
                            fill={drillSubpattern === s.id ? '#7AB0FF' : drillSubpattern ? 'rgba(44, 115, 255, 0.35)' : '#2C73FF'}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </Box>

              </Paper>
            )}
            <DrillDownPanel
              title={`${drillCluster.reason} · ${rows.length}${drillSubpattern ? ` of ${drillCluster.customers.length}` : ''} customers${drillCluster.inferredCount > 0 && !drillSubpattern ? ` (${drillCluster.inferredCount} AI-inferred)` : ''}`}
              subtitle={
                drillSubpattern
                  ? `Filtered to "${drillSubpatternStats?.stats.find((s) => s.id === drillSubpattern)?.label ?? drillSubpattern}" · ${USD_COMPACT.format(rows.reduce((s, r) => s + (r.lifetime_subscription || 0), 0))} of lifetime $`
                  : `${USD_COMPACT.format(drillCluster.dollars)} of lifetime $ · ${(drillCluster.pctOfDollars * 100).toFixed(1)}% of total churn $ · sorted by lifetime sub`
              }
              accent={drillCluster.tier === 'preventable-high' ? 'rgba(218, 54, 51, 0.5)' : drillCluster.tier === 'accept' ? 'rgba(26, 158, 92, 0.4)' : 'rgba(229, 137, 78, 0.4)'}
              rows={rows as unknown as Array<Record<string, unknown>>}
              columns={columns as unknown as DrillColumn<Record<string, unknown>>[]}
              filename={filenameBase}
              onClose={() => { setDrillReason(null); setDrillSubpattern(null); }}
            />
          </>
        );
      })()}
    </Box>
  );
}
