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

| Table | anon / authenticated | staff (authenticated + staff_profiles) | writes |
|---|---|---|---|
| market_phases, zones, localities, amenities, external_listings | SELECT all | — | service role |
| sources | SELECT where `status='approved'` | — | service role |
| projects | SELECT where `published` | — | service role |
| developers, project_units, facts (current), fact_sources, regulatory_records, regulatory_searches | SELECT only for published projects | — | service role |
| project_documents | SELECT (all columns except `storage_path`) for published projects | — | service role |
| infrastructure_items | SELECT where `published` | — | service role |
| source_observations | none | none | service role |
| staff_profiles | own row only (authenticated) | own row | service role |
| project_search_index (view, `security_invoker`) | SELECT (inherits projects/facts/units RLS) | — | — |
| leads | **none** (no INSERT, no SELECT): the server validates, rate-limits and stores leads with the service role | SELECT, UPDATE (status + erasure columns) | service role |
| lead_events | none (a trigger writes `created`) | SELECT; INSERT with `actor_id = auth.uid()` | service role |

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
the `admin` role. **Not yet implemented:** per-advisor lead assignment/scoping — every staff member can see all
leads (planned with milestone M2).

Tests: `npm run test:db` drops and recreates the `public`/`auth` schemas in `DATABASE_URL_TEST`, applies
`tests/db/supabase-shim.sql` (test-only stand-in for Supabase roles and `auth.uid()`), then every migration,
and asserts the policies above.

## Leads, consent and retention
- Stored only with `contact_consent = true`; `marketing_consent` is separate and optional;
  `consent_text_version` records the exact wording agreed to; `consented_at` is set server-side.
- `retention_until` = created + 12 months (open) or 24 months (closed/withdrawn) — `src/leads/retention.ts`
  (assumption pending legal review, DPDP Act 2023). Withdrawal erases PII immediately, keeping a minimal audit stub.
- Logs carry only `redactLeadForLog` fields (id, status, requestType). Audit events carry no PII.
- Fixture mode keeps leads in server memory per process (dev only).
- Rate limiting (dev-grade, in-memory per process; production needs a shared store) counts only *valid*
  submissions, keyed both on the client IP and on the hashed email/phone. The IP is the first
  `X-Forwarded-For` hop, which is trustworthy only behind a proxy that overwrites that header (e.g. Vercel);
  otherwise it is client-controlled and only the per-contact key is meaningful.
- A scheduled purge of leads past `retention_until` is not implemented yet.

## Auth
- Supabase mode: `@supabase/ssr` cookie session, verified with `auth.getUser()`, role from `staff_profiles`.
  Session refresh needs a Next proxy/middleware (not part of this slice).
- Fixture mode (dev only): `ADMIN_DEV_PASSWORD` (≥ 12 chars, constant-time compare) issues an httpOnly,
  `sameSite=lax`, 8-hour HMAC-signed cookie (`SESSION_SECRET` ≥ 32 chars). Refused when `NODE_ENV=production`.
