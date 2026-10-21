import "server-only";
import { z } from "zod";
import type { ExternalListing, Project } from "@/domain/types";
import { getLocality } from "@/config/markets";
import { discoverExternalWithReport, type DiscoverOptions, type DiscoveryReport } from "@/discovery";
import type { DiscoveryQuery } from "@/discovery";
import { minResearchedResults } from "../env";
import { log } from "../log";
import { getRepositories, type Repositories } from "../repositories";

export interface SearchQuery {
  localityId?: string;
  text?: string;
  limit?: number;
}

export interface SearchResult {
  /** Lane A: published, researched projects only. */
  researched: Project[];
  /** Lane B: external, unverified listings (only when researched results were insufficient). */
  external: ExternalListing[];
  /** True when Lane B was queried. */
  externalQueried: boolean;
  /** User-safe messages for sources that failed; present only when something failed. */
  externalErrors?: string[];
}

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

const querySchema = z.object({
  localityId: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(60)
    .optional()
    .catch(undefined),
  text: z.string().trim().max(100).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().catch(undefined),
});

export interface SearchDeps {
  repos?: Repositories;
  discover?: (query: DiscoveryQuery, opts: DiscoverOptions) => Promise<Pick<DiscoveryReport, "listings" | "errors">>;
  minResearched?: number;
}

export async function searchProperties(raw: SearchQuery = {}, deps: SearchDeps = {}): Promise<SearchResult> {
  const q = querySchema.parse(raw ?? {});
  const repos = deps.repos ?? getRepositories();
  const limit = q.limit ?? DEFAULT_SEARCH_LIMIT;
  const text = q.text || undefined;
  // An unknown locality id yields no results rather than silently searching everywhere.
  if (q.localityId && !getLocality(q.localityId)) return { researched: [], external: [], externalQueried: false };

  const researched = (await repos.projects.listProjects({ localityId: q.localityId, text, limit })).filter(
    (p) => p.published === true, // defence in depth: never return unpublished projects
  );

  const threshold = deps.minResearched ?? minResearchedResults();
  if (researched.length >= threshold) return { researched, external: [], externalQueried: false };

  const discover = deps.discover ?? discoverExternalWithReport;
  let report: Pick<DiscoveryReport, "listings" | "errors">;
  try {
    report = await discover({ localityId: q.localityId, text, limit }, { projects: researched });
  } catch (e) {
    log.error("search.discovery_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { researched, external: [], externalQueried: true, externalErrors: ["External listings are unavailable right now."] };
  }

  const researchedIds = new Set(researched.map((p) => p.id));
  const external = report.listings
    .filter((l) => l.lane === "external")
    .filter((l) => !(l.matchedProjectId && researchedIds.has(l.matchedProjectId)))
    .slice(0, limit);

  // Persist what we showed so leads can reference a listing id (best effort).
  if (external.length) {
    try {
      await repos.externalListings.upsertMany(external);
    } catch (e) {
      log.warn("search.external_upsert_failed", { reason: e instanceof Error ? e.name : "unknown" });
    }
  }

  const result: SearchResult = { researched, external, externalQueried: true };
  if (report.errors.length) {
    result.externalErrors = report.errors.map((err) => `Source "${err.sourceId}" could not be reached; its listings are not shown.`);
    log.warn("search.discovery_source_errors", { sources: report.errors.map((e) => e.sourceId) });
  }
  return result;
}
