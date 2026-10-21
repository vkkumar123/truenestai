// Verification-state permissions for staff (M3, D12). Pure.
import type { StaffRole, VerificationState } from "@/domain/types";
import { isAutomatedActor } from "./evidence";

export type VerificationCheck = { ok: true } | { ok: false; reason: string };

export interface VerificationActor {
  id: string;
  role: StaffRole;
}

/** Any fact edit resets verification to this state. */
export const VERIFICATION_AFTER_EDIT: VerificationState = "unverified";

export function verificationAfterFactEdit(): VerificationState {
  return VERIFICATION_AFTER_EDIT;
}

const ADMIN_ONLY: VerificationState[] = ["source_confirmed", "reviewed"];
const ADVISOR_ALLOWED: VerificationState[] = ["disputed", "requires_professional_review"];

export function canSetVerification(
  from: VerificationState,
  to: VerificationState,
  actor: VerificationActor,
): VerificationCheck {
  const id = (actor?.id ?? "").trim();
  if (!id) return { ok: false, reason: "actor id required" };
  if (isAutomatedActor(id)) return { ok: false, reason: "automated actors cannot change verification" };
  if (actor.role !== "admin" && actor.role !== "advisor") return { ok: false, reason: "unknown staff role" };
  if (from === to) return { ok: false, reason: `verification is already ${to}` };

  if (ADMIN_ONLY.includes(to)) {
    return actor.role === "admin" ? { ok: true } : { ok: false, reason: `only admins may set ${to}` };
  }
  if (ADVISOR_ALLOWED.includes(to)) return { ok: true };
  if (to === "unverified") {
    if (actor.role === "admin") return { ok: true };
    return from === "disputed"
      ? { ok: true }
      : { ok: false, reason: "advisors may reset to unverified only from disputed" };
  }
  return { ok: false, reason: `unsupported target state ${String(to)}` };
}
