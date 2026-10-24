import "server-only";
import { z } from "zod";
import type { ResearchFactField } from "@/domain/types";
import { getSource } from "@/discovery/registry";
import { isAutomatedActor } from "@/research/evidence";
import {
  EXTRACTION_ATTRIBUTES,
  ExtractionClientError,
  FakeExtractionClient,
  estimatePdfPageCount,
  isPdf,
  validateExtraction,
  type ExtractionClient,
  type ExtractionErrorCode,
} from "@/research/extraction";
import { requireStaff, type StaffSession } from "../auth";
import { anthropicModel, isProduction } from "../env";
import { AnthropicExtractionClient } from "../integrations/anthropic-extraction-client";
import { log } from "../log";
import {
  getRepositories,
  type AuditActor,
  type CurrentFact,
  type DocumentExtraction,
  type DocumentObservation,
  type Repositories,
  type StoredDocument,
} from "../repositories";
import { documentSourceType } from "../repositories/fact-store";
import { MAX_DOCUMENT_BYTES, sha256Hex } from "../storage/documents";

// K-RERA document extraction (S3a, D19). Owner decision 2026-10-24: K-RERA documents reach
// TrueNest only by staff upload; Claude reads each uploaded PDF and extracts project details with
// page citations for staff review. TrueNest never accesses K-RERA itself (D16).
//
// Staff only (requireStaff; automated actors refused). One extraction per document version
// (idempotent). Each value is kept only if it appears verbatim in a citation's cited_text and
// holds no personal data (src/research/extraction/validate.ts); it is stored as an UNVERIFIED,
// official, rera observation with its page + a <= 20-word excerpt. Nothing here raises
// verification or publishes anything. Logs carry ids, codes and counts only — never document
// text, values, titles or file names.

export const EXTRACTION_TIMEOUT_MS = 120_000;
export const EXTRACTION_MAX_BYTES = MAX_DOCUMENT_BYTES; // 15 MB (also the upload limit)
export const EXTRACTION_MAX_PAGES = 100;
/** A running extraction older than this (well past the 120 s timeout) may be claimed again. */
export const EXTRACTION_STALE_MINUTES = 10;

/** Failure codes that are final for a document version (it never changes). */
const UNSUPPORTED: ReadonlySet<ExtractionErrorCode> = new Set(["not_pdf", "too_large", "too_many_pages", "source_not_supported", "source_url_missing"]);

export interface ExtractionDeps {
  repos?: Repositories;
  requireStaff?: () => Promise<StaffSession>;
  client?: ExtractionClient;
  timeoutMs?: number;
}

export type ExtractDocumentOutcome = "succeeded" | "failed" | "unsupported" | "already_done" | "in_progress";
export type ExtractDocumentResult =
  | { ok: true; outcome: ExtractDocumentOutcome; extraction: DocumentExtraction }
  | { ok: false; error: "forbidden" | "not_found"; message: string };

/** The real client for Supabase mode; the network-free fake for fixture mode (like research). */
export function extractionClientFor(backend: Repositories["backend"]): ExtractionClient {
  return backend === "supabase" ? new AnthropicExtractionClient() : new FakeExtractionClient();
}

/** Pre-checks that need no model call. null = extractable. */
function unsupportedReason(doc: StoredDocument, production: boolean): ExtractionErrorCode | null {
  if (doc.contentType !== "application/pdf") return "not_pdf"; // no OCR in v1
  const source = getSource(doc.source.sourceId);
  if (!documentSourceType(doc.source.sourceId) || !source) return "source_not_supported";
  if (source.type === "fixture" && production) return "source_not_supported";
  // constitution §1 / D19: every extracted value cites the document's source page; none → no values
  if (!doc.source.url) return "source_url_missing";
  if (doc.sizeBytes !== null && doc.sizeBytes > EXTRACTION_MAX_BYTES) return "too_large";
  return null;
}

/**
 * Runs (or returns the existing) extraction of one uploaded document version. Every model call
 * ends in finish() (succeeded / failed / unsupported), which also writes the audit event.
 */
