import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  FactAuditEvent,
  FactValue,
  Project,
  PublishReadiness,
  ResearchFactField,
  VerificationState,
} from "@/domain/types";
import { getLocality, isActiveLocality } from "@/config/markets";
import { isAutomatedActor } from "@/research/evidence";
import { parseFactEdit, RESEARCH_FACT_FIELDS, toSourceRefs } from "@/research/fact-edit";
import { evaluatePublishReadiness, PUBLISH_ROLE } from "@/research/publish";
import { canSetVerification, VERIFICATION_AFTER_EDIT } from "@/research/verification";
import { requireStaff, type StaffSession } from "../auth";
import { log } from "../log";
import { getRepositories, type Repositories } from "../repositories";

// Staff research services (M3, D12). Every function calls requireStaff() first (throws
// StaffAuthError when there is no session). Logs carry ids and codes only.

export type ResearchErrorCode = "validation" | "forbidden" | "not_found" | "not_ready";
export type ResearchError = { ok: false; error: ResearchErrorCode; message: string; errors?: string[] };
export type ResearchResult<T> = ({ ok: true } & T) | ResearchError;

export interface ResearchDeps {
  repos?: Repositories;
  requireStaff?: () => Promise<StaffSession>;
  now?: () => Date;
}

export interface StaffProjectSummary {
  project: Project;
  readiness: PublishReadiness;
}

export interface StaffProjectView extends StaffProjectSummary {
  audit: FactAuditEvent[];
}

const VERIFICATION_STATES = ["unverified", "source_confirmed", "reviewed", "disputed", "requires_professional_review"] as const;

const fail = (error: ResearchErrorCode, message: string, errors?: string[]): ResearchError =>
  errors ? { ok: false, error, message, errors } : { ok: false, error, message };

async function staffContext(deps: ResearchDeps) {
  const session = await (deps.requireStaff ?? requireStaff)();
  const repos = deps.repos ?? getRepositories();
  const now = (deps.now ?? (() => new Date()))();
  return { session, repos, now };
}

/** Automated actors (AI workers, bots) may never change research data (D12). */
function refuseAutomated(session: StaffSession): ResearchError | null {
  return isAutomatedActor(session.userId) ? fail("forbidden", "Automated actors cannot change research data.") : null;
}

async function audit(
  repos: Repositories,
  session: StaffSession,
  now: Date,
  e: Pick<FactAuditEvent, "projectId" | "field" | "action" | "fromVerification" | "toVerification" | "note">,
): Promise<void> {
  await repos.research.appendAudit({
    id: randomUUID(),
    actorId: session.userId,
    actorRole: session.role,
    at: now.toISOString(),
    ...e,
  });
  log.info("research.audit", { projectId: e.projectId, field: e.field, action: e.action, role: session.role });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All projects (published or not) with publish readiness, for the staff list. */
export async function listStaffProjects(deps: ResearchDeps = {}): Promise<StaffProjectSummary[]> {
  const { repos } = await staffContext(deps);
  return (await repos.research.listAllProjects()).map((project) => ({ project, readiness: evaluatePublishReadiness(project) }));
}

export async function getStaffProjectView(id: string, deps: ResearchDeps = {}): Promise<ResearchResult<StaffProjectView>> {
  const { repos } = await staffContext(deps);
  const parsed = z.string().trim().min(1).max(100).safeParse(id);
  if (!parsed.success) return fail("not_found", "Project not found.");
  const project = await repos.research.getProjectByIdForStaff(parsed.data);
  if (!project) return fail("not_found", "Project not found.");
  return { ok: true, project, readiness: evaluatePublishReadiness(project), audit: await repos.research.listAudit(project.id) };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const optionalNumber = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v === null || v === undefined ? undefined : v), z.coerce.number().min(min).max(max).optional());

const createSchema = z
  .object({
    name: z.string().trim().min(3, "Name must be at least 3 characters.").max(120),
    developerName: z.string().trim().min(2, "Developer name must be at least 2 characters.").max(120),
    localityId: z
      .string()
      .trim()
      .refine((id) => isActiveLocality(id), "Choose an active North Bengaluru locality."),
    lat: optionalNumber(-90, 90),
    lng: optionalNumber(-180, 180),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: "Give both latitude and longitude, or neither.", path: ["lat"] });

function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Any staff role. New projects start unpublished, non-sample, with every fact unknown. */
export async function createProject(raw: unknown, deps: ResearchDeps = {}): Promise<ResearchResult<{ project: Project }>> {
  const { session, repos, now } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const parsed = createSchema.safeParse(raw ?? {});
  if (!parsed.success) return fail("validation", "Please correct the highlighted fields.", zodErrors(parsed.error));
  const locality = getLocality(parsed.data.localityId);
  if (!locality) return fail("validation", "Unknown locality.");
  const project = await repos.research.createProject(parsed.data);
  await audit(repos, session, now, {
    projectId: project.id,
    field: "basics",
    action: "created",
    fromVerification: null,
    toVerification: null,
    note: null,
  });
  return { ok: true, project };
}

