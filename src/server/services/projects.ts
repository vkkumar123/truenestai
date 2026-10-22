import "server-only";
import { z } from "zod";
import type { Project } from "@/domain/types";
import { currentEnv, getSource, isRunnable, isWebResearchSource, type RuntimeEnv } from "@/discovery";
import { getRepositories, type Repositories } from "../repositories";

const slugSchema = z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const idSchema = z.string().trim().min(1).max(100);

/** A published project by slug, or null if it does not exist or is not published. */
export async function getPublishedProject(slug: string, deps: { repos?: Repositories } = {}): Promise<Project | null> {
  const parsed = slugSchema.safeParse(slug);
  if (!parsed.success) return null;
  const project = await (deps.repos ?? getRepositories()).projects.getProjectBySlug(parsed.data);
  return project && project.published === true ? project : null;
}

/** True when published SAMPLE data is being shown (for the sample-data banner). Side-effect free. */
export async function hasSampleData(deps: { repos?: Repositories } = {}): Promise<boolean> {
  return (deps.repos ?? getRepositories()).projects.hasSampleData();
}

export interface RequestSubject {
  kind: "project" | "external_listing";
  id: string;
  name: string;
  isSample: boolean;
}

/**
 * Minimal public summary of what a lead request is about (for the request form heading).
 * Projects: published only. External listings: as stored (always unverified). Else null.
 * If both ids are given, the project wins.
 */
export async function getRequestSubject(
  ref: { projectId?: string | null; externalListingId?: string | null },
  deps: { repos?: Repositories; env?: RuntimeEnv } = {},
): Promise<RequestSubject | null> {
  const repos = deps.repos ?? getRepositories();
  const projectId = idSchema.safeParse(ref.projectId);
  if (projectId.success) {
    const [p] = await repos.projects.getProjectsByIds([projectId.data]);
    if (p && p.published === true) return { kind: "project", id: p.id, name: p.name, isSample: p.isSample };
    return null;
  }
  const listingId = idSchema.safeParse(ref.externalListingId);
  if (listingId.success) {
    const l = await repos.externalListings.getById(listingId.data);
    // Web research listings are shown only while their source may run here (a suspended source
    // hides everything it found, including on the request form).
    if (l && isWebResearchSource(l.sourceId)) {
      const source = getSource(l.sourceId);
      if (!source || !isRunnable(source, deps.env ?? currentEnv())) return null;
    }
    if (l) return { kind: "external_listing", id: l.id, name: l.title, isSample: l.isSample };
  }
  return null;
}