export async function extractDocument(documentId: string, deps: ExtractionDeps = {}): Promise<ExtractDocumentResult> {
  const session = await (deps.requireStaff ?? requireStaff)();
  if (isAutomatedActor(session.userId)) return { ok: false, error: "forbidden", message: "Automated actors cannot run document extraction." };
  const id = z.string().trim().min(1).max(100).safeParse(documentId);
  if (!id.success) return { ok: false, error: "not_found", message: "Document not found." };
  const repos = deps.repos ?? getRepositories();
  const actor: AuditActor = { actorId: session.userId, actorRole: session.role };

  const doc = await repos.research.getDocumentForStaff(id.data);
  if (!doc) return { ok: false, error: "not_found", message: "Document not found." };

  let client: ExtractionClient | null = deps.client ?? null;
  let clientError: ExtractionErrorCode | null = null;
  if (!client) {
    try {
      client = extractionClientFor(repos.backend);
    } catch {
      clientError = "config"; // e.g. ANTHROPIC_API_KEY unset; recorded as a failed extraction
    }
  }
  const model = client?.model ?? (repos.backend === "supabase" ? safeModel() : "fake-extraction-model");

  const started = await repos.documentExtractions.start(doc.id, model, actor, EXTRACTION_STALE_MINUTES);
  if (started.outcome === "not_found") return { ok: false, error: "not_found", message: "Document not found." };
  if (started.outcome === "done") return { ok: true, outcome: "already_done", extraction: started.extraction };
  if (started.outcome === "in_progress") return { ok: true, outcome: "in_progress", extraction: started.extraction };
  const extraction = started.extraction;
  const ctx = { projectId: doc.projectId, documentId: doc.id, role: session.role };

  const end = async (status: "failed" | "unsupported", code: ExtractionErrorCode): Promise<ExtractDocumentResult> => {
    const finished = await repos.documentExtractions.finish(extraction.id, { status, errorCode: code, values: [], droppedCount: 0, droppedReasons: {} }, actor);
    log.warn("documents.extraction_not_completed", { ...ctx, status, code });
    return { ok: true, outcome: status, extraction: finished ?? { ...extraction, status, errorCode: code } };
  };

  try {
    const pre = unsupportedReason(doc, isProduction());
    if (pre) return await end("unsupported", pre);
    if (clientError || !client) return await end("failed", clientError ?? "config");
    if (!doc.storagePath) return await end("failed", "file_missing");
    const obj = await repos.documentStorage.read(doc.storagePath);
    if (!obj) return await end("failed", "file_missing");
    if (!isPdf(obj.bytes) || obj.contentType !== "application/pdf") return await end("unsupported", "not_pdf");
    if (obj.bytes.byteLength > EXTRACTION_MAX_BYTES) return await end("unsupported", "too_large");
    if (doc.sha256 && sha256Hex(obj.bytes) !== doc.sha256) return await end("failed", "checksum_mismatch");
    if (estimatePdfPageCount(obj.bytes) > EXTRACTION_MAX_PAGES) return await end("unsupported", "too_many_pages");

    let response;
    try {
      response = await client.extract({ pdf: obj.bytes, signal: AbortSignal.timeout(deps.timeoutMs ?? EXTRACTION_TIMEOUT_MS) });
    } catch (e) {
      const code = e instanceof ExtractionClientError ? e.code : e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError") ? "timeout" : "unknown";
      return await end(UNSUPPORTED.has(code) ? "unsupported" : "failed", code);
    }
    if (response.stopReason === "refusal") return await end("failed", "refused");
    // a cut-off answer may have lost values or split a line: record nothing, staff can retry
    if (response.stopReason === "max_tokens") return await end("failed", "truncated");

    const result = validateExtraction(response.content);
    const finished = await repos.documentExtractions.finish(
      extraction.id,
      { status: "succeeded", errorCode: null, values: result.kept, droppedCount: result.droppedCount, droppedReasons: result.dropped },
      actor,
    );
    log.info("documents.extracted", {
      ...ctx,
      kept: result.kept.length,
      dropped: result.droppedCount,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });
    return { ok: true, outcome: "succeeded", extraction: finished ?? { ...extraction, status: "succeeded" } };
  } catch (e) {
    // Unexpected (storage or DB error): best effort to record the failure, then surface it.
    log.error("documents.extraction_error", { ...ctx, reason: e instanceof Error ? e.name : "unknown" });
    await repos.documentExtractions
      .finish(extraction.id, { status: "failed", errorCode: "unknown", values: [], droppedCount: 0, droppedReasons: {} }, actor)
      .catch(() => {});
    throw e;
  }
}

function safeModel(): string {
  try {
    return anthropicModel();
  } catch {
    return "unconfigured";
  }
}

// ---------------------------------------------------------------------------
// Staff read model for the admin project page
// ---------------------------------------------------------------------------

/** Curated fields an extracted attribute may be promoted to through the existing audited edit. */
const PROMOTABLE: Record<string, ResearchFactField> = { address: "address", rera_numbers: "reraNumbers" };

