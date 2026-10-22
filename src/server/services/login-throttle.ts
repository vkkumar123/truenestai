import "server-only";
import { FixedWindowRateLimiter } from "./rate-limit";

/** Staff sign-in attempts allowed per client key (and per email) per window. */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_THROTTLED_MESSAGE = "Too many sign-in attempts. Please wait 15 minutes and try again.";

const KEY = Symbol.for("truenest.loginLimiter");
type G = typeof globalThis & { [KEY]?: FixedWindowRateLimiter };

/** Process-wide DEV-GRADE limiter (see rate-limit.ts caveats); keys are hashed. */
export function loginLimiter(): FixedWindowRateLimiter {
  const g = globalThis as G;
  return (g[KEY] ??= new FixedWindowRateLimiter(LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS));
}

/**
 * L2: counts one sign-in attempt per client key and (Supabase mode) per normalised email, before
 * any credential check, so password guessing against the dev password or a staff account is
 * bounded per instance. Returns false when any key is over the limit.
 */
export function allowLoginAttempt(
  input: { ipKey: string; email?: string | null; now?: number },
  limiter: FixedWindowRateLimiter = loginLimiter(),
): boolean {
  const at = input.now ?? Date.now();
  const keys = [`login:ip:${input.ipKey}`];
  if (input.email) keys.push(`login:email:${input.email.trim().toLowerCase()}`);
  // Hit every key (no short-circuit) so a blocked IP still counts against the email and vice versa.
  return keys.map((k) => limiter.hit(k, at).allowed).every(Boolean);
}
