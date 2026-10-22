import "server-only";
import { createHmac } from "node:crypto";
import { getLocality, listLocalities } from "@/config/markets";
import { currentEnv, getSource, isRunnable, type RuntimeEnv, type SourceEntry } from "@/discovery";
import {
  FakeResearchClient,
  ResearchClientError,
  assertResearchRunnable,
  cleanQueryText,
  queryKey,
  researchQuery,
  type ResearchClient,
  type ResearchErrorCode,
} from "@/discovery/research";
import { requireStaff } from "../auth";
import { UNKNOWN_CLIENT_KEY } from "../client-ip";
import { ConfigError, researchBatchSize, researchCacheHours, researchMaxJobsPerDay, researchRunSecret, sessionSecret } from "../env";
import { AnthropicResearchClient } from "../integrations/anthropic-research-client";
import { log } from "../log";
import {
  RESEARCH_FAILURE_COOLDOWN_HOURS,
  RESEARCH_STALL_MINUTES,
  getRepositories,
  type Repositories,
  type ResearchJob,
  type ResearchJobWithListings,
} from "../repositories";
import { FixedWindowRateLimiter } from "./rate-limit";

/** New research jobs one client may start per hour (in-memory, per instance; the DB caps per day). */
export const RESEARCH_IP_MAX_PER_HOUR = 5;
/** New research jobs one client may start per 24 hours (shared, enforced in research_enqueue). */
export const RESEARCH_MAX_JOBS_PER_REQUESTER_PER_DAY = 10;
/** Wall-clock deadline per job (the Messages API call is aborted after this). */
export const RESEARCH_JOB_TIMEOUT_MS = 120_000;
/** A job "running" longer than this is assumed abandoned and may be claimed again. */
export const RESEARCH_STALE_MINUTES = 15;
/** First run + one retry. */
export const RESEARCH_MAX_ATTEMPTS = 2;

/** The research source for a data backend: the fixture source (fake client) unless Supabase. */
export function researchSourceFor(backend: Repositories["backend"]): SourceEntry {
  return getSource(backend === "supabase" ? "anthropic-web-search" : "sample-web-research")!;
}

/** Fixture mode never builds the real client, so dev, tests and CI cannot reach the network. */
export function researchClientFor(backend: Repositories["backend"]): ResearchClient {
  return backend === "supabase" ? new AnthropicResearchClient() : new FakeResearchClient();
}

// ---------------------------------------------------------------------------
// Public search miss: read-only state for the GET render, enqueue only from a POST
// ---------------------------------------------------------------------------

/**
 * Page state for a search miss. "can_start" means nothing is known for this query yet: the page
 * renders the research trigger (a form posted to a Server Action, auto-submitted with JS).
 */
export type ResearchMissState =
  | { state: "researching"; queryText: string }
  | { state: "searched_none"; queryText: string; searchedAt: string }
  | { state: "unavailable"; queryText: string }
  | { state: "can_start"; queryText: string; localityId: string | null };

const LIMITER_KEY = Symbol.for("truenest.researchEnqueueLimiter");
const WARNED_KEY = Symbol.for("truenest.researchWarnings");
type G = typeof globalThis & { [LIMITER_KEY]?: FixedWindowRateLimiter; [WARNED_KEY]?: Set<string> };
function sharedLimiter(): FixedWindowRateLimiter {
  const g = globalThis as G;
  return (g[LIMITER_KEY] ??= new FixedWindowRateLimiter(RESEARCH_IP_MAX_PER_HOUR, 3_600_000));
}

/** Logs `event` once per server process. */
function warnOnce(event: string, fields?: Record<string, string>) {
  const g = globalThis as G;
  const seen = (g[WARNED_KEY] ??= new Set());
  if (seen.has(event)) return;
  seen.add(event);
  log.warn(event, fields);
}

/** Test hook. */
export function resetResearchWarningsForTesting() {
  (globalThis as G)[WARNED_KEY]?.clear();
}

/** HMAC of the client key (never the raw IP). null without a SESSION_SECRET or for the shared unknown bucket. */
export function requesterHash(clientKey: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!clientKey || clientKey === UNKNOWN_CLIENT_KEY) return null;
  let key: string;
  try {
    key = sessionSecret(env);
  } catch {
    return null;
  }
  return createHmac("sha256", key).update(`research-requester:${clientKey}`).digest("hex");
}

