import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { FACT_ATTRIBUTES, mapFactsCurrentRow, resolveFactsCurrent, tryIsoDate } = await import("./fact-store");
const { WEB_RESEARCH_SOURCE_IDS } = await import("@/discovery/registry");
const { FixtureFactStoreRepository, SAMPLE_FACT_OBSERVATIONS } = await import("./fixture/fact-store");
const { SupabaseFactStoreRepository } = await import("./supabase/fact-store");
const { createFixtureRepositories, SAMPLE_PROJECTS } = await import("./fixture");
type Input = import("./fact-store").FactCandidateInput;

const MIGRATION = path.resolve(import.meta.dirname, "../../../supabase/migrations/0006_fact_store.sql");

function cand(o: Partial<Input>): Input {
  return {
    entity_type: "project",
    entity_id: "sample-p1",
    attribute: "promised_possession",
    origin: "observation",
    fact_id: "x",
    value_text: null,
    value_num: null,
    value_date: "2026-12-31",
    value_json: null,
    unit: null,
    truth_status: "official",
    verification: "unverified",
    confidence: null,
    estimate_basis: null,
    source_id: "sample-feed",
    source_url: "https://example.com/sample/p1",
    source_type: "builder",
    observed_at: "2026-09-01T00:00:00.000Z",
    last_verified_at: "2026-09-01T00:00:00.000Z",
    ttl_hours: 168,
    excerpt: null,
    added_by: "crawl",
    is_sample: true,
    ...o,
  };
}

