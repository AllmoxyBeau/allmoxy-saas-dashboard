import { useCallback, useMemo, useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import PageHeader from '../components/common/PageHeader';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';
import { hubspotCompanyUrl } from '../lib/hubspot';
import segmentFramework from '../data/segment_framework.json';

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

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const STORAGE_KEY = 'allmoxy:subsegment-classifications:v1';
const NAME_KEY = 'allmoxy:subsegment-classifier-name';

function readStore(): Store {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
}
function writeStore(s: Store) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

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

function ClassificationForm({
  profile,
  existing,
  classifierName,
  onSave,
  onClear,
}: {
  profile: Profile;
  existing: Classification | null;
  classifierName: string;
  onSave: (c: Omit<Classification, 'customer_id' | 'classified_at'>) => void;
  onClear: () => void;
}) {
  const [primarySelected, setPrimarySelected] = useState(existing?.primary_segment ?? profile.primary_segment ?? '');
  const [subSelected, setSubSelected] = useState(existing?.sub_segment ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const subOptions: string[] = useMemo(() => {
    const grouped = (segmentFramework as { sub_segments_by_primary: Record<string, string[]> }).sub_segments_by_primary;
    return grouped[primarySelected] || [];
  }, [primarySelected]);

  const canSave = primarySelected && subSelected && classifierName;

  return (
    <Box sx={{ mt: 1, p: 1.5, bgcolor: 'rgba(0,0,0,0.02)', borderRadius: 1 }}>
      <Grid container spacing={1.5}>
        <Grid item xs={12} sm={4}>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'text.secondary', fontSize: 10 }}>PRIMARY SEGMENT</Typography>
          <Select
            value={primarySelected}
            onChange={(e) => { setPrimarySelected(e.target.value as string); setSubSelected(''); }}
            size="small"
            fullWidth
            displayEmpty
            sx={{ fontSize: 12 }}
          >
            <MenuItem value="" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>— select —</MenuItem>
            {(segmentFramework as { primary_segments: string[] }).primary_segments.map((p) => (
              <MenuItem key={p} value={p} sx={{ fontSize: 12 }}>{p}</MenuItem>
            ))}
          </Select>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'text.secondary', fontSize: 10 }}>SUB SEGMENT</Typography>
          <Select
            value={subSelected}
            onChange={(e) => setSubSelected(e.target.value as string)}
            size="small"
            fullWidth
            displayEmpty
            disabled={!primarySelected || subOptions.length === 0}
            sx={{ fontSize: 12 }}
          >
            <MenuItem value="" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
              {!primarySelected ? '— pick primary first —' : subOptions.length === 0 ? '— no sub-segments under this primary —' : '— select —'}
            </MenuItem>
            {subOptions.map((s) => (
              <MenuItem key={s} value={s} sx={{ fontSize: 12 }}>{s}</MenuItem>
            ))}
          </Select>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Typography variant="caption" sx={{ display: 'block', mb: 0.5, color: 'text.secondary', fontSize: 10 }}>NOTES / EVIDENCE (optional)</Typography>
          <TextField
            size="small"
            fullWidth
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. their website shows custom shop work"
            sx={{ '& input': { fontSize: 12 } }}
          />
        </Grid>
        <Grid item xs={12}>
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            {existing && (
              <Button size="small" variant="outlined" color="warning" onClick={onClear} sx={{ fontSize: 11 }}>
                Clear classification
              </Button>
            )}
            <Button
              size="small"
              variant="contained"
              disabled={!canSave}
              onClick={() => onSave({ primary_segment: primarySelected || null, sub_segment: subSelected, notes, classified_by: classifierName })}
              sx={{ fontSize: 11 }}
            >
              {existing ? 'Update classification' : 'Save classification'}
            </Button>
          </Stack>
        </Grid>
      </Grid>
    </Box>
  );
}

