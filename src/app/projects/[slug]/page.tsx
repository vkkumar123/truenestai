import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, FileText, Scale } from "lucide-react";
import { formatInr } from "@/domain/format";
import type { Project, RegulatoryRecord, RegulatorySearch } from "@/domain/types";
import { getLocality } from "@/config/markets";
import { describeComplaintSearch, COMPLAINT_SCOPE_CAVEAT, REVIEW_FLAG_TEXT, reviewFlagsFor } from "@/research/evidence";
import { getPublishedProject } from "@/server/services/projects";
import { getPlannedNearProject } from "@/server/services/developments";
import type { NearbyDevelopment } from "@/locality/developments";
import { PlannedDevelopments } from "@/components/property/planned-developments";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FactRow } from "@/components/property/fact";
import {
  CONSTRUCTION_STATUS_LABEL,
  formatDate,
  formatPercent,
  formatRange,
  NOT_YET_FOUND,
  RECORD_KIND_LABEL,
} from "@/components/property/format";
import { SafeExternalLink } from "@/components/property/safe-link";
import { SourcesList } from "@/components/property/sources-list";
import { UnknownBadge, VerificationBadge } from "@/components/property/verification-badge";

export const metadata: Metadata = {
  title: "Project evidence",
  description: "Facts, sources, regulatory records and documents for a researched project.",
};

export default async function ProjectPage({ params }: PageProps<"/projects/[slug]">) {
  const { slug } = await params;
  const project = await getPublishedProject(slug);
  if (!project) notFound();

  const locality = getLocality(project.localityId)?.name ?? project.localityId;
  let planned: NearbyDevelopment[] | null;
  try {
    planned = await getPlannedNearProject(project);
  } catch {
    planned = null; // shown as an error state, never as "nothing planned"
  }
  const requestHref = (type: "verification" | "buyer_assistance") =>
    `/request?project=${encodeURIComponent(project.id)}&type=${type}&from=${encodeURIComponent(`/projects/${project.slug}`)}`;

  return (
    <article className="space-y-8">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/projects" className="underline">
          Projects
        </Link>{" "}
        / <span aria-current="page">{project.name}</span>
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="info">Researched by TrueNest</Badge>
          {project.isSample ? <Badge tone="warning">Sample data — fictional</Badge> : null}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{project.name}</h1>
        <p className="text-muted-foreground">
          {project.developer.name} · {locality}
        </p>
        <p className="text-sm text-muted-foreground">
          Data completeness {formatPercent(project.completeness)} · Last checked {formatDate(project.lastCheckedAt)}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Link href={requestHref("verification")} className={buttonVariants()}>
            Request verification
          </Link>
          <Link href={requestHref("buyer_assistance")} className={buttonVariants({ variant: "secondary" })}>
            Get buyer assistance
          </Link>
          <Link href={`/projects?compare=${encodeURIComponent(project.id)}`} className={buttonVariants({ variant: "ghost" })}>
            Compare with others
          </Link>
        </div>
      </header>

      <Alert tone="warning">
        <AlertTitle>
          <AlertTriangle aria-hidden="true" className="mr-1 inline size-4" />
          RERA registration is not proof of clear title
        </AlertTitle>
        <p>
          A registration shows only that the project is registered. It is not title clearance, a quality approval or legal
          advice. TrueNest does not guarantee title, safety, possession dates or returns.
        </p>
      </Alert>

      <Section id="overview" title="Overview">
        <dl>
          <FactRow label="Address" fact={project.address} render={(v) => v} />
          <FactRow
            label="RERA registration"
            hint="Not title clearance"
            fact={project.reraNumbers}
            render={(v) => <span className="font-mono">{v.length ? v.join(", ") : NOT_YET_FOUND}</span>}
          />
          <FactRow
            label="Construction status"
            fact={project.constructionStatus}
            render={(v) => CONSTRUCTION_STATUS_LABEL[v]}
          />
          <FactRow
            label="Declared possession"
            hint="As declared, not guaranteed"
            fact={project.declaredPossession}
            render={(v) => <>{v} <span className="text-muted-foreground">(as declared, not guaranteed)</span></>}
          />
        </dl>
      </Section>

      <Section id="units" title="Unit configurations">
        {project.units.length ? <UnitsTable project={project} /> : <p className="text-sm text-muted-foreground">Unit configurations: {NOT_YET_FOUND}.</p>}
      </Section>

      <Section id="regulatory" title="Regulatory records">
        <RegulatorySection project={project} />
      </Section>

      <Section id="documents" title="Documents">
        <DocumentsList project={project} />
      </Section>

      <section id="locality" aria-labelledby="locality-heading" className="space-y-3">
        <h2 id="locality-heading" className="text-lg font-semibold">
          Around {locality}
        </h2>
        <div className="rounded-lg border border-border bg-surface px-4 py-4">
          <PlannedDevelopments items={planned} localityName={locality} originPrecision={project.location.precision} headingLevel={3} />
        </div>
      </section>

      <ReviewBox project={project} />

      <p className="text-xs text-muted-foreground">
        Missing information is shown as &ldquo;Not yet found&rdquo;. It means we have not found it yet — not that it does not
        exist or that something is wrong.
      </p>
    </article>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        {title}
      </h2>
      <div className="rounded-lg border border-border bg-surface px-4 py-2">{children}</div>
    </section>
  );
}

