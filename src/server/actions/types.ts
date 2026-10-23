import "server-only";
// Result shapes for useActionState. Client components should `import type` from here
// (type-only imports are erased, so 'server-only' is not pulled into the client bundle).
// Initial state for every action below: `{ status: "idle" }`.

export type SubmitLeadState =
  | { status: "idle" }
  | { status: "success"; leadId: string; message: string }
  | { status: "error"; reason: "validation" | "rate_limited" | "unavailable"; errors: Record<string, string> };

export type AdminLoginState =
  | { status: "idle" }
  | { status: "error"; message: string };

export type SetPasswordState =
  | { status: "idle" }
  | { status: "error"; message: string; linkInvalid?: boolean };

export type UpdateLeadStatusState =
  | { status: "idle" }
  | { status: "success"; leadId: string; leadStatus: string; message: string }
  | { status: "error"; message: string; unauthenticated?: boolean };

export type AssignLeadState =
  | { status: "idle" }
  | { status: "success"; leadId: string; assignedTo: string | null; message: string }
  | { status: "error"; message: string; unauthenticated?: boolean };

export type ResearchActionState =
  | { status: "idle" }
  | {
      status: "success";
      /** What the action did (never includes the auto-unpublish notice). */
      message: string;
      projectId: string;
      slug: string;
      /** D13: true when this edit made a published project fail readiness and it was unpublished. */
      autoUnpublished: boolean;
      /** Present only when autoUnpublished: the notice to show (AUTO_UNPUBLISHED_MESSAGE). */
      autoUnpublishedMessage?: string;
    }
  | {
      status: "error";
      error: "validation" | "forbidden" | "not_found" | "not_ready" | "conflict" | "unauthenticated" | "unavailable";
      message: string;
      errors?: string[];
    };

/** Shown alongside a successful research action that auto-unpublished the project (D13). */
export const AUTO_UNPUBLISHED_MESSAGE =
  "The project no longer passes publish checks and was unpublished until an admin re-verifies it.";

/** On-demand web research trigger (startWebResearchAction). Initial state: `{ status: "idle" }`. */
export type WebResearchActionState =
  | { status: "idle" }
  | { status: "none" } // research does not apply (not a miss, too short, bot, or an error)
  | { status: "researching"; queryText: string }
  | { status: "searched_none"; queryText: string; searchedAt: string }
  | { status: "unavailable"; queryText: string };
