// Evidence wording and deterministic checks for public-record research.
// Pure functions only. See docs/research/REGULATORY_SOURCES.md for the rules.
import type { SourceRef } from "@/domain/types";

export interface ComplaintSearchResult {
  sourcesChecked: SourceRef[];
  found: number;
  checkedAt: string; // ISO timestamp
}

export const COMPLAINT_SCOPE_CAVEAT =
  "This reflects only the sources listed, on that date, and does not confirm the absence of complaints or disputes.";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "an unrecorded date";
  return d.toISOString().slice(0, 10);
}

function describeSources(sources: SourceRef[]): string {
  const ids = [...new Set(sources.map((s) => s.sourceId.trim()).filter(Boolean))];
  return ids.join(", ");
}

/**
 * Buyer-safe wording for a complaint search. Never states "no complaints"
 * unconditionally: an empty result is always scoped to date + sources checked.
 */
export function describeComplaintSearch(result: ComplaintSearchResult): string {
  const sources = describeSources(result.sourcesChecked);
  if (!sources) return "Complaint records not yet checked.";
  const date = formatDate(result.checkedAt);
  if (!Number.isInteger(result.found) || result.found < 0) {
    return `Complaint search result unclear as of ${date} in ${sources}; requires reviewer check.`;
  }
  if (result.found === 0) {
    return `No complaint found as of ${date} in ${sources}. ${COMPLAINT_SCOPE_CAVEAT}`;
  }
  const noun = result.found === 1 ? "complaint record" : "complaint records";
  return `${result.found} ${noun} found as of ${date} in ${sources}. Listed records are as published by the source and may not reflect their current status or outcome.`;
}

export type ReferenceCheck =
  | { ok: true; normalized: string; formatConfirmed: false }
  | { ok: false; reason: "empty" | "too_short" | "too_long" | "invalid_characters" };

const REF_MIN = 4;
const REF_MAX = 120;
// Letters, digits, and separators commonly printed in reference numbers.
const REF_ALLOWED = /^[A-Za-z0-9/\-_.() ]+$/;

/**
 * Shape-only check of a registration/complaint reference as printed.
 * Deliberately does NOT assert a K-RERA format: the format was not confirmed
 * from an official page (fetch of rera.karnataka.gov.in pages was restricted,
 * 2026-10-21). Encode a format only after confirming it and citing the URL.
 */
export function validateRegistrationReference(ref: string): ReferenceCheck {
  const normalized = (ref ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return { ok: false, reason: "empty" };
  if (normalized.length < REF_MIN) return { ok: false, reason: "too_short" };
  if (normalized.length > REF_MAX) return { ok: false, reason: "too_long" };
  if (!REF_ALLOWED.test(normalized)) return { ok: false, reason: "invalid_characters" };
  return { ok: true, normalized, formatConfirmed: false };
}

export type ReviewFlagCode =
  | "title_verification"
  | "encumbrance_check"
  | "approvals_validity"
  | "land_conversion";

export const REVIEW_FLAG_TEXT: Record<ReviewFlagCode, string> = {
  title_verification:
    "Title verification by a qualified lawyer required. RERA registration is not title clearance.",
  encumbrance_check:
    "Encumbrance check (EC from the sub-registrar/Kaveri) required, reviewed by a qualified professional.",
  approvals_validity:
    "Validity of plan sanction and commencement/occupancy certificates must be confirmed with the competent authority.",
  land_conversion:
    "Land conversion status (e.g. agricultural to residential) must be verified by a qualified professional.",
};

export interface ProjectReviewFacts {
  /** Flags a named human professional has recorded a review for. */
  professionallyReviewed?: Partial<Record<ReviewFlagCode, { reviewerId: string; reviewedAt: string }>>;
  /** true = land known not to need conversion; false/undefined = needs or unknown. */
  landConversionNotApplicable?: boolean;
}

/**
 * Standard professional-review flags. Title, encumbrance and approvals flags are
 * always present until a human review is recorded; land conversion is present
 * unless known not applicable or reviewed.
 */
export function reviewFlagsFor(facts: ProjectReviewFacts = {}): ReviewFlagCode[] {
  const reviewed = facts.professionallyReviewed ?? {};
  const isReviewed = (c: ReviewFlagCode) => {
    const r = reviewed[c];
    return !!r && r.reviewerId.trim() !== "" && !isAutomatedActor(r.reviewerId);
  };
  const flags: ReviewFlagCode[] = ["title_verification", "encumbrance_check", "approvals_validity"];
  if (facts.landConversionNotApplicable !== true) flags.push("land_conversion");
  return flags.filter((f) => !isReviewed(f));
}

const AUTOMATED_ACTORS = new Set(["ai", "system", "bot", "automation"]);

export function isAutomatedActor(id: string): boolean {
  return AUTOMATED_ACTORS.has(id.trim().toLowerCase());
}
