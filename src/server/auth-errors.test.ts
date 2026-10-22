import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const cookiesImpl = { current: async (): Promise<unknown> => ({ get: () => undefined, getAll: () => [] }) };
vi.mock("next/headers", () => ({
  cookies: () => cookiesImpl.current(),
  headers: async () => new Headers(),
}));

const { getStaffSession, requireStaff, StaffAuthError } = await import("./auth");
const { redirect, notFound } = await import("next/navigation");
const { AuthError } = await import("@supabase/supabase-js");

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DATA_BACKEND", "fixture");
  vi.stubEnv("SESSION_SECRET", "s".repeat(40));
});
afterEach(() => {
  vi.unstubAllEnvs();
  cookiesImpl.current = async () => ({ get: () => undefined, getAll: () => [] });
});

const caught = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("getStaffSession error handling", () => {
  it("re-throws Next.js redirect/notFound signals instead of reporting 'signed out'", async () => {
    cookiesImpl.current = async () => redirect("/elsewhere");
    const r = await caught(getStaffSession());
    expect((r as { digest?: string }).digest).toMatch(/^NEXT_REDIRECT/);
    cookiesImpl.current = async () => notFound();
    const n = await caught(getStaffSession());
    expect((n as { digest?: string }).digest).toMatch(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it("re-throws unexpected errors (e.g. Next InvariantError from cookies()) rather than denying silently", async () => {
    class InvariantError extends Error {
      name = "InvariantError";
    }
    cookiesImpl.current = async () => {
      throw new InvariantError("Received an underlying cookies object that does not match");
    };
    await expect(getStaffSession()).rejects.toThrow(/underlying cookies object/);
    // requireStaff surfaces it too (not converted into StaffAuthError → login redirect)
    const e = await caught(requireStaff());
    expect(e).not.toBeInstanceOf(StaffAuthError);
  });

  it("still returns null for configuration errors and Supabase auth errors", async () => {
    vi.stubEnv("SESSION_SECRET", "short");
    await expect(getStaffSession()).resolves.toBeNull();
    vi.stubEnv("SESSION_SECRET", "s".repeat(40));
    cookiesImpl.current = async () => {
      throw new AuthError("session expired", 401);
    };
    await expect(getStaffSession()).resolves.toBeNull();
  });

  it("returns null with no cookie (plain signed-out case)", async () => {
    await expect(getStaffSession()).resolves.toBeNull();
    await expect(requireStaff()).rejects.toBeInstanceOf(StaffAuthError);
  });
});
