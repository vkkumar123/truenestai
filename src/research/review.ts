// Human review workflow for research findings, plus the schema for AI extraction output.
// AI output is a draft: it stays `unverified` and unpublishable until a human approves it.
import { z } from "zod";
import type { VerificationState } from "@/domain/types";
import { isAutomatedActor, validateRegistrationReference } from "./evidence";

export const QUOTE_MAX = 300;

export const SourceRefSchema = z.object({
  sourceId: z.string().trim().min(1),
  url: z.string().url().nullable(),
  observedAt: z.string().datetime({ offset: true }),
  documentDate: z.string().nullable().optional(),
  note: z.string().optional(),
});

export const EXTRACTED_FIELDS = [
  "rera_registration_number",
  "promoter_name",
  "project_name",
  "complaint_reference",
  "order_reference",
  "order_date",
  "declared_completion",
  "approval_reference",
  "other",
] as const;

export const ExtractedFindingSchema = z
  .object({
    field: z.enum(EXTRACTED_FIELDS),
    value: z.union([z.string().trim().min(1), z.number(), z.boolean()]).nullable(),
    sourceRef: SourceRefSchema,
    quote: z.string().trim().min(1).max(QUOTE_MAX),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((f, ctx) => {
    const refFields = ["rera_registration_number", "complaint_reference", "order_reference", "approval_reference"];
    if (refFields.includes(f.field) && f.value !== null) {
      if (typeof f.value !== "string") {
        ctx.addIssue({ code: "custom", path: ["value"], message: "reference must be a string" });
        return;
      }
      const check = validateRegistrationReference(f.value);
      if (!check.ok) ctx.addIssue({ code: "custom", path: ["value"], message: `reference ${check.reason}` });
      // Cross-check: a reference value must literally appear in the quoted source text.
      else if (!f.quote.replace(/\s+/g, " ").includes(check.normalized)) {
        ctx.addIssue({ code: "custom", path: ["quote"], message: "reference not present in quote" });
      }
    }
  });

export type ExtractedFinding = z.infer<typeof ExtractedFindingSchema>;

export type ReviewState = "draft" | "submitted" | "approved" | "rejected" | "needs_professional_review";

export interface ReviewEvent {
  from: ReviewState;
  to: ReviewState;
  actorId: string;
  at: string;
  note?: string;
}

export interface ResearchFinding {
  id: string;
  extracted: ExtractedFinding;
  origin: "ai" | "human";
  state: ReviewState;
  verification: VerificationState;
  reviewerId: string | null;
  history: ReviewEvent[];
}

export type ParseResult =
  | { ok: true; finding: ExtractedFinding }
  | { ok: false; issues: string[] };

export function parseExtractedFinding(input: unknown): ParseResult {
  const r = ExtractedFindingSchema.safeParse(input);
  if (r.success) return { ok: true, finding: r.data };
  return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** AI-extracted findings always start as draft + unverified. */
export function createAiDraft(id: string, extracted: ExtractedFinding): ResearchFinding {
  return { id, extracted, origin: "ai", state: "draft", verification: "unverified", reviewerId: null, history: [] };
}

const TRANSITIONS: Record<ReviewState, ReviewState[]> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected", "needs_professional_review"],
  needs_professional_review: ["approved", "rejected"],
  rejected: ["draft"],
  approved: [],
};

const REVIEW_DECISIONS: ReviewState[] = ["approved", "rejected", "needs_professional_review"];

export class ReviewTransitionError extends Error {}

export function transition(
  finding: ResearchFinding,
  to: ReviewState,
  actorId: string,
  at: string,
  note?: string,
): ResearchFinding {
  if (!TRANSITIONS[finding.state].includes(to)) {
    throw new ReviewTransitionError(`illegal transition ${finding.state} -> ${to}`);
  }
  const actor = actorId.trim();
  if (!actor) throw new ReviewTransitionError("actorId required");
  if (REVIEW_DECISIONS.includes(to) && isAutomatedActor(actor)) {
    throw new ReviewTransitionError(`review decisions require a human reviewer, got '${actor}'`);
  }
  const verification: VerificationState =
    to === "approved" ? "reviewed" : to === "needs_professional_review" ? "requires_professional_review" : "unverified";
  return {
    ...finding,
    state: to,
    verification,
    reviewerId: REVIEW_DECISIONS.includes(to) ? actor : null,
    history: [...finding.history, { from: finding.state, to, actorId: actor, at, note }],
  };
}

/** Publishable only when approved by a human reviewer (never 'ai'/'system'). */
export function canPublish(finding: ResearchFinding): boolean {
  return (
    finding.state === "approved" &&
    finding.verification === "reviewed" &&
    typeof finding.reviewerId === "string" &&
    finding.reviewerId.trim() !== "" &&
    !isAutomatedActor(finding.reviewerId)
  );
}