/** Obvious crawlers, link previewers and scripted clients. An empty user agent counts as a bot. */
const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|scrape|preview|facebookexternalhit|embedly|headless|phantom|lighthouse|python-|requests|curl\/|wget|httpclient|okhttp|go-http|java\/|libwww|node-fetch|axios|undici|postman/i;
export function isLikelyBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  return ua.length === 0 || BOT_UA.test(ua);
}

/**
 * Whether the worker can actually run for this backend. Fixture mode always can (fake client).
 * Supabase mode needs ANTHROPIC_API_KEY and RESEARCH_RUN_SECRET; without them a job would sit
 * queued forever, so the page says "unavailable" instead of "researching".
 */
export function researchWorkerConfigured(backend: Repositories["backend"], env: NodeJS.ProcessEnv = process.env): boolean {
  if (backend === "fixture") return true;
  return Boolean(env.ANTHROPIC_API_KEY?.trim()) && researchRunSecret(env) !== null;
}

export interface ResearchMissDeps {
  repos?: Repositories;
  env?: RuntimeEnv;
  limiter?: FixedWindowRateLimiter;
  processEnv?: NodeJS.ProcessEnv;
  now?: number;
}

type Prepared = { queryText: string; localityId: string | null; key: string; repos: Repositories; pe: NodeJS.ProcessEnv };

/** null = research does not apply here (query too short, source not runnable): normal empty state. */
function prepare(input: { queryText: string; localityId?: string | null }, deps: ResearchMissDeps): Prepared | null {
  const queryText = cleanQueryText(input.queryText);
  const localityId = input.localityId && getLocality(input.localityId) ? input.localityId : null;
  const key = queryKey(queryText, localityId);
  if (!key) return null;
  const repos = deps.repos ?? getRepositories();
  if (!isRunnable(researchSourceFor(repos.backend), deps.env ?? currentEnv())) return null;
  return { queryText, localityId, key, repos, pe: deps.processEnv ?? process.env };
}

/**
 * READ-ONLY state for a search miss (safe in a GET render: never writes, never enqueues).
 * Returns null when research does not apply here or for obvious bots.
 */
