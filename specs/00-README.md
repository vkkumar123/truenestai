# North Bangalore Apartment Intelligence — Agent Specs

These are spec-kit style instruction files for the Claude Code builder agents.
Each file is self-contained: a builder agent should be able to read ONE spec
and produce working code for that component. The reviewer agent checks every
PR against `01-constitution.md` first, then the relevant spec.

## How to use

1. Copy this folder into your repo as `/specs`.
2. Read `01-constitution.md` into every agent's context (CLAUDE.md or system prompt).
3. Build in the order below. Each spec lists its inputs/outputs so later specs
   can be built against the earlier ones' contracts.
4. When a spec needs an MCP server or an API key, it says so at the top under
   **Needs from Fury**. Stop and ask for those before building that spec.

## Build order

| # | Spec | Produces | Depends on |
|---|------|----------|------------|
| 1 | `02-data-model.md` | Supabase schema + BigQuery raw datasets | — |
| 2 | `03-source-registry-and-crawl.md` | Loop 1: scheduled crawl + adapters | 02 |
| 3 | `04-extraction-and-resolution.md` | Raw → typed facts/signals, project_id resolution | 02, 03 |
| 4 | `06-developments-and-proximity.md` | Developments table, geocoding, distances | 02, 04 |
| 5 | `07-cost-estimator.md` | Official / Estimated / Unknown cost sheets | 02, 04, 05 |
| 6 | `05-research-agent.md` | Loop 2: on-demand gap → search → write | 02, 04 |
| 7 | `08-area-brief-generator.md` | Per-project and per-locality briefs | 04, 06 |
| 8 | `09-website.md` | Public site (Next.js/Astro) with capture hooks | 02–08 |
| 9 | `10-whatsapp-qualify-agent.md` | WhatsApp conversation + lead scoring + handoff brief | 02, 05, 09 |
| 10 | `11-lead-handoff-and-reconciliation.md` | Partner handoff, lead IDs, payout reconciliation | 10 |

## v2 additions (2026-10-24, after the staging review) — build these FIRST
| # | Spec | Produces | Replaces / extends |
|---|------|----------|--------------------|
| P0-1 | `12-krera-first-ingestion.md` | K-RERA as source of record via staff import + review queue | seeds 02 |
| P0-2 | `15-search-intent.md` | Intent parser, trgm catalogue match, filter chips | search in 09 |
| P0-3 | `14-research-agent-v2.md` | discover → verify → score, push trigger, status poll, diagnostics, short failure TTLs | **replaces 05 flow** |
| P2 | `13-area-horizon-plans.md` | 5–10-year development plans, horizon tabs, potential brief | extends 06 + 08 |
Order and exit criteria: `docs/PRODUCT_PLAN.md`. Target architecture: `docs/ARCHITECTURE_V2.md`.
Source priority is fixed: K-RERA first, then government planning bodies, builder, news, web search, community; portals are price/discovery signals only.

## Agent roles

- **builder-{spec}**: implements one spec. Branch `feat/{spec-slug}`, PR to `main`.
- **reviewer**: reads constitution + spec, checks the PR, blocks on any
  constitution violation (especially: facts without provenance, estimates
  shown as official, any contact data stored without consent).
- **ops**: owns `Needs from Fury` items — collects keys, sets up MCP servers,
  never commits secrets.

## Stack (fixed unless a spec says otherwise)

- Raw landing + analytics: GCS + BigQuery (dataset `nb_re_raw`, `nb_re_core`)
- Serving store: Supabase Postgres with `postgis` and `vector` extensions
- Jobs: Cloud Run Jobs triggered by Cloud Scheduler; queue = Supabase table
  `research_tasks` polled by a Cloud Run service (swap to Pub/Sub later)
- LLM: cheap model for extraction (batchable), strong model for adjudication,
  brief writing, and the WhatsApp agent
- Web search for research agent: Tavily or Brave Search API
- WhatsApp: WhatsApp Business API via Interakt / AiSensy / Gupshup
- Site: Next.js (App Router, static generation) or Astro; mobile-first
- Micro-market scope for v1: Hebbal, Thanisandra, Jakkur, Yelahanka,
  Hennur, Devanahalli, Bagalur, Kogilu, Sahakar Nagar, Kodigehalli
