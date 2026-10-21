import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { createFixtureRepositories } = await import("../repositories/fixture");
const research = await import("./research");
const { searchProperties } = await import("./search");
const { StaffAuthError } = await import("../auth");
const { factVersion } = await import("@/research/verification");

/** changeVerification with the CURRENT fact version (what a fresh tab would post). */
async function verify(
  projectId: string,
  field: "address" | "reraNumbers" | "constructionStatus" | "declaredPossession" | string,
  to: string,
  note: string | null,
  deps: Parameters<typeof research.changeVerification>[1],
) {
  const repos = deps?.repos;
  const p = repos ? await repos.research.getProjectByIdForStaff(projectId) : null;
  const fact = p ? (p as unknown as Record<string, Parameters<typeof factVersion>[0]>)[field] : undefined;
  const expectedVersion = fact ? factVersion(fact) : "none";
  return research.changeVerification({ projectId, field, to, expectedVersion, note }, deps);
}

type Role = "admin" | "advisor";
const as = (role: Role, userId = `staff-${role}`) => async () => ({ userId, role, mode: "fixture" as const, expiresAt: null });
const noSession = async (): Promise<never> => {
  throw new StaffAuthError("unauthenticated");
};
const OBSERVED = "2026-10-01T09:00:00.000Z";
const source = { "sources[0].sourceId": "sample-feed", "sources[0].url": "https://example.com/sample/x", "sources[0].observedAt": OBSERVED };

function setup() {
  const repos = createFixtureRepositories();
  const admin = { repos, requireStaff: as("admin") };
  const advisor = { repos, requireStaff: as("advisor") };
  return { repos, admin, advisor };
}

async function newProject(deps: Parameters<typeof research.createProject>[1]) {
  const r = await research.createProject({ name: "Test Residency", developerName: "Test Builder", localityId: "hebbal" }, deps);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.project;
}

async function makeReady(projectId: string, deps: { repos: ReturnType<typeof createFixtureRepositories>; requireStaff: ReturnType<typeof as> }) {
  const facts: Record<string, string | string[]>[] = [
    { field: "address", value: "Test Road 1, Hebbal" },
    { field: "reraNumbers", value: "TEST/REG/0001" },
    { field: "constructionStatus", value: "under_construction" },
  ];
  for (const f of facts) {
    const r = await research.updateFact({ projectId, status: "known", ...source, ...f }, deps);
    if (!r.ok) throw new Error(JSON.stringify(r));
  }
  const v = await verify(projectId, "reraNumbers", "source_confirmed", "Checked portal", deps);
  if (!v.ok) throw new Error(JSON.stringify(v));
}

describe("research services: session and actor checks", () => {
  it("every service requires a staff session", async () => {
    const { repos } = setup();
    const deps = { repos, requireStaff: noSession };
    await expect(research.listStaffProjects(deps)).rejects.toBeInstanceOf(StaffAuthError);
    await expect(research.getStaffProjectView("x", deps)).rejects.toBeInstanceOf(StaffAuthError);
    await expect(research.createProject({}, deps)).rejects.toBeInstanceOf(StaffAuthError);
    await expect(research.updateFact({}, deps)).rejects.toBeInstanceOf(StaffAuthError);
    await expect(verify("x", "address", "reviewed", null, deps)).rejects.toBeInstanceOf(StaffAuthError);
    await expect(research.setPublished("x", true, deps)).rejects.toBeInstanceOf(StaffAuthError);
  });

  it("refuses automated actors for every write, even with an admin role", async () => {
    const { repos, admin } = setup();
    const p = await newProject(admin);
    const ai = { repos, requireStaff: as("admin", "ai") };
    expect(await research.createProject({ name: "AI Project", developerName: "X Y", localityId: "hebbal" }, ai)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "AI Road 1", ...source }, ai)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await verify(p.id, "address", "reviewed", null, ai)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await research.setPublished(p.id, true, ai)).toMatchObject({ ok: false, error: "forbidden" });
    expect((await research.getStaffProjectView(p.id, admin)).ok && (await repos.research.listAudit(p.id)).length).toBe(1);
  });
});

