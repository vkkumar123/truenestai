# TrueNest AI — Architecture v2 (target)

Status: proposed 2026-10-24 by the product manager (Claude) after the staging review.
Supersedes the "Discovery / research" sections of `ARCHITECTURE.md` and the research flow in
`RESEARCH_WORKER.md`. Everything else in `ARCHITECTURE.md` (modular monolith, repository pattern,
access separation, Cloud Run + Supabase) stands. Decisions needed from Fury are marked **[FURY]**.

## 0. Why v2

Staging review (24 Oct): `projects` = 0 rows, Lane B has no production adapter, and the only
data path is a one-shot web-search job that ended `no_results` for both queries ever run.
v1 asked the research agent to build the catalogue one buyer query at a time. v2 makes the
catalogue a seeded, K-RERA-anchored asset that two enrichment loops keep fresh, and makes the
on-demand agent an enricher, not the catalogue's author.

## 1. Product principle (unchanged, now enforced by the data flow)

Buyer-first, provenance-first. Every fact carries `source`, `observed_at`, `last_verified_at`,
`truth ∈ {official, estimated, unknown}` and `verification ∈ {unverified, reviewed, …}`.
Automation never writes `official` + `reviewed`; only staff do. Missing is not negative.

## 2. Source priority (authoritative order)

| Rank | Source | Role | Access (per DATA_SOURCE_POLICY) | Truth it can produce |
|---|---|---|---|---|
| 1 | **K-RERA** (rera.karnataka.gov.in) | Source of record: registration, promoter, dates, extensions, complaints, orders | Manual/staff-initiated only (robots-disallowed for crawlers, D16). Bulk import of K-RERA project lists exported by staff; per-project lookups by staff or by Fury's own browser session. Link-out on every page. | `official` |
| 2 | Government planning authorities (BDA, BMRCL, K-RIDE, KRDCL, NHAI, KIADB, BBMP/GBA, BWSSB, DULT) | Area development plans, infra status | Public notices, tender pages, gazette PDFs, RSS; fetch only where robots allow, else staff-saved PDF | `official` |
| 3 | Builder's own site / brochure / price sheet (via partner) | Project facts, price, possession claims | Fetch if robots allow; partner uploads | `official` (claims by the builder, labelled as builder's claim) |
| 4 | News (Deccan Herald, TOI, The Hindu, Moneycontrol, ET Realty) | Infra timelines, launches, disputes | RSS/web search citations | `estimated` |
| 5 | Web search (Anthropic web search) | Discovery of candidates + citations | API (approved, D16) | `estimated` |
| 6 | Community (Reddit, YouTube comments, Google reviews) | Sentiment signals, "what residents say" | Official APIs | `signals` only, never facts |
| 7 | Listing portals | Price **signal** only | Link-out / discovery-only; never stored verbatim **[FURY: C-item still open]** | `estimated` price range only |

Rule: a fact from a lower-ranked source never overrides a higher-ranked one; it is stored as a
conflict and shown beside it (`facts_current.conflicts`).

## 3. The catalogue is seeded first (P0)

