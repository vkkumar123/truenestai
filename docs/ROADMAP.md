# TrueNest AI — Roadmap

Each milestone is a small vertical slice. **Done** means: acceptance criteria met, `npm run check` green (plus `build`, `test:db`, `test:e2e` where relevant), and Quality Reviewer PASS logged in `REVIEW_LOG.md`.
**Owner action** = cannot complete without the owner (see `MCP_REQUESTS.md`).

| # | Milestone | Owner action |
|---|---|---|
| M0 | Foundation | R1 (repo confirmation) |
| M1 | First buyer journey on fixtures | none |
| M2 | Supabase persistence + Auth | **R2, R7** |
| M3 | Manual research tooling | none (needs M2) |
| S1a | Spec 02 fact store skeleton (D17, D18) | none new; staging/prod apply via Fury |
| M4 | First approved external source | **R5** |
| M5 | RERA lookup workflow | **R6** for automation |
| M6 | Locality, infrastructure, amenities, maps | **R4** |
| M7 | Buyer matching + AI explanations | **R3** |
| M8 | Growth, attribution, campaign drafts | disclosure wording approval |
| Later | Bengaluru Phases 2–4 | boundary approvals |

## M0 — Foundation
- [x] `CLAUDE.md`, `AGENTS.md`, `.claude/agents/*` with ownership map (`AGENT_WORKFLOW.md`).
- [x] Docs: PRODUCT_SPEC, ARCHITECTURE, ROADMAP, DECISIONS, MCP_REQUESTS, DATA_SOURCE_POLICY, SECURITY_PRIVACY, DATA_MODEL.
- [x] Domain contract `src/domain/types.ts` compiles; `.env.example` lists vars with no values.
- [x] `npm run check` and `npm run build` pass on the scaffold.

## M1 — First buyer journey on fixtures — **done 2026-10-21** (review PASS, see REVIEW_LOG)
Journeys J1–J7 from `PRODUCT_SPEC.md`.
- [x] Fixture repositories (default mode) with fictional `SAMPLE` projects (≥ 6 Lane A, ≥ 3 Lane B) across North Bengaluru localities from `src/config/markets/`; all `isSample: true`, `example.com/.org` URLs.
- [x] **Browse:** list with locality/BHK/status/lane filters; sample badge and lane badge on every card.
- [x] **Detail:** every `FactValue` shows sources + verification; unknowns render neutrally; RERA ≠ title disclaimer visible.
- [x] **Compare:** up to 4 items; a 5th is refused with a message; unknown cells neutral.
- [x] **Lane B:** "Unverified" label, source, canonical URL, discovered/last-seen dates, limitations, Request verification CTA.
- [x] **Lead capture:** zod-validated; rejected without `contactConsent`; marketing consent separate and unticked; consent version and retention stored; no personal data before submit.
- [x] **Admin:** `/admin` requires the dev credential in fixture mode; credential login disabled when `NODE_ENV=production` (unit-tested); queue lists leads; status changes persist for the process.
- [x] Tests: unit (repositories, lead validation, consent, admin guard, compare limit) and e2e (J1–J7).
- [x] No secrets, no real data; reviewer PASS.

## M2 — Supabase persistence + Auth live — **code done 2026-10-22** (review PASS); live verification pending — **owner: R2, R7**
- [x] Migrations for projects, facts/sources, external listings, leads, consent, source registry, staff roles.
- [x] RLS: anon reads published rows only; anon cannot read leads; staff roles scoped; `test:db` covers each policy.
- [x] Supabase repositories pass the same contract tests as fixtures.
- [x] Staff login via Supabase Auth; dev credential path unused in supabase mode.
- [x] Service-role key server-only (bundle check in CI).
- [x] Carried from M1 review: advisor lead-assignment scoping (M3), Supabase session refresh in proxy (M6), dev-login throttle (L2), `is_published_project` RPC exposure (L9), Lane B matching under `lane=external` (N1), developer-name text search parity (N2), per-contact rate-limit keys (N3). N1–N3 done in M3.
- [x] Carried from M3 review: R1 expected-from check under lock, R2 completeness inside RPC, R3 auto-unpublish message flag, R4 publish-rule parity test + seed registry ids into `sources`.
- [x] Document upload to Storage with versioning (from M3).
- [x] Review fixes: SAMPLE seed blocked on production (`--mark-production`), unused `authenticated` lead grants revoked, failure-only login throttle, upload cleanup safety, fixture sources out of reference seed, staff list admin-only.
- [ ] Live run against the owner's Supabase: migrate, `--mark-production` (staging excepted), reference seed, invite staff, smoke test sign-in/refresh/upload/download/assign.

