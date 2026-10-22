import "server-only";
import { requireStaff, isStaffAuthError, type StaffSession } from "../auth";
import { log } from "../log";
import { type Repositories } from "../repositories";
import { uploadProjectDocument, type DocumentErrorCode } from "../services/documents";
import { MAX_DOCUMENT_BYTES } from "../storage/documents";

// Staff-only multipart upload for POST /api/staff/documents (a Route Handler, so the global
// Server Action body limit stays at Next's 1 MB default for public actions).
// Order: same-origin check (CSRF) → staff session → Content-Length cap → parse → service.
// Client: `fetch("/api/staff/documents", { method: "POST", body: formData })` with fields
// projectId, documentKey, title, kind, documentDate?, sourceId, sourceUrl?, file.

/** Room for multipart boundaries and the text fields on top of the 15 MB file. */
export const UPLOAD_BODY_OVERHEAD_BYTES = 64 * 1024;
export const MAX_UPLOAD_BODY_BYTES = MAX_DOCUMENT_BYTES + UPLOAD_BODY_OVERHEAD_BYTES;

export type DocumentUploadResponse =
  | { ok: true; documentId: string; projectId: string; version: number }
  | {
      ok: false;
      error: DocumentErrorCode | "unauthenticated" | "cross_origin" | "too_large" | "length_required" | "bad_request" | "unavailable";
      message: string;
      errors?: string[];
    };

export interface UploadHandlerDeps {
  repos?: Repositories;
  requireStaff?: () => Promise<StaffSession>;
  /** Called after a successful upload (the route revalidates the admin project page). */
  onUploaded?: (projectId: string) => void;
}

const json = (status: number, body: DocumentUploadResponse) =>
  Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** Origin must be present and equal the request host (X-Forwarded-Host when set by the proxy). */
export function isSameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0].trim().toLowerCase();
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export async function handleDocumentUpload(request: Request, deps: UploadHandlerDeps = {}): Promise<Response> {
  if (!isSameOrigin(request.headers)) return json(403, { ok: false, error: "cross_origin", message: "Cross-origin request refused." });

  let session: StaffSession;
  try {
    session = await (deps.requireStaff ?? requireStaff)();
  } catch (e) {
    if (isStaffAuthError(e)) return json(401, { ok: false, error: "unauthenticated", message: e.message });
    throw e;
  }

  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader === null) return json(411, { ok: false, error: "length_required", message: "Content-Length is required." });
  const length = Number(lengthHeader);
  if (!Number.isInteger(length) || length < 0) return json(400, { ok: false, error: "bad_request", message: "Invalid Content-Length." });
  if (length > MAX_UPLOAD_BODY_BYTES) return json(413, { ok: false, error: "too_large", message: "File must be 15 MB or smaller." });
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return json(415, { ok: false, error: "bad_request", message: "Expected multipart/form-data." });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { ok: false, error: "bad_request", message: "Could not read the upload." });
  }
  const text = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const file = form.get("file");
  const isFile = file !== null && typeof file === "object" && "arrayBuffer" in file;

  try {
    const r = await uploadProjectDocument(
      {
        projectId: text("projectId"),
        documentKey: text("documentKey"),
        title: text("title"),
        kind: text("kind"),
        documentDate: text("documentDate") || null,
        sourceId: text("sourceId"),
        sourceUrl: text("sourceUrl") || null,
        file: isFile
          ? { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }
          : { name: "", type: "", bytes: new Uint8Array() },
      },
      { repos: deps.repos, requireStaff: async () => session },
    );
    if (!r.ok) {
      const status = r.error === "validation" ? 422 : r.error === "forbidden" ? 403 : r.error === "not_found" ? 404 : 409;
      return json(status, { ok: false, error: r.error, message: r.message, ...(r.errors ? { errors: r.errors } : {}) });
    }
    deps.onUploaded?.(r.document.projectId);
    return json(201, { ok: true, documentId: r.document.id, projectId: r.document.projectId, version: r.document.version });
  } catch (e) {
    log.error("documents.upload_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return json(503, { ok: false, error: "unavailable", message: "Something went wrong. Please try again." });
  }
}
