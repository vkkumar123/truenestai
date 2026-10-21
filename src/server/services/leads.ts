import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LeadStatus } from "@/domain/types";
import { parseLeadInput } from "@/leads/validation";
import { qualifyLead } from "@/leads/qualification";
import { computeRetentionUntil, redactLeadForLog } from "@/leads/retention";
import { requireStaff, type StaffSession } from "../auth";
import { leadRateLimit } from "../env";
import { log } from "../log";
import { getRepositories, type LeadFilter, type Repositories, type StoredLead } from "../repositories";
import { FixedWindowRateLimiter } from "./rate-limit";

export interface SubmitLeadContext {
  /** Client key for rate limiting (e.g. first X-Forwarded-For hop). Hashed before storage. */
  ipKey: string | null;
  now?: Date;
}

export type SubmitLeadResult =
  | { ok: true; leadId: string }
  | { ok: false; reason: "validation" | "rate_limited" | "unavailable"; errors: Record<string, string> };

export interface LeadServiceDeps {
  repos?: Repositories;
  requireStaff?: () => Promise<StaffSession>;
  limiter?: FixedWindowRateLimiter;
}

const LIMITER_KEY = Symbol.for("truenest.leadRateLimiter");
type G = typeof globalThis & { [LIMITER_KEY]?: FixedWindowRateLimiter };

/** Process-wide dev-grade limiter (see rate-limit.ts for production caveats). */
export function leadRateLimiter(): FixedWindowRateLimiter {
  const g = globalThis as G;
  if (!g[LIMITER_KEY]) {
    const { max, windowMs } = leadRateLimit();
    g[LIMITER_KEY] = new FixedWindowRateLimiter(max, windowMs);
  }
  return g[LIMITER_KEY]!;
}

/**
 * Public lead submission. Validates with parseLeadInput (consent required), checks that a
 * referenced property exists publicly, qualifies, stores with status "new" and a retention
 * date, and logs only redacted fields.
 */
export async function submitLead(raw: unknown, ctx: SubmitLeadContext, deps: LeadServiceDeps = {}): Promise<SubmitLeadResult> {
  const limiter = deps.limiter ?? leadRateLimiter();
  const rl = limiter.hit(`lead:${ctx.ipKey ?? "unknown"}`, (ctx.now ?? new Date()).getTime());
  if (!rl.allowed) {
    log.warn("lead.rate_limited");
    return {
      ok: false,
      reason: "rate_limited",
      errors: { form: "Too many requests. Please wait a few minutes and try again." },
    };
  }

  const parsed = parseLeadInput(raw);
  if (!parsed.ok) return { ok: false, reason: "validation", errors: parsed.errors };
  const input = parsed.value;
  // Belt and braces: parseLeadInput already requires this.
  if (input.consent.contactConsent !== true) {
    return { ok: false, reason: "validation", errors: { contactConsent: "Please agree to be contacted so we can respond to your request." } };
  }

  const repos = deps.repos ?? getRepositories();
  try {
    if (input.projectId) {
      const [p] = await repos.projects.getProjectsByIds([input.projectId]);
      if (!p) return { ok: false, reason: "validation", errors: { projectId: "This project is not available." } };
    }
    if (input.externalListingId && !(await repos.externalListings.getById(input.externalListingId))) {
      return { ok: false, reason: "validation", errors: { externalListingId: "This listing is no longer available." } };
    }

    const now = (ctx.now ?? new Date()).toISOString();
    const lead: StoredLead = {
      ...input,
      id: randomUUID(),
      status: "new",
      createdAt: now,
      consentedAt: now,
      retentionUntil: computeRetentionUntil(now, "new"),
      qualification: qualifyLead(input),
    };
    const stored = await repos.leads.create(lead);
    log.info("lead.created", { ...redactLeadForLog(stored), tier: stored.qualification?.tier ?? null, backend: repos.backend });
    return { ok: true, leadId: stored.id };
  } catch (e) {
    log.error("lead.create_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { ok: false, reason: "unavailable", errors: { form: "We could not save your request. Please try again shortly." } };
  }
}

const leadStatusSchema = z.enum(["new", "contacted", "qualified", "closed", "withdrawn"]);
const listFilterSchema = z.object({
  status: leadStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Staff only. Throws StaffAuthError when there is no staff session. */
export async function listLeads(filter: LeadFilter = {}, deps: LeadServiceDeps = {}): Promise<StoredLead[]> {
  await (deps.requireStaff ?? requireStaff)();
  const f = listFilterSchema.parse(filter);
  return (deps.repos ?? getRepositories()).leads.list(f);
}

/** Staff only. Throws StaffAuthError when there is no staff session. */
export async function getLead(id: string, deps: LeadServiceDeps = {}): Promise<StoredLead | null> {
  await (deps.requireStaff ?? requireStaff)();
  const parsed = z.string().min(1).max(100).safeParse(id);
  if (!parsed.success) return null;
  return (deps.repos ?? getRepositories()).leads.getById(parsed.data);
}

export type UpdateLeadStatusServiceResult =
  | { ok: true; lead: StoredLead }
  | { ok: false; error: "validation" | "not_found" | "invalid_transition"; message: string };

/** Staff only. Enforces allowed transitions; withdrawal erases PII. Throws StaffAuthError if not staff. */
export async function updateLeadStatus(
  id: string,
  status: LeadStatus,
  deps: LeadServiceDeps = {},
): Promise<UpdateLeadStatusServiceResult> {
  const session = await (deps.requireStaff ?? requireStaff)();
  const parsed = z.object({ id: z.string().min(1).max(100), status: leadStatusSchema }).safeParse({ id, status });
  if (!parsed.success) return { ok: false, error: "validation", message: "Invalid lead or status." };
  const repos = deps.repos ?? getRepositories();
  const result = await repos.leads.updateStatus(parsed.data.id, parsed.data.status, session.userId);
  if (result.ok) log.info("lead.status_changed", { ...redactLeadForLog(result.lead), actor: session.userId });
  return result;
}