## M2.5 — On-demand research — **code done 2026-10-22** (review PASS); live smoke test pending — **owner: ANTHROPIC_API_KEY (D16)**
- [x] A search with no DB match lets the buyer start a research job (POST); the worker uses only the registry-approved `anthropic-web-search` source (D16) and stores cited results as Lane B unverified records; later searches read from the DB.
- [x] Anti-fabrication: every stored field appears verbatim in an API-returned citation for a search-result URL, co-located with the project name; portals excluded; K-RERA never fetched.
- [x] Honest buyer states (researching / searched, none citable / unavailable); no stuck states; robots + noindex; cost caps.
- [ ] Staff review promotes records to researched (Lane A) — next slice.
- [ ] Live: key + run secret + scheduler (hosting PR #6), reference seed re-run, one staging smoke call.

## M3 — Manual research tooling for staff — **done 2026-10-21** (review PASS; Storage upload moved to M2)
- [x] Admin forms to create or edit a project and add facts, each requiring ≥ 1 `SourceRef` (URL or document, observed date).
- [x] Verification workflow: `unverified → source_confirmed/reviewed/disputed/requires_professional_review`, with reviewer identity and timestamp (audit log).
- [x] Publish toggle gated on review; completeness score recomputed.
- [ ] → M2: Document upload to Storage with versioning (needs Supabase Storage).

## S1a — Spec 02 fact store skeleton — **done 2026-10-23** (review PASS, see REVIEW_LOG); staging/production apply via Fury
Plan: `/mnt/project-files/truenest/specs-alignment-plan.md` §6. DB/server only, no public page changes.
- [x] `0006_fact_store.sql` (additive): `fact_attributes` catalogue (spec 02, legal flags proposed), `fact_observations`, append-only `fact_observations_history`, `facts_current` (precedence, `conflicts`, `is_stale`) and `facts_history` views, curated `facts` truth/TTL columns + backfill + guard trigger, CHECK that every observation stays unverified, web search never official, truncate refused on facts/fact_sources/observations, RLS on, service role only (default service_role privileges revoked).
- [x] `test:db`: builder-vs-RERA conflict, `unknown` within TTL, automated row cannot be verified, history immutable even for service_role, existing D12/D13 RPC and readiness parity tests still pass.
- [x] Read-only `FactStoreRepository` (Supabase + SAMPLE fixture) with unit tests; optional `FactValue` fields (D18).
- [x] Quality-reviewer PASS (constitution first, then spec 02) logged in `REVIEW_LOG.md`: round 1 (6221878) CHANGES REQUIRED, round 2 (d53368f) PASS; the round-2 follow-ups are closed in the next commit.
- [ ] Fury: C6/C7 decisions; staging then production apply.
- [ ] Re-map M4–M8 onto spec slices S2–S10 (plan §4), once Fury answers the conflict register (D17).

## M4 — First approved external source adapter — **owner: R5**
- [ ] Source registry entry `approved` with documented access method and terms.
- [ ] Adapter implements `SourceAdapter`, respects rate limits/robots, stores no copied descriptions/images.
- [ ] Scheduled run updates `lastSeenAt`; disappearing listings are marked, not deleted.
- [ ] Dedupe links only on strong identifiers (test: similar names do not merge).
- [ ] Kill switch: suspending the source stops runs.

## M5 — RERA lookup workflow — **owner: R6 for automation**
- [ ] Manual-assisted: staff record registration/complaint/order with URL, observed date, as-printed reference.
- [ ] Display copy: registration ≠ title; complaints shown factually with source.
- [ ] Automated lookup only after permitted access is documented; otherwise feature-flagged off.
- [ ] Optional: Python worker parses certificates → AI-extracted draft → reviewer.

## M6 — Locality infrastructure, amenities, maps — **owner: R4**
- [ ] Infrastructure items with stage + sources; declared completion never presented as a promise.
- [ ] Amenities with source; distance computed, not claimed.
- [ ] `MapProvider` adapter with chosen provider and attribution; list fallback without key.
- [ ] Monitoring worker drafts stage changes for review.

## M7 — Buyer matching & AI comparison explanations — **owner: R3**
- [ ] Deterministic matching on stated preferences (budget band, BHK, locality, status).
- [ ] AI explanation uses only stored facts, cites them, is labelled AI-generated; schema-validated; failures fall back to the plain table.
- [ ] Evaluation set: no invented facts, no guarantees, unknown ≠ negative (tests).
- [ ] Spend limit set; key server-only.

## M8 — Growth / attribution + campaign drafting — **owner: disclosure wording**
- [ ] UTM/landing attribution on leads (already captured in M1) with reporting in admin.
- [ ] Lead qualification and routing rules; CRM export (manual).
- [ ] Campaign/content drafts only: no ad spend APIs, no outbound send; staff publish manually.
- [ ] Commercial relationship disclosures rendered where applicable.

## Later — Bengaluru expansion (Phases 2–4)
- [ ] Add each market via `src/config/markets/` (no code changes to localities elsewhere).
- [ ] Owner approves each boundary; sources and partners per market.
