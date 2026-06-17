import { useEffect, useState } from 'react';

/**
 * Feature flags read from build-time env. Set in `.env.local` for local dev,
 * left unset on Vercel production deploys so sensitive sections don't ship.
 *
 * The Vite convention: only env vars prefixed with `VITE_` are exposed to the
 * client. These are all client-side flags — they're not secrets, just toggles
 * that decide which tabs/routes get registered.
 */

/**
 * Build-time flag controlling whether the P&L and QoE / Diligence groups
 * (Profit & Loss, EBITDA Bridge, CIM Packet, Scorecard, Banker Handoff,
 * Adjustments Register, Annual Amortization Evidence, Stripe ↔ QB
 * Reconciliation, Invariant Tests, Definitions) are even compiled into the
 * bundle.
 *
 * Local dev: set `VITE_SHOW_FINANCIAL_TABS=true` in `.env.local`.
 * Vercel prod: leave unset → tabs hidden + routes redirect to overview.
 *
 * NOTE: this is module-load constant. Use `useViewMode()` (below) when you
 * want the effective runtime visibility — that hook lets local dev preview
 * the CS-rep view without restarting Vite.
 */
export const SHOW_FINANCIAL_TABS_BUILD_FLAG =
  import.meta.env.VITE_SHOW_FINANCIAL_TABS === 'true';

/**
 * Runtime "view as" toggle for local development only. Lets you flip between
 * the full admin view and a preview of what a CS rep would see on Vercel,
 * without restarting Vite. Persists in localStorage. Has NO effect in
 * production builds — when the build flag is off, financial tabs are never
 * compiled in, so toggling to "admin" can't reveal them.
 *
 * Default: 'admin' (full view). Switch to 'cs_rep' to preview the trimmed
 * deployment view.
 */
export type ViewMode = 'admin' | 'cs_rep';
const VIEW_MODE_STORAGE_KEY = 'allmoxy.dev.view_mode';

function readViewMode(): ViewMode {
  try {
    if (typeof localStorage === 'undefined') return 'admin';
    const v = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return v === 'cs_rep' ? 'cs_rep' : 'admin';
  } catch {
    return 'admin';
  }
}

/**
 * Hook returning effective view state + a setter. Components subscribe to
 * `showFinancialTabs` for nav filtering and route registration.
 *
 * Multiple components call this hook independently — they each hold their
 * own React state. To keep them in sync when ANY component flips the
 * toggle, we dispatch a same-tab custom event on every set; all instances
 * listen for it and re-read localStorage. (The native `storage` event only
 * fires cross-tab, which is why we need the custom one too.)
 */
const VIEW_MODE_CHANGE_EVENT = 'allmoxy:view-mode-changed';

export function useViewMode() {
  const [viewMode, setViewModeState] = useState<ViewMode>(() => readViewMode());

  useEffect(() => {
    const reload = () => setViewModeState(readViewMode());
    window.addEventListener('storage', reload);
    window.addEventListener(VIEW_MODE_CHANGE_EVENT, reload);
    return () => {
      window.removeEventListener('storage', reload);
      window.removeEventListener(VIEW_MODE_CHANGE_EVENT, reload);
    };
  }, []);

  const setViewMode = (mode: ViewMode) => {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch { /* ignore */ }
    setViewModeState(mode);
    window.dispatchEvent(new Event(VIEW_MODE_CHANGE_EVENT));
  };

  // Effective visibility: build flag wins (off → always hidden, even if the
  // localStorage value somehow says 'admin'). When the build flag is on, the
  // user's preference decides.
  const showFinancialTabs = SHOW_FINANCIAL_TABS_BUILD_FLAG && viewMode === 'admin';
  const isPreviewingAsCsRep = SHOW_FINANCIAL_TABS_BUILD_FLAG && viewMode === 'cs_rep';
  // The "View as" UI should only render in local dev (when financial tabs
  // are even compiled in). Production users never see the toggle.
  const canTogglePreview = SHOW_FINANCIAL_TABS_BUILD_FLAG;

  return { viewMode, setViewMode, showFinancialTabs, isPreviewingAsCsRep, canTogglePreview };
}
