# Methodology — Allmoxy QoE Dashboard

How the numbers are derived. Read after `DATA_ROOM_README.md`. The **Definitions** page (`/definitions`) is the authoritative reference for every individual metric; this document is the methodology overview.

---

## Core principle

Every number on the dashboard traces back to one of five raw data sources, through a documented adjustment pipeline. There are no "magic" calculations. Every adjustment is in an override file, every override is on the **Adjustments Register**, and every metric definition (formula + source + window + sign-off) is on the **Definitions** page.

If a buyer asks "where does this number come from?" — the answer is one click away.

---

## The five raw sources

1. **QuickBooks P&L** (`../Allmoxy+LLC_Profit+and+Loss.xlsx`) — authoritative for all GAAP P&L lines: revenue, COGS, OpEx, Net Income.
2. **Stripe transaction stream** — captured via the customer_profiles transaction history. Used for per-customer MRR composition, churn detection, and Stripe ↔ QB reconciliation.
3. **QB "MRR by Month" tab** (in `../Allmoxy - Meta Data Reconcile Tool.xlsx`) — authoritative for the historical MRR series (manually-curated rollup that includes adjustments QB has already made).
4. **HubSpot CRM** — Companies, with custom properties for Primary Segment, Sub Segment, Churn Reason, Pay Status, Contract Status. Pulled via the HubSpot Private App API + MCP connector.
5. **Stripe Connect xlsx files** — six annual exports, unioned to produce affiliate (Connect) fee revenue.

---

## The adjustment pipeline

A 20-step pipeline (`_etl_scripts/refresh_all.mjs`) takes the raw sources and produces ~25 dashboard snapshots. The pipeline is **idempotent and deterministic** — running it twice in a row produces byte-identical outputs.

Each step's dependency on prior steps is documented in inline comments in `refresh_all.mjs`. The critical ordering rules:

1. **Customer profiles must be built BEFORE amortization.** Build first, then mutate.
2. **Transaction overrides applied BEFORE amortization.** The Panhandle reclassification needs to land in the transaction stream before annual-payer amortization runs.
3. **Status overrides applied AFTER amortization.** Amortization auto-flips `churned → active` for annual payers; status overrides have final say on top of that.
4. **Never-paid auto-classification AFTER status overrides.** User-maintained overrides take precedence over the automatic rule.
5. **Invariant tests run LAST.** They cross-check the final state of all snapshots.

---

## How a buyer asks "why is the number what it is?"

The answer path is always the same:

1. **Open the chart.** Hover a data point or click into the underlying table.
2. **Cross-reference the Definitions page** (`/definitions`) to see the exact formula and adjustments applied.
3. **Cross-reference the Adjustments Register** (`/adjustments-register`) to see if any specific overrides touched this customer / period.
4. **Drill into the source-file column** of the Adjustments Register row to see the raw override entry.

Example: a buyer asks "why is B&B Door's MRR $2,133/mo when their last Stripe payment was $32K?"

- Definitions (`mrr_subscription`): "Annual-payer charges (≥ $3K from customers in annual_payers.json) are spread as amount/months over their coverage window."
- Adjustments Register (filter: B&B Door): two entries — `annual_payer_flag` and `amortization` for the $32,002.50 paid 2026-05-27.
- Annual Amortization Evidence (`/annual-amortization-evidence`): full drill-down — coverage Mar 2026 through May 2027 (15 months, $2,133.50/mo), source Stripe payment trace, QuickBooks deferred-revenue treatment, owner sign-off.

This is what "QoE-grade" means: every number is one click from its source.

---

## Adjustment philosophy

Two principles govern when we adjust raw data:

### 1. Don't change reality — represent it accurately.

We DO amortize annual payments because the lump-sum represents annual revenue earned over 12 months, not earned in the month it hit Stripe. We DO inject off-Stripe payments (mailed checks) because they ARE revenue we earned. We DO mark "never paid" customers as not-real-customers because they aren't.

We do NOT smooth revenue, defer recognition for strategic timing, or otherwise manipulate the numbers.

### 2. Every adjustment is auditable.

Every override file carries:
- The customer (or transaction) being adjusted
- The before-state and after-state
- A `reason` field explaining why
- An `evidence` field pointing to supporting documentation (signed contract, bank receipt, customer email, HubSpot note) where available
- An `added_by` / `verified_by` field stamping who made the change

A QoE reviewer should be able to challenge any adjustment by reading its row in the register.

---

## Customer-state taxonomy

The state taxonomy reflects different business arrangements; the **Definitions** page covers each formally. In summary:

- **active** — paid in the recent window OR has positive amortized MRR.
- **churned** — no payment activity beyond the recency cutoff AND no amortized coverage.
- **paused** — explicit pause flag (rare).
- **never_paid** — auto-classified: $0 lifetime + 0 transactions. Excluded from logo/churn counts because they were never customers.

Within the active/churned dimension, three arrangement types affect counting:

