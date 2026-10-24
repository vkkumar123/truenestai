import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type {
  AuditActor,
  DocumentExtraction,
  DocumentExtractionRepository,
  DocumentObservation,
  FinishExtractionInput,
  StartExtractionResult,
} from "../types";

// document_extractions + extraction RPCs (0007_document_extraction.sql). SERVICE ROLE only (no
// anon/authenticated grants). Errors carry only the Postgres error code; never values or text.

const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);

const extractionRow = z.object({
  id: z.string(),
  document_id: z.string(),
  project_id: z.string(),
  status: z.enum(["running", "succeeded", "failed", "unsupported"]),
  error_code: z.string().nullable(),
  model: z.string().nullable(),
  kept_count: num,
  dropped_count: num,
  dropped_reasons: z.record(z.string(), num).nullable(),
  attempts: num,
  requested_by: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

export function mapExtractionRow(input: unknown): DocumentExtraction {
  const r = extractionRow.parse(input);
  return {
    id: r.id,
    documentId: r.document_id,
    projectId: r.project_id,
    status: r.status,
    errorCode: r.error_code,
    model: r.model,
    keptCount: r.kept_count,
    droppedCount: r.dropped_count,
    droppedReasons: r.dropped_reasons ?? {},
    attempts: r.attempts,
    requestedBy: r.requested_by,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const observationRow = z.object({
  id: z.string(),
  document_id: z.string(),
  entity_id: z.string(),
  attribute: z.string(),
  value_text: z.string().nullable(),
  value_num: num.nullable(),
  value_date: z.string().nullable(),
  value_json: z.array(z.string()).nullable(),
  unit: z.string().nullable(),
  source_type: z.string(),
  observed_at: z.string(),
  last_verified_at: z.string(),
  excerpt: z.string(),
  page_number: num,
});

const OBSERVATION_COLUMNS =
  "id, document_id, entity_id, attribute, value_text, value_num, value_date, value_json, unit, source_type, observed_at, last_verified_at, excerpt, page_number";

export function mapObservationRow(input: unknown): DocumentObservation {
  const r = observationRow.parse(input);
  return {
    id: r.id,
    documentId: r.document_id,
    projectId: r.entity_id,
    attribute: r.attribute,
    valueText: r.value_text,
    valueNum: r.value_num,
    valueDate: r.value_date,
    valueJson: r.value_json,
    unit: r.unit,
    truthStatus: "official",
    sourceType: r.source_type,
    verification: "unverified",
    observedAt: r.observed_at,
    lastVerifiedAt: r.last_verified_at,
    excerpt: r.excerpt,
    pageNumber: r.page_number,
  };
}

export class SupabaseDocumentExtractionRepository implements DocumentExtractionRepository {
  constructor(private readonly db: () => SupabaseClient) {}

  async start(documentId: string, model: string, actor: AuditActor, staleMinutes: number): Promise<StartExtractionResult> {
    const { data, error } = await this.db().rpc("extraction_start", {
      p_document_id: documentId,
      p_model: model,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
      p_stale_minutes: staleMinutes,
    });
    if (error) throw new Error(`extraction_start failed (${error.code ?? "unknown"})`);
    const r = data as { outcome: StartExtractionResult["outcome"]; extraction?: unknown };
    if (r.outcome === "not_found") return { outcome: "not_found" };
    return { outcome: r.outcome, extraction: mapExtractionRow(r.extraction) };
  }

  async finish(extractionId: string, input: FinishExtractionInput, actor: AuditActor): Promise<DocumentExtraction | null> {
    const { data, error } = await this.db().rpc("extraction_finish", {
      p_extraction_id: extractionId,
      p_status: input.status,
      p_error_code: input.errorCode,
      p_values: input.values.map((v) => ({
        attribute: v.attribute,
        value_text: v.valueText,
        value_num: v.valueNum,
        value_date: v.valueDate,
        value_json: v.valueJson,
        page_number: v.pageNumber,
        excerpt: v.excerpt,
      })),
      p_dropped_count: input.droppedCount,
      p_dropped_reasons: input.droppedReasons,
      p_actor_id: actor.actorId,
      p_actor_role: actor.actorRole,
    });
    if (error) throw new Error(`extraction_finish failed (${error.code ?? "unknown"})`);
    const r = data as { status: string; extraction?: unknown };
    return r.status === "ok" ? mapExtractionRow(r.extraction) : null;
  }

  async listForProject(projectId: string): Promise<DocumentExtraction[]> {
    const { data, error } = await this.db()
      .from("document_extractions")
      .select("id, document_id, project_id, status, error_code, model, kept_count, dropped_count, dropped_reasons, attempts, requested_by, started_at, finished_at")
      .eq("project_id", projectId);
    if (error) throw new Error(`document_extractions read failed (${error.code ?? "unknown"})`);
    return (data ?? []).map(mapExtractionRow);
  }

  async listObservationsForProject(projectId: string): Promise<DocumentObservation[]> {
    const { data, error } = await this.db()
      .from("fact_observations")
      .select(OBSERVATION_COLUMNS)
      .eq("entity_type", "project")
      .eq("entity_id", projectId)
      .not("document_id", "is", null)
      .order("attribute", { ascending: true });
    if (error) throw new Error(`document observations read failed (${error.code ?? "unknown"})`);
    return (data ?? []).map(mapObservationRow);
  }
}
