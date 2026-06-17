import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Alert from '@mui/material/Alert';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type Adjustment = {
  id: string;
  category:
    | 'annual_payer_flag'
    | 'amortization'
    | 'variance'
    | 'reclassification'
    | 'hygiene_stripe_id'
    | 'hygiene_connect_mapping'
    | 'synthetic_transaction'
    | 'status_override'
    | 'never_paid_classification';
  severity: 'monetary' | 'hygiene';
  customer_name: string | null;
  customer_id: number | null;
  period: string | null;
  txn_date: string | null;
  before: number | null;
  after: number | null;
  delta: number | null;
  reason: string;
  evidence: string | null;
  source_file: string;
  added_by: string | null;
};

type RegisterSnapshot = {
  fetched_at: string;
  comment: string;
  totals: {
    total: number;
    by_category: Record<string, number>;
    by_severity: Record<string, number>;
  };
  adjustments: Adjustment[];
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const CATEGORY_LABEL: Record<Adjustment['category'], string> = {
  annual_payer_flag: 'Annual payer flag',
  amortization: 'Amortization',
  variance: 'Variance carry-forward',
  reclassification: 'Stream reclassification',
  hygiene_stripe_id: 'Stripe ID hygiene',
  hygiene_connect_mapping: 'Connect mapping hygiene',
  synthetic_transaction: 'Off-Stripe payment',
  status_override: 'Status override',
  never_paid_classification: 'Never-paid auto-classify',
};

const CATEGORY_COLOR: Record<Adjustment['category'], string> = {
  annual_payer_flag: '#2C73FF',
  amortization: '#9F7AEA',
  variance: '#F5A623',
  reclassification: '#1A9E5C',
  hygiene_stripe_id: '#8B949E',
  hygiene_connect_mapping: '#8B949E',
  synthetic_transaction: '#E67E22',
  status_override: '#D946A0',
  never_paid_classification: '#8B949E',
};

export default function AdjustmentsRegister() {
  const { data, isLoading, error } = useSheetTab('adjustments_register');
  const snap = data as unknown as RegisterSnapshot | undefined;

  const [filterSeverity, setFilterSeverity] = useState<'all' | 'monetary' | 'hygiene'>('all');
  const [filterCategory, setFilterCategory] = useState<string>('all');

  const rows = snap?.adjustments ?? [];

  const filtered = useMemo(() => {
    let out = rows;
    if (filterSeverity !== 'all') out = out.filter((r) => r.severity === filterSeverity);
    if (filterCategory !== 'all') out = out.filter((r) => r.category === filterCategory);
    return out;
  }, [rows, filterSeverity, filterCategory]);

  // Aggregate dollar impact of monetary adjustments (sum of absolute deltas)
  const stats = useMemo(() => {
    const monetary = rows.filter((r) => r.severity === 'monetary');
    let absDelta = 0;
    let nWithDelta = 0;
    let nCustomers = new Set<string>();
    for (const r of monetary) {
      if (typeof r.delta === 'number') {
        absDelta += Math.abs(r.delta);
        nWithDelta++;
      }
      if (r.customer_name) nCustomers.add(r.customer_name);
    }
    return {
      total: rows.length,
      monetary: monetary.length,
      hygiene: rows.length - monetary.length,
      absDelta,
      nWithDelta,
      nCustomers: nCustomers.size,
    };
  }, [rows]);

  const distinctCategories = useMemo(() => {
    const set = new Set(rows.map((r) => r.category));
    return [...set];
  }, [rows]);

  return (
    <Box>
      <PageHeader
        title="Adjustments Register"
        subtitle="Every override / adjustment made to raw source data, consolidated from the underlying config files. A QoE reviewer should be able to answer 'give me every adjustment you made to the raw data' from this page alone."
        question="durable"
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load adjustments_register: {String(error)}</Alert>}

      {snap && (
        <Alert severity="info" sx={{ mb: 3 }}>
          <strong>{stats.total} adjustments</strong> consolidated from 6 source config files
          (<code>annual_payers.json</code>, <code>annual_amortization_overrides.json</code>,
          {' '}<code>variance_overrides.json</code>, <code>transaction_overrides.json</code>,
          {' '}<code>stripe_id_overrides.json</code>, <code>connect_customer_overrides.json</code>).
          {' '}<strong>{stats.monetary}</strong> have a dollar impact; <strong>{stats.hygiene}</strong> are
          data-hygiene only (no dollar impact but they affect customer/transaction attribution).
          Last refreshed: {new Date(snap.fetched_at).toLocaleString()}.
        </Alert>
      )}

      {/* Headline KPIs */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Total adjustments</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500 }}>{stats.total}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>{stats.nCustomers} distinct customers affected</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Monetary adjustments</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'primary.main' }}>{stats.monetary}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Move dollars between periods or streams</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Total absolute $ shift</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500 }}>{USD0.format(stats.absDelta)}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Sum of |delta| across {stats.nWithDelta} quantified adjustments</Typography>
              </>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <Paper sx={{ p: 2.5 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Hygiene adjustments</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 32 }} /> : (
              <>
                <Typography variant="h4" sx={{ fontWeight: 500, color: 'text.secondary' }}>{stats.hygiene}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>Attribution fixes — no $ impact</Typography>
              </>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Filters */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={filterSeverity}
          onChange={(_, v) => v && setFilterSeverity(v)}
          sx={{ '& .MuiToggleButton-root': { px: 1.5, py: 0.25, fontSize: 11, textTransform: 'none' } }}
        >
          <ToggleButton value="all">All ({rows.length})</ToggleButton>
          <ToggleButton value="monetary">Monetary ({stats.monetary})</ToggleButton>
          <ToggleButton value="hygiene">Hygiene ({stats.hygiene})</ToggleButton>
        </ToggleButtonGroup>

        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5 }}>
            Category
          </Typography>
          <Chip
            label="All"
            size="small"
            variant={filterCategory === 'all' ? 'filled' : 'outlined'}
            onClick={() => setFilterCategory('all')}
            sx={{ height: 22, fontSize: 11, cursor: 'pointer' }}
          />
          {distinctCategories.map((c) => {
            const isActive = filterCategory === c;
            const color = CATEGORY_COLOR[c as Adjustment['category']];
            return (
              <Chip
                key={c}
                label={CATEGORY_LABEL[c as Adjustment['category']]}
                size="small"
                variant={isActive ? 'filled' : 'outlined'}
                onClick={() => setFilterCategory(isActive ? 'all' : c)}
                sx={{ height: 22, fontSize: 11, cursor: 'pointer', color: isActive ? '#fff' : color, borderColor: color, bgcolor: isActive ? color : 'transparent' }}
              />
            );
          })}
        </Stack>

        <Box sx={{ flexGrow: 1 }} />

        <CsvExportButton
          filename={`adjustments_register${filterSeverity !== 'all' ? `_${filterSeverity}` : ''}${filterCategory !== 'all' ? `_${filterCategory}` : ''}`}
          columns={[
            { key: 'id', label: 'ID' },
            { key: 'category', label: 'Category' },
            { key: 'severity', label: 'Severity' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'customer_id', label: 'Allmoxy ID' },
            { key: 'period', label: 'Period' },
            { key: 'txn_date', label: 'Transaction date' },
            { key: 'before', label: 'Before $', getValue: (r) => (r.before == null ? '' : r.before) },
            { key: 'after', label: 'After $', getValue: (r) => (r.after == null ? '' : r.after) },
            { key: 'delta', label: 'Delta $', getValue: (r) => (r.delta == null ? '' : r.delta) },
            { key: 'reason', label: 'Reason' },
            { key: 'source_file', label: 'Source file' },
            { key: 'added_by', label: 'Added / updated' },
          ]}
          rows={filtered as unknown as Array<Record<string, unknown>>}
        />
      </Stack>

      {/* Register table */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
            {filtered.length} {filtered.length === 1 ? 'adjustment' : 'adjustments'}
          </Typography>
          <InfoIcon info={
            <>
              <strong>What it is:</strong> Every adjustment made to raw source data, consolidated from 6 underlying config files into one auditable register.
              <br /><br />
              <strong>How to read:</strong> "Monetary" rows move dollars between periods or streams (annual amortization, variance carry-forwards, stream reclassifications). "Hygiene" rows fix attribution (which Stripe ID belongs to which customer, etc.) without changing dollar totals.
              <br /><br />
              <strong>Source file</strong> on each row points to the underlying config file in the repo. Open that file to see the raw entry and any change history.
            </>
          } />
        </Stack>

        {isLoading ? (
          <Skeleton variant="rectangular" height={400} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Category</TableCell>
                <TableCell>Customer</TableCell>
                <TableCell>Period</TableCell>
                <TableCell align="right">Before $</TableCell>
                <TableCell align="right">After $</TableCell>
                <TableCell align="right">Δ $</TableCell>
                <TableCell>Reason</TableCell>
                <TableCell>Source file</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} sx={{ color: 'text.secondary', textAlign: 'center', py: 3 }}>
                    No adjustments match the current filters.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.id} hover>
                    <TableCell>
                      <Chip
                        label={CATEGORY_LABEL[r.category]}
                        size="small"
                        variant="outlined"
                        sx={{ height: 20, fontSize: 11, color: CATEGORY_COLOR[r.category], borderColor: CATEGORY_COLOR[r.category] }}
                      />
                    </TableCell>
                    <TableCell sx={{ fontWeight: 500 }}>
                      {r.customer_name ? (
                        r.customer_id != null ? <CustomerLink id={r.customer_id} name={r.customer_name} /> : r.customer_name
                      ) : (
                        <Typography variant="caption" sx={{ color: 'text.secondary', fontStyle: 'italic' }}>
                          (global)
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>{r.period ?? r.txn_date ?? '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.before != null ? USD0.format(r.before) : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{r.after != null ? USD0.format(r.after) : '—'}</TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 600,
                        color: r.delta == null ? 'text.secondary' : r.delta < 0 ? 'error.main' : r.delta > 0 ? 'success.main' : 'text.secondary',
                      }}
                    >
                      {r.delta == null ? '—' : (r.delta > 0 ? '+' : '') + USD0.format(r.delta)}
                    </TableCell>
                    <TableCell sx={{ fontSize: 12, maxWidth: 480 }}>{r.reason}</TableCell>
                    <TableCell sx={{ fontSize: 11, color: 'text.secondary', fontFamily: 'monospace' }}>
                      {r.source_file.replace('_etl_scripts/', '').replace('src/data/', '')}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}

        <Box sx={{ mt: 2, p: 2, bgcolor: 'rgba(44, 115, 255, 0.04)', borderLeft: '3px solid', borderColor: 'primary.main' }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Adding or editing an adjustment
          </Typography>
          <Typography variant="body2" sx={{ fontSize: 13, mt: 0.5, lineHeight: 1.6 }}>
            All adjustments live in their underlying source-file JSONs (see the rightmost column).
            Edit there, then re-run <code>node _etl_scripts/refresh_all.mjs</code> (or just{' '}
            <code>node _etl_scripts/build_adjustments_register.mjs</code> if you only changed override
            files). Every entry should carry a <strong>reason</strong>, and for QoE-grade documentation,
            an <strong>evidence link</strong> to the supporting contract / invoice / customer email /
            HubSpot note. The <code>evidence</code> column is currently null across the register — that's
            the next pass.
          </Typography>
        </Box>
      </Paper>
    </Box>
  );
}
