import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("node:crypto", async (orig) => {
  const actual = await orig<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const crypto = await import("node:crypto");
const { createFixtureRepositories } = await import("../repositories/fixture");
const { FixtureResearchJobRepository } = await import("../repositories/fixture/research-jobs");
const { FixedWindowRateLimiter } = await import("./rate-limit");
const svc = await import("./research-jobs");
const { searchProperties } = await import("./search");
const { handleResearchRun, secretsMatch } = await import("../http/research-run");
const { FakeResearchClient, ResearchClientError, fakeResult, fakeText } = await import("@/discovery/research");
const { getSource } = await import("@/discovery");
const { getRequestSubject } = await import("./projects");

const SECRET = "test-only-research-secret-0123456789abcdef"; // 42 chars, test-only
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const PE = { SESSION_SECRET: "test-only-session-secret-for-research-hash-0000", RESEARCH_MAX_JOBS_PER_DAY: "50" } as unknown as NodeJS.ProcessEnv;

function setup(opts: { clock?: () => Date } = {}) {
  const repos = createFixtureRepositories();
  if (opts.clock) repos.researchJobs = new FixtureResearchJobRepository(repos.externalListings, opts.clock);
  return repos;
}

const limiter = (max = 100) => new FixedWindowRateLimiter(max, 3_600_000);

describe("requestResearchOnMiss: enqueue dedupe and TTL", () => {
  it("queues once per normalised query; repeats see the active job", async () => {
    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: PE };
    expect(await svc.requestResearchOnMiss({ queryText: "Zzq Towers  Hebbal", clientKey: "1.1.1.1", userAgent: UA }, deps)).toEqual({
      state: "researching",
      queryText: "Zzq Towers Hebbal",
    });
    expect(await svc.requestResearchOnMiss({ queryText: "hebbal zzq towers!", clientKey: "2.2.2.2", userAgent: UA }, deps)).toMatchObject({ state: "researching" });
    expect(await repos.researchJobs.listRecent(10)).toHaveLength(1);
  });

  it("reuses a no_results job within RESEARCH_CACHE_HOURS and re-queues after it expires", async () => {
    let now = new Date("2026-10-22T00:00:00Z");
    const repos = setup({ clock: () => now });
    const pe = { ...PE, RESEARCH_CACHE_HOURS: "24" } as NodeJS.ProcessEnv;
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: pe };
    await svc.requestResearchOnMiss({ queryText: "nothing here at all", clientKey: "1.1.1.1", userAgent: UA }, deps);
    const run = await svc.runResearchBatch({ repos, env: "test", client: new FakeResearchClient(), now: () => now });
    expect(run.outcomes).toEqual([expect.objectContaining({ status: "no_results", resultCount: 0 })]);

    now = new Date("2026-10-22T23:00:00Z");
    expect(await svc.requestResearchOnMiss({ queryText: "nothing here at all", clientKey: "1.1.1.1", userAgent: UA }, deps)).toMatchObject({
      state: "searched_none",
      searchedAt: "2026-10-22T00:00:00.000Z",
    });
    now = new Date("2026-10-23T01:00:00Z");
    expect(await svc.requestResearchOnMiss({ queryText: "nothing here at all", clientKey: "1.1.1.1", userAgent: UA }, deps)).toMatchObject({ state: "researching" });
    expect(await repos.researchJobs.listRecent(10)).toHaveLength(2);
  });

  it("returns null (normal empty state) when research cannot run here or the query is too short", async () => {
    const repos = setup();
    // The fixture research source never runs in production.
    expect(await svc.requestResearchOnMiss({ queryText: "zzq towers", clientKey: "x", userAgent: UA }, { repos, env: "production", limiter: limiter(), processEnv: PE })).toBeNull();
    expect(await svc.requestResearchOnMiss({ queryText: "a!", clientKey: "x", userAgent: UA }, { repos, env: "test", limiter: limiter(), processEnv: PE })).toBeNull();
    expect(await repos.researchJobs.listRecent(10)).toHaveLength(0);
  });
});

