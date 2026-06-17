# Refresh Runbook

How to refresh the Allmoxy data room. Read after `DATA_ROOM_README.md`.

---

## TL;DR

```bash
cd allmoxy-saas-dashboard
set -a; source .env.local; set +a    # loads HUBSPOT_TOKEN if set
node _etl_scripts/refresh_all.mjs
```

Inspect the **Invariant Tests** page (`/invariant-tests`) after the run. Status should be GREEN or YELLOW. RED means a hard QoE-blocking failure — investigate the failing test and re-run.

---

## Prerequisites

1. **Node.js 18+** — `node --version` to verify.
2. **Local clone of the repo** — `git clone git@github.com:AllmoxyBeau/allmoxy-saas-dashboard.git`.
3. **Source xlsx files in the parent directory** (`../`):
   - `Allmoxy - Meta Data Reconcile Tool.xlsx`
   - `Allmoxy+LLC_Profit+and+Loss.xlsx`
   - `Stripe Connect Revenue 2018-2019.xlsx` … `Stripe Connect Revenue 2026.xlsx` (6 files)
4. **HubSpot Private App token** (optional but recommended for churn-corpus refresh) — see `.env.sample`. Without it, the churn-corpus step is skipped silently and the prior `churn_corpus.json` is left untouched.

---

## Standard refresh

```bash
cd allmoxy-saas-dashboard
npm install                           # first time only
set -a; source .env.local; set +a    # if .env.local exists (for HUBSPOT_TOKEN)
node _etl_scripts/refresh_all.mjs
```

Expected output (abridged):

```
[1/5] Raw tab pulls
  wrote allmoxy_core_customer.json ...
  wrote classification_master.json ...
[2/5] Connect union from 6 annual Connect xlsx files
  built acct_id → name index: NNN entries
  wrote connect_by_customer_month.json ...
[3/5] MRR + Services by Month
  wrote services_by_month.json ...
  wrote mrr_by_month.json ...
[4/5] Subscription + waterfall + cohort
  running build_subscription_by_month.mjs…
  ...
[5/5] Customer aggregates + unit economics
  running build_customer_health.mjs…
  ...
  applying transaction overrides…
  applying annual-payer amortization…
  applying customer status overrides…
  classifying never-paid customers…
  ...
  Wrote ebitda_bridge.json ...
  Wrote adjustments_register.json ...
  Wrote invariant_test_results.json ...
  Invariant tests: GREEN/YELLOW
  19/22 passed · 0 error(s) · 3 warning(s)

All snapshots refreshed.
```

Wall time: 1–3 minutes for a normal refresh; up to 15 min if the HubSpot churn-corpus pull is active (rate-limited at 5 req/sec).

---

## Refreshing source data

### When the QB P&L is updated

1. Export the latest **Profit and Loss** from QuickBooks as xlsx.
2. Save as `../Allmoxy+LLC_Profit+and+Loss.xlsx` (overwriting prior).
3. Run `node _etl_scripts/refresh_all.mjs`.

The P&L drives Net Income, Gross Profit, GAAP EBITDA, and Adjusted EBITDA. As soon as the export covers 12+ months, the **TTM EBITDA bridge** activates automatically in `/ebitda-bridge`.

### When customer xlsx tabs are updated

1. From Google Sheets `18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30`, File → Download → Microsoft Excel.
2. Save as `../Allmoxy - Meta Data Reconcile Tool.xlsx` (overwriting prior).
3. Run `node _etl_scripts/refresh_all.mjs`.

### When Stripe Connect xlsx is updated (annual cadence)

1. Re-export from Stripe Connect dashboard for the affected year.
2. Save as `../Stripe Connect Revenue YYYY.xlsx`.
3. Run `node _etl_scripts/refresh_all.mjs`.

### When HubSpot sub-segments are updated

The HubSpot churn corpus is pulled on every refresh **if** `HUBSPOT_TOKEN` is set in the environment. To force a fresh sub-segment cache:

```bash
set -a; source .env.local; set +a
node _etl_scripts/build_churn_corpus.mjs   # writes churn_corpus.json
```

The sub-segment cache (`_etl_scripts/cache/hubspot_segments.json`) is currently maintained manually — re-run the Claude HubSpot MCP fetch when needed.

---

## Adding adjustments

Each adjustment category lives in its own JSON config file. Edit the JSON, then re-run `refresh_all`.

