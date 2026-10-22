import "server-only";
import { z } from "zod";
import type { Developer, FactValue, Project, PublishReadiness, ResearchFactField, SourceType, VerificationState } from "@/domain/types";
import { getLocality, isActiveLocality } from "@/config/markets";
import { getSource, SOURCE_REGISTRY, type SourceEntry } from "@/discovery";
import { isAutomatedActor } from "@/research/evidence";
import { parseFactEdit, RESEARCH_FACT_FIELDS, toSourceRefs } from "@/research/fact-edit";
import { evaluatePublishReadiness, PUBLISH_ROLE } from "@/research/publish";
import { canSetVerification, factVersion, VERIFICATION_AFTER_EDIT } from "@/research/verification";
import { requireStaff, type StaffSession } from "../auth";
import { isProduction } from "../env";
import { log } from "../log";
import { CONFLICT_MESSAGE, getRepositories, type AuditActor, type Repositories, type StaffAuditEntry } from "../repositories";

// Staff research services (M3, D12/D13). Every function calls requireStaff() first (throws
// StaffAuthError when there is no session). Logs carry ids and codes only.
// Workers/AI never hold a staff session; the automated-actor id check is defence in depth.

export type ResearchErrorCode = "validation" | "forbidden" | "not_found" | "not_ready" | "conflict";
export type ResearchError = { ok: false; error: ResearchErrorCode; message: string; errors?: string[] };
export type ResearchResult<T> = ({ ok: true } & T) | ResearchError;

export interface ResearchDeps {
  repos?: Repositories;
  requireStaff?: () => Promise<StaffSession>;
}

export interface StaffProjectSummary {
  project: Project;
  readiness: PublishReadiness;
}

export interface StaffProjectView extends StaffProjectSummary {
  audit: StaffAuditEntry[];
  /** factVersion per editable field, to post back as `expectedVersion` with verification changes. */
  factVersions: Record<ResearchFactField, string>;
}

export interface ResearchSourceOption {
  id: string;
  name: string;
  type: SourceType;
}

const VERIFICATION_STATES = ["unverified", "source_confirmed", "reviewed", "disputed", "requires_professional_review"] as const;
export const UNKNOWN_SOURCE_MESSAGE = "Unknown source — choose one from the registry";

const fail = (error: ResearchErrorCode, message: string, errors?: string[]): ResearchError =>
  errors ? { ok: false, error, message, errors } : { ok: false, error, message };

async function staffContext(deps: ResearchDeps) {
  const session = await (deps.requireStaff ?? requireStaff)();
  const repos = deps.repos ?? getRepositories();
  const actor: AuditActor = { actorId: session.userId, actorRole: session.role };
  return { session, repos, actor };
}

/** Automated actors (AI workers, bots) may never change research data (D12). */
function refuseAutomated(session: StaffSession): ResearchError | null {
  return isAutomatedActor(session.userId) ? fail("forbidden", "Automated actors cannot change research data.") : null;
}

function logWrite(event: string, projectId: string, session: StaffSession, extra: Record<string, string | boolean> = {}) {
  log.info(event, { projectId, role: session.role, ...extra });
}

// ---------------------------------------------------------------------------
// Source registry
// ---------------------------------------------------------------------------

function isCitable(s: SourceEntry, production: boolean): boolean {
  if (s.status === "rejected") return false;
  if (s.type === "fixture" && production) return false; // fixture-only sources never in production
  return true;
}

/** Sources staff may cite (registry ids). Fixture sources only outside production. Not auth-gated (public metadata). */
export function listResearchSources(): ResearchSourceOption[] {
  const production = isProduction();
  return SOURCE_REGISTRY.filter((s) => isCitable(s, production)).map((s) => ({ id: s.id, name: s.name, type: s.type }));
}

