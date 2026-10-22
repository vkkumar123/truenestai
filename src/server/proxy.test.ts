import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({}), headers: async () => new Headers() }));

// Fake @supabase/ssr: getUser() "refreshes" by calling setAll, then reports a user or not.
const ssr = vi.hoisted(() => ({ user: true as boolean | "throw", refresh: true, calls: 0 }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, opts: { cookies: { setAll: (c: unknown[], h: Record<string, string>) => void } }) => ({
    auth: {
      getUser: async () => {
        ssr.calls++;
        if (ssr.user === "throw") throw new Error("network");
        if (ssr.refresh) {
          opts.cookies.setAll([{ name: "sb-ref-auth-token", value: "rotated", options: { path: "/", httpOnly: true } }], {
            "Cache-Control": "private, no-cache, no-store",
          });
        }
        return ssr.user ? { data: { user: { id: "u1" } }, error: null } : { data: { user: null }, error: { status: 400 } };
      },
    },
  }),
}));

const { handleAdminRequest: proxy, proxy: nextProxy, hasStaffSessionCookie, STAFF_SESSION_COOKIE, config } = await import("@/proxy");

function req(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"), cookie ? { headers: { cookie } } : undefined);
}
const FIXTURE_ENV = { DATA_BACKEND: "fixture" } as unknown as NodeJS.ProcessEnv;
const SUPA_ENV = { DATA_BACKEND: "supabase", SUPABASE_URL: "https://example.supabase.co", SUPABASE_ANON_KEY: "anon-test" } as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  ssr.user = true;
  ssr.refresh = true;
  ssr.calls = 0;
});

describe("src/proxy.ts (fast-path admin guard)", () => {
  it("redirects /admin paths without a session cookie to login with next", async () => {
    const res = await proxy(req("/admin/leads?status=new"), FIXTURE_ENV);
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/admin/login");
    expect(loc.searchParams.get("next")).toBe("/admin/leads?status=new");
    expect((await proxy(req("/admin"), FIXTURE_ENV)).status).toBe(307);
  });

  it("lets the login page through", async () => {
    expect((await proxy(req("/admin/login"), FIXTURE_ENV)).headers.get("location")).toBeNull();
  });

  it("lets requests with a fixture or Supabase session cookie through (pages still verify)", async () => {
    expect((await proxy(req("/admin/leads", `${STAFF_SESSION_COOKIE}=anything`), FIXTURE_ENV)).headers.get("location")).toBeNull();
    expect((await proxy(req("/admin/leads", "sb-abcd-auth-token.0=x"), FIXTURE_ENV)).headers.get("location")).toBeNull();
    expect(hasStaffSessionCookie(["sb-abcd-auth-token-code-verifier"])).toBe(false);
    expect(hasStaffSessionCookie(["other"])).toBe(false);
    expect(ssr.calls).toBe(0); // fixture mode never calls Supabase
  });

  it("matches only admin paths and uses the same cookie name as auth.ts", async () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
    expect(nextProxy.length).toBe(1); // Next passes (request, event): env must not be a parameter
    const { FIXTURE_SESSION_COOKIE } = await import("./auth");
    expect(STAFF_SESSION_COOKIE).toBe(FIXTURE_SESSION_COOKIE);
  });
});

describe("src/proxy.ts (Supabase session refresh)", () => {
  it("refreshes the session and writes rotated cookies + no-store headers to the response", async () => {
    const res = await proxy(req("/admin/leads", "sb-ref-auth-token=old"), SUPA_ENV);
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-ref-auth-token")?.value).toBe("rotated");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    // forwarded to the page render as an overridden request cookie
    expect(res.headers.get("x-middleware-request-cookie") ?? res.headers.get("x-middleware-override-headers")).toBeTruthy();
    expect(ssr.calls).toBe(1);
  });

  it("redirects to login when Supabase Auth reports no user", async () => {
    ssr.user = false;
    ssr.refresh = false;
    const res = await proxy(req("/admin/projects", "sb-ref-auth-token=expired"), SUPA_ENV);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe("/admin/projects");
  });

  it("falls through to the page when Supabase is unreachable", async () => {
    ssr.user = "throw";
    const res = await proxy(req("/admin/leads", "sb-ref-auth-token=x"), SUPA_ENV);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not call Supabase for the fixture cookie only, and refreshes on the login page", async () => {
    await proxy(req("/admin/leads", `${STAFF_SESSION_COOKIE}=x`), SUPA_ENV);
    expect(ssr.calls).toBe(0);
    const login = await proxy(req("/admin/login", "sb-ref-auth-token=x"), SUPA_ENV);
    expect(login.headers.get("location")).toBeNull();
    expect(ssr.calls).toBe(1);
  });
});
