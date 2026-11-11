# Refreshing snapshot data

This file is the single source of truth for regenerating `public/snapshots/*.json`.
It exists because the data layer is decoupled from the source code — a fresh
clone of this repo needs somewhere to learn *where the numbers come from*.

---

## Prerequisites

Before starting a refresh:

1. **Google Drive MCP connector is enabled** in your Claude Code session.
2. **You are signed into a Google account with access to** all Sheets listed in
   §Source Sheets below (the primary Sheet is owned by `beaulewis1@gmail.com`).
3. You are running Claude Code from this directory:
   `/Users/beaulewis/projects/2 - Allmoxy - CFO/allmoxy-saas-dashboard/`

If you don't have access to the Sheets, the alternative is to re-download
the XLSX exports (`Allmoxy - Meta Data Reconcile Tool.xlsx` and
`Stripe Connect Revenue 2026.xlsx`) into the parent folder and run the ETL
scripts in `_etl_scripts/` locally.

---

## Source Sheets

Full details live in `../SaaS-Dashboard-Project-Plan.md` §5.0.
Summary:

| Role | File | File ID |
|---|---|---|
| **Primary** (customer-level, MRR, Services, cohort, classification) | Allmoxy - Meta Data Reconcile Tool | `18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30` |
| **Financials** (GAAP P&L by month Jan 2018 → Dec 2028) | QuickBooks Sync | `1kpslwvwkczgm5LzTisrxD6N6T8JOVpzV6WfJjFYtg78` |
| Stripe Connect 2018–2019 | affiliate revenue | `13lM8xxyEi0z8JbyGnB9bM6c7GCPyDNV9DQInNKgOJbc` |
| Stripe Connect 2020–2021 | affiliate revenue | `1ccaPs6fvAvHH64DJfmyBNpntNlt-TZMePalrkgucGFY` |
| Stripe Connect 2022–2023 | affiliate revenue | `1wXKDKLfYf9fkV5zN_CnO0cyERVDYlozI-nCoIr0-3RI` |
| Stripe Connect 2024 | affiliate revenue | `1PUVgothQMpbj6QcHZQ0nuQIGIuDbYdb4eXgMrWTpXeE` |
| Stripe Connect 2025 | affiliate revenue | `1fWkT8fpM7V8FqRwAubZWUlcCIEsdtHT4OZXoK15KW1k` |
| Stripe Connect 2026 | affiliate revenue | `1IZz8yoeJ1CiSmHa_pKw1LsI3jsONVw94ZMzn-JSoMok` |

---

## Snapshot → source mapping

Each row describes how one `public/snapshots/<name>.json` is produced.

| Snapshot | Source | How |
|---|---|---|
| `allmoxy_core_customer.json` | Primary Sheet tab `allmoxy_core_customer` | Raw dump in SheetTabResponse shape |
| `classification_master.json` | Primary Sheet tab `classification_master` | Raw dump |
| `mrr_by_month.json` | Primary Sheet tab `MRR by Month` | Parse wide-format matrix; keep as-is |
| `services_by_month.json` | Primary Sheet tab `Services by Month` | Parse wide-format matrix; keep as-is |
| `subscription_by_month.json` | Primary Sheet tab `MRR by Month` | Derived — `_etl_scripts/build_subscription_by_month.mjs` pivots to tall format |
| `cohort_retention.json` | Primary Sheet tabs `cohort_retention_dollar` + `cohort_retention_pct` + `cohort_lifetime` | Derived — `_etl_scripts/build_cohort.mjs` or `build_full_cohort.mjs` |
| `customer_health.json` | Primary Sheet (classification_master, stripe_charges, companies_aggregated) | Derived — `_etl_scripts/build_customer_health.mjs` |
| `customer_profiles.json` | Primary Sheet + stripe data | Derived — `_etl_scripts/build_customer_profiles.mjs` (~4.8 MB output; join of classification, MRR, Services, Connect, payments) |
| `customer_profiles_roster.json` | Same as `customer_profiles.json` | Derived — `_etl_scripts/build_roster.mjs` (trimmed roster view) |
| `connect_by_customer_month.json` | Union of all 6 Stripe Connect Sheets, `Month to Month` tab | Derived — `_etl_scripts/build_connect_by_customer.mjs` + `match_connect_customers.mjs` |
| `connect_by_month.json` | Same as above | Derived — monthly totals from the union |
| `mrr_waterfall.json` | `MRR by Month` | Derived — `_etl_scripts/build_waterfall.mjs` (New / Expansion / Contraction / Churn / Reactivation) |
| `unit_economics.json` | cohort retention × QuickBooks P&L (S&M spend lines 6050, 6300, 6310; COGS 5000/5200/5300/5400) | Derived — `_etl_scripts/build_unit_econ.mjs` |

