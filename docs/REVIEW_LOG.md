# Review log

Each entry: milestone/scope, reviewer run, findings (severity, file, status), verdict.

## M1 — review round 1 (2026-10-21)
Reviewer: quality-reviewer (read-only). Input: diff 5c21dcf..0fd7c40+, check/test:db/build/e2e all green.
Verdict: **CHANGES REQUIRED** (0 critical, 1 high, 6 medium, 11 low).

| ID | Sev | Finding | Plan |
|---|---|---|---|
| H1 | high | Browse lacks BHK/status/lane filters required by M1 | fix now (backend + frontend + e2e) |
| M1 | med | Dedupe union-find can merge conflicting RERA via a bridge record | fix now (discovery) |
| M2 | med | No https-only validation for Lane B / provenance URLs | fix now (discovery, DB checks, UI) |
| M3 | med | Advisor = admin; PII rewritable on withdrawn rows | partial now (admin-only withdraw, withdrawn-PII trigger); assignment scoping → M2 |
| M4 | med | Unused anon INSERT grant on leads bypasses app controls | fix now (revoke) |
| M5 | med | Admin: no status-persist e2e, no type filter, no Lane B context | fix now |
| M6 | med | Supabase session refresh missing | deferred to M2 (needs live Supabase) |
| L1–L11 | low | rate-limit keys, dev login throttle, banner side effect, status filter after limit, `next` query loss, realistic phones in tests, uncommitted privacy promise, getStaffSession throw, RPC probing, default privileges, lint warning | L1,L3,L4,L5,L6,L7,L8,L10,L11 now; L2,L9 → M2 |

## M1 — review round 2 (2026-10-21)
Input: diff 0fd7c40..HEAD; check (209 unit), test:db 26/26, build, e2e 28/28 — all observed green by orchestrator.
Verdict: **PASS** (no open critical/high). All round-1 fixes verified in code; no regressions found.

New (low), carried to M2 backlog:
- N1: `lane=external` can show a researched project as an unverified listing (no project matching when researched = []). Fix: always pass published projects to discovery matching; show "Researched version available".
- N2: Supabase text search omits developer name (fixture includes it).
- N3: per-contact rate limit keys on `email ?? phone`; key every present contact value.

Still carried to M2: M3 advisor assignment scoping, M6 Supabase session refresh, L2 dev-login throttle, L9 `is_published_project` RPC exposure.

## M3 — review round 1 (2026-10-21)
Input: diff 7e3ea8b..HEAD; check 267, test:db 33/33, build, e2e 34/34.
Verdict: **CHANGES REQUIRED** (0 critical, 1 high, 3 medium, 8 low).

| ID | Sev | Finding | Plan |
|---|---|---|---|
| H1 | high | Verification applies to the current fact, not the version the reviewer saw (stale tab confirms an unseen RERA value) | fix now: version token + conditional update + test |
| M1 | med | Change and audit event not atomic | fix now: single transaction RPCs in Supabase; fixture writes audit first-then-apply with rollback |
| M2 | med | Readiness check then publish is check-then-act | fix now: publish re-checks inside one transaction (RPC with row lock); fixture is single-threaded |
| M3 | med | D13: advisor edits to published legal facts go live; advisor can clear a dispute | fix now: D13 revised (auto-unpublish when an edit makes a published project fail readiness; disputed→unverified admin-only); owner asked to confirm |
| L1–L8 | low | free-text sourceId vs FK, automated-actor check is nominal, workaround runs pre-auth and in prod, lastCheckedAt bumped by publish/verify, malformed id 500, history hides actor id, Lane B match cap 50, developer reuse by name | L1, L3–L8 fix now; L2 documented (workers never hold a staff session) |

## M3 — review round 2 (2026-10-21)
Input: diff 258da35..HEAD; check 291, test:db 40/40, build, e2e 36/36 (observed by orchestrator from a clean `.next`).
Verdict: **PASS**. H1, M1–M3, L1–L8 verified fixed or documented; D13 confirmed by owner.

