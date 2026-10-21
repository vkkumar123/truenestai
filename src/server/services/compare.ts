import "server-only";
import { z } from "zod";
import type { FactValue, Project, RegulatorySearch, SourceRef, VerificationState } from "@/domain/types";
import { getLocality } from "@/config/markets";
import { describeComplaintSearch } from "@/research/evidence";
import { getRepositories, type Repositories } from "../repositories";

export const MAX_COMPARE = 4;

export interface ComparisonCell {
  projectId: string;
  status: "known" | "unknown"; // unknown = not found yet, never a negative finding
  /** Display text when known; null when unknown. */
  value: string | null;
  verification: VerificationState | null; // null for structural fields (name, locality)
  sources: SourceRef[];
  /** Buyer-facing wording when the row needs more than `value` (e.g. "Not yet checked"). */
  note?: string;
}

export interface ComparisonRow {
  key: string;
  label: string;
  cells: ComparisonCell[]; // aligned with `projects`
}

export type ComparisonResult =
  | { ok: true; projects: Project[]; rows: ComparisonRow[]; missingIds: string[] }
  | { ok: false; error: "too_many" | "none"; message: string };

const idsSchema = z.array(z.string().trim().min(1).max(100)).max(50);

const inr = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : `₹${n.toLocaleString("en-IN")}`;

function fromFact<T>(projectId: string, f: FactValue<T>, show: (v: T) => string): ComparisonCell {
  return f.status === "known" && f.value !== null
    ? { projectId, status: "known", value: show(f.value), verification: f.verification, sources: f.sources }
    : { projectId, status: "unknown", value: null, verification: f.verification, sources: f.sources };
}

function structural(projectId: string, value: string): ComparisonCell {
  return { projectId, status: "known", value, verification: null, sources: [] };
}

/** Combines a per-unit fact into one range cell; unknown if no unit has a known value. */
function unitRange(p: Project, pick: "priceInr" | "carpetAreaSqft", fmt: (n: number) => string): ComparisonCell {
  const facts = p.units.map((u) => u[pick]).filter((f) => f.status === "known" && f.value);
  if (!facts.length) return { projectId: p.id, status: "unknown", value: null, verification: "unverified", sources: [] };
  const min = Math.min(...facts.map((f) => f.value!.min));
  const max = Math.max(...facts.map((f) => f.value!.max));
  const order: VerificationState[] = ["disputed", "requires_professional_review", "unverified", "source_confirmed", "reviewed"];
  const weakest = facts.map((f) => f.verification).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  const partial = facts.length < p.units.length ? " (some configurations unknown)" : "";
  return {
    projectId: p.id,
    status: "known",
    value: `${fmt(min)} – ${fmt(max)}${partial}`,
    verification: weakest,
    sources: facts.flatMap((f) => f.sources),
  };
}

/**
 * Complaints row from records + searches:
 *  - complaint search(es) recorded → "N found" / "None found in <source> as of <date>" (scoped caveat)
 *  - no search, but complaint records exist → "N found" (as of the records' observation date)
 *  - neither → status unknown, "Not yet checked" (never a negative finding)
 * Uses the latest search per source; the count is the larger of searched results and listed records.
 */
