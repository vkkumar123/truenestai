# Spec 14 — Research agent v2 (discover → verify → score), replaces spec 05 flow

**Owner agents:** property-discovery-engineer (`src/discovery/research/v2`), backend-data-
engineer (migration 0007, status route, trigger), frontend-engineer (status polling UI),
test-engineer (e2e with fake client; a one-off staging smoke script).
**Needs from Fury:** nothing new (ANTHROPIC_API_KEY, RESEARCH_RUN_SECRET already set).
Optional: enable Cloud Tasks in GCP for the push trigger (else the in-process fetch is used).

## Why
Staging evidence: both jobs ever run ended `no_results` (`no_candidates` on the latest). The
single call is asked to discover and prove in one pass under rules written for proving; the
validator drops instead of scoring; failures are cached for a week; the buyer waits on a
2-minute cron. v2 fixes each.

## A. Two calls
**Discover** (cheap model, `effort: high`, `max_uses: 8`, portals **not** blocked at search but
their URLs never stored): "List residential projects in North Bengaluru matching the search.
For each: name, developer, locality, one URL where you saw it (any site), and whether the page
is the developer's own site, a government page, news, or a listing portal." Output JSON array.
No "output [] if nothing reliable" escape; instead "if you found fewer than 3, say what you
searched". Candidates with a portal URL are kept as **discovery-only** (name/dev/locality,
`truth='estimated'`, confidence 0.4, `source_type='search'`, `source_url` = the search-result
URL for that page) and queued for verify.
**Verify** (per candidate, max 5 per job, developer/govt/news pages only, `max_uses: 3`):
extract RERA, address, price, possession with citations. Same evidence extraction as today.

## B. Scorer (replaces drop-only validator)
| evidence found | confidence | stored? | shows RERA/price? |
|---|---|---|---|
| name + fact in same `cited_text` window | 0.9 | yes | yes |
| name in cited text; fact elsewhere on same cited page | 0.75 | yes | fact as `estimated` |
| name only in search-result title | 0.7 | yes | no |
| name only in model answer, URL in search results | 0.5 | yes, discovery-only | no |
| URL not in search results / portal host / malformed | — | **dropped** | — |
Locality must still resolve to exactly one active locality (else candidate goes to
`resolution_review`, not dropped silently). Every stored row keeps `score_basis jsonb`.
Multi-project pages: keep the candidate, flag `multi_project=true`, suppress RERA/price.

## C. Trigger and latency
- `requestResearchOnMiss` → after `queued`, call `triggerWorker()` which POSTs the run
  endpoint with the secret (`fetch`, 2 s timeout, fire-and-forget) or enqueues a Cloud Task.
- Scheduler stays at 2 min as a sweep for stalled/retry jobs.
- `GET /api/research/status?key=<queryKey>` → `{state, resultCount, updatedAt}`; the
  `ResearchNotice` polls every 5 s for up to 3 min, then swaps in results via
  `router.refresh()`.
- Target: first results visible in ≤ 60 s for a typical query.

## D. Caching and diagnostics
- `RESEARCH_CACHE_HOURS` applies to `done` only; `no_results` 12 h; `failed` 1 h; staff
  "Re-run" button on `/admin/research-jobs` bypasses all three.
- `research_jobs` gains: `stop_reason, model, search_result_blocks, candidates_received,
  accepted, dropped jsonb, fields_dropped jsonb, input_tokens, output_tokens, web_searches`.
  Admin page shows them. No prompt/response text stored (privacy rule unchanged).

## E. Gap detector (feeds this agent beyond "search miss")
Enqueue with `trigger ∈ {gap, stale, low_confidence, user_question, page_build}` and an
`attribute` when known (spec 05 table). Attribute-scoped verify calls are cheaper and more
accurate than query-scoped ones; reuse the verify prompt with the attribute named.

## F. Cost guardrails (unchanged, retuned)
Discover ≤ 8 searches; verify ≤ 3 × 5; per job ≤ 25 searches, 120 s deadline, 50 jobs/day
global, 10/requester/day, 5/IP/hour. Cheap model for discover and verify; strong model only
for locality adjudication.

## G. Test plan
- Unit: scorer table above as parametrised cases; parse of discover/verify outputs; trigger
  no-op when secret missing.
- e2e (fixture): miss → trigger → status endpoint flips → results render without manual
  refresh.
- Staging smoke (`scripts/diag/`): search a unique query (timestamp suffix), assert a
  `research_jobs` row reaches `done` with `result_count > 0` within 3 min via Supabase, else
  fail and print the diagnostics columns. The existing screenshot-only diagnostic is replaced.

## Done when
On staging, "apartments in Yelahanka under 1.2 Cr" shows ≥ 3 unverified listings within 60 s
without a manual refresh; "Assetz" shows the Assetz projects it finds; admin page shows the
diagnostics; a forced re-run works; a query that truly finds nothing is retried after 12 h.
