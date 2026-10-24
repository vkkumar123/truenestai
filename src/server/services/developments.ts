import "server-only";
import { z } from "zod";
import type { Development, GeoPoint, Project } from "@/domain/types";
import { getLocality, isActiveLocality } from "@/config/markets";
import { currentEnv, getSource, isRunnable, type RuntimeEnv, type SourceEntry } from "@/discovery";
import {
  MAX_AUTHORITY,
  MAX_DECLARED_DATE,
  MAX_DEVELOPMENT_NAME,
  ResearchClientError,
  developmentQueryKey,
  researchLocalityDevelopments,
  type DevelopmentResearchResult,
  type ResearchClient,
} from "@/discovery/research";
import {
  developmentsNear,
  isInfraCategory,
  isInfraStage,
  isPromotionalText,
  parseDeclaredDate,
  type NearbyDevelopment,
} from "@/locality/developments";
import { isAutomatedActor } from "@/research/evidence";
import { requireStaff, type StaffSession } from "../auth";
import { researchCacheHours, researchMaxJobsPerDay } from "../env";
import { log } from "../log";
import { developmentPublishBlockers } from "../repositories/development-rules";
import {
  getRepositories,
  type AuditActor,
  type DevelopmentAuditEntry,
  type DevelopmentFields,
  type DevelopmentReviewAction,
  type Repositories,
  type ResearchJob,
  type StaffDevelopment,
} from "../repositories";
import { RESEARCH_MAX_JOBS_PER_REQUESTER_PER_DAY, requesterHash, researchSourceFor, researchWorkerConfigured } from "./research-jobs";

// Planned area developments (S4a, D20). Staff functions call requireStaff() first; researched rows
// are unverified drafts that only staff may publish. Public reads return published rows only.
// Logs carry ids, codes and counts only.

export { developmentPublishBlockers };

export type DevelopmentErrorCode = "validation" | "forbidden" | "not_found" | "not_ready" | "conflict" | "unavailable";
export type DevelopmentError = { ok: false; error: DevelopmentErrorCode; message: string; errors?: string[] };
export type DevelopmentResult<T> = ({ ok: true } & T) | DevelopmentError;

export interface DevelopmentDeps {
  repos?: Repositories;
  requireStaff?: () => Promise<StaffSession>;
  env?: RuntimeEnv;
  processEnv?: NodeJS.ProcessEnv;
}

const fail = (error: DevelopmentErrorCode, message: string, errors?: string[]): DevelopmentError =>
  errors ? { ok: false, error, message, errors } : { ok: false, error, message };

async function staffContext(deps: DevelopmentDeps) {
  const session = await (deps.requireStaff ?? requireStaff)();
  const repos = deps.repos ?? getRepositories();
  const actor: AuditActor = { actorId: session.userId, actorRole: session.role };
  return { session, repos, actor };
}

// ---------------------------------------------------------------------------
// Public reads (published rows only)
// ---------------------------------------------------------------------------

async function publishedOnly(repos: Repositories): Promise<Development[]> {
  // Defence in depth: the repository already returns published rows only (RLS in Supabase).
  return repos.developments.listPublished();
}

