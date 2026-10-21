import type { Lead, LeadRequestType, LeadStatus } from "@/domain/types";

/**
 * ASSUMPTION — pending legal review (DPDP Act 2023 storage-limitation principle):
 * open leads kept 12 months from creation; closed/withdrawn kept 24 months from creation
 * (to cover dispute/audit needs). Withdrawn leads must have PII erased by the persistence
 * layer immediately (see eraseLeadPii); only the minimal audit record remains.
 */
export const RETENTION_MONTHS: Record<LeadStatus, number> = {
  new: 12,
  contacted: 12,
  qualified: 12,
  closed: 24,
  withdrawn: 24,
};

export const LEAD_STATUS_TRANSITIONS: Record<LeadStatus, readonly LeadStatus[]> = {
  new: ["contacted", "closed", "withdrawn"],
  contacted: ["qualified", "closed", "withdrawn"],
  qualified: ["contacted", "closed", "withdrawn"],
  closed: ["withdrawn"],
  withdrawn: [],
};

export function canTransition(from: LeadStatus, to: LeadStatus): boolean {
  return LEAD_STATUS_TRANSITIONS[from].includes(to);
}

function addMonthsUtc(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** Returns an ISO timestamp. Throws on an invalid createdAt. */
export function computeRetentionUntil(createdAt: string | Date, status: LeadStatus): string {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) throw new Error("Invalid createdAt");
  return addMonthsUtc(created, RETENTION_MONTHS[status]).toISOString();
}

export interface RedactedLead {
  id: string;
  status: LeadStatus;
  requestType: LeadRequestType;
}

/** The only lead shape allowed in logs. Never includes PII. */
export function redactLeadForLog(lead: Pick<Lead, "id" | "status" | "requestType">): RedactedLead {
  return { id: lead.id, status: lead.status, requestType: lead.requestType };
}

export type TransitionResult = { ok: true; lead: Lead } | { ok: false; error: string };

export function transitionLead(lead: Lead, to: LeadStatus): TransitionResult {
  if (!canTransition(lead.status, to)) {
    return { ok: false, error: `Cannot move a lead from "${lead.status}" to "${to}".` };
  }
  return {
    ok: true,
    lead: { ...lead, status: to, retentionUntil: computeRetentionUntil(lead.createdAt, to) },
  };
}

export const ERASED = "[erased]";

/** Removes personal data and consents, keeping only what a minimal audit record needs. */
export function eraseLeadPii(lead: Lead): Lead {
  return {
    ...lead,
    name: ERASED,
    email: null,
    phone: null,
    message: null,
    budgetBand: null,
    consent: { ...lead.consent, contactConsent: false, marketingConsent: false },
    attribution: {},
  };
}

/** Buyer-initiated withdrawal: status → withdrawn, contact + marketing consent revoked, PII erased. */
export function withdrawLead(lead: Lead): TransitionResult {
  if (lead.status === "withdrawn") return { ok: true, lead: eraseLeadPii(lead) };
  const t = transitionLead(lead, "withdrawn");
  if (!t.ok) return t;
  return { ok: true, lead: eraseLeadPii(t.lead) };
}
