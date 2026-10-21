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

function revalidatePublic(project: Project) {
  revalidatePath("/projects");
  revalidatePath(`/projects/${project.slug}`);
  revalidatePath("/compare");
  revalidatePath("/");
}

type Outcome = ResearchResult<{ project: Project; changed?: boolean; autoUnpublished?: boolean }>;

async function run(
  label: string,
  fn: () => Promise<Outcome>,
  success: (r: Extract<Outcome, { ok: true }>) => string,
  /** Whether public pages may have changed (published project edited, publish state changed). */
  publicChanged: (project: Project, r: Extract<Outcome, { ok: true }>) => boolean,
): Promise<ResearchActionState> {
  try {
    const r = await fn();
    // Auth passed (no StaffAuthError). See mpa.ts — dev-only workaround, also for failures.
    ensureRenderPhaseAfterAction("/admin/projects", "layout");
    if (!r.ok) return { status: "error", error: r.error, message: r.message, ...(r.errors ? { errors: r.errors } : {}) };
    if (r.changed !== false) {
      revalidatePath("/admin/projects");
      revalidatePath(`/admin/projects/${r.project.id}`);
      if (publicChanged(r.project, r)) revalidatePublic(r.project);
    }
    return {
      status: "success",
      message: success(r),
      projectId: r.project.id,
      slug: r.project.slug,
      ...(r.autoUnpublished ? { autoUnpublished: true } : {}),
    };
  } catch (e) {
    if (isStaffAuthError(e)) return { status: "error", error: "unauthenticated", message: e.message };
    log.error(`research.${label}_failed`, { reason: e instanceof Error ? e.name : "unknown" });
    return { status: "error", error: "unavailable", message: "Something went wrong. Please try again." };
  }
}

const AUTO_UNPUBLISHED_MESSAGE = " The project no longer passes publish checks and was unpublished until an admin re-verifies it.";

/** Fields: name, developerId? (existing developer) or developerName (creates a new one), localityId, lat?, lng?. */
export async function createProjectAction(_prev: ResearchActionState, formData: FormData): Promise<ResearchActionState> {
  return run("create_project", () => createProject(formObject(formData)), () => "Project created (unpublished).", () => false);
}

/**
 * Fields: projectId, field (address|reraNumbers|constructionStatus|declaredPossession),
 * status (known|unknown), value (repeat or newline/comma-separate for reraNumbers),
 * sources[i].sourceId (registry id, see listResearchSources), sources[i].url, sources[i].observedAt,
 * sources[i].documentDate?, sources[i].note? (i < 3).
 */
export async function updateFactAction(_prev: ResearchActionState, formData: FormData): Promise<ResearchActionState> {
  return run(
    "update_fact",
    () => updateFact(formEntries(formData)),
    (r) => "Fact saved as unverified." + (r.autoUnpublished ? AUTO_UNPUBLISHED_MESSAGE : ""),
    (p, r) => p.published || r.autoUnpublished === true,
  );
}

/** Fields: projectId, field, to (verification state), expectedVersion (from getStaffProjectView.factVersions), note?. */
export async function changeVerificationAction(_prev: ResearchActionState, formData: FormData): Promise<ResearchActionState> {
  const f = formObject(formData);
  return run(
    "change_verification",
    () =>
      changeVerification({
        projectId: f.projectId ?? "",
        field: f.field ?? "",
        to: f.to ?? "",
        expectedVersion: f.expectedVersion ?? "",
        note: f.note ?? null,
      }),
    (r) => "Verification updated." + (r.autoUnpublished ? AUTO_UNPUBLISHED_MESSAGE : ""),
    (p, r) => p.published || r.autoUnpublished === true,
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
    () => (flag ? "Project published." : "Project unpublished."),
    () => true,
  );
}