describe("requestResearchOnMiss: rate limits", () => {
  it("per client IP: the 6th new query in an hour is refused; others and existing jobs still work", async () => {
    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(svc.RESEARCH_IP_MAX_PER_HOUR), processEnv: PE };
    for (let i = 0; i < 5; i++) {
      expect(await svc.requestResearchOnMiss({ queryText: `zzq query ${i}`, clientKey: "9.9.9.9", userAgent: UA }, deps)).toMatchObject({ state: "researching" });
    }
    expect(await svc.requestResearchOnMiss({ queryText: "zzq query 5", clientKey: "9.9.9.9", userAgent: UA }, deps)).toMatchObject({ state: "unavailable" });
    // A rate-limited client can still see a job someone already started…
    expect(await svc.requestResearchOnMiss({ queryText: "zzq query 0", clientKey: "9.9.9.9", userAgent: UA }, deps)).toMatchObject({ state: "researching" });
    // …and a different client is unaffected.
    expect(await svc.requestResearchOnMiss({ queryText: "zzq query 5", clientKey: "8.8.8.8", userAgent: UA }, deps)).toMatchObject({ state: "researching" });
    expect(await repos.researchJobs.listRecent(20)).toHaveLength(6);
  });

  it("global daily cap (RESEARCH_MAX_JOBS_PER_DAY)", async () => {
    const repos = setup();
    const pe = { ...PE, RESEARCH_MAX_JOBS_PER_DAY: "2" } as NodeJS.ProcessEnv;
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: pe };
    await svc.requestResearchOnMiss({ queryText: "zzq one", clientKey: "1.0.0.1", userAgent: UA }, deps);
    await svc.requestResearchOnMiss({ queryText: "zzq two", clientKey: "1.0.0.2", userAgent: UA }, deps);
    expect(await svc.requestResearchOnMiss({ queryText: "zzq three", clientKey: "1.0.0.3", userAgent: UA }, deps)).toMatchObject({ state: "unavailable" });
    expect(await repos.researchJobs.listRecent(10)).toHaveLength(2);
  });

  it("per-requester daily cap uses an HMAC of the IP, never the IP", async () => {
    const h = svc.requesterHash("203.0.113.7", PE)!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("203");
    expect(svc.requesterHash("unknown", PE)).toBeNull();
    expect(svc.requesterHash("203.0.113.7", {} as NodeJS.ProcessEnv)).toBeNull();

    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(1000), processEnv: PE };
    for (let i = 0; i < svc.RESEARCH_MAX_JOBS_PER_REQUESTER_PER_DAY; i++) await svc.requestResearchOnMiss({ queryText: `zzq q${i}`, clientKey: "203.0.113.7", userAgent: UA }, deps);
    expect(await svc.requestResearchOnMiss({ queryText: "zzq over", clientKey: "203.0.113.7", userAgent: UA }, deps)).toMatchObject({ state: "unavailable" });
  });
});

