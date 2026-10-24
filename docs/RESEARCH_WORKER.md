# On-demand research worker (M2.5)

When a buyer's free-text search on `/projects` finds nothing in either lane, TrueNest queues a research job. A worker then looks the query up with Anthropic's server-side web search and stores what it can cite as **unverified Lane B listings**. Later searches for the same query are served from the database. Source policy: `docs/DATA_SOURCE_POLICY.md` §11.

## Flow
1. **Miss (GET, read-only).** `/projects?q=…` returns 0 researched and 0 external results, and external discovery was queried without errors. The GET render only *reads* state with `lookupResearchOnMiss` (`src/server/services/research-jobs.ts`); it never enqueues. The result is one of: researching (a job is running, or queued within 30 minutes), searched_none (a recent `no_results` job), unavailable (the worker is not configured, or a job failed within 6 hours), or can_start.
   - Bots are skipped: an empty or crawler-like `User-Agent` gets no research state and no trigger. `src/app/robots.ts` disallows `/projects?*q=`, `/admin` and `/api/`, and query pages carry `noindex, follow`.
   - Outside fixture mode, when `ANTHROPIC_API_KEY` or a valid `RESEARCH_RUN_SECRET` is missing, the page shows the unavailable copy and nothing is queued, so a buyer never waits on a worker that cannot run.
2. **Start (POST).** For can_start, the page renders `ResearchTrigger`. With JavaScript it auto-submits the `startWebResearchAction` Server Action once. The page also renders a "Research this search" form button for the same POST, but under `cacheComponents` the results section streams inside Suspense, so a browser with JavaScript off does not see it (a limitation of the results section that predates M2.5). The action re-runs the search server-side and enqueues only if it is still a miss, which it does through `requestResearchOnMiss`. Crawlers neither run JavaScript nor POST forms.
3. **Enqueue.** `research_enqueue` (SQL, atomic, advisory-locked) first marks any job still `queued` after 30 minutes as `failed` with `stalled`. It then works through these checks in order:
   - If a job for the same normalised query (`queryKey`) is queued or running, it reuses that job.
   - If a done or `no_results` job finished within `RESEARCH_CACHE_HOURS`, it reuses that job.
   - If a job for the query failed within the last 6 hours (this includes `stalled`), it returns `failed_recently`, and the page shows "can't start new research right now". After 6 hours a new job may be queued.
   - If the global cap `RESEARCH_MAX_JOBS_PER_DAY` is reached, it refuses.
   - If the requester's cap (10 per 24 hours, keyed by an HMAC of the client IP) is reached, it refuses.
   - Otherwise it inserts a new job.

   A separate in-memory limit of 5 new jobs per client IP per hour is applied first. The client IP comes from `TRUSTED_PROXY_HOPS`, and the requester HMAC uses `SESSION_SECRET`. If the requester hash cannot be computed in production (no client IP or no secret), only the global cap applies and a one-time warning `research.requester_hash_unavailable` is logged.
4. **Page states.** The page shows one of three states. None of them reads as "no projects exist":
   - "We're researching "X" now… refresh to check": the job is queued or running.
   - "We searched public web sources … found nothing we could cite reliably": a recent `no_results` job.
   - "We can't start new research right now": a limit was hit, the worker is not configured, or the query failed recently.
5. **Worker.** `POST /api/internal/research/run` with header `x-research-secret: $RESEARCH_RUN_SECRET`. It claims up to `RESEARCH_BATCH_SIZE` jobs (`research_claim_jobs`, `FOR UPDATE SKIP LOCKED`; a running job older than 15 minutes is reclaimed if it has had fewer than 2 attempts, and otherwise marked `failed` with `abandoned`) and processes them concurrently.
6. **Per job.** The worker passes the registry gate (`assertRunnable`), calls Claude with web search, then validates the result against the citations (see Anti-fabrication). It runs the normal Lane B normalise and dedupe, upserts `external_listings` and links them in `research_job_listings`. The job ends as `done` or `no_results`. On a retryable error it is re-queued once, then marked `failed`.
7. **Serve.** Search adds the listings of the newest done job for the query, plus stored research listings matching the text or locality. It adds them only while the research source is runnable in this environment.

