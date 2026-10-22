import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Project documents in object storage. Supabase: PRIVATE bucket `project-documents` (created by
// 0003_m2_live.sql; no storage.objects policies → anon/authenticated cannot read or write), all
// access through the server with the service role, after a staff check. Downloads use short-
// lived signed URLs handed out only by the staff route /api/staff/documents/[documentId].
// Paths are versioned and immutable: <projectId>/<documentKey>/v<N>/<filename>.

export const DOCUMENT_BUCKET = "project-documents";
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024; // 15 MB (also the bucket + DB limit)
export const ALLOWED_DOCUMENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export type DocumentContentType = (typeof ALLOWED_DOCUMENT_TYPES)[number];
export const SIGNED_URL_TTL_SECONDS = 60;

const EXTENSION: Record<DocumentContentType, string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
};

/** Content type from the file's leading bytes ("magic numbers"); null when not an allowed type. */
export function sniffContentType(bytes: Uint8Array): DocumentContentType | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  return null;
}

/** Safe object name: [A-Za-z0-9._-], no leading dot, ≤ 100 chars, extension matching the type. */
export function safeFileName(original: string, type: DocumentContentType): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  const finalExt = EXTENSION[type].includes(ext) ? ext : EXTENSION[type][0];
  return `${stem || "document"}.${finalExt}`;
}

export const DOCUMENT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECT_ID = /^[A-Za-z0-9-]+$/;

/** `<projectId>/<documentKey>/v<N>/<filename>` (matches the DB check constraint). */
export function documentStoragePath(projectId: string, documentKey: string, version: number, fileName: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error("invalid project id for a storage path");
  if (!DOCUMENT_KEY.test(documentKey) || documentKey.length > 60) throw new Error("invalid document key");
  if (!Number.isInteger(version) || version < 1) throw new Error("invalid document version");
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName.startsWith(".")) throw new Error("invalid file name");
  return `${projectId}/${documentKey}/v${version}/${fileName}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type PutResult = { ok: true } | { ok: false; error: "exists" };

export interface DocumentStorage {
  readonly kind: "fixture" | "supabase";
  /** Never overwrites: an existing object at `path` → "exists" (versioned paths are immutable). */
  put(path: string, bytes: Uint8Array, contentType: DocumentContentType): Promise<PutResult>;
  remove(path: string): Promise<void>;
  /** Short-lived signed download URL (Supabase). Fixture storage has none → null. */
  signedUrl(path: string, ttlSeconds?: number): Promise<string | null>;
  /** Raw bytes (fixture only; Supabase downloads go through signed URLs) → null when absent. */
  read(path: string): Promise<{ bytes: Uint8Array; contentType: DocumentContentType } | null>;
}

/** DEV ONLY: objects in this process's memory; lost on restart. */
export class FixtureDocumentStorage implements DocumentStorage {
  readonly kind = "fixture" as const;
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: DocumentContentType }>();

  async put(path: string, bytes: Uint8Array, contentType: DocumentContentType): Promise<PutResult> {
    if (this.objects.has(path)) return { ok: false, error: "exists" };
    this.objects.set(path, { bytes: new Uint8Array(bytes), contentType });
    return { ok: true };
  }
  async remove(path: string): Promise<void> {
    this.objects.delete(path);
  }
  async signedUrl(): Promise<string | null> {
    return null;
  }
  async read(path: string) {
    const o = this.objects.get(path);
    return o ? { bytes: new Uint8Array(o.bytes), contentType: o.contentType } : null;
  }
  get size(): number {
    return this.objects.size;
  }
}

/** Supabase Storage with the SERVICE-ROLE client (server-only). Not exercised live yet. */
export class SupabaseDocumentStorage implements DocumentStorage {
  readonly kind = "supabase" as const;
  constructor(private readonly db: () => SupabaseClient) {}

  async put(path: string, bytes: Uint8Array, contentType: DocumentContentType): Promise<PutResult> {
    const { error } = await this.db().storage.from(DOCUMENT_BUCKET).upload(path, bytes, { contentType, upsert: false, cacheControl: "0" });
    if (!error) return { ok: true };
    const status = (error as { statusCode?: string | number }).statusCode;
    if (String(status) === "409" || /exists/i.test(error.message)) return { ok: false, error: "exists" };
    throw new Error(`storage upload failed (${status ?? "unknown"})`);
  }
  async remove(path: string): Promise<void> {
    const { error } = await this.db().storage.from(DOCUMENT_BUCKET).remove([path]);
    if (error) throw new Error("storage remove failed");
  }
  async signedUrl(path: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string | null> {
    const { data, error } = await this.db().storage.from(DOCUMENT_BUCKET).createSignedUrl(path, ttlSeconds, { download: true });
    if (error || !data?.signedUrl) throw new Error("signed URL failed");
    return data.signedUrl;
  }
  async read(): Promise<null> {
    return null;
  }
}
