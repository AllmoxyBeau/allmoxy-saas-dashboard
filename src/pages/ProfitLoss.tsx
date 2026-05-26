import { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Skeleton from '@mui/material/Skeleton';
import Chip from '@mui/material/Chip';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Alert from '@mui/material/Alert';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import PageHeader from '../components/common/PageHeader';
import InfoIcon from '../components/common/InfoIcon';
import CsvExportButton from '../components/common/CsvExportButton';
import CollapseToggle, { useCollapse } from '../components/common/CollapseToggle';
import { useSheetTab } from '../hooks/useSheetTab';

type LineItem = {
  key: string;
  label: string;
  section: string;
  isTotal?: boolean;
  parentKey?: string;
  depth?: number;
};
type PnlSnap = {
  fetchedAt: string;
  months: string[];
  lineItems: LineItem[];
  data: Record<string, Record<string, number>>;
};

const USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const USD_COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });

function fmtMoney(v: number, compact = false) {
  if (Math.abs(v) < 0.5) return '—';
  const fmt = compact ? USD_COMPACT : USD0;
  if (v < 0) return `(${fmt.format(Math.abs(v))})`;
  return fmt.format(v);
}
function fmtPct(v: number | null) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}
function monthLabel(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
function monthLabelLong(iso: string) {
  const [y, m] = iso.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function shiftMonth(iso: string, delta: number) {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

type RangePreset = '3M' | '6M' | '12M' | '24M' | 'YTD' | 'ALL';

export default function ProfitLoss() {
  const { data: pnlData, isLoading } = useSheetTab('pnl_by_month');
  const snap = pnlData as unknown as PnlSnap | undefined;
  const [preset, setPreset] = useState<RangePreset>('12M');
  const pnlTable = useCollapse(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const view = useMemo(() => {
    if (!snap) return null;
    const s = snap;
    const allMonths = s.months;
    if (allMonths.length === 0) return null;

    // "Latest complete month" heuristic: last month where total_income > 0 AND
    // subscription_revenue > 0 (catches QB's not-fully-posted partial months
    // where revenue gets dumped into Stripe Fee Income only).
    let latestComplete = allMonths[0];
    for (let i = allMonths.length - 1; i >= 0; i--) {
      const m = allMonths[i];
      const total = s.data.total_income?.[m] ?? 0;
      const sub = s.data.subscription_revenue?.[m] ?? 0;
      if (total > 0 && sub > 0) { latestComplete = m; break; }
    }
    const latestAny = [...allMonths].reverse().find((m) => (s.data.total_income?.[m] ?? 0) > 0) ?? allMonths[allMonths.length - 1];
    const partialMonths = allMonths.filter((m) => m > latestComplete && (s.data.total_income?.[m] ?? 0) > 0);

    // Date range
    let from: string;
    const to = latestComplete;
    switch (preset) {
      case '3M': from = shiftMonth(to, -2); break;
      case '6M': from = shiftMonth(to, -5); break;
      case '24M': from = shiftMonth(to, -23); break;
      case 'YTD': from = `${to.slice(0, 4)}-01`; break;
      case 'ALL': from = allMonths[0]; break;
      case '12M': default: from = shiftMonth(to, -11); break;
    }
    if (from < allMonths[0]) from = allMonths[0];
    const visibleMonths = allMonths.filter((m) => m >= from && m <= to);

    // TTM and YoY summary stats based on latestComplete month.
    const ttmMonths: string[] = [];
    for (let i = 11; i >= 0; i--) ttmMonths.push(shiftMonth(latestComplete, -i));
    const priorTtmMonths = ttmMonths.map((m) => shiftMonth(m, -12));
    function sumOver(key: string, monthList: string[]): number {
      return monthList.reduce((acc, m) => acc + (s.data[key]?.[m] ?? 0), 0);
    }
    const ttmRevenue = sumOver('total_income', ttmMonths);
    const priorTtmRevenue = sumOver('total_income', priorTtmMonths);
    const ttmGrossProfit = sumOver('gross_profit', ttmMonths);
    const ttmGrossMargin = ttmRevenue > 0 ? ttmGrossProfit / ttmRevenue : null;
    const priorTtmGrossProfit = sumOver('gross_profit', priorTtmMonths);
    const ttmNetOp = sumOver('net_op_income', ttmMonths);
    const priorTtmNetOp = sumOver('net_op_income', priorTtmMonths);
    const ttmNetIncome = sumOver('net_income', ttmMonths);

    // Latest complete month
    const latestRevenue = s.data.total_income?.[latestComplete] ?? 0;
    const latestNetIncome = s.data.net_income?.[latestComplete] ?? 0;
    const yoyMonth = shiftMonth(latestComplete, -12);
    const yoyRevenue = s.data.total_income?.[yoyMonth] ?? 0;
    const yoyDelta = yoyRevenue > 0 ? (latestRevenue - yoyRevenue) / yoyRevenue : null;

    return {
      visibleMonths,
      from,
      to,
      latestComplete,
      latestAny,
      partialMonths,
      ttmRevenue,
      priorTtmRevenue,
      ttmRevenueDelta: priorTtmRevenue > 0 ? (ttmRevenue - priorTtmRevenue) / priorTtmRevenue : null,
      ttmGrossProfit,
      ttmGrossMargin,
      priorTtmGrossProfit,
      ttmNetOp,
      ttmNetOpMargin: ttmRevenue > 0 ? ttmNetOp / ttmRevenue : null,
      priorTtmNetOp,
      ttmNetIncome,
      latestRevenue,
      latestNetIncome,
      yoyDelta,
    };
  }, [snap, preset]);

  if (isLoading || !snap || !view) {
    return (
      <Box>
        <PageHeader title="Profit & Loss" subtitle="Monthly P&L sourced from QuickBooks." />
        <Skeleton variant="rectangular" height={140} sx={{ mb: 2 }} />
        <Skeleton variant="rectangular" height={500} />
      </Box>
    );
  }

  const cols = [...view.visibleMonths].reverse(); // newest first
  const snapNn: PnlSnap = snap; // narrow once for closures below

  // Build parent → children map (keys in original snapshot order).
  const childrenByParent = new Map<string, LineItem[]>();
  const topLevel: LineItem[] = [];
  for (const li of snapNn.lineItems) {
    if (li.parentKey) {
      const arr = childrenByParent.get(li.parentKey) ?? [];
      arr.push(li);
      childrenByParent.set(li.parentKey, arr);
    } else {
      topLevel.push(li);
    }
  }

  // A row "has data" if any visible month is non-zero on itself OR a descendant.
  function hasData(key: string): boolean {
    const onSelf = cols.some((m) => Math.abs(snapNn.data[key]?.[m] ?? 0) >= 0.5);
    if (onSelf) return true;
    for (const ch of childrenByParent.get(key) ?? []) {
      if (hasData(ch.key)) return true;
    }
    return false;
  }

  // Recursively walk the tree to render rows. Children (when expanded) appear
  // ABOVE their parent subtotal — matching QuickBooks' visual ordering where the
  // Total caps the group beneath it.
  function renderItem(li: LineItem, depth: number): React.ReactNode[] {
    if (!hasData(li.key)) return [];
    const children = childrenByParent.get(li.key) ?? [];
    const expandable = children.length > 0;
    const isExpanded = expanded.has(li.key);
    const rows: React.ReactNode[] = [];
    if (expandable && isExpanded) {
      for (const ch of children) rows.push(...renderItem(ch, depth + 1));
    }
    rows.push(
      <PnlRow
        key={li.key}
        item={li}
        cols={cols}
        snap={snapNn}
        depth={depth}
        expandable={expandable}
        expanded={isExpanded}
        onToggle={expandable ? () => toggle(li.key) : undefined}
      />
    );
    return rows;
  }

  const tableBodyRows: React.ReactNode[] = [];
  for (const li of topLevel) tableBodyRows.push(...renderItem(li, 0));

  const allExpandableKeys = snap.lineItems
    .filter((li) => (childrenByParent.get(li.key) ?? []).length > 0 && hasData(li.key))
    .map((li) => li.key);
  const allExpanded = allExpandableKeys.length > 0 && allExpandableKeys.every((k) => expanded.has(k));
  const expandAllToggle = () => {
    if (allExpanded) setExpanded(new Set());
    else setExpanded(new Set(allExpandableKeys));
  };

  // For computing margin lines under subtotals.
  const snapData = snap.data;
  function marginRow(numeratorKey: string, denominatorKey: string) {
    return cols.map((m) => {
      const num = snapData[numeratorKey]?.[m] ?? 0;
      const den = snapData[denominatorKey]?.[m] ?? 0;
      return den > 0 ? num / den : null;
    });
  }

  return (
    <Box>
      <PageHeader
        title="Profit & Loss"
        subtitle={`Monthly P&L sourced directly from the QuickBooks Profit & Loss export. Data through ${monthLabelLong(view.latestComplete)}.${view.partialMonths.length > 0 ? ` Partial data exists for ${view.partialMonths.length} more month${view.partialMonths.length === 1 ? '' : 's'} — see notice below.` : ''}`}
      />

      {view.partialMonths.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          QuickBooks data is still posting for {view.partialMonths.map(monthLabelLong).join(', ')} — revenue lines may be incomplete or temporarily booked under Stripe Fee Income while the close is in progress. The latest complete month is <strong>{monthLabelLong(view.latestComplete)}</strong>; KPI cards below use that.
        </Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label={`Revenue · ${monthLabel(view.latestComplete)}`}
            value={USD0.format(view.latestRevenue)}
            sub={view.yoyDelta != null ? `${view.yoyDelta >= 0 ? '+' : ''}${(view.yoyDelta * 100).toFixed(1)}% YoY` : 'No prior-year comparison'}
            deltaColor={view.yoyDelta != null && view.yoyDelta >= 0 ? 'success.main' : 'error.main'}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="TTM Revenue"
            value={USD0.format(view.ttmRevenue)}
            sub={view.ttmRevenueDelta != null ? `${view.ttmRevenueDelta >= 0 ? '+' : ''}${(view.ttmRevenueDelta * 100).toFixed(1)}% vs prior 12mo` : '—'}
            deltaColor={view.ttmRevenueDelta != null && view.ttmRevenueDelta >= 0 ? 'success.main' : 'error.main'}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="TTM Gross Margin"
            value={fmtPct(view.ttmGrossMargin)}
            sub={`Gross profit ${USD0.format(view.ttmGrossProfit)} on ${USD0.format(view.ttmRevenue)} revenue`}
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <KPICard
            label="TTM Net Op Income"
            value={USD0.format(view.ttmNetOp)}
            sub={`Operating margin ${fmtPct(view.ttmNetOpMargin)} · ${view.ttmNetOp >= 0 ? 'profitable' : 'burning'}`}
            deltaColor={view.ttmNetOp >= 0 ? 'success.main' : 'error.main'}
          />
        </Grid>
      </Grid>

      <Paper sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: pnlTable.open ? 2 : 0 }} flexWrap="wrap" useFlexGap>
          <Stack direction="row" spacing={1} alignItems="center">
            <CollapseToggle open={pnlTable.open} onToggle={pnlTable.toggle} label="monthly P&L" />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
              Monthly P&L · {monthLabelLong(view.from)} → {monthLabelLong(view.to)}
            </Typography>
            <InfoIcon
              info={
                <>
                  <strong>What it is:</strong> Standard P&L statement from QuickBooks, one column per month, newest-first (left to right). Subtotals (Total Income, Total COGS, Gross Profit, Total OpEx, Net Operating Income, Net Income) are visually emphasized; margin rows below each subtotal show the percentage.
                  <br /><br />
                  <strong>Source:</strong> <code>Allmoxy+LLC_Profit+and+Loss.xlsx</code> direct QuickBooks export. Categories are mapped 1:1 from the QuickBooks chart of accounts.
                  <br /><br />
                  <strong>Sign convention:</strong> negative numbers shown in (parentheses). Zero / null cells show as &quot;—&quot;.
                </>
              }
            />
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              onClick={expandAllToggle}
              startIcon={allExpanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
              sx={{ textTransform: 'none' }}
            >
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </Button>
            <ToggleButtonGroup
              value={preset}
              exclusive
              size="small"
              onChange={(_, v) => v && setPreset(v as RangePreset)}
            >
              {(['3M', '6M', '12M', '24M', 'YTD', 'ALL'] as RangePreset[]).map((p) => (
                <ToggleButton key={p} value={p} sx={{ px: 1.5 }}>{p}</ToggleButton>
              ))}
            </ToggleButtonGroup>
            <CsvExportButton
              filename={`pnl_${view.from}_to_${view.to}`}
              columns={[
                { key: 'label', label: 'Account' },
                { key: 'section', label: 'Section' },
                ...cols.map((m) => ({ key: m, label: m, getValue: (r: { values: number[]; idx: number }) => r.values[r.idx] })),
                { key: 'total', label: 'Total', getValue: (r: { values: number[] }) => r.values.reduce((a, b) => a + b, 0) },
              ] as never}
              rows={snap.lineItems
                .filter((li) => hasData(li.key))
                .map((li) => ({
                  label: li.label,
                  section: li.section,
                  values: cols.map((m) => snap.data[li.key]?.[m] ?? 0),
                  ...Object.fromEntries(cols.map((m) => [m, snap.data[li.key]?.[m] ?? 0])),
                  total: cols.reduce((s, m) => s + (snap.data[li.key]?.[m] ?? 0), 0),
                }))}
            />
          </Stack>
        </Stack>

        <Collapse in={pnlTable.open} unmountOnExit>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 800, '& td, & th': { whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ position: 'sticky', left: 0, bgcolor: 'background.paper', zIndex: 2, minWidth: 220 }}>Account</TableCell>
                {cols.map((m) => (
                  <TableCell key={m} align="right">{monthLabel(m)}</TableCell>
                ))}
                <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontWeight: 500 }}>Total</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {tableBodyRows}
              {/* Margin rows under headline subtotals */}
              <PnlMarginRow label="Gross Margin %" values={marginRow('gross_profit', 'total_income')} />
              <PnlMarginRow label="Operating Margin %" values={marginRow('net_op_income', 'total_income')} />
              <PnlMarginRow label="Net Margin %" values={marginRow('net_income', 'total_income')} />
            </TableBody>
          </Table>
        </Box>

        <Stack direction="row" spacing={2} sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
          <Chip size="small" label={`${cols.length} months`} variant="outlined" />
          <Chip size="small" label={`${snap.lineItems.length} accounts`} variant="outlined" />
          <Chip size="small" label={`Source updated ${new Date(snap.fetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`} variant="outlined" />
        </Stack>
        </Collapse>
      </Paper>
    </Box>
  );
}

function PnlRow({
  item, cols, snap, depth, expandable, expanded, onToggle,
}: {
  item: LineItem;
  cols: string[];
  snap: PnlSnap;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  onToggle?: () => void;
}) {
  const isTotal = !!item.isTotal;
  const total = cols.reduce((s, m) => s + (snap.data[item.key]?.[m] ?? 0), 0);
  // Indent: each depth level = 12px. Toggle column is reserved at the start.
  const labelIndent = 0.75 + depth * 1.5; // theme spacing units
  return (
    <TableRow
      hover={expandable}
      sx={{
        bgcolor: isTotal ? 'rgba(255,255,255,0.03)' : 'transparent',
        cursor: expandable ? 'pointer' : 'default',
        '& td': isTotal ? { borderTop: '1px solid', borderColor: 'divider', fontWeight: 600 } : {},
      }}
      onClick={expandable ? onToggle : undefined}
    >
      <TableCell sx={{
        position: 'sticky', left: 0, bgcolor: 'background.paper', zIndex: 1,
        pl: labelIndent, fontWeight: isTotal ? 600 : 400, fontSize: isTotal ? 13 : 12.5,
      }}>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ minWidth: 0 }}>
          {expandable ? (
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
              sx={{ p: 0.25, color: 'text.secondary' }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <KeyboardArrowDownIcon fontSize="small" /> : <KeyboardArrowRightIcon fontSize="small" />}
            </IconButton>
          ) : (
            <Box sx={{ width: 20 }} />
          )}
          <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</Box>
        </Stack>
      </TableCell>
      {cols.map((m) => {
        const v = snap.data[item.key]?.[m] ?? 0;
        const color = !isTotal ? 'text.primary' : v < 0 ? '#E53E3E' : v > 0 ? 'text.primary' : 'text.secondary';
        return (
          <TableCell key={m} align="right" sx={{ fontVariantNumeric: 'tabular-nums', color }}>
            {fmtMoney(v)}
          </TableCell>
        );
      })}
      <TableCell
        align="right"
        sx={{
          borderLeft: '1px solid',
          borderColor: 'divider',
          fontVariantNumeric: 'tabular-nums',
          fontWeight: isTotal ? 700 : 500,
          color: total < 0 ? '#E53E3E' : total > 0 ? 'text.primary' : 'text.secondary',
        }}
      >
        {fmtMoney(total)}
      </TableCell>
    </TableRow>
  );
}

