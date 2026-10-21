// Verification-state permissions for staff (M3, D12). Pure.
import type { FactValue, StaffRole, VerificationState } from "@/domain/types";
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
    // Review M3: resetting (including disputed -> unverified) is admin-only.
    return actor.role === "admin" ? { ok: true } : { ok: false, reason: "only admins may reset to unverified" };
  }
  return { ok: false, reason: `unsupported target state ${String(to)}` };
}

/** Canonical JSON: object keys sorted, undefined dropped. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return "null";
    return JSON.stringify(v) ?? "null";
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** 32-bit FNV-1a over UTF-16 code units. Not cryptographic; change detection only. */
function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Stable, client-safe version tag of a fact (status + value + verification + sources),
 * so a stale reviewer cannot overwrite a verification change they did not see. Source order does not matter. The UI posts it back and the
 * service compares it so a verification applies only to the version the reviewer saw.
 */
export function factVersion(fact: FactValue<unknown>): string {
  const sources = (fact.sources ?? []).map(canonical).sort();
  const body = canonical({ status: fact.status, value: fact.value ?? null, verification: fact.verification }) + "|" + sources.join(",");
  return `v1-${fnv1a32(body)}-${body.length.toString(36)}`;
}
