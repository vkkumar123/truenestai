# TrueNest AI — Roadmap

Each milestone is a small vertical slice. **Done** means: acceptance criteria met, `npm run check` green (plus `build`, `test:db`, `test:e2e` where relevant), and Quality Reviewer PASS logged in `REVIEW_LOG.md`.
**Owner action** = cannot complete without the owner (see `MCP_REQUESTS.md`).

| # | Milestone | Owner action |
|---|---|---|
| M0 | Foundation | R1 (repo confirmation) |
| M1 | First buyer journey on fixtures | none |
| M2 | Supabase persistence + Auth | **R2, R7** |
| M3 | Manual research tooling | none (needs M2) |
| M4 | First approved external source | **R5** |
| M5 | RERA lookup workflow | **R6** for automation |
| M6 | Locality, infrastructure, amenities, maps | **R4** |
| M7 | Buyer matching + AI explanations | **R3** |
| M8 | Growth, attribution, campaign drafts | disclosure wording approval |
| Later | Bengaluru Phases 2–4 | boundary approvals |

## M0 — Foundation
- [ ] `CLAUDE.md`, `AGENTS.md`, `.claude/agents/*` with ownership map (`AGENT_WORKFLOW.md`).
- [ ] Docs: PRODUCT_SPEC, ARCHITECTURE, ROADMAP, DECISIONS, MCP_REQUESTS, DATA_SOURCE_POLICY, SECURITY_PRIVACY, DATA_MODEL.
- [ ] Domain contract `src/domain/types.ts` compiles; `.env.example` lists vars with no values.
- [ ] `npm run check` and `npm run build` pass on the scaffold.

## M1 — First buyer journey on fixtures
Journeys J1–J7 from `PRODUCT_SPEC.md`.
- [ ] Fixture repositories (default mode) with fictional `SAMPLE` projects (≥ 6 Lane A, ≥ 3 Lane B) across North Bengaluru localities from `src/config/markets/`; all `isSample: true`, `example.com/.org` URLs.
- [ ] **Browse:** list with locality/BHK/status/lane filters; sample badge and lane badge on every card.
- [ ] **Detail:** every `FactValue` shows sources + verification; unknowns render neutrally; RERA ≠ title disclaimer visible.
- [ ] **Compare:** up to 4 items; a 5th is refused with a message; unknown cells neutral.
- [ ] **Lane B:** "Unverified" label, source, canonical URL, discovered/last-seen dates, limitations, Request verification CTA.
- [ ] **Lead capture:** zod-validated; rejected without `contactConsent`; marketing consent separate and unticked; consent version and retention stored; no personal data before submit.
- [ ] **Admin:** `/admin` requires the dev credential in fixture mode; credential login disabled when `NODE_ENV=production` (unit-tested); queue lists leads; status changes persist for the process.
- [ ] Tests: unit (repositories, lead validation, consent, admin guard, compare limit) and e2e (J1–J7).
- [ ] No secrets, no real data; reviewer PASS.

## M2 — Supabase persistence + Auth live — **owner: R2, R7**
- [ ] Migrations for projects, facts/sources, external listings, leads, consent, source registry, staff roles.
- [ ] RLS: anon reads published rows only; anon cannot read leads; staff roles scoped; `test:db` covers each policy.
- [ ] Supabase repositories pass the same contract tests as fixtures.
- [ ] Staff login via Supabase Auth; dev credential path unused in supabase mode.
- [ ] Service-role key server-only (bundle check in CI).

## M3 — Manual research tooling for staff
- [ ] Admin forms to create or edit a project and add facts, each requiring ≥ 1 `SourceRef` (URL or document, observed date).
- [ ] Verification workflow: `unverified → source_confirmed/reviewed/disputed/requires_professional_review`, with reviewer identity and timestamp (audit log).
- [ ] Publish toggle gated on review; completeness score recomputed.
- [ ] Document upload to Storage with versioning.

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
