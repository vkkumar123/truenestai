// Approved source registry for Lane B (external discovery).
// A source may run only when status is "approved" AND the current environment is allowed.
// See docs/DATA_SOURCE_POLICY.md. Never mark a source approved without a recorded ToS review.
import type { SourceType } from "@/domain/types";

export type SourceStatus = "proposed" | "approved" | "suspended" | "rejected";
export type AccessMethod = "api" | "partner_feed" | "licensed" | "link_out_only" | "manual" | "fixture";
export type RuntimeEnv = "test" | "development" | "production";

/** Fields of a discovered record that a source permits us to store. */
export type StorableField =
  | "title"
  | "developer_name"
  | "locality"
  | "location"
  | "price_text"
  | "canonical_url"
  | "source_record_id"
  | "rera_number"
  | "address";

export interface SourceEntry {
  id: string;
  name: string;
  type: SourceType;
  status: SourceStatus;
  accessMethod: AccessMethod;
  homepage: string;
  termsReviewedAt: string | null; // ISO date of a documented ToS review; null = not reviewed
  robotsNotes: string;
  rateLimitPerMinute: number; // 0 = no automated requests permitted
  storagePermissions: StorableField[];
  allowedEnvironments: RuntimeEnv[];
  listingLimitations: string[]; // source-specific caveats shown on every listing
  notes: string;
}

/** Limitation shown on every listing found by automated web research (after "Not verified by TrueNest"). */
export const RESEARCH_LIMITATION = "Found by automated web research; details may be out of date or incomplete.";

const NOT_REVIEWED =
  "Candidate only. Terms of use and robots rules have NOT been reviewed. No automated access. Requires owner approval and a documented review before any status change.";