export default function SubSegmentBackfill() {
  const { data, isLoading, error } = useSheetTab('customer_profiles');
  const profiles: Profile[] = useMemo(() => {
    const rows = (data as unknown as { rows: Profile[] } | undefined)?.rows ?? [];
    return rows.filter((r) => !r.excluded_from_logo_count);
  }, [data]);

  const classifications = useSubSegmentClassifications();

  const [statusFilter, setStatusFilter] = useState<'active' | 'churned' | 'all'>('active');
  const [primaryFilter, setPrimaryFilter] = useState<string>('all');
  const [showAlreadyTagged, setShowAlreadyTagged] = useState(false);

  const isClassified = useCallback(
    (p: Profile) => !!classifications.store[String(p.allmoxy_customer_id)],
    [classifications.store]
  );

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
      total,
      withSub,
      withSubPct: total > 0 ? withSub / total : 0,
      userClassified,
      activeMissing: activeMissing.length,
      activeMissingClassified,
      activeMissingPct: activeMissing.length > 0 ? activeMissingClassified / activeMissing.length : 0,
    };
  }, [profiles, classifications.store, isClassified]);

  const classifiedRows = useMemo(() => {
    return Object.values(classifications.store).map((c) => {
      const p = profiles.find((pr) => pr.allmoxy_customer_id === c.customer_id);
      return {
        ...c,
        customer_name: p?.name ?? `#${c.customer_id}`,
        hubspot_company_id: p?.hubspot_company_id ?? '',
        status: p?.status ?? '',
        current_mrr: p?.current_subscription_mrr ?? 0,
      };
    });
  }, [classifications.store, profiles]);

  return (
    <Box>
      <PageHeader
        title="Sub-Segment Backfill"
        subtitle="QoE-8: Push every customer through to a canonical Primary + Sub Segment in HubSpot. Active customers without a sub-segment are the priority — buyers want a clean segmentation cut of the book."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load customer_profiles: {String(error)}</Alert>}

      {/* Coverage tracker */}
      <Paper sx={{ p: 2.5, mb: 3, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '4px solid', borderColor: 'primary.main' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10.5, fontWeight: 600 }}>
          QoE-8 · Sub-segment backfill progress
        </Typography>
        <Grid container spacing={2} sx={{ mt: 0.5 }}>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>TOTAL CUSTOMERS</Typography>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>{coverage.total.toLocaleString()}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Excludes deduped records (duplicate_of / sub-instance)</Typography>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>WITH SUB-SEGMENT</Typography>
            <Typography variant="h5" sx={{ fontWeight: 600, color: 'success.main' }}>
              {coverage.withSub.toLocaleString()} <Box component="span" sx={{ fontSize: 14, fontWeight: 400, color: 'text.secondary' }}>· {(coverage.withSubPct * 100).toFixed(0)}%</Box>
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>Source: HubSpot sub_segment_framework</Typography>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>ACTIVE MISSING</Typography>
            <Typography variant="h5" sx={{ fontWeight: 600, color: 'warning.main' }}>{coverage.activeMissing.toLocaleString()}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {coverage.activeMissingClassified} classified by you ({(coverage.activeMissingPct * 100).toFixed(0)}%)
            </Typography>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}>NEXT ACTION</Typography>
            <Typography variant="body2" sx={{ fontWeight: 500, mt: 0.5, fontSize: 13 }}>
              Work through active customers below. When done, export the CSV and bulk-update HubSpot's <code>sub_segment_framework</code> property.
            </Typography>
          </Grid>
        </Grid>
      </Paper>

      {/* Classifier name input */}
      {!classifications.classifierName && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <Typography variant="body2" sx={{ fontSize: 13 }}>
              Before you classify, enter your name (saved to localStorage so we can attribute each classification on the CSV export):
            </Typography>
            <TextField
              size="small"
              placeholder="Your name"
              value={classifications.classifierName}
              onChange={(e) => classifications.setClassifierName(e.target.value)}
              sx={{ minWidth: 200 }}
            />
          </Stack>
        </Alert>
      )}

      {/* Filters */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={statusFilter}
          onChange={(_, v) => v && setStatusFilter(v)}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="active">Active ({coverage.activeMissing})</ToggleButton>
          <ToggleButton value="churned">Churned</ToggleButton>
          <ToggleButton value="all">All</ToggleButton>
        </ToggleButtonGroup>

        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5 }}>
            Primary
          </Typography>
          <Chip
            label="All"
            size="small"
            variant={primaryFilter === 'all' ? 'filled' : 'outlined'}
            onClick={() => setPrimaryFilter('all')}
            sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
          />
          {[...primaryCounts.entries()].sort((a, b) => b[1] - a[1]).map(([primary, count]) => (
            <Chip
              key={primary}
              label={`${primary} (${count})`}
              size="small"
              variant={primaryFilter === primary ? 'filled' : 'outlined'}
              onClick={() => setPrimaryFilter(primaryFilter === primary ? 'all' : primary)}
              sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
            />
          ))}
        </Stack>

        <Box sx={{ flexGrow: 1 }} />

        <Button size="small" variant={showAlreadyTagged ? 'contained' : 'outlined'} onClick={() => setShowAlreadyTagged(!showAlreadyTagged)} sx={{ fontSize: 11 }}>
          {showAlreadyTagged ? 'Hide my classifications' : `Show my ${classifiedRows.length} classifications`}
        </Button>

        <CsvExportButton
          filename={`subsegment_backfill_classifications_${new Date().toISOString().slice(0, 10)}`}
          columns={[
            { key: 'customer_id', label: 'Allmoxy ID' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'hubspot_company_id', label: 'HubSpot Company ID' },
            { key: 'primary_segment', label: 'Primary Segment' },
            { key: 'sub_segment', label: 'Sub Segment (for HubSpot push)' },
            { key: 'status', label: 'Status' },
            { key: 'current_mrr', label: 'Current MRR' },
            { key: 'notes', label: 'Notes' },
            { key: 'classified_by', label: 'Classified by' },
            { key: 'classified_at', label: 'Classified at' },
          ]}
          rows={classifiedRows as unknown as Array<Record<string, unknown>>}
        />
      </Stack>

      {/* List */}
      {isLoading ? (
        <Skeleton variant="rectangular" height={400} />
      ) : (
        <Stack spacing={1.5}>
          {missing.length === 0 ? (
            <Paper sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
              {showAlreadyTagged && classifiedRows.length > 0
                ? 'All matching customers are already classified.'
                : statusFilter === 'active' ? 'No active customers missing sub-segment under the current filter.' : 'No customers match.'}
            </Paper>
          ) : (
            missing.map((p) => {
              const existing = classifications.store[String(p.allmoxy_customer_id)] || null;
              const userClassified = !!existing;
              return (
                <Paper key={p.allmoxy_customer_id} sx={{ p: 2, borderLeft: '3px solid', borderColor: userClassified ? 'success.main' : p.status === 'active' ? 'warning.main' : 'divider' }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1}>
                    <Box sx={{ flexGrow: 1, minWidth: 240 }}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          <CustomerLink id={p.allmoxy_customer_id} name={p.name} />
                        </Typography>
                        <Chip
                          label={p.status}
                          size="small"
                          color={p.status === 'active' ? 'success' : p.status === 'churned' ? 'error' : 'default'}
                          sx={{ height: 18, fontSize: 10, textTransform: 'capitalize' }}
                        />
                        {p.primary_segment ? (
                          <Chip label={p.primary_segment} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                        ) : (
                          <Chip label="no primary" size="small" color="warning" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                        )}
                        {userClassified && (
                          <Chip label={`✓ ${existing!.sub_segment}`} size="small" color="success" sx={{ height: 18, fontSize: 10 }} />
                        )}
                      </Stack>
                      <Stack direction="row" spacing={2} sx={{ mt: 0.5 }} flexWrap="wrap">
                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                          Lifetime {USD0.format(p.lifetime_subscription)} · MRR {USD0.format(p.current_subscription_mrr)}
                          {p.years_with_us ? ` · ${p.years_with_us.toFixed(1)} yrs` : ''}
                          {p.sign_up_date ? ` · signed up ${p.sign_up_date}` : ''}
                        </Typography>
                        {hubspotCompanyUrl(p.hubspot_company_id) && (
                          <a href={hubspotCompanyUrl(p.hubspot_company_id) ?? '#'} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#2C73FF' }}>
                            Open in HubSpot ↗
                          </a>
                        )}
                      </Stack>
                    </Box>
                  </Stack>
                  <Divider sx={{ my: 1.5 }} />
                  <ClassificationForm
                    profile={p}
                    existing={existing}
                    classifierName={classifications.classifierName}
                    onSave={(c) => classifications.save(p.allmoxy_customer_id, c)}
                    onClear={() => classifications.remove(p.allmoxy_customer_id)}
                  />
                </Paper>
              );
            })
          )}
        </Stack>
      )}

      <Box sx={{ mt: 3, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Pushing to HubSpot
        </Typography>
        <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>
          When you've worked through the active list, click <strong>Show my classifications</strong> above (or just the CSV button) to export. The CSV format is shaped for HubSpot's bulk import — column headers match HubSpot Company properties (<code>hs_object_id</code> alias = the HubSpot Company ID column, <code>sub_segment_framework</code> = sub-segment column). Settings → Imports → Start an import → Companies. The <code>notes</code> column is for your own reference — drop or keep as needed.
          <br /><br />
          Canonical framework: <strong>{(segmentFramework as { primary_segments: string[] }).primary_segments.length} primary segments</strong> ×{' '}
          <strong>{Object.values((segmentFramework as { sub_segments_by_primary: Record<string, string[]> }).sub_segments_by_primary).flat().length} sub segments</strong>, sourced from HubSpot. See <code>src/data/segment_framework.json</code> to edit the editorial grouping.
        </Typography>
      </Box>
    </Box>
  );
}
