import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { createFixtureRepositories } = await import("../repositories/fixture");
const svc = await import("./developments");
const jobs = await import("./research-jobs");
const { DEVELOPMENT_BLOCKERS } = await import("../repositories/development-rules");
const { FakeResearchClient, sampleDevelopmentNames, sampleDevelopmentResponder } = await import("@/discovery/research");

type Role = "admin" | "advisor";
const as = (role: Role, userId = `staff-${role}`) => async () => ({ userId, role, mode: "fixture" as const, expiresAt: null });
const PE = { SESSION_SECRET: "test-only-session-secret-for-research-hash-0000", RESEARCH_MAX_JOBS_PER_DAY: "50" } as unknown as NodeJS.ProcessEnv;
const NOW = new Date("2026-10-24T06:00:00Z");
const NAMES = sampleDevelopmentNames("Hebbal");

function setup() {
  const repos = createFixtureRepositories();
  const base = { repos, env: "test" as const, processEnv: PE };
  return { repos, admin: { ...base, requireStaff: as("admin") }, advisor: { ...base, requireStaff: as("advisor") } };
}

/** Staff research for Hebbal, then one worker run (fake client, no network). */
async function researched(ctx = setup()) {
  const q = await svc.requestAreaDevelopmentResearch({ localityId: "hebbal" }, ctx.advisor);
  expect(q).toMatchObject({ ok: true, localityName: "Hebbal", result: { state: "queued" } });
  const run = await jobs.runResearchBatch({ repos: ctx.repos, env: "test", client: new FakeResearchClient(), now: () => NOW });
  return { ...ctx, run };
}

async function staffItem(ctx: ReturnType<typeof setup>, name: string) {
  const v = await svc.getStaffDevelopmentsView("hebbal", ctx.admin);
  if (!v.ok) throw new Error(JSON.stringify(v));
  const it = v.view.items.find((i) => i.development.name === name);
  if (!it) throw new Error(`missing ${name}`);
  return { ...it, view: v.view };
}

const editForm = (d: { id: string; version: number }, over: Record<string, unknown> = {}) => ({
  id: d.id,
  version: String(d.version),
  name: NAMES.metro,
  category: "metro",
  stage: "under_construction",
  authority: "SAMPLE Metro Authority",
  expectedCompletion: "December 2029",
  localityIds: ["hebbal"],
  lat: "13.045",
  lng: "77.597",
  locationPrecision: "approximate",
  sourceUrl: "https://example.org/sample-developments/hebbal/metro",
  sourceObservedAt: "2026-10-24",
  ...over,
});

describe("area development research: staff trigger → existing queue → worker", () => {
  it("queues one area_developments job keyed dev:<locality>; a repeat sees the active job", async () => {
    const { repos, advisor } = setup();
    expect(await svc.requestAreaDevelopmentResearch({ localityId: "hebbal" }, advisor)).toMatchObject({ ok: true, result: { state: "queued" } });
    expect(await svc.requestAreaDevelopmentResearch({ localityId: "hebbal" }, advisor)).toMatchObject({ ok: true, result: { state: "active" } });
    const [job] = await repos.researchJobs.listRecent(5);
    expect(job).toMatchObject({ kind: "area_developments", queryKey: "dev:hebbal", localityId: "hebbal", queryText: "Area developments: Hebbal" });
    expect(JSON.stringify(job)).not.toContain("staff-advisor");
  });

  it("refuses an unknown locality, automated actors and environments where research cannot run", async () => {
    const { repos, advisor } = setup();
    expect(await svc.requestAreaDevelopmentResearch({ localityId: "atlantis" }, advisor)).toMatchObject({ ok: false, error: "validation" });
    expect(await svc.requestAreaDevelopmentResearch({ localityId: "hebbal" }, { ...advisor, requireStaff: as("advisor", "system") })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await svc.requestAreaDevelopmentResearch({ localityId: "hebbal" }, { ...advisor, env: "production" })).toMatchObject({ ok: false, error: "unavailable" });
    expect(await repos.researchJobs.listRecent(5)).toHaveLength(0);
  });

  it("uses the shared daily cap", async () => {
    const { advisor } = setup();
    const pe = { ...PE, RESEARCH_MAX_JOBS_PER_DAY: "1" } as NodeJS.ProcessEnv;
    expect(await svc.requestAreaDevelopmentResearch({ localityId: "hebbal" }, { ...advisor, processEnv: pe })).toMatchObject({ result: { state: "queued" } });
    expect(await svc.requestAreaDevelopmentResearch({ localityId: "yelahanka" }, { ...advisor, processEnv: pe })).toMatchObject({ result: { state: "limited" } });
  });

  it("the worker stores cited SAMPLE items unverified and unpublished; buyers see nothing yet", async () => {
    const { repos, run } = await researched();
    expect(run.outcomes).toEqual([expect.objectContaining({ status: "done", resultCount: 2 })]);
    const rows = await repos.developments.listForStaff({ localityId: "hebbal" });
    expect(rows.map((r) => r.name).sort()).toEqual([NAMES.road, NAMES.metro].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ addedBy: "research", verification: "unverified", published: false, reviewStatus: "pending", isSample: true, sourceId: "sample-web-research" });
      expect(r.sourceUrl).toMatch(/^https:\/\/example\.org\//);
    }
    expect(rows.find((r) => r.name === NAMES.fabricated)).toBeUndefined();
    expect(await repos.developments.listPublished()).toEqual([]);
    const project = (await repos.projects.getProjectBySlug("sample-lakeview-residences"))!;
    expect(await svc.getPlannedNearProject(project, { repos })).toEqual([]);
  });

  it("a locality with nothing found finishes as no_results", async () => {
    const ctx = setup();
    await svc.requestAreaDevelopmentResearch({ localityId: "hebbal" }, ctx.advisor);
    const run = await jobs.runResearchBatch({
      repos: ctx.repos,
      env: "test",
      client: new FakeResearchClient(undefined, (req) => sampleDevelopmentResponder({ ...req, localityName: "nothing" })),
      now: () => NOW,
    });
    expect(run.outcomes).toEqual([expect.objectContaining({ status: "no_results", resultCount: 0 })]);
  });
});

