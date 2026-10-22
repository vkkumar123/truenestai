# On-demand research worker (M2.5)

When a buyer's free-text search on `/projects` finds nothing in either lane, TrueNest queues a research job. A worker then looks the query up with Anthropic's server-side web search and stores what it can cite as **unverified Lane B listings**. Later searches for the same query are served from the database. Source policy: `docs/DATA_SOURCE_POLICY.md` §11.

## Flow
1. **Miss.** `/projects?q=…` returns 0 researched and 0 external results, and external discovery was queried without errors. The page calls `requestResearchOnMiss` (`src/server/services/research-jobs.ts`).
2. **Enqueue.** `research_enqueue` (SQL, atomic) works through these checks in order:
   - If a job for the same normalised query (`queryKey`) is queued or running, it reuses that job.
   - If a done or `no_results` job finished within `RESEARCH_CACHE_HOURS`, it reuses that job.
   - If the global cap `RESEARCH_MAX_JOBS_PER_DAY` is reached, it refuses.
   - If the requester's cap (10 per 24 hours, keyed by an HMAC of the client IP) is reached, it refuses.
   - Otherwise it inserts a new job.

   A separate in-memory limit of 5 new jobs per client IP per hour is applied first; the client IP comes from `TRUSTED_PROXY_HOPS`.
3. **Page states.** The page shows one of three states. None of them reads as "no projects exist":
   - "We're researching "X" now… refresh to check": the job is queued or running.
   - "We searched public web sources … found nothing we could cite reliably": a recent `no_results` job.
   - "We can't start new research right now": a limit was hit.
4. **Worker.** `POST /api/internal/research/run` with header `x-research-secret: $RESEARCH_RUN_SECRET`. It claims up to `RESEARCH_BATCH_SIZE` jobs (`research_claim_jobs`, `FOR UPDATE SKIP LOCKED`; running jobs older than 15 minutes are reclaimed) and processes them concurrently.
5. **Per job.** The worker passes the registry gate (`assertRunnable`), calls Claude with web search, then validates the result against the citations (see Anti-fabrication). It runs the normal Lane B normalise and dedupe, upserts `external_listings` and links them in `research_job_listings`. The job ends as `done` or `no_results`. On a retryable error it is re-queued once, then marked `failed`.
6. **Serve.** Search adds the listings of the newest done job for the query, plus stored research listings matching the text or locality. It adds them only while the research source is runnable in this environment.

## Anti-fabrication
`src/discovery/research/validate.ts` keeps a field only if its value appears in text **the API cited** for a URL that **appeared in that response's web search results**. Everything else is dropped:
- RERA numbers, prices, developers or addresses that are not in a citation
- URLs that were not returned by the search, or are not https
- listing-portal hosts
- localities that do not map to exactly one active locality in `src/config/markets/`
- pages that name several projects

Searches run as direct calls (`allowed_callers: ["direct"]`) so every result comes back as an auditable `web_search_tool_result` block.

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
- **Fixture backend** (dev, unit tests, e2e, CI): an in-memory queue, the `sample-web-research` fixture source and `FakeResearchClient`. It never touches the network. `npm run research:run` (once the script is added to `package.json`) processes only the jobs in its own process.
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
- **Error codes** (`research_jobs.error_code`): `timeout`, `rate_limited`, `api_error`, `auth`, `bad_request`, `refusal`, `max_tokens`, `parse_error`, `store_failed`, `unknown`.
