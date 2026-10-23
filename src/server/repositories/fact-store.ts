import "server-only";
import { z } from "zod";
import type { FactConflict, FactEstimateBasis, FactTruthStatus, FactValue, SourceRef, VerificationState } from "@/domain/types";
import { log } from "../log";

// S1a fact store (supabase/migrations/0006_fact_store.sql, D18 proposed): the attribute catalogue
// mirror, the facts_current row shape, the precedence rule (used by the fixture; SQL is
// authoritative for Supabase) and the row → domain mapping shared by both repositories.

export type FactEntityType = "project" | "locality";
export type FactValueKind = "text" | "number" | "date" | "json";

export interface FactAttribute {
  entityType: "project" | "builder" | "development" | "locality";
  attribute: string;
  valueKind: FactValueKind;
  /** PROPOSED for C7 (Fury confirms): shown only after staff review. */
  legallySignificant: boolean;
  defaultTtlHours: number;
  /** The curated facts.field this attribute merges with in facts_current. */
  legacyField: string | null;
}

const a = (
  entityType: FactAttribute["entityType"],
  attribute: string,
  valueKind: FactValueKind,
  legallySignificant: boolean,
  defaultTtlHours: number,
  legacyField: string | null = null,
): FactAttribute => ({ entityType, attribute, valueKind, legallySignificant, defaultTtlHours, legacyField });

/** KEEP IN SYNC with the fact_attributes seed in 0006_fact_store.sql (a unit test compares them). */
export const FACT_ATTRIBUTES: readonly FactAttribute[] = [
  a("project", "rera_status", "text", true, 168),
  a("project", "rera_registration_date", "date", true, 720),
  a("project", "rera_completion_date", "date", true, 168),
  a("project", "rera_extension_count", "number", true, 168),
  a("project", "rera_complaints_count", "number", true, 168),
  a("project", "promised_possession", "date", false, 168, "declared_possession"),
  a("project", "current_possession_claim", "date", false, 168),
  a("project", "total_units", "number", false, 2160),
  a("project", "towers", "number", false, 2160),
  a("project", "floors", "number", false, 2160),
  a("project", "land_area_acres", "number", false, 2160),
  a("project", "carpet_sba_ratio", "number", false, 2160),
  a("project", "oc_status", "text", true, 720),
  a("project", "khata_type", "text", true, 720),
  a("project", "land_title_summary", "text", true, 720),
  a("project", "bank_approvals", "json", true, 720),
  a("project", "base_psf", "number", false, 168),
  a("project", "floor_rise_psf", "number", false, 168),
  a("project", "plc_note", "text", false, 168),
  a("project", "car_park_cost", "number", false, 168),
  a("project", "clubhouse_cost", "number", false, 168),
  a("project", "maintenance_psf_month", "number", false, 720),
  a("project", "maintenance_deposit_months", "number", false, 720),
  a("project", "amenities", "json", false, 2160),
  a("project", "launch_date", "date", false, 2160),
  a("project", "water_source", "text", false, 720),
  a("project", "stp_status", "text", false, 720),
  a("project", "builder_track_record_note", "text", false, 720),
  a("development", "status", "text", false, 720),
  a("development", "expected_completion", "date", false, 720),
  a("development", "budget_cr", "number", false, 2160),
  a("development", "length_km", "number", false, 2160),
  a("development", "stations", "json", false, 2160),
  a("locality", "avg_psf", "number", false, 720),
  a("locality", "psf_trend_12m", "number", false, 720),
  a("locality", "water_supply_note", "text", false, 2160),
  a("locality", "flooding_note", "text", false, 2160),
  a("locality", "major_employers", "json", false, 2160),
  a("locality", "school_hospital_note", "text", false, 2160),
];

export function getFactAttribute(entityType: string, attribute: string): FactAttribute | undefined {
  return FACT_ATTRIBUTES.find((x) => x.entityType === entityType && x.attribute === attribute);
}

// ---- boundary validation ----

export const factEntityTypeSchema = z.enum(["project", "locality"]);
export const factEntityIdSchema = z.string().min(1).max(200);
export const factAttributeSchema = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);

const truthSchema = z.enum(["official", "estimated", "unknown"]);
const verificationSchema = z.enum(["unverified", "source_confirmed", "reviewed", "disputed", "requires_professional_review"]);
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const ts = z.string().min(1);

/** One candidate value, as listed in facts_current.conflicts (snake_case, as stored). */
export const factCandidateSchema = z.object({
  origin: z.enum(["observation", "curated"]),
  fact_id: z.string(),
  value_text: z.string().nullable(),
  value_num: num.nullable(),
  value_date: z.string().nullable(),
  value_json: z.unknown().nullable(),
  unit: z.string().nullable(),
  truth_status: truthSchema,
  verification: verificationSchema,
  confidence: num.nullable(),
  source_id: z.string().nullable(),
  source_url: z.string().nullable(),
  source_type: z.string().nullable(),
  observed_at: ts,
  last_verified_at: ts,
  added_by: z.string(),
});
export type FactCandidateRow = z.input<typeof factCandidateSchema>;

