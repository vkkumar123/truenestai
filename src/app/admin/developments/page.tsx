import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getLocality, listLocalities } from "@/config/markets";
import {
  INFRA_CATEGORY_LABEL,
  INFRA_STAGE_LABEL,
  describeSlips,
  expectedLabel,
  sortRevisions,
  summarizeSlips,
} from "@/locality/developments";
import { isStaffAuthError, type StaffSession } from "@/server/auth";
import type { ResearchJob } from "@/server/repositories";
import { developmentSourceName, getStaffDevelopmentsView, type StaffDevelopmentItem } from "@/server/services/developments";
import { requireStaffPage } from "../_lib/session";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  DevelopmentFieldsForm,
  DevelopmentReviewForm,
  ResearchDevelopmentsForm,
  type DevelopmentDraft,
} from "@/components/admin/development-forms";
import { formatDate, NOT_YET_FOUND } from "@/components/property/format";
import { SafeExternalLink } from "@/components/property/safe-link";
import { VerificationBadge } from "@/components/property/verification-badge";

export const metadata: Metadata = { title: "Area developments", robots: { index: false, follow: false } };

const REVIEW_TONE = { pending: "neutral", published: "success", rejected: "danger" } as const;
const REVIEW_LABEL = { pending: "Pending review", published: "Published", rejected: "Rejected" } as const;
const JOB_LABEL: Record<ResearchJob["status"], string> = { queued: "Queued", running: "Running", done: "Done", no_results: "No results", failed: "Failed" };

