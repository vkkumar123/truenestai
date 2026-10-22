"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import type { LeadStatus } from "@/domain/types";
import { isStaffAuthError } from "../auth";
// Never trusts client-supplied (left-most) X-Forwarded-For entries; see client-ip.ts.
import { requestClientKey } from "../client-ip";
import { log } from "../log";
import { assignLead, submitLead, updateLeadStatus } from "../services/leads";
import type { AssignLeadState, SubmitLeadState, UpdateLeadStatusState } from "./types";
import { ensureRenderPhaseAfterAction } from "./mpa";

/** String fields only; files and repeated keys are ignored (first value wins). */
function formToObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && !(k in out) && !k.startsWith("$ACTION")) out[k] = v;
  }
  return out;
}

/**
 * Lead form action. Use with `useActionState(submitLeadAction, { status: "idle" })`.
 * Form fields: requestType, name, email, phone, preferredChannel, message, projectId,
 * externalListingId, budgetBand, contactConsent, marketingConsent, consentTextVersion,
 * utmSource, utmMedium, utmCampaign, landingPath, website (honeypot, leave empty).
 */
export async function submitLeadAction(_prev: SubmitLeadState, formData: FormData): Promise<SubmitLeadState> {
  const result = await submitLead(formToObject(formData), { ipKey: await requestClientKey() });
  if (result.ok) {
    return { status: "success", leadId: result.leadId, message: "Thank you. Your request has been received." };
  }
  return { status: "error", reason: result.reason, errors: result.errors };
}

/**
 * Staff action. Use with `useActionState(updateLeadStatusAction, { status: "idle" })`.
 * Form fields: leadId, status.
 */
export async function updateLeadStatusAction(_prev: UpdateLeadStatusState, formData: FormData): Promise<UpdateLeadStatusState> {
  const leadId = String(formData.get("leadId") ?? "");
  const status = String(formData.get("status") ?? "") as LeadStatus;
  try {
    const result = await updateLeadStatus(leadId, status);
    ensureRenderPhaseAfterAction("/admin", "layout"); // after the auth check; see mpa.ts
    if (!result.ok) return { status: "error", message: result.message };
    revalidatePath("/admin", "layout");
    return { status: "success", leadId: result.lead.id, leadStatus: result.lead.status, message: "Status updated." };
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", message: e.message, unauthenticated: true };
    log.error("lead.status_action_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", message: "Could not update the lead. Please try again." };
  }
}

/**
 * Admin action. Use with `useActionState(assignLeadAction, { status: "idle" })`.
 * Form fields: leadId, assigneeId (staff user id from listAssignableStaff; empty = unassign).
 */
export async function assignLeadAction(_prev: AssignLeadState, formData: FormData): Promise<AssignLeadState> {
  const leadId = String(formData.get("leadId") ?? "");
  const raw = String(formData.get("assigneeId") ?? "").trim();
  try {
    const result = await assignLead(leadId, raw === "" ? null : raw);
    ensureRenderPhaseAfterAction("/admin", "layout"); // after the auth check; see mpa.ts
    if (!result.ok) return { status: "error", message: result.message };
    if (result.changed) revalidatePath("/admin", "layout");
    const assignedTo = result.lead.assignedTo ?? null;
    return { status: "success", leadId: result.lead.id, assignedTo, message: assignedTo ? "Lead assigned." : "Lead unassigned." };
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", message: e.message, unauthenticated: true };
    log.error("lead.assign_action_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", message: "Could not assign the lead. Please try again." };
  }
}
