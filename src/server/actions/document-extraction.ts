"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { isStaffAuthError } from "../auth";
import { log } from "../log";
import { extractDocument } from "../services/document-extraction";
import { ensureRenderPhaseAfterAction } from "./mpa";
import type { ExtractDocumentActionState } from "./types";

const MESSAGES = {
  succeeded: "Extraction finished. Every value below is unverified and needs review.",
  already_done: "This document version was already extracted; showing the stored result.",
  in_progress: "An extraction of this document is already running. Reload in a minute.",
  failed: "The extraction did not complete. You can try again.",
  unsupported: "This document cannot be extracted automatically.",
} as const;

/**
 * Staff only (enforced in services/document-extraction.ts). Fields: documentId, projectId (for
 * revalidation only; the document's own project is authoritative). Use with
 * `useActionState(extractDocumentAction, { status: "idle" })`. Audited by the repository.
 */
export async function extractDocumentAction(_prev: ExtractDocumentActionState, formData: FormData): Promise<ExtractDocumentActionState> {
  const documentId = formData.get("documentId");
  if (typeof documentId !== "string" || !documentId) return { status: "error", message: "Missing document." };
  try {
    const r = await extractDocument(documentId);
    ensureRenderPhaseAfterAction("/admin/projects", "layout");
    if (!r.ok) return { status: "error", message: r.message };
    revalidatePath(`/admin/projects/${r.extraction.projectId}`);
    return {
      status: r.outcome === "failed" || r.outcome === "unsupported" ? "error" : "success",
      outcome: r.outcome,
      message: MESSAGES[r.outcome],
      errorCode: r.extraction.errorCode,
    };
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", message: e.message, unauthenticated: true };
    log.error("documents.extract_action_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", message: "Something went wrong. Please try again." };
  }
}
