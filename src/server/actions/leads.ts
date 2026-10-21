"use server";
import "server-only";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { LeadStatus } from "@/domain/types";
import { isStaffAuthError } from "../auth";
import { log } from "../log";
import { submitLead, updateLeadStatus } from "../services/leads";
import type { SubmitLeadState, UpdateLeadStatusState } from "./types";

/** String fields only; files and repeated keys are ignored (first value wins). */
function formToObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === "string" && !(k in out) && !k.startsWith("$ACTION")) out[k] = v;
  }
  return out;
}

async function clientIpKey(): Promise<string | null> {
  const h = await headers();
  // First hop as set by the hosting proxy. Spoofable without a trusted proxy (dev-grade only).
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || h.get("x-real-ip")?.trim() || null;
}

/**
 * Lead form action. Use with `useActionState(submitLeadAction, { status: "idle" })`.
 * Form fields: requestType, name, email, phone, preferredChannel, message, projectId,
 * externalListingId, budgetBand, contactConsent, marketingConsent, consentTextVersion,
 * utmSource, utmMedium, utmCampaign, landingPath, website (honeypot, leave empty).
 */
export async function submitLeadAction(_prev: SubmitLeadState, formData: FormData): Promise<SubmitLeadState> {
  const result = await submitLead(formToObject(formData), { ipKey: await clientIpKey() });
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
    if (!result.ok) return { status: "error", message: result.message };
    revalidatePath("/admin", "layout");
    return { status: "success", leadId: result.lead.id, leadStatus: result.lead.status, message: "Status updated." };
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", message: e.message, unauthenticated: true };
    log.error("lead.status_action_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", message: "Could not update the lead. Please try again." };
  }
}
