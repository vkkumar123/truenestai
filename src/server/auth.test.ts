import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCookieJar } from "./__tests__/cookie-mock";

vi.mock("server-only", () => ({}));
const jar = { current: createCookieJar() };
vi.mock("next/headers", () => ({
  cookies: async () => jar.current.store,
  headers: async () => new Headers(),
}));

const { signSessionToken, verifySessionToken, constantTimeEqual, SESSION_TTL_SECONDS } = await import("./session-token");
const auth = await import("./auth");

const SECRET = "s".repeat(40);
const PASSWORD = "correct-horse-battery";

beforeEach(() => {
  jar.current = createCookieJar();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATA_BACKEND", "fixture");
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("ADMIN_DEV_PASSWORD", PASSWORD);
  vi.stubEnv("ADMIN_DEV_ADVISOR_PASSWORD", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("session token", () => {
  it("round-trips a valid token", () => {
    const { token } = signSessionToken({ sub: "u1", role: "admin" }, SECRET);
    expect(verifySessionToken(token, SECRET)).toMatchObject({ sub: "u1", role: "admin" });
  });

  it("rejects a tampered payload", () => {
    const { token } = signSessionToken({ sub: "u1", role: "advisor" }, SECRET);
    const [v, , sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "u1", role: "admin", iat: 0, exp: 9e9 })).toString("base64url");
    expect(verifySessionToken(`${v}.${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects a tampered signature and a wrong secret", () => {
    const { token } = signSessionToken({ sub: "u1", role: "admin" }, SECRET);
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(verifySessionToken(flipped, SECRET)).toBeNull();
    expect(verifySessionToken(token, "x".repeat(40))).toBeNull();
    expect(verifySessionToken("garbage", SECRET)).toBeNull();
    expect(verifySessionToken(undefined, SECRET)).toBeNull();
  });

  it("rejects an expired token (8h TTL)", () => {
    const issued = new Date("2026-10-21T00:00:00Z");
    const { token } = signSessionToken({ sub: "u1", role: "admin" }, SECRET, issued);
    expect(verifySessionToken(token, SECRET, new Date(issued.getTime() + (SESSION_TTL_SECONDS - 1) * 1000))).not.toBeNull();
    expect(verifySessionToken(token, SECRET, new Date(issued.getTime() + SESSION_TTL_SECONDS * 1000))).toBeNull();
  });

  it("compares strings in constant time semantics", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("fixture admin login", () => {
  it("is refused when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const r = await auth.loginWithDevPassword(PASSWORD);
    expect(r).toMatchObject({ ok: false, error: "disabled" });
    expect(jar.current.sets).toHaveLength(0);
    expect(auth.fixtureAdminAllowed()).toBe(false);
  });

  it("does not honour an otherwise valid cookie in production", async () => {
    const { token } = signSessionToken({ sub: auth.FIXTURE_ADMIN_USER_ID, role: "admin" }, SECRET);
    jar.current.values.set(auth.FIXTURE_SESSION_COOKIE, token);
    expect(await auth.getStaffSession()).not.toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(await auth.getStaffSession()).toBeNull();
    await expect(auth.requireStaff()).rejects.toBeInstanceOf(auth.StaffAuthError);
  });

  it("rejects a wrong password without setting a cookie", async () => {
    const r = await auth.loginWithDevPassword("wrong-password-123");
    expect(r).toMatchObject({ ok: false, error: "invalid_credentials" });
    expect(jar.current.sets).toHaveLength(0);
  });

  it("refuses to run with a short ADMIN_DEV_PASSWORD or SESSION_SECRET", async () => {
    vi.stubEnv("ADMIN_DEV_PASSWORD", "short");
    expect(await auth.loginWithDevPassword("short")).toMatchObject({ ok: false, error: "misconfigured" });
    vi.stubEnv("ADMIN_DEV_PASSWORD", PASSWORD);
    vi.stubEnv("SESSION_SECRET", "too-short");
    expect(await auth.loginWithDevPassword(PASSWORD)).toMatchObject({ ok: false, error: "misconfigured" });
  });

  it("sets an httpOnly, sameSite=lax, 8h signed cookie and yields a staff session", async () => {
    const r = await auth.loginWithDevPassword(PASSWORD);
    expect(r.ok).toBe(true);
    const set = jar.current.sets[0];
    expect(set.name).toBe(auth.FIXTURE_SESSION_COOKIE);
    expect(set.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 8 * 3600 });
    const session = await auth.requireStaff();
    expect(session).toMatchObject({ userId: auth.FIXTURE_ADMIN_USER_ID, role: "admin", mode: "fixture" });
  });

  it("optional advisor password signs in as a distinct advisor user", async () => {
    vi.stubEnv("ADMIN_DEV_ADVISOR_PASSWORD", "advisor-password-xyz");
    const r = await auth.loginWithDevPassword("advisor-password-xyz");
    expect(r).toMatchObject({ ok: true, session: { userId: auth.FIXTURE_ADVISOR_USER_ID, role: "advisor" } });
    expect(await auth.requireStaff()).toMatchObject({ role: "advisor", userId: "fixture-dev-advisor" });
    jar.current = createCookieJar();
    expect(await auth.loginWithDevPassword(PASSWORD)).toMatchObject({ ok: true, session: { role: "admin" } });
  });

  it("advisor login is unavailable when unset and refused when invalid or in production", async () => {
    expect(await auth.loginWithDevPassword("advisor-password-xyz")).toMatchObject({ ok: false, error: "invalid_credentials" });
    vi.stubEnv("ADMIN_DEV_ADVISOR_PASSWORD", "short");
    expect(await auth.loginWithDevPassword(PASSWORD)).toMatchObject({ ok: false, error: "misconfigured" });
    vi.stubEnv("ADMIN_DEV_ADVISOR_PASSWORD", PASSWORD);
    expect(await auth.loginWithDevPassword(PASSWORD)).toMatchObject({ ok: false, error: "misconfigured" });
    vi.stubEnv("ADMIN_DEV_ADVISOR_PASSWORD", "advisor-password-xyz");
    vi.stubEnv("NODE_ENV", "production");
    expect(await auth.loginWithDevPassword("advisor-password-xyz")).toMatchObject({ ok: false, error: "disabled" });
  });

  it("rejects a tampered session cookie", async () => {
    await auth.loginWithDevPassword(PASSWORD);
    const token = jar.current.values.get(auth.FIXTURE_SESSION_COOKIE)!;
    for (const pos of [token.length - 1, token.length - 10, 5]) {
      const c = token[pos] === "A" ? "B" : "A";
      jar.current.values.set(auth.FIXTURE_SESSION_COOKIE, token.slice(0, pos) + c + token.slice(pos + 1));
      expect(await auth.getStaffSession()).toBeNull();
    }
  });

  it("logout clears the session", async () => {
    await auth.loginWithDevPassword(PASSWORD);
    await auth.logoutStaff();
    expect(await auth.getStaffSession()).toBeNull();
  });
});

describe("backend selection", () => {
  it("throws a clear error when supabase is selected without env", async () => {
    vi.stubEnv("DATA_BACKEND", "supabase");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_ANON_KEY", "");
    const { getRepositories, setRepositoriesForTesting } = await import("./repositories");
    setRepositoriesForTesting(undefined);
    expect(() => getRepositories()).toThrow(/DATA_BACKEND=supabase requires SUPABASE_URL/);
  });

  it("rejects an unknown DATA_BACKEND", async () => {
    vi.stubEnv("DATA_BACKEND", "mysql");
    const { getRepositories } = await import("./repositories");
    expect(() => getRepositories()).toThrow(/DATA_BACKEND must be/);
  });
});
