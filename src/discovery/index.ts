// Lane B entry point: runs only runnable sources, normalises, dedupes, limits.
// Errors from one adapter are captured and never thrown to the caller.
import type { ExternalListing, Project } from "@/domain/types";
import { normalizeRecord, type DiscoveryAdapter, type DiscoveryQuery, type NormalizedRecord } from "./adapter";
import { createFixtureAdapter, filterRecords } from "./adapters/fixture-adapter";
import { dedupe, type ReviewFlag } from "./dedupe";
import { SAMPLE_RECORDS } from "./fixtures";
import { SOURCE_REGISTRY, currentEnv, getSource, isRunnable, type RuntimeEnv, type SourceEntry } from "./registry";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export interface DiscoverOptions {
  env?: RuntimeEnv;
  adapters?: DiscoveryAdapter[];
  now?: Date;
  projects?: Project[]; // researched projects to match against (RERA only sets matchedProjectId)
  registry?: readonly SourceEntry[];
}

export interface DiscoveryReport {
  listings: ExternalListing[];
  errors: { sourceId: string; message: string }[];
  skipped: { sourceId: string; reason: string }[];
  reviewFlags: ReviewFlag[];
}

const clampLimit = (n?: number) => Math.max(0, Math.min(MAX_LIMIT, Math.floor(n ?? DEFAULT_LIMIT)));

export function defaultAdapters(registry: readonly SourceEntry[] = SOURCE_REGISTRY): DiscoveryAdapter[] {
  return registry.filter((s) => s.accessMethod === "fixture").map((s) => createFixtureAdapter(s.id));
}

function finish(records: NormalizedRecord[], query: DiscoveryQuery, projects: readonly Project[]) {
  const { clusters, reviewFlags } = dedupe(records, projects);
  return { listings: clusters.map((c) => c.listing).slice(0, clampLimit(query.limit)), reviewFlags };
}

export async function discoverExternalWithReport(query: DiscoveryQuery, opts: DiscoverOptions = {}): Promise<DiscoveryReport> {
  const env = opts.env ?? currentEnv();
  const now = opts.now ?? new Date();
  const registry = opts.registry ?? SOURCE_REGISTRY;
  const errors: DiscoveryReport["errors"] = [];
  const skipped: DiscoveryReport["skipped"] = [];

  const runnable: { adapter: DiscoveryAdapter; source: SourceEntry }[] = [];
  for (const adapter of opts.adapters ?? defaultAdapters(registry)) {
    const source = getSource(adapter.sourceId, registry);
    if (!source) skipped.push({ sourceId: adapter.sourceId, reason: "not in source registry" });
    else if (!isRunnable(source, env)) skipped.push({ sourceId: source.id, reason: `not runnable in ${env} (status ${source.status})` });
    else runnable.push({ adapter, source });
  }

  const batches = await Promise.all(
    runnable.map(async ({ adapter, source }) => {
      try {
        const raws = await adapter.search(query);
        const out: NormalizedRecord[] = [];
        for (const raw of raws) {
          try {
            out.push(normalizeRecord({ ...raw, sourceId: source.id }, source, now));
          } catch (e) {
            errors.push({ sourceId: source.id, message: e instanceof Error ? e.message : String(e) });
          }
        }
        return out;
      } catch (e) {
        errors.push({ sourceId: source.id, message: e instanceof Error ? e.message : String(e) });
        return [];
      }
    }),
  );

  return { ...finish(batches.flat(), query, opts.projects ?? []), errors, skipped };
}

/** Listings only. Never throws because of an adapter failure. */
export async function discoverExternal(query: DiscoveryQuery, opts: DiscoverOptions = {}): Promise<ExternalListing[]> {
  return (await discoverExternalWithReport(query, opts)).listings;
}

/** Synchronous fixture-only helper for dev pages/tests. Returns [] where fixtures may not run (e.g. production). */
export function discoverSampleSync(query: DiscoveryQuery, opts: { env?: RuntimeEnv; now?: Date } = {}): ExternalListing[] {
  const env = opts.env ?? currentEnv();
  const now = opts.now ?? new Date();
  const records = SOURCE_REGISTRY.filter((s) => s.accessMethod === "fixture" && isRunnable(s, env)).flatMap((s) =>
    filterRecords(SAMPLE_RECORDS, s.id, query).map((r) => normalizeRecord(r, s, now)),
  );
  return finish(records, query, []).listings;
}

export * from "./adapter";
export * from "./registry";
export { dedupe, comparePair, normaliseUrl, nameSimilarity, distanceMeters, spreadMeters } from "./dedupe";
export type { DedupeCluster, DedupeResult, ReviewFlag, MergeReason, FlagReason } from "./dedupe";
export { createFixtureAdapter } from "./adapters/fixture-adapter";
