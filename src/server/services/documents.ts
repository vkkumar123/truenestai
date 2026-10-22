import "server-only";
import { z } from "zod";
import { isAutomatedActor } from "@/research/evidence";
import { requireStaff, type StaffSession } from "../auth";
import { log } from "../log";
import { getRepositories, type Repositories, type StoredDocument } from "../repositories";
import {
  ALLOWED_DOCUMENT_TYPES,
  DOCUMENT_KEY,
  documentStoragePath,
  MAX_DOCUMENT_BYTES,
  safeFileName,
  sha256Hex,
  SIGNED_URL_TTL_SECONDS,
  sniffContentType,
} from "../storage/documents";
import { listResearchSources, UNKNOWN_SOURCE_MESSAGE } from "./research";

// Staff document uploads (M2). Any staff role may upload; every upload is a NEW immutable
// version (<projectId>/<documentKey>/v<N>/<file>) and is audited. Files are checked by their
// bytes (PDF/PNG/JPEG magic numbers), not by the browser-declared type. Downloads are staff-only
// (route /api/staff/documents/[documentId]): fixture mode streams bytes, Supabase mode
// redirects to a 60-second signed URL. Never log file names, titles or storage paths.

export interface DocumentDeps {
  repos?: Repositories;
  requireStaff?: () => Promise<StaffSession>;
}

export interface UploadFileInput {
  name: string;
  /** Browser-declared type; must agree with the sniffed type. */
  type: string;
  bytes: Uint8Array;
}

export interface UploadDocumentInput {
  projectId: string;
  documentKey: string;
  title: string;
  kind: string;
  documentDate?: string | null;
  sourceId: string;
  sourceUrl?: string | null;
  file: UploadFileInput;
}

export type DocumentErrorCode = "validation" | "forbidden" | "not_found" | "conflict";
export type UploadDocumentResult =
  | { ok: true; document: StoredDocument }
  | { ok: false; error: DocumentErrorCode; message: string; errors?: string[] };

const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const metaSchema = z.object({
  projectId: z.string().trim().min(1).max(100),
  documentKey: z
    .string()
    .trim()
    .toLowerCase()
    .max(60)
    .regex(DOCUMENT_KEY, "use lowercase letters, digits and dashes (e.g. site-plan)"),
  title: z.string().trim().min(1, "required").max(200),
  kind: z.enum(["approval", "brochure", "rera_certificate", "plan", "other"]),
  documentDate: z.preprocess(empty, z.iso.date().nullable().optional()),
  sourceId: z.string().trim().min(1, "required").max(100),
  sourceUrl: z.preprocess(empty, z.url({ protocol: /^https$/, message: "must be an https URL" }).max(2000).nullable().optional()),
});

const fail = (error: DocumentErrorCode, message: string, errors?: string[]): UploadDocumentResult =>
  errors ? { ok: false, error, message, errors } : { ok: false, error, message };

/**
 * Validates metadata + bytes, allocates the next version, stores the object (never overwriting),
 * then records the row + audit event atomically. If the DB write fails after the object was
 * stored, the object is removed again (best effort) so no orphan stays referenced by nothing.
 */
export async function uploadProjectDocument(input: UploadDocumentInput, deps: DocumentDeps = {}): Promise<UploadDocumentResult> {
  const session = await (deps.requireStaff ?? requireStaff)();
  if (isAutomatedActor(session.userId)) return fail("forbidden", "Automated actors cannot upload documents.");
  const repos = deps.repos ?? getRepositories();

  const parsed = metaSchema.safeParse(input ?? {});
  const errors = parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  if (parsed.success && !listResearchSources().some((s) => s.id === parsed.data.sourceId)) {
    errors.push(`sourceId: ${UNKNOWN_SOURCE_MESSAGE}`);
  }
  const file = input?.file;
  const bytes = file?.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) errors.push("file: choose a file to upload");
  else if (bytes.byteLength > MAX_DOCUMENT_BYTES) errors.push("file: must be 15 MB or smaller");
  const sniffed = bytes instanceof Uint8Array && bytes.byteLength > 0 ? sniffContentType(bytes) : null;
  if (bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_DOCUMENT_BYTES) {
    if (!sniffed) errors.push(`file: only ${ALLOWED_DOCUMENT_TYPES.join(", ")} files are accepted`);
    else if (file.type && file.type !== sniffed && !(sniffed === "image/jpeg" && file.type === "image/jpg")) {
      errors.push("file: the file's content does not match its type");
    }
  }
  if (!parsed.success || errors.length || !sniffed) return fail("validation", "Please correct the document details.", errors);
  const meta = parsed.data;

  const project = await repos.research.getProjectByIdForStaff(meta.projectId);
  if (!project) return fail("not_found", "Project not found.");

  const version = await repos.research.nextDocumentVersion(project.id, meta.documentKey);
  const path = documentStoragePath(project.id, meta.documentKey, version, safeFileName(file.name ?? "", sniffed));
  const put = await repos.documentStorage.put(path, bytes!, sniffed);
  if (!put.ok) return fail("conflict", "Another upload of this document finished first — reload and try again.");

  let added;
  try {
    added = await repos.research.addDocument(
      {
        projectId: project.id,
        documentKey: meta.documentKey,
        title: meta.title,
        kind: meta.kind,
        documentDate: meta.documentDate ?? null,
        sourceId: meta.sourceId,
        sourceUrl: meta.sourceUrl ?? null,
        storagePath: path,
        contentType: sniffed,
        sizeBytes: bytes!.byteLength,
        sha256: sha256Hex(bytes!),
        version,
      },
      { actorId: session.userId, actorRole: session.role },
    );
  } catch (e) {
    await repos.documentStorage.remove(path).catch(() => log.warn("documents.orphan_cleanup_failed", { projectId: project.id }));
    throw e;
  }
  if (!added.ok) {
    await repos.documentStorage.remove(path).catch(() => log.warn("documents.orphan_cleanup_failed", { projectId: project.id }));
    return fail(added.error, added.message);
  }
  log.info("documents.uploaded", { projectId: project.id, version, contentType: sniffed, bytes: bytes!.byteLength, role: session.role });
  return { ok: true, document: added.document };
}

export type DocumentDownload =
  | { kind: "redirect"; url: string }
  | { kind: "bytes"; bytes: Uint8Array; contentType: string; fileName: string };

/** Staff only (throws StaffAuthError). null when the document or its stored file does not exist. */
export async function getDocumentDownload(documentId: string, deps: DocumentDeps = {}): Promise<DocumentDownload | null> {
  await (deps.requireStaff ?? requireStaff)();
  const id = z.string().trim().min(1).max(100).safeParse(documentId);
  if (!id.success) return null;
  const repos = deps.repos ?? getRepositories();
  const doc = await repos.research.getDocumentForStaff(id.data);
  if (!doc?.storagePath) return null;
  const signed = await repos.documentStorage.signedUrl(doc.storagePath, SIGNED_URL_TTL_SECONDS);
  if (signed) return { kind: "redirect", url: signed };
  const obj = await repos.documentStorage.read(doc.storagePath);
  if (!obj) return null;
  return { kind: "bytes", bytes: obj.bytes, contentType: obj.contentType, fileName: doc.storagePath.split("/").pop()! };
}