export interface ExtractedValueView {
  observationId: string;
  attribute: string;
  label: string;
  /** Human-readable value, exactly as stored (dates as ISO). */
  display: string;
  pageNumber: number;
  excerpt: string;
  /** Always "unverified": nothing extracted is reviewed. */
  verification: "unverified";
  /** Another live value for this attribute disagrees (facts_current). */
  conflict: { winner: "this" | "other"; otherDisplay: string | null; otherSourceType: string | null; otherCount: number } | null;
  /** Promotion to a curated fact (existing audited edit; saved unverified). null when not mappable. */
  promote: {
    field: ResearchFactField;
    values: string[];
    source: { sourceId: string; url: string; observedAt: string; documentDate: string | null; note: string };
  } | null;
  /** Why promotion is not offered, when the attribute maps but something is missing. */
  promoteBlocked: string | null;
}

export interface DocumentExtractionView {
  extraction: DocumentExtraction | null;
  values: ExtractedValueView[];
}

const labelOf = (attribute: string) => EXTRACTION_ATTRIBUTES.find((a) => a.attribute === attribute)?.label ?? attribute;

function displayObservation(o: Pick<DocumentObservation, "valueText" | "valueNum" | "valueDate" | "valueJson" | "attribute">): string {
  if (o.valueJson) return o.valueJson.join("; ");
  if (o.valueDate) return o.valueDate;
  if (o.valueNum !== null) return o.attribute === "land_area_acres" ? `${o.valueNum} acres` : String(o.valueNum);
  return o.valueText ?? "";
}

function displayCurrent(f: unknown): string | null {
  if (f === null || f === undefined) return null;
  if (Array.isArray(f)) return f.map(String).join("; ");
  return typeof f === "object" ? JSON.stringify(f) : String(f);
}

function conflictFor(o: DocumentObservation, current: CurrentFact | undefined): ExtractedValueView["conflict"] {
  if (!current || !current.hasDisagreement) return null;
  const mine = displayObservation(o);
  if (current.factId === o.id) {
    const other = current.fact.conflicts?.find((c) => displayCurrent(c.value) !== mine);
    return { winner: "this", otherDisplay: other ? displayCurrent(other.value) : null, otherSourceType: null, otherCount: current.fact.conflicts?.length ?? 0 };
  }
  return { winner: "other", otherDisplay: displayCurrent(current.fact.value), otherSourceType: current.sourceType, otherCount: current.fact.conflicts?.length ?? 0 };
}

/** Staff only. Per document id: its extraction (if any) and the extracted values, with conflicts. */
export async function getDocumentExtractionViews(
  projectId: string,
  deps: Pick<ExtractionDeps, "repos" | "requireStaff"> = {},
): Promise<Record<string, DocumentExtractionView>> {
  await (deps.requireStaff ?? requireStaff)();
  const repos = deps.repos ?? getRepositories();
  const id = z.string().trim().min(1).max(100).parse(projectId);
  const project = await repos.research.getProjectByIdForStaff(id);
  if (!project) return {};
  const [extractions, observations, current] = await Promise.all([
    repos.documentExtractions.listForProject(id),
    repos.documentExtractions.listObservationsForProject(id),
    repos.factStore.listCurrent("project", id),
  ]);
  const currentByAttr = new Map(current.map((c) => [c.attribute, c]));
  const out: Record<string, DocumentExtractionView> = {};
  for (const d of project.documents) {
    const extraction = extractions.find((e) => e.documentId === d.id) ?? null;
    const order = (a: string) => EXTRACTION_ATTRIBUTES.findIndex((x) => x.attribute === a);
    const values = observations
      .filter((o) => o.documentId === d.id)
      .sort((x, y) => order(x.attribute) - order(y.attribute))
      .map((o): ExtractedValueView => {
        const field = PROMOTABLE[o.attribute];
        const url = d.source.url && /^https:\/\//.test(d.source.url) ? d.source.url : null;
        const values = o.valueJson ?? (o.valueText !== null ? [o.valueText] : []);
        const note = `From uploaded document "${d.title}" v${d.version}, page ${o.pageNumber} (AI-extracted)`.slice(0, 300);
        return {
          observationId: o.id,
          attribute: o.attribute,
          label: labelOf(o.attribute),
          display: displayObservation(o),
          pageNumber: o.pageNumber,
          excerpt: o.excerpt,
          verification: "unverified",
          conflict: conflictFor(o, currentByAttr.get(o.attribute)),
          promote:
            field && url && values.length
              ? { field, values, source: { sourceId: d.source.sourceId, url, observedAt: d.source.observedAt, documentDate: d.documentDate, note } }
              : null,
          promoteBlocked: field && !url ? "Add the document's https source URL (upload a new version with it) to use this value as a curated fact." : null,
        };
      });
    out[d.id] = { extraction, values };
  }
  return out;
}
