import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, hasStaffSessionCookie, STAFF_SESSION_COOKIE, config } from "@/proxy";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));

function req(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"), cookie ? { headers: { cookie } } : undefined);
}

describe("src/proxy.ts (fast-path admin guard)", () => {
  it("redirects /admin paths without a session cookie to login with next", () => {
    const res = proxy(req("/admin/leads?status=new"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/admin/login");
    expect(loc.searchParams.get("next")).toBe("/admin/leads?status=new");
    expect(proxy(req("/admin")).status).toBe(307);
  });

  it("lets the login page through", () => {
    expect(proxy(req("/admin/login")).headers.get("location")).toBeNull();
  });

  it("lets requests with a fixture or Supabase session cookie through (pages still verify)", () => {
    expect(proxy(req("/admin/leads", `${STAFF_SESSION_COOKIE}=anything`)).headers.get("location")).toBeNull();
    expect(proxy(req("/admin/leads", "sb-abcd-auth-token.0=x")).headers.get("location")).toBeNull();
    expect(hasStaffSessionCookie(["sb-abcd-auth-token-code-verifier"])).toBe(false);
    expect(hasStaffSessionCookie(["other"])).toBe(false);
  });

  it("matches only admin paths and uses the same cookie name as auth.ts", async () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
    const { FIXTURE_SESSION_COOKIE } = await import("./auth");
    expect(STAFF_SESSION_COOKIE).toBe(FIXTURE_SESSION_COOKIE);
  });
});
