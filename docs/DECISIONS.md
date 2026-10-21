# Decisions

Format: context → decision → consequences. Status: `accepted` unless noted. Changes to `src/domain/types.ts` must be proposed here first.

## D1 — Modular monolith — accepted
- **Context:** Small team, one market, fast iteration, strong consistency needs (provenance, consent).
- **Decision:** One Next.js app with internal modules (`server`, `discovery`, `research`, `locality`, `leads`, `growth`) on one Supabase Postgres. Separate runtime only where needed (Python document parsing in `workers/`).
- **Consequences:** Simple deploys and transactions. Module boundaries are enforced by folder ownership and imports, not by the network. Services can be split out later if load requires it.

## D2 — Repository pattern, fixture implementation by default — accepted
- **Context:** No Supabase project yet; CI and reviewers need deterministic data; no real data may be committed.
- **Decision:** Repository interfaces return domain types. The fixture implementation is the default; the Supabase implementation is selected by env. Both pass the same contract tests.
- **Consequences:** M1 is fully buildable and testable without owner action. Fixture data must be fictional (`SAMPLE`, `example.com`). Supabase mode fails loudly if misconfigured.

## D3 — Configurable market geography — accepted
- **Context:** Phase 1 is North Bengaluru; three more Bengaluru phases will follow; boundaries are not yet approved.
- **Decision:** Markets, zones and localities live only in `src/config/markets/`. Nothing else hardcodes localities.
- **Consequences:** Expansion is a config change. Boundary changes need owner approval (see Unresolved).

## D4 — Two-lane discovery and source registry — accepted
- **Context:** Buyers want breadth, but external data is unverified and access may be restricted.
- **Decision:** Lane A (`Project`, researched, provenance per fact) and Lane B (`ExternalListing`, always unverified, with source, URL, dates and limitations). Adapters run only for sources `approved` in the registry with a documented access method. Linking needs strong identifiers.
- **Consequences:** The UI must always distinguish lanes. No scraping until approved. Lane B drives "Request verification" leads.

## D5 — Dev agents vs production workers — accepted
- **Context:** "Agent" is ambiguous between coding assistants and business automation.
- **Decision:** `.claude/agents/*` are development assistants only. Production work runs as scheduled workers or deterministic server functions with logged runs and human review gates; AI produces validated drafts.
- **Consequences:** No autonomous agent touches production data or sends outbound messages. Marketing workflows cannot spend or send.

## D6 — No Agent Teams (experimental) for now — accepted
- **Context:** Agent Teams is an experimental Claude Code feature; parallel subagents with disjoint file ownership already suffice.
- **Decision:** Use orchestrator plus subagents with the ownership map (`AGENT_WORKFLOW.md`), with worktrees when overlap is unavoidable.
- **Consequences:** Revisit when the feature is stable and coordination costs justify it.

## D7 — Next.js 16.4 with `cacheComponents` — accepted
- **Context:** The scaffold installed `next@16.4.2` with `cacheComponents: true` and `partialPrefetching: true` in `next.config.ts`.
- **Decision:** Keep these defaults. Public pages may cache published data; admin, lead and other personalised routes stay dynamic. Engineers read `node_modules/next/dist/docs/` before using Next APIs (APIs differ from older versions).
- **Consequences:** Caching boundaries must be explicit and tested so that no admin or lead data is cached publicly.

## D8 — Domain contract owned by the orchestrator — accepted
- **Context:** Many agents work in parallel against shared types.
- **Decision:** `src/domain/types.ts` is the single contract, edited only by the orchestrator. Proposed changes are recorded here first.
- **Consequences:** Stable interfaces between modules; changes are deliberate and visible.

## D9 — Explicit regulatory searches in the contract — accepted (2026-10-21)
- **Context:** "Searched and none found" must differ from "not yet checked" and from a negative finding.
- **Decision:** `Project.regulatorySearches: RegulatorySearch[]` mirrors the `regulatory_searches` table. Buyer wording comes from `describeComplaintSearch` (never "no complaints").
- **Consequences:** Replaces a magic-string stopgap in the backend.

## D10 — No PostGIS in M1 — accepted (2026-10-21)
- **Context:** The local test Postgres lacks PostGIS; M1 geospatial needs are radius/bbox on few rows.
- **Decision:** `numeric` lat/lng + precision column; pure TS geo helpers in `src/locality/geo.ts`. Add a PostGIS migration with M6 (Supabase supports it).

## D11 — Lead extras stay server-side — accepted (2026-10-21)
- `consentedAt` and qualification live on the server `StoredLead` type and DB columns, not the shared `Lead` contract, until a client needs them.

## Proposed contract notes (not yet accepted)
- P1: `Project.lane` and `ExternalListing.lane` are literal types, which is good for discriminated unions. Consider adding `published` or `hidden` to `ExternalListing` so staff can suppress a listing without deleting it (M4).
- P2: Consider a `Disclosure` type (commercial relationship per project or developer) for M8.
- P3: Consider an audit/`reviewedBy` field on `FactValue` or a separate audit table for M3 (may stay DB-only).

---

## Unresolved assumptions / questions for owner
| # | Question | Assumption in use | Blocks |
|---|---|---|---|
| Q1 | Approve the **North Bengaluru boundary** and locality list | Draft list in `src/config/markets/` (locality-intelligence-engineer) | Public launch |
| Q2 | **Commercial relationship disclosure** wording and placement | Generic disclosure block on detail and compare pages | M1 copy finalisation, M8 |
| Q3 | **Map provider** and billing (OSM tiles, MapTiler, Mapbox, Google) | List/static fallback, no key | M6 |
| Q4 | **Data sources / partners** with permitted access | Fixture adapter only | M4 |
| Q5 | **DPDP Act legal review** of consent text, retention period, withdrawal and grievance process | Versioned consent, separate marketing opt-in, retention date per lead; period TBD | Taking real leads (M2 go-live) |
| Q6 | **Brand name "TrueNest"**: trademark/domain clearance | Used as working name | Public launch |
| Q7 | **Repo visibility**: `vkkumar123/truenestai` is public | Stay public until told; no secrets or real data committed | None (risk item) |
| Q8 | Later phase split (East/South/West?) and order | Three further Bengaluru markets, unnamed | Later phases |
| Q9 | Property types in scope | Residential apartments/villas; no rentals, plots or commercial | Data model scope |
| Q10 | K-RERA automated access permission | Manual staff lookup only | M5 automation |

No legal or regulatory facts are asserted in these docs; any statement about RERA, DPDP or source terms needs the owner or qualified counsel to confirm it.
