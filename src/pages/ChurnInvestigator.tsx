import { useCallback, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';

import PageHeader from '../components/common/PageHeader';
import CsvExportButton from '../components/common/CsvExportButton';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import { segmentColor, segmentLabel, CANONICAL_SEGMENTS } from '../lib/segmentsRegistry';

// Canonical Allmoxy Churn Playbook reasons (matches ChurnPatterns INITIATIVES).
// Multi-select: a single churn often involves more than one of these.
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
type ChurnReason = (typeof CANONICAL_CHURN_REASONS)[number];

type Classification = {
  reasons: ChurnReason[];
  notes: string;
  classified_at: string;
  classified_by: string;
};

const CLASSIFICATION_STORAGE_KEY = 'allmoxy:churn-classifications:v1';
const CLASSIFIER_STORAGE_KEY = 'allmoxy:churn-classifier-name';

/**
 * useChurnClassifications — persistent per-customer classification store backed
 * by localStorage. Survives page reloads but lives in the browser only; export
 * to CSV when you're ready to push to HubSpot.
 */
function useChurnClassifications() {
  const [store, setStore] = useState<Record<string, Classification>>(() => {
    try {
      const raw = localStorage.getItem(CLASSIFICATION_STORAGE_KEY);
      return raw ? JSON.parse(raw) as Record<string, Classification> : {};
    } catch { return {}; }
  });
  const [classifierName, setClassifierName] = useState<string>(() => {
    try { return localStorage.getItem(CLASSIFIER_STORAGE_KEY) ?? ''; }
    catch { return ''; }
  });

  useEffect(() => {
    try { localStorage.setItem(CLASSIFICATION_STORAGE_KEY, JSON.stringify(store)); } catch {}
  }, [store]);
  useEffect(() => {
    try { localStorage.setItem(CLASSIFIER_STORAGE_KEY, classifierName); } catch {}
  }, [classifierName]);

  const set = useCallback((customerId: number, c: Omit<Classification, 'classified_at' | 'classified_by'>) => {
    setStore((prev) => ({
      ...prev,
      [String(customerId)]: {
        ...c,
        classified_at: new Date().toISOString(),
        classified_by: classifierName || 'unknown',
      },
    }));
  }, [classifierName]);

  const clear = useCallback((customerId: number) => {
    setStore((prev) => {
      const next = { ...prev };
      delete next[String(customerId)];
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    if (confirm('Clear ALL local classifications? This cannot be undone (unless you exported a CSV first).')) {
      setStore({});
    }
  }, []);

  return { store, set, clear, clearAll, classifierName, setClassifierName };
}

type SegmentLookupRow = {
  allmoxy_customer_id: number;
  name: string;
  primary_segment: string | null;
  sub_segment: string | null;
  status: string;
  churn_reason: string | null;
  hubspot_company_id: string | null;
  lifetime_subscription: number | null;
  years_with_us: number | null;
  excluded_from_logo_count?: boolean;
};

type InferenceCustomer = {
  allmoxy_customer_id: number;
  name: string;
  // Many entries (~33) have no linked HubSpot record and ~31 lack a tenure value, so these
  // fields are nullable. The page must guard `.toFixed`, `<Link>`, etc.
  hubspot_company_id: string | null;
  lifetime_subscription: number;
  years_with_us: number | null;
  current_status: string;
  suggested_reason: string;
  confidence: 'high' | 'medium' | 'low';
  evidence_quote: string;
  evidence_date: string | null;
  signals: string[];
  hubspot_url: string | null;
  recommended_action: string;
  // The 'reason_source' below is set when we synthesize a synthetic inference
  // entry for a churned customer who isn't in the original inferences set.
  // 'hubspot' = customer already has a recorded HubSpot churn_reason; 'none' =
  // no reason from any source yet (rare — should be near zero).
  reason_source?: 'inference' | 'hubspot' | 'none';
};

type InferencesSnapshot = {
  fetchedAt: string;
  generatedBy: string;
  customer_count: number;
  notes: string;
  customers: InferenceCustomer[];
};

// Deep-research classification from _etl_scripts/churn_research_batches/, consolidated
// into public/snapshots/churn_research_classifications.json. Surfaces per-card so the
// user can accept the proposed reason with one click instead of re-investigating.
type ResearchClassification = {
  allmoxy_customer_id: number;
  name: string;
  hubspot_company_id: string | null;
  hubspot_url: string | null;
  lifetime_subscription: number;
  proposed_churn_reason: string;
  confidence: 'high' | 'medium' | 'low';
  evidence_quotes: Array<{ date: string | null; quote: string; interpretation: string }>;
  supporting_facts?: Record<string, string | number | null>;
  alternative_reasons_considered?: string[];
  recommended_action: string;
  source_batch?: string;
};

type ResearchSnapshot = {
  fetched_at: string;
  total: number;
  classifications_by_customer_id: Record<string, ResearchClassification>;
};

// Map agent-proposed reasons to the canonical 13. Most match directly; a few
// need translation. FALSE POSITIVE entries are handled separately (not a churn).
function mapProposedToCanonical(proposed: string): ChurnReason[] {
  if (!proposed) return [];
  if (proposed.includes('FALSE POSITIVE')) return []; // not a churn — handled elsewhere
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
  // Last-resort exact-match search across the canonical list
  const exact = CANONICAL_CHURN_REASONS.find((r) => r.toLowerCase() === p);
  if (exact) return [exact];
  return [];
}

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

function confidenceColor(c: InferenceCustomer['confidence']): string {
  switch (c) {
    case 'high':   return 'success.main';
    case 'medium': return 'warning.main';
    case 'low':    return 'text.secondary';
  }
}

// Does the legacy AI inference carry a real proposed reason worth surfacing?
// Filters out two dilutive categories:
//   1. Placeholder strings like "(needs manual review)" / "(unknown)"
//   2. Low-confidence default-Unresponsive — these are essentially "we have no
//      idea, defaulting to Unresponsive". They get filtered out of ChurnPatterns
//      as noise; the Investigator treats them the same so both pages agree on
//      what counts as "classified".
function isUsableInference(c: InferenceCustomer): boolean {
  if (c.reason_source !== 'inference') return false;
  if (!c.suggested_reason) return false;
  if (/^\(.*\)$/.test(c.suggested_reason.trim())) return false;
  if (c.confidence === 'low' && c.suggested_reason === 'Unresponsive') return false;
  return true;
}


export default function ChurnInvestigator() {
  const { data, isLoading, error } = useSheetTab('churn_inferences');
  const snap = data as unknown as InferencesSnapshot | undefined;

  // Side-load customer_profiles for segment lookup. The inferences snapshot doesn't
  // carry primary_segment / sub_segment — those live on customer_profiles. We build
  // a Map<allmoxy_customer_id, {primary, sub}> and look up on each card render.
  const { data: profilesData } = useSheetTab('customer_profiles');

  // Deep-research classifications from the agent-research batches. Keyed by
  // allmoxy_customer_id. Loaded once; looked up per card.
  const { data: researchData } = useSheetTab('churn_research_classifications');
  const researchByCustomerId = useMemo(() => {
    const snap = researchData as unknown as ResearchSnapshot | undefined;
    const map = new Map<number, ResearchClassification>();
    if (!snap?.classifications_by_customer_id) return map;
    for (const [k, v] of Object.entries(snap.classifications_by_customer_id)) {
      map.set(Number(k), v);
    }
    return map;
  }, [researchData]);
  const segmentByCustomerId = useMemo(() => {
    const m = new Map<number, { primary: string | null; sub: string | null }>();
    const rows = (profilesData as unknown as { rows: SegmentLookupRow[] } | undefined)?.rows ?? [];
    for (const r of rows) {
      m.set(r.allmoxy_customer_id, { primary: r.primary_segment ?? null, sub: r.sub_segment ?? null });
    }
    return m;
  }, [profilesData]);

  const [filter, setFilter] = useState<'all' | 'confirmed' | 'needs_review' | 'researched' | 'my_classifications'>('all');
  const [segmentFilter, setSegmentFilter] = useState<string>('all');
  const classifications = useChurnClassifications();

  // The customers array is the MASTER list of every real churn (status='churned',
  // not excluded). For each, we merge in: HubSpot's recorded churn_reason (if
  // any), the legacy inference entry (if any), and downstream the deep-research
  // proposal and the user's localStorage classification get joined per card.
  // This is what makes the dashboard the master, not HubSpot.
  const customers: InferenceCustomer[] = useMemo(() => {
    const profileRows = (profilesData as unknown as { rows: SegmentLookupRow[] } | undefined)?.rows ?? [];
    const inferenceById = new Map<number, InferenceCustomer>();
    for (const c of snap?.customers ?? []) inferenceById.set(c.allmoxy_customer_id, c);

    return profileRows
      .filter((r) => r.status === 'churned' && !r.excluded_from_logo_count)
      .map<InferenceCustomer>((p) => {
        const existing = inferenceById.get(p.allmoxy_customer_id);
        if (existing) {
          return { ...existing, reason_source: 'inference' };
        }
        // Synthesize an entry for a churned customer who isn't in the inferences set.
        // Happens when HubSpot already has a churn_reason recorded — they were excluded
        // from extend_churn_inferences. We surface them here so the dashboard is the
        // master view of every churn, with their HubSpot reason as the suggested_reason.
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

  const isUserClassified = useCallback(
    (c: InferenceCustomer) => !!classifications.store[String(c.allmoxy_customer_id)],
    [classifications.store]
  );

  // Confirmed = the dashboard considers this customer's reason locked in. Two ways
  // to be confirmed: (a) you explicitly classified them, or (b) HubSpot has a
  // recorded churn_reason that we're inheriting as-is. Everything else is "Needs
  // review" — has a proposal (deep research / legacy AI inference) but no
  // owner sign-off.
  const isConfirmed = useCallback(
    (c: InferenceCustomer) => isUserClassified(c) || c.reason_source === 'hubspot',
    [isUserClassified]
  );

  const filtered = useMemo(() => {
    let rows = customers;
    if (filter === 'confirmed') {
      rows = rows.filter(isConfirmed);
    } else if (filter === 'needs_review') {
      rows = rows.filter((c) => !isConfirmed(c));
    } else if (filter === 'researched') {
      rows = rows.filter((c) => researchByCustomerId.has(c.allmoxy_customer_id));
    } else if (filter === 'my_classifications') {
      rows = rows.filter(isUserClassified);
    }
    if (segmentFilter !== 'all') {
      rows = rows.filter((c) => segmentByCustomerId.get(c.allmoxy_customer_id)?.primary === segmentFilter);
    }
    return rows;
  }, [customers, filter, segmentFilter, segmentByCustomerId, isUserClassified, isConfirmed, researchByCustomerId]);

  // Build the segment-filter chip set: only segments actually represented in the inferences list.
  const segmentFilterChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of customers) {
      const seg = segmentByCustomerId.get(c.allmoxy_customer_id)?.primary;
      if (!seg) continue;
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
    // Sort by canonical HubSpot order
    return CANONICAL_SEGMENTS
      .filter((s) => counts.has(s.value))
      .map((s) => ({ value: s.value, label: s.label, count: counts.get(s.value)!, color: s.color }));
  }, [customers, segmentByCustomerId]);

  // Simple stats — Confirmed (user-classified or HubSpot recorded) vs Needs review
  // (has only a proposal from research/AI inference, no owner sign-off yet).
  const stats = useMemo(() => {
    let totalDollars = 0;
    let confirmedDollars = 0;
    let needsReviewDollars = 0;
    let unclassifiedDollars = 0;
    let confirmedCount = 0;
    let needsReviewCount = 0;
    let unclassifiedCount = 0;
    let hubspotRecordedCount = 0;
    let userClassifiedCount = 0;
    let researchedCount = 0;
    for (const c of customers) {
      totalDollars += c.lifetime_subscription;
      const userHas = isUserClassified(c);
      const hubspotHas = c.reason_source === 'hubspot';
      const researchHas = researchByCustomerId.has(c.allmoxy_customer_id);
      if (userHas) userClassifiedCount++;
      if (hubspotHas) hubspotRecordedCount++;
      if (researchHas) researchedCount++;
      if (userHas || hubspotHas) {
        confirmedDollars += c.lifetime_subscription;
        confirmedCount++;
      } else if (researchHas || isUsableInference(c)) {
        needsReviewDollars += c.lifetime_subscription;
        needsReviewCount++;
      } else {
        unclassifiedDollars += c.lifetime_subscription;
        unclassifiedCount++;
      }
    }
    return {
      totalDollars, confirmedDollars, needsReviewDollars, unclassifiedDollars,
      confirmedCount, needsReviewCount, unclassifiedCount,
      hubspotRecordedCount, userClassifiedCount, researchedCount,
    };
  }, [customers, isUserClassified, researchByCustomerId]);

  return (
    <Box>
      <PageHeader
        title="Churn Investigator"
        subtitle="The master classification file for every churned customer. Each row carries its current reason from the strongest available source (your classification → HubSpot recorded → deep research → AI inference). Confirm or override any row; this dashboard is the system of record."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load data: {String(error)}</Alert>}

      {/* Coverage tracker — Confirmed vs Needs review */}
      <Paper sx={{ p: 2.5, mb: 3, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '4px solid', borderColor: 'primary.main' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5, fontWeight: 600 }}>
          Classification status
        </Typography>
        <Grid container spacing={2} sx={{ mt: 0.5 }}>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>TOTAL CHURNS</Typography>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>{customers.length.toLocaleString()}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{USD0.format(stats.totalDollars)} lifetime $</Typography>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>CONFIRMED</Typography>
            <Typography variant="h5" sx={{ fontWeight: 600, color: 'success.main' }}>
              {stats.confirmedCount.toLocaleString()}
              <Box component="span" sx={{ fontSize: 14, fontWeight: 400, color: 'text.secondary' }}> · {customers.length > 0 ? Math.round((stats.confirmedCount / customers.length) * 100) : 0}%</Box>
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {stats.userClassifiedCount} by you · {stats.hubspotRecordedCount} from HubSpot
            </Typography>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>NEEDS YOUR REVIEW</Typography>
            <Typography variant="h5" sx={{ fontWeight: 600, color: 'warning.main' }}>{stats.needsReviewCount.toLocaleString()}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Has a proposal (research or AI) — needs your confirmation. {stats.researchedCount} have deep-research evidence.
            </Typography>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>UNCLASSIFIED</Typography>
            <Typography variant="h5" sx={{ fontWeight: 600, color: stats.unclassifiedCount > 0 ? 'error.main' : 'text.primary' }}>{stats.unclassifiedCount.toLocaleString()}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              No reason from any source. {stats.unclassifiedCount === 0 ? 'Every churn has a classification.' : 'Needs manual entry.'}
            </Typography>
          </Grid>
        </Grid>
      </Paper>

      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="all">All ({customers.length})</ToggleButton>
          <ToggleButton value="confirmed">
            Confirmed ({stats.confirmedCount})
          </ToggleButton>
          <ToggleButton value="needs_review">
            Needs review ({stats.needsReviewCount})
          </ToggleButton>
          <ToggleButton value="researched">
            Has research ({stats.researchedCount})
          </ToggleButton>
          <ToggleButton value="my_classifications">
            My classifications ({stats.userClassifiedCount})
          </ToggleButton>
        </ToggleButtonGroup>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            placeholder="Your name"
            value={classifications.classifierName}
            onChange={(e) => classifications.setClassifierName(e.target.value)}
            sx={{ width: 140, '& input': { fontSize: 12 } }}
            inputProps={{ 'aria-label': 'Your name (stamped on classifications)' }}
          />
          <CsvExportButton
            filename={`churn_master_classifications_${new Date().toISOString().slice(0, 10)}`}
            columns={[
              { key: 'allmoxy_customer_id', label: 'Allmoxy ID' },
              { key: 'name', label: 'Company name' },
              { key: 'lifetime_subscription', label: 'Lifetime Subscription $' },
              {
                key: 'effective_reason',
                label: 'Churn Reason',
                getValue: (r) => {
                  const c = r as unknown as InferenceCustomer;
                  const user = classifications.store[String(c.allmoxy_customer_id)];
                  if (user) return user.reasons.join('; ');
                  if (c.reason_source === 'hubspot') return c.suggested_reason;
                  const res = researchByCustomerId.get(c.allmoxy_customer_id);
                  if (res) return res.proposed_churn_reason;
                  return isUsableInference(c) ? c.suggested_reason : '';
                },
              },
              {
                key: 'reason_source',
                label: 'Source',
                getValue: (r) => {
                  const c = r as unknown as InferenceCustomer;
                  if (classifications.store[String(c.allmoxy_customer_id)]) return 'Your classification';
                  if (c.reason_source === 'hubspot') return 'HubSpot recorded';
                  if (researchByCustomerId.has(c.allmoxy_customer_id)) return 'Deep research (agent)';
                  if (isUsableInference(c)) return 'AI inference';
                  return 'Unclassified';
                },
              },
              {
                key: 'confirmed',
                label: 'Confirmed?',
                getValue: (r) => {
                  const c = r as unknown as InferenceCustomer;
                  return (classifications.store[String(c.allmoxy_customer_id)] || c.reason_source === 'hubspot') ? 'yes' : 'no';
                },
              },
              {
                key: 'my_notes',
                label: 'Your Notes',
                getValue: (r) => classifications.store[String((r as unknown as InferenceCustomer).allmoxy_customer_id)]?.notes ?? '',
              },
              {
                key: 'classified_by',
                label: 'Classified By',
                getValue: (r) => classifications.store[String((r as unknown as InferenceCustomer).allmoxy_customer_id)]?.classified_by ?? '',
              },
              {
                key: 'classified_at',
                label: 'Classified At',
                getValue: (r) => classifications.store[String((r as unknown as InferenceCustomer).allmoxy_customer_id)]?.classified_at ?? '',
              },
              { key: 'hubspot_company_id', label: 'HubSpot Company ID' },
              { key: 'hubspot_url', label: 'HubSpot Link' },
            ]}
            rows={filtered as unknown as Array<Record<string, unknown>>}
            label="Export master file"
          />
        </Stack>
      </Stack>

      {/* Segment filter — chip strip of segments actually represented in the inference set,
          in canonical HubSpot order. Clicking a segment chip toggles the filter. */}
      {segmentFilterChips.length > 0 && (
        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5 }}>
            Segment
          </Typography>
          <Chip
            label={`All (${customers.length})`}
            size="small"
            variant={segmentFilter === 'all' ? 'filled' : 'outlined'}
            onClick={() => setSegmentFilter('all')}
            sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
          />
          {segmentFilterChips.map((s) => {
            const isActive = segmentFilter === s.value;
            return (
              <Chip
                key={s.value}
                label={`${s.label} (${s.count})`}
                size="small"
                variant={isActive ? 'filled' : 'outlined'}
                onClick={() => setSegmentFilter(isActive ? 'all' : s.value)}
                sx={{
                  height: 22,
                  fontSize: 11,
                  cursor: 'pointer',
                  color: isActive ? '#fff' : s.color,
                  borderColor: s.color,
                  bgcolor: isActive ? s.color : 'transparent',
                  '&:hover': { bgcolor: isActive ? s.color : `${s.color}22` },
                }}
              />
            );
          })}
        </Stack>
      )}

      <Stack spacing={2}>
        {isLoading && [1, 2, 3].map((i) => <Skeleton key={i} variant="rectangular" height={140} />)}
        {filtered.map((c) => {
          const seg = segmentByCustomerId.get(c.allmoxy_customer_id);
          const userClassified = isUserClassified(c);
          const hubspotRecorded = c.reason_source === 'hubspot';
          const confirmed = userClassified || hubspotRecorded;
          const research = researchByCustomerId.get(c.allmoxy_customer_id);
          // Card accent color tells the user the state at a glance:
          //   green  = confirmed (their classification OR HubSpot recorded)
          //   blue   = has research proposal awaiting review
          //   yellow = has AI inference only
          //   red    = unclassified (no source has a reason — needs manual entry)
          const usableInference = isUsableInference(c);
          const accentColor = confirmed
            ? 'success.main'
            : research
              ? 'primary.main'
              : usableInference
                ? 'warning.main'
                : 'error.main';
          const sourceLabel = userClassified
            ? 'Your classification'
            : hubspotRecorded
              ? 'HubSpot recorded'
              : research
                ? `Research · ${research.confidence}`
                : usableInference
                  ? `AI inference · ${c.confidence}`
                  : 'Unclassified';
          const sourceColor = userClassified || hubspotRecorded
            ? { bg: 'rgba(26, 158, 92, 0.15)', fg: 'success.main' }
            : research
              ? { bg: 'rgba(44, 115, 255, 0.18)', fg: 'primary.main' }
              : usableInference
                ? { bg: 'rgba(245, 166, 35, 0.18)', fg: 'warning.main' }
                : { bg: 'rgba(218, 54, 51, 0.22)', fg: 'error.main' };
          return (
            <Paper key={c.allmoxy_customer_id} sx={{ p: 2.5, borderLeft: '3px solid', borderLeftColor: accentColor }}>
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{c.name}</Typography>
                    <Chip
                      label={sourceLabel}
                      size="small"
                      sx={{ height: 20, fontSize: 10, bgcolor: sourceColor.bg, color: sourceColor.fg, fontWeight: 500 }}
                    />
                    {seg?.primary && (
                      <Chip
                        label={segmentLabel(seg.primary)}
                        size="small"
                        variant="outlined"
                        sx={{ height: 20, fontSize: 10, color: segmentColor(seg.primary), borderColor: segmentColor(seg.primary), fontWeight: 500 }}
                        title={`Primary segment: ${segmentLabel(seg.primary)}`}
                      />
                    )}
                    {seg?.sub && (
                      <Chip
                        label={seg.sub}
                        size="small"
                        variant="outlined"
                        sx={{ height: 20, fontSize: 10, color: 'text.secondary', borderColor: 'rgba(139,148,158,0.5)' }}
                        title={`Sub-segment: ${seg.sub}`}
                      />
                    )}
                  </Stack>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>
                    {USD0.format(c.lifetime_subscription)} · {c.years_with_us != null ? `${c.years_with_us.toFixed(1)}y tenure` : 'tenure n/a'} · aid {c.allmoxy_customer_id}
                  </Typography>
                  <Box sx={{ mt: 1 }}>
                    {(() => {
                      // What reason to display in the headline block, in cascade priority:
                      // user-classification → HubSpot recorded → research → usable AI inference.
                      // Unclassified (no usable source) just labels itself.
                      const userClass = classifications.store[String(c.allmoxy_customer_id)];
                      if (userClass) {
                        return (
                          <>
                            <Typography variant="caption" sx={{ color: 'success.main', display: 'block', fontSize: 10, fontWeight: 600 }}>YOUR CLASSIFICATION</Typography>
                            <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 600, mt: 0.25 }}>{userClass.reasons.join(' + ')}</Typography>
                          </>
                        );
                      }
                      if (hubspotRecorded) {
                        return (
                          <>
                            <Typography variant="caption" sx={{ color: 'success.main', display: 'block', fontSize: 10, fontWeight: 600 }}>RECORDED IN HUBSPOT</Typography>
                            <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 600, mt: 0.25 }}>{c.suggested_reason}</Typography>
                          </>
                        );
                      }
                      if (research) {
                        return (
                          <>
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>RESEARCH-PROPOSED · {research.confidence.toUpperCase()} CONFIDENCE</Typography>
                            <Typography variant="body2" sx={{ color: confidenceColor(research.confidence), fontWeight: 600, mt: 0.25 }}>{research.proposed_churn_reason}</Typography>
                          </>
                        );
                      }
                      if (usableInference) {
                        return (
                          <>
                            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>AI INFERENCE · {c.confidence.toUpperCase()} CONFIDENCE</Typography>
                            <Typography variant="body2" sx={{ color: confidenceColor(c.confidence), fontWeight: 600, mt: 0.25 }}>{c.suggested_reason}</Typography>
                          </>
                        );
                      }
                      return (
                        <>
                          <Typography variant="caption" sx={{ color: 'error.main', display: 'block', fontSize: 10, fontWeight: 600 }}>UNCLASSIFIED</Typography>
                          <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic', mt: 0.25 }}>No reason from any source — classify manually below.</Typography>
                        </>
                      );
                    })()}
                    {research && mapProposedToCanonical(research.proposed_churn_reason).length > 0 && (
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => {
                          const reasons = mapProposedToCanonical(research.proposed_churn_reason);
                          const notes = `Auto-accepted from deep HubSpot research (${research.source_batch}). ${research.recommended_action}`;
                          classifications.set(c.allmoxy_customer_id, { reasons, notes });
                        }}
                        disabled={userClassified}
                        sx={{ mt: 1, textTransform: 'none', fontSize: 11, py: 0.25 }}
                      >
                        {userClassified ? '✓ Already classified' : `Accept "${mapProposedToCanonical(research.proposed_churn_reason).join(' + ')}"`}
                      </Button>
                    )}
                    {research && research.proposed_churn_reason.includes('FALSE POSITIVE') && (
                      <Alert severity="warning" sx={{ mt: 1, py: 0.5, '& .MuiAlert-message': { fontSize: 11 } }}>
                        Agent flagged this as a FALSE POSITIVE — see <code>customer_status_overrides.json</code> or adjust manually. Do not classify as a churn.
                      </Alert>
                    )}
                  </Box>
                  {c.hubspot_url ? (
                    <Link href={c.hubspot_url} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 11, display: 'inline-block', mt: 1 }}>
                      Open in HubSpot →
                    </Link>
                  ) : (
                    <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11, display: 'inline-block', mt: 1, fontStyle: 'italic' }}>
                      No HubSpot record linked
                    </Typography>
                  )}
                </Grid>
                <Grid item xs={12} md={5}>
                  {research && research.evidence_quotes.length > 0 ? (
                    <>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>
                        HUBSPOT EVIDENCE · {research.evidence_quotes.length} quote(s)
                      </Typography>
                      <Stack spacing={1} sx={{ mt: 0.5 }}>
                        {research.evidence_quotes.slice(0, 2).map((eq, i) => (
                          <Box key={i} sx={{ borderLeft: '2px solid rgba(44, 115, 255, 0.4)', pl: 1.5 }}>
                            {eq.date && (
                              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, display: 'block' }}>
                                {eq.date}
                              </Typography>
                            )}
                            <Typography variant="body2" sx={{ fontStyle: 'italic', fontSize: 12.5, lineHeight: 1.5, mt: 0.25 }}>
                              "{eq.quote.length > 240 ? eq.quote.slice(0, 240) + '…' : eq.quote}"
                            </Typography>
                            {eq.interpretation && (
                              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10.5, display: 'block', mt: 0.5 }}>
                                → {eq.interpretation}
                              </Typography>
                            )}
                          </Box>
                        ))}
                      </Stack>
                      {(research.evidence_quotes.length > 2 || (research.alternative_reasons_considered?.length ?? 0) > 0) && (
                        <Accordion elevation={0} sx={{ mt: 1, '&:before': { display: 'none' }, bgcolor: 'transparent' }}>
                          <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: 16 }} />} sx={{ minHeight: 24, px: 0, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                            <Typography variant="caption" sx={{ color: 'primary.main', fontSize: 10.5 }}>
                              Show {research.evidence_quotes.length > 2 ? `${research.evidence_quotes.length - 2} more quote(s)` : ''}
                              {research.evidence_quotes.length > 2 && (research.alternative_reasons_considered?.length ?? 0) > 0 ? ' + ' : ''}
                              {(research.alternative_reasons_considered?.length ?? 0) > 0 ? `${research.alternative_reasons_considered?.length} ruled-out alternatives` : ''}
                            </Typography>
                          </AccordionSummary>
                          <AccordionDetails sx={{ px: 0, pt: 0 }}>
                            {research.evidence_quotes.length > 2 && (
                              <Stack spacing={1}>
                                {research.evidence_quotes.slice(2).map((eq, i) => (
                                  <Box key={i} sx={{ borderLeft: '2px solid rgba(44, 115, 255, 0.4)', pl: 1.5 }}>
                                    {eq.date && (
                                      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, display: 'block' }}>
                                        {eq.date}
                                      </Typography>
                                    )}
                                    <Typography variant="body2" sx={{ fontStyle: 'italic', fontSize: 12.5, lineHeight: 1.5, mt: 0.25 }}>
                                      "{eq.quote.length > 240 ? eq.quote.slice(0, 240) + '…' : eq.quote}"
                                    </Typography>
                                    {eq.interpretation && (
                                      <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10.5, display: 'block', mt: 0.5 }}>
                                        → {eq.interpretation}
                                      </Typography>
                                    )}
                                  </Box>
                                ))}
                              </Stack>
                            )}
                            {(research.alternative_reasons_considered?.length ?? 0) > 0 && (
                              <Box sx={{ mt: 1.5 }}>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, mb: 0.5 }}>
                                  ALTERNATIVE REASONS CONSIDERED + RULED OUT
                                </Typography>
                                <Stack component="ul" sx={{ pl: 2, m: 0 }} spacing={0.5}>
                                  {research.alternative_reasons_considered!.map((a, i) => (
                                    <Typography key={i} component="li" variant="caption" sx={{ fontSize: 11, lineHeight: 1.5, color: 'text.secondary' }}>
                                      {a}
                                    </Typography>
                                  ))}
                                </Stack>
                              </Box>
                            )}
                          </AccordionDetails>
                        </Accordion>
                      )}
                    </>
                  ) : (
                    <>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>EVIDENCE {c.evidence_date && `· ${c.evidence_date}`}</Typography>
                      <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary', mt: 0.5, fontSize: 13, lineHeight: 1.5, borderLeft: '2px solid rgba(139,148,158,0.3)', pl: 1.5 }}>
                        "{c.evidence_quote}"
                      </Typography>
                      {c.signals.length > 0 && (
                        <Box sx={{ mt: 1.5 }}>
                          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>SIGNALS</Typography>
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
                            {c.signals.map((s, i) => (
                              <Chip key={i} label={s} size="small" sx={{ height: 18, fontSize: 10, mb: 0.5 }} variant="outlined" />
                            ))}
                          </Stack>
                        </Box>
                      )}
                    </>
                  )}
                </Grid>
                <Grid item xs={12} md={3}>
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>RECOMMENDED ACTION</Typography>
                  <Typography variant="body2" sx={{ fontSize: 13, lineHeight: 1.5, mt: 0.5 }}>{research?.recommended_action ?? c.recommended_action}</Typography>
                </Grid>
                <Grid item xs={12}>
                  <ClassificationForm
                    customer={c}
                    classification={classifications.store[String(c.allmoxy_customer_id)]}
                    onSave={(reasons, notes) => classifications.set(c.allmoxy_customer_id, { reasons, notes })}
                    onClear={() => classifications.clear(c.allmoxy_customer_id)}
                  />
                </Grid>
              </Grid>
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}