Manual overrides (not regenerated — edit by hand):
- `src/data/annual_payers.json`
- `src/data/connect_customer_overrides.json`

Optional snapshot (requires HubSpot Private App token):
- `churn_corpus.json` — produced by `_etl_scripts/build_churn_corpus.mjs`. Pulls every note / email / call / task / ticket from HubSpot for each churned customer. `refresh_all.mjs` runs it automatically when `HUBSPOT_TOKEN` is set in the environment, and skips it cleanly otherwise. To enable:
  1. Create a HubSpot Private App (Settings → Integrations → Private Apps) with the scopes listed in `.env.sample`.
  2. Paste the token into `.env.local` as `HUBSPOT_TOKEN=pat-na1-...`.
  3. Before refresh: `set -a; source .env.local; set +a; node _etl_scripts/refresh_all.mjs`
  4. First pull takes 5–15 minutes (rate-limited at 5 req/sec). Subsequent pulls are similar — there's no incremental mode yet.

---

## One-command refresh prompt

Start a new Claude Code session in this directory, then paste this prompt:

> Refresh all snapshots in `public/snapshots/` per `REFRESH_DATA.md`.
> Use the Google Drive MCP connector to read the Sheets by the file IDs in
> this doc, then run the ETL scripts in `_etl_scripts/` to produce the derived
> snapshots. Run in this order:
>
> 1. Raw tab pulls (no dependencies): `allmoxy_core_customer`, `classification_master`, `mrr_by_month`, `services_by_month`.
> 2. Connect union: pull `Month to Month` from all 6 annual Connect Sheets, union them, run `build_connect_by_customer.mjs` and `match_connect_customers.mjs`.
> 3. Derived primary: `subscription_by_month`, `cohort_retention`, `mrr_waterfall`.
> 4. Aggregated: `customer_profiles`, `customer_profiles_roster`, `customer_health`.
> 5. Financial-joined: `unit_economics` (reads QuickBooks Sync Sheet).
>
> After each batch, spot-check one value against the source Sheet (e.g. total
> MRR for the latest month against the `Total MRR` row of the `MRR by Month`
> tab). Commit when every snapshot is regenerated and the dev server renders
> without errors.

---

## One-off refresh prompt (single snapshot)

> Refresh `<snapshot_name>` per `REFRESH_DATA.md`. Read the source tab(s) via
> Google Drive MCP, run the relevant ETL script from `_etl_scripts/`, write the
> output JSON, and verify the dev server picks it up.

---

## Manual fallback (no MCP)

If Google Drive MCP isn't available:

1. Open each Sheet in a browser, `File → Download → Microsoft Excel (.xlsx)`.
2. Drop the files in `/Users/beaulewis/projects/2 - Allmoxy - CFO/`.
3. Ask Claude to run the ETL scripts against those XLSX files. Most of the
   scripts in `_etl_scripts/` start with `parse_xlsx.mjs`-style loaders and
   can be adapted. Expect 15–30 minutes of adjustment; the Drive MCP path is
   much faster.

---

## Don't forget

- The `src/data/snapshots/` path mentioned in the old README is stale.
  Current code reads from `public/snapshots/` (set in `src/lib/dataClient.ts`).
- Snapshots are *not* committed to git by default (see `.gitignore`). If you
  want them in git for a diligence-room snapshot-in-time, remove the ignore
  line temporarily, commit, then restore the ignore.
- After a refresh, verify by hitting `http://127.0.0.1:3000/` — each page
  should load without "data missing" errors.
