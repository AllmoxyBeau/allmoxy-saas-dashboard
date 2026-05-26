import Button from '@mui/material/Button';
import DownloadIcon from '@mui/icons-material/Download';
import { exportRowsAsCsv, type CsvColumn } from '../../lib/csvExport';

type Props<Row> = {
  filename: string;
  columns: CsvColumn<Row>[];
  rows: Row[];
  size?: 'small' | 'medium';
  variant?: 'outlined' | 'text' | 'contained';
  label?: string;
  disabled?: boolean;
};

export default function CsvExportButton<Row>({ filename, columns, rows, size = 'small', variant = 'outlined', label = 'Export CSV', disabled }: Props<Row>) {
  return (
    <Button
      size={size}
      variant={variant}
      startIcon={<DownloadIcon />}
      onClick={() => exportRowsAsCsv(filename, columns, rows)}
      disabled={disabled || rows.length === 0}
    >
      {label}
    </Button>
  );
}