/** Published developments around a project (straight-line, nearest first; unmapped ones in its locality after). */
export async function getPlannedNearProject(
  project: Pick<Project, "location" | "localityId">,
  deps: { repos?: Repositories } = {},
): Promise<NearbyDevelopment[]> {
  try {
    const all = await publishedOnly(deps.repos ?? getRepositories());
    return developmentsNear(all, project.location, project.localityId);
  } catch (e) {
    log.warn("developments.public_read_failed", { reason: e instanceof Error ? e.name : "unknown" });
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Research: staff trigger → existing queue → existing worker
// ---------------------------------------------------------------------------

export type DevelopmentResearchRequestState =
  | { state: "queued" | "active"; job: ResearchJob }
  | { state: "cached"; job: ResearchJob }
  | { state: "failed_recently"; job: ResearchJob }
  | { state: "limited" };

/**
 * Queues development research for one configured, active locality (staff only). Reuses the
 * research queue, its daily cap, cache window and failure cooldown; the per-requester cap is keyed
 * by the staff user (HMAC), so one account cannot spend the whole daily cap.
 */
export async function requestAreaDevelopmentResearch(
  input: { localityId: unknown },
  deps: DevelopmentDeps = {},
): Promise<DevelopmentResult<{ result: DevelopmentResearchRequestState; localityName: string }>> {
  const { session, repos } = await staffContext(deps);
  if (isAutomatedActor(session.userId)) return fail("forbidden", "Automated actors cannot start research.");
  const id = z.string().trim().min(1).max(80).safeParse(input.localityId);
  if (!id.success || !isActiveLocality(id.data)) return fail("validation", "Choose an active locality from the market configuration.");
  const locality = getLocality(id.data)!;
  const source = researchSourceFor(repos.backend);
  const pe = deps.processEnv ?? process.env;
  if (!isRunnable(source, deps.env ?? currentEnv()) || !researchWorkerConfigured(repos.backend, pe)) {
    return fail("unavailable", "Web research is not available in this environment.");
  }
  const result = await repos.researchJobs.enqueue({
    kind: "area_developments",
    queryText: `Area developments: ${locality.name}`.slice(0, 100),
    queryKey: developmentQueryKey(locality.id),
    localityId: locality.id,
    requesterIpHash: requesterHash(`staff:${session.userId}`, pe),
    cacheHours: researchCacheHours(pe),
    maxPerDay: researchMaxJobsPerDay(pe),
    maxPerRequesterPerDay: RESEARCH_MAX_JOBS_PER_REQUESTER_PER_DAY,
  });
  log.info("developments.research_requested", { localityId: locality.id, outcome: result.outcome, role: session.role });
  switch (result.outcome) {
    case "queued":
    case "active":
      return { ok: true, localityName: locality.name, result: { state: result.outcome, job: result.job } };
    case "cached":
      return { ok: true, localityName: locality.name, result: { state: "cached", job: result.job } };
    case "failed_recently":
      return { ok: true, localityName: locality.name, result: { state: "failed_recently", job: result.job } };
    default:
      return { ok: true, localityName: locality.name, result: { state: "limited" } };
  }
}

export interface DevelopmentJobOutcome {
  stored: number;
  run: DevelopmentResearchResult;
}

/**
 * Worker step for an area_developments job (called by runResearchBatch, inside its deadline).
 * Validated, cited items are stored unverified and unpublished; nothing is published here.
 */
export async function runAreaDevelopmentJob(
  job: ResearchJob,
  ctx: { repos: Repositories; client: ResearchClient; source: SourceEntry; env: RuntimeEnv; now: Date; signal: AbortSignal },
): Promise<DevelopmentJobOutcome> {
  if (!job.localityId) throw new ResearchClientError("bad_request", false);
  const run = await researchLocalityDevelopments(job.localityId, {
    client: ctx.client,
    source: ctx.source,
    env: ctx.env,
    now: ctx.now,
    signal: ctx.signal,
  });
  let ids: string[] = [];
  if (run.developments.length) {
    try {
      ids = await ctx.repos.developments.storeResearched({
        jobId: job.id,
        researchLocalityId: job.localityId,
        sourceId: ctx.source.id,
        observedAt: ctx.now.toISOString(),
        isSample: ctx.source.type === "fixture",
        items: run.developments.map((d) => ({
          name: d.name,
          category: d.category,
          stage: d.stage,
          authority: d.authority,
          expectedCompletion: d.expectedCompletion,
          localityId: d.localityId,
          sourceUrl: d.sourceUrl,
        })),
      });
    } catch {
      throw new ResearchClientError("store_failed", true, run.usage);
    }
  }
  return { stored: ids.length, run };
}

// ---------------------------------------------------------------------------
// Staff reads
// ---------------------------------------------------------------------------

export interface StaffDevelopmentItem {
  development: StaffDevelopment;
  blockers: string[];
  audit: DevelopmentAuditEntry[];
}

export interface StaffDevelopmentsView {
  localityId: string;
  localityName: string;
  items: StaffDevelopmentItem[];
  /** Newest development research job for this locality, if any. */
  latestJob: ResearchJob | null;
  researchAvailable: boolean;
}

export async function getStaffDevelopmentsView(localityId: string, deps: DevelopmentDeps = {}): Promise<DevelopmentResult<{ view: StaffDevelopmentsView }>> {
  const { repos } = await staffContext(deps);
  const id = z.string().trim().min(1).max(80).safeParse(localityId);
  if (!id.success || !isActiveLocality(id.data)) return fail("not_found", "Locality not found.");
  const loc = getLocality(id.data)!;
  const [rows, jobs] = await Promise.all([
    repos.developments.listForStaff({ localityId: loc.id }),
    repos.researchJobs.listForQuery(developmentQueryKey(loc.id), 1),
  ]);
  const items = await Promise.all(
    rows.map(async (development) => ({ development, blockers: developmentPublishBlockers(development), audit: await repos.developments.listAudit(development.id) })),
  );
  const source = researchSourceFor(repos.backend);
  return {
    ok: true,
    view: {
      localityId: loc.id,
      localityName: loc.name,
      items,
      latestJob: jobs[0] ?? null,
      researchAvailable: isRunnable(source, deps.env ?? currentEnv()) && researchWorkerConfigured(repos.backend, deps.processEnv ?? process.env),
    },
  };
}

// ---------------------------------------------------------------------------
// Staff writes
// ---------------------------------------------------------------------------

type FormInput = { entries(): Iterable<[string, string]> } | Record<string, unknown>;

function toMulti(raw: FormInput): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const add = (k: string, v: unknown) => {
    if (typeof v === "string") m.set(k, [...(m.get(k) ?? []), v]);
    else if (Array.isArray(v)) for (const x of v) add(k, x);
  };
  if (raw && typeof (raw as { entries?: unknown }).entries === "function" && !Array.isArray(raw)) {
    for (const [k, v] of (raw as { entries(): Iterable<[string, string]> }).entries()) add(k, v);
  } else {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) add(k, v);
  }
  return m;
}

