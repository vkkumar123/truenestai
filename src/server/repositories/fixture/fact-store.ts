import "server-only";
import type { Project } from "@/domain/types";
import { getSource, isWebResearchSource } from "@/discovery/registry";
import {
  factAttributeSchema,
  factEntityIdSchema,
  factEntityTypeSchema,
  getFactAttribute,
  mapFactsCurrentRow,
  resolveFactsCurrent,
  tryIsoDate,
  type CurrentFact,
  type FactCandidateInput,
  type FactEntityType,
} from "../fact-store";
import type { FactStoreRepository } from "../types";

// OBVIOUSLY FICTIONAL observations for local development and tests: SAMPLE project ids only,
// example.com / example.org URLs, fixture sources, is_sample true. Not real dates or facts.

const SAMPLE_PROJECT = "sample-proj-lakeview";

const base = {
  entity_type: "project",
  entity_id: SAMPLE_PROJECT,
  origin: "observation",
  value_text: null,
  value_num: null,
  value_date: null,
  value_json: null,
  unit: null,
  confidence: null,
  estimate_basis: null,
  excerpt: null,
  verification: "unverified",
  is_sample: true,
} as const;

export const SAMPLE_FACT_OBSERVATIONS: readonly FactCandidateInput[] = [
  {
    ...base,
    fact_id: "sample-obs-lakeview-possession-builder",
    attribute: "promised_possession",
    value_date: "2028-12-31",
    truth_status: "official",
    source_id: "sample-feed",
    source_url: "https://example.com/sample/lakeview/possession",
    source_type: "builder",
    observed_at: "2026-09-01T09:00:00.000Z",
    last_verified_at: "2026-09-01T09:00:00.000Z",
    ttl_hours: 168,
    added_by: "crawl",
  },
  {
    ...base,
    fact_id: "sample-obs-lakeview-possession-registry",
    attribute: "promised_possession",
    value_date: "2029-06-30",
    truth_status: "official",
    source_id: "sample-feed-mirror",
    source_url: "https://example.org/sample/lakeview/registry-extension",
    source_type: "rera",
    observed_at: "2026-10-01T09:00:00.000Z",
    last_verified_at: "2026-10-01T09:00:00.000Z",
    ttl_hours: 168,
    added_by: "crawl",
  },
  {
    ...base,
    fact_id: "sample-obs-lakeview-possession-estimate",
    attribute: "promised_possession",
    value_date: "2029-12-31",
    truth_status: "estimated",
    estimate_basis: {
      sources: [{ sourceId: "sample-feed", url: "https://example.com/sample/lakeview/forum-thread", observedAt: "2026-10-05T09:00:00.000Z" }],
      signalCount: 1,
    },
    source_id: "sample-feed",
    source_url: "https://example.com/sample/lakeview/forum-thread",
    source_type: "reddit",
    observed_at: "2026-10-05T09:00:00.000Z",
    last_verified_at: "2026-10-05T09:00:00.000Z",
    ttl_hours: 168,
    added_by: "extraction",
  },
  {
    ...base,
    fact_id: "sample-obs-lakeview-oc-unknown",
    attribute: "oc_status",
    truth_status: "unknown",
    source_id: "sample-web-research",
    source_url: null,
    source_type: "search",
    observed_at: "2026-10-15T09:00:00.000Z",
    last_verified_at: "2026-10-15T09:00:00.000Z",
    ttl_hours: 72,
    added_by: "research",
  },
];

/** Registry source → spec 02 source_type (mirrors tn_spec_source_type in 0006). */
function specSourceType(sourceId: string): string | null {
  if (isWebResearchSource(sourceId)) return "search";
  const type = getSource(sourceId)?.type;
  if (!type) return null;
  return ({ regulator: "rera", government: "govt", developer: "builder", listing_portal: "portal" } as Record<string, string>)[type] ?? type;
}

/** Mirrors tn_source_is_official: regulator/government/developer, not web research, not rejected. */
function isOfficialSource(sourceId: string): boolean {
  const s = getSource(sourceId);
  return !!s && ["regulator", "government", "developer"].includes(s.type) && !isWebResearchSource(sourceId) && s.status !== "rejected";
}

/** Current curated facts whose field maps to a catalogue attribute (as the view merges them). */
function curatedCandidates(projects: readonly Project[]): FactCandidateInput[] {
  const attr = getFactAttribute("project", "promised_possession")!;
  // M2: a known curated value without a source never enters facts_current
  return projects.filter((p) => p.declaredPossession.status === "unknown" || p.declaredPossession.sources.length > 0).map((p) => {
    const f = p.declaredPossession;
    const newestFirst = [...f.sources].sort((x, y) => y.observedAt.localeCompare(x.observedAt));
    // M3: an official-qualifying source represents the fact when there is one, then the newest
    const latest = newestFirst.find((s) => isOfficialSource(s.sourceId)) ?? newestFirst[0];
    const official = f.sources.some((s) => isOfficialSource(s.sourceId));
    const truth = f.truth ?? (f.status === "unknown" ? "unknown" : official ? "official" : "estimated");
    const observedAt = latest?.observedAt ?? p.lastCheckedAt;
    const text = f.status === "known" && typeof f.value === "string" ? f.value : null;
    const date = tryIsoDate(text); // L2: served and compared as a date
    return {
      ...base,
      entity_id: p.id,
      origin: "curated" as const,
      fact_id: `${p.id}:declared_possession`,
      attribute: attr.attribute,
      value_text: date ? null : text,
      value_date: date,
      truth_status: truth,
      estimate_basis: truth === "estimated" ? { sources: newestFirst.map((s) => ({ sourceId: s.sourceId, url: s.url, observedAt: s.observedAt })) } : null,
      verification: f.verification,
      source_id: latest?.sourceId ?? null,
      source_url: latest?.url ?? null,
      source_type: latest ? specSourceType(latest.sourceId) : null,
      observed_at: observedAt,
      last_verified_at: f.lastVerifiedAt ?? observedAt,
      ttl_hours: f.ttlHours ?? attr.defaultTtlHours,
      added_by: "staff",
      is_sample: p.isSample,
    };
  });
}

/**
 * Fixture facts_current: SAMPLE observations plus the curated declaredPossession of the shared
 * project store, resolved with the same precedence as the SQL view. Read-only.
 */
export class FixtureFactStoreRepository implements FactStoreRepository {
  constructor(
    private readonly projects: readonly Project[] = [],
    private readonly observations: readonly FactCandidateInput[] = SAMPLE_FACT_OBSERVATIONS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listCurrent(entityType: FactEntityType, entityId: string): Promise<CurrentFact[]> {
    const type = factEntityTypeSchema.parse(entityType);
    const id = factEntityIdSchema.parse(entityId);
    const candidates = [
      ...this.observations,
      ...(type === "project" ? curatedCandidates(this.projects.filter((p) => p.id === id)) : []),
    ].filter((c) => c.entity_type === type && c.entity_id === id);
    return resolveFactsCurrent(candidates, this.clock()).map(mapFactsCurrentRow);
  }

  async getCurrent(entityType: FactEntityType, entityId: string, attribute: string): Promise<CurrentFact | null> {
    const attr = factAttributeSchema.parse(attribute);
    return (await this.listCurrent(entityType, entityId)).find((f) => f.attribute === attr) ?? null;
  }
}
