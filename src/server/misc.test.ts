import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { safeAdminPath, DEFAULT_ADMIN_HOME } = await import("./redirects");
const { getStaffSession } = await import("./auth");
const { hasSampleData } = await import("./services/projects");
const { createFixtureRepositories, FixtureProjectRepository, SAMPLE_PROJECTS } = await import("./repositories/fixture");
const { formatInr } = await import("@/domain/format");
const { bhkMatches } = await import("@/domain/search-options");

afterEach(() => vi.unstubAllEnvs());

describe("safeAdminPath", () => {
  it.each([
    ["/admin/leads?status=new", "/admin/leads?status=new"],
    ["/admin", "/admin"],
    ["/admin/leads/abc", "/admin/leads/abc"],
  ])("keeps %s", (input, out) => expect(safeAdminPath(input)).toBe(out));

  it.each([
    "https://evil.example/admin",
    "//evil.example/admin",
    "/\\evil.example/admin",
    "/admin/../evil",
    "/administrator",
    "/admin//x",
    "/admin/login",
    "javascript:alert(1)",
    "",
    null,
    "/",
  ])("rejects %s", (input) => expect(safeAdminPath(input as string | null)).toBe(DEFAULT_ADMIN_HOME));
});

describe("getStaffSession", () => {
  it("returns null (and does not throw) on configuration errors", async () => {
    vi.stubEnv("DATA_BACKEND", "nonsense");
    await expect(getStaffSession()).resolves.toBeNull();
    vi.stubEnv("DATA_BACKEND", "supabase");
    vi.stubEnv("SUPABASE_URL", "");
    await expect(getStaffSession()).resolves.toBeNull();
    vi.stubEnv("DATA_BACKEND", "fixture");
    vi.stubEnv("SESSION_SECRET", "short");
    await expect(getStaffSession()).resolves.toBeNull();
  });
});

describe("hasSampleData", () => {
  it("is true for the fixture backend and false without published samples", async () => {
    expect(await hasSampleData({ repos: createFixtureRepositories() })).toBe(true);
    const repos = { ...createFixtureRepositories(), projects: new FixtureProjectRepository(SAMPLE_PROJECTS.filter((p) => !p.published)) };
    expect(await hasSampleData({ repos })).toBe(false);
  });
});

describe("domain helpers", () => {
  it("formats INR", () => {
    expect(formatInr(15000000)).toBe("₹1.50 Cr");
    expect(formatInr(8500000)).toBe("₹85.0 L");
  });
  it("matches BHK labels", () => {
    expect(bhkMatches("2 BHK", "2")).toBe(true);
    expect(bhkMatches("3BHK + study", "3")).toBe(true);
    expect(bhkMatches("6 BHK", "5+")).toBe(true);
    expect(bhkMatches("Plot", "1")).toBe(false);
    expect(bhkMatches("12 BHK", "1")).toBe(false);
  });
});
