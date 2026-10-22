// Proxy for staff pages (Next 16 `proxy.ts`, Node runtime). NOT a security boundary: every
// /admin page and staff action still verifies the session server-side (getStaffSession /
// requireStaff in src/server/auth.ts). It does two things:
//   1. Fast path: no staff session cookie at all → 307 to /admin/login?next=…
//   2. Supabase mode (DATA_BACKEND=supabase): refreshes the Supabase Auth session per
//      @supabase/ssr — `auth.getUser()` rotates an expired access token and the new cookies are
//      written to BOTH the forwarded request (so Server Components see them) and the response.
//      Server Components cannot write cookies, so without this a session expires after ~1 hour.
// Kept free of server modules and globals (reads process.env directly), as Next recommends.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Must equal FIXTURE_SESSION_COOKIE in src/server/auth.ts (asserted by a unit test). */
export const STAFF_SESSION_COOKIE = "tn_staff_session";
export const ADMIN_LOGIN_PATH = "/admin/login";

/** Supabase SSR auth cookies: "sb-<ref>-auth-token" (optionally chunked: ".0", ".1", ...). */
const SUPABASE_AUTH_COOKIE = /^sb-[A-Za-z0-9-]+-auth-token(\.\d+)?$/;

export function hasStaffSessionCookie(names: string[]): boolean {
  return names.some((n) => n === STAFF_SESSION_COOKIE || SUPABASE_AUTH_COOKIE.test(n));
}

export function hasSupabaseAuthCookie(names: string[]): boolean {
  return names.some((n) => SUPABASE_AUTH_COOKIE.test(n));
}

export function isAdminLoginPath(pathname: string): boolean {
  return pathname === ADMIN_LOGIN_PATH || pathname === `${ADMIN_LOGIN_PATH}/`;
}

function loginRedirect(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const url = request.nextUrl.clone();
  url.pathname = ADMIN_LOGIN_PATH;
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url, 307);
}

/** Supabase URL + anon key when the app runs in Supabase mode, else null. Never logged. */
function supabaseConfig(env: NodeJS.ProcessEnv): { url: string; anonKey: string } | null {
  if (env.DATA_BACKEND?.trim() !== "supabase") return null;
  const url = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

/**
 * Refreshes the Supabase session. Returns the response to send (carrying refreshed cookies) and
 * whether Supabase Auth confirmed a user. Failures (network, misconfig) fall through to the page,
 * which verifies again and redirects as needed.
 */
async function refreshSupabaseSession(
  request: NextRequest,
  cfg: { url: string; anonKey: string },
): Promise<{ response: NextResponse; hasUser: boolean | null }> {
  let response = NextResponse.next({ request });
  try {
    const supabase = createServerClient(cfg.url, cfg.anonKey, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet, headers) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
          for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
        },
      },
    });
    // getUser() validates with the Auth server and refreshes an expired token (→ setAll).
    const { data, error } = await supabase.auth.getUser();
    if (error && error.status !== undefined && error.status >= 500) return { response, hasUser: null };
    return { response, hasUser: !!data?.user };
  } catch {
    return { response, hasUser: null };
  }
}

/** Testable core (explicit env). Next calls `proxy(request, event)`, so env is not a parameter there. */
export async function handleAdminRequest(request: NextRequest, env: NodeJS.ProcessEnv): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/admin")) return NextResponse.next();
  const names = request.cookies.getAll().map((c) => c.name);
  const cfg = supabaseConfig(env);

  if (isAdminLoginPath(pathname)) {
    // Keep a live Supabase session fresh on the login page too (it redirects signed-in staff).
    return cfg && hasSupabaseAuthCookie(names) ? (await refreshSupabaseSession(request, cfg)).response : NextResponse.next();
  }
  if (!hasStaffSessionCookie(names)) return loginRedirect(request);
  if (!cfg || !hasSupabaseAuthCookie(names)) return NextResponse.next();

  const { response, hasUser } = await refreshSupabaseSession(request, cfg);
  // Definitively signed out (expired refresh token, revoked): send to login early.
  if (hasUser === false) return loginRedirect(request);
  return response;
}

export function proxy(request: NextRequest): Promise<NextResponse> {
  return handleAdminRequest(request, process.env);
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
