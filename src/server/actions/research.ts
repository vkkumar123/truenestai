"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import type { Project } from "@/domain/types";
import { isStaffAuthError } from "../auth";
import { log } from "../log";
import { changeVerification, createProject, setPublished, updateFact, type ResearchResult } from "../services/research";
import type { ResearchActionState } from "./types";
import { ensureRenderPhaseAfterAction } from "./mpa";

// Staff research actions for useActionState: `useActionState(action, { status: "idle" })`.
// Authorization is enforced in services/research.ts (requireStaff + role rules).

/** Form entries without Next's internal $ACTION_* fields; repeated keys (e.g. `value`) preserved. */
function formEntries(formData: FormData): { entries(): Iterable<[string, string]> } {
  const list: [string, string][] = [];
  for (const [k, v] of formData.entries()) if (typeof v === "string" && !k.startsWith("$ACTION")) list.push([k, v]);
  return { entries: () => list };
}

function formObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formEntries(formData).entries()) if (!(k in out)) out[k] = v;
  return out;
}

function revalidate(project: Project, publicChanged: boolean) {
  revalidatePath("/admin/projects");
  revalidatePath(`/admin/projects/${project.id}`);
  if (publicChanged) {
    revalidatePath("/projects");
    revalidatePath(`/projects/${project.slug}`);
    revalidatePath("/compare");
    revalidatePath("/");
  }
}

async function run(
  label: string,
  fn: () => Promise<ResearchResult<{ project: Project; changed?: boolean }>>,
  success: string,
  publicChanged: (project: Project, changed: boolean) => boolean,
): Promise<ResearchActionState> {
  // See mpa.ts: guarantees the post-action render is in the render phase even on failure.
  ensureRenderPhaseAfterAction("/admin/projects", "layout");
  try {
    const r = await fn();
    if (!r.ok) return { status: "error", error: r.error, message: r.message, ...(r.errors ? { errors: r.errors } : {}) };
    const changed = r.changed ?? true;
    if (changed) revalidate(r.project, publicChanged(r.project, changed));
    return { status: "success", message: success, projectId: r.project.id, slug: r.project.slug };
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", error: "unauthenticated", message: e.message };
    log.error(`research.${label}_failed`, { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", error: "unavailable", message: "Something went wrong. Please try again." };
  }
}

/** Fields: name, developerName, localityId, lat?, lng?. */
export async function createProjectAction(_prev: ResearchActionState, formData: FormData): Promise<ResearchActionState> {
  return run("create_project", () => createProject(formObject(formData)), "Project created (unpublished).", () => false);
}

/**
 * Fields: projectId, field (address|reraNumbers|constructionStatus|declaredPossession),
 * status (known|unknown), value (repeat or newline/comma-separate for reraNumbers),
 * sources[i].sourceId, sources[i].url, sources[i].observedAt, sources[i].documentDate?, sources[i].note? (i < 3).
 */
export async function updateFactAction(_prev: ResearchActionState, formData: FormData): Promise<ResearchActionState> {
  return run("update_fact", () => updateFact(formEntries(formData)), "Fact saved as unverified.", (p) => p.published);
}

/** Fields: projectId, field, to (verification state), note?. */
export async function changeVerificationAction(_prev: ResearchActionState, formData: FormData): Promise<ResearchActionState> {
  const f = formObject(formData);
  return run(
    "change_verification",
    () => changeVerification(f.projectId ?? "", f.field ?? "", f.to ?? "", f.note ?? null),
    "Verification updated.",
    (p) => p.published,
  );
}

/** Fields: projectId, published ("true" | "false"). Admin only; publishing requires readiness. */
export async function setPublishedAction(_prev: ResearchActionState, formData: FormData): Promise<ResearchActionState> {
  const f = formObject(formData);
  const flag = f.published === "true" ? true : f.published === "false" ? false : null;
  if (flag === null) return { status: "error", error: "validation", message: "Invalid publish request." };
  return run(
    "set_published",
    () => setPublished(f.projectId ?? "", flag),
    flag ? "Project published." : "Project unpublished.",
    () => true,
  );
}