describe("runResearchBatch", () => {
  it("refuses (claims nothing, calls nothing) while the source is not runnable, e.g. a suspended anthropic-web-search", async () => {
    const repos = setup();
    await svc.requestResearchOnMiss({ queryText: "zzq towers", clientKey: "1.1.1.1", userAgent: UA }, { repos, env: "test", limiter: limiter(), processEnv: PE });
    const client = new FakeResearchClient();
    for (const env of ["test", "development", "production"] as const) {
      const r = await svc.runResearchBatch({ repos, env, client, source: { ...getSource("anthropic-web-search")!, status: "suspended" } });
      expect(r).toEqual({ refused: "source_not_runnable", claimed: 0, outcomes: [] });
    }
    expect(client.calls).toHaveLength(0);
    expect((await repos.researchJobs.listRecent(1))[0].status).toBe("queued");
  });

  it("stores survivors as unverified Lane B listings; a later search is served from the DB", async () => {
    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: PE };
    const q = "zzq unheard-of towers";
    const first = await searchProperties({ text: q }, { repos, env: "test" });
    expect(first.researched).toHaveLength(0);
    expect(first.external).toHaveLength(0);
    await svc.requestResearchOnMiss({ queryText: q, clientKey: "1.1.1.1", userAgent: UA }, deps);

    const run = await svc.runResearchBatch({ repos, env: "test", client: new FakeResearchClient() });
    expect(run.outcomes).toEqual([expect.objectContaining({ status: "done", resultCount: 1, errorCode: null })]);
    const [job] = await repos.researchJobs.listRecent(1);
    expect(job.listings).toHaveLength(1);
    expect(job.listings[0]).toMatchObject({ lane: "external", sourceId: "sample-web-research", isSample: true });
    expect(job.listings[0].limitations[0]).toBe("Not verified by TrueNest");

    const again = await searchProperties({ text: q }, { repos, env: "test" });
    expect(again.external.map((l) => l.id)).toEqual([job.listings[0].id]);
    // Nothing became Lane A.
    expect(again.researched).toHaveLength(0);
    expect((await repos.research.listAllProjects()).some((p) => p.name.includes("Research Residences"))).toBe(false);
  });

  it("retries a retryable failure once, then marks it failed", async () => {
    const repos = setup();
    await svc.requestResearchOnMiss({ queryText: "zzq flaky", clientKey: "1.1.1.1", userAgent: UA }, { repos, env: "test", limiter: limiter(), processEnv: PE });
    const client = new FakeResearchClient(() => {
      throw new ResearchClientError("rate_limited", true);
    });
    const a = await svc.runResearchBatch({ repos, env: "test", client });
    expect(a.outcomes[0]).toMatchObject({ status: "queued", errorCode: "rate_limited" });
    const b = await svc.runResearchBatch({ repos, env: "test", client });
    expect(b.outcomes[0]).toMatchObject({ status: "failed", errorCode: "rate_limited" });
    const c = await svc.runResearchBatch({ repos, env: "test", client });
    expect(c.claimed).toBe(0);
    expect(client.calls).toHaveLength(2);
  });

  it("does not retry non-retryable failures (refusal) and enforces the per-job timeout", async () => {
    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: PE };
    await svc.requestResearchOnMiss({ queryText: "zzq refused", clientKey: "1.1.1.1", userAgent: UA }, deps);
    const refusal = await svc.runResearchBatch({ repos, env: "test", client: new FakeResearchClient(() => fakeResult([fakeText("")], "refusal")) });
    expect(refusal.outcomes[0]).toMatchObject({ status: "failed", errorCode: "refusal" });

    await svc.requestResearchOnMiss({ queryText: "zzq slow", clientKey: "1.1.1.1", userAgent: UA }, deps);
    const hang = new FakeResearchClient(() => new Promise(() => {}));
    const slow = await svc.runResearchBatch({ repos, env: "test", client: hang, timeoutMs: 20 });
    expect(slow.outcomes[0]).toMatchObject({ status: "queued", errorCode: "timeout" });
  });

  it("respects RESEARCH_BATCH_SIZE", async () => {
    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: PE };
    for (const q of ["zzq a1", "zzq b2", "zzq c3", "zzq d4"]) await svc.requestResearchOnMiss({ queryText: q, clientKey: "1.1.1.1", userAgent: UA }, deps);
    const r = await svc.runResearchBatch({ repos, env: "test", client: new FakeResearchClient(), batchSize: 3 });
    expect(r.claimed).toBe(3);
  });
});

