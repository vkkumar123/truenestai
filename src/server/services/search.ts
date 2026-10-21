import "server-only";
import { z } from "zod";
import type { ConstructionStatus, ExternalListing, Project } from "@/domain/types";
import { BHK_OPTIONS, CONSTRUCTION_STATUS_OPTIONS, SEARCH_LANES, type BhkOption, type SearchLane } from "@/domain/search-options";
import { getLocality } from "@/config/markets";
import {
  defaultAdapters,
  discoverExternalWithReport,
  type DiscoverOptions,
  type DiscoveryAdapter,
  type DiscoveryReport,
} from "@/discovery";
import type { DiscoveryQuery } from "@/discovery";
import { minResearchedResults } from "../env";
import { log } from "../log";
import { getRepositories, type Repositories } from "../repositories";

export interface SearchQuery {
  localityId?: string;
  text?: string;
  limit?: number;
  /** One of BHK_OPTIONS ("1".."4", "5+"); matched against unit labels like "2 BHK". Lane A only. */
  bhk?: string;
  /** One of CONSTRUCTION_STATUS_OPTIONS; matches only where the status is known. Lane A only. */
  status?: ConstructionStatus | string;
  /** "all" (default) | "researched" | "external". */
  lane?: SearchLane | string;
}

export interface SearchResult {
  /** Lane A: published, researched projects only. */
  researched: Project[];
  /** Lane B: external, unverified listings. */
  external: ExternalListing[];
  /** True when Lane B was queried. */
  externalQueried: boolean;
  /** User-safe messages for sources that failed; present only when something failed. */
  externalErrors?: string[];
  /** User-facing notes about how filters were applied (e.g. filters that do not apply to Lane B). */
  notes?: string[];
  /**
   * For shown Lane B listings that dedupe matched (by RERA number) to a PUBLISHED researched
   * project: listing id → that project, so the UI can offer "Researched version available".
   */
  matchedProjects: Record<string, MatchedProjectRef>;
}

export interface MatchedProjectRef {
  id: string;
  slug: string;
  name: string;
}

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

export const LANE_B_FILTER_NOTE =
  "Configuration (BHK) and construction-status filters apply only to researched projects; external listings do not provide them reliably.";

const querySchema = z.object({
  localityId: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60).optional().catch(undefined),
  text: z.string().trim().max(100).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().catch(undefined),
  bhk: z.enum(BHK_OPTIONS).optional().catch(undefined),
  status: z.enum(CONSTRUCTION_STATUS_OPTIONS).optional().catch(undefined),
  lane: z.enum(SEARCH_LANES).optional().catch(undefined),
});

export interface SearchDeps {
  repos?: Repositories;
  discover?: (query: DiscoveryQuery, opts: DiscoverOptions) => Promise<Pick<DiscoveryReport, "listings" | "errors">>;
  minResearched?: number;
  /** Lane B adapters (default: discovery's defaultAdapters()). */
  adapters?: DiscoveryAdapter[];
}

/**
 * Lane A first. Lane B (external, unverified) is queried when:
 *  - lane = "external": always (researched is then empty), or
 *  - lane = "all" (default): only when fewer than MIN_RESEARCHED_RESULTS researched results were
 *    found AND no Lane-A-only filter (bhk/status) is set.
 * lane = "researched" never queries Lane B. Lane B listings matched to a returned researched
 * project are not repeated. Invalid filter values are ignored (treated as absent).
 */
export async function searchProperties(raw: SearchQuery = {}, deps: SearchDeps = {}): Promise<SearchResult> {
  const q = querySchema.parse(raw ?? {});
  const repos = deps.repos ?? getRepositories();
  const limit = q.limit ?? DEFAULT_SEARCH_LIMIT;
  const text = q.text || undefined;
  const lane: SearchLane = q.lane ?? "all";
  const bhk: BhkOption | undefined = q.bhk;
  const laneAOnlyFilter = Boolean(bhk || q.status);
  // An unknown locality id yields no results rather than silently searching everywhere.
  if (q.localityId && !getLocality(q.localityId)) return { researched: [], external: [], externalQueried: false, matchedProjects: {} };

  const researched =
    lane === "external"
      ? []
      : (await repos.projects.listProjects({ localityId: q.localityId, text, status: q.status, bhk, limit })).filter(
          (p) => p.published === true, // defence in depth: never return unpublished projects
        );

  const notes: string[] = [];
  const done = (r: SearchResult): SearchResult => (notes.length ? { ...r, notes } : r);

  if (lane === "researched") return done({ researched, external: [], externalQueried: false, matchedProjects: {} });
  if (lane === "all") {
    const threshold = deps.minResearched ?? minResearchedResults();
    if (researched.length >= threshold) return done({ researched, external: [], externalQueried: false, matchedProjects: {} });
    if (laneAOnlyFilter) {
      notes.push(LANE_B_FILTER_NOTE);
      return done({ researched, external: [], externalQueried: false, matchedProjects: {} });
    }
  } else if (laneAOnlyFilter) {
    notes.push(LANE_B_FILTER_NOTE);
  }

  // Match Lane B against published projects found BY RERA NUMBER (no project-count cap), plus
  // the returned researched results, so a listing for a known project carries matchedProjectId
  // even under lane=external. The adapters are wrapped to look up candidates from each raw
  // batch's RERA numbers; discovery reads `projects` only after all adapters finish (dedupe),
  // which a unit test guards. The match itself is still made by discovery's dedupe.
  const matchPool: Project[] = researched.filter((p) => p.published === true);
  const projectById = new Map(matchPool.map((p) => [p.id, p]));
  const addCandidates = (found: Project[]) => {
    for (const p of found) {
      if (p.published !== true || projectById.has(p.id)) continue;
      projectById.set(p.id, p);
      matchPool.push(p);
    }
  };
  const withReraLookup = (a: DiscoveryAdapter): DiscoveryAdapter => ({
    sourceId: a.sourceId,
    search: async (query) => {
      const raws = await a.search(query);
      const numbers = raws.map((x) => x.reraNumber).filter((x): x is string => typeof x === "string" && x.trim() !== "");
      if (numbers.length) addCandidates(await repos.projects.findPublishedProjectsByRera(numbers));
      return raws;
    },
  });

  const discover = deps.discover ?? discoverExternalWithReport;
  let report: Pick<DiscoveryReport, "listings" | "errors">;
  try {
    const adapters = (deps.adapters ?? defaultAdapters()).map(withReraLookup);
    report = await discover({ localityId: q.localityId, text, limit }, { projects: matchPool, adapters });
  } catch (e) {
    log.error("search.discovery_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return done({ researched, external: [], externalQueried: true, externalErrors: ["External listings are unavailable right now."], matchedProjects: {} });
  }

  const researchedIds = new Set(researched.map((p) => p.id)); // only these are hidden as duplicates
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

  const matchedProjects: Record<string, MatchedProjectRef> = {};
  for (const l of external) {
    const p = l.matchedProjectId ? projectById.get(l.matchedProjectId) : undefined;
    if (p) matchedProjects[l.id] = { id: p.id, slug: p.slug, name: p.name };
  }

  const result: SearchResult = { researched, external, externalQueried: true, matchedProjects };
  if (report.errors.length) {
    result.externalErrors = report.errors.map((err) => `Source "${err.sourceId}" could not be reached; its listings are not shown.`);
    log.warn("search.discovery_source_errors", { sources: report.errors.map((e) => e.sourceId) });
  }
  return done(result);
}
