import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LeadStatus } from "@/domain/types";
import { getSource } from "@/discovery";
import { parseLeadInput } from "@/leads/validation";
import { qualifyLead } from "@/leads/qualification";
import { computeRetentionUntil, redactLeadForLog } from "@/leads/retention";
import { requireStaff, type StaffSession } from "../auth";
import { leadRateLimit } from "../env";
import { log } from "../log";
import { getRepositories, type LeadFilter, type Repositories, type StoredLead } from "../repositories";
import { FixedWindowRateLimiter } from "./rate-limit";

export interface SubmitLeadContext {
  /**
   * Client key for rate limiting, from clientIpFromForwardedFor (right-most trusted hop, see
   * TRUSTED_PROXY_HOPS). Hashed before it is held in memory.
   */
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

const RATE_LIMITED: SubmitLeadResult = {
  ok: false,
  reason: "rate_limited",
  errors: { form: "Too many requests. Please wait a few minutes and try again." },
};

/**
 * Public lead submission. Validates with parseLeadInput (consent required), rate-limits VALID
 * submissions per client key AND per contact (hashed email/phone), checks that a referenced
 * property exists publicly, qualifies, stores with status "new" and a retention date, and logs
 * only redacted fields.
 */
export async function submitLead(raw: unknown, ctx: SubmitLeadContext, deps: LeadServiceDeps = {}): Promise<SubmitLeadResult> {
  const parsed = parseLeadInput(raw);
  if (!parsed.ok) return { ok: false, reason: "validation", errors: parsed.errors };
  const input = parsed.value;
  // Belt and braces: parseLeadInput already requires this.
  if (input.consent.contactConsent !== true) {
    return { ok: false, reason: "validation", errors: { contactConsent: "Please agree to be contacted so we can respond to your request." } };
  }

  const limiter = deps.limiter ?? leadRateLimiter();
  const at = (ctx.now ?? new Date()).getTime();
  // One key for the client IP and one per contact value present (email and phone separately).
  const keys = [`lead:ip:${ctx.ipKey ?? "unknown"}`];
  if (input.email) keys.push(`lead:email:${input.email.trim().toLowerCase()}`);
  if (input.phone) keys.push(`lead:phone:${input.phone}`);
  const blocked = keys.map((k) => ({ k, r: limiter.hit(k, at) })).filter((x) => !x.r.allowed);
  if (blocked.length) {
    log.warn("lead.rate_limited", { keys: blocked.map((b) => b.k.split(":")[1]) });
    return RATE_LIMITED;
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

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/** What a lead refers to, for the staff list. Lane B listings stay labelled unverified. */
export type LeadSubjectSummary =
  | { kind: "project"; id: string; name: string | null; slug: string | null; available: boolean }
  | {
      kind: "external_listing";
      id: string;
      title: string | null;
      sourceId: string | null;
      sourceName: string | null;
      canonicalUrl: string | null;
      discoveredAt: string | null;
      lastSeenAt: string | null;
      available: boolean;
    };

export interface StaffLeadView extends StoredLead {
  subject: LeadSubjectSummary | null;
}

async function withSubjects(leads: StoredLead[], repos: Repositories): Promise<StaffLeadView[]> {
  const projectIds = [...new Set(leads.map((l) => l.projectId).filter((x): x is string => !!x))];
  const projects = new Map((await repos.projects.getProjectsByIds(projectIds)).map((p) => [p.id, p]));
  const listingIds = [...new Set(leads.map((l) => l.externalListingId).filter((x): x is string => !!x))];
  const listings = new Map(
    (await Promise.all(listingIds.map((id) => repos.externalListings.getById(id)))).flatMap((l) => (l ? [[l.id, l] as const] : [])),
  );
  return leads.map((lead) => {
    let subject: LeadSubjectSummary | null = null;
    if (lead.projectId) {
      const p = projects.get(lead.projectId);
      subject = { kind: "project", id: lead.projectId, name: p?.name ?? null, slug: p?.slug ?? null, available: !!p };
    } else if (lead.externalListingId) {
      const l = listings.get(lead.externalListingId);
      subject = {
        kind: "external_listing",
        id: lead.externalListingId,
        title: l?.title ?? null,
        sourceId: l?.sourceId ?? null,
        sourceName: l ? (getSource(l.sourceId)?.name ?? l.sourceId) : null,
        canonicalUrl: l?.canonicalUrl ?? null,
        discoveredAt: l?.discoveredAt ?? null,
        lastSeenAt: l?.lastSeenAt ?? null,
        available: !!l,
      };
    }
    return { ...lead, subject };
  });
}

const leadStatusSchema = z.enum(["new", "contacted", "qualified", "closed", "withdrawn"]);
const listFilterSchema = z.object({
  status: leadStatusSchema.optional(),
  requestType: z.enum(["verification", "buyer_assistance"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Staff only (throws StaffAuthError). Newest first, each with a subject summary. */
export async function listLeads(filter: LeadFilter = {}, deps: LeadServiceDeps = {}): Promise<StaffLeadView[]> {
  await (deps.requireStaff ?? requireStaff)();
  const f = listFilterSchema.parse(filter);
  const repos = deps.repos ?? getRepositories();
  return withSubjects(await repos.leads.list(f), repos);
}

/** Staff only (throws StaffAuthError). */
export async function getLead(id: string, deps: LeadServiceDeps = {}): Promise<StaffLeadView | null> {
  await (deps.requireStaff ?? requireStaff)();
  const parsed = z.string().min(1).max(100).safeParse(id);
  if (!parsed.success) return null;
  const repos = deps.repos ?? getRepositories();
  const lead = await repos.leads.getById(parsed.data);
  return lead ? (await withSubjects([lead], repos))[0] : null;
}

export type UpdateLeadStatusServiceResult =
  | { ok: true; lead: StoredLead }
  | { ok: false; error: "validation" | "not_found" | "invalid_transition" | "forbidden"; message: string };

/**
 * Staff only (throws StaffAuthError). Enforces allowed transitions. Withdrawal (irreversible PII
 * erasure) requires the admin role. Lead assignment scoping is not implemented yet.
 */
export async function updateLeadStatus(
  id: string,
  status: LeadStatus,
  deps: LeadServiceDeps = {},
): Promise<UpdateLeadStatusServiceResult> {
  const session = await (deps.requireStaff ?? requireStaff)();
  const parsed = z.object({ id: z.string().min(1).max(100), status: leadStatusSchema }).safeParse({ id, status });
  if (!parsed.success) return { ok: false, error: "validation", message: "Invalid lead or status." };
  if (parsed.data.status === "withdrawn" && session.role !== "admin") {
    return { ok: false, error: "forbidden", message: "Only an admin can withdraw a lead (this erases personal data)." };
  }
  const repos = deps.repos ?? getRepositories();
  const result = await repos.leads.updateStatus(parsed.data.id, parsed.data.status, session.userId);
  if (result.ok) log.info("lead.status_changed", { ...redactLeadForLog(result.lead), actor: session.userId });
  return result;
}