export async function lookupResearchOnMiss(
  input: { queryText: string; localityId?: string | null; userAgent?: string | null },
  deps: ResearchMissDeps = {},
): Promise<ResearchMissState | null> {
  const p = prepare(input, deps);
  if (!p) return null;
  if (isLikelyBot(input.userAgent)) return null;
  if (!researchWorkerConfigured(p.repos.backend, p.pe)) {
    warnOnce("research.worker_unconfigured", { backend: p.repos.backend });
    return { state: "unavailable", queryText: p.queryText };
  }
  try {
    const nowMs = deps.now ?? Date.now();
    const within = (iso: string | null, ms: number) => !!iso && nowMs - Date.parse(iso) < ms;
    const jobs = await p.repos.researchJobs.listForQuery(p.key, 10);
    const { queryText } = p;
    // Same precedence as research_enqueue: active → cached result → recent failure → can start.
    // A queued job not picked up for RESEARCH_STALL_MINUTES is not "researching": the next
    // enqueue marks it failed ('stalled').
    if (jobs.some((j) => j.status === "running" || (j.status === "queued" && within(j.startedAt ?? j.requestedAt, RESEARCH_STALL_MINUTES * 60_000))))
      return { state: "researching", queryText };
    const cacheMs = researchCacheHours(p.pe) * 3_600_000;
    const cached = jobs.find((j) => (j.status === "done" || j.status === "no_results") && within(j.finishedAt, cacheMs));
    if (cached) {
      return cached.status === "no_results" || cached.resultCount === 0
        ? { state: "searched_none", queryText, searchedAt: cached.finishedAt ?? cached.requestedAt }
        : null; // its listings are served by search
    }
    if (jobs.some((j) => j.status === "failed" && within(j.finishedAt, RESEARCH_FAILURE_COOLDOWN_HOURS * 3_600_000)))
      return { state: "unavailable", queryText };
    return { state: "can_start", queryText: p.queryText, localityId: p.localityId };
  } catch (e) {
    log.warn("research.lookup_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return null;
  }
}

/**
 * Starts research for a confirmed search miss (call only from a POST: the Server Action).
 * Reuses an active job, a recent result or a recent failure for the same normalised query;
 * otherwise enqueues one within the per-client and global daily limits. Bots never enqueue.
 * Returns null when research does not apply here (normal empty state).
 */
export async function requestResearchOnMiss(
  input: { queryText: string; localityId?: string | null; clientKey: string; userAgent?: string | null },
  deps: ResearchMissDeps = {},
): Promise<Exclude<ResearchMissState, { state: "can_start" }> | null> {
  const p = prepare(input, deps);
  if (!p) return null;
  if (isLikelyBot(input.userAgent)) return null;
  if (!researchWorkerConfigured(p.repos.backend, p.pe)) {
    warnOnce("research.worker_unconfigured", { backend: p.repos.backend });
    return { state: "unavailable", queryText: p.queryText };
  }
  const { queryText, key, localityId, repos, pe } = p;
  const limiter = deps.limiter ?? sharedLimiter();
  const blocked = limiter.isBlocked(input.clientKey, deps.now);
  const ipHash = requesterHash(input.clientKey, pe);
  if (ipHash === null && pe.NODE_ENV === "production") {
    // Without SESSION_SECRET (or behind a proxy that sends no X-Forwarded-For) only the global
    // daily cap and the in-memory per-instance limit protect against a single heavy client.
    warnOnce("research.requester_hash_unavailable", {
      reason: input.clientKey === UNKNOWN_CLIENT_KEY ? "no_client_ip" : "no_session_secret",
    });
  }
  try {
    const result = await repos.researchJobs.enqueue({
      queryText,
      queryKey: key,
      localityId,
      requesterIpHash: ipHash,
      cacheHours: researchCacheHours(pe),
      // A rate-limited client may still see an existing job, but cannot start one (cap 0).
      maxPerDay: blocked ? 0 : researchMaxJobsPerDay(pe),
      maxPerRequesterPerDay: RESEARCH_MAX_JOBS_PER_REQUESTER_PER_DAY,
    });
    switch (result.outcome) {
      case "queued":
        limiter.hit(input.clientKey, deps.now);
        log.info("research.enqueued", { jobId: result.job.id });
        return { state: "researching", queryText };
      case "active":
        return { state: "researching", queryText };
      case "cached":
        return result.job.status === "no_results" || result.job.resultCount === 0
          ? { state: "searched_none", queryText, searchedAt: result.job.finishedAt ?? result.job.requestedAt }
          : null;
      case "failed_recently":
        return { state: "unavailable", queryText };
      case "daily_cap":
      case "requester_cap":
        log.warn("research.enqueue_limited", { outcome: blocked ? "client_rate_limit" : result.outcome });
        return { state: "unavailable", queryText };
    }
  } catch (e) {
    if (e instanceof ConfigError) log.error("research.misconfigured", { reason: e.message });
    else log.warn("research.enqueue_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface ResearchJobOutcome {
  jobId: string;
  status: ResearchJob["status"];
  resultCount: number;
  errorCode: string | null;
}

export interface ResearchBatchResult {
  refused: ResearchErrorCode | null;
  claimed: number;
  outcomes: ResearchJobOutcome[];
}

export interface ResearchBatchDeps {
  repos?: Repositories;
  client?: ResearchClient;
  source?: SourceEntry;
  env?: RuntimeEnv;
  batchSize?: number;
  timeoutMs?: number;
  now?: () => Date;
}

function withDeadline<T>(p: Promise<T>, controller: AbortController, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ResearchClientError("timeout", true));
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Processes up to RESEARCH_BATCH_SIZE queued jobs concurrently. Refuses (claims nothing) unless
 * the research source is runnable in this environment. Stores survivors as unverified Lane B
 * listings; never publishes, verifies or creates researched (Lane A) projects.
 * Logs only job ids, statuses, counts and token usage.
 */
export async function runResearchBatch(deps: ResearchBatchDeps = {}): Promise<ResearchBatchResult> {
  const repos = deps.repos ?? getRepositories();
  const source = deps.source ?? researchSourceFor(repos.backend);
  const env = deps.env ?? currentEnv();
  const now = deps.now ?? (() => new Date());
  if (!isRunnable(source, env)) {
    log.warn("research.run_refused", { sourceId: source.id, reason: "source_not_runnable" });
    return { refused: "source_not_runnable", claimed: 0, outcomes: [] };
  }
  let client: ResearchClient;
  try {
    client = deps.client ?? researchClientFor(repos.backend);
    assertResearchRunnable(source, env, client);
  } catch (e) {
    const code: ResearchErrorCode = e instanceof ResearchClientError ? e.code : "config";
    log.error("research.run_refused", { sourceId: source.id, reason: code });
    return { refused: code, claimed: 0, outcomes: [] };
  }

  const jobs = await repos.researchJobs.claim(deps.batchSize ?? researchBatchSize(), RESEARCH_STALE_MINUTES);
  const localityNames = listLocalities({ activeOnly: true }).map((l) => l.name);
  const timeoutMs = deps.timeoutMs ?? RESEARCH_JOB_TIMEOUT_MS;

  const outcomes = await Promise.all(
    jobs.map(async (job): Promise<ResearchJobOutcome> => {
      const controller = new AbortController();
      try {
        const r = await withDeadline(
          researchQuery(job.queryText, {
            client,
            source,
            env,
            now: now(),
            signal: controller.signal,
            localityNames,
            localityName: job.localityId ? (getLocality(job.localityId)?.name ?? null) : null,
            resolveProjectsByRera: (nums) => repos.projects.findPublishedProjectsByRera(nums),
          }),
          controller,
          timeoutMs,
        );
        let stored;
        try {
          stored = r.listings.length ? await repos.externalListings.upsertMany(r.listings) : [];
        } catch {
          throw new ResearchClientError("store_failed", true, r.usage);
        }
        const status = stored.length ? "done" : "no_results";
        await repos.researchJobs.finish(job.id, { status, resultCount: stored.length, errorCode: null, listingIds: stored.map((l) => l.id) });
        const sum = (m: Partial<Record<string, number>>) => Object.values(m).reduce<number>((a, b) => a + (b ?? 0), 0);
        log.info("research.job_finished", {
          jobId: job.id,
          status,
          attempt: job.attempts,
          resultCount: stored.length,
          candidates: r.validation.received,
          accepted: r.validation.accepted,
          dropped: sum(r.validation.dropped),
          fieldsDropped: sum(r.validation.fieldsDropped),
          reviewFlags: r.reviewFlags,
          inputTokens: r.usage.inputTokens,
          outputTokens: r.usage.outputTokens,
          webSearchRequests: r.usage.webSearchRequests,
        });
        return { jobId: job.id, status, resultCount: stored.length, errorCode: null };
      } catch (e) {
        const err = e instanceof ResearchClientError ? e : new ResearchClientError("unknown", false);
        const retry = err.retryable && job.attempts < RESEARCH_MAX_ATTEMPTS;
        let finished: ResearchJob | null = null;
        try {
          finished = await repos.researchJobs.finish(job.id, { status: retry ? "queued" : "failed", resultCount: 0, errorCode: err.code, listingIds: [] });
        } catch {
          // The job stays "running" and is reclaimed after RESEARCH_STALE_MINUTES.
        }
        const status = finished?.status ?? "running";
        log.warn("research.job_failed", {
          jobId: job.id,
          status,
          attempt: job.attempts,
          errorCode: err.code,
          inputTokens: err.usage?.inputTokens,
          outputTokens: err.usage?.outputTokens,
          webSearchRequests: err.usage?.webSearchRequests,
        });
        return { jobId: job.id, status, resultCount: 0, errorCode: err.code };
      }
    }),
  );
  return { refused: null, claimed: jobs.length, outcomes };
}

/** Staff view (admin and advisor, read-only): recent jobs with their stored listings. */
export async function listRecentResearchJobs(limit = 50, deps: { repos?: Repositories } = {}): Promise<ResearchJobWithListings[]> {
  await requireStaff(); // throws StaffAuthError without a staff session
  return (deps.repos ?? getRepositories()).researchJobs.listRecent(Math.max(1, Math.min(200, limit)));
}