- Staff bulk import (`/admin/import`): upload a K-RERA export (CSV/XLSX the staff downloaded
  from the portal's project search, or a hand-built sheet) → `projects` rows with
  `rera_number`, promoter, locality, dates, status; each imported fact gets
  `source_type='rera'`, `truth='official'`, `verification='unverified'`, `source_url` = the
  K-RERA project URL the staff pasted, `observed_at` = the export date.
- Publish rule stays (D12/D13): a project is published only after an admin marks RERA facts
  `reviewed`. Target for launch: **40–80 published North Bengaluru projects**.
- Geocode on import (builder map link → Google Geocoding → manual pin queue).

## 4. Two enrichment loops, one extraction step

```
                 ┌──────────────────────────────┐
  Loop 1         │ sources registry (cadence/ttl)│  Cloud Scheduler → Cloud Run Job
  scheduled ───▶ │ adapters: govt_notice, news,  │──┐
                 │ builder_site, reddit, youtube,│  │
                 │ google_places, portal_price   │  │
                 └──────────────────────────────┘  │   ┌────────────────────────────┐
                                                    ├──▶│ extraction + resolution    │──▶ facts / signals /
  Loop 2         ┌──────────────────────────────┐  │   │ (aliases, typed facts,     │    developments
  on-demand ───▶ │ research v2: discover → verify│──┘   │ confidence, provenance)    │    + history
  (gap/stale/    │ pushed at enqueue, swept 2-min │      └────────────────────────────┘
   user question)└──────────────────────────────┘
```

- Loop 1 is specs 03/04/06; it runs whether or not a buyer asks. Cadence: govt/news daily,
  builder weekly, community daily, portal price weekly.
- Loop 2 is spec 14 (replaces spec 05 + `RESEARCH_WORKER.md` flow): discover call (candidates
  + URLs; portals allowed for discovery only) → verify call per candidate (developer/govt/news
  pages with citations) → scorer (confidence, not a drop filter) → store as `estimated`.
  Triggered by `fetch()` to the run endpoint at enqueue (or Cloud Tasks) so the buyer waits
  seconds, not minutes; the 2-minute scheduler only sweeps stalled jobs. Page polls
  `/api/research/status`.
- Failure caching: `no_results` 12 h, `failed` 1 h, success 7 days. Staff can force a re-run.
- Diagnostics persisted on `research_jobs` (stop_reason, search blocks, candidates, drop reasons).

## 5. Area potential: 5–10-year development plans (spec 13)

A buyer sees, on every project page and every locality page, a **Potential** section:

- `developments` rows are place-centric with geometry and a **horizon bucket**
  `0–2 y | 2–5 y | 5–10 y | beyond/unscheduled`, derived from `expected_completion` and the
  **status tier** `proposed → dpr_approved → tendered → under_construction → operational`
  (plus `shelved`). Each has `authority`, `source_url`, `completion_history`, `confidence`.
- Plan sources ranked: BDA Revised Master Plan 2041 (zoning, road network, growth corridors),
  BMRCL Phase 2B/3/3A and CMP 2031, K-RIDE suburban rail corridors, Bengaluru Business Corridor
  (PRR), STRR (NHAI), airport expansion (BIAL T3/second runway/aerocity), KIADB Aerospace Park
  & Devanahalli business park, Hennur/Thanisandra/Bellary Road widening, Cauvery Stage V/VI
  coverage, lake rejuvenation, Greater Bengaluru Authority reorganisation.
- Proximity (`project_development_proximity`) gives straight-line distance and 9 AM drive time.
- The area brief (spec 08) composes a dated "Potential" narrative strictly from these rows,
  grouped by horizon, with status tier and revision count on every item, and a caveat line.
- Nothing is called "upcoming" without a tier and a date.

## 6. Search (spec 15)

Intent parser before SQL: locality (aliases), BHK, budget range (₹ L/Cr parsing), builder
(aliases), status, possession-by, free keywords. Free keywords use `pg_trgm` over a
`search_document` column (name + builder + locality + aliases). Only then the gap detector
decides whether research is needed, and for what attribute.

## 7. Module map (additions only)

```
src/ingest/krera-import/      staff bulk import parser + mapper (spec 12)
src/discovery/research/v2/    discover.ts, verify.ts, score.ts, trigger.ts (spec 14)
src/search/intent.ts          intent parser (spec 15)
src/locality/horizon.ts       horizon buckets, potential brief inputs (spec 13)
supabase/migrations/0007_*    search_document + trgm, research diagnostics, developments.horizon
app/api/research/status       poll endpoint
app/admin/import              import UI + review queue
```

## 8. Non-negotiables carried over

CLAUDE.md rules, D16 (no K-RERA crawling), DPDP consent-first leads, no outbound messaging
without approval, secrets never in Git. The spec pack's constitution (`specs/01`) governs the
fact model; the conflict register C1–C25 remains open **[FURY]** and the stricter rule applies
until decided.