| Adjustment | File | Quick example |
|---|---|---|
| Flag a customer as an annual payer | `src/data/annual_payers.json` → add ID to `annual_payer_ids`, add a `payer_details` entry with `typical_annual_amount`, `qb_treatment`, `verified_by`, `verified_at`. | `293` (B&B Door), `15` (Mid Michigan Wood) |
| Custom amortization window | `_etl_scripts/annual_amortization_overrides.json` → add an override entry with `allmoxy_customer_id`, `origin_month`, `amount_match_min/max`, `start_month`, `months`, `reason`. | B&B Door's 15-month coverage |
| Variance carry-forward | `_etl_scripts/variance_overrides.json` → add `{customer_name, month, reason}`. | Bella, Raumplus, Drawer Works for late-month payments |
| Transaction stream reclassification | `_etl_scripts/transaction_overrides.json` → add `{allmoxy_customer_id, month, from, to, amount, reason}`. | Panhandle $7,658 subscription → services |
| Off-Stripe payment (check/wire/ACH) | `_etl_scripts/synthetic_transactions.json` → add a transaction entry as if it were a Stripe charge. | Mid Michigan Wood $12,474 mailed check |
| Customer status override (sub-instance / comp / duplicate) | `_etl_scripts/customer_status_overrides.json` → add an entry with `arrangement_type` ∈ `{sub_instance_of_parent, comp, duplicate_of}`, `force_status`, `parent_allmoxy_customer_id`, `reason`, `evidence`. | Ruck/Thomas Creek, AWI/Tree Products, Wildwood/Modern Fronts |
| QoE EBITDA add-back | `_etl_scripts/ebitda_adjustments.json` → add an entry under `adjustments` with `category` ∈ `{owner_compensation, one_time, discretionary, non_operating, other}`, `per_month` or `ytd_total`, `reason`, `evidence`, `verified_by`. Set `is_placeholder: false` to indicate owner sign-off. | placeholder entries for owner-comp, one-time fees, discretionary perks |

All adjustments are auto-published to the **Adjustments Register** (`/adjustments-register`) on every refresh — no UI changes required.

---

## When refresh fails

| Symptom | Cause | Fix |
|---|---|---|
| `Reading primary xlsx… Error: ENOENT: no such file` | Source xlsx not in expected `../` parent dir. | Drop the file at `../Allmoxy - Meta Data Reconcile Tool.xlsx`. |
| `running build_pnl.mjs… Error: ENOENT` | QB P&L export missing. | Drop the file at `../Allmoxy+LLC_Profit+and+Loss.xlsx`. |
| `HUBSPOT_TOKEN not set` (info-level) | Optional HubSpot churn-corpus pull skipped. | Add `HUBSPOT_TOKEN=…` to `.env.local`. The refresh proceeds without it; only `churn_corpus.json` won't update. |
| Invariant tests RED with `mrr_by_month subscription = sum of customer_profiles monthly_history` failure | Source-data inconsistency between QB-tab and transaction-stream rollups. | Check the failing months in the test output. Likely cause: a new transaction reclassification that needs a `transaction_overrides.json` entry, OR a new variance carry-forward needed. |
| `every customer_status_override is applied to its profile` fails | An override references a customer ID that doesn't exist in customer_profiles, OR force_status doesn't match what was applied. | Check the test detail — it lists the failing ID. Likely a typo in `customer_status_overrides.json` or a duplicate_of pointing to a parent whose status changed. |
| Synthetic transaction not flowing | Override missing from `_etl_scripts/synthetic_transactions.json` or customer ID mismatch. | The test `every synthetic_transaction has a matching profile` catches this. |

---

## Verifying a clean refresh

After each refresh:

1. Check **Invariant Tests** (`/invariant-tests`) — should be GREEN or YELLOW.
2. Check **Stripe ↔ QB Reconciliation** (`/stripe-qb-reconciliation`) — no months should be `investigate` status.
3. Spot-check headline figures on **Overview** against the QB MRR-by-Month tab (the authoritative manually-curated source).
4. Spot-check the **Adjustments Register** total count — it should equal the sum of entries across the 8 source-config files.

If anything looks off, the invariant tests should have caught it. If you see a discrepancy the tests didn't catch, that's a missing test — file it and add to `_etl_scripts/run_invariant_tests.mjs`.

---

## Common one-off scripts

These run as part of `refresh_all.mjs` but can also be invoked individually for debugging:

- `node _etl_scripts/build_customer_profiles.mjs > public/snapshots/customer_profiles.json`
- `node _etl_scripts/apply_annual_amortization.mjs`
- `node _etl_scripts/apply_customer_status_overrides.mjs`
- `node _etl_scripts/apply_never_paid_classification.mjs`
- `node _etl_scripts/build_adjustments_register.mjs`
- `node _etl_scripts/build_ebitda_bridge.mjs`
- `node _etl_scripts/build_annual_amortization_evidence.mjs`
- `node _etl_scripts/build_stripe_qb_reconciliation.mjs`
- `node _etl_scripts/extend_churn_inferences.mjs`
- `node _etl_scripts/run_invariant_tests.mjs`
- `node _etl_scripts/build_metric_definitions.mjs`

Each script has a header comment explaining what it does and its dependencies.
