// Cross-module regression tests for TrueNest critical controls.
// Module-level behaviour is covered next to each module (src/**/*.test.ts); these tests pin the
// guarantees that only hold when several modules work together (search + discovery + registry,
// lead validation + lead service + repository, auth + lead service).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCookieJar } from "../../src/server/__tests__/cookie-mock";

vi.mock("server-only", () => ({}));
const jar = { current: createCookieJar() };
const reqHeaders = { current: new Headers() };
vi.mock("next/headers", () => ({
  cookies: async () => jar.current.store,
  headers: async () => reqHeaders.current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const discovery = await import("@/discovery");
const { SAMPLE_RECORDS } = await import("@/discovery/fixtures");
const { parseLeadInput } = await import("@/leads/validation");
const { CONSENT_TEXT_VERSION } = await import("@/leads/consent");
const { createFixtureRepositories, SAMPLE_PROJECTS } = await import("@/server/repositories/fixture");
const { searchProperties } = await import("@/server/services/search");
const { getComparison } = await import("@/server/services/compare");
const { submitLead, listLeads } = await import("@/server/services/leads");
const { FixedWindowRateLimiter } = await import("@/server/services/rate-limit");
const auth = await import("@/server/auth");
const { signSessionToken } = await import("@/server/session-token");
const research = await import("@/server/services/research");
const { setRepositoriesForTesting } = await import("@/server/repositories");
const { submitLeadAction } = await import("@/server/actions/leads");
const { clientIpFromForwardedFor } = await import("@/server/client-ip");

const TEST_ONLY_SESSION_SECRET = "test-only-session-secret-not-for-real-use-000000";
const TEST_ONLY_ADMIN_PASSWORD = "test-only-admin-password";
const ENVS = ["test", "development", "production"] as const;
const UNPUBLISHED = SAMPLE_PROJECTS.find((p) => !p.published)!;
const PUBLISHED = SAMPLE_PROJECTS.filter((p) => p.published);

function validLead(overrides: Record<string, unknown> = {}) {
  return {
    requestType: "buyer_assistance",
    name: "Test Buyer",
    email: "buyer@example.com",
    phone: null,
    preferredChannel: "email",
    contactConsent: true,
    marketingConsent: false,
    consentTextVersion: CONSENT_TEXT_VERSION,
    ...overrides,
  };
}
const openLimiter = () => new FixedWindowRateLimiter(1000, 60_000);
const asStaff = async () => ({ userId: "staff-1", role: "admin" as const, mode: "fixture" as const, expiresAt: null });

beforeEach(() => {
  jar.current = createCookieJar();
  reqHeaders.current = new Headers();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATA_BACKEND", "fixture");
  vi.stubEnv("SESSION_SECRET", TEST_ONLY_SESSION_SECRET);
  vi.stubEnv("ADMIN_DEV_PASSWORD", TEST_ONLY_ADMIN_PASSWORD);
});
afterEach(() => vi.unstubAllEnvs());

describe("Lane B never runs fixtures in production", () => {
  it("discoverExternal and discoverSampleSync return [] for env production", async () => {
    for (const q of [{}, { localityId: "hebbal" }, { localityId: "thanisandra" }, { text: "SAMPLE" }]) {
      expect(await discovery.discoverExternal(q, { env: "production" })).toEqual([]);
      expect(discovery.discoverSampleSync(q, { env: "production" })).toEqual([]);
    }
    // sanity: the same queries do return fixtures outside production
    expect((await discovery.discoverExternal({}, { env: "test" })).length).toBeGreaterThan(0);
  });

  it("searchProperties with the default discovery yields no external listings when NODE_ENV=production", async () => {
    const repos = createFixtureRepositories();
    vi.stubEnv("NODE_ENV", "production");
    const prod = await searchProperties({ localityId: "thanisandra" }, { repos, minResearched: 99 });
    expect(prod.external).toEqual([]);
    vi.stubEnv("NODE_ENV", "development");
    const dev = await searchProperties({ localityId: "thanisandra" }, { repos, minResearched: 99 });
    expect(dev.externalQueried).toBe(true);
    expect(dev.external.length).toBeGreaterThan(0);
  });
});

describe("source registry gate", () => {
  it("no proposed / suspended / rejected source is runnable in any environment", () => {
    const blocked = discovery.SOURCE_REGISTRY.filter((s) => s.status !== "approved");
    expect(blocked.length).toBeGreaterThan(0);
    for (const s of blocked) for (const env of ENVS) expect(discovery.isRunnable(s, env)).toBe(false);
  });

  it("every approved source is either an in-repo fixture or has a documented terms review", () => {
    for (const s of discovery.SOURCE_REGISTRY.filter((x) => x.status === "approved")) {
      if (s.accessMethod !== "fixture") expect(s.termsReviewedAt, s.id).not.toBeNull();
      if (s.type === "fixture") expect(s.allowedEnvironments).not.toContain("production");
    }
  });

  it("an adapter for a proposed source is skipped and never called", async () => {
    const proposed = discovery.SOURCE_REGISTRY.find((s) => s.status === "proposed")!;
    const search = vi.fn(async () => [
      { sourceId: proposed.id, sourceRecordId: "x", canonicalUrl: "https://example.com/x", title: "SAMPLE X" },
    ]);
    for (const env of ENVS) {
      const r = await discovery.discoverExternalWithReport({}, { env, adapters: [{ sourceId: proposed.id, search }] });
      expect(r.listings).toEqual([]);
      expect(r.skipped.map((s) => s.sourceId)).toContain(proposed.id);
    }
    expect(search).not.toHaveBeenCalled();
  });
});

describe("dedupe never merges on similar names alone", () => {
  it("fixture 'Lakeview Residences' (Developer A) and 'Lakeview Residency' (Developer B) stay separate listings", async () => {
    const listings = await discovery.discoverExternal({}, { env: "test" });
    const residences = listings.filter((l) => /Lakeview Residences/.test(l.title));
    const residency = listings.filter((l) => /Lakeview Residency/.test(l.title));
    expect(residences).toHaveLength(1);
    expect(residency).toHaveLength(1);
    expect(residences[0].id).not.toBe(residency[0].id);
    expect(residences[0].developerName).not.toBe(residency[0].developerName);
  });

  it("same name, same address, same coordinates but different developers does not merge (flagged instead)", async () => {
    const base = SAMPLE_RECORDS[0];
    const twin = {
      ...base,
      sourceRecordId: "SAMPLE-TWIN-1",
      canonicalUrl: "https://example.org/sample/other-page",
      developerName: "SAMPLE Developer Z",
      reraNumber: null,
    };
    const r = await discovery.discoverExternalWithReport(
      {},
      {
        env: "test",
        adapters: [{ sourceId: "sample-feed", search: async () => [{ ...base, reraNumber: null }, twin] }],
      },
    );
    expect(r.listings).toHaveLength(2);
    expect(r.reviewFlags.some((f) => f.kind === "possible_duplicate")).toBe(true);
  });

  it("a Lane B listing is linked to a researched project only by RERA number, never by name/developer/location", async () => {
    const listings = await discovery.discoverExternal({ localityId: "devanahalli" }, { env: "test", projects: [...SAMPLE_PROJECTS] });
    const orchard = listings.find((l) => /Orchard Greens/.test(l.title));
    expect(orchard).toBeDefined();
    // Researched "SAMPLE Orchard Greens" has no RERA number, so no strong identifier exists.
    expect(orchard!.matchedProjectId).toBeNull();
    const hebbal = await discovery.discoverExternal({ localityId: "hebbal" }, { env: "test", projects: [...SAMPLE_PROJECTS] });
    expect(hebbal.find((l) => /Lakeview Residences/.test(l.title))?.matchedProjectId).toBe("sample-proj-lakeview");
  });

  it("every Lane B listing carries the unverified label, source, canonical URL and discovery date", async () => {
    const repos = createFixtureRepositories();
    const r = await searchProperties({ localityId: "thanisandra" }, { repos, minResearched: 99 });
    expect(r.external.length).toBeGreaterThan(0);
    for (const l of r.external) {
      expect(l.lane).toBe("external");
      expect(l.limitations[0]).toBe(discovery.NOT_VERIFIED);
      expect(l.sourceId).toBeTruthy();
      expect(l.canonicalUrl).toMatch(/^https:\/\/(www\.)?example\.(com|org)\//);
      expect(l.discoveredAt).toBeTruthy();
    }
  });
});

describe("consent gating", () => {
  for (const [label, consent] of [
    ["missing", undefined],
    ["false", false],
    ["unticked checkbox string", "off"],
    ["empty string", ""],
  ] as const) {
    it(`parseLeadInput rejects contactConsent ${label}`, () => {
      const raw = validLead();
      if (consent === undefined) delete (raw as Record<string, unknown>).contactConsent;
      else (raw as Record<string, unknown>).contactConsent = consent;
      const r = parseLeadInput(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.contactConsent).toBeTruthy();
    });
  }

  it("parseLeadInput rejects a nested consent object without contactConsent", () => {
    const flat: Record<string, unknown> = validLead();
    for (const k of ["contactConsent", "marketingConsent", "consentTextVersion"]) delete flat[k];
    const r = parseLeadInput({ ...flat, consent: { marketingConsent: true, consentTextVersion: CONSENT_TEXT_VERSION } });
    expect(r.ok).toBe(false);
  });

  it("submitLead without consent stores nothing; with consent stores exactly one lead", async () => {
    const repos = createFixtureRepositories();
    const deps = { repos, limiter: openLimiter(), requireStaff: asStaff };
    const denied = await submitLead(validLead({ contactConsent: false }), { ipKey: "t" }, deps);
    expect(denied).toMatchObject({ ok: false, reason: "validation" });
    expect(await listLeads({}, deps)).toHaveLength(0);

    const ok = await submitLead(validLead(), { ipKey: "t" }, deps);
    expect(ok.ok).toBe(true);
    const stored = await listLeads({}, deps);
    expect(stored).toHaveLength(1);
    expect(stored[0].consent.contactConsent).toBe(true);
    expect(stored[0].consent.marketingConsent).toBe(false);
    expect(stored[0].consent.consentTextVersion).toBe(CONSENT_TEXT_VERSION);
  });
});

describe("unpublished projects never leak", () => {
  it("search, comparison and lead references all refuse the unpublished project", async () => {
    const repos = createFixtureRepositories();
    const discover = async () => ({ listings: [], errors: [] });
    for (const q of [{}, { localityId: UNPUBLISHED.localityId }, { text: "Unpublished" }, { text: UNPUBLISHED.slug }]) {
      const r = await searchProperties(q, { repos, discover, minResearched: 0 });
      expect(r.researched.map((p) => p.id)).not.toContain(UNPUBLISHED.id);
    }
    const all = await searchProperties({ limit: 50 }, { repos, discover, minResearched: 0 });
    expect(all.researched.map((p) => p.id).sort()).toEqual(PUBLISHED.map((p) => p.id).sort());

    const cmp = await getComparison([PUBLISHED[0].id, UNPUBLISHED.id], { repos });
    expect(cmp.ok).toBe(true);
    if (cmp.ok) {
      expect(cmp.projects.map((p) => p.id)).toEqual([PUBLISHED[0].id]);
      expect(cmp.missingIds).toEqual([UNPUBLISHED.id]);
    }

    const lead = await submitLead(validLead({ projectId: UNPUBLISHED.id }), { ipKey: "t" }, { repos, limiter: openLimiter() });
    expect(lead).toMatchObject({ ok: false, reason: "validation" });
  });
});

describe("admin access denial", () => {
  it("fixture admin is refused in production and outside fixture mode", () => {
    expect(auth.fixtureAdminAllowed({ NODE_ENV: "production", DATA_BACKEND: "fixture" } as NodeJS.ProcessEnv)).toBe(false);
    expect(auth.fixtureAdminAllowed({ NODE_ENV: "development", DATA_BACKEND: "supabase" } as NodeJS.ProcessEnv)).toBe(false);
    expect(auth.fixtureAdminAllowed({ NODE_ENV: "development", DATA_BACKEND: "fixture" } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("dev-password login in production sets no cookie, and lead listing stays locked", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await auth.loginWithDevPassword(TEST_ONLY_ADMIN_PASSWORD)).toMatchObject({ ok: false, error: "disabled" });
    expect(jar.current.sets).toHaveLength(0);
    await expect(listLeads({}, { repos: createFixtureRepositories() })).rejects.toBeInstanceOf(auth.StaffAuthError);
  });

  it("lead listing requires a staff session (none, forged, or production-replayed cookie)", async () => {
    const repos = createFixtureRepositories();
    await expect(listLeads({}, { repos })).rejects.toBeInstanceOf(auth.StaffAuthError);

    const { token: forged } = signSessionToken({ sub: auth.FIXTURE_ADMIN_USER_ID, role: "admin" }, "x".repeat(48));
    jar.current.values.set(auth.FIXTURE_SESSION_COOKIE, forged);
    await expect(listLeads({}, { repos })).rejects.toBeInstanceOf(auth.StaffAuthError);

    const { token } = signSessionToken({ sub: auth.FIXTURE_ADMIN_USER_ID, role: "admin" }, TEST_ONLY_SESSION_SECRET);
    jar.current.values.set(auth.FIXTURE_SESSION_COOKIE, token);
    await expect(listLeads({}, { repos })).resolves.toEqual([]);
    vi.stubEnv("NODE_ENV", "production");
    await expect(listLeads({}, { repos })).rejects.toBeInstanceOf(auth.StaffAuthError);
  });
});

// ---------------------------------------------------------------------------
// M3 staff research tooling (D12/D13)
// ---------------------------------------------------------------------------
type Role = "admin" | "advisor";
const staffAs = (role: Role, userId = `staff-${role}`) => async () =>
  ({ userId, role, mode: "fixture" as const, expiresAt: null });
const OBSERVED = "2026-10-01T00:00:00.000Z";
const SOURCE = { sourceId: "sample-research-source", url: "https://example.com/sample/research", observedAt: OBSERVED };

async function newProject(repos: ReturnType<typeof createFixtureRepositories>, name = "SAMPLE M3 Test Residency") {
  const r = await research.createProject(
    { name, developerName: "SAMPLE Developer M3", localityId: "hebbal" },
    { repos, requireStaff: staffAs("admin") },
  );
  if (!r.ok) throw new Error(`createProject failed: ${r.message}`);
  return r.project;
}

async function setFacts(repos: ReturnType<typeof createFixtureRepositories>, projectId: string, role: Role = "admin") {
  const deps = { repos, requireStaff: staffAs(role) };
  const edits = [
    { field: "address", status: "known", value: "SAMPLE Research Road 9, Hebbal (fictional)" },
    { field: "reraNumbers", status: "known", value: ["SAMPLE-RERA-0777"] },
    { field: "constructionStatus", status: "known", value: "under_construction" },
  ];
  for (const e of edits) {
    const r = await research.updateFact({ projectId, sources: [SOURCE], ...e }, deps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
}

const discoverNone = async () => ({ listings: [], errors: [] });
const publicNames = async (repos: ReturnType<typeof createFixtureRepositories>, text: string) =>
  (await searchProperties({ text, lane: "researched" }, { repos, discover: discoverNone, minResearched: 0 })).researched.map((p) => p.name);

describe("M3: role and actor rules for research changes", () => {
  it("an advisor cannot publish, nor set source_confirmed / reviewed", async () => {
    const repos = createFixtureRepositories();
    const p = await newProject(repos);
    await setFacts(repos, p.id, "advisor");
    const advisor = { repos, requireStaff: staffAs("advisor") };
    for (const to of ["source_confirmed", "reviewed"]) {
      const r = await research.changeVerification(p.id, "reraNumbers", to, null, advisor);
      expect(r).toMatchObject({ ok: false, error: "forbidden" });
    }
    expect(await research.setPublished(p.id, true, advisor)).toMatchObject({ ok: false, error: "forbidden" });
    // Even a fully ready project cannot be published by an advisor.
    await research.changeVerification(p.id, "reraNumbers", "reviewed", null, { repos, requireStaff: staffAs("admin") });
    expect(await research.setPublished(p.id, true, advisor)).toMatchObject({ ok: false, error: "forbidden" });
    expect((await repos.research.getProjectByIdForStaff(p.id))!.published).toBe(false);
    // Advisors may still flag problems.
    expect((await research.changeVerification(p.id, "address", "disputed", "SAMPLE note", advisor)).ok).toBe(true);
  });

  it("automated actors ('ai', 'system') are refused for every write, even with the admin role", async () => {
    const repos = createFixtureRepositories();
    const p = await newProject(repos);
    await setFacts(repos, p.id);
    for (const id of ["ai", "system", " AI "]) {
      const deps = { repos, requireStaff: staffAs("admin", id) };
      expect(await research.createProject({ name: "SAMPLE Bot Project", developerName: "SAMPLE Dev", localityId: "hebbal" }, deps)).toMatchObject({ ok: false, error: "forbidden" });
      expect(await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "SAMPLE Bot Road (fictional)", sources: [SOURCE] }, deps)).toMatchObject({ ok: false, error: "forbidden" });
      expect(await research.changeVerification(p.id, "reraNumbers", "reviewed", null, deps)).toMatchObject({ ok: false, error: "forbidden" });
      expect(await research.setPublished(p.id, true, deps)).toMatchObject({ ok: false, error: "forbidden" });
    }
    const audit = await repos.research.listAudit(p.id);
    expect(audit.some((e) => ["ai", "system"].includes(e.actorId.trim().toLowerCase()))).toBe(false);
  });

  it("research services require a staff session", async () => {
    const repos = createFixtureRepositories();
    await expect(research.listStaffProjects({ repos })).rejects.toBeInstanceOf(auth.StaffAuthError);
    await expect(research.setPublished("sample-proj-unpublished", true, { repos })).rejects.toBeInstanceOf(auth.StaffAuthError);
  });
});

describe("M3: publish readiness and verification lifecycle", () => {
  it("publish is refused while readiness has blockers, and succeeds once they are cleared", async () => {
    const repos = createFixtureRepositories();
    const admin = { repos, requireStaff: staffAs("admin") };
    const p = await newProject(repos);
    const empty = await research.setPublished(p.id, true, admin);
    expect(empty).toMatchObject({ ok: false, error: "not_ready" });
    if (!empty.ok) expect(empty.errors?.length).toBeGreaterThan(0);

    await setFacts(repos, p.id);
    const unverified = await research.setPublished(p.id, true, admin);
    expect(unverified).toMatchObject({ ok: false, error: "not_ready" });
    if (!unverified.ok) expect(unverified.errors).toContain("reraNumbers: must be source_confirmed or reviewed");

    expect((await research.changeVerification(p.id, "reraNumbers", "reviewed", null, admin)).ok).toBe(true);
    // A disputed fact blocks again.
    await research.changeVerification(p.id, "address", "disputed", null, admin);
    expect(await research.setPublished(p.id, true, admin)).toMatchObject({ ok: false, error: "not_ready" });
    await research.changeVerification(p.id, "address", "unverified", null, admin);
    expect(await research.setPublished(p.id, true, admin)).toMatchObject({ ok: true, changed: true });
  });

  it("an edit resets verification to unverified and writes an audit event with the actor", async () => {
    const repos = createFixtureRepositories();
    const admin = { repos, requireStaff: staffAs("admin", "staff-admin-1") };
    const p = await newProject(repos);
    await setFacts(repos, p.id);
    await research.changeVerification(p.id, "reraNumbers", "reviewed", "SAMPLE checked", admin);
    expect((await repos.research.getProjectByIdForStaff(p.id))!.reraNumbers.verification).toBe("reviewed");

    const edit = await research.updateFact(
      { projectId: p.id, field: "reraNumbers", status: "known", value: ["SAMPLE-RERA-0778"], sources: [SOURCE] },
      admin,
    );
    expect(edit.ok).toBe(true);
    const after = (await repos.research.getProjectByIdForStaff(p.id))!;
    expect(after.reraNumbers).toMatchObject({ value: ["SAMPLE-RERA-0778"], verification: "unverified" });

    const audit = await repos.research.listAudit(p.id);
    const last = audit[audit.length - 1];
    expect(last).toMatchObject({
      field: "reraNumbers",
      action: "fact_set",
      fromVerification: "reviewed",
      toVerification: "unverified",
      actorId: "staff-admin-1",
      actorRole: "admin",
    });
    expect(audit.map((e) => e.action)).toEqual(["created", "fact_set", "fact_set", "fact_set", "verification_changed", "fact_set"]);
  });

  it("a fact edit without an https source is rejected and changes nothing", async () => {
    const repos = createFixtureRepositories();
    const admin = { repos, requireStaff: staffAs("admin") };
    const p = await newProject(repos);
    for (const sources of [[], [{ ...SOURCE, url: "http://example.com/sample/x" }]]) {
      const r = await research.updateFact({ projectId: p.id, field: "address", status: "known", value: "SAMPLE Road (fictional)", sources }, admin);
      expect(r).toMatchObject({ ok: false, error: "validation" });
    }
    expect((await repos.research.getProjectByIdForStaff(p.id))!.address.status).toBe("unknown");
    expect((await repos.research.listAudit(p.id)).map((e) => e.action)).toEqual(["created"]);
  });
});

describe("M3: staff-created projects and public visibility", () => {
  it("a new project is invisible to public search, detail and compare until published, then visible", async () => {
    const repos = createFixtureRepositories();
    const admin = { repos, requireStaff: staffAs("admin") };
    const p = await newProject(repos, "SAMPLE Visibility Check Towers");
    expect(p.published).toBe(false);
    await setFacts(repos, p.id);
    await research.changeVerification(p.id, "reraNumbers", "reviewed", null, admin);

    expect(await publicNames(repos, "Visibility Check")).toEqual([]);
    expect(await repos.projects.getProjectBySlug(p.slug)).toBeNull();
    const cmp = await getComparison([p.id], { repos });
    if (cmp.ok) expect(cmp.projects).toEqual([]);
    // Staff can still see it.
    expect((await research.listStaffProjects(admin)).some((s) => s.project.id === p.id)).toBe(true);

    expect((await research.setPublished(p.id, true, admin)).ok).toBe(true);
    expect(await publicNames(repos, "Visibility Check")).toEqual(["SAMPLE Visibility Check Towers"]);
    expect((await repos.projects.getProjectBySlug(p.slug))?.id).toBe(p.id);

    // D13: a later edit keeps it published but resets that fact to unverified.
    await research.updateFact({ projectId: p.id, field: "constructionStatus", status: "known", value: "completed", sources: [SOURCE] }, admin);
    const pub = (await repos.projects.getProjectBySlug(p.slug))!;
    expect(pub.constructionStatus).toMatchObject({ value: "completed", verification: "unverified" });

    expect((await research.setPublished(p.id, false, admin)).ok).toBe(true);
    expect(await publicNames(repos, "Visibility Check")).toEqual([]);
  });

  it("a Lane B listing matched by RERA to a published project carries matchedProjects under lane=external", async () => {
    const repos = createFixtureRepositories();
    const r = await searchProperties({ localityId: "hebbal", lane: "external" }, { repos });
    expect(r.researched).toEqual([]);
    const listing = r.external.find((l) => /Lakeview Residences/.test(l.title));
    expect(listing).toBeDefined();
    expect(listing!.matchedProjectId).toBe("sample-proj-lakeview");
    expect(r.matchedProjects[listing!.id]).toMatchObject({ id: "sample-proj-lakeview", slug: "sample-lakeview-residences" });
    // Name-similar but unmatched listings get no researched link.
    const residency = (await searchProperties({ text: "Residency", lane: "external" }, { repos })).external.find((l) =>
      /Lakeview Residency/.test(l.title),
    );
    expect(residency?.matchedProjectId ?? null).toBeNull();
    // Labels are unchanged by the match.
    expect(listing!.limitations[0]).toBe(discovery.NOT_VERIFIED);
  });

  it("matchedProjects never links to an unpublished project", async () => {
    const repos = createFixtureRepositories();
    const r = await searchProperties({ lane: "external", limit: 50 }, { repos });
    for (const ref of Object.values(r.matchedProjects)) expect(ref.id).not.toBe(UNPUBLISHED.id);
  });
});

describe("rate-limit key ignores spoofed X-Forwarded-For entries (TRUSTED_PROXY_HOPS=2)", () => {
  it("clientIpFromForwardedFor takes the entry two from the right", () => {
    expect(clientIpFromForwardedFor("6.6.6.6, 203.0.113.7, 10.0.0.1", 2)).toBe("203.0.113.7");
    expect(clientIpFromForwardedFor("1.2.3.4, 5.6.7.8, 203.0.113.7, 10.0.0.1", 2)).toBe("203.0.113.7");
  });

  it("submitLeadAction rate-limits by the trusted hop, whatever the client prepends", async () => {
    vi.stubEnv("TRUSTED_PROXY_HOPS", "2");
    vi.stubEnv("LEAD_RATE_LIMIT_MAX", "1");
    vi.stubEnv("LEAD_RATE_LIMIT_WINDOW_SECONDS", "600");
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("truenest.leadRateLimiter")];
    setRepositoriesForTesting(createFixtureRepositories());
    // Valid submissions only count towards the limit; a distinct email per call isolates the IP key.
    let n = 0;
    const submit = async (xff: string) => {
      reqHeaders.current = new Headers({ "x-forwarded-for": xff });
      const fd = new FormData();
      for (const [k, v] of Object.entries(validLead({ email: `xff-${++n}@example.com` }))) {
        if (v !== null && v !== false) fd.set(k, String(v));
      }
      return submitLeadAction({ status: "idle" }, fd);
    };
    try {
      expect(await submit("198.51.100.1, 203.0.113.7, 10.0.0.1")).toMatchObject({ status: "success" });
      // Same real client (trusted hop 203.0.113.7), different spoofed prefixes: still limited.
      for (const spoof of ["198.51.100.2, 203.0.113.7, 10.0.0.1", "1.1.1.1, 2.2.2.2, 203.0.113.7, 10.0.0.1"]) {
        expect(await submit(spoof)).toMatchObject({ status: "error", reason: "rate_limited" });
      }
      // A different real client has its own bucket, even with the same spoofed prefix.
      expect(await submit("198.51.100.1, 203.0.113.8, 10.0.0.1")).toMatchObject({ status: "success" });
    } finally {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("truenest.leadRateLimiter")];
      setRepositoriesForTesting(undefined);
    }
  });
});
