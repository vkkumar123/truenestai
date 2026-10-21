import type { LeadInput } from "@/domain/types";

export type LeadTier = "high" | "medium" | "low";
export interface LeadQualification {
  score: number;
  tier: LeadTier;
  reasons: string[];
}

/** Deterministic, explainable weights. Scores only prioritise human follow-up; no outbound actions. */
export const QUALIFICATION_WEIGHTS = {
  verificationRequest: 25,
  linkedProject: 25,
  linkedExternalListing: 15,
  budgetBand: 20,
  substantiveMessage: 15,
  briefMessage: 5,
  bothContactMethods: 10,
} as const;

export const TIER_THRESHOLDS = { high: 60, medium: 30 } as const;
const SUBSTANTIVE_MESSAGE_CHARS = 40;

export function qualifyLead(lead: LeadInput): LeadQualification {
  const w = QUALIFICATION_WEIGHTS;
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${reason} (+${points})`);
  };

  if (lead.requestType === "verification") add(w.verificationRequest, "Requested property verification");
  if (lead.projectId) add(w.linkedProject, "Linked to a researched project");
  else if (lead.externalListingId) add(w.linkedExternalListing, "Linked to an external listing");
  if (lead.budgetBand) add(w.budgetBand, "Budget band provided");
  const msg = lead.message?.trim() ?? "";
  if (msg.length >= SUBSTANTIVE_MESSAGE_CHARS) add(w.substantiveMessage, "Detailed message provided");
  else if (msg.length > 0) add(w.briefMessage, "Short message provided");
  if (lead.email && lead.phone) add(w.bothContactMethods, "Both email and phone provided");

  score = Math.min(100, score);
  const tier: LeadTier =
    score >= TIER_THRESHOLDS.high ? "high" : score >= TIER_THRESHOLDS.medium ? "medium" : "low";
  if (reasons.length === 0) reasons.push("No qualifying signals beyond contact details");
  return { score, tier, reasons };
}