describe("createProject", () => {
  it("creates an unpublished, non-sample project with unknown facts, unique slug and an audit event", async () => {
    const { repos, advisor } = setup();
    const a = await newProject(advisor);
    const b = await newProject(advisor);
    expect(a).toMatchObject({ published: false, isSample: false, localityId: "hebbal", completeness: 0 });
    expect(a.location.precision).toBe("locality_centroid");
    for (const f of [a.address, a.reraNumbers, a.constructionStatus, a.declaredPossession]) {
      expect(f).toEqual({ status: "unknown", value: null, verification: "unverified", sources: [] });
    }
    expect(a.slug).toBe("test-residency-hebbal");
    expect(b.slug).toBe("test-residency-hebbal-2");
    expect(await repos.research.listAudit(a.id)).toMatchObject([{ action: "created", field: "basics", actorRole: "advisor" }]);
    // never visible publicly
    expect(await repos.projects.getProjectBySlug(a.slug)).toBeNull();
  });

  it("validates input and requires an active locality", async () => {
    const { advisor } = setup();
    expect(await research.createProject({ name: "X", developerName: "Y", localityId: "hebbal" }, advisor)).toMatchObject({ ok: false, error: "validation" });
    expect(await research.createProject({ name: "Valid Name", developerName: "Valid Dev", localityId: "not-a-place" }, advisor)).toMatchObject({ ok: false, error: "validation" });
    expect(await research.createProject({ name: "Valid Name", developerName: "Valid Dev", localityId: "hebbal", lat: "13.0" }, advisor)).toMatchObject({ ok: false, error: "validation" });
    const ok = await research.createProject({ name: "Valid Name", developerName: "Valid Dev", localityId: "hebbal", lat: "13.04", lng: "77.6" }, advisor);
    expect(ok.ok && ok.project.location).toEqual({ lat: 13.04, lng: 77.6, precision: "approximate" });
  });
});

