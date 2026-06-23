import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Skeleton from '@mui/material/Skeleton';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Button from '@mui/material/Button';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CustomerLink from '../components/common/CustomerLink';
import { useSheetTab } from '../hooks/useSheetTab';

type Severity = 'low' | 'medium' | 'high';

type Issue = {
  category: string;
  category_label: string;
  severity: Severity;
  action: string;
  // Optional fields depending on category
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

type Snapshot = {
  fetchedAt: string;
  aggregates: Aggregates;
  issues: Issue[];
};

const SEVERITY_COLOR: Record<Severity, string> = {
  high: '#D63A4D',
  medium: '#F5A623',
  low: '#8B949E',
};

// Stable per-issue key — MUST match issueKey() in build_data_cleanup.mjs so an
// accepted resolution suppresses the right issue on rebuild.
function issueKey(i: Issue): string {
  if (i.category === 'hubspot_instance_missing_aid') return `${i.category}:${i.instance_id}`;
  if (i.category === 'connect_mapping_orphan') return `${i.category}:${i.connect_name}`;
  return `${i.category}:${i.allmoxy_customer_id}`; // pay_status_drift, company_id_ghost
}

// Accepted suggestions live in the browser until applied to
// _etl_scripts/data_cleanup_resolutions.json (same stage→Claude-applies pattern
// as the annual-payer / schedule edits).
const ACCEPTED_KEY = 'allmoxy.data_cleanup.accepted';
type Accepted = Record<string, { decision: string; value: string | number | null; label: string }>;
function readAccepted(): Accepted {
  try { const raw = localStorage.getItem(ACCEPTED_KEY); return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

export default function DataCleanup() {
  const { data, isLoading, error } = useSheetTab<Snapshot>('data_cleanup');
  const snap = data as Snapshot | undefined;
  const [severityFilter, setSeverityFilter] = useState<Severity[]>([]);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Accepted>(() => readAccepted());

  useEffect(() => { try { localStorage.setItem(ACCEPTED_KEY, JSON.stringify(accepted)); } catch { /* ignore */ } }, [accepted]);

  function acceptIssue(i: Issue, decision: string, value: string | number | null, label: string) {
    setAccepted((prev) => ({ ...prev, [issueKey(i)]: { decision, value, label } }));
  }

  // Accepted issues drop out of the list immediately (optimistic); they become
  // durable for everyone once the resolutions file is applied + rebuilt.
  const issuesByCategory = useMemo(() => {
    const m = new Map<string, Issue[]>();
    for (const it of snap?.issues ?? []) {
      if (accepted[issueKey(it)]) continue;
      if (severityFilter.length > 0 && !severityFilter.includes(it.severity)) continue;
      if (!m.has(it.category)) m.set(it.category, []);
      m.get(it.category)!.push(it);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [snap, severityFilter, accepted]);

  const acceptedEntries = Object.entries(accepted);

  function copyResolutionsJson() {
    const resolved: Record<string, { decision: string; value: string | number | null }> = {};
    for (const [k, v] of acceptedEntries) resolved[k] = { decision: v.decision, value: v.value };
    navigator.clipboard?.writeText(JSON.stringify({ resolved }, null, 2)).then(() => {}, () => {});
  }

  function toggleSeverity(s: Severity) {
    setSeverityFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  const csvColumns = useMemo(() => ([
    { key: 'category', label: 'Category', getValue: (i: Issue) => i.category_label },
    { key: 'severity', label: 'Severity', getValue: (i: Issue) => i.severity },
    { key: 'customer', label: 'Customer', getValue: (i: Issue) => i.customer_name ?? i.account_name ?? '' },
    { key: 'aid', label: 'Allmoxy ID', getValue: (i: Issue) => i.allmoxy_customer_id ?? i.suggested_aid ?? '' },
    { key: 'instance_id', label: 'HubSpot Instance ID', getValue: (i: Issue) => i.instance_id ?? '' },
    { key: 'installer_id', label: 'Installer ID', getValue: (i: Issue) => i.installer_id ?? '' },
    { key: 'hubspot_company_id', label: 'HubSpot Company ID', getValue: (i: Issue) => i.hubspot_company_id ?? '' },
    { key: 'pay_status', label: 'Pay Status', getValue: (i: Issue) => i.pay_status ?? i.hubspot_pay_status ?? '' },
    { key: 'action', label: 'Action', getValue: (i: Issue) => i.action },
  ]), []);

  return (
    <Box>
      <PageHeader
        title="Data Cleanup"
        subtitle="Every detectable data-hygiene issue across HubSpot, the xlsx Sync Sheet, and Stripe Connect mapping. Chip away at these to improve every downstream join."
      />

      {error && <Alert severity="error" sx={{ mb: 2 }}>Failed to load data_cleanup: {String(error)}</Alert>}

      {/* KPI tiles */}
      <Grid container spacing={2} sx={{ mb: 2 }} alignItems="stretch">
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Total issues</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <Typography variant="h5" sx={{ fontWeight: 500 }}>{snap?.aggregates.total_issues ?? '—'}</Typography>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: SEVERITY_COLOR.high }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>High severity</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <Typography variant="h5" sx={{ fontWeight: 500, color: SEVERITY_COLOR.high }}>{snap?.aggregates.by_severity.high ?? 0}</Typography>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: SEVERITY_COLOR.medium }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Medium severity</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <Typography variant="h5" sx={{ fontWeight: 500, color: SEVERITY_COLOR.medium }}>{snap?.aggregates.by_severity.medium ?? 0}</Typography>
            )}
          </Paper>
        </Grid>
        <Grid item xs={12} sm={6} md={3} sx={{ display: 'flex' }}>
          <Paper sx={{ p: 2, flexGrow: 1, borderLeft: '3px solid', borderColor: SEVERITY_COLOR.low }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>Low severity</Typography>
            {isLoading ? <Skeleton variant="text" sx={{ fontSize: 28 }} /> : (
              <Typography variant="h5" sx={{ fontWeight: 500, color: SEVERITY_COLOR.low }}>{snap?.aggregates.by_severity.low ?? 0}</Typography>
            )}
          </Paper>
        </Grid>
      </Grid>

      {/* Severity filter + export */}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.06em', mr: 0.5 }}>Severity</Typography>
        {(['high', 'medium', 'low'] as Severity[]).map((s) => {
          const active = severityFilter.includes(s);
          return (
            <Chip
              key={s}
              label={s}
              size="small"
              variant={active ? 'filled' : 'outlined'}
              onClick={() => toggleSeverity(s)}
              sx={{ cursor: 'pointer', textTransform: 'capitalize', bgcolor: active ? SEVERITY_COLOR[s] + '22' : undefined, color: active ? SEVERITY_COLOR[s] : undefined, borderColor: active ? SEVERITY_COLOR[s] : undefined }}
            />
          );
        })}
        {severityFilter.length > 0 && (
          <Chip label="clear" size="small" variant="outlined" onClick={() => setSeverityFilter([])} sx={{ color: 'text.secondary' }} />
        )}
        <Box sx={{ flexGrow: 1 }} />
        <CsvExportButton filename={`data_cleanup_${new Date().toISOString().slice(0, 10)}`} rows={snap?.issues ?? []} columns={csvColumns} />
      </Stack>

      {/* Accepted-suggestions banner — stage → ask Claude to apply. */}
      {acceptedEntries.length > 0 && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          action={
            <Stack direction="row" spacing={1}>
              <Button color="inherit" size="small" onClick={copyResolutionsJson}>Copy JSON</Button>
              <Button color="inherit" size="small" onClick={() => setAccepted({})}>Clear</Button>
            </Stack>
          }
        >
          <strong>{acceptedEntries.length}</strong> accepted suggestion{acceptedEntries.length === 1 ? '' : 's'} (this browser only). Click <strong>Copy JSON</strong> and ask Claude to apply it to <code>data_cleanup_resolutions.json</code> + rebuild — then these clear for the whole team.
        </Alert>
      )}

      {/* Issue accordions by category */}
      {isLoading ? (
        <Skeleton variant="rectangular" height={400} />
      ) : issuesByCategory.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
          <Typography variant="h6">Nothing to clean up</Typography>
          <Typography variant="body2">All hygiene checks pass with the current filters.</Typography>
        </Paper>
      ) : (
        issuesByCategory.map(([cat, list]) => (
          <Accordion
            key={cat}
            expanded={expandedCategory === cat}
            onChange={(_, isExp) => setExpandedCategory(isExp ? cat : null)}
            sx={{ '&:before': { display: 'none' }, mb: 1, border: '1px solid', borderColor: 'divider' }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600, flexGrow: 1 }}>{list[0].category_label}</Typography>
                <Chip label={`${list.length} issue${list.length > 1 ? 's' : ''}`} size="small" sx={{ height: 22, fontSize: 11 }} />
                {(['high', 'medium', 'low'] as Severity[]).map((sev) => {
                  const n = list.filter((i) => i.severity === sev).length;
                  if (n === 0) return null;
                  return (
                    <Chip key={sev} label={`${n} ${sev}`} size="small" sx={{ height: 18, fontSize: 10, bgcolor: SEVERITY_COLOR[sev] + '22', color: SEVERITY_COLOR[sev], textTransform: 'capitalize' }} />
                  );
                })}
                <InfoIcon info={categoryDescription(cat)} />
              </Stack>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0 }}>
              <CategoryTable category={cat} issues={list} onAccept={acceptIssue} />
            </AccordionDetails>
          </Accordion>
        ))
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'text.secondary' }}>
        Generated {snap?.fetchedAt ? new Date(snap.fetchedAt).toLocaleString() : '—'} · refreshes whenever the ETL pipeline runs.
      </Typography>
    </Box>
  );
}

