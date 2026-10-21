import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Info } from "lucide-react";
import { getLocality, listLocalities } from "@/config/markets";
import { searchProperties } from "@/server/services/search";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { CompareToggle, MAX_COMPARE_UI, withCompare } from "@/components/property/compare-toggle";
import { EXTERNAL_LABEL, ExternalListingCard } from "@/components/property/external-card";
import { ProjectCard } from "@/components/property/project-card";
import { LocalitySearch } from "@/components/site/locality-search";
import { ResultsSkeleton } from "./results-skeleton";

export const metadata: Metadata = {
  title: "Browse projects",
  description: "Researched and externally discovered residential projects in North Bengaluru.",
};

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

function parseCompare(raw: string): string[] {
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_COMPARE_UI);
}

export default function ProjectsPage({ searchParams }: PageProps<"/projects">) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Browse projects</h1>
      <Suspense fallback={<ResultsSkeleton />}>
        <Results searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Results({ searchParams }: { searchParams: PageProps<"/projects">["searchParams"] }) {
  await connection(); // discovery reads the current time: request-time only
  const sp = await searchParams;
  const locality = first(sp.locality);
  const q = first(sp.q).slice(0, 100);
  const selected = parseCompare(first(sp.compare));
  const query = { locality: locality || undefined, q: q || undefined };

  const localities = listLocalities({ activeOnly: true })
    .map((l) => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const localityName = locality ? getLocality(locality)?.name : undefined;

  const result = await searchProperties({ localityId: locality || undefined, text: q || undefined });
  const { researched, external, externalErrors } = result;
  const total = researched.length + external.length;

  return (
    <div className="space-y-8">
      <LocalitySearch localities={localities} defaultLocality={localityName ? locality : ""} defaultQuery={q} />

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {total} result{total === 1 ? "" : "s"}
        {localityName ? ` in ${localityName}` : locality ? " (unknown locality)" : " across North Bengaluru"}
        {q ? ` matching “${q}”` : ""}.
      </p>

      {selected.length ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-surface p-3 shadow-sm">
          <p className="text-sm">
            {selected.length} of {MAX_COMPARE_UI} selected for comparison
            {selected.length >= MAX_COMPARE_UI ? " — the maximum. Remove one to add another." : "."}
          </p>
          <div className="flex gap-2">
            <Link href={withCompare("/projects", query, [])} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Clear
            </Link>
            <Link href={`/compare?ids=${selected.map(encodeURIComponent).join(",")}`} className={buttonVariants({ size: "sm" })}>
              Compare {selected.length}
            </Link>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="researched-heading" className="space-y-3">
        <div>
          <h2 id="researched-heading" className="text-lg font-semibold">
            Researched by TrueNest
          </h2>
          <p className="text-sm text-muted-foreground">
            Facts collected with sources and a verification state. Tick up to {MAX_COMPARE_UI} to compare.
          </p>
        </div>
        {researched.length ? (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {researched.map((p) => (
              <li key={p.id}>
                <ProjectCard
                  project={p}
                  compareSlot={<CompareToggle projectId={p.id} projectName={p.name} selected={selected} query={query} />}
                />
              </li>
            ))}
          </ul>
        ) : (
          <Alert>
            <AlertTitle>No researched projects match yet</AlertTitle>
            <p>
              This does not mean there are no projects here — only that we have not researched one matching your search.{" "}
              <Link href="/request?type=buyer_assistance">Ask us to look</Link> or <Link href="/projects">clear the filters</Link>.
            </p>
          </Alert>
        )}
      </section>

      {external.length || externalErrors?.length ? (
        <section aria-labelledby="external-heading" className="space-y-3 rounded-xl border border-dashed border-external/40 bg-external/5 p-4">
          <div>
            <h2 id="external-heading" className="text-lg font-semibold">
              {EXTERNAL_LABEL}
            </h2>
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">
                <Info aria-hidden="true" className="mr-1 inline size-4" />
                What does unverified mean?
              </summary>
              <p className="mt-1">
                These listings were found on an approved external source. TrueNest has not checked them. We show only a short
                title, the source and a link. Facts may be wrong, incomplete or out of date. Request verification and we will
                research it.
              </p>
            </details>
          </div>
          {externalErrors?.length ? (
            <Alert tone="warning" role="status">
              <AlertTitle>Some external sources could not be reached</AlertTitle>
              <ul className="list-disc pl-5">
                {externalErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {external.length ? (
            <ul className={cn("grid gap-4 sm:grid-cols-2 lg:grid-cols-3")}>
              {external.map((l) => (
                <li key={l.id}>
                  <ExternalListingCard listing={l} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
