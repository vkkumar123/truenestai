// Cross-module regression tests for TrueNest critical controls.
// Module-level behaviour is covered next to each module (src/**/*.test.ts); these tests pin the
// guarantees that only hold when several modules work together (search + discovery + registry,
// lead validation + lead service + repository, auth + lead service).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCookieJar } from "../../src/server/__tests__/cookie-mock";

vi.mock("server-only", () => ({}));
const jar = { current: createCookieJar() };
vi.mock("next/headers", () => ({
  cookies: async () => jar.current.store,
  headers: async () => new Headers(),
}));

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
