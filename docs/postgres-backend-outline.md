# Aurora Postgres Backend — Build Outline

**Audience:** the data engineer cleaning/prepping data and building the Postgres (Aurora) schema that will replace the current JSON-snapshot backend.

**Goal:** Today the dashboard is a *static* React app that reads ~30 committed JSON snapshots in `public/snapshots/`. Those snapshots are produced by an ETL pipeline (`_etl_scripts/*.mjs`) that pulls from several source systems. We want to move the system of record into **Aurora Postgres**: real tables for source/entity data, SQL views for the computed metrics, and real tables (not localStorage) for the human-entered overrides. The React app will then read from an API over Postgres instead of static JSON.

> **Mental model:** the existing snapshots are already a hand-rolled warehouse. This migration formalizes them into Postgres. Treat each snapshot as either (a) a **source/entity table**, (b) a **derived view/materialized view**, or (c) a **human-decision table**. The bulk of the design work is the identity spine (§3) and not losing the business semantics (§7).

---

## 1. Source systems (where the data originates)

| Source | Feeds | How it arrives today | Notes |
|---|---|---|---|
| **Stripe** | charges/transactions, customers, subscriptions, fees | xlsx export (Coefficient) + planned API | Cash basis. One Allmoxy customer → **many** Stripe customer IDs / subscription IDs. |
| **HubSpot** | Company props, Owners, **Instance custom object** (`2-39181518`), Quotes | Live API (`sync_hubspot.mjs`, token in `.env.local`) | Instance = the per-realm record carrying renewal/contract/pay-status. |
| **QuickBooks** | P&L, invoice $, reconciliation | xlsx export | Used for P&L / EBITDA / QB↔Stripe reconciliation. |
| **Harvest** | clients, projects, time entries (services hours/$) | Live API (`sync_harvest.mjs`) | `harvest_id` on a customer **== Harvest `client_id`** (1:1, verified). |
| **JIRA Cloud** | implementation epics + child tasks (project **IPA**) | Live API (`sync_jira.mjs`) | Customer = epic summary (name-match); tasks carry the schedule dates. |
| **Allmoxy core / "meta" xlsx** | `allmoxy_customer_id`, `installer_id`, realm, sign-up, `harvest_id` | xlsx (Coefficient → Sheets) | **Source of truth for identity** (the keys below). |
| **HubSpot Instance Sync Sheet** | joined HubSpot+Stripe+core report | xlsx | Column B = HubSpot Company ID is authoritative (see §3). |

**Recommendation:** land each source in a raw/staging schema first (e.g. `stg_stripe_charges`, `stg_hubspot_companies`, `stg_hubspot_instances`, `stg_harvest_time_entries`, `stg_jira_issues`, `stg_core_customers`), then transform into the modeled tables in §4. This makes reloads idempotent and debuggable. dbt is a natural fit but not required.

---

## 2. Two big shifts from the current setup

1. **Computed snapshots become views, not tables.** ~20 of the snapshots are *derived* (MRR, waterfall, cohort, NRR, P&L, EBITDA, unit economics, renewal management, time-to-value, churn risk, data cleanup, implementation). Do **not** hand-maintain these — build them as SQL **views** (or **materialized views** refreshed on a schedule) over the entity + override tables. The current `.mjs` builders are the spec for the logic.
2. **Human overrides become real tables with writes.** Today the app stages edits in `localStorage` and a human commits them to JSON override files, then rebuilds. In Postgres these become first-class tables the app writes to directly (with audit columns). See §6 — this is the most important behavior to preserve and the main reason to move off JSON.

---

## 3. Identity spine (do this first — everything joins on it)

The canonical primary key for a customer is **`allmoxy_customer_id`** (integer). Every other system attaches via a resolver. Build a clean `customers` dimension keyed on it, plus the cross-reference tables.

**Join keys & rules:**

| Key | Cardinality | Rule |
|---|---|---|
| `allmoxy_customer_id` | PK | Canonical. From the core/meta xlsx. |
| `installer_id` | 1 customer → 1+ instances | The Allmoxy realm/instance id. Primary fallback join for HubSpot Instances. |
| `hubspot_company_id` | 1:1 (mostly) | **Sync Sheet Column B is authoritative** over the core file (which freezes/rots). Use a **3-stage resolver**: (1) Sync Sheet col B → (2) core customer record → (3) name-match + merge-redirect map (handles HubSpot company merges + typos). |
| `harvest_id` | 1:1 | **Equals Harvest `client_id`.** Direct join, no fuzzy matching. |
| `stripe_customer_ids[]` | 1 customer → **many** | A customer can have multiple Stripe customers + subscription IDs (incl. custom-domain subs). Model as a child table. |
| JIRA epic | name-match | Implementation epic summary → customer by normalized name + an overrides table for misses. |

