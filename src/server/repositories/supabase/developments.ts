import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  DeclaredCompletionRevision,
  Development,
  GeoPoint,
  InfrastructureCategory,
  InfrastructureStage,
  VerificationState,
} from "@/domain/types";
import {
  DEVELOPMENT_CONFLICT_MESSAGE,
  type AuditActor,
  type DevelopmentAuditEntry,
  type DevelopmentFields,
  type DevelopmentPendingChange,
  type DevelopmentRepository,
  type DevelopmentReviewAction,
  type DevelopmentWriteResult,
  type StaffDevelopment,
  type StoreResearchedDevelopmentsInput,
} from "../types";

/** Columns anon may read (0008 column grant). */
const PUBLIC_COLUMNS =
  "id, name, category, stage, authority, announced_date, expected_completion, completion_history, locality_ids, lat, lng, location_precision, source_id, source_url, source_observed_at, last_checked_at, verification, added_by, is_sample, published";
const STAFF_COLUMNS = `${PUBLIC_COLUMNS}, rejected_at, rejection_note, pending_change, research_job_id, research_locality_id, version, created_at, updated_at`;

interface Row {
  id: string;
  name: string;
  category: InfrastructureCategory;
  stage: InfrastructureStage;
  authority: string | null;
  announced_date: string | null;
  expected_completion: string | null;
  completion_history: { date_claimed: string; as_of: string; source_url: string | null }[] | null;
  locality_ids: string[] | null;
  lat: number | string | null;
  lng: number | string | null;
  location_precision: GeoPoint["precision"] | null;
  source_id: string | null;
  source_url: string | null;
  source_observed_at: string | null;
  last_checked_at: string;
  verification: VerificationState;
  added_by: "research" | "staff" | null;
  is_sample: boolean;
  published: boolean;
  rejected_at?: string | null;
  rejection_note?: string | null;
  pending_change?: { stage?: InfrastructureStage | null; authority?: string | null; expectedCompletion?: string | null; observedAt?: string | null } | null;
  research_job_id?: string | null;
  research_locality_id?: string | null;
  version?: number;
  created_at?: string;
  updated_at?: string;
}

function history(r: Row): DeclaredCompletionRevision[] {
  return (r.completion_history ?? []).map((h) => ({ expectedCompletion: h.date_claimed, asOf: h.as_of, sourceUrl: h.source_url ?? null }));
}

export function mapDevelopmentRow(r: Row): Development {
  const location: GeoPoint | null =
    r.lat !== null && r.lng !== null && r.location_precision ? { lat: Number(r.lat), lng: Number(r.lng), precision: r.location_precision } : null;
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    stage: r.stage,
    authority: r.authority,
    expectedCompletion: r.expected_completion,
    announcedDate: r.announced_date,
    completionHistory: history(r),
    localityIds: r.locality_ids ?? [],
    location,
    sourceId: r.source_id,
    sourceUrl: r.source_url,
    sourceObservedAt: r.source_observed_at,
    lastCheckedAt: r.last_checked_at,
    verification: r.verification,
    // Legacy (pre-S4a) rows have no added_by; they were entered by hand.
    addedBy: r.added_by ?? "staff",
    isSample: r.is_sample,
  };
}

function mapStaffRow(r: Row): StaffDevelopment {
  const pc = r.pending_change;
  const pendingChange: DevelopmentPendingChange | null = pc
    ? { stage: pc.stage ?? null, authority: pc.authority ?? null, expectedCompletion: pc.expectedCompletion ?? null, observedAt: pc.observedAt ?? null }
    : null;
  return {
    ...mapDevelopmentRow(r),
    published: r.published,
    reviewStatus: r.published ? "published" : r.rejected_at ? "rejected" : "pending",
    rejectionNote: r.rejection_note ?? null,
    pendingChange,
    researchJobId: r.research_job_id ?? null,
    researchLocalityId: r.research_locality_id ?? null,
    version: r.version ?? 1,
    createdAt: r.created_at ?? r.last_checked_at,
    updatedAt: r.updated_at ?? r.last_checked_at,
  };
}

function fieldsJson(f: DevelopmentFields) {
  return {
    name: f.name,
    category: f.category,
    stage: f.stage,
    authority: f.authority ?? "",
    expectedCompletion: f.expectedCompletion ?? "",
    announcedDate: f.announcedDate ?? "",
    localityIds: f.localityIds,
    lat: f.location ? String(f.location.lat) : "",
    lng: f.location ? String(f.location.lng) : "",
    locationPrecision: f.location?.precision ?? "",
    sourceId: f.sourceId ?? "",
    sourceUrl: f.sourceUrl ?? "",
    sourceObservedAt: f.sourceObservedAt,
  };
}

const fail = (what: string, error: { code?: string } | null) => new Error(`${what} failed: ${error?.code ?? "unknown"}`);

/**
 * listPublished uses the anon client (RLS: published rows and granted columns only); every other
 * method uses the service role and must only be reached through staff-gated services or the worker.
 */