function PnlMarginRow({ label, values }: { label: string; values: (number | null)[] }) {
  const validValues = values.filter((v): v is number => v != null);
  const avg = validValues.length > 0 ? validValues.reduce((a, b) => a + b, 0) / validValues.length : null;
  return (
    <TableRow sx={{ bgcolor: 'rgba(44, 115, 255, 0.04)' }}>
      <TableCell sx={{ position: 'sticky', left: 0, bgcolor: 'background.paper', zIndex: 1, pl: 3, fontStyle: 'italic', color: 'text.secondary', fontSize: 12 }}>
        {label}
      </TableCell>
      {values.map((v, i) => (
        <TableCell key={i} align="right" sx={{ fontStyle: 'italic', color: 'text.secondary', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
          {fmtPct(v)}
        </TableCell>
      ))}
      <TableCell align="right" sx={{ borderLeft: '1px solid', borderColor: 'divider', fontStyle: 'italic', color: 'text.secondary', fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
        {fmtPct(avg)}
      </TableCell>
    </TableRow>
  );
}

function KPICard({ label, value, sub, deltaColor }: { label: string; value: string; sub: string; deltaColor?: string }) {
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: 10.5 }}>
        {label}
      </Typography>
      <Typography variant="h4" sx={{ fontWeight: 500, mt: 0.5, mb: 0.5 }}>{value}</Typography>
      <Typography variant="caption" sx={{ color: deltaColor ?? 'text.secondary' }}>{sub}</Typography>
    </Paper>
  );
}
