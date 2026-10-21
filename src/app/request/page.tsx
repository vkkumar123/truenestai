import type { Metadata } from "next";
import { Suspense } from "react";
import type { LeadRequestType } from "@/domain/types";
import { BUDGET_BANDS } from "@/leads/validation";
import { getRequestSubject } from "@/server/services/projects";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { LeadForm } from "@/components/lead/lead-form";
import { BUDGET_BAND_LABEL } from "@/components/property/format";
import { EXTERNAL_LABEL } from "@/components/property/external-card";

export const metadata: Metadata = {
  title: "Request verification or buyer assistance",
  description: "Ask TrueNest to verify a property or help with your search. Your details are used only to respond.",
};

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

  // A request refers to at most one property; the service lets a project reference win.
  const subject =
    projectParam || listingParam
      ? await getRequestSubject({ projectId: projectParam || null, externalListingId: projectParam ? null : listingParam || null })
      : null;
  const missing = (projectParam || listingParam) && !subject;
  const isListing = subject?.kind === "external_listing";

  const defaultRequestType: LeadRequestType =
    typeParam === "verification" || typeParam === "buyer_assistance" ? typeParam : isListing ? "verification" : "buyer_assistance";
  const landingPath = from.startsWith("/") && !from.startsWith("//") && from.length <= 300 ? from : "/request";

  return (
    <div className="space-y-6">
      {subject ? (
        <Alert tone="info">
          <AlertTitle>{isListing ? "About this listing" : "About this project"}</AlertTitle>
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{subject.name}</span>
            {isListing ? (
              <Badge className="border-external/40 bg-external/10 text-external">{EXTERNAL_LABEL}</Badge>
            ) : (
              <Badge tone="info">Researched by TrueNest</Badge>
            )}
            {subject.isSample ? <Badge tone="warning">Sample data</Badge> : null}
          </p>
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
        projectId={subject?.kind === "project" ? subject.id : null}
        externalListingId={isListing ? subject.id : null}
        landingPath={landingPath}
        utm={{ utmSource: attr(first(sp.utm_source)), utmMedium: attr(first(sp.utm_medium)), utmCampaign: attr(first(sp.utm_campaign)) }}
        budgetBands={BUDGET_BANDS.map((b) => ({ value: b, label: BUDGET_BAND_LABEL[b] ?? b }))}
      />
    </div>
  );
}
