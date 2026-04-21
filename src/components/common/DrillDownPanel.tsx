import { useMemo, useState } from 'react';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableSortLabel from '@mui/material/TableSortLabel';
import DownloadIcon from '@mui/icons-material/Download';
import CloseIcon from '@mui/icons-material/Close';

import { toCsv, downloadCsv, safeFilename } from '../../lib/csv';

export type ColumnAlign = 'left' | 'right' | 'center';

export type DrillColumn<Row> = {
  key: string;
  label: string;
  align?: ColumnAlign;
  render?: (row: Row) => React.ReactNode;
  // When exporting to CSV, we send the raw value under key — override if needed.
  exportValue?: (row: Row) => unknown;
  // Comparable used for sorting. Defaults to exportValue, then row[key].
  sortValue?: (row: Row) => string | number | null | undefined;
  sortable?: boolean; // default true
};

export type DrillDownPanelProps<Row> = {
  title: string;
  subtitle?: string;
  accent?: string; // optional colored accent border
  rows: Row[];
  columns: DrillColumn<Row>[];
  filename: string;
  onClose?: () => void;
  emptyMessage?: string;
};

function toComparable(v: unknown): string | number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.join(', ').toLowerCase();
  return String(v).toLowerCase();
}

export default function DrillDownPanel<Row extends Record<string, unknown>>({
  title,
  subtitle,
  accent,
  rows,
  columns,
  filename,
  onClose,
  emptyMessage = 'No rows to show.',
}: DrillDownPanelProps<Row>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return rows;
    const getSortVal = (r: Row) => {
      if (col.sortValue) return toComparable(col.sortValue(r));
      if (col.exportValue) return toComparable(col.exportValue(r));
      return toComparable(r[col.key]);
    };
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = getSortVal(a);
      const vb = getSortVal(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, columns, sortKey, sortDir]);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Default direction: numeric columns desc (big first), string asc.
      const col = columns.find((c) => c.key === key);
      const sample =
        col?.sortValue?.(rows[0]) ??
        col?.exportValue?.(rows[0]) ??
        (rows[0] ? rows[0][key] : null);
      setSortDir(typeof sample === 'number' ? 'desc' : 'asc');
    }
  }

  function handleExport() {
    const csvRows = sortedRows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of columns) {
        o[c.key] = c.exportValue ? c.exportValue(r) : r[c.key];
      }
      return o;
    });
    const csv = toCsv(csvRows, columns.map((c) => ({ key: c.key, label: c.label })));
    downloadCsv(`${safeFilename(filename)}.csv`, csv);
  }

  return (
    <Paper
      id="drill-down-panel"
      sx={{
        p: 3,
        mt: 3,
        border: '1px solid',
        borderColor: accent ?? 'rgba(44, 115, 255, 0.4)',
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2 }}>
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 500 }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {subtitle}
            </Typography>
          )}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={handleExport}
            disabled={rows.length === 0}
          >
            Export CSV
          </Button>
          {onClose && (
            <IconButton size="small" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Stack>
      </Stack>

      {rows.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {emptyMessage}
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              {columns.map((c) => {
                const align = c.align ?? (typeof rows[0][c.key] === 'number' ? 'right' : 'left');
                const sortable = c.sortable !== false;
                const isSorted = sortKey === c.key;
                return (
                  <TableCell key={c.key} align={align} sortDirection={isSorted ? sortDir : false}>
                    {sortable ? (
                      <TableSortLabel
                        active={isSorted}
                        direction={isSorted ? sortDir : 'asc'}
                        onClick={() => handleSort(c.key)}
                      >
                        {c.label}
                      </TableSortLabel>
                    ) : (
                      c.label
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          </TableHead>
          <TableBody>
            {sortedRows.map((r, i) => (
              <TableRow key={i}>
                {columns.map((c) => (
                  <TableCell key={c.key} align={c.align ?? (typeof r[c.key] === 'number' ? 'right' : 'left')}>
                    {c.render ? c.render(r) : String(r[c.key] ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Paper>
  );
}
