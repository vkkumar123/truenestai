import "server-only";
import { loginRateLimit } from "../env";
import { FixedWindowRateLimiter } from "./rate-limit";

// L2 staff sign-in throttle. DEV-GRADE and PER INSTANCE: counters live in this server process's
// memory (reset on restart, not shared between instances/serverless workers), so production also
// relies on Supabase Auth's own rate limits and edge/WAF limits.
// Only FAILED attempts count. Limits (env, defaults): LOGIN_MAX_ATTEMPTS=10 failures per client IP
// per LOGIN_WINDOW_SECONDS=900; per email (Supabase mode) EMAIL_LIMIT_FACTOR × that, so a single
// attacker IP is stopped first and a distributed guess against one account is still bounded,
// while locking a staff member out takes many IPs.

export const EMAIL_LIMIT_FACTOR = 5;
export const LOGIN_THROTTLED_MESSAGE = "Too many failed sign-in attempts. Please wait and try again later.";

export interface LoginLimiters {
  ip: FixedWindowRateLimiter;
  email: FixedWindowRateLimiter;
}

const KEY = Symbol.for("truenest.loginLimiters");
type G = typeof globalThis & { [KEY]?: LoginLimiters };

export function createLoginLimiters(max: number, windowMs: number): LoginLimiters {
  return { ip: new FixedWindowRateLimiter(max, windowMs), email: new FixedWindowRateLimiter(max * EMAIL_LIMIT_FACTOR, windowMs) };
}

/** Process-wide limiters (keys are hashed; no raw IPs or emails are held). */
export function loginLimiters(): LoginLimiters {
  const g = globalThis as G;
  if (!g[KEY]) {
    const { max, windowMs } = loginRateLimit();
    g[KEY] = createLoginLimiters(max, windowMs);
  }
  return g[KEY]!;
}

export interface LoginAttemptKey {
  ipKey: string;
  email?: string | null;
  now?: number;
}

const emailKey = (email: string) => `login:email:${email.trim().toLowerCase()}`;

/** Checked BEFORE credentials; records nothing. */
export function isLoginThrottled(k: LoginAttemptKey, limiters: LoginLimiters = loginLimiters()): boolean {
  const at = k.now ?? Date.now();
  if (limiters.ip.isBlocked(`login:ip:${k.ipKey}`, at)) return true;
  return !!k.email && limiters.email.isBlocked(emailKey(k.email), at);
}

/** Call only after a failed credential check. */
export function recordLoginFailure(k: LoginAttemptKey, limiters: LoginLimiters = loginLimiters()): void {
  const at = k.now ?? Date.now();
  limiters.ip.hit(`login:ip:${k.ipKey}`, at);
  if (k.email) limiters.email.hit(emailKey(k.email), at);
}