function unknownSourceErrors(raw: unknown): string[] {
  const production = isProduction();
  const errors: string[] = [];
  const entries: [string, unknown][] =
    raw && typeof raw === "object" && typeof (raw as { entries?: unknown }).entries === "function" && !Array.isArray(raw)
      ? Array.from((raw as { entries(): Iterable<[string, unknown]> }).entries())
      : Object.entries((raw ?? {}) as Record<string, unknown>);
  const check = (key: string, id: unknown) => {
    if (typeof id !== "string" || id.trim() === "") return; // missing: parseFactEdit reports it
    const s = getSource(id.trim());
    if (!s || !isCitable(s, production)) errors.push(`${key}: ${UNKNOWN_SOURCE_MESSAGE}`);
  };
  for (const [k, v] of entries) {
    const m = /^sources\[(\d+)\]\.sourceId$/.exec(k);
    if (m) check(`sources.${m[1]}.sourceId`, v);
    if (k === "sources" && Array.isArray(v)) v.forEach((src, i) => check(`sources.${i}.sourceId`, (src as { sourceId?: unknown })?.sourceId));
  }
  return errors;
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
  const factVersions = Object.fromEntries(
    RESEARCH_FACT_FIELDS.map((f) => [f, factVersion(project[f] as FactValue<unknown>)]),
  ) as Record<ResearchFactField, string>;
  return {
    ok: true,
    project,
    readiness: evaluatePublishReadiness(project),
    audit: await repos.research.listAudit(project.id),
    factVersions,
  };
}