const optText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .optional()
    .transform((v) => (v ?? "").replace(/\s+/g, " ").trim() || null)
    .refine((v) => v === null || v.length <= max, `at most ${max} characters`);

const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "must be an https URL");

const isoDateTime = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)), "must be a date");

const fieldsSchema = z
  .object({
    name: z
      .string()
      .transform((v) => v.replace(/\s+/g, " ").trim())
      .pipe(z.string().min(3, "at least 3 characters").max(MAX_DEVELOPMENT_NAME, `at most ${MAX_DEVELOPMENT_NAME} characters`))
      .refine((v) => !isPromotionalText(v), "must not describe prices, returns or investment value"),
    category: z.string().refine(isInfraCategory, "choose a type"),
    stage: z.string().refine(isInfraStage, "choose a stage"),
    authority: optText(MAX_AUTHORITY),
    expectedCompletion: optText(MAX_DECLARED_DATE).refine((v) => v === null || parseDeclaredDate(v) !== null, "must state a year, as the source declares it"),
    announcedDate: z
      .string()
      .optional()
      .transform((v) => v?.trim() || null)
      .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))), "must be a date (YYYY-MM-DD)"),
    localityIds: z.array(z.string().trim()).min(1, "choose at least one locality").max(10).refine((ids) => ids.every(isActiveLocality), "unknown locality"),
    lat: z.string().optional(),
    lng: z.string().optional(),
    locationPrecision: z.enum(["exact", "approximate"]).optional(),
    sourceUrl: httpsUrl,
    sourceObservedAt: isoDateTime,
  })
  .superRefine((v, ctx) => {
    const lat = v.lat?.trim() ?? "";
    const lng = v.lng?.trim() ?? "";
    if ((lat === "") !== (lng === "")) ctx.addIssue({ code: "custom", path: ["lat"], message: "give both latitude and longitude, or neither" });
    if (lat !== "" && (!Number.isFinite(Number(lat)) || Math.abs(Number(lat)) > 90)) ctx.addIssue({ code: "custom", path: ["lat"], message: "invalid latitude" });
    if (lng !== "" && (!Number.isFinite(Number(lng)) || Math.abs(Number(lng)) > 180)) ctx.addIssue({ code: "custom", path: ["lng"], message: "invalid longitude" });
    if (Date.parse(v.sourceObservedAt) > Date.now() + 5 * 60_000) ctx.addIssue({ code: "custom", path: ["sourceObservedAt"], message: "cannot be in the future" });
  });

function parseFields(raw: FormInput): { ok: true; fields: Omit<DevelopmentFields, "sourceId"> } | DevelopmentError {
  const m = toMulti(raw);
  const one = (k: string) => m.get(k)?.[0];
  const localityIds = [...new Set((m.get("localityIds") ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean))];
  const parsed = fieldsSchema.safeParse({
    name: one("name") ?? "",
    category: one("category") ?? "",
    stage: one("stage") ?? "",
    authority: one("authority"),
    expectedCompletion: one("expectedCompletion"),
    announcedDate: one("announcedDate"),
    localityIds,
    lat: one("lat"),
    lng: one("lng"),
    locationPrecision: one("locationPrecision") || undefined,
    sourceUrl: one("sourceUrl") ?? "",
    sourceObservedAt: one("sourceObservedAt") ?? "",
  });
  if (!parsed.success) {
    return fail("validation", "Please correct the highlighted fields.", parsed.error.issues.map((i) => `${i.path.join(".") || "form"}: ${i.message}`));
  }
  const v = parsed.data;
  const location: GeoPoint | null =
    v.lat && v.lat.trim() !== "" && v.lng ? { lat: Number(v.lat), lng: Number(v.lng), precision: v.locationPrecision ?? "approximate" } : null;
  return {
    ok: true,
    fields: {
      name: v.name,
      category: v.category as DevelopmentFields["category"],
      stage: v.stage as DevelopmentFields["stage"],
      authority: v.authority,
      expectedCompletion: v.expectedCompletion,
      announcedDate: v.announcedDate,
      localityIds: v.localityIds,
      location,
      sourceUrl: v.sourceUrl,
      sourceObservedAt: new Date(v.sourceObservedAt).toISOString(),
    },
  };
}