describe("staff review: publish, roles, readiness, audit", () => {
  it("advisor edits; only an admin publishes; the buyer then sees the item with its distance", async () => {
    const ctx = await researched();
    const metro = await staffItem(ctx, NAMES.metro);
    expect(metro.blockers).toEqual([]);
    expect(metro.view.latestJob).toMatchObject({ kind: "area_developments", status: "done" });

    const edited = await svc.updateDevelopment(editForm(metro.development), ctx.advisor);
    expect(edited).toMatchObject({ ok: true, changed: true });
    const d = edited.ok ? edited.development : null!;
    expect(d.location).toEqual({ lat: 13.045, lng: 77.597, precision: "approximate" });

    expect(await svc.reviewDevelopment({ id: d.id, version: String(d.version), action: "publish" }, ctx.advisor)).toMatchObject({ ok: false, error: "forbidden" });
    const pub = await svc.reviewDevelopment({ id: d.id, version: String(d.version), action: "publish", verification: "source_confirmed" }, ctx.admin);
    expect(pub).toMatchObject({ ok: true, changed: true, development: { published: true, verification: "source_confirmed" } });

    const project = (await ctx.repos.projects.getProjectBySlug("sample-lakeview-residences"))!;
    const near = await svc.getPlannedNearProject(project, { repos: ctx.repos });
    expect(near).toHaveLength(1);
    expect(near[0].development).toMatchObject({ name: NAMES.metro, expectedCompletion: "December 2029", isSample: true });
    expect(near[0].distanceMeters).toBeGreaterThan(500);
    expect(near[0].distanceMeters).toBeLessThan(1500);
    expect("reviewStatus" in near[0].development).toBe(false);

    const far = (await ctx.repos.projects.getProjectBySlug("sample-orchard-greens"))!;
    expect(await svc.getPlannedNearProject(far, { repos: ctx.repos })).toEqual([]);

    const audit = (await staffItem(ctx, NAMES.metro)).audit.map((a) => a.action);
    expect(audit).toEqual(["researched", "edited", "published"]);
  });

  it("an item without a cited authority is not ready; rejecting needs no admin while unpublished", async () => {
    const ctx = await researched();
    const road = await staffItem(ctx, NAMES.road);
    expect(road.blockers).toEqual([DEVELOPMENT_BLOCKERS.authority]);
    const r = await svc.reviewDevelopment({ id: road.development.id, version: String(road.development.version), action: "publish" }, ctx.admin);
    expect(r).toMatchObject({ ok: false, error: "not_ready", errors: [DEVELOPMENT_BLOCKERS.authority] });
    const rej = await svc.reviewDevelopment({ id: road.development.id, version: String(road.development.version), action: "reject", note: "no authority page" }, ctx.advisor);
    expect(rej).toMatchObject({ ok: true, development: { reviewStatus: "rejected", rejectionNote: "no authority page" } });
  });

  it("stale versions conflict; an advisor cannot edit a published row; an admin edit that breaks readiness auto-unpublishes", async () => {
    const ctx = await researched();
    const metro = await staffItem(ctx, NAMES.metro);
    const v1 = metro.development.version;
    const ok = await svc.reviewDevelopment({ id: metro.development.id, version: String(v1), action: "publish" }, ctx.admin);
    expect(ok.ok).toBe(true);
    expect(await svc.reviewDevelopment({ id: metro.development.id, version: String(v1), action: "unpublish" }, ctx.admin)).toMatchObject({ ok: false, error: "conflict" });
    const cur = (await staffItem(ctx, NAMES.metro)).development;
    expect(await svc.updateDevelopment(editForm(cur), ctx.advisor)).toMatchObject({ ok: false, error: "forbidden" });
    const broke = await svc.updateDevelopment(editForm(cur, { authority: "" }), ctx.admin);
    expect(broke).toMatchObject({ ok: true, autoUnpublished: true, development: { published: false, verification: "unverified" } });
  });

  it("a changed declared date is appended to the slip history", async () => {
    const ctx = await researched();
    const metro = (await staffItem(ctx, NAMES.metro)).development;
    const r = await svc.updateDevelopment(editForm(metro, { expectedCompletion: "June 2030", sourceObservedAt: "2026-10-24T05:00:00Z" }), ctx.advisor);
    expect(r.ok && r.development.completionHistory.map((h) => h.expectedCompletion)).toEqual(["December 2029", "June 2030"]);
  });

  it("re-research never overwrites a published row; it records a pending change instead", async () => {
    const ctx = await researched();
    const metro = (await staffItem(ctx, NAMES.metro)).development;
    const edited = await svc.updateDevelopment(editForm(metro, { stage: "tendered" }), ctx.admin);
    const d = edited.ok ? edited.development : null!;
    await svc.reviewDevelopment({ id: d.id, version: String(d.version), action: "publish" }, ctx.admin);
    await ctx.repos.developments.storeResearched({
      jobId: "job-2",
      researchLocalityId: "hebbal",
      sourceId: "sample-web-research",
      observedAt: "2026-10-25T00:00:00.000Z",
      isSample: true,
      items: [{ name: NAMES.metro, category: "metro", stage: "under_construction", authority: "SAMPLE Metro Authority", expectedCompletion: "December 2029", localityId: "hebbal", sourceUrl: d.sourceUrl! }],
    });
    const after = (await staffItem(ctx, NAMES.metro)).development;
    expect(after).toMatchObject({ published: true, stage: "tendered", pendingChange: { stage: "under_construction" } });
  });

  it("manual entry requires an authority and an https page, and refuses promotional names", async () => {
    const { admin } = setup();
    const base = {
      name: "SAMPLE Manual Flyover",
      category: "flyover",
      stage: "approved",
      authority: "SAMPLE Roads Board",
      localityIds: ["hebbal"],
      sourceUrl: "https://example.org/sample-manual",
      sourceObservedAt: "2026-10-20",
    };
    const r = await svc.createDevelopment(base, admin);
    expect(r).toMatchObject({ ok: true, development: { addedBy: "staff", verification: "unverified", published: false, sourceId: null } });
    expect(await svc.createDevelopment({ ...base, authority: "" }, admin)).toMatchObject({ ok: false, error: "validation", errors: ["authority: required for a manual entry"] });
    expect(await svc.createDevelopment({ ...base, sourceUrl: "http://example.org/x" }, admin)).toMatchObject({ ok: false, error: "validation" });
    expect(await svc.createDevelopment({ ...base, name: "SAMPLE Price Boom Road" }, admin)).toMatchObject({ ok: false, error: "validation" });
    expect(await svc.createDevelopment({ ...base, expectedCompletion: "soon" }, admin)).toMatchObject({ ok: false, error: "validation" });
    expect(await svc.createDevelopment({ ...base, lat: "13.0" }, admin)).toMatchObject({ ok: false, error: "validation" });
  });
});

describe("readiness rules stay in sync with SQL", () => {
  it("every blocker message is produced by tn_development_publish_blockers", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0008_developments.sql"), "utf8");
    for (const msg of Object.values(DEVELOPMENT_BLOCKERS)) expect(sql).toContain(`'${msg}'`);
  });
});
