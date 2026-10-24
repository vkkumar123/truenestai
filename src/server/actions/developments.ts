"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { isStaffAuthError } from "../auth";
import { log } from "../log";
import {
  createDevelopment,
  requestAreaDevelopmentResearch,
  reviewDevelopment,
  updateDevelopment,
  type DevelopmentResult,
  type DevelopmentWriteOk,
} from "../services/developments";
import { ensureRenderPhaseAfterAction } from "./mpa";
import type { DevelopmentActionState } from "./types";

// Area developments staff actions for useActionState(action, { status: "idle" }).
// Authorization and role rules are enforced in services/developments.ts.

/** Form entries without Next's internal $ACTION_* fields; repeated keys (localityIds) kept. */
function formEntries(formData: FormData): { entries(): Iterable<[string, string]> } {
  const list: [string, string][] = [];
  for (const [k, v] of formData.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) list.push([k, v]);
  return { entries: () => list };
}

function revalidateDevelopments(publicChanged: boolean) {
  revalidatePath("/admin/developments");
  if (publicChanged) revalidatePath("/projects", "layout");
}

async function run(
  label: string,
  fn: () => Promise<DevelopmentResult<DevelopmentWriteOk>>,
  success: (r: DevelopmentWriteOk) => string,
  /** Review actions (publish, unpublish, reject, restore) can change what buyers see. */
  alwaysPublic = false,
): Promise<DevelopmentActionState> {
  try {
    const r = await fn();
    ensureRenderPhaseAfterAction("/admin/developments"); // see mpa.ts (dev-only)
    if (!r.ok) return { status: "error", error: r.error, message: r.message, ...(r.errors ? { errors: r.errors } : {}) };
    if (r.changed) revalidateDevelopments(alwaysPublic || r.development.published || r.autoUnpublished);
    return {
      status: "success",
      message: r.changed ? success(r) : "Nothing changed.",
      developmentId: r.development.id,
      autoUnpublished: r.autoUnpublished,
    };
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", error: "unauthenticated", message: e.message };
    log.error(`developments.${label}_failed`, { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", error: "unavailable", message: "Something went wrong. Please try again." };
  }
}

/** Field: localityId. Queues "Research area developments" for that locality (existing worker). */
export async function requestDevelopmentResearchAction(_prev: DevelopmentActionState, formData: FormData): Promise<DevelopmentActionState> {
  try {
    const r = await requestAreaDevelopmentResearch({ localityId: formData.get("localityId") });
    ensureRenderPhaseAfterAction("/admin/developments");
    if (!r.ok) return { status: "error", error: r.error, message: r.message };
    revalidatePath("/admin/developments");
    revalidatePath("/admin/research-jobs");
    const name = r.localityName;
    switch (r.result.state) {
      case "queued":
        return { status: "success", message: `Research queued for ${name}. The worker runs it on its next scheduled run; refresh to see results.` };
      case "active":
        return { status: "success", message: `Research for ${name} is already queued or running.` };
      case "cached":
        return { status: "success", message: `${name} was researched recently; results are listed below. Research can be repeated after the cache window.` };
      case "failed_recently":
        return { status: "error", error: "unavailable", message: `Research for ${name} failed recently. Try again later.` };
      case "limited":
        return { status: "error", error: "unavailable", message: "The daily research limit has been reached. Try again tomorrow." };
    }
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", error: "unauthenticated", message: e.message };
    log.error("developments.research_request_failed", { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", error: "unavailable", message: "Something went wrong. Please try again." };
  }
}

/** Fields: name, category, stage, authority, expectedCompletion?, announcedDate?, localityIds (repeat), lat?, lng?, locationPrecision?, sourceUrl, sourceObservedAt. */
export async function createDevelopmentAction(_prev: DevelopmentActionState, formData: FormData): Promise<DevelopmentActionState> {
  return run("create", () => createDevelopment(formEntries(formData)), () => "Development added (unpublished, unverified).");
}

/** Same fields as create, plus id and version (what the reviewer saw). */
export async function updateDevelopmentAction(_prev: DevelopmentActionState, formData: FormData): Promise<DevelopmentActionState> {
  return run("update", () => updateDevelopment(formEntries(formData)), (r) =>
    r.autoUnpublished ? "Saved. It no longer passes publish checks and was unpublished." : "Saved as unverified.",
  );
}

/** Fields: id, version, action (publish|unpublish|reject|restore), verification? (publish), note? */
export async function reviewDevelopmentAction(_prev: DevelopmentActionState, formData: FormData): Promise<DevelopmentActionState> {
  const action = String(formData.get("action") ?? "");
  const done: Record<string, string> = { publish: "Published.", unpublish: "Unpublished.", reject: "Rejected.", restore: "Restored to pending review." };
  return run("review", () => reviewDevelopment(formEntries(formData)), () => done[action] ?? "Saved.", true);
}