describe("POST /api/internal/research/run auth", () => {
  const req = (secret?: string) =>
    new Request("http://localhost/api/internal/research/run", { method: "POST", headers: secret === undefined ? {} : { "x-research-secret": secret } });
  const ok = async () => ({ refused: null, claimed: 0, outcomes: [] });

  it("404 when RESEARCH_RUN_SECRET is unset or shorter than 32 characters", async () => {
    let ran = 0;
    const run = async () => (ran++, ok());
    expect((await handleResearchRun(req(SECRET), { run, env: {} as NodeJS.ProcessEnv })).status).toBe(404);
    expect((await handleResearchRun(req("short"), { run, env: { RESEARCH_RUN_SECRET: "short" } as unknown as NodeJS.ProcessEnv })).status).toBe(404);
    expect(ran).toBe(0);
  });

  it("401 for a missing or wrong secret; 200 for the right one; 503 when refused", async () => {
    const env = { RESEARCH_RUN_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;
    let ran = 0;
    const run = async () => (ran++, ok());
    expect((await handleResearchRun(req(), { run, env })).status).toBe(401);
    expect((await handleResearchRun(req(`${SECRET}x`), { run, env })).status).toBe(401);
    expect((await handleResearchRun(req(SECRET.toUpperCase()), { run, env })).status).toBe(401);
    expect(ran).toBe(0);
    const good = await handleResearchRun(req(SECRET), { run, env });
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ claimed: 0, outcomes: [] });
    const refused = await handleResearchRun(req(SECRET), { run: async () => ({ refused: "source_not_runnable", claimed: 0, outcomes: [] }), env });
    expect(refused.status).toBe(503);
  });

  it("compares in constant time over fixed-length digests", () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    expect(secretsMatch("a", SECRET)).toBe(false);
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });
});

