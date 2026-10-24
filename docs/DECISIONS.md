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

## D12 — M3 staff research write-model — accepted (2026-10-21)
- **Context:** Staff must add facts with evidence and move them through verification before a project is published.
- **Decision:** Editable fact fields are `address`, `reraNumbers`, `constructionStatus`, `declaredPossession` (units/regulatory records/documents follow in later slices). Every edit needs ≥ 1 https `SourceRef` with an observed date; each change writes a `FactAuditEvent`. Advisors may add facts (always `unverified`) and mark `disputed`/`requires_professional_review`; only admins may set `source_confirmed`/`reviewed` and publish/unpublish. Automated actors can never verify or publish. Publish rules live in `src/research/publish.ts` (assumption pending owner approval).
- **Document upload to Storage** is deferred to M2 (needs Supabase Storage); M3 records document metadata only.

## D13 — Edits to a published project — revised and confirmed by owner (2026-10-21)
- An edit resets that fact to `unverified`. If, after the edit, a published project no longer passes publish readiness (e.g. RERA numbers changed and are unverified), it is **automatically unpublished** with an audit event (`unpublished`, note "auto: failed readiness after edit") until an admin re-verifies and republishes. Edits that keep readiness (e.g. address) stay live, shown as Unverified. Only admins may clear a `disputed` state.
- Superseded first version: "edits keep the project published" (rejected in M3 review: legally significant facts could go live unreviewed).

## D14 — Workaround for Next 16.4 dev-mode cookies() invariant after no-JS action posts — accepted (2026-10-21)
- A failed, non-revalidating server action posted without JS leaves the request in the action phase; `cookies()` then throws an InvariantError in dev. Staff actions call `ensureRenderPhaseAfterAction()` (`src/server/actions/mpa.ts`) which revalidates the admin path. `getStaffSession()` now rethrows unexpected errors instead of treating them as signed-out. Remove the workaround when Next fixes it upstream.

## D15 — Document metadata visibility — accepted (2026-10-22)
- Document metadata (title, kind, version, date, source URL) on a **published** project is public as soon as staff upload it; the file itself stays private (staff-only signed URLs). Any staff role may upload. Accepted for M2 because only staff can upload and published projects are admin-controlled; a per-document review flag (admin-approved before public display) is planned with the document-review slice. Raised as L3 in the M2 review.

## GCP hosting — Cloud Run + Supabase — accepted by owner (2026-10-21)
- **Context:** The owner wants production on GCP before going live. The schema, RLS (`auth.uid()`), staff auth and document storage are built on Supabase.
- **Decision:** Run the Next.js app on Cloud Run (`asia-south1`) from a standalone-output container; keep Postgres, Auth and Storage on Supabase (`ap-south-1`). Infra as code in `infra/terraform`; deploys from GitHub Actions via Workload Identity Federation (no keys); secrets in Secret Manager. Custom domains go through a global HTTPS load balancer with Cloud Armor (Cloud Run domain mappings are not offered in `asia-south1`).
- **Rejected for now:** Cloud SQL + Identity Platform + Cloud Storage, which would rewrite RLS, staff auth and storage before M2. Revisit if data must sit inside GCP.
- Details: `DEPLOYMENT.md`.

## D16 — Research sources for on-demand research — owner decision (2026-10-22)
- **Context:** The owner requires no sample data in production: a research agent researches a search miss, stores results in the DB, and later searches read from the DB.
- **Decision (owner chose "Web search + developer + K-RERA"):**
  - `anthropic-web-search` is **approved** (access method `api`). It covers Anthropic server-side web search with citations, and the public developer pages it surfaces. Only short factual fields that appear verbatim in the cited text are stored, with the cited URL, as Lane B unverified records.
  - **K-RERA automated reading is not enabled.** On 2026-10-22 an automated fetch of `rera.karnataka.gov.in/robots.txt` was refused as robots-disallowed, and no terms page permitting automated access was found. Per DATA_SOURCE_POLICY §4 we do not crawl it. K-RERA stays manual staff lookup plus link-out. A RERA number may still be stored when it appears verbatim in a web-search citation.
  - Revisit if the K-RERA authority publishes an API or grants permission.
- **Consequences:** The research worker never publishes or verifies. Staff review is still required before anything becomes a researched (Lane A) project.

## D17 — Spec pack adopted as governing; conflict register pending Fury's decision — accepted as working rule (2026-10-23)
- **Context:** The spec pack `nb-realestate-specs` (00-README, 01-constitution, 02–11, its CLAUDE.md) describes the target product. Parts of it clash with repo non-negotiables, D5/D16, DATA_SOURCE_POLICY, or the law.
- **Decision:** The spec pack governs. Where it clashes with a repo non-negotiable, the law or a source's rules, the clash is recorded as a C-item in the conflict register of the alignment plan (`/mnt/project-files/truenest/specs-alignment-plan.md` §3, C1–C25) with a proposed resolution. **None of C1–C25 is resolved yet; each awaits Fury's decision.** Until then the stricter rule applies (no K-RERA crawling, no portal scraping, no autonomous outbound messages, no lead row before consent).
- **Consequences:** Spec slices are built in the plan's order (§4), starting with S1a (DB/server only, needs nothing new from Fury). Spec branches use `feat/<spec-slug>` (C25).