export default function AdminDevelopmentsPage({ searchParams }: PageProps<"/admin/developments">) {
  return (
    <Suspense fallback={<div aria-busy="true" className="h-96 animate-pulse rounded-lg bg-muted" />}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}

async function Content({ searchParams }: { searchParams: PageProps<"/admin/developments">["searchParams"] }) {
  const session = await requireStaffPage("/admin/developments");
  const sp = await searchParams;
  const raw = typeof sp.locality === "string" ? sp.locality : "";
  const localities = listLocalities({ activeOnly: true }).map((l) => ({ id: l.id, name: l.name }));
  const selected = raw && getLocality(raw) ? raw : "";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Area developments</h1>
        <p className="text-sm text-muted-foreground">
          Planned infrastructure around each configured locality (next 5–10 years). Researched items are unverified drafts; buyers see an item only
          after staff publish it. Never record price, appreciation or return claims.
        </p>
      </div>

      <form method="GET" className="flex flex-wrap items-end gap-2" aria-label="Choose locality">
        <div className="min-w-60 space-y-1">
          <Label htmlFor="locality">Locality</Label>
          <Select id="locality" name="locality" defaultValue={selected}>
            <option value="">Choose a locality…</option>
            {localities.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {selected ? <LocalityDevelopments localityId={selected} session={session} localities={localities} today={today} /> : null}
    </div>
  );
}

async function LocalityDevelopments({
  localityId,
  session,
  localities,
  today,
}: {
  localityId: string;
  session: StaffSession;
  localities: { id: string; name: string }[];
  today: string;
}) {
  let r;
  try {
    r = await getStaffDevelopmentsView(localityId);
  } catch (e) {
    if (isStaffAuthError(e)) redirect(`/admin/login?next=${encodeURIComponent(`/admin/developments?locality=${localityId}`)}`);
    throw e;
  }
  if (!r.ok) {
    return (
      <Alert tone="danger">
        <AlertTitle>{r.message}</AlertTitle>
      </Alert>
    );
  }
  const v = r.view;
  const job = v.latestJob;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Research for {v.localityName}</CardTitle>
          <p className="text-sm text-muted-foreground">
            Latest research:{" "}
            {job ? (
              <>
                <Badge tone={job.status === "failed" ? "danger" : job.status === "done" ? "success" : "neutral"}>{JOB_LABEL[job.status]}</Badge>{" "}
                requested {formatDate(job.requestedAt)}
                {job.finishedAt ? `, finished ${formatDate(job.finishedAt)}` : ""} · {job.resultCount} stored
                {job.errorCode ? <span className="font-mono text-xs"> ({job.errorCode})</span> : null}
              </>
            ) : (
              "never researched"
            )}
          </p>
        </CardHeader>
        <CardContent>
          {v.researchAvailable ? null : (
            <Alert tone="warning" className="mb-3">
              Web research is not available in this environment. Add developments manually below.
            </Alert>
          )}
          <ResearchDevelopmentsForm localityId={v.localityId} localityName={v.localityName} disabled={!v.researchAvailable} />
        </CardContent>
      </Card>

      <section aria-labelledby="dev-list-heading" className="space-y-3">
        <h2 id="dev-list-heading" className="text-lg font-semibold">
          Developments for {v.localityName} ({v.items.length})
        </h2>
        {v.items.length === 0 ? (
          <Alert>
            <AlertTitle>None yet</AlertTitle>
            <p>Run research or add one manually. Buyers see &ldquo;Not yet researched&rdquo; until something is published.</p>
          </Alert>
        ) : (
          <ul className="space-y-4">
            {v.items.map((it) => (
              <DevelopmentItem key={it.development.id} item={it} session={session} localities={localities} today={today} />
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Add a development manually</CardTitle>
          <p className="text-sm text-muted-foreground">From the responsible authority&apos;s own page. The authority and its https link are required.</p>
        </CardHeader>
        <CardContent>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Open the manual entry form</summary>
            <div className="pt-3">
              <DevelopmentFieldsForm
                mode="create"
                localities={localities}
                draft={{
                  name: "",
                  category: "metro",
                  stage: "proposed",
                  authority: "",
                  expectedCompletion: "",
                  announcedDate: "",
                  localityIds: [v.localityId],
                  lat: "",
                  lng: "",
                  locationPrecision: "approximate",
                  sourceUrl: "",
                  sourceObservedAt: today,
                }}
              />
            </div>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

function DevelopmentItem({
  item,
  session,
  localities,
  today,
}: {
  item: StaffDevelopmentItem;
  session: StaffSession;
  localities: { id: string; name: string }[];
  today: string;
}) {
  const d = item.development;
  const isAdmin = session.role === "admin";
  const history = sortRevisions(d.completionHistory);
  const draft: DevelopmentDraft = {
    id: d.id,
    version: d.version,
    name: d.name,
    category: d.category,
    stage: d.stage,
    authority: d.authority ?? "",
    expectedCompletion: d.expectedCompletion ?? "",
    announcedDate: d.announcedDate ?? "",
    localityIds: d.localityIds,
    lat: d.location ? String(d.location.lat) : "",
    lng: d.location ? String(d.location.lng) : "",
    locationPrecision: d.location?.precision === "exact" ? "exact" : "approximate",
    sourceUrl: d.sourceUrl ?? "",
    sourceObservedAt: d.sourceObservedAt?.slice(0, 10) ?? today,
  };
  return (
    <li>
      <article aria-label={d.name} className="space-y-3 rounded-lg border border-border bg-surface p-4 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="mr-1 text-base font-semibold">{d.name}</h3>
          <Badge tone={REVIEW_TONE[d.reviewStatus]}>{REVIEW_LABEL[d.reviewStatus]}</Badge>
          <Badge tone="outline">{INFRA_CATEGORY_LABEL[d.category]}</Badge>
          <Badge tone="info">Stage: {INFRA_STAGE_LABEL[d.stage]}</Badge>
          <VerificationBadge state={d.verification} />
          <Badge tone="neutral">{d.addedBy === "research" ? "Automated research" : "Staff entry"}</Badge>
          {d.isSample ? <Badge tone="warning">Sample data</Badge> : null}
        </div>
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted-foreground">Authority</dt>
          <dd>{d.authority ?? NOT_YET_FOUND}</dd>
          <dt className="text-muted-foreground">Expected</dt>
          <dd>{expectedLabel(d.expectedCompletion)}</dd>
          <dt className="text-muted-foreground">Slip history</dt>
          <dd>
            {describeSlips(summarizeSlips(d.completionHistory))}
            {history.length ? (
              <ol className="mt-1 list-decimal pl-5 text-muted-foreground">
                {history.map((h, i) => (
                  <li key={`${h.asOf}-${i}`}>
                    {h.expectedCompletion} — seen {formatDate(h.asOf)}
                  </li>
                ))}
              </ol>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Localities</dt>
          <dd>{d.localityIds.map((id) => getLocality(id)?.name ?? id).join(", ") || NOT_YET_FOUND}</dd>
          <dt className="text-muted-foreground">Location</dt>
          <dd>{d.location ? `${d.location.lat}, ${d.location.lng} (${d.location.precision})` : "Not yet mapped (distance is not shown to buyers)"}</dd>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="space-y-0.5">
            {d.sourceUrl ? <SafeExternalLink url={d.sourceUrl} /> : NOT_YET_FOUND}
            <p className="text-muted-foreground">
              {developmentSourceName(d.sourceId) ?? "Staff manual entry"} · seen {formatDate(d.sourceObservedAt)} · last checked {formatDate(d.lastCheckedAt)}
            </p>
          </dd>
        </dl>

        {d.pendingChange ? (
          <Alert tone="info" role="note">
            <AlertTitle>Research saw different values on {formatDate(d.pendingChange.observedAt)}</AlertTitle>
            <p>
              Stage {d.pendingChange.stage ? INFRA_STAGE_LABEL[d.pendingChange.stage] : NOT_YET_FOUND} · authority {d.pendingChange.authority ?? NOT_YET_FOUND} ·
              expected {d.pendingChange.expectedCompletion ?? NOT_YET_FOUND}. Check the source and edit if it is right; nothing changed automatically.
            </p>
          </Alert>
        ) : null}
        {d.rejectionNote ? <p className="text-muted-foreground">Rejection note: {d.rejectionNote}</p> : null}
        {item.blockers.length ? (
          <div>
            <p className="font-medium">Blocking publication</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {item.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground">Ready to publish.</p>
        )}

        <div className="flex flex-wrap items-start gap-3">
          {isAdmin && !d.published ? (
            <DevelopmentReviewForm id={d.id} version={d.version} action="publish" label="Publish" variant="primary" withVerification />
          ) : null}
          {isAdmin && d.published ? <DevelopmentReviewForm id={d.id} version={d.version} action="unpublish" label="Unpublish" /> : null}
          {d.reviewStatus !== "rejected" && (isAdmin || !d.published) ? (
            <DevelopmentReviewForm id={d.id} version={d.version} action="reject" label="Reject" variant="ghost" withNote />
          ) : null}
          {d.reviewStatus === "rejected" ? <DevelopmentReviewForm id={d.id} version={d.version} action="restore" label="Restore to pending" /> : null}
        </div>
        {!isAdmin ? <p className="text-xs text-muted-foreground">Only an admin can publish or unpublish.</p> : null}

        {isAdmin || !d.published ? (
          <details>
            <summary className="cursor-pointer font-medium">Edit details</summary>
            <div className="pt-3">
              <DevelopmentFieldsForm mode="edit" draft={draft} localities={localities} />
            </div>
          </details>
        ) : null}

        <details>
          <summary className="cursor-pointer font-medium">Review history ({item.audit.length})</summary>
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-2 font-medium">When</th>
                <th scope="col" className="py-1 pr-2 font-medium">Action</th>
                <th scope="col" className="py-1 pr-2 font-medium">By</th>
                <th scope="col" className="py-1 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {item.audit.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="py-1 pr-2">{formatDate(e.at)}</td>
                  <td className="py-1 pr-2">{e.action}</td>
                  <td className="py-1 pr-2">{e.actorRole}</td>
                  <td className="py-1">{e.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </article>
    </li>
  );
}
