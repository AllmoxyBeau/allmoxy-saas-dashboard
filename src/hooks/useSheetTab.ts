import { useQuery } from '@tanstack/react-query';
import { loadSnapshot } from '../data/manifest';

export type SheetTabResponse<Row = Record<string, unknown>> = {
  tab: string;
  sheetId?: string;
  sheetIds?: string[];
  fetchedAt: string;
  cachedUntil: string;
  columns: string[];
  rows: Row[];
  rowCount: number;
  // Optional pre-computed aggregates that time-series snapshots may include.
  monthlyTotals?: Record<string, number>;
  notes?: string;
};

export function useSheetTab<Row = Record<string, string | number | null>>(
  tabName: string,
  options?: { enabled?: boolean }
) {
  return useQuery<SheetTabResponse<Row>>({
    queryKey: ['sheet', tabName],
    queryFn: () => loadSnapshot(tabName) as Promise<SheetTabResponse<Row>>,
    enabled: options?.enabled ?? true,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