describe("attribute catalogue", () => {
  it("TS mirror equals the fact_attributes seed in 0006_fact_store.sql", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const re = /\('(project|development|locality|builder)',\s*'([a-z0-9_]+)',\s*'(\w+)',\s*(?:null|'[^']*'),\s*(true|false),\s*(\d+),\s*(null|'[a-z_]+')/g;
    const fromSql = [...sql.matchAll(re)].map((m) => ({
      entityType: m[1],
      attribute: m[2],
      valueKind: m[3],
      legallySignificant: m[4] === "true",
      defaultTtlHours: Number(m[5]),
      legacyField: m[6] === "null" ? null : m[6].slice(1, -1),
    }));
    expect(fromSql).toHaveLength(39);
    expect(fromSql).toEqual(FACT_ATTRIBUTES.map((x) => ({ ...x })));
  });

  it("H1: tn_is_web_research_source lists exactly WEB_RESEARCH_SOURCE_IDS", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const m = sql.match(/tn_is_web_research_source\(p_id text\)[\s\S]*?select p_id in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const ids = m![1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
    expect(ids.sort()).toEqual([...WEB_RESEARCH_SOURCE_IDS].sort());
  });
});

describe("resolveFactsCurrent (TS mirror of the facts_current view)", () => {
  const now = new Date("2026-10-20T00:00:00Z");

  it("conflict: builder vs RERA dates both kept; newer official wins, official outranks a newer estimate", () => {
    const rows = resolveFactsCurrent(
      [
        cand({ fact_id: "builder" }),
        cand({ fact_id: "rera", value_date: "2027-06-30", source_type: "rera", observed_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-01T00:00:00Z" }),
        cand({ fact_id: "est", value_date: "2028-01-31", truth_status: "estimated", estimate_basis: { sources: [] }, observed_at: "2026-10-10T00:00:00Z", last_verified_at: "2026-10-10T00:00:00Z" }),
      ],
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fact_id: "rera", conflict_count: 2, has_disagreement: true, is_stale: true }); // verified 2026-10-01 + 168 h < now
    expect(rows[0].conflicts.map((c) => c.fact_id)).toEqual(["builder", "est"]);
  });

  it("M5: a reviewed curated UNKNOWN never overrides a known observation", () => {
    const curated = cand({ fact_id: "cur", origin: "curated", value_date: null, truth_status: "unknown", verification: "reviewed", added_by: "staff", source_url: null });
    const row = resolveFactsCurrent([curated, cand({ fact_id: "obs" })], now)[0];
    expect(row.fact_id).toBe("obs");
    expect(row.conflicts.map((x) => x.fact_id)).toEqual(["cur"]);
  });

  it("L2: in a date attribute, an ISO date held as text is not a disagreement with the same date", () => {
    const curated = cand({ fact_id: "cur", origin: "curated", value_date: null, value_text: "2026-12-31", added_by: "staff" });
    expect(resolveFactsCurrent([cand({ fact_id: "obs" }), curated], now)[0].has_disagreement).toBe(false);
    expect(resolveFactsCurrent([cand({ fact_id: "obs" }), { ...curated, value_text: "2026-12 (SAMPLE)" }], now)[0].has_disagreement).toBe(true);
    expect(tryIsoDate("2026-02-30")).toBeNull();
    expect(tryIsoDate("2026-02-28")).toBe("2026-02-28");
  });

  it("a curated value wins only once source_confirmed or reviewed", () => {
    const curated = cand({ fact_id: "cur", origin: "curated", value_date: null, value_text: "2026-12 (SAMPLE)", added_by: "staff", observed_at: "2026-08-01T00:00:00Z", last_verified_at: "2026-08-01T00:00:00Z" });
    const rera = cand({ fact_id: "rera", value_date: "2027-06-30", observed_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-01T00:00:00Z" });
    expect(resolveFactsCurrent([curated, rera], now)[0].fact_id).toBe("rera");
    expect(resolveFactsCurrent([{ ...curated, verification: "reviewed" }, rera], now)[0].fact_id).toBe("cur");
    expect(resolveFactsCurrent([{ ...curated, verification: "disputed" }, rera], now)[0].fact_id).toBe("rera");
  });

  it("unknown: within its TTL it is not stale; past it, stale; same values are not a disagreement", () => {
    const unknown = cand({
      attribute: "oc_status", value_date: null, truth_status: "unknown", source_url: null, source_type: "search", added_by: "research",
      observed_at: "2026-10-19T00:00:00Z", last_verified_at: "2026-10-19T00:00:00Z", ttl_hours: 72,
    });
    const [fresh] = resolveFactsCurrent([unknown], now);
    expect(fresh).toMatchObject({ is_stale: false, requires_review: true, legally_significant: true, conflict_count: 0, has_disagreement: false });
    expect(resolveFactsCurrent([unknown], new Date("2026-10-22T00:00:01Z"))[0].is_stale).toBe(true);
    const same = resolveFactsCurrent([cand({ fact_id: "a" }), cand({ fact_id: "b", source_url: "https://example.org/sample/p1" })], now)[0];
    expect(same).toMatchObject({ conflict_count: 1, has_disagreement: false });
  });
});

describe("mapFactsCurrentRow", () => {
  const view = (o: Record<string, unknown> = {}) => ({
    ...cand({}),
    legally_significant: false,
    requires_review: false,
    is_stale: false,
    conflicts: [],
    conflict_count: 0,
    has_disagreement: false,
    ...o,
  });

  it("maps provenance, truth, TTL and conflicts onto FactValue", () => {
    const f = mapFactsCurrentRow(view({
      observed_at: "2026-10-01 00:00:00+00",
      conflict_count: "1",
      conflicts: [{ ...cand({ value_date: null, value_num: "7000.5", truth_status: "estimated", source_id: null, source_url: null }) }],
    }));
    expect(f.fact).toEqual({
      status: "known",
      value: "2026-12-31",
      verification: "unverified",
      sources: [{ sourceId: "sample-feed", url: "https://example.com/sample/p1", observedAt: "2026-10-01T00:00:00.000Z" }],
      truth: "official",
      lastVerifiedAt: "2026-09-01T00:00:00.000Z",
      ttlHours: 168,
      conflicts: [{ value: 7000.5, truth: "estimated", verification: "unverified", source: null }],
    });
    expect(f).toMatchObject({ entityType: "project", attribute: "promised_possession", origin: "observation", sourceType: "builder", isSample: true });
  });

  it("unknown carries no value; estimates keep a well-formed basis and are refused without one (M2)", () => {
    expect(mapFactsCurrentRow(view({ truth_status: "unknown", value_date: null })).fact).toMatchObject({ status: "unknown", value: null, truth: "unknown" });
    const basis = { sources: [{ sourceId: "sample-feed", url: "https://example.com/sample/x", observedAt: "2026-10-01 00:00:00+00" }], signalCount: 3 };
    expect(mapFactsCurrentRow(view({ truth_status: "estimated", estimate_basis: basis })).fact.estimateBasis).toEqual({
      sources: [{ sourceId: "sample-feed", url: "https://example.com/sample/x", observedAt: "2026-10-01T00:00:00.000Z" }],
      signalCount: 3,
    });
    expect(() => mapFactsCurrentRow(view({ truth_status: "estimated", estimate_basis: { bogus: 1 } }))).toThrow();
    expect(() => mapFactsCurrentRow(view({ truth_status: "estimated", estimate_basis: null }))).toThrow();
  });

  it("rejects malformed rows", () => {
    expect(() => mapFactsCurrentRow(view({ truth_status: "verified" }))).toThrow();
    expect(() => mapFactsCurrentRow(view({ entity_type: "builder" }))).toThrow();
    expect(() => mapFactsCurrentRow({})).toThrow();
  });
});

describe("FixtureFactStoreRepository", () => {
  const LAKEVIEW = "sample-proj-lakeview";

  it("fixture observations are obviously fictional SAMPLE rows", () => {
    for (const o of SAMPLE_FACT_OBSERVATIONS) {
      expect(o.is_sample).toBe(true);
      expect(o.entity_id.startsWith("sample-")).toBe(true);
      expect(o.source_id?.startsWith("sample-")).toBe(true);
      if (o.source_url) expect(o.source_url).toMatch(/^https:\/\/example\.(com|org)\//);
      expect(o.verification).toBe("unverified");
    }
  });

  it("serves facts_current for a SAMPLE project: the registry date wins, builder + estimates + curated stay in conflicts", async () => {
    const repo = new FixtureFactStoreRepository(SAMPLE_PROJECTS, undefined, () => new Date("2026-10-16T00:00:00Z"));
    const facts = await repo.listCurrent("project", LAKEVIEW);
    expect(facts.map((f) => f.attribute)).toEqual(["oc_status", "promised_possession"]);
    const pp = facts[1];
    expect(pp).toMatchObject({ origin: "observation", factId: "sample-obs-lakeview-possession-registry", sourceType: "rera", hasDisagreement: true });
    expect(pp.fact.value).toBe("2029-06-30");
    expect(pp.fact.conflicts?.map((c) => [c.truth, c.value])).toEqual([
      ["official", "2028-12-31"],
      ["estimated", "2029-12-31"],
      ["estimated", SAMPLE_PROJECTS.find((p) => p.id === LAKEVIEW)!.declaredPossession.value],
    ]);
    const oc = facts[0];
    expect(oc).toMatchObject({ isStale: false, requiresReview: true });
    expect(oc.fact).toMatchObject({ status: "unknown", value: null, truth: "unknown" });
    const later = new FixtureFactStoreRepository(SAMPLE_PROJECTS, undefined, () => new Date("2026-10-20T00:00:00Z"));
    expect((await later.getCurrent("project", LAKEVIEW, "oc_status"))?.isStale).toBe(true);
    expect(await later.getCurrent("project", LAKEVIEW, "khata_type")).toBeNull();
  });

  it("H1 / M2 / M3 in the fixture: web search is estimated/search; sourceless known values are left out", async () => {
    const lake = SAMPLE_PROJECTS.find((p) => p.id === LAKEVIEW)!;
    const at = "2026-10-01T00:00:00.000Z";
    const withSources = (sources: { sourceId: string; url: string; observedAt: string }[], value: string | null = "2027-12 (SAMPLE)") =>
      [{ ...lake, declaredPossession: { status: value === null ? "unknown" : "known", value, verification: "unverified", sources } as typeof lake.declaredPossession }];
    const pick = async (projects: typeof SAMPLE_PROJECTS) =>
      (await new FixtureFactStoreRepository(projects, [], () => new Date(at)).listCurrent("project", LAKEVIEW))[0];
    const web = await pick(withSources([{ sourceId: "anthropic-web-search", url: "https://example.com/sample/web", observedAt: at }]));
    expect(web).toMatchObject({ origin: "curated", sourceType: "search" });
    expect(web.fact.truth).toBe("estimated");
    expect(web.fact.estimateBasis?.sources.map((s) => s.sourceId)).toEqual(["anthropic-web-search"]);
    expect(await pick(withSources([]))).toBeUndefined();
    expect((await pick(withSources([], null)))?.fact.truth).toBe("unknown");
  });

  it("other entities only see their own curated facts; inputs are validated", async () => {
    const repo = createFixtureRepositories().factStore;
    const other = SAMPLE_PROJECTS.find((p) => p.id !== LAKEVIEW)!;
    const facts = await repo.listCurrent("project", other.id);
    expect(facts.every((f) => f.entityId === other.id && f.origin === "curated")).toBe(true);
    expect(await repo.listCurrent("locality", "hebbal")).toEqual([]);
    await expect(repo.listCurrent("builder" as never, "x")).rejects.toThrow();
    await expect(repo.listCurrent("project", "")).rejects.toThrow();
    await expect(repo.getCurrent("project", LAKEVIEW, "DROP TABLE")).rejects.toThrow();
  });
});

describe("SupabaseFactStoreRepository", () => {
  function fakeClient(result: { data: unknown; error: { code?: string; message?: string } | null }) {
    const calls: Array<[string, unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order"]) {
      q[m] = (...args: unknown[]) => {
        calls.push([m, args]);
        return q;
      };
    }
    q.maybeSingle = () => {
      calls.push(["maybeSingle", []]);
      return Promise.resolve(result);
    };
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    const client = { from: (t: string) => (calls.push(["from", [t]]), q) };
    return { client: client as never, calls };
  }

  const row = { ...cand({ entity_id: "sample-p1" }), legally_significant: false, requires_review: false, is_stale: false, conflicts: [], conflict_count: 0, has_disagreement: false };

  it("reads facts_current filtered by entity, mapped and validated", async () => {
    const { client, calls } = fakeClient({ data: [row], error: null });
    const facts = await new SupabaseFactStoreRepository(() => client).listCurrent("project", "sample-p1");
    expect(facts).toHaveLength(1);
    expect(facts[0].fact.truth).toBe("official");
    expect(calls.map((c) => c[0])).toEqual(["from", "select", "eq", "eq", "order"]);
    expect(calls[0][1]).toEqual(["facts_current"]);
    expect(calls.slice(2, 4).map((c) => c[1])).toEqual([["entity_type", "project"], ["entity_id", "sample-p1"]]);
  });

  it("getCurrent returns null when absent; errors carry only the code", async () => {
    const empty = fakeClient({ data: null, error: null });
    expect(await new SupabaseFactStoreRepository(() => empty.client).getCurrent("project", "sample-p1", "oc_status")).toBeNull();
    const failing = fakeClient({ data: null, error: { code: "42501", message: "permission denied for view facts_current" } });
    await expect(new SupabaseFactStoreRepository(() => failing.client).listCurrent("project", "sample-p1")).rejects.toThrow(
      /^facts_current read failed \(42501\)$/,
    );
  });
});
