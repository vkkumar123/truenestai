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

export const CONSTRUCTION_STATUS_LABEL: Record<ConstructionStatus, string> = {
  pre_launch: "Pre-launch",
  under_construction: "Under construction",
  ready_to_move: "Ready to move",
  completed: "Completed",
  stalled: "Stalled",
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

export function formatInr(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

export function formatRange(r: { min: number; max: number }, fmt: (n: number) => string): string {
  return r.min === r.max ? fmt(r.min) : `${fmt(r.min)} – ${fmt(r.max)}`;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

export const BUDGET_BAND_LABEL: Record<string, string> = {
  under_50l: "Under ₹50 L",
  "50l_1cr": "₹50 L – ₹1 Cr",
  "1cr_1_5cr": "₹1 Cr – ₹1.5 Cr",
  "1_5cr_2cr": "₹1.5 Cr – ₹2 Cr",
  "2cr_3cr": "₹2 Cr – ₹3 Cr",
  above_3cr: "Above ₹3 Cr",
};
