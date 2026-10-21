import type { SourceRef } from "@/domain/types";
import { formatDate } from "./format";
import { SafeExternalLink } from "./safe-link";

/** Provenance list: source id, link, observed date and document date for each source. */
export function SourcesList({ sources, label = "Sources" }: { sources: SourceRef[]; label?: string }) {
  if (!sources.length) {
    return <p className="text-xs text-muted-foreground">No source recorded yet.</p>;
  }
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        {label} ({sources.length})
      </summary>
      <ul className="mt-2 space-y-2 border-l-2 border-border pl-3">
        {sources.map((s, i) => (
          <li key={`${s.sourceId}-${s.url ?? "nourl"}-${i}`} className="space-y-0.5">
            <p>
              <span className="font-medium">Source:</span> <code className="font-mono">{s.sourceId}</code>
            </p>
            {s.url ? (
              <p>
                <SafeExternalLink url={s.url} />
              </p>
            ) : (
              <p className="text-muted-foreground">No link available</p>
            )}
            <p className="text-muted-foreground">
              Observed {formatDate(s.observedAt)}
              {" · "}Document date {s.documentDate ? formatDate(s.documentDate) : "not recorded"}
            </p>
            {s.note ? <p className="text-muted-foreground">{s.note}</p> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
