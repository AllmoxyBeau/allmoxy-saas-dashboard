# Allmoxy SaaS Dashboard

Opinionated, exit-grade SaaS metrics dashboard for Allmoxy. Data lives in committed JSON snapshots that Claude refreshes on-demand by reading the source Google Sheets (fed by Coefficient from SQL / HubSpot / Stripe / QuickBooks / Harvest). The dashboard itself is a pure static site — no backend, no secrets.

- **Frontend:** React 18 + Vite + MUI v5 (Allmoxy dark theme)
- **Data:** committed JSON snapshots in `src/data/snapshots/` — one per curated tab
- **Refresh:** ask Claude (*"refresh classification_master"* or *"refresh everything"*). Claude reads the Sheet via the Drive connector and writes the JSON.
- **Hosting:** any static host (Vercel, Netlify, Cloudflare Pages, S3 + CloudFront) — `npm run build` produces a self-contained `dist/`.

Full architectural context lives in `../SaaS-Dashboard-Project-Plan.md`.

---

## Quick start

```bash
npm install
npm run dev         # vite on :3000
```

Open **http://allmoxy-saas-dashboard.localhost:3000**. No env vars, no service accounts, nothing to configure.

---

## Refreshing data

When the numbers need updating, ask Claude in this repo:

- *"Refresh classification_master"* — pulls one tab
- *"Refresh all snapshots"* — loops through every tab in [src/data/manifest.ts](src/data/manifest.ts)
- *"Add mrr_waterfall as a new snapshot"* — pulls a tab that isn't wired yet and adds it to the manifest

Claude will:

1. Read the Sheet via the Google Drive MCP connector (you granted this once at connector setup)
2. Parse headers + rows into the `SheetTabResponse` shape
3. Write / overwrite `src/data/snapshots/{tab}.json`
4. Vite HMR picks it up live — the dashboard re-renders with the new numbers

For hosted viewers, commit the updated JSON and redeploy (`git push` → whatever static host you've wired up).

### Which Sheets feed which snapshots

From `../SaaS-Dashboard-Project-Plan.md` §5:

| Sheet | File ID |
|---|---|
| Allmoxy - Meta Data Reconcile Tool | `18RR86SKihlhx9qa1LyP59XaxRKkOHbAx00NnbE7iV30` |
| QuickBooks Sync (P&L by Month) | `1kpslwvwkczgm5LzTisrxD6N6T8JOVpzV6WfJjFYtg78` |
| Stripe Connect 2018–2019 | `13lM8xxyEi0z8JbyGnB9bM6c7GCPyDNV9DQInNKgOJbc` |
| Stripe Connect 2020–2021 | `1ccaPs6fvAvHH64DJfmyBNpntNlt-TZMePalrkgucGFY` |
| Stripe Connect 2022–2023 | `1wXKDKLfYf9fkV5zN_CnO0cyERVDYlozI-nCoIr0-3RI` |
| Stripe Connect 2024 | `1PUVgothQMpbj6QcHZQ0nuQIGIuDbYdb4eXgMrWTpXeE` |
| Stripe Connect 2025 | `1fWkT8fpM7V8FqRwAubZWUlcCIEsdtHT4OZXoK15KW1k` |
| Stripe Connect 2026 | `1IZz8yoeJ1CiSmHa_pKw1LsI3jsONVw94ZMzn-JSoMok` |

All tabs currently live in the first Sheet (Meta Data Reconcile Tool). QuickBooks and Stripe Connect feeds come online in Phase 2.

---

## Project structure

```
allmoxy-saas-dashboard/
├── src/
│   ├── data/
│   │   ├── manifest.ts           # tab name → JSON loader
│   │   └── snapshots/            # committed JSON, one per tab (refreshed by Claude)
│   │       └── classification_master.json
│   ├── theme/allmoxyTheme.ts     # MUI v5 theme (Electric Blue / Midnight / Gunmetal)
│   ├── components/
│   │   ├── layout/               # AppShell + Header + NavTabs
│   │   └── common/               # PageHeader, ModulePlaceholder
│   ├── pages/                    # 8 modules (NorthStar live, 7 placeholders)
│   ├── hooks/useSheetTab.ts      # TanStack Query wrapper around loadSnapshot()
│   ├── lib/queryClient.ts
│   ├── App.tsx                   # Routes
│   └── main.tsx                  # ThemeProvider + QueryClientProvider entry
├── vite.config.ts
├── tsconfig.json
└── README.md
```

---

## Hosting

`npm run build` produces a static `dist/` with the JSON snapshots baked in. Drop it on any static host — no server, no env vars, no API keys.

For view-only access by teammates / advisors, use the host's auth (Vercel password protection, Cloudflare Access, Netlify identity, etc.) — the app itself has no auth layer because it has nothing worth authenticating against.

---

## Roadmap

| Phase | Weeks | Scope |
|---|---|---|
| Phase 0 (parallel) | Days 1–5 | Build curated Sheet tabs (mrr_waterfall, services_waterfall, connect_waterfall, connect_customer_map, unit_economics, customer_health, efficiency, segments, benchmarks, ma_readiness, config, recast_ebitda) |
| **Phase 1 — this scaffold** | Week 1 | Shell + snapshot pipeline + North Star live ✓ |
| Phase 2 | Week 2 | Parsers, Revenue Waterfall, Cohort Retention, benchmarks |
| Phase 3 | Week 3 | Unit Economics, Customer Health, Efficiency, Segments |
| Phase 4 | Week 4 | Scheduled daily refresh skill, M&A Readiness, hosting cutover |
| Phase 5 | Week 5 | Empty/loading/error states, PNG export, manual refresh, prod launch |

---

## Design system

Don't deviate from `src/theme/allmoxyTheme.ts`. Every UI decision on this repo should flow through the `allmoxy-brand-mui` skill. Short version:

- **Colors:** Electric Blue `#2C73FF` · Midnight `#0D1117` · Gunmetal `#161B22` · Slate `#21262D` · Cloud `#8B949E`
- **Font:** Roboto only. Never `textTransform: uppercase` on buttons.
- **Shape:** `borderRadius: 6` everywhere.
- **Paper:** always `backgroundImage: 'none'` (MUI v5 gradient override).

---

## Key architectural rules

1. **The repo is the source of truth at refresh time.** Snapshot JSON commits represent what the dashboard shows — buyers, advisors, and CI all see exactly what's been reviewed and merged.
2. **Three layers, one concern each.** Coefficient → Sheet. Sheet → Claude-written JSON. JSON → React. No short-circuits.
3. **Every page answers one of the three questions.** Healthy? Efficient? Exit-ready? The `PageHeader` component surfaces this on each module — if a module can't answer one, cut it.
4. **Always show the stream breakdown.** Never report a single blended revenue number without one-click access to the MRR / Services / Connect split. Buyers price each stream differently.
