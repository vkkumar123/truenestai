// Adapter contract and normalisation for Lane B (external, unverified) records.
import type { ExternalListing, GeoPoint } from "@/domain/types";
import type { SourceEntry, StorableField } from "./registry";

export interface DiscoveryQuery {
  localityId?: string;
  text?: string;
  limit?: number;
}

/** Record as returned by an adapter, before normalisation. Only short factual fields. */
export interface RawExternalRecord {
  sourceId: string;
  sourceRecordId: string | null;
  canonicalUrl: string;
  title: string;
  developerName?: string | null;
  localityId?: string | null;
  address?: string | null;
  location?: GeoPoint | null;
  reraNumber?: string | null;
  priceText?: string | null;
  lastSeenAt?: string | null;
}

export interface DiscoveryAdapter {
  sourceId: string;
  search(query: DiscoveryQuery): Promise<RawExternalRecord[]>;
}

/** Normalised listing plus match-only fields that ExternalListing does not carry. */
export interface NormalizedRecord {
  listing: ExternalListing;
  reraNumber: string | null;
  address: string | null;
}

export const NOT_VERIFIED = "Not verified by TrueNest";
export const MAX_TITLE = 100;
export const MAX_PRICE_TEXT = 40;
export const MAX_SHORT = 120;

/** Strip tags/control chars, collapse whitespace, and cut to `max` characters. */
export function cleanText(input: string | null | undefined, max: number): string | null {
  if (input == null) return null;
  const s = String(input)
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export class InvalidRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecordError";
  }
}

/** Returns the trimmed URL if it parses and uses https; otherwise null. Never rewritten by the text cleaner. */
export function safeHttpsUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (s.length > 2048 || /\s/.test(s)) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Throws InvalidRecordError when the canonical URL is not a valid https URL. */
export function normalizeRecord(raw: RawExternalRecord, source: SourceEntry, now: Date): NormalizedRecord {
  const may = (f: StorableField) => source.storagePermissions.includes(f);
  const iso = now.toISOString();
  const recordId = may("source_record_id") ? cleanText(raw.sourceRecordId, MAX_SHORT) : null;
  const url = safeHttpsUrl(raw.canonicalUrl);
  if (!url) throw new InvalidRecordError(`record ${raw.sourceRecordId ?? "(no id)"} from ${source.id}: canonical URL must be a valid https URL`);
  const isSample = source.type === "fixture";

  const listing: ExternalListing = {
    id: `${source.id}:${recordId ?? hash(url)}`,
    lane: "external",
    sourceId: source.id,
    sourceRecordId: recordId,
    canonicalUrl: url,
    title: (may("title") ? cleanText(raw.title, MAX_TITLE) : null) ?? `Listing on ${source.name}`,
    developerName: may("developer_name") ? cleanText(raw.developerName, MAX_SHORT) : null,
    localityId: may("locality") ? cleanText(raw.localityId, 60) : null,
    location: may("location") && raw.location ? { ...raw.location } : null,
    priceText: may("price_text") ? cleanText(raw.priceText, MAX_PRICE_TEXT) : null,
    discoveredAt: iso,
    lastSeenAt: raw.lastSeenAt ?? iso,
    limitations: [
      NOT_VERIFIED,
      `Details as shown by ${source.name}; may be incomplete or out of date.`,
      "Price as listed by the source, not confirmed.",
      ...source.listingLimitations,
    ],
    matchedProjectId: null,
    isSample,
  };
  return {
    listing,
    reraNumber: may("rera_number") ? cleanText(raw.reraNumber, 60) : null,
    address: may("address") ? cleanText(raw.address, 200) : null,
  };
}

export function normalize(raw: RawExternalRecord, source: SourceEntry, now: Date): ExternalListing {
  return normalizeRecord(raw, source, now).listing;
}