## Anti-fabrication
`src/discovery/research/validate.ts` keeps a field only if its value appears in text **the API cited** for a URL that **appeared in that response's web search results**. Everything else is dropped:
- RERA numbers, prices, developers or addresses that are not in a citation
- URLs that were not returned by the search, or are not https
- listing-portal hosts
- localities that do not map to exactly one active locality in `src/config/markets/`
- pages that name several projects. A candidate is dropped (`multiple_projects`) if its URL's citations contain more than one distinct RERA-shaped token, and also (`shared_url`) if several candidates share one URL.

Strict rules:
- **Same citation, near the name.** A fact (RERA, price, developer, locality) counts only if it appears in a cited text that also names the candidate, within 200 characters of the name. This stops one project's facts from being attributed to another project on a multi-project page.
- **Whole tokens.** A RERA number must equal a whole normalised token, never a fragment of a longer one or two tokens spliced together. A price must have a non-digit, non-dot boundary on both sides, so "45 L" does not match "1.45 L" and "5 Cr" does not match "2.5 Cr".
- **Stored URL.** The URL stored is the one from the matching `web_search_tool_result`, not the URL the model wrote.

The request uses the basic `web_search_20250305` tool (no dynamic filtering), so search results go straight into the model's context and its answer carries `web_search_result_location` citations, the only evidence the validator trusts. With dynamic filtering (`web_search_20260209`) the results are filtered by code first. On staging (2026-10-24) a job ended `no_candidates`; dynamic filtering is the suspected cause (the response itself was not observable), to be confirmed by the refined `no_candidates_*` codes on the next run. If the model returns candidates but the response has no search result blocks, the job fails closed with `no_evidence`.

## Cost guardrails
| Guardrail | Value |
|---|---|
| Model | `ANTHROPIC_MODEL` (default `claude-opus-5-5`), effort `medium` |
| `max_tokens` per request | 12,000 |
| Web searches per job (`max_uses`) | 5 |
| `pause_turn` resumptions | 2 |
| Jobs per day | `RESEARCH_MAX_JOBS_PER_DAY` (default 50) |
| Retries | 1 (SDK retries off) |
| Per-job deadline | 120 s (request timeout 110 s) |

## Environments
- **Fixture backend** (dev, unit tests, e2e, CI): an in-memory queue, the `sample-web-research` fixture source and `FakeResearchClient`. It never touches the network. `npm run research:run` processes only the jobs in its own process.
- **Supabase backend**: the `anthropic-web-search` source and `AnthropicResearchClient` (needs `ANTHROPIC_API_KEY`). Every path refuses until the registry entry is `approved` for the current environment. The worker then answers 503 `source_not_runnable`, and misses fall back to the normal empty state.

## Operations
- **Deploy:**
  1. Apply `0005_research_jobs.sql` (`npm run db:migrate`).
  2. Re-run the reference seed, so the `sources` table has `anthropic-web-search` (it is required by the `external_listings` foreign key).
  3. Set `ANTHROPIC_API_KEY` and `RESEARCH_RUN_SECRET` in Secret Manager.
  4. Schedule `POST /api/internal/research/run` every few minutes with the secret header. The hosting thread owns this.
- **Responses:**
  - 404: no secret is configured.
  - 401: the secret is wrong.
  - 503: the run was refused (`source_not_runnable` or `config`).
  - 200: `{claimed, outcomes: [{jobId, status, resultCount, errorCode}]}`.
- **Logs** contain job ids, statuses, counts and token usage only. They never contain the API key, the prompt, response text, query text or IPs. Staff see the query text on `/admin/research-jobs` (admin and advisor, read-only).
- **Error codes** (`research_jobs.error_code`): `timeout`, `rate_limited`, `api_error`, `auth`, `bad_request`, `refusal`, `max_tokens`, `parse_error`, `no_evidence` (candidates with no search result blocks), `store_failed`, `unknown`, `stalled` (still queued after 30 minutes, which usually means the worker is not scheduled; the failure is cached for 6 hours), and `abandoned` (still running after 15 minutes on its second attempt).
