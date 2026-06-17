import { useMemo, useState } from 'react';
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

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import { useSheetTab } from '../hooks/useSheetTab';

type TestResult = {
  name: string;
  severity: 'error' | 'warn' | 'info';
  passed: boolean;
  detail: string;
  examples: string[];
};

type Snapshot = {
  fetched_at: string;
  total: number;
  passed: number;
  errors: number;
  warnings: number;
  status: 'green' | 'yellow' | 'red';
  comment: string;
  results: TestResult[];
};

const STATUS_COLOR: Record<Snapshot['status'], string> = {
  green: '#1A9E5C',
  yellow: '#F5A623',
  red: '#D63A4D',
};

const STATUS_LABEL: Record<Snapshot['status'], string> = {
  green: 'All invariants pass',
  yellow: 'Soft warnings outstanding',
  red: 'Hard QoE-blocking failures',
};

export default function InvariantTests() {
  const { data, isLoading, error } = useSheetTab('invariant_test_results');
  const snap = data as unknown as Snapshot | undefined;

  const [filter, setFilter] = useState<'all' | 'failed' | 'errors' | 'warnings' | 'passed'>('failed');

  const filtered = useMemo(() => {
    const rows = snap?.results ?? [];
    if (filter === 'all') return rows;
    if (filter === 'failed') return rows.filter((r) => !r.passed);
    if (filter === 'errors') return rows.filter((r) => !r.passed && r.severity === 'error');
    if (filter === 'warnings') return rows.filter((r) => !r.passed && r.severity === 'warn');
    if (filter === 'passed') return rows.filter((r) => r.passed);
    return rows;
  }, [snap, filter]);

  return (
    <Box>
      <PageHeader
        title="Invariant Tests"
        subtitle="Automated self-consistency checks across all snapshots, run as the final step of refresh_all. Errors block QoE handoff; warnings are punch-list items worth resolving before banker review."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load invariant_test_results: {String(error)}</Alert>}

      {snap && (
        <Alert
          severity={snap.status === 'red' ? 'error' : snap.status === 'yellow' ? 'warning' : 'success'}
          sx={{ mb: 3 }}
          icon={<Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: STATUS_COLOR[snap.status], display: 'inline-block', mr: 1 }} />}
        >
          <strong>{STATUS_LABEL[snap.status]}</strong> · {snap.passed}/{snap.total} passed · {snap.errors} error(s) · {snap.warnings} warning(s).
          Last run: {new Date(snap.fetched_at).toLocaleString()}.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Tests run</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : <Typography variant="h4" sx={{ fontWeight: 500 }}>{snap?.total ?? 0}</Typography>}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Passed</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : <Typography variant="h4" sx={{ fontWeight: 500, color: 'success.main' }}>{snap?.passed ?? 0}</Typography>}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Errors (blocking)</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : <Typography variant="h4" sx={{ fontWeight: 500, color: (snap?.errors ?? 0) > 0 ? 'error.main' : 'text.primary' }}>{snap?.errors ?? 0}</Typography>}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Warnings (punch list)</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : <Typography variant="h4" sx={{ fontWeight: 500, color: (snap?.warnings ?? 0) > 0 ? 'warning.main' : 'text.primary' }}>{snap?.warnings ?? 0}</Typography>}
          </Paper>
        </Grid>
      </Grid>

      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filter}
          onChange={(_, v) => v && setFilter(v)}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="all">All ({snap?.results?.length ?? 0})</ToggleButton>
          <ToggleButton value="failed">Failed ({(snap?.errors ?? 0) + (snap?.warnings ?? 0)})</ToggleButton>
          <ToggleButton value="errors">Errors ({snap?.errors ?? 0})</ToggleButton>
          <ToggleButton value="warnings">Warnings ({snap?.warnings ?? 0})</ToggleButton>
          <ToggleButton value="passed">Passed ({snap?.passed ?? 0})</ToggleButton>
        </ToggleButtonGroup>
        <InfoIcon info={
          <>
            <strong>Error</strong> severity: hard inconsistencies that must be resolved before any banker handoff. The refresh script exits non-zero so CI/hooks can detect them.
            <br /><br />
            <strong>Warning</strong> severity: punch-list items — known/expected drift (transaction reclassifications, placeholder EBITDA add-backs, missing contract links). These don't block, but should be resolved or explicitly explained before diligence.
          </>
        } />
      </Stack>

      {isLoading ? (
        <Skeleton variant="rectangular" height={300} />
      ) : (
        <Stack spacing={1.5}>
          {filtered.length === 0 ? (
            <Paper sx={{ p: 3, textAlign: 'center', color: 'text.secondary' }}>
              {filter === 'failed' ? 'No failed tests — green run.' : 'No tests match the current filter.'}
            </Paper>
          ) : (
            filtered.map((r) => (
              <Paper key={r.name} sx={{ p: 2, borderLeft: '3px solid', borderColor: r.passed ? 'success.main' : r.severity === 'error' ? 'error.main' : 'warning.main' }}>
                <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: r.examples.length > 0 ? 1 : 0 }}>
                  <Chip
                    label={r.passed ? '✓ pass' : r.severity}
                    size="small"
                    color={r.passed ? 'success' : r.severity === 'error' ? 'error' : 'warning'}
                    sx={{ height: 20, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}
                  />
                  <Typography variant="body2" sx={{ fontSize: 13, fontWeight: 500, flexGrow: 1 }}>{r.name}</Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11 }}>{r.detail}</Typography>
                </Stack>
                {!r.passed && r.examples.length > 0 && (
                  <Box sx={{ mt: 1, pl: 1, borderLeft: '1px solid', borderColor: 'divider' }}>
                    {r.examples.slice(0, 10).map((ex, i) => (
                      <Typography key={i} variant="caption" sx={{ display: 'block', fontFamily: 'monospace', fontSize: 11, color: 'text.secondary', lineHeight: 1.6 }}>
                        · {ex}
                      </Typography>
                    ))}
                  </Box>
                )}
              </Paper>
            ))
          )}
        </Stack>
      )}

      <Box sx={{ mt: 3, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Adding new invariants
        </Typography>
        <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>
          Tests live in <code>_etl_scripts/run_invariant_tests.mjs</code>. Each test is a single function returning <code>{`{ passed, detail, examples }`}</code>. Add a new <code>test('name', 'error|warn', fn)</code> call and re-run. Tests run automatically as the final step of <code>refresh_all.mjs</code>; the script exits non-zero if any error-severity test fails so CI hooks can catch it.
        </Typography>
      </Box>
    </Box>
  );
}
