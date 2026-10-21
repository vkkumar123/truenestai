import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import type { LeadRequestType } from "@/domain/types";
import { getLocality } from "@/config/markets";
import { getSource } from "@/discovery/registry";
import { BUDGET_BANDS } from "@/leads/validation";
import { getRepositories } from "@/server/repositories";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LeadForm } from "@/components/lead/lead-form";
import { BUDGET_BAND_LABEL } from "@/components/property/format";
import { EXTERNAL_LABEL } from "@/components/property/external-card";

export const metadata: Metadata = {
  title: "Request verification or buyer assistance",
  description: "Ask TrueNest to verify a property or help with your search. Your details are used only to respond.",
};

const ID = /^[A-Za-z0-9_-]{1,100}$/;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

function attr(v: string): string | undefined {
  const t = v.slice(0, 100);
  return t || undefined;
}

export default function RequestPage({ searchParams }: PageProps<"/request">) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Request verification or buyer assistance</h1>
        <p className="text-muted-foreground">
          Browsing is free and needs no details. Share them only if you want TrueNest to follow up.
        </p>
      </div>
      <Suspense fallback={<div aria-busy="true" className="h-[36rem] animate-pulse rounded-lg bg-muted" />}>
        <RequestContent searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function RequestContent({ searchParams }: { searchParams: PageProps<"/request">["searchParams"] }) {
  const sp = await searchParams;
  const projectParam = first(sp.project);
  const listingParam = first(sp.listing);
  const typeParam = first(sp.type);
  const from = first(sp.from);

  const repos = getRepositories();
  // A request refers to at most one property; a project reference wins over a listing.
  const projectId = ID.test(projectParam) ? projectParam : null;
  const listingId = !projectId && ID.test(listingParam) ? listingParam : null;
  const [project] = projectId ? (await repos.projects.getProjectsByIds([projectId])).filter((p) => p.published) : [];
  const listing = listingId ? await repos.externalListings.getById(listingId) : null;
  const missing = (projectId && !project) || (listingId && !listing);

  const defaultRequestType: LeadRequestType =
    typeParam === "verification" || typeParam === "buyer_assistance" ? typeParam : listing ? "verification" : "buyer_assistance";
  const landingPath = from.startsWith("/") && !from.startsWith("//") && from.length <= 300 ? from : "/request";

  return (
    <div className="space-y-6">
      {project ? (
        <Alert tone="info">
          <AlertTitle>About this project</AlertTitle>
          <p>
            <Link href={`/projects/${project.slug}`}>{project.name}</Link> · {project.developer.name} ·{" "}
            {getLocality(project.localityId)?.name ?? project.localityId}{" "}
            {project.isSample ? <Badge tone="warning">Sample data</Badge> : null}
          </p>
        </Alert>
      ) : null}
      {listing ? (
        <Alert tone="info">
          <AlertTitle>About this listing</AlertTitle>
          <p className="space-x-1">
            <span className="font-medium">{listing.title}</span>
            <Badge className="border-external/40 bg-external/10 text-external">{EXTERNAL_LABEL}</Badge>
            {listing.isSample ? <Badge tone="warning">Sample data</Badge> : null}
          </p>
          <p className="text-muted-foreground">Source: {getSource(listing.sourceId)?.name ?? listing.sourceId}</p>
        </Alert>
      ) : null}
      {missing ? (
        <Alert tone="warning" role="status">
          <AlertTitle>We could not find that property</AlertTitle>
          <p>It may no longer be available. You can still send a general request below.</p>
        </Alert>
      ) : null}

      <LeadForm
        defaultRequestType={defaultRequestType}
        projectId={project?.id ?? null}
        externalListingId={listing?.id ?? null}
        landingPath={landingPath}
        utm={{ utmSource: attr(first(sp.utm_source)), utmMedium: attr(first(sp.utm_medium)), utmCampaign: attr(first(sp.utm_campaign)) }}
        budgetBands={BUDGET_BANDS.map((b) => ({ value: b, label: BUDGET_BAND_LABEL[b] ?? b }))}
      />
    </div>
  );
}
