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