export const SOURCE_REGISTRY: readonly SourceEntry[] = [
  {
    id: "sample-feed",
    name: "SAMPLE Feed (fictional fixture)",
    type: "fixture",
    status: "approved",
    accessMethod: "fixture",
    homepage: "https://example.com/",
    termsReviewedAt: null,
    robotsNotes: "Not applicable: in-repo fictional fixture, no network access.",
    rateLimitPerMinute: 0,
    storagePermissions: ["title", "developer_name", "locality", "location", "price_text", "canonical_url", "source_record_id", "rera_number", "address"],
    allowedEnvironments: ["test", "development"],
    listingLimitations: ["SAMPLE fictional data for testing only. Not a real property."],
    notes: "Fictional records used for tests and local development.",
  },
  {
    id: "sample-feed-mirror",
    name: "SAMPLE Mirror Feed (fictional fixture)",
    type: "fixture",
    status: "approved",
    accessMethod: "fixture",
    homepage: "https://example.org/",
    termsReviewedAt: null,
    robotsNotes: "Not applicable: in-repo fictional fixture, no network access.",
    rateLimitPerMinute: 0,
    storagePermissions: ["title", "developer_name", "locality", "location", "price_text", "canonical_url", "source_record_id", "address"],
    allowedEnvironments: ["test", "development"],
    listingLimitations: ["SAMPLE fictional data for testing only. Not a real property."],
    notes: "Second fictional fixture used to exercise cross-source deduplication.",
  },
  {
    id: "sample-web-research",
    name: "SAMPLE Web Research (fictional fixture)",
    type: "fixture",
    status: "approved",
    accessMethod: "fixture",
    homepage: "https://example.com/",
    termsReviewedAt: null,
    robotsNotes: "Not applicable: fake research client over fictional example.com pages, no network access.",
    rateLimitPerMinute: 0,
    storagePermissions: ["title", "developer_name", "locality", "price_text", "canonical_url", "rera_number", "address"],
    allowedEnvironments: ["test", "development"],
    listingLimitations: [RESEARCH_LIMITATION, "SAMPLE fictional data for testing only. Not a real property."],
    notes: "Stands in for anthropic-web-search in fixture mode, tests and CI (fake research client, never the network).",
  },
  {
    id: "anthropic-web-search",
    name: "Web research (Anthropic web search)",
    // Results are mostly developer pages surfaced by web search; listing portals are excluded.
    type: "developer",
    // Approved by the owner 2026-10-22 (D16).
    status: "approved",
    accessMethod: "api",
    homepage: "https://www.anthropic.com/",
    termsReviewedAt: "2026-10-22",
    robotsNotes:
      "No crawling by TrueNest. Pages are searched and read only by Anthropic's server-side web search tool through the Messages API; the worker never fetches a page itself.",
    rateLimitPerMinute: 10,
    storagePermissions: ["title", "developer_name", "locality", "price_text", "canonical_url", "rera_number", "address"],
    // Staging also runs NODE_ENV=production. Test, CI and local development use the
    // sample-web-research fixture source with the fake client instead.
    allowedEnvironments: ["production"],
    listingLimitations: [RESEARCH_LIMITATION],
    notes:
      "Approved 2026-10-22 by the owner (DECISIONS D16: web search + developer sites; K-RERA link-out only). " +
      "Stores only short factual fields that appear verbatim in a citation the API returned for a page in that response's search results, plus the cited URL (src/discovery/research/validate.ts). " +
      "Listing portals whose terms forbid reuse are blocked in the search and never stored. " +
      "A RERA number may be stored when it appears verbatim in a citation, including one pointing at a Karnataka RERA page that web search surfaced; the worker never fetches K-RERA pages itself (D16).",
  },
  {
    id: "k-rera",
    name: "Karnataka RERA portal (regulator)",
    type: "regulator",
    status: "proposed",
    accessMethod: "link_out_only",
    homepage: "https://rera.karnataka.gov.in/",
    termsReviewedAt: null,
    robotsNotes: "2026-10-22: the automated fetch of robots.txt was refused as robots-disallowed. No crawler or automated access, ever (D16).",
    rateLimitPerMinute: 0,
    storagePermissions: ["canonical_url"],
    allowedEnvironments: [],
    listingLimitations: [],
    notes:
      "Never runnable: automated access is robots-disallowed (D16). Link-out and manual staff lookups only. " +
      "A RERA number seen verbatim in an anthropic-web-search citation (including one pointing at a K-RERA page) is stored under that source, not this one. Regulatory research is owned by src/research.",
  },
  ...(
    [
      ["99acres", "99acres (listing portal)", "https://www.99acres.com/"],
      ["magicbricks", "MagicBricks (listing portal)", "https://www.magicbricks.com/"],
      ["housing-com", "Housing.com (listing portal)", "https://housing.com/"],
      ["nobroker", "NoBroker (listing portal)", "https://www.nobroker.in/"],
    ] as const
  ).map(
    ([id, name, homepage]): SourceEntry => ({
      id,
      name,
      type: "listing_portal",
      status: "proposed",
      accessMethod: "manual",
      homepage,
      termsReviewedAt: null,
      robotsNotes: "Not reviewed.",
      rateLimitPerMinute: 0,
      storagePermissions: ["canonical_url"],
      allowedEnvironments: [],
      listingLimitations: [],
      notes: `${NOT_REVIEWED} Possible routes to evaluate: partner feed, licensed data or link-out only.`,
    }),
  ),
];

/** Sources filled by on-demand research jobs (src/discovery/research), never by search-time adapters. */
export const WEB_RESEARCH_SOURCE_IDS = ["anthropic-web-search", "sample-web-research"] as const;

export function isWebResearchSource(id: string): boolean {
  return (WEB_RESEARCH_SOURCE_IDS as readonly string[]).includes(id);
}

export class SourceNotRunnableError extends Error {
  constructor(sourceId: string, reason: string) {
    super(`Source "${sourceId}" is not runnable: ${reason}`);
    this.name = "SourceNotRunnableError";
  }
}

export function getSource(id: string, registry: readonly SourceEntry[] = SOURCE_REGISTRY): SourceEntry | undefined {
  return registry.find((s) => s.id === id);
}

/** Throws unless the source is approved AND allowed in `env`. */
export function assertRunnable(source: SourceEntry, env: RuntimeEnv): void {
  if (source.status !== "approved") throw new SourceNotRunnableError(source.id, `status is "${source.status}"`);
  if (!source.allowedEnvironments.includes(env))
    throw new SourceNotRunnableError(source.id, `not allowed in "${env}"`);
  if (source.type === "fixture" && env === "production")
    throw new SourceNotRunnableError(source.id, "fixtures never run in production");
}

export function isRunnable(source: SourceEntry, env: RuntimeEnv): boolean {
  try {
    assertRunnable(source, env);
    return true;
  } catch {
    return false;
  }
}

export function currentEnv(nodeEnv: string | undefined = process.env.NODE_ENV): RuntimeEnv {
  if (nodeEnv === "production") return "production";
  if (nodeEnv === "test") return "test";
  return "development";
}