function complaintsCell(p: Project): ComparisonCell {
  const records = p.regulatoryRecords.filter((r) => r.kind === "complaint");
  const latestBySource = new Map<string, RegulatorySearch>();
  for (const s of p.regulatorySearches.filter((x) => x.kind === "complaint")) {
    const prev = latestBySource.get(s.sourceId);
    if (!prev || prev.searchedAt < s.searchedAt) latestBySource.set(s.sourceId, s);
  }
  const searches = [...latestBySource.values()];
  if (!searches.length && !records.length) {
    return {
      projectId: p.id,
      status: "unknown",
      value: null,
      verification: null,
      sources: [],
      note: describeComplaintSearch({ sourcesChecked: [], found: 0, checkedAt: "" }),
    };
  }
  const searchRefs: SourceRef[] = searches.map((s) => ({ sourceId: s.sourceId, url: s.url, observedAt: s.searchedAt }));
  const recordRefs = records.map((r) => r.source);
  const sourcesChecked = searches.length ? searchRefs : recordRefs;
  const checkedAt = sourcesChecked.map((s) => s.observedAt).sort().at(-1)!;
  const found = Math.max(records.length, searches.reduce((n, s) => n + s.resultsFound, 0));
  const text = describeComplaintSearch({ sourcesChecked, found, checkedAt });
  return {
    projectId: p.id,
    status: "known",
    value: text,
    verification: records.length && records.every((r) => r.verification !== "unverified") ? records[0].verification : "unverified",
    sources: [...searchRefs, ...recordRefs],
    note: text,
  };
}

const ROWS: { key: string; label: string; cell: (p: Project) => ComparisonCell }[] = [
  { key: "developer", label: "Developer", cell: (p) => structural(p.id, p.developer.name) },
  { key: "locality", label: "Locality", cell: (p) => structural(p.id, getLocality(p.localityId)?.name ?? p.localityId) },
  { key: "reraNumbers", label: "RERA registration (not title clearance)", cell: (p) => fromFact(p.id, p.reraNumbers, (v) => v.join(", ")) },
  { key: "constructionStatus", label: "Construction status", cell: (p) => fromFact(p.id, p.constructionStatus, (v) => v.replace(/_/g, " ")) },
  { key: "declaredPossession", label: "Declared possession (not a promise)", cell: (p) => fromFact(p.id, p.declaredPossession, (v) => v) },
  { key: "address", label: "Address", cell: (p) => fromFact(p.id, p.address, (v) => v) },
  {
    key: "configurations",
    label: "Configurations",
    cell: (p) => (p.units.length ? structural(p.id, p.units.map((u) => u.label).join(", ")) : { projectId: p.id, status: "unknown", value: null, verification: null, sources: [] }),
  },
  { key: "priceInr", label: "Price range (as listed)", cell: (p) => unitRange(p, "priceInr", inr) },
  { key: "carpetAreaSqft", label: "Carpet area (sq ft)", cell: (p) => unitRange(p, "carpetAreaSqft", (n) => n.toLocaleString("en-IN")) },
  { key: "complaints", label: "Complaints", cell: complaintsCell },
  { key: "reviewFlags", label: "Needs professional review", cell: (p) => structural(p.id, p.reviewFlags.length ? `${p.reviewFlags.length} item(s)` : "None recorded") },
  { key: "completeness", label: "Data completeness", cell: (p) => structural(p.id, `${Math.round(p.completeness * 100)}%`) },
  { key: "lastCheckedAt", label: "Last checked", cell: (p) => structural(p.id, p.lastCheckedAt.slice(0, 10)) },
];

/** Compares up to MAX_COMPARE published projects. Unknown/unpublished ids are reported in missingIds. */
export async function getComparison(ids: string[], deps: { repos?: Repositories } = {}): Promise<ComparisonResult> {
  const parsed = idsSchema.safeParse(ids);
  if (!parsed.success) return { ok: false, error: "too_many", message: `You can compare up to ${MAX_COMPARE} projects.` };
  const unique = [...new Set(parsed.data)];
  if (unique.length === 0) return { ok: false, error: "none", message: "Choose at least one project to compare." };
  if (unique.length > MAX_COMPARE) return { ok: false, error: "too_many", message: `You can compare up to ${MAX_COMPARE} projects.` };
  const repos = deps.repos ?? getRepositories();
  const projects = (await repos.projects.getProjectsByIds(unique)).filter((p) => p.published === true);
  const found = new Set(projects.map((p) => p.id));
  const rows = ROWS.map((r) => ({ key: r.key, label: r.label, cells: projects.map(r.cell) }));
  return { ok: true, projects, rows, missingIds: unique.filter((id) => !found.has(id)) };
}
