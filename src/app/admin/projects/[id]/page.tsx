import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { CONSTRUCTION_STATUS_LABELS, CONSTRUCTION_STATUS_OPTIONS } from "@/domain/search-options";
import type { FactValue, Project, ResearchFactField, VerificationState } from "@/domain/types";
import type { StaffAuditEntry } from "@/server/repositories";
import { getLocality } from "@/config/markets";
import { RESEARCH_FACT_FIELDS } from "@/research/fact-edit";
import { canSetVerification } from "@/research/verification";
import { isStaffAuthError, type StaffSession } from "@/server/auth";
import { getStaffProjectView, listResearchSources } from "@/server/services/research";
import { getDocumentExtractionViews, type DocumentExtractionView } from "@/server/services/document-extraction";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FactEditForm, type SourceDraft } from "@/components/admin/fact-edit-form";
import { ExtractDocumentForm } from "@/components/admin/extract-document-form";
import { ExtractionResults } from "@/components/admin/extraction-results";
import { DOCUMENT_KIND_LABELS, DocumentUploadForm } from "@/components/admin/document-upload-form";
import { PublishForm } from "@/components/admin/publish-form";
import { VerificationForm } from "@/components/admin/verification-form";
import { CONSTRUCTION_STATUS_LABEL, formatDate, formatPercent, NOT_YET_FOUND, VERIFICATION_LABEL } from "@/components/property/format";
import { SourcesList } from "@/components/property/sources-list";
import { UnknownBadge, VerificationBadge } from "@/components/property/verification-badge";
import { requireStaffPage } from "../../_lib/session";

export const metadata: Metadata = { title: "Research project", robots: { index: false, follow: false } };

const FIELD_LABEL: Record<ResearchFactField, string> = {
  address: "Address",
  reraNumbers: "RERA registration numbers",
  constructionStatus: "Construction status",
  declaredPossession: "Declared possession (as declared, not guaranteed)",
};

const ALL_STATES: VerificationState[] = ["unverified", "source_confirmed", "reviewed", "disputed", "requires_professional_review"];

export default function AdminProjectPage({ params }: PageProps<"/admin/projects/[id]">) {
  return (
    <Suspense fallback={<div aria-busy="true" className="h-[40rem] animate-pulse rounded-lg bg-muted" />}>
      <ProjectContent params={params} />
    </Suspense>
  );
}

function displayValue(field: ResearchFactField, fact: FactValue<unknown>): string | null {
  if (fact.status !== "known" || fact.value === null) return null;
  if (field === "reraNumbers") return (fact.value as string[]).join(", ");
  if (field === "constructionStatus") return CONSTRUCTION_STATUS_LABEL[fact.value as keyof typeof CONSTRUCTION_STATUS_LABEL] ?? String(fact.value);
  return String(fact.value);
}

function inputValue(field: ResearchFactField, fact: FactValue<unknown>): string {
  if (fact.status !== "known" || fact.value === null) return "";
  return field === "reraNumbers" ? (fact.value as string[]).join("\n") : String(fact.value);
}

function sourceDrafts(fact: FactValue<unknown>): SourceDraft[] {
  return fact.sources.map((s) => ({
    sourceId: s.sourceId,
    url: s.url ?? "",
    observedAt: s.observedAt,
    documentDate: s.documentDate?.slice(0, 10) ?? "",
    note: s.note ?? "",
  }));
}

function verificationOptions(fact: FactValue<unknown>, session: StaffSession) {
  return ALL_STATES.filter((to) => canSetVerification(fact.verification, to, { id: session.userId, role: session.role }).ok).map((to) => ({
    value: to,
    label: VERIFICATION_LABEL[to],
  }));
}

