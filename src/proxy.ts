// Fast-path guard for staff pages. NOT a security boundary: it only checks that a staff
// session cookie is PRESENT and redirects early if not. Every /admin page and staff action
// must still verify the session server-side (getStaffSession / requireStaff in src/server/auth.ts).
// Kept dependency-free (no server modules, no globals) as recommended for Next 16 Proxy.
import { NextResponse, type NextRequest } from "next/server";

/** Must equal FIXTURE_SESSION_COOKIE in src/server/auth.ts (asserted by a unit test). */
export const STAFF_SESSION_COOKIE = "tn_staff_session";
export const ADMIN_LOGIN_PATH = "/admin/login";

/** Supabase SSR auth cookies: "sb-<ref>-auth-token" (optionally chunked: ".0", ".1", ...). */
const SUPABASE_AUTH_COOKIE = /^sb-[A-Za-z0-9-]+-auth-token(\.\d+)?$/;

export function hasStaffSessionCookie(names: string[]): boolean {
  return names.some((n) => n === STAFF_SESSION_COOKIE || SUPABASE_AUTH_COOKIE.test(n));
}

export function isAdminLoginPath(pathname: string): boolean {
  return pathname === ADMIN_LOGIN_PATH || pathname === `${ADMIN_LOGIN_PATH}/`;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (!pathname.startsWith("/admin") || isAdminLoginPath(pathname)) return NextResponse.next();
  if (hasStaffSessionCookie(request.cookies.getAll().map((c) => c.name))) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = ADMIN_LOGIN_PATH;
  url.search = "";
  url.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(url, 307);
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
