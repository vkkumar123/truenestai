// Deduplication for Lane B. Strong identifiers first, then developer + address/coordinates.
// Similar names alone NEVER merge; they only raise a `possible_duplicate` flag for human review.
import type { ExternalListing, Project } from "@/domain/types";
import type { NormalizedRecord } from "./adapter";

export type MergeReason = "rera_number" | "source_record_id" | "canonical_url" | "developer_address" | "developer_coordinates";
export type FlagReason = "similar_name_only" | "conflicting_rera" | "project_secondary_match";

export interface DedupeCluster {
  listing: ExternalListing; // representative (first member), with matchedProjectId set if any
  memberIds: string[];
  reasons: MergeReason[];
}

export interface ReviewFlag {
  kind: "possible_duplicate";
  reason: FlagReason;
  ids: [string, string]; // listing ids, or listing id + project id
}

export interface DedupeResult {
  clusters: DedupeCluster[];
  reviewFlags: ReviewFlag[];
}

export const COORDINATE_MATCH_METERS = 150;
export const NAME_SIMILARITY_FLAG = 0.8;

const TRACKING = /^(utm_|fbclid$|gclid$|ref$|source$)/i;

export function normaliseUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}${query}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function normaliseDeveloper(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = words(name)
    .split(" ")
    .filter((w) => !["pvt", "private", "ltd", "limited", "llp", "inc", "the"].includes(w))
    .join(" ");
  return s || null;
}

export function normaliseAddress(a: string | null | undefined): string | null {
  return a ? words(a) || null : null;
}

export function normaliseRera(r: string | null | undefined): string | null {
  return r ? r.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null;
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Dice coefficient on character bigrams of normalised names (0..1). */
export function nameSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = words(s).replace(/\b(sample|fictional)\b/g, "").replace(/\s+/g, "");
    const out: string[] = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.length || !gb.length) return 0;
  const pool = [...gb];
  let hits = 0;
  for (const g of ga) {
    const i = pool.indexOf(g);
    if (i >= 0) {
      hits++;
      pool.splice(i, 1);
    }
  }
  return (2 * hits) / (ga.length + gb.length);
}

interface Comparable {
  id: string;
  name: string;
  sourceKey: string | null;
  url: string | null;
  rera: string[];
  developer: string | null;
  address: string | null;
  location: { lat: number; lng: number } | null;
}

function fromRecord(r: NormalizedRecord): Comparable {
  const l = r.listing;
  const rera = normaliseRera(r.reraNumber);
  return {
    id: l.id,
    name: l.title,
    sourceKey: l.sourceRecordId ? `${l.sourceId}\u0000${l.sourceRecordId}` : null,
    url: l.canonicalUrl ? normaliseUrl(l.canonicalUrl) : null,
    rera: rera ? [rera] : [],
    developer: normaliseDeveloper(l.developerName),
    address: normaliseAddress(r.address),
    location: l.location,
  };
}

function fromProject(p: Project): Comparable {
  return {
    id: p.id,
    name: p.name,
    sourceKey: null,
    url: null,
    rera: (p.reraNumbers.value ?? []).map(normaliseRera).filter((x): x is string => !!x),
    developer: normaliseDeveloper(p.developer.name),
    address: p.address.status === "known" ? normaliseAddress(p.address.value) : null,
    location: p.location,
  };
}

export type PairResult = { merge: MergeReason } | { flag: FlagReason } | null;

export function comparePair(a: Comparable, b: Comparable): PairResult {
  const reraConflict = a.rera.length > 0 && b.rera.length > 0 && !a.rera.some((r) => b.rera.includes(r));
  if (a.rera.some((r) => b.rera.includes(r))) return { merge: "rera_number" };
  const strong: MergeReason | null =
    a.sourceKey && a.sourceKey === b.sourceKey ? "source_record_id" : a.url && a.url === b.url ? "canonical_url" : null;
  if (strong) return reraConflict ? { flag: "conflicting_rera" } : { merge: strong };
  if (!reraConflict && a.developer && a.developer === b.developer) {
    if (a.address && a.address === b.address) return { merge: "developer_address" };
    if (a.location && b.location && distanceMeters(a.location, b.location) <= COORDINATE_MATCH_METERS)
      return { merge: "developer_coordinates" };
  }
  if (nameSimilarity(a.name, b.name) >= NAME_SIMILARITY_FLAG) return { flag: "similar_name_only" };
  return null;
}

/**
 * Cluster normalised records. Researched projects are matched by RERA number only
 * (contract: matchedProjectId is set only via strong identifiers); weaker project matches are flagged.
 */
export function dedupe(records: readonly NormalizedRecord[], projects: readonly Project[] = []): DedupeResult {
  const items = records.map(fromRecord);
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const reasonsByRoot = new Map<number, Set<MergeReason>>();
  const pendingFlags: { i: number; j: number; reason: FlagReason }[] = [];
  const edgeReasons: { i: number; j: number; reason: MergeReason }[] = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const r = comparePair(items[i], items[j]);
      if (!r) continue;
      if ("merge" in r) {
        parent[find(j)] = find(i);
        edgeReasons.push({ i, j, reason: r.merge });
      } else pendingFlags.push({ i, j, reason: r.flag });
    }
  }
  for (const e of edgeReasons) {
    const root = find(e.i);
    if (!reasonsByRoot.has(root)) reasonsByRoot.set(root, new Set());
    reasonsByRoot.get(root)!.add(e.reason);
  }

  const reviewFlags: ReviewFlag[] = pendingFlags
    .filter((f) => find(f.i) !== find(f.j))
    .map((f) => ({ kind: "possible_duplicate", reason: f.reason, ids: [items[f.i].id, items[f.j].id] }));

  const projectItems = projects.map((p) => ({ p, c: fromProject(p) }));
  const clusters: DedupeCluster[] = [];
  const seen = new Map<number, DedupeCluster>();
  items.forEach((item, i) => {
    const root = find(i);
    let cluster = seen.get(root);
    if (!cluster) {
      cluster = { listing: { ...records[i].listing }, memberIds: [], reasons: [...(reasonsByRoot.get(root) ?? [])] };
      seen.set(root, cluster);
      clusters.push(cluster);
    }
    cluster.memberIds.push(item.id);
    for (const { p, c } of projectItems) {
      const r = comparePair(item, c);
      if (r && "merge" in r && r.merge === "rera_number") {
        if (!cluster.listing.matchedProjectId) cluster.listing.matchedProjectId = p.id;
      } else if (r) {
        const already = reviewFlags.some((f) => f.ids[0] === item.id && f.ids[1] === p.id);
        if (!already) reviewFlags.push({ kind: "possible_duplicate", reason: "merge" in r ? "project_secondary_match" : r.flag, ids: [item.id, p.id] });
      }
    }
  });
  return { clusters, reviewFlags };
}
