// Staff-only document download. Supabase mode: 302 to a 60-second signed URL for the private
// bucket. Fixture mode (dev): streams the in-memory bytes. Never cached; never public.
import { isStaffAuthError } from "@/server/auth";
import { log } from "@/server/log";
import { getDocumentDownload } from "@/server/services/documents";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  try {
    const d = await getDocumentDownload(documentId);
    if (!d) return new Response("Not found", { status: 404, headers: NO_STORE });
    if (d.kind === "redirect") return new Response(null, { status: 302, headers: { ...NO_STORE, Location: d.url, "Referrer-Policy": "no-referrer" } });
    return new Response(d.bytes as BodyInit, {
      status: 200,
      headers: {
        ...NO_STORE,
        "Content-Type": d.contentType,
        "Content-Disposition": `attachment; filename="${d.fileName}"`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    if (isStaffAuthError(e)) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
    log.error("documents.download_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return new Response("Unavailable", { status: 503, headers: NO_STORE });
  }
}
