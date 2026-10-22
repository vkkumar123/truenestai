import Link from "next/link";
import { Globe } from "lucide-react";
import type { ExternalListing } from "@/domain/types";
import { getLocality } from "@/config/markets";
import { getSource } from "@/discovery/registry";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { formatDate } from "./format";
import { SafeExternalLink } from "./safe-link";

export const EXTERNAL_LABEL = "Externally discovered — not verified by TrueNest";

export function ExternalListingCard({ listing }: { listing: ExternalListing }) {
  const sourceName = getSource(listing.sourceId)?.name ?? listing.sourceId;
  const locality = listing.localityId ? getLocality(listing.localityId)?.name ?? listing.localityId : null;
  return (
    <Card className="flex h-full flex-col border-dashed border-external/40">
      <CardHeader>
        <div className="flex flex-wrap gap-1.5">
          <Badge className="border-external/40 bg-external/10 text-external">{EXTERNAL_LABEL}</Badge>
          {listing.isSample ? <Badge tone="warning">Sample data</Badge> : null}
        </div>
        <CardTitle>{listing.title}</CardTitle>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Globe aria-hidden="true" className="size-4" /> Source: {sourceName}
        </p>
      </CardHeader>
      <CardContent className="flex-1 space-y-2 text-sm">
        <SafeExternalLink url={listing.canonicalUrl} srLabel="(opens the source site in a new tab)" />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <dt>Discovered</dt>
          <dd>{formatDate(listing.discoveredAt)}</dd>
          <dt>Last seen</dt>
          <dd>{listing.lastSeenAt ? formatDate(listing.lastSeenAt) : "Not recorded"}</dd>
          {locality ? (
            <>
              <dt>Locality (as shown by source)</dt>
              <dd>{locality}</dd>
            </>
          ) : null}
          {listing.priceText ? (
            <>
              <dt>Price (as shown by source, unverified)</dt>
              <dd>{listing.priceText}</dd>
            </>
          ) : null}
        </dl>
        <div>
          <p className="text-xs font-medium">Limitations</p>
          {listing.limitations.length ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {listing.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Not reviewed by TrueNest. Details may be incomplete or out of date.</p>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Link href={`/request?listing=${encodeURIComponent(listing.id)}&type=verification`} className={buttonVariants({ variant: "secondary", size: "sm" })}>
          Request verification<span className="sr-only"> of {listing.title}</span>
        </Link>
      </CardFooter>
    </Card>
  );
}