## D18 — Two-axis fact model (truth status vs verification) — proposed (2026-10-23)
- **Context:** Constitution §2 requires every fact to be `official | estimated | unknown`; the repo models `known | unknown` plus `VerificationState` (D8, D12). Spec 02 wants several live values per attribute with conflicts (C6).
- **Proposal:** Two orthogonal axes. *Truth status* (official / estimated / unknown: what kind of claim) and *verification* (has TrueNest reviewed it). Automation writes `fact_observations` (spec 02 `facts` shape); every observation is `unverified` (DB CHECK) until a staff RPC with an actor and audit event exists; web-search sources never count as official; staff curation stays in `facts`; the views `facts_current` (precedence + `conflicts` + `is_stale`) and `facts_history` carry the spec names. `FactValue` gains optional `truth`, `lastVerifiedAt`, `ttlHours`, `estimateBasis`, `conflicts` (required once every repository fills them; `FactConflict.source` is nullable for a curated value stored without a source). Implemented as the S1a skeleton in `0006_fact_store.sql` (see `DATA_MODEL.md`); nothing renders from it yet.
- **Needs Fury:** confirm C6 (this model) and C7 (the proposed `legally_significant` list: `rera_*`, `oc_status`, `khata_type`, `land_title_summary`, `bank_approvals`).

## D19 — Architecture v2: K-RERA first, seeded catalogue, two enrichment loops — proposed by PM (2026-10-24)
- **Context:** Staging review 24 Oct: `projects` = 0, Lane B has no production adapter, both research jobs ended `no_results`. v1 asked the research agent to author the catalogue one buyer query at a time.
- **Decision (proposed, Fury to confirm):** `docs/ARCHITECTURE_V2.md` governs the data path. Source priority is fixed: K-RERA (staff-driven, no crawling, D16 stands) → government planning bodies → builder → news → web search → community; portals are discovery/price signals only. The catalogue is seeded via staff import (spec 12) and published after RERA verification; Loop 1 (scheduled crawl) and Loop 2 (research v2, spec 14: discover → verify → score, push trigger, short failure TTLs) enrich it. Area potential over 5–10 years is a first-class section (spec 13). Build order and exit criteria: `docs/PRODUCT_PLAN.md`.
- **Consequences:** spec 05's flow is superseded by spec 14; `RESEARCH_WORKER.md` to be revised in the spec-14 branch. The seed sheet is compiled from builder sites and news only (never fetched from K-RERA), every row `needs_verification = yes`, and nothing is published until an admin verifies it against K-RERA by hand.

## D20 — K-RERA access method stays staff-initiated; browser tools are not crawlers — owner-confirmed intent (2026-10-24)
- **Context:** Fury confirmed K-RERA is the first source of truth and asked how browser tooling (Playwright MCP, Claude in Chrome) and Scrapy fit.
- **Decision:** Source *priority* (K-RERA = rank 1, ARCHITECTURE_V2 §2) is separate from *access method*. Access stays as D16: no crawler against rera.karnataka.gov.in. A staff member may open one K-RERA project page in their own browser session and ask Claude to transcribe the visible fields (URL + timestamp recorded, `needs_verification` until an admin confirms). Loops over listings, schedules, or CAPTCHA/login handling are crawling and remain prohibited. Scrapy is the Loop 1 worker for sources whose robots/terms allow it (R12) and never targets K-RERA.
- **Revisit:** only by an owner-recorded review of K-RERA's terms and robots (DATA_SOURCE_POLICY §4) or an official data channel (spec 12 Part E, R6).

## D22 — Area developments: AI-researched, staff-published, no return predictions — proposed (2026-10-24)
- **Context:** The owner (Fury, 2026-10-24) wants buyers to see planned development for the next 5–10 years around a project ("development plans … in the nearby area for the customers to see the potential"). Spec 06 models `developments` with stage, authority, declared dates and slip history.
- **Decision (slice S4a):**
  - Staff start research per configured locality from `/admin/developments`. The job runs on the existing research queue and worker (`research_jobs.kind = 'area_developments'`, key `dev:<locality>`) under the same daily cap, cache window and failure cooldown. There is no new scheduler and no new spend path.
  - The research uses the approved `anthropic-web-search` source (web search only, no fetching or scraping). It covers about 5 km around the locality: metro, suburban rail, roads, flyovers, STRR/PRR, airport and master plan/zoning. It prefers authority pages (BMRCL, K-RIDE, BDA, BBMP, NHAI, KIADB, BIAL); news is acceptable.
  - Same anti-fabrication rule as D16. The name, stage phrase, authority, expected date and locality must appear verbatim in a citation for a URL from that response's search results, and in the same citation as the name. The stage is derived from the cited phrase, never from the model's label. Promotional names are dropped.
  - Every researched row is stored **unverified and unpublished**. Only staff publish: advisors edit drafts and admins publish or unpublish. Every action is audited, and declared dates keep an append-only slip history. Re-research never overwrites a reviewed row; it records a pending change for staff.
  - Buyers see published rows only, under "Planned around here (next 5–10 years)" with the disclaimer "Plans can change, be delayed or be cancelled. Not a prediction of property prices or returns." Each item shows the stage, the authority, the expected date "as declared", slips, the straight-line distance, the source and the dates. With nothing published, buyers see an honest "Not yet researched", which is not a negative finding.
  - TrueNest never predicts appreciation, returns or completion dates.
- **Storage permission granted (2026-10-24):** the registry gains the storable field `development_fields`. It is granted to `sample-web-research` and to `anthropic-web-search` because Fury explicitly asked for it on 2026-10-24: "I don't need only the project details, I also need development plans for next 5-10 years in the nearby area for the customers to see the potential." Both `requestAreaDevelopmentResearch` and the worker refuse a source without it (`mayStoreDevelopments`).
- **Still proposed (needs Fury):** the rest of D22 (staff-only publishing, the wording, the 10 km display radius, the +10-year horizon) and DATA_SOURCE_POLICY §11.3 beyond the grant. Until Fury confirms, production research stays staff-triggered only, and nothing is shown until staff publish.
