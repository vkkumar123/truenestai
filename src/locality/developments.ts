// Pure helpers for planned area developments (S4a, D20): infrastructure tiers, declared
// completion dates, slip history and straight-line distance. No I/O.
//
// Rules: a declared date is the source's claim, never a TrueNest prediction; a slip is computed
// only from dated declarations that were each seen on a source; distance is straight-line
// (haversine on lat/lng; PostGIS later) and is never a travel time.
import type {
  DeclaredCompletionRevision,
  Development,
  InfrastructureCategory,
  InfrastructureStage,
} from "@/domain/types";
import { haversineMeters, type LatLng } from "./geo";

// ---------------------------------------------------------------------------
// Tiers (constitution §5)
// ---------------------------------------------------------------------------

/** Lifecycle order. `shelved` is terminal and sits outside the progression. */
export const INFRA_STAGES: readonly InfrastructureStage[] = [
  "proposed",
  "approved",
  "dpr_approved",
  "tendered",
  "under_construction",
  "operational",
  "shelved",
];

export const INFRA_STAGE_LABEL: Record<InfrastructureStage, string> = {
  proposed: "Proposed",
  approved: "Approved",
  dpr_approved: "DPR approved",
  tendered: "Tendered",
  under_construction: "Under construction",
  operational: "Operational",
  shelved: "Shelved",
};

export const INFRA_STAGE_HELP: Record<InfrastructureStage, string> = {
  proposed: "Announced or planned; not yet approved.",
  approved: "Approved or sanctioned in principle; detailed project report not yet approved.",
  dpr_approved: "Detailed project report approved.",
  tendered: "Tenders invited or awarded; construction not yet reported.",
  under_construction: "Construction reported as started.",
  operational: "Reported as open or operational.",
  shelved: "Reported as shelved, cancelled or put on hold.",
};

export const INFRA_CATEGORIES: readonly InfrastructureCategory[] = [
  "metro",
  "suburban_rail",
  "rail",
  "road",
  "flyover",
  "ring_road",
  "airport",
  "zoning",
  "water",
  "power",
  "other",
];

export const INFRA_CATEGORY_LABEL: Record<InfrastructureCategory, string> = {
  metro: "Metro",
  suburban_rail: "Suburban rail",
  rail: "Rail",
  road: "Road",
  flyover: "Flyover",
  ring_road: "Ring road",
  airport: "Airport",
  zoning: "Master plan / zoning",
  water: "Water",
  power: "Power",
  other: "Other",
};

export function isInfraStage(v: unknown): v is InfrastructureStage {
  return typeof v === "string" && (INFRA_STAGES as readonly string[]).includes(v);
}

export function isInfraCategory(v: unknown): v is InfrastructureCategory {
  return typeof v === "string" && (INFRA_CATEGORIES as readonly string[]).includes(v);
}

/** Position in the lifecycle (0 = proposed … 5 = operational); shelved = -1. */
export function stageRank(stage: InfrastructureStage): number {
  return stage === "shelved" ? -1 : INFRA_STAGES.indexOf(stage);
}

/**
 * Phrases that state a tier, most specific first. A researched stage is accepted only when one of
 * these phrases is what the cited page says (see src/discovery/research/developments.ts).
 */
const STAGE_PHRASES: readonly [RegExp, InfrastructureStage][] = [
  [/\b(shelved|scrapped|cancell?ed|dropped|put on hold|on hold|abandoned)\b/, "shelved"],
  [/\b(operational|opened|inaugurated|commissioned|open to (the )?public|in operation|services? (began|started|commenced))\b/, "operational"],
  [/\b(under construction|construction (is )?(under ?way|in progress|ongoing|has (begun|started|commenced))|work (is )?(under ?way|in progress|ongoing)|being built)\b/, "under_construction"],
  [/\b(tender(s|ed)?( (has|have) been)? (invited|floated|awarded|issued|called)|tendered|contract(s)? (has |have )?(been )?awarded|bids? (invited|opened))\b/, "tendered"],
  [/\b(dpr|detailed project report)( (has|was) been| (has|was|is))? (approved|cleared)\b/, "dpr_approved"],
  [/\b(approved|sanctioned|cleared|got (the )?(nod|approval)|green ?light(ed)?)\b/, "approved"],
  [/\b(proposed|planned|announced|on the anvil|in the pipeline|mooted|envisaged|feasibility)\b/, "proposed"],
];