function categoryDescription(cat: string): string {
  switch (cat) {
    case 'hubspot_instance_missing_aid':
      return 'Active HubSpot Instances where the Allmoxy Customer ID field is empty. The dashboard joins these via installer_id today, but populating allmoxy_customer_id directly on the Instance would simplify every HubSpot-side report.';
    case 'hubspot_company_id_ghost':
      return 'Customer profiles whose hubspot_company_id points at a HubSpot Company that no longer exists (not via merge redirect, not in the live set). Almost certainly a stale id in the xlsx Sync Sheet column B.';
    case 'connect_mapping_orphan':
      return 'Entries in src/data/connect_customer_overrides.json that map to a customer name no longer present in the Stripe Connect xlsx export. Either the account closed, the customer churned, or the Connect account changed.';
    case 'hubspot_pay_status_drift':
      return 'HubSpot Instance.status disagrees with the xlsx Sync Sheet pay_status. One side has gone stale — check which.';
    default:
      return 'Data hygiene issue detected by the cleanup builder.';
  }
}

type AcceptFn = (i: Issue, decision: string, value: string | number | null, label: string) => void;

function CategoryTable({ category, issues, onAccept }: { category: string; issues: Issue[]; onAccept: AcceptFn }) {
  if (category === 'hubspot_instance_missing_aid') {
    return (
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Account Name</TableCell>
            <TableCell>Installer ID</TableCell>
            <TableCell>Pay Status</TableCell>
            <TableCell>Suggested AID</TableCell>
            <TableCell>Severity</TableCell>
            <TableCell>Action</TableCell>
            <TableCell align="right">Accept</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {issues.map((i, idx) => (
            <TableRow key={i.instance_id ?? idx} hover>
              <TableCell sx={{ fontWeight: 500 }}>
                {i.suggested_aid
                  ? <CustomerLink id={i.suggested_aid} name={i.account_name || ''}>{i.account_name}</CustomerLink>
                  : i.account_name}
              </TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{i.installer_id ?? '—'}</TableCell>
              <TableCell sx={{ fontSize: 12 }}>{i.pay_status}</TableCell>
              <TableCell sx={{ fontSize: 12 }}>
                {i.suggested_aid ? (
                  <>
                    <CustomerLink id={i.suggested_aid} name={i.suggested_customer_name || ''}>{i.suggested_aid}</CustomerLink>
                    {i.suggested_customer_name && <Typography component="div" variant="caption" sx={{ color: 'text.secondary' }}>{i.suggested_customer_name}</Typography>}
                  </>
                ) : <Typography variant="caption" sx={{ color: 'error.main' }}>no auto-resolve — manual lookup needed</Typography>}
              </TableCell>
              <TableCell><Chip label={i.severity} size="small" sx={{ height: 18, fontSize: 10, bgcolor: SEVERITY_COLOR[i.severity] + '22', color: SEVERITY_COLOR[i.severity], textTransform: 'capitalize' }} /></TableCell>
              <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{i.action}</TableCell>
              <TableCell align="right">
                <Button
                  size="small" variant="outlined"
                  disabled={!i.suggested_aid}
                  onClick={() => onAccept(i, 'set_instance_aid', i.suggested_aid ?? null, `Set Instance "${i.account_name}" Allmoxy ID → ${i.suggested_aid} (${i.suggested_customer_name})`)}
                >Accept</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  if (category === 'connect_mapping_orphan') {
    return (
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Customer</TableCell>
            <TableCell>Connect Name (orphaned)</TableCell>
            <TableCell>Pay Status</TableCell>
            <TableCell>Severity</TableCell>
            <TableCell>Action</TableCell>
            <TableCell align="right">Accept</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {issues.map((i, idx) => (
            <TableRow key={idx} hover>
              <TableCell sx={{ fontWeight: 500 }}>
                {i.allmoxy_customer_id ? <CustomerLink id={i.allmoxy_customer_id} name={i.customer_name || ''}>{i.customer_name || '(unknown)'}</CustomerLink> : i.customer_name}
              </TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{i.connect_name}</TableCell>
              <TableCell sx={{ fontSize: 12 }}>{i.pay_status || '—'}</TableCell>
              <TableCell><Chip label={i.severity} size="small" sx={{ height: 18, fontSize: 10, bgcolor: SEVERITY_COLOR[i.severity] + '22', color: SEVERITY_COLOR[i.severity], textTransform: 'capitalize' }} /></TableCell>
              <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{i.action}</TableCell>
              <TableCell align="right">
                <Button
                  size="small" variant="outlined" color="warning"
                  onClick={() => onAccept(i, 'remove_connect_mapping', i.connect_name ?? null, `Remove orphaned Connect mapping "${i.connect_name}"`)}
                >Confirm removal</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  if (category === 'hubspot_pay_status_drift') {
    return (
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Customer</TableCell>
            <TableCell>HubSpot Pay Status</TableCell>
            <TableCell>xlsx Pay Status</TableCell>
            <TableCell>Installer ID</TableCell>
            <TableCell>Severity</TableCell>
            <TableCell align="right">Accept which?</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {issues.map((i, idx) => (
            <TableRow key={idx} hover>
              <TableCell sx={{ fontWeight: 500 }}>
                {i.allmoxy_customer_id ? <CustomerLink id={i.allmoxy_customer_id} name={i.customer_name || ''}>{i.customer_name}</CustomerLink> : i.customer_name}
              </TableCell>
              <TableCell sx={{ fontSize: 12 }}>{i.hubspot_pay_status}</TableCell>
              <TableCell sx={{ fontSize: 12 }}>{i.xlsx_pay_status}</TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{i.installer_id}</TableCell>
              <TableCell><Chip label={i.severity} size="small" sx={{ height: 18, fontSize: 10, bgcolor: SEVERITY_COLOR[i.severity] + '22', color: SEVERITY_COLOR[i.severity], textTransform: 'capitalize' }} /></TableCell>
              <TableCell align="right">
                <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                  <Button size="small" variant="outlined" onClick={() => onAccept(i, 'use_hubspot', i.hubspot_pay_status ?? null, `${i.customer_name}: pay status → "${i.hubspot_pay_status}" (HubSpot)`)}>HubSpot</Button>
                  <Button size="small" variant="outlined" onClick={() => onAccept(i, 'use_xlsx', i.xlsx_pay_status ?? null, `${i.customer_name}: pay status → "${i.xlsx_pay_status}" (xlsx)`)}>xlsx</Button>
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }
  // Generic fallback table
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Customer</TableCell>
          <TableCell>Detail</TableCell>
          <TableCell>Severity</TableCell>
          <TableCell>Action</TableCell>
          <TableCell align="right">Accept</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {issues.map((i, idx) => (
          <TableRow key={idx} hover>
            <TableCell sx={{ fontWeight: 500 }}>
              {i.allmoxy_customer_id ? <CustomerLink id={i.allmoxy_customer_id} name={i.customer_name || ''}>{i.customer_name || i.account_name}</CustomerLink> : i.customer_name || i.account_name}
            </TableCell>
            <TableCell sx={{ fontSize: 12 }}>{i.hubspot_company_id ?? i.installer_id ?? '—'}</TableCell>
            <TableCell><Chip label={i.severity} size="small" sx={{ height: 18, fontSize: 10, bgcolor: SEVERITY_COLOR[i.severity] + '22', color: SEVERITY_COLOR[i.severity], textTransform: 'capitalize' }} /></TableCell>
            <TableCell sx={{ fontSize: 11, color: 'text.secondary' }}>{i.action}</TableCell>
            <TableCell align="right">
              <Button size="small" variant="outlined" onClick={() => onAccept(i, 'acknowledge', null, `${i.category_label}: ${i.customer_name || i.account_name}`)}>Accept</Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
