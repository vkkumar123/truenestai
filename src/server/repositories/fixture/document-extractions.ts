import "server-only";
import { randomUUID } from "node:crypto";
import type { Project } from "@/domain/types";
import { documentSourceType, getFactAttribute, type FactCandidateInput } from "../fact-store";
import type {
  AuditActor,
  DocumentExtraction,
  DocumentExtractionRepository,
  DocumentObservation,
  FinishExtractionInput,
  StartExtractionResult,
} from "../types";
import type { FixtureResearchRepository } from "./research";

/**
 * DEV ONLY, in memory. Mirrors 0007's extraction_start / extraction_finish: one extraction per
 * document version, final once succeeded or unsupported, observations upserted by
 * (project, attribute, document) and appended to the shared fixture fact-store list so
 * facts_current (and its conflicts) sees them. Each finish commits in one synchronous step.
 */
export class FixtureDocumentExtractionRepository implements DocumentExtractionRepository {
  private readonly extractions = new Map<string, DocumentExtraction>(); // by document id
  private readonly observations: DocumentObservation[] = [];

  constructor(
    private readonly research: FixtureResearchRepository,
    private readonly store: readonly Project[],
    /** Shared with FixtureFactStoreRepository. */
    private readonly factObservations: FactCandidateInput[],
  ) {}

  async start(documentId: string, model: string, actor: AuditActor, staleMinutes: number): Promise<StartExtractionResult> {
    const doc = await this.research.getDocumentForStaff(documentId);
    if (!doc) return { outcome: "not_found" };
    const now = new Date();
    const existing = this.extractions.get(documentId);
    if (existing && (existing.status === "succeeded" || existing.status === "unsupported")) return { outcome: "done", extraction: { ...existing } };
    if (existing?.status === "running" && Date.parse(existing.startedAt) > now.getTime() - Math.max(staleMinutes, 1) * 60_000) {
      return { outcome: "in_progress", extraction: { ...existing } };
    }
    const next: DocumentExtraction = {
      id: existing?.id ?? randomUUID(),
      documentId,
      projectId: doc.projectId,
      status: "running",
      errorCode: null,
      model,
      keptCount: 0,
      droppedCount: 0,
      droppedReasons: {},
      attempts: (existing?.attempts ?? 0) + 1,
      requestedBy: actor.actorId,
      startedAt: now.toISOString(),
      finishedAt: null,
    };
    this.extractions.set(documentId, next);
    return { outcome: "started", extraction: { ...next } };
  }

  async finish(extractionId: string, input: FinishExtractionInput, actor: AuditActor): Promise<DocumentExtraction | null> {
    const current = [...this.extractions.values()].find((e) => e.id === extractionId);
    if (!current || current.status !== "running") return null;
    const doc = await this.research.getDocumentForStaff(current.documentId);
    if (!doc) return null;
    const project = this.store.find((p) => p.id === doc.projectId);
    const now = new Date().toISOString();
    const built: DocumentObservation[] = [];
    if (input.status === "succeeded") {
      const sourceType = documentSourceType(doc.source.sourceId);
      if (!sourceType) throw new Error("only regulator or fixture documents can be extracted");
      // mirrors extraction_finish (0007): constitution §1, and one value per attribute
      if (!doc.source.url) throw new Error("a document without a source URL cannot be extracted as succeeded");
      if (new Set(input.values.map((v) => v.attribute)).size !== input.values.length) throw new Error("duplicate attribute in extraction values");
      for (const v of input.values) {
        const attr = getFactAttribute("project", v.attribute);
        if (!attr) throw new Error(`unknown attribute ${v.attribute}`);
        const prev = this.observations.find((o) => o.documentId === doc.id && o.attribute === v.attribute);
        built.push({
          ...v,
          id: prev?.id ?? randomUUID(),
          documentId: doc.id,
          projectId: doc.projectId,
          unit: null,
          truthStatus: "official",
          sourceType,
          verification: "unverified",
          observedAt: doc.source.observedAt,
          lastVerifiedAt: now > doc.source.observedAt ? now : doc.source.observedAt,
        });
      }
    }
    const finished: DocumentExtraction = {
      ...current,
      status: input.status,
      errorCode: input.status === "succeeded" ? null : input.errorCode,
      keptCount: built.length,
      droppedCount: Math.max(0, input.droppedCount),
      droppedReasons: { ...input.droppedReasons },
      finishedAt: now,
    };
    // --- commit (synchronous) ---
    for (const o of built) {
      const i = this.observations.findIndex((x) => x.id === o.id);
      if (i >= 0) this.observations[i] = o;
      else this.observations.push(o);
      const attr = getFactAttribute("project", o.attribute)!;
      const candidate: FactCandidateInput = {
        entity_type: "project",
        entity_id: o.projectId,
        attribute: o.attribute,
        origin: "observation",
        fact_id: o.id,
        value_text: o.valueText,
        value_num: o.valueNum,
        value_date: o.valueDate,
        value_json: o.valueJson,
        unit: null,
        truth_status: "official",
        verification: "unverified",
        confidence: null,
        estimate_basis: null,
        source_id: doc.source.sourceId,
        source_url: doc.source.url,
        source_type: o.sourceType,
        observed_at: o.observedAt,
        last_verified_at: o.lastVerifiedAt,
        ttl_hours: attr.defaultTtlHours,
        excerpt: o.excerpt,
        added_by: "extraction",
        is_sample: project?.isSample ?? false,
      };
      const j = this.factObservations.findIndex((x) => x.fact_id === o.id);
      if (j >= 0) this.factObservations[j] = candidate;
      else this.factObservations.push(candidate);
    }
    this.extractions.set(current.documentId, finished);
    this.research.recordDocumentEvent(
      doc.projectId,
      `document extraction ${input.status}: ${doc.title} v${doc.version}, ${built.length} value(s) kept, ${finished.droppedCount} dropped` +
        (input.status === "succeeded" ? "" : ` (${input.errorCode ?? "error"})`),
      actor,
    );
    return { ...finished };
  }

  async listForProject(projectId: string): Promise<DocumentExtraction[]> {
    return [...this.extractions.values()].filter((e) => e.projectId === projectId).map((e) => ({ ...e, droppedReasons: { ...e.droppedReasons } }));
  }

  async listObservationsForProject(projectId: string): Promise<DocumentObservation[]> {
    return this.observations.filter((o) => o.projectId === projectId).map((o) => structuredClone(o));
  }
}