/** Negation: "has not been approved", "no tender", "yet to be approved", "awaiting approval". */
const NEGATION = /\b(not|no|never|nor|yet to|awaiting|pending|without)\b|n't\b/;
/** Future or expectation: "expected to be operational", "will be opened", "likely to be tendered". */
const FUTURE = /\b(expected to|likely to|set to|due to|will|shall|would|to be|soon|upcoming|plans? to|scheduled to)\b/;

/** Negation and future markers in a stage phrase (or in the words just before it on the page). */
export function stageMarkers(text: string): { negated: boolean; future: boolean } {
  const t = text.normalize("NFKC").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");
  return { negated: NEGATION.test(t), future: FUTURE.test(t) };
}

/** True when markers make a phrase unusable as evidence of `stage`. Future intent is what "proposed" means. */
export function markersVoidStage(m: { negated: boolean; future: boolean }, stage: InfrastructureStage): boolean {
  return m.negated || (m.future && stage !== "proposed");
}

/**
 * The tier a stage phrase states, or null when it states none. A negated phrase ("has not been
 * approved", "DPR yet to be approved") states no tier, and neither does a future one ("expected
 * to be operational by 2027", "will be opened"), except "proposed", which is future intent.
 */
export function stageFromText(text: string | null | undefined): InfrastructureStage | null {
  if (!text) return null;
  const t = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return null;
  for (const [re, stage] of STAGE_PHRASES) {
    if (re.test(t)) return markersVoidStage(stageMarkers(t), stage) ? null : stage;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Declared completion dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export interface DeclaredDate {
  year: number;
  /** 1–12 when the declaration names a month (or a quarter/half: its last month); else null. */
  month: number | null;
  /** Sortable end-of-period key: year * 12 + (month ?? 12). Later key = later date. */
  key: number;
}

/**
 * Parses a declared date such as "December 2027", "Dec 2027", "2027", "Q3 2028", "H2 2029",
 * "mid-2027" or "2027-12". Returns null when no year 2000–2100 is stated. "2026-27" (a financial
 * year) resolves to the later year.
 */
export function parseDeclaredDate(text: string | null | undefined): DeclaredDate | null {
  if (!text) return null;
  const t = text.normalize("NFKC").toLowerCase();
  const mk = (year: number, month: number | null): DeclaredDate | null =>
    year >= 2000 && year <= 2100 && (month === null || (month >= 1 && month <= 12)) ? { year, month, key: year * 12 + (month ?? 12) } : null;

  let m = /\b(\d{4})-(\d{2})(?:-\d{2})?\b/.exec(t);
  if (m && Number(m[2]) <= 12) return mk(Number(m[1]), Number(m[2]));
  m = /\b(20\d{2})\s*[-–/]\s*(\d{2})\b/.exec(t);
  if (m) return mk(Number(m[1].slice(0, 2) + m[2]), null);
  m = /\bq([1-4])\s*(?:fy\s*)?(\d{4})\b/.exec(t) ?? /\b(\d{4})\s*q([1-4])\b/.exec(t);
  if (m) {
    const [q, y] = /^q/.test(m[0]) ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
    return mk(y, q * 3);
  }
  m = /\bh([12])\s*(\d{4})\b/.exec(t);
  if (m) return mk(Number(m[2]), Number(m[1]) * 6);
  m = /\b(?:mid)[\s-]*(\d{4})\b/.exec(t);
  if (m) return mk(Number(m[1]), 6);
  m = /\b(?:end of|end-|late|by end)\s*(\d{4})\b/.exec(t);
  if (m) return mk(Number(m[1]), 12);
  m = /\b([a-z]{3,9})\.?,?\s+(\d{4})\b/.exec(t);
  if (m && MONTHS[m[1]]) return mk(Number(m[2]), MONTHS[m[1]]);
  m = /\b(\d{4})\b/.exec(t);
  if (m) return mk(Number(m[1]), null);
  return null;
}

/** Research horizon in years ahead of now (owner requirement: next 5–10 years). */
export const DEVELOPMENT_HORIZON_YEARS = 10;

/**
 * True when a declared date falls in the research horizon: from last year to `horizonYears`
 * ahead of `now`. Used to keep researched rows to plans for the next 5–10 years.
 */
export function withinHorizon(text: string | null | undefined, now: Date, horizonYears = DEVELOPMENT_HORIZON_YEARS): boolean {
  const d = parseDeclaredDate(text);
  if (!d) return false;
  const y = now.getUTCFullYear();
  return d.year >= y - 1 && d.year <= y + horizonYears;
}

// ---------------------------------------------------------------------------
// Slip history
// ---------------------------------------------------------------------------

export type RevisionChange = "slipped" | "advanced" | "restated" | "unclear";

export interface SlipStep {
  from: DeclaredCompletionRevision;
  to: DeclaredCompletionRevision;
  change: RevisionChange;
  /** Months later (positive) or earlier (negative) by period end; null when unclear. */
  months: number | null;
}

export interface SlipSummary {
  /** Declarations recorded (the first one counts as the original). */
  declarations: number;
  /** Changes of the declared date after the first declaration (spec 06 revisions_count). */
  revisions: number;
  slips: number;
  advances: number;
  /** Net months later than the first declaration (null when either end is unparseable). */
  netMonths: number | null;
  steps: SlipStep[];
  first: DeclaredCompletionRevision | null;
  latest: DeclaredCompletionRevision | null;
}

/** Oldest first, by asOf; ties keep input order. */
export function sortRevisions(history: readonly DeclaredCompletionRevision[]): DeclaredCompletionRevision[] {
  return history
    .map((h, i) => ({ h, i }))
    .sort((a, b) => a.h.asOf.localeCompare(b.h.asOf) || a.i - b.i)
    .map((x) => x.h);
}

export function classifyChange(from: string, to: string): { change: RevisionChange; months: number | null } {
  const a = parseDeclaredDate(from);
  const b = parseDeclaredDate(to);
  if (!a || !b) return { change: from.trim().toLowerCase() === to.trim().toLowerCase() ? "restated" : "unclear", months: null };
  const months = b.key - a.key;
  return { change: months > 0 ? "slipped" : months < 0 ? "advanced" : "restated", months };
}

/**
 * How often the declared date moved. A revision is a declaration whose text differs from the one
 * before it; a slip is a revision to a later period. Restating the same date is not a revision.
 */
export function summarizeSlips(history: readonly DeclaredCompletionRevision[]): SlipSummary {
  const sorted = sortRevisions(history);
  const steps: SlipStep[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1];
    const to = sorted[i];
    if (from.expectedCompletion.trim().toLowerCase() === to.expectedCompletion.trim().toLowerCase()) continue;
    steps.push({ from, to, ...classifyChange(from.expectedCompletion, to.expectedCompletion) });
  }
  const first = sorted[0] ?? null;
  const latest = sorted[sorted.length - 1] ?? null;
  const a = first ? parseDeclaredDate(first.expectedCompletion) : null;
  const b = latest ? parseDeclaredDate(latest.expectedCompletion) : null;
  return {
    declarations: sorted.length,
    revisions: steps.length,
    slips: steps.filter((s) => s.change === "slipped").length,
    advances: steps.filter((s) => s.change === "advanced").length,
    netMonths: a && b ? b.key - a.key : null,
    steps,
    first,
    latest,
  };
}

/** One-line buyer-facing summary, e.g. "Declared date revised 2 times (slipped twice, 18 months later than first declared)". */
export function describeSlips(s: SlipSummary): string {
  if (s.declarations === 0) return "No declared date recorded yet.";
  if (s.revisions === 0) return s.declarations === 1 ? "No revisions recorded yet (one declaration seen)." : "Declared date unchanged across the declarations we recorded.";
  const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
  const parts: string[] = [];
  if (s.slips) parts.push(`slipped ${times(s.slips)}`);
  if (s.advances) parts.push(`brought forward ${times(s.advances)}`);
  if (s.netMonths !== null && s.netMonths > 0) parts.push(`${s.netMonths} month${s.netMonths === 1 ? "" : "s"} later than first declared`);
  const n = s.revisions === 1 ? "once" : `${s.revisions} times`;
  return `Declared date revised ${n}${parts.length ? ` (${parts.join(", ")})` : ""}.`;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** Straight-line radius for listing developments around a project (spec 06 uses 10 km for transit/jobs). */
export const DEVELOPMENT_DISPLAY_RADIUS_METERS = 10_000;
/** Research scope around each configured locality (owner requirement 2026-10-24). */
export const DEVELOPMENT_RESEARCH_RADIUS_KM = 5;

/** "2.3 km straight-line" (1 decimal, spec 08) or "450 m straight-line" below 1 km. */
export function formatStraightLine(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "Distance not available";
  // From 950 m, metres would round to "1000 m", so switch to km ("1.0 km").
  if (meters < 950) return `${Math.max(10, Math.round(meters / 10) * 10)} m straight-line`;
  return `${(Math.round(meters / 100) / 10).toFixed(1)} km straight-line`;
}

export interface NearbyDevelopment<T extends Pick<Development, "location" | "localityIds" | "name"> = Development> {
  development: T;
  /** Straight-line metres from the centre; null when the development is not yet mapped. */
  distanceMeters: number | null;
}

/**
 * Developments around `center`: every mapped one within `radiusMeters` (nearest first), then
 * unmapped ones listed for `localityId` (by name). Mapped ones further away are left out.
 */
export function developmentsNear<T extends Pick<Development, "location" | "localityIds" | "name">>(
  items: readonly T[],
  center: LatLng,
  localityId: string | null,
  radiusMeters = DEVELOPMENT_DISPLAY_RADIUS_METERS,
): NearbyDevelopment<T>[] {
  const mapped: NearbyDevelopment<T>[] = [];
  const unmapped: NearbyDevelopment<T>[] = [];
  for (const d of items) {
    if (d.location) {
      const m = haversineMeters(center, d.location);
      if (m <= radiusMeters) mapped.push({ development: d, distanceMeters: m });
    } else if (localityId && d.localityIds.includes(localityId)) {
      unmapped.push({ development: d, distanceMeters: null });
    }
  }
  mapped.sort((a, b) => a.distanceMeters! - b.distanceMeters! || a.development.name.localeCompare(b.development.name));
  unmapped.sort((a, b) => a.development.name.localeCompare(b.development.name));
  return [...mapped, ...unmapped];
}

// ---------------------------------------------------------------------------
// Buyer-facing wording (no predictions)
// ---------------------------------------------------------------------------

export const PLANNED_HEADING = "Planned around here (next 5–10 years)";
export const PLANNED_DISCLAIMER = "Plans can change, be delayed or be cancelled. Not a prediction of property prices or returns.";

/** "Expected (declared) December 2027" — always attributed to the declaring source. */
export function expectedLabel(expectedCompletion: string | null): string {
  return expectedCompletion ? `Expected (declared) ${expectedCompletion}` : "Expected date: not yet declared by a source we found";
}

/** Words that would make a stored name read as a promise of gains; such names are never stored. */
const PROMOTIONAL = /\b(apprecia\w*|returns?|roi|invest\w*|price|prices|profit\w*|guarantee\w*|boom\w*|doubl\w*|hike|value)\b/i;
export function isPromotionalText(text: string): boolean {
  return PROMOTIONAL.test(text);
}
