// Tiny CSV-export helper used by table-bearing pages. Lifted from the pattern in
// DrillDownPanel so we can attach an export button to any custom Table without
// reaching for the full DrillDownPanel component.

export type CsvColumn<Row> = {
  key: string;
  label: string;
  getValue?: (row: Row) => unknown;
};

function csvEscape(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  const s = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function rowsToCsv<Row>(columns: CsvColumn<Row>[], rows: Row[]): string {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((r) => columns.map((c) => csvEscape(c.getValue ? c.getValue(r) : (r as unknown as Record<string, unknown>)[c.key])).join(','));
  return [header, ...lines].join('\n');
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportRowsAsCsv<Row>(filename: string, columns: CsvColumn<Row>[], rows: Row[]) {
  downloadCsv(filename, rowsToCsv(columns, rows));
}