describe("H1: never 'researching' when the worker cannot run", () => {
  const configured = { ...PE, ANTHROPIC_API_KEY: "test-only-not-a-key", RESEARCH_RUN_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;

  it("supabase mode needs ANTHROPIC_API_KEY and RESEARCH_RUN_SECRET; fixture mode always works", () => {
    expect(svc.researchWorkerConfigured("fixture", {} as NodeJS.ProcessEnv)).toBe(true);
    expect(svc.researchWorkerConfigured("supabase", {} as NodeJS.ProcessEnv)).toBe(false);
    expect(svc.researchWorkerConfigured("supabase", { ...configured, ANTHROPIC_API_KEY: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(svc.researchWorkerConfigured("supabase", { ...configured, RESEARCH_RUN_SECRET: "short" } as NodeJS.ProcessEnv)).toBe(false);
    expect(svc.researchWorkerConfigured("supabase", configured)).toBe(true);
  });

  it("an unconfigured production worker yields 'unavailable' and enqueues nothing", async () => {
    const repos = setup();
    repos.backend = "supabase"; // anthropic-web-search: approved for production
    const deps = { repos, env: "production" as const, limiter: limiter(), processEnv: PE };
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq towers", userAgent: UA }, deps)).toEqual({ state: "unavailable", queryText: "zzq towers" });
    expect(await svc.requestResearchOnMiss({ queryText: "zzq towers", clientKey: "1.1.1.1", userAgent: UA }, deps)).toEqual({
      state: "unavailable",
      queryText: "zzq towers",
    });
    expect(await repos.researchJobs.listRecent(10)).toHaveLength(0);
    const ok = { ...deps, processEnv: configured };
    expect(await svc.requestResearchOnMiss({ queryText: "zzq towers", clientKey: "1.1.1.1", userAgent: UA }, ok)).toMatchObject({ state: "researching" });
  });

  it("a running job past its stale window (no worker to reclaim it) shows 'unavailable', not 'researching'", async () => {
    let now = new Date("2026-10-22T00:00:00Z");
    const repos = setup({ clock: () => now });
    const deps = () => ({ repos, env: "test" as const, limiter: limiter(), processEnv: PE, now: now.getTime() });
    await svc.requestResearchOnMiss({ queryText: "zzq orphan", clientKey: "1.1.1.1", userAgent: UA }, deps());
    await repos.researchJobs.claim(1, 15);
    now = new Date("2026-10-22T00:10:00Z");
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq orphan", userAgent: UA }, deps())).toMatchObject({ state: "researching" });
    now = new Date("2026-10-22T00:18:00Z");
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq orphan", userAgent: UA }, deps())).toMatchObject({ state: "unavailable" });
  });

  it("a queued job not picked up for 30 minutes is failed as 'stalled' and shows 'unavailable' (no re-enqueue for 6 h)", async () => {
    let now = new Date("2026-10-22T00:00:00Z");
    const repos = setup({ clock: () => now });
    const deps = () => ({ repos, env: "test" as const, limiter: limiter(), processEnv: PE, now: now.getTime() });
    await svc.requestResearchOnMiss({ queryText: "zzq stuck", clientKey: "1.1.1.1", userAgent: UA }, deps());
    now = new Date("2026-10-22T00:20:00Z");
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq stuck", userAgent: UA }, deps())).toMatchObject({ state: "researching" });
    now = new Date("2026-10-22T00:31:00Z");
    // Read-only lookup no longer claims "researching"; the trigger's enqueue marks it stalled.
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq stuck", userAgent: UA }, deps())).toMatchObject({ state: "can_start" });
    expect(await svc.requestResearchOnMiss({ queryText: "zzq stuck", clientKey: "1.1.1.1", userAgent: UA }, deps())).toMatchObject({ state: "unavailable" });
    const [job] = await repos.researchJobs.listRecent(5);
    expect(job).toMatchObject({ status: "failed", errorCode: "stalled" });
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq stuck", userAgent: UA }, deps())).toMatchObject({ state: "unavailable" });
    expect(await repos.researchJobs.listRecent(5)).toHaveLength(1);
  });
});

describe("M4: a failed job is cached for 6 hours", () => {
  it("shows 'unavailable' within 6 h and allows a new job afterwards", async () => {
    let now = new Date("2026-10-22T00:00:00Z");
    const repos = setup({ clock: () => now });
    const deps = () => ({ repos, env: "test" as const, limiter: limiter(), processEnv: PE, now: now.getTime() });
    await svc.requestResearchOnMiss({ queryText: "zzq broken", clientKey: "1.1.1.1", userAgent: UA }, deps());
    const bad = new FakeResearchClient(() => fakeResult([fakeText("")], "refusal"));
    expect((await svc.runResearchBatch({ repos, env: "test", client: bad, now: () => now })).outcomes[0]).toMatchObject({ status: "failed" });
    now = new Date("2026-10-22T05:59:00Z");
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq broken", userAgent: UA }, deps())).toMatchObject({ state: "unavailable" });
    expect(await svc.requestResearchOnMiss({ queryText: "zzq broken", clientKey: "1.1.1.1", userAgent: UA }, deps())).toMatchObject({ state: "unavailable" });
    expect(await repos.researchJobs.listRecent(5)).toHaveLength(1);
    now = new Date("2026-10-22T06:01:00Z");
    expect(await svc.requestResearchOnMiss({ queryText: "zzq broken", clientKey: "1.1.1.1", userAgent: UA }, deps())).toMatchObject({ state: "researching" });
    expect(await repos.researchJobs.listRecent(5)).toHaveLength(2);
  });
});

describe("M3: crawlers and the GET render never enqueue", () => {
  it("detects obvious bots and empty user agents", () => {
    for (const ua of ["", "Googlebot/2.1 (+http://www.google.com/bot.html)", "Mozilla/5.0 (compatible; bingbot/2.0)", "curl/8.4.0", "python-requests/2.32", "facebookexternalhit/1.1", "Mozilla/5.0 HeadlessChrome/141"])
      expect(svc.isLikelyBot(ua), ua).toBe(true);
    expect(svc.isLikelyBot(UA)).toBe(false);
  });
  it("bots get no research state and enqueue nothing", async () => {
    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: PE };
    expect(await svc.requestResearchOnMiss({ queryText: "zzq crawl", clientKey: "1.1.1.1", userAgent: "Googlebot/2.1" }, deps)).toBeNull();
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq crawl", userAgent: "Googlebot/2.1" }, deps)).toBeNull();
    expect(await repos.researchJobs.listRecent(5)).toHaveLength(0);
  });
  it("lookupResearchOnMiss is read-only: 'can_start' without creating a job", async () => {
    const repos = setup();
    const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: PE };
    expect(await svc.lookupResearchOnMiss({ queryText: "zzq fresh", localityId: "hebbal", userAgent: UA }, deps)).toEqual({
      state: "can_start",
      queryText: "zzq fresh",
      localityId: "hebbal",
    });
    expect(await repos.researchJobs.listRecent(5)).toHaveLength(0);
  });
});

describe("L3: stale running jobs that used both attempts are abandoned, not reclaimed", () => {
  it("marks them failed with error_code 'abandoned'", async () => {
    let now = new Date("2026-10-22T00:00:00Z");
    const repos = setup({ clock: () => now });
    await svc.requestResearchOnMiss({ queryText: "zzq crash", clientKey: "1.1.1.1", userAgent: UA }, { repos, env: "test", limiter: limiter(), processEnv: PE, now: now.getTime() });
    await repos.researchJobs.claim(1, 15); // attempt 1, worker "dies"
    now = new Date("2026-10-22T00:20:00Z");
    expect(await repos.researchJobs.claim(1, 15)).toMatchObject([{ attempts: 2 }]); // reclaimed once, dies again
    now = new Date("2026-10-22T00:40:00Z");
    expect(await repos.researchJobs.claim(1, 15)).toEqual([]);
    expect((await repos.researchJobs.listRecent(1))[0]).toMatchObject({ status: "failed", errorCode: "abandoned" });
  });
});

describe("L4: one-time warning when the requester hash is unavailable in production", () => {
  it("warns once per process", async () => {
    svc.resetResearchWarningsForTesting();
    const prev = process.env.TN_LOG_IN_TESTS;
    process.env.TN_LOG_IN_TESTS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const repos = setup();
      const pe = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv; // no SESSION_SECRET
      const deps = { repos, env: "test" as const, limiter: limiter(), processEnv: pe };
      await svc.requestResearchOnMiss({ queryText: "zzq w1", clientKey: "1.1.1.1", userAgent: UA }, deps);
      await svc.requestResearchOnMiss({ queryText: "zzq w2", clientKey: "1.1.1.1", userAgent: UA }, deps);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("research.requester_hash_unavailable"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("1.1.1.1");
    } finally {
      warn.mockRestore();
      process.env.TN_LOG_IN_TESTS = prev;
    }
  });
});

describe("L6: /request subject for web research listings follows the source gate", () => {
  it("returns the listing only while its research source is runnable", async () => {
    const repos = setup();
    await svc.requestResearchOnMiss({ queryText: "zzq subject", clientKey: "1.1.1.1", userAgent: UA }, { repos, env: "test", limiter: limiter(), processEnv: PE });
    await svc.runResearchBatch({ repos, env: "test", client: new FakeResearchClient() });
    const [{ listings }] = await repos.researchJobs.listRecent(1);
    const id = listings[0].id;
    expect(await getRequestSubject({ externalListingId: id }, { repos, env: "test" })).toMatchObject({ kind: "external_listing", id });
    expect(await getRequestSubject({ externalListingId: id }, { repos, env: "production" })).toBeNull();
  });
});

describe("startWebResearchAction (POST)", () => {
  it("does nothing for a query that is not a miss, or for a request without a browser user agent", async () => {
    const { startWebResearchAction } = await import("../actions/research-jobs");
    const fd = (q: string) => {
      const f = new FormData();
      f.set("q", q);
      return f;
    };
    // "Residency" matches fixture listings: not a miss, never enqueued.
    expect(await startWebResearchAction({ status: "idle" }, fd("Residency"))).toEqual({ status: "none" });
    // The mocked request has no user agent: treated as a bot.
    expect(await startWebResearchAction({ status: "idle" }, fd("zzq action miss"))).toEqual({ status: "none" });
  });
});
