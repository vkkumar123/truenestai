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

describe("login throttle (L2)", async () => {
  const { createLoginLimiters, isLoginThrottled, recordLoginFailure, EMAIL_LIMIT_FACTOR } = await import("./services/login-throttle");
  const { loginRateLimit } = await import("./env");

  it("counts only failures, per IP, and resets after the window", () => {
    const l = createLoginLimiters(3, 1000);
    const k = { ipKey: "1.2.3.4", now: 0 };
    for (let i = 0; i < 10; i++) expect(isLoginThrottled(k, l)).toBe(false); // checks alone never count
    for (let i = 0; i < 3; i++) recordLoginFailure(k, l);
    expect(isLoginThrottled(k, l)).toBe(true);
    expect(isLoginThrottled({ ipKey: "5.6.7.8", now: 0 }, l)).toBe(false);
    expect(isLoginThrottled({ ...k, now: 1001 }, l)).toBe(false);
  });

  it("the per-email key has a higher limit than the IP key (case-insensitive)", () => {
    const l = createLoginLimiters(2, 1000);
    const total = 2 * EMAIL_LIMIT_FACTOR;
    for (let i = 0; i < total - 1; i++) recordLoginFailure({ ipKey: `ip-${i}`, email: i % 2 ? "Staff@Example.com" : "staff@example.com ", now: 0 }, l);
    expect(isLoginThrottled({ ipKey: "fresh", email: "staff@example.com", now: 0 }, l)).toBe(false);
    recordLoginFailure({ ipKey: "another", email: "staff@example.com", now: 0 }, l);
    expect(isLoginThrottled({ ipKey: "fresh", email: "STAFF@example.com", now: 0 }, l)).toBe(true);
    expect(isLoginThrottled({ ipKey: "fresh", email: "other@example.com", now: 0 }, l)).toBe(false);
  });

  it("reads LOGIN_MAX_ATTEMPTS / LOGIN_WINDOW_SECONDS with defaults 10 / 900", () => {
    expect(loginRateLimit({} as NodeJS.ProcessEnv)).toEqual({ max: 10, windowMs: 900_000 });
    expect(loginRateLimit({ LOGIN_MAX_ATTEMPTS: "4", LOGIN_WINDOW_SECONDS: "60" } as unknown as NodeJS.ProcessEnv)).toEqual({ max: 4, windowMs: 60_000 });
    expect(() => loginRateLimit({ LOGIN_MAX_ATTEMPTS: "0" } as unknown as NodeJS.ProcessEnv)).toThrow();
  });
});
