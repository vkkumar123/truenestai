# Data model

Source of truth for shapes: `src/domain/types.ts`. Schema: `supabase/migrations/0001_core.sql`.
Server access: `src/server/repositories` (fixture or Supabase, chosen by `DATA_BACKEND`).

## Lanes
| Lane | Entity | Meaning |
|---|---|---|
| A — researched | `projects` (+ facts, regulatory records, documents) | Collected and structured by TrueNest with per-fact provenance. Shown only when `published = true`. |
| B — external | `external_listings` | Discovered on an approved source. **Always unverified.** Shown with source, canonical URL, discovered/last-seen dates and limitations. Never presented as a verified fact. |

Search (`searchProperties`) returns Lane A first and queries Lane B only when Lane A has fewer than
`MIN_RESEARCHED_RESULTS` (default 3) results. A Lane B listing whose `matched_project_id` is one of the
returned Lane A projects is not shown twice. `matched_project_id` is set only by strong identifiers
(RERA number), never by name similarity.

## Entities and relationships
```
market_phases 1─* zones 1─* localities            (mirror of src/config/markets; config is authoritative)
sources                                           (mirror of src/discovery/registry.ts)
developers 1─* projects *─1 localities
projects 1─* project_units
projects 1─* facts *─1 project_units (unit facts only)
facts 1─* fact_sources *─1 sources
projects 1─* regulatory_records *─1 sources
projects 1─* regulatory_searches *─1 sources      (searches performed, including "found nothing")
projects 1─* project_documents *─1 sources        (versioned by document_key + version)
sources 1─* source_observations                   (raw observation log; internal only)
sources 1─* external_listings ─0..1 projects      (matched_project_id)
infrastructure_items, amenities                   (locality context)
leads ─0..1 projects | external_listings; leads 1─* lead_events
staff_profiles (user_id = auth.users.id, role advisor|admin)
```
Ids are text (`gen_random_uuid()::text` default) so fixture ids and DB ids share one shape; leads use `uuid`.
Coordinates are `numeric(9,6)` lat/lng plus `precision` (`exact | approximate | locality_centroid`).
PostGIS is **not** used yet (the local test Postgres lacks it); a later migration may add a
`geography(Point)` column with a GiST index derived from lat/lng.

## Provenance
Every material project fact is a row in `facts`:
- `field` (address, rera_numbers, construction_status, declared_possession, unit_carpet_area_sqft, unit_price_inr), `value jsonb`, `status known|unknown`, `verification`, `created_at`, `is_current`.
- One or more `fact_sources`: `source_id` (registry), `url`, `observed_at`, `document_date`, `note`.
- History is kept: a new observation inserts a new row and clears `is_current` on the old one
  (a partial unique index allows one current row per project/field/unit).

Regulatory records and documents carry the same provenance inline (`source_id`, `source_url`,
`observed_at`, `document_date`, `verification`). Documents are versioned (`document_key`, `version`);
`storage_path` is internal and not readable by the public.

## Unknown is not negative
- `status = 'unknown'` ⇒ `value is null` (enforced by CHECK). It means "not found yet" and is shown as such.
- Every search performed is recorded (`regulatory_searches` ↔ `Project.regulatorySearches`). `results_found = 0`
  is shown as "No complaint found as of <date> in <source>" with a scope caveat (`describeComplaintSearch`,
  src/research/evidence.ts), never as "clean". No search of a kind = "Not yet checked".
- RERA registration is not title clearance. Title/legal items go in `review_flags` / `requires_professional_review`.

## Verification states
`unverified` (collected, not reviewed) · `source_confirmed` (matches an authoritative public source on the
observation date) · `reviewed` (checked by our reviewer against documents) · `disputed` (sources disagree) ·
`requires_professional_review` (e.g. title). Lane B listings have no verification column: they are always unverified.

