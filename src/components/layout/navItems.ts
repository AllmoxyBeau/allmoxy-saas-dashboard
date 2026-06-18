import { SHOW_FINANCIAL_TABS_BUILD_FLAG } from '../../config/features';

export type NavLeaf = { label: string; path: string; financial?: boolean };
export type NavGroup = { label: string; items: NavLeaf[]; financial?: boolean };
export type NavEntry = NavLeaf | NavGroup;

export const isGroup = (e: NavEntry): e is NavGroup => 'items' in e;

// The P&L and QoE / Diligence groups are gated behind the SHOW_FINANCIAL_TABS
// feature flag — see src/config/features.ts. On production Vercel deploys
// (env var unset) they don't render in the nav AND the routes aren't
// registered, so direct URL typing redirects to /overview via App.tsx's
// catch-all route. Local dev shows them when `.env.local` sets
// VITE_SHOW_FINANCIAL_TABS=true.
const FINANCIAL_GROUPS: NavEntry[] = [
  {
    label: 'P&L',
    financial: true,
    items: [
      { label: 'Profit & Loss', path: '/profit-loss', financial: true },
      { label: 'Adjusted EBITDA Bridge', path: '/ebitda-bridge', financial: true },
    ],
  },
  {
    label: 'QoE / Diligence',
    financial: true,
    items: [
      { label: 'CIM Packet', path: '/cim-packet', financial: true },
      { label: 'Scorecard', path: '/scorecard', financial: true },
      { label: 'Banker Handoff', path: '/banker-handoff', financial: true },
      { label: 'Adjustments Register', path: '/adjustments-register', financial: true },
      { label: 'Annual Amortization Evidence', path: '/annual-amortization-evidence', financial: true },
      { label: 'Stripe ↔ QB Reconciliation', path: '/stripe-qb-reconciliation', financial: true },
      { label: 'Invariant Tests', path: '/invariant-tests', financial: true },
      { label: 'Definitions', path: '/definitions', financial: true },
    ],
  },
];

export const NAV_ENTRIES: NavEntry[] = [
  { label: 'Overview', path: '/overview' },
  {
    label: 'Customers',
    items: [
      { label: 'All Customers', path: '/customers' },
      { label: 'Rep Dashboard', path: '/rep-dashboard' },
      { label: 'Customer Detail', path: '/customer-detail' },
      { label: 'Custom Report', path: '/custom-report' },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { label: 'Current Month', path: '/current-month' },
      { label: 'Revenue Waterfall', path: '/revenue-waterfall' },
      { label: 'Logo Waterfall', path: '/logo-waterfall' },
      { label: 'Cohort Retention', path: '/cohort-retention' },
      { label: 'Net Revenue Retention', path: '/net-revenue-retention' },
    ],
  },
  {
    label: 'Churn & Health',
    items: [
      { label: 'Customer Health', path: '/customer-health' },
      { label: 'Churn Risk Matrix', path: '/churn-risk-matrix' },
      { label: 'Churn Patterns', path: '/churn-patterns' },
      { label: 'Churn Investigator', path: '/churn-investigator' },
      { label: 'Time to Value', path: '/time-to-value' },
      { label: 'Orders Verified', path: '/orders-verified' },
    ],
  },
  {
    label: 'Unit Economics',
    items: [
      { label: 'Unit Economics', path: '/unit-economics' },
      { label: 'Efficiency', path: '/efficiency' },
      { label: 'Segments', path: '/segments' },
      { label: 'Sub-Segment Backfill', path: '/sub-segment-backfill' },
    ],
  },
  // Build-time gate: when VITE_SHOW_FINANCIAL_TABS isn't 'true', these entries
  // never ship in the bundle. When the flag IS on (local dev), entries are
  // present but NavTabs filters them out at render time when the user has
  // toggled "View as CS Rep" — see useViewMode() in src/config/features.ts.
  ...(SHOW_FINANCIAL_TABS_BUILD_FLAG ? FINANCIAL_GROUPS : []),
];

// Legacy flat list for any consumer that still expects it.
export type NavItem = NavLeaf;
export const NAV_ITEMS: NavItem[] = NAV_ENTRIES.flatMap((e) =>
  isGroup(e) ? e.items : [e],
);