function UnitsTable({ project }: { project: Project }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <caption className="sr-only">Unit configurations with carpet area and listed price</caption>
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-4 font-medium">Configuration</th>
            <th scope="col" className="py-2 pr-4 font-medium">Carpet area (sq ft)</th>
            <th scope="col" className="py-2 font-medium">Price (as listed)</th>
          </tr>
        </thead>
        <tbody>
          {project.units.map((u) => (
            <tr key={u.label} className="border-b border-border align-top last:border-b-0">
              <th scope="row" className="py-3 pr-4 font-medium">{u.label}</th>
              {[
                { f: u.carpetAreaSqft, fmt: (n: number) => n.toLocaleString("en-IN") },
                { f: u.priceInr, fmt: formatInr },
              ].map(({ f, fmt }, i) => (
                <td key={i} className="space-y-1 py-3 pr-4">
                  {f.status === "known" && f.value ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{formatRange(f.value, fmt)}</span>
                      <VerificationBadge state={f.verification} />
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground">{NOT_YET_FOUND}</span>
                      <UnknownBadge />
                    </div>
                  )}
                  <SourcesList sources={f.sources} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const KINDS: RegulatoryRecord["kind"][] = ["rera_registration", "complaint", "order", "extension", "other_disclosure"];
const ALWAYS_SHOWN = new Set<RegulatoryRecord["kind"]>(["rera_registration", "complaint"]);

function latestPerSource(searches: RegulatorySearch[]): RegulatorySearch[] {
  const m = new Map<string, RegulatorySearch>();
  for (const s of searches) {
    const prev = m.get(s.sourceId);
    if (!prev || prev.searchedAt < s.searchedAt) m.set(s.sourceId, s);
  }
  return [...m.values()];
}

function describeSearch(s: RegulatorySearch): string {
  const ref = { sourceId: s.sourceId, url: s.url, observedAt: s.searchedAt };
  if (s.kind === "complaint") return describeComplaintSearch({ sourcesChecked: [ref], found: s.resultsFound, checkedAt: s.searchedAt });
  const label = RECORD_KIND_LABEL[s.kind].toLowerCase();
  const date = formatDate(s.searchedAt);
  if (s.resultsFound === 0) {
    return `No ${label} record found as of ${date} in ${s.sourceId}. This reflects only the source listed, on that date, and does not confirm that none exist.`;
  }
  return `${s.resultsFound} ${label} record(s) found as of ${date} in ${s.sourceId}, as published by the source.`;
}

function RegulatorySection({ project }: { project: Project }) {
  const groups = KINDS.map((kind) => ({
    kind,
    records: project.regulatoryRecords.filter((r) => r.kind === kind),
    searches: latestPerSource(project.regulatorySearches.filter((s) => s.kind === kind)),
  })).filter((g) => ALWAYS_SHOWN.has(g.kind) || g.records.length || g.searches.length);

  return (
    <div className="divide-y divide-border">
      {groups.map((g) => (
        <div key={g.kind} className="space-y-2 py-3">
          <h3 className="font-medium">{RECORD_KIND_LABEL[g.kind]}</h3>
          {g.searches.length ? (
            <ul className="space-y-1 text-sm">
              {g.searches.map((s) => (
                <li key={`${s.sourceId}-${s.searchedAt}`}>
                  {describeSearch(s)}{" "}
                  {s.url ? <SafeExternalLink url={s.url}>Search source</SafeExternalLink> : null}
                </li>
              ))}
            </ul>
          ) : !g.records.length ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <UnknownBadge>Not yet checked</UnknownBadge>
              {g.kind === "complaint" ? describeComplaintSearch({ sourcesChecked: [], found: 0, checkedAt: "" }) : "We have not searched for these records yet."}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No search has been recorded for this record type, so other records may exist. {g.kind === "complaint" ? COMPLAINT_SCOPE_CAVEAT : ""}
            </p>
          )}
          {g.records.length ? (
            <ul className="space-y-2">
              {g.records.map((r) => (
                <li key={r.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.reference ? <span className="font-mono">{r.reference}</span> : "Reference not recorded"}</span>
                    <VerificationBadge state={r.verification} />
                  </div>
                  <p className="mt-1">{r.summary}</p>
                  <p className="mt-1 text-muted-foreground">
                    Status (as shown by source):{" "}
                    {r.status.status === "known" && r.status.value ? r.status.value : NOT_YET_FOUND}
                  </p>
                  <div className="mt-1">
                    <SourcesList sources={[r.source]} label="Source" />
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function DocumentsList({ project }: { project: Project }) {
  if (!project.documents.length) {
    return <p className="py-2 text-sm text-muted-foreground">Documents: {NOT_YET_FOUND}.</p>;
  }
  const groups = new Map<string, Project["documents"]>();
  for (const d of project.documents) {
    const key = `${d.kind}:${d.title}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return (
    <ul className="divide-y divide-border">
      {[...groups.values()].map((docs) => {
        const sorted = [...docs].sort((a, b) => b.version - a.version);
        const latest = sorted[0];
        return (
          <li key={latest.id} className="space-y-1 py-3 text-sm">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
              {latest.title}
              <Badge tone="outline">{latest.kind.replace(/_/g, " ")}</Badge>
            </p>
            <ul className="space-y-1 pl-6">
              {sorted.map((d) => (
                <li key={d.id}>
                  <span className="font-medium">Version {d.version}</span>
                  {d === latest && sorted.length > 1 ? " (latest)" : ""} · Document date{" "}
                  {d.documentDate ? formatDate(d.documentDate) : "not recorded"}
                  {d.source.url ? (
                    <>
                      {" · "}
                      <SafeExternalLink url={d.source.url} srLabel={`version ${d.version} of ${d.title} (opens in a new tab)`}>
                        Open
                      </SafeExternalLink>
                    </>
                  ) : null}
                  <div>
                    <SourcesList sources={[d.source]} label="Source" />
                  </div>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function ReviewBox({ project }: { project: Project }) {
  const standard = reviewFlagsFor().map((c) => REVIEW_FLAG_TEXT[c]);
  return (
    <Card className="border-warning/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale aria-hidden="true" className="size-5 text-warning" />
          Requires review by a qualified professional
        </CardTitle>
        <p className="text-sm text-muted-foreground">Title, encumbrance, approvals and land conversion are not checked by TrueNest.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="list-disc space-y-1 pl-5">
          {standard.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        {project.reviewFlags.length ? (
          <div>
            <p className="font-medium">Flagged for this project</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {project.reviewFlags
                .filter((f) => !standard.includes(f))
                .map((f) => (
                  <li key={f}>{f}</li>
                ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">This is not legal advice.</p>
      </CardContent>
    </Card>
  );
}