## Access control (RLS on every table)
Roles: `anon`, `authenticated` (Supabase JWT; `auth.uid()`), `service_role` (bypasses RLS, server/workers only).
`is_staff()` / `staff_role()` are `security definer` functions reading `staff_profiles` for `auth.uid()`.
Policy-only helpers `private.is_published_project(text)` and `private.is_staff_admin()` live in the
`private` schema (0003, L9), which must stay **out of** PostgREST's exposed schemas, so they cannot be
called via `/rest/v1/rpc`. `is_staff()` / `staff_role()` stay in `public` (they reveal only the caller's own role).

| Table | anon / authenticated | staff (authenticated + staff_profiles) | writes |
|---|---|---|---|
| market_phases, zones, localities, amenities, external_listings | SELECT all | — | service role |
| sources | SELECT where `status='approved'` | — | service role |
| projects | SELECT where `published` | — | service role |
| developers, project_units, facts (current), fact_sources, regulatory_records, regulatory_searches | SELECT only for published projects | — | service role |
| project_documents | SELECT (title, kind, version, dates, source; not `storage_path`/`sha256`/`size_bytes`/`content_type`/`uploaded_by`) for published projects | — | service role (`research_add_document`) |
| infrastructure_items | SELECT where `published`, public columns only (0008) | — | service role (S4a writes via RPCs) |
| source_observations | none | none | service role |
| staff_profiles | own row only (authenticated) | own row | service role |
| project_search_index (view, `security_invoker`) | SELECT (inherits projects/facts/units RLS) | — | — |
| leads | **none** (no grants) | **none** (0004/L1: grants revoked; staff access is server-side with the service role after `requireStaff()` + service scoping). Policies kept as defence in depth: admins all, advisors `assigned_to = auth.uid()` | service role (`lead_assign` for assignment) |
| lead_events | none (a trigger writes `created`) | **none** (0004/L1). Policies kept: visible leads only; INSERT `status_changed`, `actor_id = auth.uid()` | service role |
| private.settings | none | none | service role / migration runner (deployment marker) |
| storage bucket `project-documents` | none (private bucket, no `storage.objects` policies) | none directly — staff download via the server's signed URL | service role |

DB-level rules independent of RLS (apply to every role, including the service role): leads require consent
unless withdrawn; status changes must follow `LEAD_STATUS_TRANSITIONS` (trigger); once a lead is withdrawn its
personal-data, consent and qualification columns are frozen (trigger); approved non-fixture sources need
`terms_reviewed_at`; source/document URLs must be `https://` or null.

Default privileges: the migration revokes default table/sequence privileges from `anon`/`authenticated` and
default function EXECUTE from `public` in schema `public`, so new objects are private until granted explicitly.

Search filters that live in facts/units (construction status, BHK) are evaluated in SQL through the
`project_search_index` view (`construction_status`, `bhk_counts int[]`, `max_bhk`) before the limit.

The app's Supabase repositories use the anon client for public reads and the service-role client for lead
storage/staff operations and worker writes; staff operations are gated in `src/server/services/leads.ts` by
`requireStaff()` before the repository is called. Withdrawal (irreversible PII erasure) additionally requires
the `admin` role.

**Lead assignment (M2):** `leads.assigned_to` → `staff_profiles.user_id`. Admins see and update every lead and
assign/unassign (`assignLead`, `assignLeadAction`; DB `lead_assign(lead, assignee, actor)` — row lock, assignee
must be staff, withdrawn leads refused, `assigned` event in `lead_events` with `assigned_to`). Advisors see,
open and update only leads assigned to them: the service layer scopes `listLeads` / `getLead` /
`updateLeadStatus` (an advisor gets `not_found` for other leads), mirroring the RLS policy above for any
direct authenticated access. `listAssignableStaff()` (admin only) lists staff (id, role, display name; no
contact data).

Tests: `npm run test:db` drops and recreates the `public`/`auth`/`private`/`storage` schemas in
`DATABASE_URL_TEST`, applies `tests/db/supabase-shim.sql` (test-only stand-in for Supabase roles, `auth.uid()`
and `storage.buckets`), then every migration (directly, or through the migration runner), and asserts the
policies above, the seed, and SQL/TS readiness parity.

## Migrations, seed and staff bootstrap (M2)
- `npm run db:migrate` (`scripts/db-migrate.ts` → `src/server/db/migrate.ts`) applies
  `supabase/migrations/NNNN_*.sql` in order against `SUPABASE_DB_URL`. Ledger: `private.schema_migrations`
  (name, sha256, applied_at); each migration and its ledger row commit in one transaction; an applied file whose
  checksum changed aborts the run (add a new migration instead); a Postgres advisory lock serialises runners.
  `--dry-run` lists pending files. The ledger is separate from the Supabase CLI's — use one tool per database.
- Production marker (M1): `private.settings (key, value)`, `environment` ∈ production|staging|development, set
  with `db:migrate -- --mark-production` (refused while SAMPLE projects exist). On a production-marked database the
  SAMPLE seed is refused by the runner and by a guard at the top of the SAMPLE section of `seed.sql`.
- Seed: `npm run db:seed:generate` writes `supabase/seed/seed.sql` (reference + SAMPLE projects) and
  `supabase/seed/reference.sql` (geography from `src/config/markets` + the full source registry) from
  `src/server/db/seed.ts`; a unit test fails when the committed files drift. Reference rows are upserted (repo
  config wins; fixture-type sources are excluded from `reference.sql` and ship only with the SAMPLE seed, L5); SAMPLE rows (`is_sample = true`, names start with `SAMPLE`, `example.com` URLs, published exactly
  as in the fixtures) use `on conflict do nothing`, so re-runs never overwrite later edits. Deterministic ids:
  facts `<projectId>:<field>`, units `<projectId>:u<N>`, fact sources `<factId>:s<N>`.
  `npm run db:seed` / `--seed` = migrate + `reference.sql` (safe everywhere); the SAMPLE seed needs
  `--seed=full --allow-sample` (staging/dev).
- Staff: `npm run staff:create -- --email … --role admin|advisor [--name …] [--dry-run]`
  (`src/server/admin/staff-bootstrap.ts`): finds the Auth user by email or sends a Supabase invite (no
  passwords on the command line), then upserts `staff_profiles`. Idempotent.

## Documents (M2)
- Object storage: private bucket `project-documents` (created by 0003 when `storage.buckets` exists; 15 MB
  limit; `application/pdf`, `image/png`, `image/jpeg`). No `storage.objects` policies: anon/authenticated have no
  access; the server uses the service role after a staff check.
- Paths are immutable and versioned: `<projectId>/<documentKey>/v<N>/<safe-filename>` (DB check constraint).
  Re-uploading the same `documentKey` creates version N+1; the storage write never overwrites (`upsert: false`).
- Upload: `POST /api/staff/documents` (multipart; `src/server/http/document-upload.ts`) — Origin must match the
  host (CSRF), staff session checked first, `Content-Length` required and ≤ 15 MB + 64 KB before the body is
  parsed; JSON `{ok, documentId, projectId, version}` / `{ok:false, error, message, errors?}`. It calls
  `uploadProjectDocument` (`src/server/services/documents.ts`, any staff role), which
  validates metadata (registry `sourceId`, optional https `sourceUrl`, kind, ISO date), checks the bytes'
  magic number (PDF/PNG/JPEG) against the declared type, ≤ 15 MB; stores the object; then
  `research_add_document` locks the project, re-checks the version (`conflict` if another upload won), inserts
  the row (`content_type`, `size_bytes`, `sha256`, `uploaded_by`) and audits field `documents`, action
  `document_uploaded`, note `document uploaded: <key> v<N> (<kind>)`. A failed DB write removes the stored
  object again — only after confirming no row references its path (L4); if that check fails the object is kept.
- No Server Action is used, so the global Server Action body limit stays at Next's 1 MB default.
- Download: `GET /api/staff/documents/<documentId>` — staff only; Supabase → 302 to a 60-second signed URL;
  fixture (dev, in-memory) → the bytes as an attachment with `no-store`, `nosniff` and a sandbox CSP.
- Document metadata (not the file) of a published project is public, like other provenance.

## Leads, consent and retention
- Stored only with `contact_consent = true`; `marketing_consent` is separate and optional;
  `consent_text_version` records the exact wording agreed to; `consented_at` is set server-side.
- `retention_until` = created + 12 months (open) or 24 months (closed/withdrawn) — `src/leads/retention.ts`
  (assumption pending legal review, DPDP Act 2023). Withdrawal erases PII immediately, keeping a minimal audit stub.
- Logs carry only `redactLeadForLog` fields (id, status, requestType). Audit events carry no PII.
- Fixture mode keeps leads in server memory per process (dev only).
- Rate limiting (dev-grade, in-memory per process; production needs a shared store) counts only *valid*
  submissions, keyed on the client IP and separately on each contact value given (hashed email, hashed phone).
  The client IP is taken `TRUSTED_PROXY_HOPS` entries from the **right** of `X-Forwarded-For`
  (`src/server/client-ip.ts`); client-supplied left entries are never trusted. Requests without the header share
  one `unknown` bucket.
- A scheduled purge of leads past `retention_until` is not implemented yet.

## Auth
- Supabase mode: `@supabase/ssr` cookie session, verified with `auth.getUser()`, role from `staff_profiles`.
  `src/proxy.ts` refreshes the session on `/admin/*` (per `@supabase/ssr`: `getUser()` rotates an expired token;
  new cookies go to the forwarded request and the response; a definitively signed-out user is redirected to
  login). The proxy is a fast path only — pages and actions still verify.
- Sign-in throttle (L2, dev-grade, in-memory **per instance**: not shared across processes/serverless
  instances; production also relies on Supabase Auth rate limits and edge/WAF limits): only **failed** sign-ins
  (wrong credentials, non-staff account) count — `LOGIN_MAX_ATTEMPTS` (default 10) per client IP per
  `LOGIN_WINDOW_SECONDS` (default 900), and 5× that per email in Supabase mode; checked before the credential
  check (`src/server/services/login-throttle.ts`).
- Fixture mode (dev only): `ADMIN_DEV_PASSWORD` (≥ 12 chars, constant-time compare) issues an httpOnly,
  `sameSite=lax`, 8-hour HMAC-signed cookie (`SESSION_SECRET` ≥ 32 chars). Refused when `NODE_ENV=production`.

## Staff research write-model (M3, D12/D13)
- Editable research facts: `address`, `reraNumbers`, `constructionStatus`, `declaredPossession`
  (DB `facts.field`: `address`, `rera_numbers`, `construction_status`, `declared_possession`).
- **Who writes:** only signed-in human staff through `src/server/services/research.ts`. Workers and AI
  pipelines never hold a staff session (they produce drafts elsewhere); the automated-actor id check
  (`ai`, `system`, `bot`, `automation`) is kept as defence in depth.
- Every edit needs ≥ 1 https source with an observed date (`src/research/fact-edit.ts`) whose `sourceId` is in
  the source registry (`listResearchSources()`; fixture sources only outside production), and resets the
  fact's verification to `unverified`.
- **Atomicity (Supabase):** every staff write is one SQL transaction in a `security invoker`, fixed
  `search_path`, service-role-only function that takes a row lock on the project and writes the audit row
  (`at` defaulted by the DB):
  `research_create_project`, `research_set_fact`, `research_set_verification`, `research_set_published`
  (signatures as of `0003_m2_live.sql`). `research_set_fact` recomputes `projects.completeness` in SQL from the
  committed state (`tn_compute_completeness`, same formula as `computeCompleteness`; R2).
  Fixture mode computes the next state + audit events, then commits both in one synchronous step.
- **Stale reviews (H1):** a verification change carries `expectedVersion` = `factVersion(fact)` as the reviewer
  saw it, and optionally `expectedFrom` = the verification state they saw. The service and repository compare
  both with the current fact; `research_set_verification(…, p_expected_from, …)` re-checks, under the row lock,
  that the exact fact row is still current **and** its verification still equals the expected one (R1). Otherwise → `conflict` ("This fact changed since you loaded
  it — reload and review again").
- Verification rules (`canSetVerification`): advisors may set `disputed` / `requires_professional_review`; only
  admins may set `source_confirmed` / `reviewed` or reset to `unverified` (incl. clearing `disputed`). A fact
  needs ≥ 1 source before its verification can change.
- **Publish:** admin only (`PUBLISH_ROLE`). `research_set_published` re-checks readiness in SQL under the row
  lock (`tn_publish_blockers`: RERA known and `source_confirmed`/`reviewed`, construction status known, no
  disputed current fact, every known current fact has a source, completeness ≥ 0.6 computed live by
  `tn_compute_completeness`). These constants mirror `src/research/publish.ts`; a unit test parses the latest
  definition, and a DB test (R4) compares `tn_publish_blockers` / `tn_compute_completeness` with
  `evaluatePublishReadiness` / `computeCompleteness` on every seeded SAMPLE project, before and after mutations. Rules are an assumption
  pending owner approval.
- **D13 auto-unpublish:** after a fact edit or verification change, a published project that no longer passes
  readiness is unpublished in the same transaction, audited as `unpublished` with note
  `auto: failed readiness after edit` and the editing staff member as actor. Public pages are revalidated.
  Research actions return `autoUnpublished: boolean` and, when true, `autoUnpublishedMessage` separately from
  the base `message` (R3).
- New projects start unpublished, `is_sample = false`, every fact unknown; slug = kebab(name + locality), made
  unique with a numeric suffix. A **new developer** is created unless an existing `developerId` is chosen
  (developers are never merged by name).
- Audit: `fact_review_events` (↔ `FactAuditEvent`) — RLS on; staff SELECT via `is_staff()`; no client
  insert/update/delete; **append-only for every role** (trigger rejects UPDATE/DELETE/TRUNCATE, including the
  service role and the owner). Staff views show the actor id and `staff_profiles.display_name` when present.
- Fixture mode: staff writes mutate the in-memory project list the public repository reads (per process,
  lost on restart); `lastCheckedAt` changes only on fact edits. The dev advisor login
  (`ADMIN_DEV_ADVISOR_PASSWORD`) exists to exercise role limits.
- Search matches Lane B listings against published projects looked up **by RERA number**
  (`findPublishedProjectsByRera`, via `project_search_index.rera_numbers_normalized`; no project-count cap) —
  also under `lane=external` — and returns `matchedProjects: { [listingId]: { id, slug, name } }` for
  "Researched version available".

## Fact store skeleton (S1a, `0006_fact_store.sql`, D18 proposed)
Spec 02's multi-source fact store, added **alongside** the curated store (no drops or renames). Plan:
`/mnt/project-files/truenest/specs-alignment-plan.md` §5–§6. Nothing renders from it yet.

**Two axes per fact (D18).** *Truth status* `official | estimated | unknown` says what kind of claim it is
(constitution §2: official = builder, RERA or a government body; estimated = derived by us, always with its
basis; unknown = nothing credible found yet, never a negative finding). *Verification* (`VerificationState`)
says whether TrueNest reviewed it. They are independent.

**Official source** (`tn_source_is_official(id, type, status)`, mirrored in the fixture): registry type
regulator / government / developer, **not** a web research source (`anthropic-web-search`,
`sample-web-research`, = `WEB_RESEARCH_SOURCE_IDS`, a unit test compares them), and not `rejected`. Web search
is registered as type `developer`, but a search result is never an official figure.

| Object | What it holds |
|---|---|
| `fact_attributes` | The spec 02 attribute catalogue (39 rows: 28 project, 5 development, 6 locality). Schema metadata only: `value_kind`, `unit`, `default_ttl_hours` (assumptions), `legally_significant` (**proposed** for C7, `legal_flag_status = 'proposed'`), `legacy_field` (`declared_possession` → `promised_possession`). TS mirror: `FACT_ATTRIBUTES` in `src/server/repositories/fact-store.ts` (unit test compares it to the SQL seed). |
| `fact_observations` | One row per `(entity_type, entity_id, attribute, source_url)` (`unique nulls not distinct`), written by automation (`added_by` crawl / research / extraction) or staff. Entity types `project`, `locality` for now (existence checked by trigger). `value_text/num/date/json` must match the catalogue `value_kind`; `unknown` carries no value; a known value needs an `https` `source_url`; `estimate_basis` is required for, and only for, `estimated`, and must hold a non-empty `sources` array; a web research source always writes `source_type = 'search'`; `official` requires `source_type` in rera / builder / govt / fixture; `excerpt` ≤ 20 words; `last_verified_at ≥ observed_at`; `ttl_hours > 0`. **Every row is `unverified`** (CHECK `fact_observations_unverified_only`, staff rows included) until a staff RPC with an actor and an audit event exists. Identity columns, `added_by` and `is_sample` never change; for a project, `is_sample` must equal the project's at insert. |
| `fact_observations_history` | The OLD row of every UPDATE/DELETE on `fact_observations` (no-op upserts skipped), with `operation` and `superseded_at`. Written only by a `security definer` trigger. |
| `facts` (curated) | New nullable `truth_status`, `last_verified_at`, `ttl_hours`. Backfilled: an official source (above) → `official`, any other source (or none) → `estimated`, `unknown` stays `unknown`; `last_verified_at` = latest `fact_sources.observed_at`. The views always **derive truth at read time** with `tn_curated_truth_status` (the stored value is only a fallback), so a stored value cannot go stale when sources are added or the registry changes. |
| `facts_current` (view) | One row per `(entity_type, entity_id, attribute)` over live observations **plus** current curated project facts whose field maps via `legacy_field`; a known curated value **without a source is left out** (constitution §1). Precedence: a curated value that is **known** and `source_confirmed`/`reviewed` wins; otherwise official > estimated > unknown, then newest `observed_at`, then id. Every other live row is listed in `conflicts jsonb` (with `conflict_count`, `has_disagreement`), never hidden (constitution §3). For a date attribute an ISO date held as text is served and compared as a date (`tn_try_date`). `is_stale` = `last_verified_at + ttl_hours < now()`: an `unknown` inside its TTL is not stale, so it suppresses re-research. `requires_review` = legally significant and not `source_confirmed`/`reviewed` (C7, proposed). A curated row's representative source is an official-qualifying one when there is one, then the newest; its `source_type` is mapped by `tn_spec_source_type(id, type)` (web research → search, regulator → rera, government → govt, developer → builder, listing_portal → portal). An estimated curated row's `estimate_basis` is `{sources: [...]}` from its `fact_sources`. |
| `facts_history` (view) | `fact_observations_history` rows plus superseded curated rows (`is_current = false`, `operation = 'SUPERSEDED'`, `superseded_at` = the next row's `created_at`), with the same representative-source rule. |

**Integrity rules (every role, including the service role and the owner):**
- Observations are always `unverified` (above), on insert and on update.
- `fact_observations_history` is append-only (UPDATE, DELETE and TRUNCATE rejected by
  `tn_reject_audit_mutation`, now generic: "`<table>` is append-only"). TRUNCATE of `fact_observations`,
  `facts` and `fact_sources` is rejected too (it would skip the row-level history capture and the guard).
  Takedown/erasure will use an audited `tn_redact()` tombstone (C23, later).
- `facts_guard` trigger on curated `facts`: `id`, `project_id`, `unit_id`, `field`, `value`, `status`,
  `created_at` never change in place (a new value is a new row via `research_set_fact`), and direct DELETE is
  refused. `truth_status` can only be set once, from null to the derived `tn_curated_truth_status` value; any
  other change is refused, so nobody can relabel a fact official by hand. `verification` may change only
  inside the audited RPCs: `research_set_verification` and `research_set_fact` (redefined in 0006 with
  otherwise identical bodies) set the transaction-local flag `tn.via_rpc` around their own UPDATE and clear it
  right after; a direct UPDATE of `verification` is refused for every role. The flag guards against accidental
  direct writes by server code; it is not a security boundary (any role that can run SQL can set it).
  `is_current`, `last_verified_at` and `ttl_hours` may change. A cascade from deleting the project or unit (RI trigger,
  `pg_trigger_depth() > 1`) is still allowed, so SAMPLE data can be removed before marking production.
- Marking a database production (`src/server/db/migrate.ts`) is refused while any SAMPLE project **or SAMPLE
  fact observation** exists (observations have no FK to the project, so they survive deleting it).

**Access:** RLS on all three tables; no policies and no grants for `anon`/`authenticated` on the tables or the
views (both views are `security_invoker`). Supabase grants `service_role` ALL on new objects by default
(`tests/db/supabase-shim.sql` reproduces that before the migrations), so 0006 revokes `service_role` too and
then grants only: `fact_attributes` SELECT (catalogue changes go through migrations), `fact_observations`
SELECT/INSERT/UPDATE/DELETE, `fact_observations_history` SELECT only, `facts_current`/`facts_history` SELECT.
Public read through filtered views comes with the rendering slice.

**Server read model:** `FactStoreRepository` (`getRepositories().factStore`, read-only): `listCurrent(entityType,
entityId)` and `getCurrent(entityType, entityId, attribute)` return `CurrentFact` rows whose `fact` is a
`FactValue` with `truth`, `lastVerifiedAt`, `ttlHours`, `conflicts`, and `estimateBasis` for an estimate. The
mapper **throws** on an estimated row without a well-formed basis; `listCurrent`/`getCurrent` skip such a row
and log `fact_store_row_skipped` with its id only (no values, sources or PII), so one bad row never hides an
entity's other facts. Supabase: service-role client over
`facts_current`, rows validated with zod. Fixture: fictional SAMPLE observations for `sample-proj-lakeview` plus
the curated `declaredPossession` of the SAMPLE projects, resolved by `resolveFactsCurrent` (TS mirror of the
view's rules). Tests: `tests/db/fact-store.test.ts`, `src/server/repositories/fact-store.test.ts`.

**Tracked open items:**
- **The approved-source check belongs to S2a.** `fact_observations.source_id` only references the registry;
  nothing in SQL refuses observations from a source that is not `approved` yet. That check ships with
  `crawl_targets` in S2a (plan §5: a target whose registry source is not approved cannot be scheduled).
- C8 (news reports of official figures) is not modelled yet: news is never an official source here.
- Only `declared_possession` maps to the catalogue; `address`, `rera_numbers` and `construction_status` map to
  spec project columns in S1b, and unit price/area to `cost_sheets` (S5a).
- Locality observations have no `is_sample` cross-check (localities carry no such flag).

## Area developments (S4a, `0008_developments.sql`, D22 proposed)
Spec 06 developments are added to the existing `infrastructure_items`. The migration is additive, and the legacy
columns `declared_completion` and `sources` stay as trigger-maintained mirrors for S4a rows.

| Object | What it holds |
|---|---|
| `infrastructure_items` (extended) | Stage `proposed, approved, dpr_approved, tendered, under_construction, operational, shelved` (C19). Category adds `suburban_rail, flyover, ring_road, zoning`. New columns: `authority`, `announced_date`, `expected_completion` (verbatim, as declared), `completion_history` (derived), `confidence`, `source_id`, `source_url` (https), `source_observed_at`, `verification`, `added_by` (`research`/`staff`; null = legacy row), `research_job_id`, `research_locality_id`, `rejected_at`/`rejection_note`, `pending_change`, `staff_edited_at`, `reviewed_at` (first publish; kept after unpublish), `version`, `created_at`/`updated_at`, and the generated `name_key`. CHECKs: research rows carry source, URL and observed date; staff rows carry authority and URL; a published S4a row has authority, URL and observed date; a published row is never rejected. The unique index `(name_key, source_url)` on research rows means the same name on the same cited page is one row; rows are never merged on name alone. |
| `infrastructure_completion_history` | Append-only (UPDATE/DELETE/TRUNCATE rejected for every role). Each row is one declared date as seen: `expected_completion`, `as_of`, `source_url`. Written only by a `security definer` trigger whenever `expected_completion` is set or changes. |
| `infrastructure_review_events` | Append-only audit: `researched/created/edited/published/unpublished/rejected/restored` with actor and role. `system` may only record `researched`. |
| `developments` (view, `security_invoker`) | Spec 06 names (`development_id`, `type`, `status`, `expected_completion`, `revisions_count` = declarations − 1, `last_verified_at`, …). The caller's RLS applies. |

**Guard trigger.** S4a rows are inserted `unverified`. Identity columns never change. `verification` changes only
inside the RPCs (`tn.via_rpc`). A direct write to `completion_history` is ignored, and a changed declared date
appends a history entry. `version` bumps on any content change. An S4a row can't be inserted published, and any
row goes from unpublished to published only inside `development_set_review` (`tn.via_rpc`). The service role
has no DELETE or TRUNCATE on `infrastructure_items`.

**RPCs** (service role only, security invoker, row lock plus audit event):
- `development_store_research` upserts researched items. A pending draft takes the new values. A reviewed row (published, ever published (`reviewed_at`), rejected, or edited by staff (`staff_edited_at`)) keeps its values. Inserts use `ON CONFLICT DO NOTHING` and then re-select the row, so concurrent jobs storing the same item share one row. If research contradicts it, the new values go to `pending_change` and into the audit note, and `last_checked_at` is **not** refreshed. `last_checked_at` is refreshed only when research matches the stored values. Publishing (or a staff edit) clears `pending_change` and records what it cleared in the audit note.
- `development_create` is the staff manual entry.
- `development_update` takes `p_expected_version` and returns `ok | unchanged | conflict | not_found`. A content change resets verification. An edit that fails readiness unpublishes the row in the same statement and audits it as `auto: failed readiness after edit`.
- `development_set_review` handles publish, unpublish, reject and restore. Publish rechecks readiness via `tn_development_publish_blockers` (mirrored by `developmentPublishBlockers`, compared by a unit test) and may set `source_confirmed`.

`research_enqueue` gains `p_kind` (`search_miss` default, or `area_developments`). A CHECK ties
`kind = 'area_developments'` to `dev:%` keys that carry a locality. `research_claim_jobs(limit, stale)` now
claims `search_miss` jobs only (what a pre-S4a worker understands). The S4a worker calls
`research_claim_jobs(limit, stale, kinds)`.

**Access.** anon and authenticated get SELECT on published rows only (0001 policy) and only on public columns.
Hidden from them: the research job, rejection fields, pending change, version and timestamps. The history table
is readable only for published developments (`private.is_published_development`). Review events are visible to
staff only. The service role can SELECT, INSERT and UPDATE items, can SELECT history, and can SELECT and INSERT
review events.

**Server.**
- `DevelopmentRepository` (`getRepositories().developments`) has two implementations. Supabase reads with the anon client for buyers and uses the service role plus RPCs for staff. Fixture is an in-memory mirror that starts empty, so buyers see "Not yet researched".
- Services live in `src/server/services/developments.ts`, the pure logic (stage tiers, declared-date parsing, slips, haversine distance, wording) in `src/locality/developments.ts`, and the validator in `src/discovery/research/developments.ts`.
- Buyer display lists mapped items within 10 km straight-line of the project, nearest first, then unmapped items listed for the project's locality.
- Tests: `tests/db/developments.test.ts`, `src/locality/developments.test.ts`, `src/discovery/research/developments.test.ts`, `src/server/services/developments.test.ts`, `e2e/area-developments.spec.ts`.
- Not done yet: PostGIS geometry (lat/lng only for now), and a monitoring worker that drafts stage changes on a schedule (M6).