**Multi-instance reality:** one customer can have **multiple HubSpot Instances** (e.g. Production + Sandbox; two-Production is a known future state). Model `instances` as a child of `customers` (one-to-many) — do **not** collapse to one row per customer. Sandboxes are excluded from most reporting.

Suggested cross-ref tables:
- `customer_stripe_ids (allmoxy_customer_id, stripe_customer_id, kind)` — kind ∈ {customer, subscription, custom_domain_subscription}
- `customer_hubspot_resolution (allmoxy_customer_id, hubspot_company_id, resolved_via, resolved_at)`
- `hubspot_company_merge_map (old_company_id, new_company_id)`

---

## 4. Core entity tables to build

Money = `numeric(14,2)`; ids = `bigint`/`text` as appropriate; dates = `date`/`timestamptz`. Use enums for status fields. JSONB is fine for genuinely variable nested data initially (e.g. raw payloads), but the fields below should be real columns.

### `customers` (dimension) — one row per `allmoxy_customer_id`
Identity + enrichment (from `customer_profiles` snapshot):
`allmoxy_customer_id` (PK), `name`, `installer_id`, `installer_directory`, `harvest_id`, `master_classification_name`, `primary_segment`, `sub_segment`, `cohort_year`, `sign_up_date`, `first_payment_date`, `last_payment_date`, `status` (active/at_risk/churned/never_paid), `active_today`, `pay_status`, `contract_status`, `churn_reason`, `vip_legacy_customer`, `allmoxy_main_poc`, `instance_owner`, lifecycle/launch fields (`is_launched_per_hubspot`, `actual_launch_date`, `goal_launch_date`, `cs_start_date`), HubSpot owner fields, and `customer_health_cs_pulse`.

> Lifetime/current revenue rollups (`lifetime_total`, `current_subscription_mrr`, etc.) and `monthly_history` on the current snapshot are **derived** — compute them as views over `transactions`/`monthly_revenue`, don't store on the dimension.

### `instances` — one row per HubSpot Instance (child of customers)
From `renewal_management` + `hubspot_instances`: `instance_id` (PK), `allmoxy_customer_id` (FK), `account_name`, `installer_id`, `status`/`pay_status`, `contract_status`, `contract_length_months`, `monthly_flat_fee`, `renewal_date` (+ `calculated_renewal_date`, `renewal_date_manual`), `payment_start_date`, `payment_pause_date`, `instance_creation`, `merchant_connect_date`, `goal_launch_date`, `is_launched`, `is_sandbox` (bool), `hubspot_owner_id`.

### `transactions` (fact — cash basis) — from Stripe
`id` (PK), `allmoxy_customer_id` (FK), `stripe_subscription_id`, `created` (timestamptz), `amount`, `amount_refunded`, `net_amount`, `type` (subscription/services/connect/other), `status` (succeeded/failed/…), `description`. Keep **cash basis** here so it reconciles to Stripe/QB.

### `monthly_revenue` (fact — accrual basis) — per customer × month × stream
`allmoxy_customer_id`, `month` (date, 1st), `subscription`, `services`, `connect`, `total`. This is the accrual view that the `monthly_history` map represents today. **Annual payers** are amortized (amount/12 across 12 months) and **lump catch-up payments** are reallocated across the months they cover — see §6 (`overrides_transaction`) and §7. Keep cash in `transactions`, accrual here.

### `quotes` — HubSpot Quotes
`quote_id` (PK), `allmoxy_customer_id` (FK via company association), `title`, `status` (DRAFT/APPROVAL_NOT_NEEDED/…), `amount`, `currency`, `created_date`, `expiration_date`, `hubspot_url`.

### `orders_verified` — per customer × year (+ monthly avg)
From the Orders Verified xlsx: `allmoxy_customer_id`, `year`, `order_count` (**nullable — 2026 has $ only**, see §7), `total_usd`, `subtotal_usd`, plus customer-level `live_date` (**year-granular**), `live_date_source`, `is_launched`, `months_to_launch`, `total_lifetime_orders`, monthly-average series. Consider `orders_verified_year (customer, year, …)` + `orders_verified_customer (customer, live_date, is_launched, …)`.

### Implementation (services) — JIRA + Harvest
- `jira_epics (epic_key PK, allmoxy_customer_id FK, summary, status/stage, stage_category, assignee, project)`
- `jira_tasks (task_key PK, epic_key FK, summary, status, stage_category, assignee, created, updated, due_date, url)` — **task dates drive the schedule**.
- `harvest_projects (project_id PK, allmoxy_customer_id FK via client_id, name, bill_by, is_billable, hourly_rate, fee)`
- `harvest_time_entries (id PK, project_id FK, spent_date, hours, billable, billable_rate)` — aggregate to hours/$ in a view.

