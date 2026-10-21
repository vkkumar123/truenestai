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
