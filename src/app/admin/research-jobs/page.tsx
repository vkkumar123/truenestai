import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getLocality } from "@/config/markets";
import { getSource } from "@/discovery";
import { isStaffAuthError } from "@/server/auth";
import type { ResearchJobStatus, ResearchJobWithListings } from "@/server/repositories";
import { listRecentResearchJobs } from "@/server/services/research-jobs";
import { requireStaffPage } from "../_lib/session";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { EXTERNAL_LABEL } from "@/components/property/external-card";
import { formatDate } from "@/components/property/format";
import { SafeExternalLink } from "@/components/property/safe-link";

export const metadata: Metadata = { title: "Research jobs", robots: { index: false, follow: false } };

const STATUS_LABELS: Record<ResearchJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  no_results: "No results",
  failed: "Failed",
};

const STATUS_TONE: Record<ResearchJobStatus, "info" | "neutral" | "success" | "warning" | "danger"> = {
  queued: "neutral",
  running: "info",
  done: "success",
  no_results: "neutral",
  failed: "danger",
};

export default function AdminResearchJobsPage() {
  return (
    <Suspense
      fallback={
        <div aria-busy="true" className="h-96 animate-pulse rounded-lg bg-muted">
          <span className="sr-only">Loading…</span>
        </div>
      }
    >
      <ResearchJobsContent />
    </Suspense>
  );
}

function Listings({ job }: { job: ResearchJobWithListings }) {
  if (!job.listings.length) return <span className="text-muted-foreground">None stored</span>;
  return (
    <ul className="space-y-2">
      {job.listings.map((l) => (
        <li key={l.id} className="space-y-0.5">
          <p className="font-medium">{l.title}</p>
          <p className="text-muted-foreground">
            Source: {getSource(l.sourceId)?.name ?? l.sourceId}
            {l.localityId ? ` · ${getLocality(l.localityId)?.name ?? l.localityId}` : ""}
          </p>
          <SafeExternalLink url={l.canonicalUrl} srLabel="(opens the cited page in a new tab)" />
          <p className="text-muted-foreground">Discovered {formatDate(l.discoveredAt)}</p>
        </li>
      ))}
    </ul>
  );
}

async function ResearchJobsContent() {
  await requireStaffPage("/admin/research-jobs");

  let jobs: ResearchJobWithListings[];
  try {
    jobs = await listRecentResearchJobs(100);
  } catch (e) {
    if (isStaffAuthError(e)) redirect("/admin/login?next=%2Fadmin%2Fresearch-jobs");
    throw e;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Research jobs</h1>
        <p className="text-sm text-muted-foreground">
          Automated web research started by buyer searches that found nothing. Read-only. Stored results are{" "}
          <Badge className="border-external/40 bg-external/10 text-external">{EXTERNAL_LABEL}</Badge> listings: they are never
          published or verified automatically.
        </p>
      </div>

      {jobs.length === 0 ? (
        <Alert>
          <AlertTitle>No research jobs yet</AlertTitle>
          <p>A job is queued when a buyer’s search finds no researched or external results.</p>
        </Alert>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface" role="region" aria-label="Research jobs" tabIndex={0}>
          <table className="w-full min-w-[60rem] text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["Requested", "Query", "Status", "Attempts", "Results", "Finished", "Stored listings"].map((h) => (
                  <th key={h} scope="col" className="p-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-border align-top last:border-b-0">
                  <td className="whitespace-nowrap p-3">{formatDate(j.requestedAt)}</td>
                  <td className="max-w-64 p-3">
                    <p className="break-words">{j.queryText}</p>
                    {j.localityId ? <p className="text-xs text-muted-foreground">{getLocality(j.localityId)?.name ?? j.localityId}</p> : null}
                  </td>
                  <td className="p-3">
                    <Badge tone={STATUS_TONE[j.status]}>{STATUS_LABELS[j.status]}</Badge>
                    {j.errorCode ? <p className="mt-1 font-mono text-xs text-muted-foreground">{j.errorCode}</p> : null}
                  </td>
                  <td className="p-3">{j.attempts}</td>
                  <td className="p-3">{j.resultCount}</td>
                  <td className="whitespace-nowrap p-3">{j.finishedAt ? formatDate(j.finishedAt) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="max-w-80 p-3 text-xs">
                    <Listings job={j} />
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
