import { CalendarClock, Info, MapPin } from "lucide-react";
import type { Development, GeoPoint } from "@/domain/types";
import { getLocality } from "@/config/markets";
import {
  INFRA_CATEGORY_LABEL,
  INFRA_STAGE_HELP,
  INFRA_STAGE_LABEL,
  PLANNED_DISCLAIMER,
  PLANNED_HEADING,
  describeSlips,
  expectedLabel,
  formatStraightLine,
  sortRevisions,
  summarizeSlips,
  type NearbyDevelopment,
} from "@/locality/developments";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatDate, NOT_YET_FOUND } from "./format";
import { SafeExternalLink } from "./safe-link";
import { VerificationBadge } from "./verification-badge";

const STAGE_TONE = {
  proposed: "neutral",
  approved: "info",
  dpr_approved: "info",
  tendered: "info",
  under_construction: "warning",
  operational: "success",
  shelved: "danger",
} as const;

/**
 * "Planned around here (next 5–10 years)". Published developments only (the service filters).
 * items === null → the list could not be loaded (error state). [] → honest "Not yet researched".
 */
/** What a straight-line distance is measured from, worded honestly for the project's location precision. */
export function distanceOrigin(precision: GeoPoint["precision"], localityName: string): string {
  if (precision === "exact") return "from this project";
  if (precision === "locality_centroid") return `from the ${localityName} locality centre (the project's exact location is not yet mapped)`;
  return "from this project's approximate location";
}

export function PlannedDevelopments({
  items,
  localityName,
  originPrecision,
  headingLevel = 2,
}: {
  items: NearbyDevelopment[] | null;
  localityName: string;
  /** Precision of the point distances are measured from (the project's location). */
  originPrecision: GeoPoint["precision"];
  headingLevel?: 2 | 3;
}) {
  const origin = distanceOrigin(originPrecision, localityName);
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby="planned-heading" className="space-y-3">
      <H id="planned-heading" className={headingLevel === 2 ? "text-lg font-semibold" : "text-base font-semibold"}>
        {PLANNED_HEADING}
      </H>
      <Alert tone="warning" role="note">
        <p className="font-medium">{PLANNED_DISCLAIMER}</p>
        <p className="mt-1 text-muted-foreground">
          Stages and dates are as declared by the authority or source on the date shown. Distances are straight-line, not travel time.
        </p>
      </Alert>
      {items === null ? (
        <Alert tone="neutral" role="status">
          Planned developments could not be loaded right now. Please try again later.
        </Alert>
      ) : items.length === 0 ? (
        <div role="status" className="rounded-lg border border-dashed border-border bg-surface p-4 text-sm">
          <p className="font-medium">Not yet researched</p>
          <p className="mt-1 text-muted-foreground">
            We have not yet published researched infrastructure plans around {localityName}. This does not mean nothing is planned here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3" aria-label={`Planned developments around ${localityName}`}>
          {items.map((n) => (
            <DevelopmentCard key={n.development.id} item={n} origin={origin} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DevelopmentCard({ item, origin }: { item: NearbyDevelopment<Development>; origin: string }) {
  const d = item.development;
  const slips = summarizeSlips(d.completionHistory);
  const history = sortRevisions(d.completionHistory);
  const localities = d.localityIds.map((id) => getLocality(id)?.name ?? id).join(", ");
  return (
    <li className="space-y-2 rounded-lg border border-border bg-surface p-4 text-sm" aria-label={d.name}>
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="mr-1 text-base font-semibold">{d.name}</p>
        <Badge tone="outline">{INFRA_CATEGORY_LABEL[d.category]}</Badge>
        <Badge tone={STAGE_TONE[d.stage]} title={INFRA_STAGE_HELP[d.stage]}>
          Stage: {INFRA_STAGE_LABEL[d.stage]}
        </Badge>
        <VerificationBadge state={d.verification} />
        {d.isSample ? <Badge tone="warning">Sample data — fictional</Badge> : null}
      </div>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">Authority</dt>
        <dd>{d.authority ?? NOT_YET_FOUND}</dd>
        <dt className="text-muted-foreground">Expected</dt>
        <dd className="flex items-start gap-1">
          <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            {expectedLabel(d.expectedCompletion)}
            <span className="text-muted-foreground"> — not a TrueNest estimate or guarantee</span>
          </span>
        </dd>
        <dt className="text-muted-foreground">Slip history</dt>
        <dd>
          <p>{describeSlips(slips)}</p>
          {history.length > 1 ? (
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted-foreground">
              {history.map((h, i) => (
                <li key={`${h.asOf}-${i}`}>
                  {h.expectedCompletion} (declared, seen {formatDate(h.asOf)})
                </li>
              ))}
            </ol>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Distance</dt>
        <dd className="flex items-start gap-1">
          <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          {item.distanceMeters !== null ? (
            <span>
              {formatStraightLine(item.distanceMeters)} {origin}
              {d.location?.precision !== "exact" ? <span className="text-muted-foreground"> (development location approximate)</span> : null}
            </span>
          ) : (
            <span className="text-muted-foreground">Location not yet mapped (listed for {localities || "this area"})</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd className="space-y-0.5">
          {d.sourceUrl ? <SafeExternalLink url={d.sourceUrl} srLabel={`(source for ${d.name}, opens in a new tab)`} /> : <span>{NOT_YET_FOUND}</span>}
          <p className="text-muted-foreground">
            Seen on the source {formatDate(d.sourceObservedAt)} · Last checked {formatDate(d.lastCheckedAt)}
          </p>
        </dd>
      </dl>
      <p className="flex items-start gap-1 text-xs text-muted-foreground">
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {d.addedBy === "research"
          ? "Found by automated web research, then reviewed and published by TrueNest staff. Details may be out of date."
          : "Entered by TrueNest staff from the authority's page."}
      </p>
    </li>
  );
}
