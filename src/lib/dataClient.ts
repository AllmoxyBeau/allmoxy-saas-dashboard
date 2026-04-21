import type { SheetTabResponse } from '../hooks/useSheetTab';

/**
 * Single entry point for fetching snapshot data. Swapping from static JSON
 * (served from /snapshots/) to a real API (served from /api/) is a one-line
 * change — set VITE_DATA_BASE at build time.
 *
 * Keep this shape stable: components consume via useSheetTab which goes through
 * this client. When endpoints come online, they just need to return the same
 * JSON shape.
 */

export const KNOWN_SNAPSHOTS = [
  'allmoxy_core_customer',
  'classification_master',
  'cohort_retention',
  'connect_by_customer_month',
  'connect_by_month',
  'customer_health',
  'customer_profiles',
  'customer_profiles_roster',
  'mrr_by_month',
  'mrr_waterfall',
  'services_by_month',
  'subscription_by_month',
  'unit_economics',
] as const;

export type SnapshotName = (typeof KNOWN_SNAPSHOTS)[number];

const KNOWN = new Set<string>(KNOWN_SNAPSHOTS);

// Base URL can be overridden per-environment. Default: static files at /snapshots/.
// When the backend lands, set VITE_DATA_BASE=/api in the deploy env.
const DATA_BASE = (import.meta.env.VITE_DATA_BASE as string | undefined) ?? '/snapshots';

export function hasSnapshot(tab: string): boolean {
  return KNOWN.has(tab);
}

export async function fetchSnapshot(tab: string): Promise<SheetTabResponse> {
  if (!KNOWN.has(tab)) {
    throw new Error(
      `Unknown snapshot "${tab}". Add it to KNOWN_SNAPSHOTS in src/lib/dataClient.ts and drop the JSON in public/snapshots/.`
    );
  }
  const res = await fetch(`${DATA_BASE}/${tab}.json`, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${tab}: HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as SheetTabResponse;
}
