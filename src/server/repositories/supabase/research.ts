import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Developer, FactAuditEvent, FactValue, Project, ResearchFactField, VerificationState } from "@/domain/types";
import { getLocality, isActiveLocality } from "@/config/markets";
import { factVersion } from "@/research/verification";
import {
  CONFLICT_MESSAGE,
  type AddDocumentResult,
  type AuditActor,
  type NewDocumentRecord,
  type NewProjectInput,
  type PublishWriteResult,
  type ResearchRepository,
  type ResearchWriteResult,
  type StaffAuditEntry,
  type StoredDocument,
} from "../types";
import { slugify, uniqueSlug } from "../slug";
import { mapProjectRow, PROJECT_SELECT, toFact, type FactRow, type ProjectRow } from "./mappers";

export const DB_FACT_FIELD: Record<ResearchFactField, string> = {
  address: "address",
  reraNumbers: "rera_numbers",
  constructionStatus: "construction_status",
  declaredPossession: "declared_possession",
};

interface AuditRow {
  id: string;
  project_id: string;
  field: FactAuditEvent["field"];
  action: FactAuditEvent["action"];
  from_verification: VerificationState | null;
  to_verification: VerificationState | null;
  actor_id: string;
  actor_role: FactAuditEvent["actorRole"];
  at: string;
  note: string | null;
}

type RpcStatus = { status: "ok" | "not_found" | "conflict" | "unchanged" | "not_ready"; auto_unpublished?: boolean; blockers?: string[] };

const NOT_FOUND = { ok: false, error: "not_found", message: "Project not found." } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SERVICE-ROLE staff write model (bypasses RLS: sees unpublished projects). Server-only; callers
 * enforce staff roles. Every write is ONE SQL transaction via the research_* functions in
 * 0002_research_audit.sql / 0003_m2_live.sql (change + audit + auto-unpublish, readiness re-checked under a row lock).
 * Not exercised against a live Supabase yet (no credentials); the SQL is covered by `npm run test:db`.
 */
export class SupabaseResearchRepository implements ResearchRepository {
  constructor(private readonly db: () => SupabaseClient) {}

  private async rpc(fn: string, args: Record<string, unknown>): Promise<RpcStatus> {
    const { data, error } = await this.db().rpc(fn, args);
    if (error) throw new Error(`${fn} failed (${error.code ?? "unknown"})`);
    return data as RpcStatus;
  }

  async listAllProjects(): Promise<Project[]> {
    const { data, error } = await this.db().from("projects").select(PROJECT_SELECT).order("name").limit(500);
    if (error) throw new Error(`listAllProjects failed: ${error.message}`);
    return (data as unknown as ProjectRow[]).map(mapProjectRow);
  }

  async getProjectByIdForStaff(id: string): Promise<Project | null> {
    const { data, error } = await this.db().from("projects").select(PROJECT_SELECT).eq("id", id).maybeSingle();
    if (error) throw new Error(`getProjectByIdForStaff failed: ${error.message}`);
    return data ? mapProjectRow(data as unknown as ProjectRow) : null;
  }

  async listDevelopers(): Promise<Developer[]> {
    const { data, error } = await this.db().from("developers").select("id, name, is_sample").order("name").limit(1000);
    if (error) throw new Error(`listDevelopers failed: ${error.message}`);
    return (data as { id: string; name: string; is_sample: boolean }[]).map((d) => ({ id: d.id, name: d.name, isSample: d.is_sample }));
  }