- **sub_instance_of_parent** — secondary Allmoxy instance billed under a parent's subscription. Status mirrors parent (typically active). Excluded from logo count to avoid double-counting (parent already counts).
- **comp** — free / comp arrangement. Status = active. Counted as a logo (it's a real live instance — the buyer would see the dollars-lost-to-comp as an Adjusted EBITDA add-back).
- **duplicate_of** — same business as another Allmoxy record (rename/rebrand). Status mirrors the canonical record. Excluded from logo count.

---

## EBITDA bridge methodology

Two-stage bridge from GAAP Net Income to Adjusted EBITDA:

### Stage 1: Standard EBITDA add-backs (NI → GAAP EBITDA)
Mechanical, GAAP-driven, no judgment:
- + 7011 Loan Interest
- + 7300 Tax & Penalties
- + 7400 Depreciation
- + 7405 Amortization

### Stage 2: QoE adjustments (GAAP EBITDA → Adjusted EBITDA)
Owner-and-CSM judgment with sign-off:
- **Owner compensation normalization** — bring Beau's W2+benefits to a market CEO rate; positive add-back if currently below market, negative subtraction if above.
- **One-time non-recurring expenses** — legal/M&A advisory fees, transaction prep costs that won't recur post-close.
- **Discretionary owner perks** — personal travel/meals/etc. run through the business that a new owner wouldn't continue.

Each Stage-2 add-back lives in `_etl_scripts/ebitda_adjustments.json` with `reason`, `evidence`, `verified_by`, `verified_at`. Currently three placeholder entries pending owner sign-off (see the open punch list in `DATA_ROOM_README.md`).

---

## Churn definition

A customer is in the churn count when:
- `status === 'churned'` AND
- NOT `excluded_from_logo_count` (i.e., not a duplicate/sub-instance) AND
- NOT in `annual_payers.json` (annual payers' false-positive churn signals get auto-corrected by amortization)

Per-customer churn _reason_ comes from HubSpot Company's `churn_reason` property where set. For customers without a HubSpot reason, the **Churn Investigator** page combines (a) AI-classified inference from CSM notes, (b) user-classifications via the inline UI, and (c) deep HubSpot research saved in `_etl_scripts/churn_research_batches/` (one batch file per ~10 customers). The 13 canonical churn reasons are listed in the Definitions page entry for `churn_reason_attribution`.

---

## Stripe ↔ QuickBooks reconciliation

For each month, two parallel calculations:

- **Stripe side**: sum of customer_profiles.transactions (filtered to subscription type) in that month.
- **QB side**: pnl_by_month subscription_revenue + annual_deferred for that month.

Variance % = (Stripe − QB) / Stripe. Status tagged:
- **tight** (|variance| ≤ 1%) — no investigation needed.
- **acceptable** (|variance| ≤ 5%) — within expected reconciling-items envelope.
- **investigate** (|variance| > 5%) — needs explicit explanation.

Known reconciling items (documented on the reconciliation page):
- **Annual deferred timing**: QB defers annual lumps via "4100 Annual Deferred Monthly"; Stripe sees the full charge in the month it hit. Difference resolves over 12 months.
- **Intra-month settlement**: Stripe's last-day-of-month charges may settle in QB the following month.
- **Off-Stripe payments**: Mid Michigan Wood's $12,474 December 2025 check — Stripe side picks it up via synthetic-transaction injection; QB side picks it up via the deposit.

---

## Invariant tests (QoE-6)

22 tests across 6 areas, run on every refresh:

| Area | Tests | Severity |
|---|---|---|
| Churn attribution | 4 | error (block release) |
| Status overrides | 2 | error |
| Amortization integrity | 4 | error / warn |
| MRR reconciliation | 2 | error / warn |
| Adjustments register completeness | 3 | error |
| EBITDA bridge integrity | 2 | error |
| QoE readiness / soft checks | 4 | warn |
| Schema / snapshot presence | 1 | error |

Test results: `public/snapshots/invariant_test_results.json`. Surfaced at `/invariant-tests`. Refresh script exits non-zero on error-severity failures so CI hooks can catch them.

---

## What's intentionally NOT in scope

A few things the dashboard explicitly does NOT do:

- **No forward-looking projections.** All figures are historical or current-state. Forecasts are not part of the QoE handoff — they belong in the CIM narrative.
- **No employee-level data.** Headcount and per-employee productivity are in the QB OpEx P&L (payroll line items) but not broken out by individual.
- **No customer-level cost allocation.** We track per-customer revenue (MRR + services + connect) and lifetime totals, but not per-customer COGS / CAC. Aggregate gross margin is computed on the P&L pages.
- **No competitor / market analysis.** Belongs in the CIM narrative, not the data dashboard.

---

## Where to dig next

- Numbers don't match my expectation → **Definitions** (`/definitions`) and **Adjustments Register** (`/adjustments-register`)
- Annual-payer detail → **Annual Amortization Evidence** (`/annual-amortization-evidence`)
- Revenue tie-out questions → **Stripe ↔ QB Reconciliation** (`/stripe-qb-reconciliation`)
- EBITDA add-back detail → **Adjusted EBITDA Bridge** (`/ebitda-bridge`)
- Churn reason questions → **Churn Investigator** (`/churn-investigator`) + `_etl_scripts/churn_research_batches/`
- Refresh / data update mechanics → `REFRESH_RUNBOOK.md`
