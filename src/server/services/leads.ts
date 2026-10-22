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
import { getRepositories, type LeadFilter, type Repositories, type StaffMember, type StoredLead } from "../repositories";
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
  assignedTo: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Admins see every lead; advisors only leads assigned to them (mirrors the leads RLS policy). */
function canSeeLead(session: StaffSession, lead: StoredLead): boolean {
  return session.role === "admin" || (lead.assignedTo ?? null) === session.userId;
}

/**
 * Staff only (throws StaffAuthError). Newest first, each with a subject summary. Advisors get
 * only leads assigned to them (any `assignedTo` they pass is overridden); admins may filter.
 */
export async function listLeads(filter: LeadFilter = {}, deps: LeadServiceDeps = {}): Promise<StaffLeadView[]> {
  const session = await (deps.requireStaff ?? requireStaff)();
  const f = listFilterSchema.parse(filter);
  const scoped: LeadFilter = session.role === "admin" ? f : { ...f, assignedTo: session.userId };
  const repos = deps.repos ?? getRepositories();
  return withSubjects(await repos.leads.list(scoped), repos);
}

/** Staff only (throws StaffAuthError). Advisors get null for leads not assigned to them. */
export async function getLead(id: string, deps: LeadServiceDeps = {}): Promise<StaffLeadView | null> {
  const session = await (deps.requireStaff ?? requireStaff)();
  const parsed = z.string().min(1).max(100).safeParse(id);
  if (!parsed.success) return null;
  const repos = deps.repos ?? getRepositories();
  const lead = await repos.leads.getById(parsed.data);
  return lead && canSeeLead(session, lead) ? (await withSubjects([lead], repos))[0] : null;
}

/** Staff only. Members leads can be assigned to (for the admin assignment picker). */
export async function listAssignableStaff(deps: LeadServiceDeps = {}): Promise<StaffMember[]> {
  await (deps.requireStaff ?? requireStaff)();
  return (deps.repos ?? getRepositories()).leads.listStaff();
}

export type AssignLeadServiceResult =
  | { ok: true; lead: StoredLead; changed: boolean }
  | { ok: false; error: "validation" | "not_found" | "forbidden"; message: string };

/** Admin only. Assigns a lead to a staff member, or unassigns it with null. Audited ('assigned'). */
export async function assignLead(id: string, assigneeId: string | null, deps: LeadServiceDeps = {}): Promise<AssignLeadServiceResult> {
  const session = await (deps.requireStaff ?? requireStaff)();
  if (session.role !== "admin") return { ok: false, error: "forbidden", message: "Only an admin can assign leads." };
  const parsed = z
    .object({ id: z.string().min(1).max(100), assigneeId: z.string().min(1).max(100).nullable() })
    .safeParse({ id, assigneeId });
  if (!parsed.success) return { ok: false, error: "validation", message: "Invalid lead or staff member." };
  const repos = deps.repos ?? getRepositories();
  const r = await repos.leads.assign(parsed.data.id, parsed.data.assigneeId, session.userId);
  if (r.ok && r.changed) log.info("lead.assigned", { leadId: r.lead.id, assigned: parsed.data.assigneeId !== null, actor: session.userId });
  return r;
}

export type UpdateLeadStatusServiceResult =
  | { ok: true; lead: StoredLead }
  | { ok: false; error: "validation" | "not_found" | "invalid_transition" | "forbidden"; message: string };

/**
 * Staff only (throws StaffAuthError). Enforces allowed transitions. Withdrawal (irreversible PII
 * erasure) requires the admin role. Advisors may change only leads assigned to them ("not_found"
 * otherwise, so unassigned lead ids are not confirmed).
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
  if (session.role !== "admin") {
    const lead = await repos.leads.getById(parsed.data.id);
    if (!lead || !canSeeLead(session, lead)) return { ok: false, error: "not_found", message: "Lead not found." };
  }
  const result = await repos.leads.updateStatus(parsed.data.id, parsed.data.status, session.userId);
  if (result.ok) log.info("lead.status_changed", { ...redactLeadForLog(result.lead), actor: session.userId });
  return result;
}
