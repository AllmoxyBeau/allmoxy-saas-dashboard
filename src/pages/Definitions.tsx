import { useMemo, useState } from 'react';
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
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';

import PageHeader from '../components/common/PageHeader';
import { useSheetTab } from '../hooks/useSheetTab';

type Metric = {
  id: string;
  name: string;
  category: string;
  definition: string;
  formula: string;
  source_files: string[];
  source_lineage: string;
  window: string;
  adjustments: string[];
  displayed_on: string[];
  verified_by: string | null;
  verified_at: string | null;
};

type Category = {
  key: string;
  label: string;
  description: string;
};

type DefinitionsSnapshot = {
  comment: string;
  updated_at: string;
  fetched_at?: string;
  verified_by: string;
  categories: Category[];
  metrics: Metric[];
};

const CATEGORY_COLOR: Record<string, string> = {
  revenue: '#2C73FF',
  customer_state: '#9F7AEA',
  churn: '#D63A4D',
  retention: '#1A9E5C',
  unit_economics: '#F5A623',
  pnl_ebitda: '#635bff',
  adjustments: '#E67E22',
};

export default function Definitions() {
  const { data, isLoading, error } = useSheetTab('metric_definitions');
  const snap = data as unknown as DefinitionsSnapshot | undefined;

  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    if (!snap) return [];
    const q = query.trim().toLowerCase();
    let rows = snap.metrics;
    if (categoryFilter !== 'all') rows = rows.filter((m) => m.category === categoryFilter);
    if (q) {
      rows = rows.filter((m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.definition.toLowerCase().includes(q) ||
        m.formula.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [snap, query, categoryFilter]);

  const categoryCounts = useMemo(() => {
    if (!snap) return new Map<string, number>();
    const m = new Map<string, number>();
    for (const metric of snap.metrics) m.set(metric.category, (m.get(metric.category) ?? 0) + 1);
    return m;
  }, [snap]);

  return (
    <Box>
      <PageHeader
        title="Definitions"
        subtitle="Canonical definitions for every metric on the dashboard. The first document a banker / buyer / QoE reviewer should read — every other artifact flows from these definitions."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load metric_definitions: {String(error)}</Alert>}

      {snap && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>{snap.metrics.length} metric definitions</strong> across <strong>{snap.categories.length}</strong> categories.
          Sign-off: {snap.verified_by}. Last updated: {snap.updated_at}.
        </Alert>
      )}

      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 3 }} flexWrap="wrap" gap={1}>
        <TextField
          size="small"
          placeholder="Search definitions, formulas…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 18 }} />
              </InputAdornment>
            ),
          }}
          sx={{ minWidth: 300 }}
        />
        <Chip
          label={`All (${snap?.metrics.length ?? 0})`}
          size="small"
          variant={categoryFilter === 'all' ? 'filled' : 'outlined'}
          onClick={() => setCategoryFilter('all')}
          sx={{ height: 24, fontSize: 11, cursor: 'pointer' }}
        />
        {snap?.categories.map((c) => {
          const isActive = categoryFilter === c.key;
          const color = CATEGORY_COLOR[c.key] ?? '#94a3b8';
          return (
            <Chip
              key={c.key}
              label={`${c.label} (${categoryCounts.get(c.key) ?? 0})`}
              size="small"
              variant={isActive ? 'filled' : 'outlined'}
              onClick={() => setCategoryFilter(isActive ? 'all' : c.key)}
              sx={{ height: 24, fontSize: 11, cursor: 'pointer', color: isActive ? '#fff' : color, borderColor: color, bgcolor: isActive ? color : 'transparent' }}
            />
          );
        })}
      </Stack>

      {/* Category descriptions */}
      {categoryFilter !== 'all' && (
        <Paper sx={{ p: 2, mb: 3, bgcolor: 'rgba(0,0,0,0.02)' }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }}>
            About this category
          </Typography>
          <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5 }}>
            {snap?.categories.find((c) => c.key === categoryFilter)?.description}
          </Typography>
        </Paper>
      )}

      {isLoading ? (
        <Skeleton variant="rectangular" height={400} />
      ) : (
        <Grid container spacing={2}>
          {filtered.map((m) => {
            const color = CATEGORY_COLOR[m.category] ?? '#94a3b8';
            const categoryLabel = snap?.categories.find((c) => c.key === m.category)?.label ?? m.category;
            return (
              <Grid item xs={12} key={m.id}>
                <Paper sx={{ p: 3, borderLeft: '3px solid', borderColor: color }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={1} sx={{ mb: 1.5 }}>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Typography variant="h6" sx={{ fontWeight: 600 }}>{m.name}</Typography>
                        <Chip label={categoryLabel} size="small" sx={{ height: 20, fontSize: 10, color, borderColor: color, bgcolor: 'transparent' }} variant="outlined" />
                        <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', fontSize: 10 }}>
                          {m.id}
                        </Typography>
                      </Stack>
                      <Typography variant="body2" sx={{ fontSize: 13.5, mt: 1, lineHeight: 1.6 }}>
                        {m.definition}
                      </Typography>
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      {m.verified_by && (
                        <Chip
                          label={`Verified ${m.verified_by}${m.verified_at ? ` · ${m.verified_at}` : ''}`}
                          size="small"
                          variant="outlined"
                          color="success"
                          sx={{ height: 20, fontSize: 10 }}
                        />
                      )}
                    </Box>
                  </Stack>

                  <Divider sx={{ my: 1.5 }} />

                  <Grid container spacing={2}>
                    <Grid item xs={12} md={6}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, display: 'block' }}>Formula</Typography>
                      <Typography variant="body2" sx={{ fontSize: 12.5, lineHeight: 1.55, mt: 0.5, fontFamily: 'inherit' }}>
                        {m.formula}
                      </Typography>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, display: 'block' }}>Source files</Typography>
                      <Box sx={{ mt: 0.5 }}>
                        {m.source_files.map((sf) => (
                          <Chip key={sf} label={sf.replace('public/snapshots/', '').replace('_etl_scripts/', '').replace('src/data/', '')} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, fontFamily: 'monospace', mr: 0.5, mb: 0.5 }} />
                        ))}
                      </Box>
                      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1, fontSize: 11, lineHeight: 1.5 }}>
                        {m.source_lineage}
                      </Typography>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, display: 'block' }}>Window</Typography>
                      <Typography variant="body2" sx={{ fontSize: 12.5, mt: 0.5 }}>{m.window}</Typography>
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, display: 'block' }}>Displayed on</Typography>
                      <Box sx={{ mt: 0.5 }}>
                        {m.displayed_on.map((page) => (
                          <Chip key={page} label={page} size="small" variant="outlined" sx={{ height: 18, fontSize: 10, fontFamily: 'monospace', mr: 0.5, mb: 0.5 }} />
                        ))}
                      </Box>
                    </Grid>
                    <Grid item xs={12}>
                      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10, display: 'block' }}>Adjustments applied</Typography>
                      {m.adjustments.length === 0 ? (
                        <Typography variant="body2" sx={{ fontSize: 12, color: 'text.secondary', fontStyle: 'italic', mt: 0.5 }}>None — straight from source.</Typography>
                      ) : (
                        <Stack component="ul" sx={{ pl: 2, m: 0, mt: 0.5 }} spacing={0.5}>
                          {m.adjustments.map((a, i) => (
                            <Typography key={i} component="li" variant="body2" sx={{ fontSize: 12, lineHeight: 1.5 }}>{a}</Typography>
                          ))}
                        </Stack>
                      )}
                    </Grid>
                  </Grid>
                </Paper>
              </Grid>
            );
          })}
          {filtered.length === 0 && !isLoading && (
            <Grid item xs={12}>
              <Paper sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
                No definitions match your search.
              </Paper>
            </Grid>
          )}
        </Grid>
      )}

      <Box sx={{ mt: 3, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Adding or editing a definition
        </Typography>
        <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>
          Definitions live in <code>_etl_scripts/metric_definitions.json</code>. Each metric needs: <strong>definition</strong> (plain English), <strong>formula</strong> (exact computation), <strong>source_files</strong>, <strong>source_lineage</strong> (where the raw data comes from), <strong>window</strong> (point-in-time / YTD / TTM / rolling), <strong>adjustments</strong> (list of every override applied), <strong>displayed_on</strong> (dashboard routes), and <strong>verified_by/verified_at</strong> (owner sign-off). Re-run <code>node _etl_scripts/refresh_all.mjs</code> to publish.
        </Typography>
      </Box>
    </Box>
  );
}
