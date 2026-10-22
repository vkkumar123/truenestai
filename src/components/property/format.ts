import { CONSTRUCTION_STATUS_LABELS } from "@/domain/search-options";
import type { ConstructionStatus, RegulatoryRecord, VerificationState } from "@/domain/types";

/** Shown wherever a fact has not been found. Never "None" or "No". */
export const NOT_YET_FOUND = "Not yet found";

export const VERIFICATION_LABEL: Record<VerificationState, string> = {
  unverified: "Unverified",
  source_confirmed: "Source confirmed",
  reviewed: "Reviewed",
  disputed: "Disputed",
  requires_professional_review: "Requires professional review",
};

export const VERIFICATION_HELP: Record<VerificationState, string> = {
  unverified: "Collected from the listed source but not yet checked by TrueNest.",
  source_confirmed: "Matches an authoritative public source on the observed date.",
  reviewed: "Checked by a TrueNest reviewer against documents.",
  disputed: "Sources disagree. Treat with caution.",
  requires_professional_review: "Must be reviewed by a qualified professional (e.g. a lawyer).",
};

/** Includes "unknown", which is shown as "Not yet found" (never as a status). */
export const CONSTRUCTION_STATUS_LABEL: Record<ConstructionStatus, string> = {
  ...CONSTRUCTION_STATUS_LABELS,
  unknown: NOT_YET_FOUND,
};

export const RECORD_KIND_LABEL: Record<RegulatoryRecord["kind"], string> = {
  rera_registration: "RERA registration",
  complaint: "Complaints",
  order: "Orders",
  extension: "Extensions",
  other_disclosure: "Other disclosures",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Formats an ISO date/time as "21 Oct 2026" (UTC) without reading the current time. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return NOT_YET_FOUND;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}

export function formatRange(r: { min: number; max: number }, fmt: (n: number) => string): string {
  return r.min === r.max ? fmt(r.min) : `${fmt(r.min)} – ${fmt(r.max)}`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/**
 * Returns the URL only when it is a well-formed https URL, so source/listing data can never
 * produce javascript:, data: or plain-http links. Callers render plain text when this is null.
 */
export function safeHttpsHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
