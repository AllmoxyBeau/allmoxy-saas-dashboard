# Allmoxy — Data Room README

**Audience:** Investment banker / M&A advisor / buyer-side QoE reviewer.
**Maintained by:** Beau Lewis (CEO / owner).
**Last updated:** 2026-06-12.

This is the first document to read. It is a map of the rest.

---

## What this package contains

A Quality-of-Earnings-grade SaaS financial dashboard for Allmoxy, covering revenue, churn, retention, unit economics, P&L, and Adjusted EBITDA. Every number on every chart traces back through a documented adjustment pipeline to raw source data (Stripe, HubSpot CRM, QuickBooks, Stripe Connect xlsx files).

The dashboard is a Vite + React SPA. Open `npm run dev` (in `allmoxy-saas-dashboard/`) to run locally; the live URL for the engagement is provided separately.

### Headline figures (latest refresh)

See the **Overview** page (`/overview`) for the current MRR, blended MRR, logo count, churn, and TTM revenue figures. The **CIM Packet** page (`/cim-packet`) is a one-stop summary formatted for outbound buyer materials.

### The diligence stack (read in this order)

| # | Page | Path | What's there |
|---|---|---|---|
| 1 | **Definitions** | `/definitions` | Canonical formula + source + window + sign-off for **26 metrics** across 7 categories. Read this first to understand what every other number means. |
| 2 | **Invariant Tests** | `/invariant-tests` | **22 automated self-consistency checks** run on every refresh. Currently green/yellow status with 3 documented punch-list warnings. Any banker-blocking failure is a red status. |
| 3 | **Adjustments Register** | `/adjustments-register` | **Every override / adjustment made to raw source data**, consolidated from 8 underlying config files. The single most important QoE artifact — "give me every adjustment you made to raw data" is answered here. |
| 4 | **Annual Amortization Evidence** | `/annual-amortization-evidence` | Per annual-payer: source payment trace (Stripe + off-Stripe checks), realized monthly amortization, custom-window overrides, QuickBooks deferred-revenue treatment, owner sign-off. Currently 2 annual payers, $147K amortized across 94 month-cells. |
| 5 | **Adjusted EBITDA Bridge** | `/ebitda-bridge` | GAAP NI → standard EBITDA add-backs → GAAP EBITDA → QoE adjustments → Adjusted EBITDA. Three time windows (YTD, latest month, TTM-when-available). Owner-comp + one-time + discretionary add-back framework. |
| 6 | **Stripe ↔ QB Reconciliation** | `/stripe-qb-reconciliation` | Per-month tie-out of Stripe payments to QuickBooks revenue lines. Status tag (tight/acceptable/investigate) on every month with documented reconciling items. |

---

## Adjustments philosophy

Eight categories of adjustments are applied to raw source data. Every adjustment carries a `reason` and (where applicable) `evidence` field, surfaced on the Adjustments Register page.