  async createProject(input: NewProjectInput, actor: AuditActor): Promise<Project> {
    if (!isActiveLocality(input.localityId)) throw new Error("Locality is not active.");
    const loc = getLocality(input.localityId)!;
    const base = slugify(`${input.name} ${loc.name}`);
    const hasPoint = input.lat !== undefined && input.lng !== undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const taken = await this.db().from("projects").select("slug").like("slug", `${base}%`);
      if (taken.error) throw new Error(`slug lookup failed: ${taken.error.message}`);
      const slug = uniqueSlug(base, new Set((taken.data as { slug: string }[]).map((r) => r.slug)));
      const { data, error } = await this.db().rpc("research_create_project", {
        p_slug: slug,
        p_name: input.name.trim(),
        p_developer_id: input.developerId ?? null,
        p_developer_name: input.developerId ? null : (input.developerName ?? "").trim(),
        p_locality_id: input.localityId,
        p_lat: hasPoint ? input.lat : loc.centroid.lat,
        p_lng: hasPoint ? input.lng : loc.centroid.lng,
        p_precision: hasPoint ? "approximate" : "locality_centroid",
        p_actor_id: actor.actorId,
        p_actor_role: actor.actorRole,
      });
      if (error?.code === "23505") continue; // slug taken concurrently: retry
      if (error) throw new Error(`createProject failed (${error.code ?? "unknown"})`);
      const project = await this.getProjectByIdForStaff(data as string);
      if (!project) throw new Error("createProject: inserted row not readable");
      return project;
    }
    throw new Error("createProject failed: could not allocate a unique slug");
  }

  async setFact(projectId: string, field: ResearchFactField, fact: FactValue<unknown>, actor: AuditActor): Promise<ResearchWriteResult> {
    // Completeness is recomputed inside the RPC from the committed state (R2, tn_compute_completeness).
    const r = await this.rpc("research_set_fact", {
      p_project_id: projectId,
      p_field: DB_FACT_FIELD[field],
      p_status: fact.status,
      p_value: fact.status === "known" ? fact.value : null,
      p_verification: fact.verification,
      p_sources: fact.sources,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
    });
    if (r.status === "not_found") return NOT_FOUND;
    const project = await this.getProjectByIdForStaff(projectId);
    return project ? { ok: true, project, autoUnpublished: r.auto_unpublished === true } : NOT_FOUND;
  }

  async setFactVerification(
    projectId: string,
    field: ResearchFactField,
    to: VerificationState,
    expectedVersion: string,
    actor: AuditActor,
    note: string | null,
    expectedFrom?: VerificationState,
  ): Promise<ResearchWriteResult> {
    const { data, error } = await this.db()
      .from("facts")
      .select("id, unit_id, field, value, status, verification, is_current, fact_sources(source_id, url, observed_at, document_date, note)")
      .eq("project_id", projectId)
      .eq("field", DB_FACT_FIELD[field])
      .is("unit_id", null)
      .eq("is_current", true)
      .maybeSingle();
    if (error) throw new Error(`fact lookup failed (${error.code ?? "unknown"})`);
    if (!data) return { ok: false, error: "conflict", message: CONFLICT_MESSAGE };
    const row = data as FactRow;
    if (factVersion(toFact(row)) !== expectedVersion) return { ok: false, error: "conflict", message: CONFLICT_MESSAGE };
    if (expectedFrom !== undefined && row.verification !== expectedFrom) {
      return { ok: false, error: "conflict", message: CONFLICT_MESSAGE };
    }
    // R1: the RPC re-checks, under the row lock, that this exact fact row is still current AND
    // its verification is still the one read here → 'conflict' if either changed meanwhile.
    const r = await this.rpc("research_set_verification", {
      p_project_id: projectId,
      p_field: DB_FACT_FIELD[field],
      p_fact_id: row.id,
      p_expected_from: row.verification,
      p_to: to,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
      p_note: note,
    });
    if (r.status === "not_found") return NOT_FOUND;
    if (r.status === "conflict") return { ok: false, error: "conflict", message: CONFLICT_MESSAGE };
    const project = await this.getProjectByIdForStaff(projectId);
    return project ? { ok: true, project, autoUnpublished: r.auto_unpublished === true } : NOT_FOUND;
  }

  async setPublished(projectId: string, published: boolean, actor: AuditActor): Promise<PublishWriteResult> {
    const r = await this.rpc("research_set_published", {
      p_project_id: projectId,
      p_published: published,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
    });
    if (r.status === "not_found") return NOT_FOUND;
    if (r.status === "not_ready") {
      return { ok: false, error: "not_ready", message: "This project is not ready to publish.", blockers: r.blockers ?? [] };
    }
    const project = await this.getProjectByIdForStaff(projectId);
    if (!project) return NOT_FOUND;
    return { ok: true, project, changed: r.status === "ok" };
  }

  async listAudit(projectId: string): Promise<StaffAuditEntry[]> {
    const { data, error } = await this.db()
      .from("fact_review_events")
      .select("*")
      .eq("project_id", projectId)
      .order("at", { ascending: true });
    if (error) throw new Error(`listAudit failed (${error.code ?? "unknown"})`);
    const rows = data as AuditRow[];
    const ids = [...new Set(rows.map((r) => r.actor_id).filter((id) => UUID.test(id)))];
    const names = new Map<string, string>();
    if (ids.length) {
      const profiles = await this.db().from("staff_profiles").select("user_id, display_name").in("user_id", ids);
      if (profiles.error) throw new Error(`staff names failed (${profiles.error.code ?? "unknown"})`);
      for (const p of profiles.data as { user_id: string; display_name: string | null }[]) {
        if (p.display_name) names.set(p.user_id, p.display_name);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      field: r.field,
      action: r.action,
      fromVerification: r.from_verification,
      toVerification: r.to_verification,
      actorId: r.actor_id,
      actorRole: r.actor_role,
      at: r.at,
      note: r.note,
      actorName: names.get(r.actor_id) ?? r.actor_id,
    }));
  }

  async nextDocumentVersion(projectId: string, documentKey: string): Promise<number> {
    const { data, error } = await this.db()
      .from("project_documents")
      .select("version")
      .eq("project_id", projectId)
      .eq("document_key", documentKey)
      .order("version", { ascending: false })
      .limit(1);
    if (error) throw new Error(`document version lookup failed (${error.code ?? "unknown"})`);
    const top = (data as { version: number }[])[0];
    return top ? top.version + 1 : 1;
  }

  async addDocument(record: NewDocumentRecord, actor: AuditActor): Promise<AddDocumentResult> {
    // research_add_document (0003_m2_live.sql): project lock + version check + row + audit, one transaction.
    const { data, error } = await this.db().rpc("research_add_document", {
      p_project_id: record.projectId,
      p_document_key: record.documentKey,
      p_title: record.title,
      p_kind: record.kind,
      p_document_date: record.documentDate,
      p_source_id: record.sourceId,
      p_source_url: record.sourceUrl,
      p_storage_path: record.storagePath,
      p_content_type: record.contentType,
      p_size_bytes: record.sizeBytes,
      p_sha256: record.sha256,
      p_version: record.version,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
    });
    if (error) throw new Error(`research_add_document failed (${error.code ?? "unknown"})`);
    const r = data as { status: "ok" | "not_found" | "conflict"; id?: string };
    if (r.status === "not_found") return NOT_FOUND;
    if (r.status === "conflict") {
      return { ok: false, error: "conflict", message: "Another upload of this document finished first — reload and try again." };
    }
    const doc = await this.getDocumentForStaff(r.id!);
    if (!doc) throw new Error("addDocument: inserted row not readable");
    return { ok: true, document: doc };
  }

  async getDocumentForStaff(documentId: string): Promise<StoredDocument | null> {
    const { data, error } = await this.db()
      .from("project_documents")
      .select("id, project_id, document_key, title, kind, version, document_date, source_id, source_url, observed_at, storage_path, content_type, size_bytes, sha256")
      .eq("id", documentId)
      .maybeSingle();
    if (error) throw new Error(`document lookup failed (${error.code ?? "unknown"})`);
    if (!data) return null;
    const d = data as {
      id: string; project_id: string; document_key: string; title: string; kind: StoredDocument["kind"]; version: number;
      document_date: string | null; source_id: string; source_url: string | null; observed_at: string; storage_path: string | null;
      content_type: StoredDocument["contentType"]; size_bytes: number | string | null; sha256: string | null;
    };
    return {
      id: d.id,
      title: d.title,
      kind: d.kind,
      version: d.version,
      documentDate: d.document_date,
      source: { sourceId: d.source_id, url: d.source_url, observedAt: d.observed_at, documentDate: d.document_date },
      projectId: d.project_id,
      documentKey: d.document_key,
      storagePath: d.storage_path,
      contentType: d.content_type,
      sizeBytes: d.size_bytes === null ? null : Number(d.size_bytes),
      sha256: d.sha256,
    };
  }
}
