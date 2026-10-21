import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { adminDevPassword, ConfigError, dataBackend, isProduction, sessionSecret, supabaseEnv } from "./env";
import { log } from "./log";
import { constantTimeEqual, SESSION_TTL_SECONDS, signSessionToken, verifySessionToken } from "./session-token";

export type StaffRole = "advisor" | "admin";

export interface StaffSession {
  userId: string;
  role: StaffRole;
  mode: "fixture" | "supabase";
  expiresAt: string | null; // ISO; null when managed by Supabase Auth
}

export type StaffAuthErrorCode = "unauthenticated" | "forbidden" | "misconfigured";

/**
 * Thrown by requireStaff(). It is a plain Error (not a Next redirect/notFound signal), so callers
 * decide: pages typically `redirect("/admin/login")`, actions return a typed error.
 */
export class StaffAuthError extends Error {
  constructor(
    readonly code: StaffAuthErrorCode,
    message = code === "forbidden" ? "Staff access required." : "Please sign in.",
  ) {
    super(message);
    this.name = "StaffAuthError";
  }
}

export function isStaffAuthError(e: unknown): e is StaffAuthError {
  return e instanceof StaffAuthError;
}

export const FIXTURE_SESSION_COOKIE = "tn_staff_session";
export const FIXTURE_ADMIN_USER_ID = "fixture-dev-admin";

/** The dev-only password login is refused outright in production builds/servers. */
export function fixtureAdminAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProduction(env) && dataBackend(env) === "fixture";
}

// ---------------------------------------------------------------------------
// Supabase mode
// ---------------------------------------------------------------------------
async function supabaseServerClient() {
  const env = supabaseEnv();
  const store = await cookies();
  return createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Called from a Server Component: cookies are read-only there. Token refresh must be
          // handled by the proxy/middleware (see docs/DATA_MODEL.md, "Auth").
        }
      },
    },
  });
}

async function getSupabaseStaffSession(): Promise<StaffSession | null> {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.getUser(); // verified with the Auth server
  if (error || !data.user) return null;
  // RLS: a user may read only their own staff_profiles row.
  const profile = await supabase.from("staff_profiles").select("role").eq("user_id", data.user.id).maybeSingle();
  const role = profile.data?.role;
  if (profile.error || (role !== "advisor" && role !== "admin")) return null;
  return { userId: data.user.id, role, mode: "supabase", expiresAt: null };
}

// ---------------------------------------------------------------------------
// Fixture (dev-only) mode
// ---------------------------------------------------------------------------
async function getFixtureStaffSession(now: Date): Promise<StaffSession | null> {
  if (!fixtureAdminAllowed()) return null;
  let secret: string;
  try {
    secret = sessionSecret();
  } catch {
    return null;
  }
  const token = (await cookies()).get(FIXTURE_SESSION_COOKIE)?.value;
  const payload = verifySessionToken(token, secret, now);
  if (!payload) return null;
  return { userId: payload.sub, role: payload.role, mode: "fixture", expiresAt: new Date(payload.exp * 1000).toISOString() };
}

/** Current staff session, or null. Never throws for a missing/invalid session. */
export async function getStaffSession(now: Date = new Date()): Promise<StaffSession | null> {
  return dataBackend() === "supabase" ? getSupabaseStaffSession() : getFixtureStaffSession(now);
}

/** Resolves to the staff session or throws StaffAuthError("unauthenticated"). */
export async function requireStaff(): Promise<StaffSession> {
  const session = await getStaffSession();
  if (!session) throw new StaffAuthError("unauthenticated");
  return session;
}

export type StaffLoginResult =
  | { ok: true; session: StaffSession }
  | { ok: false; error: "invalid_credentials" | "not_staff" | "disabled" | "misconfigured"; message: string };

const INVALID = { ok: false, error: "invalid_credentials", message: "Incorrect sign-in details." } as const;

/**
 * DEV-ONLY admin login for fixture mode. Refused when NODE_ENV === "production".
 * Requires ADMIN_DEV_PASSWORD (>= 12 chars) and SESSION_SECRET (>= 32 chars).
 */
export async function loginWithDevPassword(password: string, now: Date = new Date()): Promise<StaffLoginResult> {
  if (isProduction()) {
    log.warn("auth.fixture_login_refused_production");
    return { ok: false, error: "disabled", message: "Development sign-in is disabled in production." };
  }
  if (dataBackend() !== "fixture") {
    return { ok: false, error: "disabled", message: "Development sign-in is only available in fixture mode." };
  }
  let expected: string;
  let secret: string;
  try {
    expected = adminDevPassword();
    secret = sessionSecret();
  } catch (e) {
    log.error("auth.fixture_login_misconfigured", { reason: e instanceof ConfigError ? e.message : "config" });
    return { ok: false, error: "misconfigured", message: "Sign-in is not configured on this server." };
  }
  if (typeof password !== "string" || password.length > 512 || !constantTimeEqual(password, expected)) {
    log.warn("auth.fixture_login_failed");
    return INVALID;
  }
  const { token, payload } = signSessionToken({ sub: FIXTURE_ADMIN_USER_ID, role: "admin" }, secret, now);
  (await cookies()).set(FIXTURE_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(), // always false here (production refused above); kept explicit
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  log.info("auth.fixture_login_ok");
  return {
    ok: true,
    session: { userId: payload.sub, role: payload.role, mode: "fixture", expiresAt: new Date(payload.exp * 1000).toISOString() },
  };
}

/** Supabase-mode staff login (email + password via Supabase Auth), then staff_profiles check. */
export async function loginWithSupabasePassword(email: string, password: string): Promise<StaffLoginResult> {
  const supabase = await supabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return INVALID;
  const profile = await supabase.from("staff_profiles").select("role").eq("user_id", data.user.id).maybeSingle();
  const role = profile.data?.role;
  if (role !== "advisor" && role !== "admin") {
    await supabase.auth.signOut();
    return { ok: false, error: "not_staff", message: "This account does not have staff access." };
  }
  return { ok: true, session: { userId: data.user.id, role, mode: "supabase", expiresAt: null } };
}

export async function logoutStaff(): Promise<void> {
  if (dataBackend() === "supabase") {
    const supabase = await supabaseServerClient();
    await supabase.auth.signOut();
    return;
  }
  (await cookies()).delete(FIXTURE_SESSION_COOKIE);
}
