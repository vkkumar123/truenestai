import { describe, expect, it } from "vitest";
import { QUOTE_MAX, ReviewTransitionError, canPublish, createAiDraft, parseExtractedFinding, transition } from "./review";

const base = {
  field: "rera_registration_number",
  value: "SAMPLE/REF/0001",
  sourceRef: { sourceId: "SAMPLE_rera", url: "https://example.org/sample", observedAt: "2026-10-01T10:00:00Z" },
  quote: "Registration No: SAMPLE/REF/0001",
  confidence: 0.9,
};
const at = "2026-10-02T00:00:00Z";

function draft() {
  const p = parseExtractedFinding(base);
  if (!p.ok) throw new Error(p.issues.join("; "));
  return createAiDraft("f1", p.finding);
}

describe("ExtractedFindingSchema", () => {
  it("accepts valid output", () => expect(parseExtractedFinding(base).ok).toBe(true));
  it("rejects long quotes, bad confidence, extra keys", () => {
    expect(parseExtractedFinding({ ...base, quote: "x".repeat(QUOTE_MAX + 1) }).ok).toBe(false);
    expect(parseExtractedFinding({ ...base, confidence: 1.5 }).ok).toBe(false);
    expect(parseExtractedFinding({ ...base, verified: true }).ok).toBe(false);
  });
  it("cross-checks reference against quote and shape", () => {
    expect(parseExtractedFinding({ ...base, quote: "Registration No: OTHER/0002" }).ok).toBe(false);
    expect(parseExtractedFinding({ ...base, value: "<bad>" }).ok).toBe(false);
  });
  it("is deterministic", () => {
    expect(parseExtractedFinding({ ...base, confidence: -1 })).toEqual(parseExtractedFinding({ ...base, confidence: -1 }));
  });
});

describe("review workflow", () => {
  it("AI drafts start draft + unverified and are unpublishable", () => {
    const f = draft();
    expect(f.state).toBe("draft");
    expect(f.verification).toBe("unverified");
    expect(canPublish(f)).toBe(false);
  });
  it("publishes only after human approval", () => {
    const s = transition(draft(), "submitted", "ai", at);
    expect(canPublish(s)).toBe(false);
    const a = transition(s, "approved", "reviewer_1", at);
    expect(a.verification).toBe("reviewed");
    expect(canPublish(a)).toBe(true);
    expect(a.history).toHaveLength(2);
  });
  it("blocks automated reviewers and illegal transitions", () => {
    const s = transition(draft(), "submitted", "ai", at);
    expect(() => transition(s, "approved", "AI", at)).toThrow(ReviewTransitionError);
    expect(() => transition(s, "approved", "system", at)).toThrow(ReviewTransitionError);
    expect(() => transition(draft(), "approved", "reviewer_1", at)).toThrow(ReviewTransitionError);
  });
  it("routes to professional review and back", () => {
    const s = transition(draft(), "submitted", "ai", at);
    const p = transition(s, "needs_professional_review", "reviewer_1", at);
    expect(p.verification).toBe("requires_professional_review");
    expect(canPublish(p)).toBe(false);
    expect(canPublish(transition(p, "approved", "lawyer_1", at))).toBe(true);
    const r = transition(s, "rejected", "reviewer_1", at);
    expect(canPublish(r)).toBe(false);
    expect(transition(r, "draft", "ai", at).state).toBe("draft");
  });
  it("canPublish rejects tampered state with automated reviewer", () => {
    const a = transition(transition(draft(), "submitted", "ai", at), "approved", "reviewer_1", at);
    expect(canPublish({ ...a, reviewerId: "system" })).toBe(false);
  });
});
