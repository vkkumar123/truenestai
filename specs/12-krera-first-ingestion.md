# Spec 12 — K-RERA as the first source (staff-driven ingestion)

**Owner agents:** regulatory-research-engineer (`src/research`, `src/ingest/krera-import`),
backend-data-engineer (migration, repository), frontend-engineer (`/admin/import`).
**Needs from Fury:** (1) one K-RERA export or hand-built sheet of North Bengaluru projects to
seed with (40–80 rows; columns below); (2) confirmation that staff-initiated lookups in a
normal browser are acceptable (they are not crawling); (3) optional: send the official data
request to K-RERA (template in Part E).

## Why
K-RERA is the source of record and must rank first (ARCHITECTURE_V2 §2), but automated access
is robots-disallowed (D16). So K-RERA data enters through **people**, with a tool that makes
their work fast, auditable and re-verifiable, and every page links out to K-RERA for the buyer.

## Part A — Import file contract
CSV/XLSX, one row per RERA registration (a project with several phases = several rows, later
grouped by `project_group`):

| column | required | maps to |
|---|---|---|
| `rera_number` | yes | `projects.rera_number` (normalised with `normaliseRera`) |
| `project_name` | yes | `projects.name` |
| `promoter_name` | yes | `builders.name` (+ alias) |
| `locality_text` | yes | resolved via `findLocalitiesByText`; unresolved → review queue |
| `address` | no | fact `address` |
| `registration_date`, `proposed_completion_date`, `revised_completion_date` | no | facts `rera_registration_date`, `rera_completion_date` (+ history) |
| `status_text` | no | fact `rera_status` |
| `total_units`, `towers`, `land_area` | no | facts |
| `krera_url` | yes | `source_url` for every imported fact |
| `observed_at` | yes | export/lookup date |
| `lat`, `lng`, `map_url` | no | geocode inputs |

## Part B — Importer (`src/ingest/krera-import`)
1. Parse → zod-validate rows → dry-run report (new / updated / conflicting / unresolved locality).
2. Upsert `builders` (alias table gets `promoter_name`), `projects` (`published=false`,
   `is_sample=false`), facts with `source_type='rera'`, `truth='official'`,
   `verification='unverified'`, `source_url=krera_url`, `observed_at`.
3. Changed values on an existing fact → new observation + history row, never overwrite.
4. Audit event per row (`imported_by`, file hash).
5. Geocode queue entry for rows without coordinates (spec 06 Part A).

## Part C — Review queue (`/admin/import`, `/admin/projects/[id]`)
- Admin sees imported projects grouped by locality with a "Verify RERA" checklist:
  open K-RERA link (new tab), confirm number/name/dates, tick → `research_set_verification`
  marks the RERA facts `reviewed`. Publish button enables when publish readiness passes
  (`src/research/publish.ts`).
- Re-verification reminder: RERA facts older than 90 days show a "re-check" badge; a weekly
  staff task lists them.

## Part D — Staff-initiated lookups with Fury's own browser (not a crawler)
For a single project Fury can ask Claude (Chrome extension or desktop browser pane) to open the
K-RERA project page **he navigates to**, read the visible fields and fill the import sheet.
Rules: one page at a time, human-initiated, no scheduled runs, no bypassing CAPTCHA/login,
record the URL and timestamp. This is the "manual staff lookup" of REGULATORY_SOURCES.md done
faster, and it stays within D16.

## Part E — Official channel request (template, send once)
To: Secretary, Karnataka Real Estate Regulatory Authority. Subject: request for bulk project
registration data for consumer-information use. Ask for: periodic export (CSV/API) of
registered projects in Bengaluru Urban/Rural with number, promoter, dates, status, extensions,
complaint counts; cite consumer transparency purpose, commit to attribution and no
republication of personal data. Track in `MCP_REQUESTS.md` as R6.

## Buyer-facing
Every project page: "RERA {number} · registered {date} · completion {date} (revised {n}×) ·
verified by TrueNest on {date} · **View on K-RERA ↗**". Complaint line follows the evidence
rule ("No complaint found as of {date} in {sources}…").

## Done when
A 10-row sample file imports with a dry-run report, two rows deliberately conflicting show as
conflicts (not overwrites), unresolved locality lands in the queue, verification flips facts to
`reviewed`, publish succeeds, and the project page renders the K-RERA block with the link-out.
