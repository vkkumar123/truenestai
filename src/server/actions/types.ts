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

export type UpdateLeadStatusState =
  | { status: "idle" }
  | { status: "success"; leadId: string; leadStatus: string; message: string }
  | { status: "error"; message: string; unauthenticated?: boolean };

export type ResearchActionState =
  | { status: "idle" }
  | { status: "success"; message: string; projectId: string; slug: string }
  | {
      status: "error";
      error: "validation" | "forbidden" | "not_found" | "not_ready" | "unauthenticated" | "unavailable";
      message: string;
      errors?: string[];
    };
