import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getLocality } from "@/config/markets";
import { isStaffAuthError } from "@/server/auth";
import { listStaffProjects, type StaffProjectSummary } from "@/server/services/research";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatDate, formatPercent } from "@/components/property/format";
import { requireStaffPage } from "../_lib/session";

export const metadata: Metadata = { title: "Research projects", robots: { index: false, follow: false } };

export default function AdminProjectsPage() {
  return (
    <Suspense fallback={<div aria-busy="true" className="h-96 animate-pulse rounded-lg bg-muted" />}>
      <ProjectsContent />
    </Suspense>
  );
}

async function ProjectsContent() {
  await requireStaffPage("/admin/projects");
  let rows: StaffProjectSummary[];
  try {
    rows = await listStaffProjects();
  } catch (e) {
    if (isStaffAuthError(e)) redirect("/admin/login?next=%2Fadmin%2Fprojects");
    throw e;
  }
  rows = [...rows].sort((a, b) => a.project.name.localeCompare(b.project.name));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Research projects</h1>
          <p className="text-sm text-muted-foreground">All projects, published or not, with publish readiness.</p>
        </div>
        <Link href="/admin/projects/new" className={buttonVariants()}>
          New project
        </Link>
      </div>

      {rows.length === 0 ? (
        <Alert>
          <AlertTitle>No projects yet</AlertTitle>
          <p>Create a project to start adding facts with sources.</p>
        </Alert>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface" role="region" aria-label="Research projects" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                {["Project", "Locality", "Visibility", "Completeness", "Readiness", "Last checked"].map((h) => (
                  <th key={h} scope="col" className="p-3 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ project: p, readiness: r }) => (
                <tr key={p.id} className="border-b border-border align-top last:border-b-0">
                  <th scope="row" className="p-3 font-medium">
                    <Link href={`/admin/projects/${encodeURIComponent(p.id)}`} className="text-primary underline-offset-4 hover:underline">
                      {p.name}
                    </Link>
                    <p className="text-xs font-normal text-muted-foreground">{p.developer.name}</p>
                    {p.isSample ? (
                      <Badge tone="warning" className="mt-1">
                        Sample data
                      </Badge>
                    ) : null}
                  </th>
                  <td className="p-3">{getLocality(p.localityId)?.name ?? p.localityId}</td>
                  <td className="space-y-1 p-3">
                    <Badge tone={p.published ? "success" : "neutral"}>{p.published ? "Published" : "Unpublished"}</Badge>
                    {p.published && !r.ready ? (
                      <Badge tone="warning" className="block w-fit whitespace-normal">
                        Published but no longer meets publish rules
                      </Badge>
                    ) : null}
                  </td>
                  <td className="p-3">{formatPercent(r.completeness)}</td>
                  <td className="p-3">
                    {r.ready ? (
                      <Badge tone="success">Ready</Badge>
                    ) : (
                      <Badge tone="warning">
                        {r.blockers.length} blocker{r.blockers.length === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap p-3">{formatDate(p.lastCheckedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
