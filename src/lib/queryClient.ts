import { QueryClient } from '@tanstack/react-query';

/**
 * TanStack Query client for a read-only analytics dashboard. Data lives in
 * src/data/snapshots/*.json, refreshed by asking Claude — no live polling.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes — dashboards are read-heavy, Sheets don't tick second-by-second
      gcTime: 30 * 60 * 1000, // 30 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
