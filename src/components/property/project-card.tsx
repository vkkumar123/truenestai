import type { ReactNode } from "react";
import Link from "next/link";
import { Building2, MapPin } from "lucide-react";
import type { Project } from "@/domain/types";
import { getLocality } from "@/config/markets";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { CONSTRUCTION_STATUS_LABEL, formatDate, formatPercent, NOT_YET_FOUND } from "./format";
import { UnknownBadge, VerificationBadge } from "./verification-badge";

export function ProjectCard({ project, compareSlot }: { project: Project; compareSlot?: ReactNode }) {
  const locality = getLocality(project.localityId)?.name ?? project.localityId;
  const status = project.constructionStatus;
  const rera = project.reraNumbers;
  const statusKnown = status.status === "known" && status.value !== null && status.value !== "unknown";
  const reraKnown = rera.status === "known" && !!rera.value?.length;
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="info">Researched by TrueNest</Badge>
          {project.isSample ? <Badge tone="warning">Sample data</Badge> : null}
        </div>
        <CardTitle>
          <Link href={`/projects/${project.slug}`} className="hover:underline">
            {project.name}
          </Link>
        </CardTitle>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Building2 aria-hidden="true" className="size-4" /> {project.developer.name}
        </p>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <MapPin aria-hidden="true" className="size-4" /> {locality}
        </p>
      </CardHeader>
      <CardContent className="flex-1">
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Construction status</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {statusKnown ? CONSTRUCTION_STATUS_LABEL[status.value!] : <span className="text-muted-foreground">{NOT_YET_FOUND}</span>}
              {statusKnown ? <VerificationBadge state={status.verification} /> : <UnknownBadge />}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">RERA registration (not title clearance)</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {reraKnown ? <span className="font-mono text-xs">{rera.value!.join(", ")}</span> : <span className="text-muted-foreground">{NOT_YET_FOUND}</span>}
              {reraKnown ? <VerificationBadge state={rera.verification} /> : <UnknownBadge />}
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Data completeness {formatPercent(project.completeness)}</span>
            <span>Last checked {formatDate(project.lastCheckedAt)}</span>
          </div>
        </dl>
      </CardContent>
      <CardFooter className="justify-between">
        <Link href={`/projects/${project.slug}`} className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          View evidence<span className="sr-only"> for {project.name}</span>
        </Link>
        {compareSlot}
      </CardFooter>
    </Card>
  );
}
