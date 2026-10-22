import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { Info } from "lucide-react";
import { getLocality, listLocalities } from "@/config/markets";
import { searchProperties } from "@/server/services/search";
import { requestResearchOnMiss } from "@/server/services/research-jobs";
import { requestClientKey } from "@/server/client-ip";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { MAX_COMPARE } from "@/domain/limits";
import { BHK_OPTIONS, CONSTRUCTION_STATUS_LABELS, CONSTRUCTION_STATUS_OPTIONS, SEARCH_LANES, type SearchLane } from "@/domain/search-options";
import { CompareToggle } from "@/components/property/compare-toggle";
import { withCompare } from "@/components/property/compare-url";
import { EXTERNAL_LABEL, ExternalListingCard } from "@/components/property/external-card";
import { ProjectCard } from "@/components/property/project-card";
import { LocalitySearch } from "@/components/site/locality-search";
import { formatDate } from "@/components/property/format";
import { ResultsSkeleton } from "./results-skeleton";

export const metadata: Metadata = {
  title: "Browse projects",
  description: "Researched and externally discovered residential projects in North Bengaluru.",
};

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

function parseCompare(raw: string): string[] {
  return [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_COMPARE);
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
  const bhkRaw = first(sp.bhk);
  const bhk = (BHK_OPTIONS as readonly string[]).includes(bhkRaw) ? bhkRaw : "";
  const statusRaw = first(sp.status);
  const status = (CONSTRUCTION_STATUS_OPTIONS as readonly string[]).includes(statusRaw) ? (statusRaw as (typeof CONSTRUCTION_STATUS_OPTIONS)[number]) : "";
  const laneRaw = first(sp.lane);
  const lane: SearchLane = (SEARCH_LANES as readonly string[]).includes(laneRaw) ? (laneRaw as SearchLane) : "all";
  const selected = parseCompare(first(sp.compare));
  // Everything except `compare`, so toggles and "Clear" keep the current filters.
  const query = {
    locality: locality || undefined,
    q: q || undefined,
    bhk: bhk || undefined,
    status: status || undefined,
    lane: lane === "all" ? undefined : lane,
  };

  const localities = listLocalities({ activeOnly: true })
    .map((l) => ({ id: l.id, name: l.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const localityName = locality ? getLocality(locality)?.name : undefined;

  const result = await searchProperties({
    localityId: locality || undefined,
    text: q || undefined,
    bhk: bhk || undefined,
    status: status || undefined,
    lane,
  });
  const { researched, external, externalErrors, notes, matchedProjects } = result;
  const total = researched.length + external.length;
  // A free-text miss in both lanes starts (or reuses) on-demand web research. Request-time only.
  const isMiss = Boolean(q) && result.externalQueried && !externalErrors?.length && total === 0;
  const research = isMiss
    ? await requestResearchOnMiss({ queryText: q, localityId: locality || null, clientKey: await requestClientKey() })
    : null;
  const filterText = [bhk ? `${bhk} BHK` : "", status ? CONSTRUCTION_STATUS_LABELS[status] : ""].filter(Boolean).join(", ");

  return (
    <div className="space-y-8">
      <LocalitySearch
        localities={localities}
        defaults={{ locality: localityName ? locality : "", q, bhk, status, lane, compare: selected.join(",") }}
      />

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {total} result{total === 1 ? "" : "s"}
        {localityName ? ` in ${localityName}` : locality ? " (unknown locality)" : " across North Bengaluru"}
        {q ? ` matching “${q}”` : ""}
        {filterText ? ` (${filterText})` : ""}.
      </p>

      {research?.state === "researching" ? (
        <Alert tone="info" role="status">
          <AlertTitle>We’re researching “{research.queryText}” now</AlertTitle>
          <p>
            Results usually appear within a few minutes; refresh this page to check. Anything we find comes from public web
            pages and is labelled unverified until TrueNest checks it.
          </p>
        </Alert>
      ) : research?.state === "searched_none" ? (
        <Alert role="status">
          <AlertTitle>We searched public web sources for “{research.queryText}” on {formatDate(research.searchedAt)}</AlertTitle>
          <p>
            We found nothing we could cite reliably. That does not mean no projects exist.{" "}
            <Link href="/request?type=buyer_assistance">Ask us to look</Link>.
          </p>
        </Alert>
      ) : research?.state === "unavailable" ? (
        <Alert role="status">
          <AlertTitle>We can’t start new research right now</AlertTitle>
          <p>
            Please try again later, or <Link href="/request?type=buyer_assistance">ask us to look</Link>.
          </p>
        </Alert>
      ) : null}

      {notes?.length ? (
        <Alert tone="info" role="status">
          <ul className="space-y-1">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {selected.length ? (
        <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-surface p-3 shadow-sm">
          <p className="text-sm">
            {selected.length} of {MAX_COMPARE} selected for comparison
            {selected.length >= MAX_COMPARE ? " — the maximum. Remove one to add another." : "."}
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

      {lane !== "external" ? (
      <section aria-labelledby="researched-heading" className="space-y-3">
        <div>
          <h2 id="researched-heading" className="text-lg font-semibold">
            Researched by TrueNest
          </h2>
          <p className="text-sm text-muted-foreground">
            Facts collected with sources and a verification state. Tick up to {MAX_COMPARE} to compare.
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
      ) : null}

      {external.length || externalErrors?.length || lane === "external" ? (
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
                  <ExternalListingCard listing={l} researchedVersion={matchedProjects?.[l.id]} />
                </li>
              ))}
            </ul>
          ) : !externalErrors?.length ? (
            <p className="text-sm text-muted-foreground">No externally discovered listings match this search.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
