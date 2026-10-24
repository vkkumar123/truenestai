import type { DocumentExtractionView } from "@/server/services/document-extraction";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/components/property/format";
import { PromoteExtractedValueForm } from "./promote-extracted-value-form";

export const EXTRACTION_LIMITATION =
  "AI-extracted from the uploaded document, not verified by TrueNest. Check every value against the page shown. RERA registration is not title clearance, and a value missing here is not a negative finding.";

const ERROR_TEXT: Record<string, string> = {
  not_pdf: "Only PDF documents can be extracted. Images are not read (no OCR yet).",
  too_large: "The PDF is larger than the extraction limit (15 MB).",
  too_many_pages: "The PDF has more pages than the extraction limit (100).",
  source_not_supported: "Only documents whose source is the regulator (K-RERA) can be extracted.",
  source_url_missing:
    "This document has no source URL, so extracted details could not cite where they came from. Upload it again as a new version with the K-RERA page address.",
  truncated: "The AI answer was cut off before it finished, so nothing was saved. Try again.",
  timeout: "The extraction took longer than 2 minutes and was stopped.",
  rate_limited: "The AI service was busy. Try again in a few minutes.",
  api_error: "The AI service returned an error.",
  auth: "The AI service is not configured correctly (ask an admin).",
  config: "Document extraction is not configured on this server (ask an admin).",
  bad_request: "The AI service could not read this PDF.",
  refused: "The AI service declined to process this document.",
  file_missing: "The stored file could not be read.",
  checksum_mismatch: "The stored file does not match the uploaded file's checksum.",
  unknown: "Something went wrong.",
};

const DROP_TEXT: Record<string, string> = {
  not_cited: "no citation",
  not_verbatim: "not word-for-word in the cited text",
  personal_data: "personal data",
  invalid_value: "unreadable value",
  duplicate: "duplicate",
  conflicting: "conflicting value in the same document",
  unknown_attribute: "not a requested detail",
  other_page: "list item cited on a different page",
  multi_page: "citation spans several pages",
};

const SOURCE_TYPE_TEXT: Record<string, string> = { rera: "K-RERA", govt: "government", builder: "builder", fixture: "SAMPLE fixture", search: "web search" };

export function extractionErrorText(code: string | null): string {
  return (code && ERROR_TEXT[code]) || "Something went wrong.";
}

/** Status + values of one document's extraction. Staff only (admin page). */
export function ExtractionResults({ projectId, view, documentLabel }: { projectId: string; view: DocumentExtractionView; documentLabel: string }) {
  const x = view.extraction;
  if (!x) return null;
  if (x.status === "running") {
    return (
      <Alert tone="info" role="status">
        Extraction running since {formatDate(x.startedAt)} {x.startedAt.slice(11, 16)} UTC. Reload in a minute.
      </Alert>
    );
  }
  if (x.status === "unsupported") {
    return (
      <Alert tone="neutral" role="status" data-testid="extraction-unsupported">
        <AlertTitle>Cannot be extracted automatically</AlertTitle>
        <p>{extractionErrorText(x.errorCode)} Enter the details by hand with their source instead.</p>
      </Alert>
    );
  }
  if (x.status === "failed") {
    return (
      <Alert tone="warning" role="alert" data-testid="extraction-failed">
        <AlertTitle>Extraction did not complete</AlertTitle>
        <p>{extractionErrorText(x.errorCode)}</p>
      </Alert>
    );
  }
  const drops = Object.entries(x.droppedReasons).filter(([, n]) => n > 0);
  return (
    <div className="space-y-2" data-testid="extraction-results">
      <Alert tone="warning">
        <AlertTitle>Unverified — needs review</AlertTitle>
        <p>{EXTRACTION_LIMITATION}</p>
      </Alert>
      <p className="text-xs text-muted-foreground">
        {x.keptCount} value(s) kept; {x.droppedCount} dropped
        {drops.length ? ` (${drops.map(([r, n]) => `${n} ${DROP_TEXT[r] ?? r}`).join(", ")})` : ""}. Model <code className="font-mono">{x.model ?? "—"}</code>,{" "}
        {x.finishedAt ? `${formatDate(x.finishedAt)} ${x.finishedAt.slice(11, 16)} UTC` : ""}.
      </p>
      {view.values.length === 0 ? (
        <p className="text-sm text-muted-foreground">No project details could be confirmed word-for-word from this document. Nothing was stored.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border" role="region" aria-label={`Extracted details from ${documentLabel}`} tabIndex={0}>
          <table className="w-full min-w-[46rem] text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["Attribute", "Value (as printed)", "Page", "Excerpt", "Status"].map((h) => (
                  <th key={h} scope="col" className="p-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.values.map((v) => (
                <tr key={v.observationId} className="border-b border-border align-top last:border-b-0" data-attribute={v.attribute}>
                  <th scope="row" className="p-2 font-medium">
                    {v.label}
                  </th>
                  <td className="p-2 break-words">{v.display}</td>
                  <td className="p-2 whitespace-nowrap" data-testid="page">
                    p. {v.pageNumber}
                  </td>
                  <td className="p-2 text-muted-foreground">
                    <q>{v.excerpt}</q>
                  </td>
                  <td className="space-y-1 p-2">
                    <Badge tone="warning">Unverified — needs review</Badge>
                    {v.conflict ? (
                      <p className="text-xs text-danger" data-testid="conflict">
                        <Badge tone="danger">Conflict</Badge>{" "}
                        {v.conflict.winner === "other"
                          ? `Current value from ${SOURCE_TYPE_TEXT[v.conflict.otherSourceType ?? ""] ?? v.conflict.otherSourceType ?? "another source"}: ${v.conflict.otherDisplay ?? "—"}`
                          : `Another source says: ${v.conflict.otherDisplay ?? "a different value"}`}
                      </p>
                    ) : null}
                    {v.promote ? (
                      <PromoteExtractedValueForm projectId={projectId} field={v.promote.field} values={v.promote.values} source={v.promote.source} label={v.label} />
                    ) : v.promoteBlocked ? (
                      <p className="text-xs text-muted-foreground">{v.promoteBlocked}</p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