/** A facts_current row (snake_case, as the view returns it). */
export const factsCurrentRowSchema = factCandidateSchema.extend({
  entity_type: factEntityTypeSchema,
  entity_id: z.string(),
  attribute: z.string(),
  estimate_basis: z.unknown().nullable(),
  ttl_hours: num,
  excerpt: z.string().nullable(),
  is_sample: z.boolean(),
  legally_significant: z.boolean(),
  requires_review: z.boolean(),
  is_stale: z.boolean(),
  conflicts: z.array(factCandidateSchema),
  conflict_count: num,
  has_disagreement: z.boolean(),
});
export type FactsCurrentRow = z.input<typeof factsCurrentRowSchema>;

export const FACTS_CURRENT_COLUMNS =
  "entity_type, entity_id, attribute, origin, fact_id, value_text, value_num, value_date, value_json, unit, truth_status, " +
  "verification, confidence, estimate_basis, source_id, source_url, source_type, observed_at, last_verified_at, ttl_hours, " +
  "excerpt, added_by, is_sample, legally_significant, requires_review, is_stale, conflicts, conflict_count, has_disagreement";

// ---- domain read model ----

/** The current value of one attribute of one entity, with every other live value in fact.conflicts. */
export interface CurrentFact {
  entityType: FactEntityType;
  entityId: string;
  attribute: string;
  origin: "observation" | "curated";
  factId: string;
  /** truth, lastVerifiedAt, ttlHours and conflicts are always set here. */
  fact: FactValue<unknown>;
  unit: string | null;
  /** spec 02 source_type ('rera', 'builder', 'news', 'search', …) of the winning value. */
  sourceType: string | null;
  addedBy: string;
  confidence: number | null;
  excerpt: string | null;
  isSample: boolean;
  legallySignificant: boolean;
  /** Legally significant and not yet source_confirmed/reviewed: render "Not yet verified" + source link only. */
  requiresReview: boolean;
  /** lastVerifiedAt + ttlHours is in the past. An unknown that is not stale suppresses re-research. */
  isStale: boolean;
  /** Another live value differs from the winner (a contradiction to show). */
  hasDisagreement: boolean;
}

type ParsedCandidate = z.output<typeof factCandidateSchema>;

