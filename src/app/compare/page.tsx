import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { X } from "lucide-react";
import { getComparison, MAX_COMPARE } from "@/server/services/compare";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { NOT_YET_FOUND } from "@/components/property/format";
import { SourcesList } from "@/components/property/sources-list";
import { UnknownBadge, VerificationBadge } from "@/components/property/verification-badge";

export const metadata: Metadata = {
  title: "Compare projects",
  description: "Side-by-side facts with sources and verification state for up to four researched projects.",
};

export default function ComparePage({ searchParams }: PageProps<"/compare">) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Compare projects</h1>
      <Suspense fallback={<CompareSkeleton />}>
        <Comparison searchParams={searchParams} />
      </Suspense>
    </div>
  );
}


async function Comparison({ searchParams }: { searchParams: PageProps<"/compare">["searchParams"] }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.ids) ? sp.ids.join(",") : (sp.ids ?? "");
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
  const result = await getComparison(ids);

  if (!result.ok) {
    return (
      <Alert tone={result.error === "too_many" ? "warning" : "neutral"}>
        <AlertTitle>{result.error === "too_many" ? `Up to ${MAX_COMPARE} projects at a time` : "Nothing to compare yet"}</AlertTitle>
        <p className="mb-3">
          {result.message} Pick projects on the browse page using the &ldquo;Compare&rdquo; tick boxes.
        </p>
        <Link href="/projects" className={buttonVariants({ size: "sm" })}>
          Browse projects
        </Link>
      </Alert>
    );
  }

  const { projects, rows, missingIds } = result;
  const without = (id: string) => {
    const rest = projects.map((p) => p.id).filter((x) => x !== id);
    return rest.length ? `/compare?ids=${rest.map(encodeURIComponent).join(",")}` : "/compare";
  };

  return (
    <div className="space-y-4">
      {missingIds.length ? (
        <Alert tone="warning" role="status">
          <AlertTitle>
            {missingIds.length} project{missingIds.length === 1 ? " is" : "s are"} not available
          </AlertTitle>
          <p>They may not exist or may not be published yet, so they are left out of this comparison.</p>
        </Alert>
      ) : null}

      {projects.length === 0 ? (
        <Alert>
          <AlertTitle>None of the selected projects are available</AlertTitle>
          <p>
            <Link href="/projects">Browse projects</Link> to choose again.
          </p>
        </Alert>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Unknown values are shown as &ldquo;{NOT_YET_FOUND}&rdquo; — that is not a negative finding. Scroll sideways on small screens.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface" role="region" aria-labelledby="compare-caption" tabIndex={0}>
            <table className="w-full border-collapse text-left text-sm">
              <caption id="compare-caption" className="sr-only">
                Comparison of {projects.length} researched projects
              </caption>
              <thead>
                <tr className="border-b border-border align-top">
                  <th scope="col" className="sticky left-0 z-10 min-w-36 bg-surface p-3 font-medium text-muted-foreground">
                    Fact
                  </th>
                  {projects.map((p) => (
                    <th key={p.id} scope="col" className="min-w-56 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/projects/${p.slug}`} className="font-semibold hover:underline">
                          {p.name}
                        </Link>
                        <Link href={without(p.id)} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label={`Remove ${p.name} from comparison`}>
                          <X aria-hidden="true" className="size-4" />
                        </Link>
                      </div>
                      {p.isSample ? (
                        <Badge tone="warning" className="mt-1">
                          Sample data
                        </Badge>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="border-b border-border align-top last:border-b-0">
                    <th scope="row" className="sticky left-0 z-10 bg-surface p-3 font-medium text-muted-foreground shadow-[1px_0_0_var(--border)]">
                      {row.label}
                    </th>
                    {row.cells.map((c) => (
                      <td key={c.projectId} className="space-y-1.5 p-3">
                        {c.status === "known" && c.value !== null ? (
                          <p>{c.value}</p>
                        ) : (
                          <p className="text-muted-foreground">{c.note ?? NOT_YET_FOUND}</p>
                        )}
                        {c.status === "known" && c.value !== null && c.note && c.note !== c.value ? (
                          <p className="text-xs text-muted-foreground">{c.note}</p>
                        ) : null}
                        {c.status === "unknown" ? <UnknownBadge>{c.note ? "Not yet checked" : NOT_YET_FOUND}</UnknownBadge> : c.verification ? <VerificationBadge state={c.verification} /> : null}
                        {c.sources.length ? <SourcesList sources={c.sources} /> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            {projects.length < MAX_COMPARE ? (
              <Link href={`/projects?compare=${projects.map((p) => encodeURIComponent(p.id)).join(",")}`} className={buttonVariants({ variant: "secondary" })}>
                Add another project
              </Link>
            ) : (
              <p className="self-center text-sm text-muted-foreground">You are comparing the maximum of {MAX_COMPARE} projects.</p>
            )}
            <Link href="/request?type=buyer_assistance&from=%2Fcompare" className={buttonVariants()}>
              Get buyer assistance
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function CompareSkeleton() {
  return (
    <div aria-busy="true" className="h-96 animate-pulse rounded-lg bg-muted">
      <span className="sr-only">Loading comparison…</span>
    </div>
  );
}
