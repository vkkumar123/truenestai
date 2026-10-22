import "server-only";
import { z } from "zod";

/**
 * Server-only environment access. Read lazily (per call) so tests can change process.env.
 * Secrets never leave this module except to the code that needs them; never log them.
 */

export type DataBackend = "fixture" | "supabase";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const backendSchema = z.enum(["fixture", "supabase"]);

export function dataBackend(env: NodeJS.ProcessEnv = process.env): DataBackend {
  const raw = env.DATA_BACKEND?.trim() || "fixture";
  const parsed = backendSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`DATA_BACKEND must be "fixture" or "supabase" (got "${raw}").`);
  return parsed.data;
}

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string | null;
}

/** Throws a clear ConfigError when Supabase mode is selected without its variables. */
export function supabaseEnv(env: NodeJS.ProcessEnv = process.env, opts: { requireServiceRole?: boolean } = {}): SupabaseEnv {
  const url = env.SUPABASE_URL?.trim();
  const anonKey = env.SUPABASE_ANON_KEY?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
  const missing: string[] = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!anonKey) missing.push("SUPABASE_ANON_KEY");
  if (opts.requireServiceRole && !serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    throw new ConfigError(`DATA_BACKEND=supabase requires ${missing.join(", ")} (see .env.example).`);
  }
  if (!/^https:\/\//.test(url!) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url!)) {
    throw new ConfigError("SUPABASE_URL must be an https URL (or http://localhost for a local stack).");
  }
  return { url: url!, anonKey: anonKey!, serviceRoleKey };
}

function intEnv(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer in [${min}, ${max}].`);
  return n;
}

/** Below this many researched results, search also queries Lane B (external discovery). */
export function minResearchedResults(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.MIN_RESEARCHED_RESULTS, 3, 0, 50, "MIN_RESEARCHED_RESULTS");
}

/**
 * Number of trusted proxies that append to X-Forwarded-For in front of the app (>= 1).
 * 1 = use the last entry; 2 = second-from-last (Cloud Run behind a Google external LB).
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.TRUSTED_PROXY_HOPS, 1, 1, 10, "TRUSTED_PROXY_HOPS");
}

export function leadRateLimit(env: NodeJS.ProcessEnv = process.env): { max: number; windowMs: number } {
  return {
    max: intEnv(env.LEAD_RATE_LIMIT_MAX, 5, 1, 1000, "LEAD_RATE_LIMIT_MAX"),
    windowMs: intEnv(env.LEAD_RATE_LIMIT_WINDOW_SECONDS, 600, 1, 86400, "LEAD_RATE_LIMIT_WINDOW_SECONDS") * 1000,
  };
}

/** Failed staff sign-ins allowed per client IP per window (email key: 5× this). */
export function loginRateLimit(env: NodeJS.ProcessEnv = process.env): { max: number; windowMs: number } {
  return {
    max: intEnv(env.LOGIN_MAX_ATTEMPTS, 10, 1, 1000, "LOGIN_MAX_ATTEMPTS"),
    windowMs: intEnv(env.LOGIN_WINDOW_SECONDS, 900, 1, 86400, "LOGIN_WINDOW_SECONDS") * 1000,
  };
}

export const MIN_SESSION_SECRET_LENGTH = 32;
export const MIN_ADMIN_DEV_PASSWORD_LENGTH = 12;

export function sessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SESSION_SECRET ?? "";
  if (s.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(`SESSION_SECRET must be set and at least ${MIN_SESSION_SECRET_LENGTH} characters.`);
  }
  return s;
}

/**
 * Optional DEV-ONLY advisor password (fixture mode). null when unset. Throws ConfigError when set
 * but shorter than 12 characters or equal to ADMIN_DEV_PASSWORD.
 */
export function adminDevAdvisorPassword(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = env.ADMIN_DEV_ADVISOR_PASSWORD ?? "";
  if (p === "") return null;
  if (p.length < MIN_ADMIN_DEV_PASSWORD_LENGTH) {
    throw new ConfigError(`ADMIN_DEV_ADVISOR_PASSWORD must be at least ${MIN_ADMIN_DEV_PASSWORD_LENGTH} characters.`);
  }
  if (p === (env.ADMIN_DEV_PASSWORD ?? "")) {
    throw new ConfigError("ADMIN_DEV_ADVISOR_PASSWORD must differ from ADMIN_DEV_PASSWORD.");
  }
  return p;
}

export function adminDevPassword(env: NodeJS.ProcessEnv = process.env): string {
  const p = env.ADMIN_DEV_PASSWORD ?? "";
  if (p.length < MIN_ADMIN_DEV_PASSWORD_LENGTH) {
    throw new ConfigError(`ADMIN_DEV_PASSWORD must be set and at least ${MIN_ADMIN_DEV_PASSWORD_LENGTH} characters.`);
  }
  return p;
}

// --- On-demand web research (docs/RESEARCH_WORKER.md) ---------------------------------------

export const MIN_RESEARCH_RUN_SECRET_LENGTH = 32;
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Hours a finished research job for the same query is reused instead of researching again. */
export function researchCacheHours(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RESEARCH_CACHE_HOURS, 168, 1, 24 * 90, "RESEARCH_CACHE_HOURS");
}

/** Global cap on research jobs enqueued per rolling 24 hours (cost guardrail). */
export function researchMaxJobsPerDay(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RESEARCH_MAX_JOBS_PER_DAY, 50, 0, 10_000, "RESEARCH_MAX_JOBS_PER_DAY");
}

/** Jobs processed per worker run. */
export function researchBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env.RESEARCH_BATCH_SIZE, 3, 1, 20, "RESEARCH_BATCH_SIZE");
}

/**
 * Shared secret for POST /api/internal/research/run. null when unset or shorter than 32
 * characters: the endpoint then answers 404 (it does not exist). Never log it.
 */
export function researchRunSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.RESEARCH_RUN_SECRET ?? "";
  return s.length >= MIN_RESEARCH_RUN_SECRET_LENGTH ? s : null;
}

/** Anthropic API key for the research worker. Throws ConfigError when unset. Never log it. */
export function anthropicApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const k = env.ANTHROPIC_API_KEY?.trim();
  if (!k) throw new ConfigError("ANTHROPIC_API_KEY must be set to run web research (see .env.example).");
  return k;
}

export function anthropicModel(env: NodeJS.ProcessEnv = process.env): string {
  const m = env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
  if (!/^[a-z0-9][a-z0-9.\-]{1,80}$/.test(m)) throw new ConfigError("ANTHROPIC_MODEL must be a model id like claude-opus-5-5.");
  return m;
}