function refuseAutomated(session: StaffSession): DevelopmentError | null {
  return isAutomatedActor(session.userId) ? fail("forbidden", "Automated actors cannot change developments.") : null;
}

const versionSchema = z.coerce.number().int().min(1).max(1_000_000);

export type DevelopmentWriteOk = { development: StaffDevelopment; changed: boolean; autoUnpublished: boolean };

/**
 * Staff manual entry (advisor or admin). The authority and its https page are required; the row
 * starts unpublished and unverified like every other draft.
 */
export async function createDevelopment(raw: FormInput, deps: DevelopmentDeps = {}): Promise<DevelopmentResult<DevelopmentWriteOk>> {
  const { session, repos, actor } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const p = parseFields(raw);
  if (!p.ok) return p;
  if (!p.fields.authority) return fail("validation", "Please correct the highlighted fields.", ["authority: required for a manual entry"]);
  const development = await repos.developments.create({ ...p.fields, sourceId: null }, false, actor);
  log.info("developments.created", { id: development.id, role: session.role });
  return { ok: true, development, changed: true, autoUnpublished: false };
}

/** Staff edit. Advisors may edit unpublished rows only; any content change resets verification. */
export async function updateDevelopment(raw: FormInput, deps: DevelopmentDeps = {}): Promise<DevelopmentResult<DevelopmentWriteOk>> {
  const { session, repos, actor } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const m = toMulti(raw);
  const id = z.string().trim().min(1).max(100).safeParse(m.get("id")?.[0]);
  const version = versionSchema.safeParse(m.get("version")?.[0]);
  if (!id.success || !version.success) return fail("validation", "Invalid edit request.");
  const current = await repos.developments.getForStaff(id.data);
  if (!current) return fail("not_found", "Development not found.");
  if (current.published && session.role !== "admin") return fail("forbidden", "Only an admin can edit a published development.");
  const p = parseFields(raw);
  if (!p.ok) return p;
  const r = await repos.developments.update(id.data, version.data, { ...p.fields, sourceId: current.sourceId }, actor);
  if (!r.ok) return fail(r.error === "duplicate" ? "validation" : r.error, r.message, r.blockers);
  log.info("developments.updated", { id: id.data, role: session.role, changed: r.changed, autoUnpublished: r.autoUnpublished });
  return { ok: true, development: r.development, changed: r.changed, autoUnpublished: r.autoUnpublished };
}

/**
 * Review: publish / unpublish (admin only; publishing re-checks readiness and may mark the source
 * confirmed), reject (with a note) or restore (advisor or admin, not on a published row).
 */
export async function reviewDevelopment(raw: FormInput, deps: DevelopmentDeps = {}): Promise<DevelopmentResult<DevelopmentWriteOk>> {
  const { session, repos, actor } = await staffContext(deps);
  const refused = refuseAutomated(session);
  if (refused) return refused;
  const m = toMulti(raw);
  const parsed = z
    .object({
      id: z.string().trim().min(1).max(100),
      version: versionSchema,
      action: z.enum(["publish", "unpublish", "reject", "restore"]),
      verification: z.enum(["unverified", "source_confirmed"]).optional(),
      note: z.string().max(1000).optional(),
    })
    .safeParse({
      id: m.get("id")?.[0],
      version: m.get("version")?.[0],
      action: m.get("action")?.[0],
      verification: m.get("verification")?.[0] || undefined,
      note: m.get("note")?.[0] || undefined,
    });
  if (!parsed.success) return fail("validation", "Invalid review request.");
  const { id, version, action, verification, note } = parsed.data;
  if ((action === "publish" || action === "unpublish") && session.role !== "admin") return fail("forbidden", "Only an admin can publish or unpublish.");
  const current = await repos.developments.getForStaff(id);
  if (!current) return fail("not_found", "Development not found.");
  if ((action === "reject" || action === "restore") && current.published && session.role !== "admin") {
    return fail("forbidden", "Only an admin can reject a published development.");
  }
  const r = await repos.developments.review(id, version, action as DevelopmentReviewAction, action === "publish" ? (verification ?? "unverified") : null, note?.trim() || null, actor);
  if (!r.ok) return fail(r.error === "duplicate" ? "validation" : r.error, r.message, r.blockers);
  log.info("developments.reviewed", { id, action, role: session.role, changed: r.changed });
  return { ok: true, development: r.development, changed: r.changed, autoUnpublished: false };
}

/** Registry metadata for the source of a row (null for a staff manual entry). */
export function developmentSourceName(sourceId: string | null): string | null {
  return sourceId ? (getSource(sourceId)?.name ?? sourceId) : null;
}