/**
 * Any staff role. Validates with parseFactEdit (≥1 https source). The stored fact is always
 * reset to VERIFICATION_AFTER_EDIT ("unverified"). Audits fact_set.
 */
export async function updateFact(raw: unknown, deps: ResearchDeps = {}): Promise<ResearchResult<{ project: Project }>> {
  const { session, repos, now } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const parsed = parseFactEdit(raw);
  if (!parsed.ok) return fail("validation", "Please correct the fact details.", parsed.errors);
  const edit = parsed.value;
  const current = await repos.research.getProjectByIdForStaff(edit.projectId);
  if (!current) return fail("not_found", "Project not found.");
  const before = current[edit.field] as FactValue<unknown>;
  const fact: FactValue<unknown> = {
    status: edit.status,
    value: edit.status === "known" ? edit.value : null,
    verification: VERIFICATION_AFTER_EDIT,
    sources: toSourceRefs(edit),
  };
  const project = await repos.research.setFact(edit.projectId, edit.field, fact);
  if (!project) return fail("not_found", "Project not found.");
  await audit(repos, session, now, {
    projectId: project.id,
    field: edit.field,
    action: "fact_set",
    fromVerification: before.verification,
    toVerification: VERIFICATION_AFTER_EDIT,
    note: null,
  });
  return { ok: true, project };
}

const verificationSchema = z.object({
  projectId: z.string().trim().min(1).max(100),
  field: z.enum(RESEARCH_FACT_FIELDS),
  to: z.enum(VERIFICATION_STATES),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(1000).optional()),
});

/**
 * Role rules from canSetVerification: advisors may set disputed / requires_professional_review;
 * only admins may set source_confirmed / reviewed. A fact needs ≥1 source to be verified. Audited.
 */
export async function changeVerification(
  projectId: string,
  field: ResearchFactField | string,
  to: VerificationState | string,
  note?: string | null,
  deps: ResearchDeps = {},
): Promise<ResearchResult<{ project: Project }>> {
  const { session, repos, now } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const parsed = verificationSchema.safeParse({ projectId, field, to, note: note ?? undefined });
  if (!parsed.success) return fail("validation", "Invalid verification change.", zodErrors(parsed.error));
  const v = parsed.data;
  const current = await repos.research.getProjectByIdForStaff(v.projectId);
  if (!current) return fail("not_found", "Project not found.");
  const fact = current[v.field] as FactValue<unknown>;
  if (fact.sources.length === 0) {
    return fail("validation", "Add at least one source for this fact before changing its verification.");
  }
  const check = canSetVerification(fact.verification, v.to, { id: session.userId, role: session.role });
  if (!check.ok) {
    const forbidden = /only admins|automated|unknown staff role|advisors may/.test(check.reason);
    return fail(forbidden ? "forbidden" : "validation", check.reason);
  }
  const project = await repos.research.setFactVerification(v.projectId, v.field, v.to);
  if (!project) return fail("not_found", "Project not found.");
  await audit(repos, session, now, {
    projectId: project.id,
    field: v.field,
    action: "verification_changed",
    fromVerification: fact.verification,
    toVerification: v.to,
    note: v.note ?? null,
  });
  return { ok: true, project };
}

/**
 * PUBLISH_ROLE only. Publishing requires evaluatePublishReadiness(project).ready; unpublishing is
 * always allowed for PUBLISH_ROLE. A no-op (already in that state) succeeds without an audit event.
 */
export async function setPublished(
  projectId: string,
  published: boolean,
  deps: ResearchDeps = {},
): Promise<ResearchResult<{ project: Project; changed: boolean }>> {
  const { session, repos, now } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  if (session.role !== PUBLISH_ROLE) return fail("forbidden", `Only an ${PUBLISH_ROLE} can publish or unpublish projects.`);
  const id = z.string().trim().min(1).max(100).safeParse(projectId);
  if (!id.success || typeof published !== "boolean") return fail("validation", "Invalid publish request.");
  const current = await repos.research.getProjectByIdForStaff(id.data);
  if (!current) return fail("not_found", "Project not found.");
  if (current.published === published) return { ok: true, project: current, changed: false };
  if (published) {
    const readiness = evaluatePublishReadiness(current);
    if (!readiness.ready) return fail("not_ready", "This project is not ready to publish.", readiness.blockers);
  }
  const project = await repos.research.setPublished(current.id, published);
  if (!project) return fail("not_found", "Project not found.");
  await audit(repos, session, now, {
    projectId: project.id,
    field: "published",
    action: published ? "published" : "unpublished",
    fromVerification: null,
    toVerification: null,
    note: null,
  });
  return { ok: true, project, changed: true };
}
