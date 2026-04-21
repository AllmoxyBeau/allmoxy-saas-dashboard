/**
 * Thin shim preserved for backwards compatibility. All data fetching goes
 * through src/lib/dataClient.ts — update consumers to import from there
 * directly when touching them.
 */
export { fetchSnapshot as loadSnapshot, hasSnapshot } from '../lib/dataClient';