describe("updateFact", () => {
  it("stores the fact with sources, resets verification to unverified, recomputes completeness and audits", async () => {
    const { repos, admin, advisor } = setup();
    const p = await newProject(advisor);
    const r1 = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 1, Hebbal", ...source }, advisor);
    if (!r1.ok) throw new Error(JSON.stringify(r1));
    expect(r1.project.address).toMatchObject({ status: "known", value: "Test Road 1, Hebbal", verification: "unverified", sources: [{ sourceId: "sample-feed", url: "https://example.com/sample/x", observedAt: OBSERVED }] });
    expect(r1.project.completeness).toBeGreaterThan(0);
    await verify(p.id, "address", "reviewed", null, admin);
    const r2 = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 2, Hebbal", ...source }, admin);
    expect(r2.ok && r2.project.address.verification).toBe("unverified");
    const audit = await repos.research.listAudit(p.id);
    expect(audit.map((e) => e.action)).toEqual(["created", "fact_set", "verification_changed", "fact_set"]);
    expect(audit[3]).toMatchObject({ fromVerification: "reviewed", toVerification: "unverified", actorRole: "admin" });
  });

  it("rejects edits without an https source and unknown projects", async () => {
    const { advisor } = setup();
    const p = await newProject(advisor);
    const noSource = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 1" }, advisor);
    expect(noSource).toMatchObject({ ok: false, error: "validation" });
    const http = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 1", ...source, "sources[0].url": "http://example.com" }, advisor);
    expect(http).toMatchObject({ ok: false, error: "validation" });
    expect(await research.updateFact({ projectId: "nope", field: "address", status: "known", value: "Test Road 1", ...source }, advisor)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("changeVerification", () => {
  it("advisor cannot set reviewed or source_confirmed; may set disputed; admin may set reviewed", async () => {
    const { repos, admin, advisor } = setup();
    const p = await newProject(advisor);
    await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 1, Hebbal", ...source }, advisor);
    expect(await verify(p.id, "address", "reviewed", null, advisor)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await verify(p.id, "address", "source_confirmed", null, advisor)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await verify(p.id, "address", "disputed", "Sources disagree", advisor)).toMatchObject({ ok: true });
    expect(await verify(p.id, "address", "reviewed", null, admin)).toMatchObject({ ok: true });
    const audit = (await repos.research.listAudit(p.id)).filter((e) => e.action === "verification_changed");
    expect(audit).toMatchObject([
      { fromVerification: "unverified", toVerification: "disputed", note: "Sources disagree", actorRole: "advisor" },
      { fromVerification: "disputed", toVerification: "reviewed", actorRole: "admin" },
    ]);
  });

  it("requires a source on the fact and a valid field/state", async () => {
    const { admin, advisor } = setup();
    const p = await newProject(advisor);
    expect(await verify(p.id, "address", "reviewed", null, admin)).toMatchObject({ ok: false, error: "validation" });
    expect(await verify(p.id, "price", "reviewed", null, admin)).toMatchObject({ ok: false, error: "validation" });
    expect(await verify(p.id, "address", "verified", null, admin)).toMatchObject({ ok: false, error: "validation" });
  });
});

describe("setPublished", () => {
  it("advisor cannot publish or unpublish", async () => {
    const { admin, advisor } = setup();
    const p = await newProject(advisor);
    await makeReady(p.id, admin);
    expect(await research.setPublished(p.id, true, advisor)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await research.setPublished("sample-proj-lakeview", false, advisor)).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("publishing is blocked when not ready, with blockers listed", async () => {
    const { admin, advisor } = setup();
    const p = await newProject(advisor);
    const r = await research.setPublished(p.id, true, admin);
    expect(r).toMatchObject({ ok: false, error: "not_ready" });
    expect(!r.ok && r.errors?.length).toBeGreaterThan(0);
  });

  it("admin publishes a ready project (then visible publicly), unpublishes it, each audited", async () => {
    const { repos, admin, advisor } = setup();
    const p = await newProject(advisor);
    await makeReady(p.id, admin);
    const view = await research.getStaffProjectView(p.id, advisor);
    expect(view.ok && view.readiness.ready).toBe(true);
    expect(await research.setPublished(p.id, true, admin)).toMatchObject({ ok: true, changed: true });
    expect((await repos.projects.getProjectBySlug(p.slug))?.id).toBe(p.id);
    const found = await searchProperties({ text: "Test Residency" }, { repos, minResearched: 0 });
    expect(found.researched.map((x) => x.id)).toEqual([p.id]);
    expect(await research.setPublished(p.id, true, admin)).toMatchObject({ ok: true, changed: false });
    expect(await research.setPublished(p.id, false, admin)).toMatchObject({ ok: true, changed: true });
    expect(await repos.projects.getProjectBySlug(p.slug)).toBeNull();
    const actions = (await repos.research.listAudit(p.id)).map((e) => e.action);
    expect(actions.filter((a) => a === "published" || a === "unpublished")).toEqual(["published", "unpublished"]);
  });

  it("unpublishing is always allowed for admin (even if not ready)", async () => {
    const { admin } = setup();
    expect(await research.setPublished("sample-proj-jakkur", false, admin)).toMatchObject({ ok: true, changed: true });
  });
});

describe("staff reads", () => {
  it("list includes unpublished projects with readiness; view includes audit", async () => {
    const { advisor } = setup();
    const list = await research.listStaffProjects(advisor);
    expect(list.some((x) => !x.project.published)).toBe(true);
    expect(list.every((x) => typeof x.readiness.ready === "boolean")).toBe(true);
    const v = await research.getStaffProjectView("sample-proj-unpublished", advisor);
    expect(v).toMatchObject({ ok: true, project: { published: false }, audit: [] });
    expect(await research.getStaffProjectView("missing", advisor)).toMatchObject({ ok: false, error: "not_found" });
  });
});

describe("M3 review fixes", () => {
  it("H1: a stale tab's verification is refused with 'conflict' and nothing changes", async () => {
    const { repos, admin, advisor } = setup();
    const p = await newProject(advisor);
    await research.updateFact({ projectId: p.id, field: "reraNumbers", status: "known", value: "TEST/REG/0001", ...source }, advisor);
    const tabA = await research.getStaffProjectView(p.id, admin); // reviewer loads the page
    if (!tabA.ok) throw new Error("view");
    // meanwhile someone edits the RERA number
    await research.updateFact({ projectId: p.id, field: "reraNumbers", status: "known", value: "TEST/REG/0002", ...source }, advisor);
    const stale = await research.changeVerification(
      { projectId: p.id, field: "reraNumbers", to: "reviewed", expectedVersion: tabA.factVersions.reraNumbers },
      admin,
    );
    expect(stale).toEqual({ ok: false, error: "conflict", message: "This fact changed since you loaded it — reload and review again." });
    const after = await repos.research.getProjectByIdForStaff(p.id);
    expect(after?.reraNumbers.verification).toBe("unverified");
    expect((await repos.research.listAudit(p.id)).some((e) => e.action === "verification_changed")).toBe(false);
    // the repository enforces it too (authoritative check)
    const direct = await repos.research.setFactVerification(p.id, "reraNumbers", "reviewed", tabA.factVersions.reraNumbers, { actorId: "a", actorRole: "admin" }, null);
    expect(direct).toMatchObject({ ok: false, error: "conflict" });
    // a fresh load works
    const tabB = await research.getStaffProjectView(p.id, admin);
    if (!tabB.ok) throw new Error("view");
    expect(await research.changeVerification({ projectId: p.id, field: "reraNumbers", to: "reviewed", expectedVersion: tabB.factVersions.reraNumbers }, admin)).toMatchObject({ ok: true });
  });

  it("H1: expectedVersion is required", async () => {
    const { admin, advisor } = setup();
    const p = await newProject(advisor);
    await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 1, Hebbal", ...source }, advisor);
    expect(await research.changeVerification({ projectId: p.id, field: "address", to: "reviewed", expectedVersion: "" }, admin)).toMatchObject({ ok: false, error: "validation" });
  });

  it("M3/D13: an edit that breaks readiness auto-unpublishes with audit; a harmless edit stays live", async () => {
    const { repos, admin, advisor } = setup();
    const p = await newProject(advisor);
    await makeReady(p.id, admin);
    expect(await research.setPublished(p.id, true, admin)).toMatchObject({ ok: true, changed: true });
    const harmless = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 9, Hebbal", ...source }, advisor);
    expect(harmless).toMatchObject({ ok: true, autoUnpublished: false, project: { published: true } });
    const breaking = await research.updateFact({ projectId: p.id, field: "reraNumbers", status: "known", value: "TEST/REG/0009", ...source }, advisor);
    expect(breaking).toMatchObject({ ok: true, autoUnpublished: true, project: { published: false } });
    expect(await repos.projects.getProjectBySlug(p.slug)).toBeNull();
    const auto = (await repos.research.listAudit(p.id)).filter((e) => e.action === "unpublished");
    expect(auto).toMatchObject([{ note: "auto: failed readiness after edit", actorId: "staff-advisor", actorRole: "advisor", field: "published" }]);
  });

  it("M3/D13: an advisor's dispute on a published project auto-unpublishes it", async () => {
    const { repos, admin, advisor } = setup();
    const p = await newProject(advisor);
    await makeReady(p.id, admin);
    await research.setPublished(p.id, true, admin);
    const r = await verify(p.id, "constructionStatus", "disputed", "Conflicting reports", advisor);
    expect(r).toMatchObject({ ok: true, autoUnpublished: true, project: { published: false } });
    expect((await repos.research.listAudit(p.id)).at(-1)).toMatchObject({ action: "unpublished", note: "auto: failed readiness after edit" });
  });

  it("M1: fixture writes commit change and audit together (failed write leaves no trace)", async () => {
    const { repos, admin } = setup();
    const before = await repos.research.listAudit("sample-proj-lakeview");
    const r = await repos.research.setFact("missing", "address", { status: "unknown", value: null, verification: "unverified", sources: [] }, { actorId: "a", actorRole: "admin" });
    expect(r).toMatchObject({ ok: false, error: "not_found" });
    const notReady = await research.setPublished("sample-proj-unpublished", true, admin);
    expect(notReady).toMatchObject({ ok: false, error: "not_ready" });
    expect(await repos.research.listAudit("sample-proj-unpublished")).toEqual([]);
    expect(await repos.research.listAudit("sample-proj-lakeview")).toEqual(before);
  });

  it("L1: sourceId must be in the registry; listResearchSources exposes citable sources", async () => {
    const { advisor } = setup();
    const p = await newProject(advisor);
    const r = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 1, Hebbal", ...source, "sources[0].sourceId": "made-up" }, advisor);
    expect(r).toMatchObject({ ok: false, error: "validation", errors: ["sources.0.sourceId: Unknown source — choose one from the registry"] });
    const ids = research.listResearchSources().map((s) => s.id);
    expect(ids).toContain("k-rera");
    expect(ids).toContain("sample-feed"); // non-production only
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(research.listResearchSources().map((s) => s.id)).not.toContain("sample-feed");
      const prod = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "Test Road 1, Hebbal", ...source }, advisor);
      expect(prod).toMatchObject({ ok: false, error: "validation" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("L4: lastCheckedAt changes only on fact edits", async () => {
    const { repos, admin } = setup();
    const before = (await repos.research.getProjectByIdForStaff("sample-proj-jakkur"))!.lastCheckedAt;
    await research.setPublished("sample-proj-jakkur", false, admin);
    expect((await repos.research.getProjectByIdForStaff("sample-proj-jakkur"))!.lastCheckedAt).toBe(before);
    await research.updateFact({ projectId: "sample-proj-jakkur", field: "address", status: "known", value: "SAMPLE Road 7, Jakkur", ...source }, admin);
    expect((await repos.research.getProjectByIdForStaff("sample-proj-jakkur"))!.lastCheckedAt).not.toBe(before);
  });

  it("L6: audit entries carry actor id and a display name (id in fixture mode)", async () => {
    const { advisor } = setup();
    const p = await newProject(advisor);
    const v = await research.getStaffProjectView(p.id, advisor);
    expect(v.ok && v.audit[0]).toMatchObject({ actorId: "staff-advisor", actorName: "staff-advisor" });
  });

  it("L8: a new developer is created unless developerId is given; listDevelopers lists them", async () => {
    const { advisor } = setup();
    const a = await research.createProject({ name: "Dev Test One", developerName: "SAMPLE Developer A", localityId: "hebbal" }, advisor);
    if (!a.ok) throw new Error("create");
    expect(a.project.developer.id).not.toBe("sample-dev-a"); // same name, NOT merged
    expect(a.project.developer.isSample).toBe(false);
    const b = await research.createProject({ name: "Dev Test Two", developerId: "sample-dev-a", localityId: "hebbal" }, advisor);
    expect(b.ok && b.project.developer.id).toBe("sample-dev-a");
    expect(await research.createProject({ name: "Dev Test Three", developerId: "nope", localityId: "hebbal" }, advisor)).toMatchObject({ ok: false, error: "validation" });
    expect(await research.createProject({ name: "Dev Test Four", localityId: "hebbal" }, advisor)).toMatchObject({ ok: false, error: "validation" });
    const devs = await research.listDevelopers(advisor);
    expect(devs.map((d) => d.id)).toEqual(expect.arrayContaining(["sample-dev-a", a.project.developer.id]));
  });
});