async function ProjectContent({ params }: { params: PageProps<"/admin/projects/[id]">["params"] }) {
  const { id: rawId } = await params;
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    notFound(); // malformed percent-encoding
  }
  const session = await requireStaffPage(`/admin/projects/${encodeURIComponent(id)}`);
  let view;
  let extractions: Record<string, DocumentExtractionView> = {};
  try {
    view = await getStaffProjectView(id);
    if (view.ok) extractions = await getDocumentExtractionViews(view.project.id);
  } catch (e) {
    if (isStaffAuthError(e)) redirect("/admin/login?next=%2Fadmin%2Fprojects");
    throw e;
  }
  if (!view.ok) notFound();
  const { project, readiness, audit, factVersions } = view;
  const sourceOptions = listResearchSources().map((o) => ({ id: o.id, name: o.name }));
  const nowIso = new Date().toISOString(); // request time (after connection()): default observed date
  const isAdmin = session.role === "admin";

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/admin/projects" className="underline">
          ← Research projects
        </Link>
      </p>
      <header className="space-y-1">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={project.published ? "success" : "neutral"}>{project.published ? "Published" : "Unpublished"}</Badge>
          {project.published && !readiness.ready ? <Badge tone="warning">Published but no longer meets publish rules</Badge> : null}
          {project.isSample ? <Badge tone="warning">Sample data</Badge> : null}
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <p className="text-sm text-muted-foreground">
          {project.developer.name} · {getLocality(project.localityId)?.name ?? project.localityId} · id <code className="font-mono">{project.id}</code>
        </p>
        {project.published ? (
          <p className="text-sm">
            <Link href={`/projects/${project.slug}`}>View public page</Link>
          </p>
        ) : null}
      </header>

      <PublishPanel project={project} readiness={readiness} isAdmin={isAdmin} />

      <section aria-labelledby="facts-heading" className="space-y-4">
        <h2 id="facts-heading" className="text-lg font-semibold">
          Facts
        </h2>
        {RESEARCH_FACT_FIELDS.map((field) => {
          const fact = project[field] as FactValue<unknown>;
          const shown = displayValue(field, fact);
          const options = verificationOptions(fact, session);
          return (
            <Card key={field} id={`fact-${field}`}>
              <CardHeader>
                <CardTitle>{FIELD_LABEL[field]}</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {shown ? <span>{shown}</span> : <span className="text-muted-foreground">{NOT_YET_FOUND}</span>}
                  {shown ? <VerificationBadge state={fact.verification} /> : <UnknownBadge />}
                  {!shown && fact.verification !== "unverified" ? <VerificationBadge state={fact.verification} /> : null}
                </div>
                <SourcesList sources={fact.sources} />
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border border-border p-3">
                  <h3 className="mb-2 text-sm font-semibold">Verification</h3>
                  {fact.sources.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add at least one source before changing verification.</p>
                  ) : options.length ? (
                    <VerificationForm projectId={project.id} field={field} options={options} expectedVersion={factVersions[field]} expectedFrom={fact.verification} />
                  ) : (
                    <p className="text-sm text-muted-foreground">No verification changes are available to your role from this state.</p>
                  )}
                  {!isAdmin ? (
                    <p className="mt-2 text-xs text-muted-foreground">Only an admin can mark a fact Source confirmed or Reviewed.</p>
                  ) : null}
                </div>
                <details className="rounded-md border border-border p-3">
                  <summary className="cursor-pointer text-sm font-semibold">Edit fact and sources</summary>
                  <div className="mt-3">
                    <FactEditForm
                      projectId={project.id}
                      field={field}
                      label={FIELD_LABEL[field]}
                      initialStatus={fact.status}
                      initialValue={inputValue(field, fact)}
                      initialSources={sourceDrafts(fact)}
                      nowIso={nowIso}
                      sourceOptions={sourceOptions}
                      statusOptions={
                        field === "constructionStatus"
                          ? CONSTRUCTION_STATUS_OPTIONS.map((s) => ({ value: s, label: CONSTRUCTION_STATUS_LABELS[s] }))
                          : undefined
                      }
                    />
                  </div>
                </details>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <DocumentsSection project={project} sourceOptions={sourceOptions} extractions={extractions} />

      <AuditTable audit={audit} />
    </div>
  );
}

function PublishPanel({ project, readiness, isAdmin }: { project: Project; readiness: { ready: boolean; completeness: number; blockers: string[] }; isAdmin: boolean }) {
  return (
    <section aria-labelledby="publish-heading" className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <h2 id="publish-heading" className="text-lg font-semibold">
        Publishing
      </h2>
      <p className="text-sm">
        Completeness <strong>{formatPercent(readiness.completeness)}</strong> ·{" "}
        {readiness.ready ? <Badge tone="success">Ready to publish</Badge> : <Badge tone="warning">{readiness.blockers.length} blocker(s)</Badge>}
      </p>
      {readiness.blockers.length ? (
        <Alert tone="warning">
          <AlertTitle>Blocking publication</AlertTitle>
          <ul className="list-disc space-y-0.5 pl-5">
            {readiness.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {project.published && !readiness.ready ? (
        <p className="text-sm text-warning">This project is published but no longer meets the publish rules. Re-verify the facts or unpublish it.</p>
      ) : null}
      {isAdmin ? (
        <PublishForm projectId={project.id} published={project.published} ready={readiness.ready} />
      ) : (
        <p className="text-sm text-muted-foreground">Only an admin can publish or unpublish.</p>
      )}
      <p className="text-xs text-muted-foreground">Publish rules are a proposed default pending owner approval.</p>
    </section>
  );
}

function DocumentsSection({
  project,
  sourceOptions,
  extractions,
}: {
  project: Project;
  sourceOptions: { id: string; name: string }[];
  extractions: Record<string, DocumentExtractionView>;
}) {
  const groups = new Map<string, Project["documents"]>();
  for (const d of project.documents) {
    const key = `${d.kind}:${d.title}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return (
    <section aria-labelledby="docs-heading" className="space-y-3">
      <h2 id="docs-heading" className="text-lg font-semibold">
        Documents
      </h2>
      <p className="text-sm text-muted-foreground">
        K-RERA documents: download them by hand from the K-RERA portal and upload them here with source K-RERA. TrueNest never
        accesses K-RERA automatically. &ldquo;Extract details&rdquo; has AI read a PDF and list what it finds, each value with its page;
        every value stays unverified until staff review it. RERA registration is not title clearance.
      </p>
      <div className="rounded-lg border border-border bg-surface p-4">
        {project.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No documents recorded yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {[...groups.values()].map((docs) => {
              const sorted = [...docs].sort((a, b) => b.version - a.version);
              return (
                <li key={sorted[0].id} className="space-y-1 py-3 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {sorted[0].title}
                    <Badge tone="outline">{DOCUMENT_KIND_LABELS[sorted[0].kind] ?? sorted[0].kind}</Badge>
                  </p>
                  <ul className="space-y-1 pl-4">
                    {sorted.map((d, i) => {
                      const x = extractions[d.id];
                      const status = x?.extraction?.status;
                      const label = `version ${d.version} of ${d.title}`;
                      return (
                        <li key={d.id} className="space-y-2" data-testid={`document-${d.id}`}>
                          <div className="flex flex-wrap items-center gap-x-2">
                            <span className="font-medium">Version {d.version}</span>
                            {i === 0 && sorted.length > 1 ? <span className="text-muted-foreground">(latest)</span> : null}
                            <span className="text-muted-foreground">
                              · Document date {d.documentDate ? formatDate(d.documentDate) : "not recorded"} · Source{" "}
                              <code className="font-mono">{d.source.sourceId}</code>
                            </span>
                            {/* Staff-only route; plain <a> so the browser downloads the file. */}
                            <a href={`/api/staff/documents/${encodeURIComponent(d.id)}`} className="text-primary underline">
                              Download<span className="sr-only"> version {d.version} of {d.title}</span>
                            </a>
                          </div>
                          {/* S3a: K-RERA document extraction (staff upload + AI extraction only, D19) */}
                          {status === "succeeded" || status === "unsupported" || status === "running" ? null : (
                            <ExtractDocumentForm documentId={d.id} label={label} retry={status === "failed"} />
                          )}
                          {x ? <ExtractionResults projectId={project.id} view={x} documentLabel={label} /> : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">Upload a document or new version</summary>
        <div className="mt-3">
          <DocumentUploadForm projectId={project.id} sourceOptions={sourceOptions} />
        </div>
      </details>
    </section>
  );
}

function AuditTable({ audit }: { audit: StaffAuditEntry[] }) {
  const rows = [...audit].sort((a, b) => (a.at < b.at ? 1 : -1));
  return (
    <section aria-labelledby="audit-heading" className="space-y-3">
      <h2 id="audit-heading" className="text-lg font-semibold">
        History
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface" role="region" aria-label="Change history" tabIndex={0}>
          <table className="w-full min-w-[44rem] text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["Time (UTC)", "Field", "Action", "Verification", "By", "Note"].map((h) => (
                  <th key={h} scope="col" className="p-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-border align-top last:border-b-0">
                  <td className="whitespace-nowrap p-3">
                    {formatDate(e.at)} {e.at.slice(11, 16)}
                  </td>
                  <td className="p-3">{e.field in FIELD_LABEL ? FIELD_LABEL[e.field as ResearchFactField] : e.field}</td>
                  <td className="p-3">{e.action.replace(/_/g, " ")}</td>
                  <td className="p-3">
                    {e.fromVerification || e.toVerification
                      ? `${e.fromVerification ? VERIFICATION_LABEL[e.fromVerification] : "—"} → ${e.toVerification ? VERIFICATION_LABEL[e.toVerification] : "—"}`
                      : "—"}
                  </td>
                  <td className="p-3">
                    {e.actorName || e.actorId} <span className="text-xs text-muted-foreground">({e.actorRole})</span>
                  </td>
                  <td className="p-3">{e.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
