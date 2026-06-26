# Meta-File → API Migration Plan

**Goal:** retire the manual upload of *Allmoxy – Meta Data Reconcile Tool.xlsx* by pulling each underlying source directly from its API, and (once no human upload is required) move the refresh from manual to scheduled.

**TL;DR:** the workbook is a *reconciliation hub* over five upstream systems. Three of them (Stripe, HubSpot, Harvest) we can connect to **today** — the credentials already exist. Two (the Allmoxy application DB, QuickBooks) need new access. Most of the workbook's tabs aren't real sources at all — they're spreadsheet rollups that the ETL already recomputes, so they disappear automatically once the raw sources are API-direct.

---

## 1. How the ETL works today

- **Trigger: manual.** There is no cron, GitHub Action, or Vercel cron. The flow is: someone uploads a new xlsx → runs `npm run refresh`.
- `npm run refresh` (`refresh_and_commit.mjs`) runs: HubSpot sync (≈3 min, skippable) → `refresh_all.mjs` (rebuilds **all** snapshots) → apply overrides → invariant tests → `git commit` → `git push` (Vercel auto-deploys ~90s later). Flags: `--no-hubspot`, `--no-commit`, `--no-push`, `--stripe`.
- **Snapshot builds = full rebuild every run.** The whole workbook is re-parsed and every snapshot recomputed from scratch — deterministic and idempotent. Cheap at ~600 customers.
- **External API pulls = cached + gated.** Each integration writes to `_etl_scripts/cache/*.json`; builds read the cache. Slow network pulls only fire on request (HubSpot unless `--no-hubspot`; the ~1 hr Stripe Connect pull only with `--stripe`). So we never re-pull everything every run.

The API migration **keeps this model** — it only swaps the *raw source* of each slice from "a tab in the uploaded xlsx" to "a cached API pull."

---

## 2. Source-by-source map

| Workbook tab(s) | Upstream system | API today? | Notes |
|---|---|---|---|
| **Stripe Sync** (22k rows), **Stripe Subscriptions**, **Refunds**, and the derived **MRR by Month / New MRR / Renewals MRR / cohort $ / Annual Cohort Summary** tabs | **Stripe** | ✅ key in `.env.local` | The MRR/cohort/refund tabs are pivots over Stripe charges that the ETL already recomputes. Pulling charges + subscriptions retires all of them. Highest-volume manual piece. |
| **Hubspot Instance Sync Sheet**, **Hubspot Transition Sheet** (pay_status, payment_stop_date, churn_reason), **Deals** | **HubSpot** | ✅ token in `.env.local` | `sync_hubspot.mjs` already pulls companies, the Instance custom object (live pay_status), owners, quotes. Extend to transition/churn fields + Deals. |
| **Harvest** (2.2k rows) | **Harvest** | ✅ token in `.env.local` | `sync_harvest.mjs` already pulls Harvest for the Implementation feature. |
| *(Stripe Connect Revenue — separate file)* | **Stripe** | ✅ done | `sync_stripe_connect.mjs` already pulls it live (application fees → GMV + take rate). |
| **allmoxy_core_customer** (roster), **Installer Info** (instances / realms / sandbox), **Master Classification** (the identity join) | **Allmoxy app DB** (MySQL) | ⚠️ needs access | The one source that's *yours* but not yet exposed. Needs a read-only DB connection or an internal Allmoxy endpoint. This is the Postgres-backend territory. |
| **QuickBooks CAC Info** (P&L behind unit economics) | **QuickBooks** | ⚠️ depends | QuickBooks **Online** has a clean API; **Desktop** (which onboarding notes reference) does not — would need middleware (Codat/Rutter) or a QBO move. Confirm the edition. |

**Derived rollups** (Services by Month, MRR/New MRR/Renewals, Refunds, cohort tabs, retention summaries) are **not** independent sources — they're spreadsheet math over Stripe data. Once Stripe is API-direct they leave the upload entirely; the dashboard already computes these.

---

## 3. Phased plan

### Phase 1 — Stripe + HubSpot + Harvest (no new access needed)
Credentials already exist. Build/extend three sync scripts following the existing cache+gate pattern:
- `sync_stripe.mjs` — Charges + Subscriptions + Refunds → `cache/stripe_*.json`. Incremental after first backfill (`created > last cursor`).
- extend `sync_hubspot.mjs` — add Transition/churn fields + Deals to the existing pull.
- `sync_harvest.mjs` — already exists; confirm it covers the Harvest tab's needs.

**Retires:** Stripe Sync, Stripe Subscriptions, Refunds, every MRR/cohort rollup, HubSpot Instance Sync, Transition, Deals, Harvest. → the majority of the workbook.

### Phase 2 — Allmoxy DB + QuickBooks (needs eng/decisions)
- **Allmoxy DB:** stand up a read-only connection (or internal API) for the customer roster, installer instances, and identity fields. Until then this slice stays a (much smaller) manual export.
- **QuickBooks: deferred for now (decided 2026-06).** The QuickBooks CAC Info P&L stays a manual export until there's a reason to revisit (and an edition decision: QBO → direct API; QBD → Codat/Rutter middleware).

After Phase 1, the upload shrinks to **just the Allmoxy-DB roster + the QuickBooks P&L** — two slices instead of the whole reconcile tool.

---

## 4. Sync architecture (every new connector follows this)

1. **Cache** raw API responses to `_etl_scripts/cache/<source>.json` — never persist the full firehose in snapshots.
2. **Gate** the slow pulls behind a flag (`--stripe`, etc.) so they don't run on every build.
3. **Incremental** where the API supports it: store a cursor/`last_synced_at`, fetch only new/changed records, merge into the cache. (First run = full backfill; later runs = seconds.)
4. **Recompute** snapshots from the cache exactly as today — the build layer is unchanged.

---

## 5. Triggering & scheduling

Today the trigger is manual *because a human uploads the file.* Once the data is API-direct, that constraint is gone, so the refresh becomes schedulable:

- **Keep manual:** `npm run refresh` on demand (you control timing).
- **Schedule it (recommended once Phase 1 lands):** a nightly **GitHub Action** runs `npm run refresh --stripe` — incremental pulls, full rebuild, commit, push, auto-deploy — with zero human steps. The expensive pulls stay incremental, so a nightly run is cheap.

This is the real payoff: a **self-updating dashboard** instead of "upload → run."

---

## 6. The one thing to watch — reconciliation ownership

The workbook's actual job (its name says it) is to **reconcile one customer's identity across Stripe ↔ HubSpot ↔ Allmoxy ↔ Harvest**. Going API-direct means that join logic moves fully into our ETL. We already do most of it (the 3-stage HubSpot company-ID resolver, the Stripe-account→customer mapping, name normalization), but it becomes load-bearing.

**Cutover approach:** during the transition, keep generating the sheet and **diff the API-built snapshots against it** until they reconcile cleanly for a few cycles. Then drop the manual upload source-by-source, not all at once.