Carried to M2 (before Supabase goes live):
- R1 (med): concurrent verification changes on the same fact can overwrite in Supabase; pass `p_expected_from` and compare under the lock.
- R2 (low): completeness computed before the lock in `research_set_fact`; recompute inside the RPC or re-read after.
- R3 (low): auto-unpublish message split on a sentence fragment in `action-feedback.tsx`; return flag and base message separately.
- R4 (low): SQL/TS publish-blocker rule parity test; unauthenticated no-JS post skips dev workaround; seed registry ids into `sources`.

## M2 — review round 1 (2026-10-22)
Input: diff feature/m3-research-tooling...feature/m2-supabase-live; check 324, test:db, build, e2e 46/46 (clean `.next`). Live Supabase not exercised (sandbox cannot reach supabase.co).
Verdict: **PASS** (0 critical, 0 high, 1 medium, 6 low). M3 carry-overs R1–R4 confirmed resolved.

| ID | Sev | Finding | Plan |
|---|---|---|---|
| M1 | med | `db:seed`/bare `--seed` loads published SAMPLE projects; nothing stops it on production | fix now |
| L1 | low | `authenticated` SELECT/UPDATE on `leads`, INSERT on `lead_events` unused by the app; advisor could bypass service rules via PostgREST | fix now (0004 revoke) |
| L2 | low | Per-email throttle locks out staff; successes counted; per-instance | fix now |
| L3 | low | Uploaded document metadata public on published projects without review | accepted as D15 |
| L4 | low | Upload cleanup can delete an object whose row committed | fix now |
| L5 | low | Reference seed publishes fixture sources as approved | fix now |
| L6 | low | Advisors can list all staff | fix now |

## M2 — review round 2 (2026-10-22)
Input: working-tree fixes incl. `0004_m2_review.sql`; check 327, test:db 57/57, build, e2e 46/46 (clean `.next`, observed by orchestrator).
Verdict: **PASS**. M1, L1, L2, L4, L5, L6 fixed; L3 → D15.

Open (low):
- N1: parallel login attempts all pass the check before failures are recorded; Supabase Auth has its own limits. Accepted for now.
- N2: resolved — production marker step is in SUPABASE_SETUP §6 and `tests/db/migrate-seed.test.ts` covers seed.sql refusing a marked DB.
- Live smoke test against the owner's Supabase is required before go-live.

## M2.5 — review round 1 (2026-10-22)
Input: 117ea5f (diff origin/main...HEAD); check 367, test:db 64, build, e2e 48. No live API call.
Verdict: **CHANGES REQUIRED** (0 critical, 1 high, 4 medium, 6 low).
- H1: missing key/secret or no scheduler left buyers on "researching" forever (queued jobs never expired).
- M1: cross-attribution on multi-project pages. M2: substring matches let RERA fragments/price splices through. M3: paid research enqueued during GET render; no robots. M4: failed jobs not cached.
- L1 model URL stored; L2 undocumented `allowed_callers`; L3 stale-running reclaim loop; L4 null requester hash silent; L5 doc drift; L6 /request lookup ungated.

## M2.5 — review round 2 (2026-10-22)
Input: d993519; check 387 (observed by orchestrator), test:db 65, build, e2e 50.
Verdict: **PASS**. All round-1 findings verified fixed.
Low, open/accepted:
- L-a: spoofable UA; IP rotation can exhaust the 50/day cap (honest "unavailable"; no runaway spend). Later: Cloud Armor rule on POST /projects.
- L-b: fixed by orchestrator — a running job past stale window + job deadline shows "unavailable".
- L-c: 200-char citation window can admit a neighbouring card's price on dense pages; accepted (Lane B, unverified, sourced).
- L-d: fixed — RESEARCH_WORKER.md no longer overstates no-JS support (Suspense streaming limitation predates M2.5).
- L-e: real API search-result block shape untested; fails closed (`no_evidence`). Staging smoke call required before enabling the scheduler.
- Deploy check: 0005 edited in place; confirmed not on origin/main and not applied by any database before merge.