export class SupabaseDevelopmentRepository implements DevelopmentRepository {
  constructor(
    private readonly anon: SupabaseClient,
    private readonly db: () => SupabaseClient,
  ) {}

  async listPublished(): Promise<Development[]> {
    const { data, error } = await this.anon.from("infrastructure_items").select(PUBLIC_COLUMNS).eq("published", true).order("name").limit(500);
    if (error) throw fail("listPublished", error);
    return ((data ?? []) as unknown as Row[]).map(mapDevelopmentRow);
  }

  async listForStaff(filter: { localityId?: string; limit?: number }): Promise<StaffDevelopment[]> {
    let q = this.db().from("infrastructure_items").select(STAFF_COLUMNS);
    if (filter.localityId) {
      if (!/^[a-z0-9-]{1,80}$/.test(filter.localityId)) return [];
      q = q.or(`locality_ids.cs.{${filter.localityId}},research_locality_id.eq.${filter.localityId}`);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).limit(Math.max(1, Math.min(500, filter.limit ?? 200)));
    if (error) throw fail("listForStaff", error);
    return ((data ?? []) as unknown as Row[]).map(mapStaffRow);
  }

  async getForStaff(id: string): Promise<StaffDevelopment | null> {
    const { data, error } = await this.db().from("infrastructure_items").select(STAFF_COLUMNS).eq("id", id).maybeSingle();
    if (error) throw fail("getForStaff", error);
    return data ? mapStaffRow(data as unknown as Row) : null;
  }

  async storeResearched(input: StoreResearchedDevelopmentsInput): Promise<string[]> {
    const { data, error } = await this.db().rpc("development_store_research", {
      p_job_id: input.jobId,
      p_research_locality_id: input.researchLocalityId,
      p_source_id: input.sourceId,
      p_observed_at: input.observedAt,
      p_is_sample: input.isSample,
      p_items: input.items,
    });
    if (error) throw fail("development_store_research", error);
    return (data ?? []) as string[];
  }

  async create(fields: DevelopmentFields, isSample: boolean, actor: AuditActor): Promise<StaffDevelopment> {
    const { data, error } = await this.db().rpc("development_create", {
      p_fields: fieldsJson(fields),
      p_is_sample: isSample,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
    });
    if (error) throw fail("development_create", error);
    const created = await this.getForStaff((data as { id: string }).id);
    if (!created) throw new Error("development_create failed: missing row");
    return created;
  }

  private async result(id: string, r: { status: string; auto_unpublished?: boolean; blockers?: string[] }): Promise<DevelopmentWriteResult> {
    if (r.status === "not_found") return { ok: false, error: "not_found", message: "Development not found." };
    if (r.status === "conflict") return { ok: false, error: "conflict", message: DEVELOPMENT_CONFLICT_MESSAGE };
    if (r.status === "not_ready") return { ok: false, error: "not_ready", message: "Not ready to publish.", blockers: r.blockers ?? [] };
    const development = await this.getForStaff(id);
    if (!development) return { ok: false, error: "not_found", message: "Development not found." };
    return { ok: true, development, changed: r.status === "ok", autoUnpublished: r.auto_unpublished === true };
  }

  async update(id: string, expectedVersion: number, fields: DevelopmentFields, actor: AuditActor): Promise<DevelopmentWriteResult> {
    const { data, error } = await this.db().rpc("development_update", {
      p_id: id,
      p_expected_version: expectedVersion,
      p_fields: fieldsJson(fields),
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
    });
    if (error?.code === "23505") return { ok: false, error: "duplicate", message: "Another researched development has this name and source link." };
    if (error) throw fail("development_update", error);
    return this.result(id, data as { status: string });
  }

  async review(
    id: string,
    expectedVersion: number,
    action: DevelopmentReviewAction,
    verification: "unverified" | "source_confirmed" | null,
    note: string | null,
    actor: AuditActor,
  ): Promise<DevelopmentWriteResult> {
    const { data, error } = await this.db().rpc("development_set_review", {
      p_id: id,
      p_expected_version: expectedVersion,
      p_action: action,
      p_verification: verification,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
      p_note: note,
    });
    if (error) throw fail("development_set_review", error);
    return this.result(id, data as { status: string });
  }

  async listAudit(id: string): Promise<DevelopmentAuditEntry[]> {
    const { data, error } = await this.db()
      .from("infrastructure_review_events")
      .select("id, development_id, action, from_verification, to_verification, actor_id, actor_role, at, note")
      .eq("development_id", id)
      .order("at")
      .order("id");
    if (error) throw fail("listAudit", error);
    return ((data ?? []) as Record<string, unknown>[]).map((e) => ({
      id: String(e.id),
      developmentId: e.development_id as string,
      action: e.action as DevelopmentAuditEntry["action"],
      fromVerification: (e.from_verification as VerificationState | null) ?? null,
      toVerification: (e.to_verification as VerificationState | null) ?? null,
      actorId: e.actor_id as string,
      actorRole: e.actor_role as DevelopmentAuditEntry["actorRole"],
      at: e.at as string,
      note: (e.note as string | null) ?? null,
    }));
  }
}