### Reference / lookup tables
`segments`, `classifications`, `hubspot_owners (owner_id, name, email)`, `metric_definitions`.

### Churn & health
`churn_reasons` (HubSpot playbook taxonomy), `churn_inferences` (AI-classified, with `evidence_quote`, confidence), `churn_subpatterns`, `churn_corpus` (notes/engagements text), and `health_scores` (5-signal risk matrix inputs + tier/score). Most of churn_risk_matrix and customer_health are **derived** (§5).

---

## 5. Derived metrics → build as VIEWS (logic spec = the existing `.mjs` builders)

Do not hand-maintain these; compute from the entity + override tables. Materialize the expensive ones.

| View | Grain | Source builder (spec) |
|---|---|---|
| `mrr_by_month`, `subscription_by_month`, `services_by_month` | month | `build_subscription_by_month.mjs`, `parse_services.mjs` |
| `mrr_waterfall` (new/expansion/contraction/churn) | month | `build_waterfall*.mjs` |
| `cohort_retention`, `net_revenue_retention` | cohort/month | `build_full_cohort.mjs` |
| `pnl_by_month`, `ebitda_bridge`, `adjustments_register` | month | `build_pnl.mjs`, `build_ebitda_bridge.mjs` |
| `unit_economics` | customer/segment | `build_unit_econ.mjs` |
| `renewal_management` (+ `action_tag`) | instance | `build_renewal_management.mjs` — **`action_tag` precedence:** Paused → Contraction(red tier) → Expansion(orders YoY ≥ +20%) → Contraction(≤ −20%) → Watch(yellow) → Stable |
| `time_to_value` (gym_member/onboarding/launched_dormant/…) | customer | `build_time_to_value.mjs` |
| `churn_risk_matrix` (tier red/yellow/green, ARR at risk) | customer | `build_churn_risk_matrix.mjs` |
| `customer_health` | customer | `build_customer_health.mjs` |
| `connect_by_customer_month`, `connect_by_month` | customer/month | Stripe Connect attribution (`apply_connect_attribution.mjs` is authoritative) |
| `implementation` (+ time-to-first-order, SLA, Gantt) | customer/ticket | `build_implementation.mjs` |
| `data_cleanup` | issue | `build_data_cleanup.mjs` |
| `stripe_qb_reconciliation` | month | `build_stripe_qb_reconciliation.mjs` |

---

## 6. Human-decision / override tables (THE reason to move off JSON)

These are currently JSON files in `_etl_scripts/` that humans edit (staged in the app via localStorage, then committed + rebuilt). In Postgres each becomes a **table the app writes to directly**, with audit columns: `created_by`, `created_at`, `updated_at`, and ideally a `source` note. Views in §5 must read these.

| Current file | Becomes table | Holds |
|---|---|---|
| `customer_overrides.json` | `overrides_customer_field` | per-customer field corrections |
| `customer_status_overrides.json` | `overrides_customer_status` | active/churned/etc. overrides |
| `annual_payer_ids.json` (in `src/data/`) | `overrides_annual_payer` | flag customers paying annually (drives amortization) |
| `bid_only_customers.json` | `overrides_bid_only` | bid-only flag (affects risk scoring) |
| `transaction_overrides.json` | `overrides_transaction` | lump-payment **reallocation** across months (accrual) |
| `stripe_id_overrides.json` | `overrides_stripe_id` | manual Stripe-customer → Allmoxy mappings |
| `connect_customer_overrides.json` (in `src/data/`) | `overrides_connect_mapping` | Connect account name → customer |
| `churn_subpattern_overrides.json` | `overrides_churn_subpattern` | manual churn sub-pattern tags |
| `jira_customer_overrides.json` | `overrides_jira_customer` | JIRA epic → `allmoxy_customer_id` |
| `implementation_schedule_overrides.json` | `overrides_implementation_schedule` | meeting-set priority + per-ticket start/end |
| `data_cleanup_resolutions.json` | `data_cleanup_resolutions` | accepted cleanup suggestions (suppress issue + record decision) |
| `ebitda_adjustments.json`, `annual_amortization_overrides.json`, `variance_overrides.json`, `synthetic_transactions.json` | `overrides_*` / `manual_*` | QoE adjustments, amortization, synthetic txns |

> Design note: each override table should be keyed by the entity it modifies (`allmoxy_customer_id`, `instance_id`, `transaction_id`, `epic_key`, `task_key`, or a `category:identifier` for cleanup) so the derived views can `LEFT JOIN` and apply the override deterministically.

---

## 7. Non-obvious business rules that MUST survive the migration

These are easy to get wrong and have caused real bugs. Encode them in the transforms/views and document them as comments/constraints:

1. **`pay_status = 'Cancelled'`** means the HubSpot Churn *Playbook* was completed — **not** that revenue = $0. Do not auto-flip such customers to churned/zero. Decide per-case.
2. **`pay_status = 'Active - Pause Granted'`** = an agreed, legitimate pause. **Exclude** from churn-risk and time-to-value cohorts (not a churn signal).
3. **2026 order counts are unavailable** — the monthly source has **$ only, not counts**. `order_count` must be **nullable** and null for 2026; never infer 0.
4. **HubSpot Company ID:** Sync Sheet **Column B is authoritative**; the core file's copy freezes/rots. Use the 3-stage resolver (§3) incl. the merge-redirect map.
5. **Transaction reallocation (accrual vs cash):** lump catch-up payments are split across the months they cover in the **accrual** (`monthly_revenue`) view, while `transactions` stay **cash basis** (so they reconcile to Stripe/QB). Two grains, two truths — keep both.
6. **Annual payers** are amortized as amount/12 across 12 months starting the payment date, so MRR doesn't spike.
7. **Connect attribution** has an authoritative mapping step — re-applying customer-profile rebuilds without it drops attribution. Bake it into the model, not a post-step.
8. **`live_date` is year-granular** (Orders Verified) — time-to-first-order is therefore approximate; the sign-up→today clock is exact. Don't present year-level as day-level.
9. **Multi-instance** (§3): never collapse a customer's instances; sandboxes excluded from reporting.

---

## 8. Data quality — turn invariants into constraints/tests

The pipeline already runs invariant tests (`run_invariant_tests.mjs` → `invariant_test_results`). Port these to Postgres as FK constraints, CHECKs, and/or dbt tests:
- **Reconciliation:** `mrr_by_month` subscription ≈ Σ `monthly_revenue.subscription` (last 24 months, ±0.5%). *(Currently slightly out — investigate during migration.)*
- Every `overrides_annual_payer` row has a contract link.
- FK integrity: every `instance`, `transaction`, `quote`, `harvest_project`, `jira_epic` resolves to a real `allmoxy_customer_id`.
- Uniqueness: at most one **Production** instance per customer today (flag two-Production as a watch, not an error).
- No orphaned Connect mappings (the `connect_mapping_orphan` cleanup check).

---

## 9. Suggested phasing

1. **Schema + load from snapshots.** Stand up staging + modeled tables; load directly from today's JSON snapshots (they're a clean, current dataset). Gets Postgres populated without touching live sources. Validate row counts + the §8 invariants.
2. **Repoint syncs to Postgres.** Move `sync_hubspot` / `sync_harvest` / `sync_jira` (+ Stripe/QB/core xlsx loaders) to write into staging tables instead of `cache/` JSON.
3. **Replace builders with views.** Re-implement §5 builders as SQL views/materialized views; verify outputs match the snapshots field-for-field before cutover.
4. **Move overrides to tables + app writes.** Replace the localStorage→JSON→rebuild loop with real writes to the §6 tables (with auth/audit). This is the payoff — edits become durable and multi-user immediately.
5. **App reads via an API.** Expose Postgres through an API layer (PostgREST / Hasura / a small serverless API). The React app swaps `useSheetTab(<snapshot>)` for API calls returning the same shapes.

---

## 10. Open decisions for the team

- **Transform tool:** raw SQL views vs **dbt** (recommended for the §5 derived layer + §8 tests + lineage).
- **App read path:** PostgREST / Hasura / custom API? Affects how `useSheetTab` is replaced.
- **Refresh cadence:** which views are real-time vs nightly materialized? (Stripe/HubSpot syncs, order xlsx drops.)
- **Source-of-truth ownership:** which fields are owner-editable in-app (→ override tables) vs sourced (→ read-only)?
- **History:** load full history from snapshots, or backfill from source systems where available?
- **Auth/audit:** who can write overrides; do we need change history (temporal tables)?

---

## 11. Deliverables checklist for the data engineer

- [ ] Staging schema per source system (idempotent loads)
- [ ] `customers` dimension + cross-ref tables (§3) with the 3-stage HubSpot resolver + merge map
- [ ] `instances`, `transactions` (cash), `monthly_revenue` (accrual), `quotes`, `orders_verified`, implementation (JIRA+Harvest), churn/health entity tables (§4)
- [ ] Override tables with audit columns (§6), seeded from the current JSON files
- [ ] Derived views/materialized views matching each computed snapshot (§5), validated field-for-field
- [ ] Business rules from §7 encoded + commented
- [ ] Invariant/DQ tests from §8
- [ ] Reconciliation report: Postgres views vs current JSON snapshots (sign-off before cutover)

> **Reference while building:** the `.mjs` files in `_etl_scripts/` are the executable spec for every transform; the snapshot JSON in `public/snapshots/` is the expected output to validate against; `MEMORY`/CLAUDE notes capture the §7 semantics.
