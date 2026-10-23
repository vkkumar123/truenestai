// One research call for one query: registry gate → research client → evidence → validator →
// the normal Lane B normalise + dedupe pipeline. Returns unverified ExternalListings; it never
// stores, publishes or verifies anything (the caller stores them as Lane B records).
import type { ExternalListing, Project } from "@/domain/types";
import { discoverExternalWithReport } from "../index";
import { SOURCE_REGISTRY, SourceNotRunnableError, assertRunnable, type RuntimeEnv, type SourceEntry } from "../registry";
import { ResearchClientError, type ResearchClient, type ResearchUsage } from "./client";
import { CandidateParseError, extractEvidence, parseCandidates } from "./evidence";
import { MAX_CANDIDATES, validateCandidates, type ValidationReport } from "./validate";

export interface ResearchRunOptions {
  client: ResearchClient;
  source: SourceEntry;
  env: RuntimeEnv;
  now?: Date;
  registry?: readonly SourceEntry[];
  localityNames: string[];
  localityName?: string | null;
  signal?: AbortSignal;
  /** Published projects by RERA number, so a listing links to a researched project only via RERA. */
  resolveProjectsByRera?: (reraNumbers: string[]) => Promise<Project[]>;
}

export interface ResearchRunResult {
  listings: ExternalListing[];
  validation: Omit<ValidationReport, "accepted"> & { accepted: number };
  usage: ResearchUsage;
  stopReason: string | null;
  reviewFlags: number;
  normaliseErrors: number;
}

/** Throws ResearchClientError("source_not_runnable") unless the source may run in `env`. */
export function assertResearchRunnable(source: SourceEntry, env: RuntimeEnv, client: ResearchClient): void {
  try {
    assertRunnable(source, env);
  } catch (e) {
    if (e instanceof SourceNotRunnableError) throw new ResearchClientError("source_not_runnable", false);
    throw e;
  }
  // Fixture (fictional) sources only ever pair with the network-free fake client.
  if (source.type === "fixture" && client.kind !== "fake") throw new ResearchClientError("source_not_runnable", false);
}

export async function researchQuery(queryText: string, opts: ResearchRunOptions): Promise<ResearchRunResult> {
  assertResearchRunnable(opts.source, opts.env, opts.client);
  const res = await opts.client.research({
    queryText,
    localityNames: opts.localityNames,
    localityName: opts.localityName ?? null,
    signal: opts.signal,
  });
  if (res.stopReason === "refusal") throw new ResearchClientError("refusal", false, res.usage);
  if (res.stopReason === "max_tokens") throw new ResearchClientError("max_tokens", false, res.usage);

  const evidence = extractEvidence(res.content);
  let candidates: unknown[];
  try {
    candidates = parseCandidates(evidence.text);
  } catch (e) {
    if (e instanceof CandidateParseError) throw new ResearchClientError("parse_error", true, res.usage);
    throw e;
  }
  // Fail closed and visibly if candidates arrive without any search-result blocks to check them
  // against (e.g. an API change that stops returning them): every candidate would be dropped.
  if (candidates.length > 0 && evidence.searchResultBlocks === 0) throw new ResearchClientError("no_evidence", false, res.usage);
  const report = validateCandidates(candidates, evidence);

  const source = opts.source;
  const registry = [source, ...(opts.registry ?? SOURCE_REGISTRY).filter((s) => s.id !== source.id)];
  const discovery = await discoverExternalWithReport(
    { text: queryText, limit: MAX_CANDIDATES },
    {
      env: opts.env,
      now: opts.now,
      registry,
      adapters: [{ sourceId: source.id, search: async () => report.accepted.map((r) => ({ ...r, sourceId: source.id })) }],
      resolveProjectsByRera: opts.resolveProjectsByRera,
    },
  );
  if (discovery.skipped.length) throw new ResearchClientError("source_not_runnable", false, res.usage);

  return {
    listings: discovery.listings,
    validation: { received: report.received, accepted: report.accepted.length, dropped: report.dropped, fieldsDropped: report.fieldsDropped },
    usage: res.usage,
    stopReason: res.stopReason,
    reviewFlags: discovery.reviewFlags.length,
    normaliseErrors: discovery.errors.filter((e) => e.sourceId === source.id).length,
  };
}