| Category | What it does | Source file |
|---|---|---|
| **Annual payer flag** | Marks customers who pay annually upfront so their lump sums get amortized. | `src/data/annual_payers.json` |
| **Amortization override** | Per-payment custom amortization windows (e.g., B&B Door's 15-month coverage). | `_etl_scripts/annual_amortization_overrides.json` |
| **Variance carry-forward** | Non-churn $0 months (card failure, tiered billing reset, pause) carry forward to avoid false-positive churn signals. | `_etl_scripts/variance_overrides.json` |
| **Transaction reclassification** | Misclassified Stripe charges moved between revenue streams. Currently 1 documented case (Panhandle Door, $7,658 reclassified subscription → services). | `_etl_scripts/transaction_overrides.json` |
| **Stripe ID hygiene** | Inject missing Stripe customer IDs so orphan charges are attributed correctly. | `_etl_scripts/stripe_id_overrides.json` |
| **Synthetic transaction** | Off-Stripe payments (checks, wires, ACH) injected into the transaction stream. Currently 1 case (Mid Michigan Wood $12,474 mailed check). | `_etl_scripts/synthetic_transactions.json` |
| **Status override** | Forces a customer's status for business arrangements the payment-recency heuristic can't see. 5 documented cases across `sub_instance_of_parent`, `comp`, `duplicate_of` arrangements. | `_etl_scripts/customer_status_overrides.json` |
| **Never-paid auto-classify** | Customers with $0 lifetime + 0 transactions auto-flagged as `never_paid` and excluded from logo/churn counts. Currently 54 records (signed up but never paid us). | `_etl_scripts/apply_never_paid_classification.mjs` |

---

## Customer count reconciliation

Each adjustment moves the headline customer numbers. After all adjustments:

| Bucket | Count | Counted as a logo? |
|---|---|---|
| Active (counted) | 186 | yes |
| Churned (counted, real) | 320 | yes |
| Never paid (excluded) | 54 | no — never paid us, not real customers |
| Duplicate / sub-instance (excluded) | 4 | no — same business as another counted record |
| **Total profile rows** | **593** | — |

The 4 excluded duplicate / sub-instance records:
- AWI Tacoma / Tree Products → sub-instance of AWI parent
- Ruck Cabinet Doors → duplicate of Thomas Creek (rebrand)
- Ultra Craftsmanship → duplicate of Ultrashelf (rebrand)
- Wildwood Cabinets, Inc. → duplicate of Modern Fronts DBA - Wildwood Cabinets Incorporated (rebrand)

---

## Source data trace

Every metric ultimately flows from one of these source files:

| Source | What's in it | Refresh by |
|---|---|---|
| `Allmoxy - Meta Data Reconcile Tool.xlsx` | Master customer roster, MRR by Month, Services by Month, Master Classification, Hubspot Instance Sync. | Re-export from Google Sheets (sheet ID `18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30`). |
| `Allmoxy+LLC_Profit+and+Loss.xlsx` | Monthly QuickBooks P&L: revenue lines, COGS, OpEx, Net Income. Currently covers Jan-May 2026 YTD. | Re-export from QuickBooks. Extend coverage to 12+ months to activate the TTM Adjusted EBITDA bridge. |
| `Stripe Connect Revenue {year}.xlsx` × 6 files | Per-transaction affiliate (Connect) revenue, 2018-2026. | Re-export annually from Stripe Connect dashboard. |
| HubSpot Companies (via MCP / Private App token) | Primary Segment, Sub Segment, Churn Reason, Pay Status, Contract Status, custom Stripe Subscription IDs. | Pulled via the HubSpot MCP (or `_etl_scripts/build_churn_corpus.mjs` with `HUBSPOT_TOKEN` env var). Cached at `_etl_scripts/cache/hubspot_segments.json`. |
| Customer instances master CSV | Authoritative customer name, sign-up date, installer ID. | Manual; updated in `src/data/` or via the Master Classification tab of the xlsx. |

---

## How to refresh

```bash
cd allmoxy-saas-dashboard
node _etl_scripts/refresh_all.mjs
```

The refresh script orchestrates ~20 build steps in sequence: raw tab pulls → Connect union → MRR/Services aggregation → subscription waterfall → cohort retention → customer profiles → transaction overrides → annual amortization → status overrides → never-paid classification → cohort reconciliation → waterfall (from transactions) → roster → unit economics → P&L → annual amortization evidence → Adjusted EBITDA bridge → metric definitions publish → Adjustments Register → Stripe-QB reconciliation → churn-inferences extension → optional HubSpot churn corpus → invariant tests.

The order is critical and documented in `_etl_scripts/refresh_all.mjs` with inline comments explaining the dependency between steps.

The script writes ~25 JSON snapshots to `public/snapshots/` which the dashboard fetches at runtime.

---

## QoE punch list (open items)

These are surfaced live by the **Invariant Tests** page; current as of this README:

1. **EBITDA bridge add-backs are placeholders.** Owner-comp normalization, one-time legal/M&A fees, and discretionary owner perks are scaffolded in `_etl_scripts/ebitda_adjustments.json` with $0 amounts. Needs owner sign-off + dollar values before the Adjusted EBITDA figure is banker-ready.
2. **Annual-payer contracts not on file.** Both annual payers (B&B Door, Mid Michigan Wood) have placeholder `contract_link: null` in `src/data/annual_payers.json`. Drop in the signed-contract / invoice link to close the evidence loop.
3. **TTM EBITDA bridge inactive.** P&L source covers Jan-May 2026 YTD only (5 months). Extending the QuickBooks P&L export to 12+ months auto-activates the TTM bridge.
4. **Sub-segment backfill 64% complete.** 388 of 593 customers carry a HubSpot sub-segment value; 205 (49 active + 146 churned + 10 paused) still need classification. Use the **Sub-Segment Backfill** page (`/sub-segment-backfill`) to work through the active queue and export to HubSpot via CSV.
5. **Churn reason backfill ~25% complete.** 113 of 377 real churns carry a HubSpot reason. The **Churn Investigator** page (`/churn-investigator`) lets you classify the remaining 211 unattributed; `_etl_scripts/churn_research_batches/` contains deep-research batch files with proposed reasons + evidence quotes for offline review.

---

## Contact

- **Owner / sign-off:** Beau Lewis — beau@allmoxy.com
- **Dashboard repo:** `github.com/AllmoxyBeau/allmoxy-saas-dashboard` (private)
- **For diligence questions:** start with the Definitions page and the Adjustments Register; if a number doesn't make sense, the answer is one click away.