// ============================================================================
// ClassificationForm — inline per-card form to record the user's churn-reason
// classification. Multi-select chips for canonical reasons + free-text notes +
// Save / Clear. Stamps the user's name (from the toolbar field) and a timestamp.
// Persists to localStorage via useChurnClassifications.
// ============================================================================
function ClassificationForm({
  customer, classification, onSave, onClear,
}: {
  customer: InferenceCustomer;
  classification: Classification | undefined;
  onSave: (reasons: ChurnReason[], notes: string) => void;
  onClear: () => void;
}) {
  const [selectedReasons, setSelectedReasons] = useState<ChurnReason[]>(classification?.reasons ?? []);
  const [notes, setNotes] = useState<string>(classification?.notes ?? '');
  const [open, setOpen] = useState<boolean>(false);

  // Reset local state if the persisted classification changes (e.g., after Clear)
  useEffect(() => {
    setSelectedReasons(classification?.reasons ?? []);
    setNotes(classification?.notes ?? '');
  }, [classification]);

  const dirty =
    JSON.stringify(selectedReasons) !== JSON.stringify(classification?.reasons ?? []) ||
    notes !== (classification?.notes ?? '');

  function toggleReason(r: ChurnReason) {
    setSelectedReasons((prev) => prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]);
  }
  function handleSave() {
    if (selectedReasons.length === 0) {
      alert('Pick at least one churn reason before saving.');
      return;
    }
    onSave(selectedReasons, notes.trim());
  }

  return (
    <Box sx={{ mt: 1, pt: 1.5, borderTop: '1px dashed rgba(139,148,158,0.3)' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: open || classification ? 1 : 0 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
          My classification
        </Typography>
        {classification && (
          <Chip
            icon={<CheckCircleIcon sx={{ fontSize: 14 }} />}
            label={classification.reasons.join(' + ')}
            size="small"
            sx={{ height: 20, fontSize: 11, bgcolor: 'rgba(26, 158, 92, 0.15)', color: 'success.main', fontWeight: 500 }}
          />
        )}
        {classification && (
          <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10, fontStyle: 'italic' }}>
            {classification.classified_by} · {new Date(classification.classified_at).toLocaleString()}
          </Typography>
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Button
          size="small"
          variant={open ? 'contained' : 'outlined'}
          onClick={() => setOpen(!open)}
          sx={{ textTransform: 'none', fontSize: 11, py: 0.25 }}
        >
          {open ? 'Hide' : classification ? 'Edit' : 'Classify'}
        </Button>
        {classification && !open && (
          <Button
            size="small"
            color="error"
            onClick={() => { if (confirm('Clear your classification for this customer?')) onClear(); }}
            sx={{ textTransform: 'none', fontSize: 11, py: 0.25 }}
          >
            Clear
          </Button>
        )}
      </Stack>

      {open && (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, mb: 0.5 }}>
            REASON (multi-select)
          </Typography>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            {CANONICAL_CHURN_REASONS.map((r) => {
              const active = selectedReasons.includes(r);
              return (
                <Chip
                  key={r}
                  label={r}
                  size="small"
                  variant={active ? 'filled' : 'outlined'}
                  onClick={() => toggleReason(r)}
                  sx={{
                    height: 24,
                    fontSize: 11,
                    cursor: 'pointer',
                    color: active ? '#fff' : 'text.primary',
                    bgcolor: active ? 'primary.main' : 'transparent',
                  }}
                />
              );
            })}
          </Stack>
          <TextField
            size="small"
            fullWidth
            multiline
            minRows={2}
            placeholder="Notes (optional) — anything you saw in HubSpot or remember about this customer that informs the reason."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            sx={{ mb: 1.5, '& textarea': { fontSize: 12 } }}
          />
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="contained"
              onClick={handleSave}
              disabled={!dirty || selectedReasons.length === 0}
              sx={{ textTransform: 'none' }}
            >
              Save classification
            </Button>
            {classification && (
              <Button
                size="small"
                color="error"
                variant="outlined"
                onClick={() => { if (confirm('Clear your classification for this customer?')) onClear(); }}
                sx={{ textTransform: 'none' }}
              >
                Clear
              </Button>
            )}
            <Box sx={{ flexGrow: 1 }} />
            {customer.hubspot_url && (
              <Link href={customer.hubspot_url} target="_blank" rel="noopener noreferrer" sx={{ fontSize: 11, alignSelf: 'center' }}>
                Open in HubSpot →
              </Link>
            )}
          </Stack>
        </Box>
      )}
    </Box>
  );
}