## S1a fact store — review round 1 (2026-10-23)
Input: 6221878 (feat/02-fact-store); check 401, test:db 76. No live or remote database touched.
Verdict: **CHANGES REQUIRED** (0 critical, 4 high, 5 medium, 4 low).
- H1: the curated backfill counted web-search sources (registry type `developer`) as official.
- H2: `facts.truth_status` could be changed freely, so a fact could be relabelled official by hand.
- H3: staff-added observations could be inserted as verified with no actor or audit event.
- H4: Supabase's default ALL privileges for `service_role` were not revoked on the new tables and views.
- M1 truncate of facts/fact_sources; M2 sourceless curated values and basis-less estimates; M3 representative source; M4 official needs an official source type; M5 verified unknown curated rows overrode observations.
- L1 is_sample integrity + production refusal; L2 date comparison; L3 rejected sources; L4 approved-source check (S2a).

## S1a fact store — review round 2 (2026-10-23)
Input: d53368f; check 405, test:db 81.
Verdict: **PASS**. All round-1 findings verified fixed. Follow-ups closed in the next commit (0006 not yet applied anywhere):
- estimate_basis CHECK requires a non-empty `sources` array; `listCurrent`/`getCurrent` skip a malformed row and log only its id.
- Curated truth is derived at read time in `facts_current` and `facts_history` (stored value is a fallback only; H2 guard unchanged).
- CHECK: a web research source always writes `source_type = 'search'`.
- `facts.verification` changes only inside `research_set_verification` / `research_set_fact` (`tn.via_rpc` flag, redefined in 0006 with otherwise identical bodies); a direct UPDATE is refused. The flag is a guard against accidental writes, not a security boundary.
## M2.5 staging fix — review round 1 (2026-10-23)
Input: 57416fb (filtered-search hint, request-time sample banner, title-backed citations, no-results diagnosis); check 391, build, e2e 51.
Verdict: **CHANGES REQUIRED** (1 high).
- H1: a title-only name match let any citation on the page supply the RERA number and price, so another project's registration could be attached.

## M2.5 staging fix — review round 2 (2026-10-23)
Input: 1d47343; check 393, research e2e 15.
Verdict: **PASS**. H1 fixed: in title-only mode RERA and price need the name window (always dropped), and the name must have 2+ words and not be the developer name.
Low, open/accepted:
- L1: the developer-name guard relies on the model's developerName; a developer-style title can still pass as an unverified listing without RERA or price. Optional hardening later.
- L2: fixed — stale comment above the title-only check.

## Research empty-run fix — review (2026-10-24)
Input: 98ff691 (basic web_search_20250305, prompt tweak, refined no_candidates_* codes); check 411, research e2e 15.
Verdict: **PASS**. Validator untouched; prompt still forbids guessing; counts-only logs; codes fit the CHECK.
- L1: fixed — docs/comment now call dynamic filtering the suspected (not confirmed) cause.

## S3a K-RERA extraction — review round 1 (2026-10-24)
Input: 20ac74b (0007, extraction service, admin UI, tests, D19 precedence); check 433, test:db 90, build, e2e 53.
Verdict: **CHANGES REQUIRED** (1 high, 2 medium, 4 low). All addressed in the follow-up change on the same branch.
- H1: the verbatim check matched substrings ("2" in "112/2", "registered" in "unregistered", "40" in "240"). Fixed: `findVerbatim` matches whole tokens (no adjacent letter/digit, no joiner `/ . , -` into one); the excerpt is taken at the match; unit tests for the four cases.
- M1: list attributes kept only the first item's page. Fixed: an item cited on another page is dropped as `other_page` (tested).
- M2: `facts_current` could pick a winner with no `source_url` (constitution §1). Fixed: `extraction_finish` refuses `succeeded` for a document without a source URL; the upload requires the K-RERA page URL for RERA certificates and regulator sources (the UI says so); the service marks such a document `unsupported` / `source_url_missing`; the relaxed `value_matches_status` is documented in DATA_MODEL. Tested in unit, service and test:db.
- L1: `max_tokens` → failed `truncated` (retryable), nothing stored (tested).
- L2: a citation spanning more than one page is not used; with no one-page citation the value is dropped as `multi_page` (tested).
- L3: `extraction_finish` raises on a duplicate attribute in `p_values` (test:db).
- L4: storage `read()` returns the bytes with `contentType: null` for non-sniffable objects; the service maps that to unsupported / `not_pdf`; downloads refuse it (tested).

## S3a K-RERA extraction — review round 2 (2026-10-24)
Status: **pending re-review** of the round-1 fixes.