/** Developers for the optional "existing developer" select. */
export async function listDevelopers(deps: ResearchDeps = {}): Promise<Developer[]> {
  const { repos } = await staffContext(deps);
  return repos.research.listDevelopers();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const blankToUndefined = (v: unknown) => (v === "" || v === null || v === undefined ? undefined : v);
const optionalNumber = (min: number, max: number) => z.preprocess(blankToUndefined, z.coerce.number().min(min).max(max).optional());

const createSchema = z
  .object({
    name: z.string().trim().min(3, "Name must be at least 3 characters.").max(120),
    developerId: z.preprocess(blankToUndefined, z.string().trim().min(1).max(100).optional()),
    developerName: z.preprocess(blankToUndefined, z.string().trim().min(2, "Developer name must be at least 2 characters.").max(120).optional()),
    localityId: z
      .string()
      .trim()
      .refine((id) => isActiveLocality(id), "Choose an active North Bengaluru locality."),
    lat: optionalNumber(-90, 90),
    lng: optionalNumber(-180, 180),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { message: "Give both latitude and longitude, or neither.", path: ["lat"] })
  .refine((v) => v.developerId !== undefined || v.developerName !== undefined, {
    message: "Choose an existing developer or enter a new developer name.",
    path: ["developerName"],
  });

function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/**
 * Any staff role. New projects start unpublished, non-sample, with every fact unknown.
 * A NEW developer is created unless `developerId` names an existing one (never matched by name).
 */
export async function createProject(raw: unknown, deps: ResearchDeps = {}): Promise<ResearchResult<{ project: Project }>> {
  const { session, repos, actor } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const parsed = createSchema.safeParse(raw ?? {});
  if (!parsed.success) return fail("validation", "Please correct the highlighted fields.", zodErrors(parsed.error));
  if (!getLocality(parsed.data.localityId)) return fail("validation", "Unknown locality.");
  if (parsed.data.developerId && !(await repos.research.listDevelopers()).some((d) => d.id === parsed.data.developerId)) {
    return fail("validation", "Please correct the highlighted fields.", ["developerId: Unknown developer."]);
  }
  const input = parsed.data.developerId
    ? { ...parsed.data, developerName: undefined }
    : parsed.data;
  const project = await repos.research.createProject(input, actor);
  logWrite("research.project_created", project.id, session);
  return { ok: true, project };
}

/**
 * Any staff role. Validates with parseFactEdit (≥1 https source) and the source registry. The
 * stored fact is reset to "unverified". Audits fact_set; auto-unpublishes a published project that
 * no longer passes readiness (D13) — `autoUnpublished` tells the caller to revalidate public pages.
 */
export async function updateFact(raw: unknown, deps: ResearchDeps = {}): Promise<ResearchResult<{ project: Project; autoUnpublished: boolean }>> {
  const { session, repos, actor } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const parsed = parseFactEdit(raw);
  const sourceErrors = unknownSourceErrors(raw);
  if (!parsed.ok || sourceErrors.length) {
    return fail("validation", "Please correct the fact details.", [...(parsed.ok ? [] : parsed.errors), ...sourceErrors]);
  }
  const edit = parsed.value;
  const fact: FactValue<unknown> = {
    status: edit.status,
    value: edit.status === "known" ? edit.value : null,
    verification: VERIFICATION_AFTER_EDIT,
    sources: toSourceRefs(edit),
  };
  const r = await repos.research.setFact(edit.projectId, edit.field, fact, actor);
  if (!r.ok) return fail(r.error, r.message);
  logWrite("research.fact_set", r.project.id, session, { field: edit.field, autoUnpublished: r.autoUnpublished });
  return { ok: true, project: r.project, autoUnpublished: r.autoUnpublished };
}

const verificationSchema = z.object({
  projectId: z.string().trim().min(1).max(100),
  field: z.enum(RESEARCH_FACT_FIELDS),
  to: z.enum(VERIFICATION_STATES),
  expectedVersion: z.string().trim().min(1, "expectedVersion required (reload the page)").max(100),
  expectedFrom: z.enum(VERIFICATION_STATES).optional(),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(1000).optional()),
});

export interface ChangeVerificationInput {
  projectId: string;
  field: ResearchFactField | string;
  to: VerificationState | string;
  /** factVersion of the fact as the reviewer saw it (getStaffProjectView().factVersions[field]). */
  expectedVersion: string;
  /** Verification state the reviewer saw; a different current state → "conflict" (R1). */
  expectedFrom?: VerificationState | string;
  note?: string | null;
}

/**
 * Role rules from canSetVerification (advisors: disputed / requires_professional_review; admins
 * also source_confirmed / reviewed / reset). Applies only to the fact version the reviewer saw,
 * else error "conflict" (stale tab). A fact needs ≥1 source. Audited; may auto-unpublish (D13).
 */
export async function changeVerification(
  input: ChangeVerificationInput,
  deps: ResearchDeps = {},
): Promise<ResearchResult<{ project: Project; autoUnpublished: boolean }>> {
  const { session, repos, actor } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const parsed = verificationSchema.safeParse({
    ...input,
    expectedFrom: input?.expectedFrom || undefined,
    note: input?.note ?? undefined,
  });
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
    const forbidden = /only admins|automated|unknown staff role|advisors may|admin/.test(check.reason);
    return fail(forbidden ? "forbidden" : "validation", check.reason);
  }
  if (factVersion(fact) !== v.expectedVersion) return fail("conflict", CONFLICT_MESSAGE);
  if (v.expectedFrom !== undefined && fact.verification !== v.expectedFrom) return fail("conflict", CONFLICT_MESSAGE);
  // Authoritative version check + change + audit happen atomically in the repository.
  const r = await repos.research.setFactVerification(
    v.projectId, v.field, v.to, v.expectedVersion, actor, v.note ?? null, v.expectedFrom ?? fact.verification,
  );
  if (!r.ok) return fail(r.error, r.message);
  logWrite("research.verification_changed", r.project.id, session, { field: v.field, to: v.to, autoUnpublished: r.autoUnpublished });
  return { ok: true, project: r.project, autoUnpublished: r.autoUnpublished };
}

/**
 * PUBLISH_ROLE only. Publishing requires readiness, re-checked atomically in the repository
 * (SQL under a row lock in Supabase). Unpublishing is always allowed for PUBLISH_ROLE.
 * A no-op (already in that state) succeeds with changed:false and no audit event.
 */
export async function setPublished(
  projectId: string,
  published: boolean,
  deps: ResearchDeps = {},
): Promise<ResearchResult<{ project: Project; changed: boolean }>> {
  const { session, repos, actor } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  if (session.role !== PUBLISH_ROLE) return fail("forbidden", `Only an ${PUBLISH_ROLE} can publish or unpublish projects.`);
  const id = z.string().trim().min(1).max(100).safeParse(projectId);
  if (!id.success || typeof published !== "boolean") return fail("validation", "Invalid publish request.");
  const r = await repos.research.setPublished(id.data, published, actor);
  if (!r.ok) return fail(r.error, r.message, r.error === "not_ready" ? r.blockers : undefined);
  if (r.changed) logWrite(published ? "research.published" : "research.unpublished", r.project.id, session);
  return { ok: true, project: r.project, changed: r.changed };
}
