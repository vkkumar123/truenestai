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
    id: "k-rera",
    name: "Karnataka RERA portal (regulator)",
    type: "regulator",
    status: "proposed",
    accessMethod: "link_out_only",
    homepage: "https://rera.karnataka.gov.in/",
    termsReviewedAt: null,
    robotsNotes: "Not reviewed.",
    rateLimitPerMinute: 0,
    storagePermissions: ["canonical_url"],
    allowedEnvironments: [],
    listingLimitations: [],
    notes: `${NOT_REVIEWED} Intended use: link buyers to the regulator's own record pages; regulatory research is owned by src/research.`,
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