/** Postgres / PostgREST timestamps ("2026-10-01 00:00:00+00", "…T…+00:00", "…Z") → ISO 8601 UTC. */
const iso = (t: string) => {
  const d = new Date(t.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(d.getTime()) ? t : d.toISOString();
};

function candidateValue(c: ParsedCandidate): unknown {
  if (c.truth_status === "unknown") return null;
  return c.value_date ?? c.value_num ?? c.value_text ?? c.value_json ?? null;
}

function candidateSource(c: ParsedCandidate): SourceRef | null {
  return c.source_id ? { sourceId: c.source_id, url: c.source_url, observedAt: iso(c.observed_at) } : null;
}

const sourceRefSchema = z.object({
  sourceId: z.string().min(1),
  url: z.string().nullable(),
  observedAt: z.string().min(1),
  documentDate: z.string().nullable().optional(),
  note: z.string().optional(),
});
const estimateBasisSchema = z.object({
  sources: z.array(sourceRefSchema),
  assumptionsVersion: z.string().optional(),
  signalCount: z.number().int().nonnegative().optional(),
});

/** Validates a facts_current row and maps it to the domain read model. Throws on a malformed row. */
export function mapFactsCurrentRow(input: unknown): CurrentFact {
  const r = factsCurrentRowSchema.parse(input);
  const source = candidateSource(r);
  const conflicts: FactConflict<unknown>[] = r.conflicts.map((c) => ({
    value: candidateValue(c),
    truth: c.truth_status as FactTruthStatus,
    verification: c.verification as VerificationState,
    source: candidateSource(c),
  }));
  // constitution §2: an estimate is never served without its basis (M2) — a malformed one is an error
  const basis = r.truth_status === "estimated" ? estimateBasisSchema.parse(r.estimate_basis) : null;
  const fact: FactValue<unknown> = {
    status: r.truth_status === "unknown" ? "unknown" : "known",
    value: candidateValue(r),
    verification: r.verification,
    sources: source ? [source] : [],
    truth: r.truth_status,
    lastVerifiedAt: iso(r.last_verified_at),
    ttlHours: r.ttl_hours,
    conflicts,
    ...(basis
      ? { estimateBasis: { ...basis, sources: basis.sources.map((s) => ({ ...s, observedAt: iso(s.observedAt) })) } as FactEstimateBasis }
      : {}),
  };
  return {
    entityType: r.entity_type,
    entityId: r.entity_id,
    attribute: r.attribute,
    origin: r.origin,
    factId: r.fact_id,
    fact,
    unit: r.unit,
    sourceType: r.source_type,
    addedBy: r.added_by,
    confidence: r.confidence,
    excerpt: r.excerpt,
    isSample: r.is_sample,
    legallySignificant: r.legally_significant,
    requiresReview: r.requires_review,
    isStale: r.is_stale,
    hasDisagreement: r.has_disagreement,
  };
}

/**
 * Maps many rows, skipping (and logging) any row that fails validation, so one malformed row never
 * hides an entity's other facts. The log carries only the row's id: no values, sources or PII.
 */
export function mapFactsCurrentRows(rows: readonly unknown[]): CurrentFact[] {
  const out: CurrentFact[] = [];
  for (const row of rows) {
    try {
      out.push(mapFactsCurrentRow(row));
    } catch {
      const id = (row as { fact_id?: unknown } | null)?.fact_id;
      log.warn("fact_store_row_skipped", { factId: typeof id === "string" ? id.slice(0, 64) : null });
    }
  }
  return out;
}

// ---- precedence (TS mirror of the facts_current view; the fixture uses it) ----

/** A live candidate value with the extra columns the view carries for the winner. */
export interface FactCandidateInput extends FactCandidateRow {
  entity_type: FactEntityType;
  entity_id: string;
  attribute: string;
  estimate_basis: unknown;
  ttl_hours: number;
  excerpt: string | null;
  is_sample: boolean;
}

const TRUTH_RANK: Record<string, number> = { official: 0, estimated: 1, unknown: 2 };
const CURATED_WINS: readonly string[] = ["source_confirmed", "reviewed"];

/** facts_current ordering: verified curated first, then official > estimated > unknown, newest, id. */
export function compareCandidates(x: FactCandidateRow, y: FactCandidateRow): number {
  // M5: only a verified KNOWN curated value overrides the observations
  const cv = (c: FactCandidateRow) =>
    c.origin === "curated" && c.truth_status !== "unknown" && CURATED_WINS.includes(c.verification) ? 0 : 1;
  return (
    cv(x) - cv(y) ||
    TRUTH_RANK[x.truth_status] - TRUTH_RANK[y.truth_status] ||
    Date.parse(iso(y.observed_at)) - Date.parse(iso(x.observed_at)) ||
    (x.fact_id < y.fact_id ? -1 : x.fact_id > y.fact_id ? 1 : 0)
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' that is a real calendar date, else null (mirrors tn_try_date). */
export function tryIsoDate(t: string | null | undefined): string | null {
  if (!t || !ISO_DATE.test(t)) return null;
  const d = new Date(`${t}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : null;
}

/** L2: for a date attribute, an ISO date held as text compares equal to the same date. */
function valueTuple(c: FactCandidateRow, kind: FactValueKind | undefined): string {
  if (kind === "date") {
    const d = c.value_date ?? tryIsoDate(c.value_text);
    return JSON.stringify([d ? null : c.value_text, c.value_num, d, c.value_json]);
  }
  return JSON.stringify([c.value_text, c.value_num, c.value_date, c.value_json]);
}

/** Resolves candidates into facts_current rows (same rules as the SQL view). Sorted by attribute. */
export function resolveFactsCurrent(candidates: readonly FactCandidateInput[], now: Date): FactsCurrentRow[] {
  const groups = new Map<string, FactCandidateInput[]>();
  for (const c of candidates) {
    const k = `${c.entity_type}\u0000${c.entity_id}\u0000${c.attribute}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const out: FactsCurrentRow[] = [];
  for (const group of groups.values()) {
    const [w, ...rest] = [...group].sort(compareCandidates);
    const attr = getFactAttribute(w.entity_type, w.attribute);
    const legallySignificant = attr?.legallySignificant ?? false;
    const conflicts = rest.map((o) => ({
      origin: o.origin, fact_id: o.fact_id, value_text: o.value_text, value_num: o.value_num, value_date: o.value_date,
      value_json: o.value_json, unit: o.unit, truth_status: o.truth_status, verification: o.verification,
      confidence: o.confidence, source_id: o.source_id, source_url: o.source_url, source_type: o.source_type,
      observed_at: o.observed_at, last_verified_at: o.last_verified_at, added_by: o.added_by,
    }));
    out.push({
      ...w,
      legally_significant: legallySignificant,
      requires_review: legallySignificant && !CURATED_WINS.includes(w.verification),
      is_stale: Date.parse(iso(w.last_verified_at)) + w.ttl_hours * 3_600_000 < now.getTime(),
      conflicts,
      conflict_count: rest.length,
      has_disagreement: rest.some((o) => valueTuple(o, attr?.valueKind) !== valueTuple(w, attr?.valueKind)),
    });
  }
  return out.sort((x, y) => (x.attribute < y.attribute ? -1 : x.attribute > y.attribute ? 1 : 0));
}
