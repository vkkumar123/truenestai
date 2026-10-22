import { describe, expect, it } from "vitest";
import { describeComplaintSearch, reviewFlagsFor, validateRegistrationReference } from "./evidence";

const src = (sourceId: string) => ({ sourceId, url: "https://example.org/sample", observedAt: "2026-10-01T10:00:00Z" });

describe("describeComplaintSearch", () => {
  it("scopes zero results to date and sources, never 'no complaints'", () => {
    const text = describeComplaintSearch({ sourcesChecked: [src("SAMPLE_rera"), src("SAMPLE_rera")], found: 0, checkedAt: "2026-10-01T10:00:00Z" });
    expect(text).toContain("No complaint found as of 2026-10-01 in SAMPLE_rera.");
    expect(text).toContain("does not confirm the absence");
    expect(text.toLowerCase()).not.toMatch(/\bno complaints\b/);
  });
  it("says not checked when no sources were checked", () => {
    expect(describeComplaintSearch({ sourcesChecked: [], found: 0, checkedAt: "2026-10-01T10:00:00Z" })).toBe(
      "Complaint records not yet checked.",
    );
  });
  it("reports counts with source scope", () => {
    expect(describeComplaintSearch({ sourcesChecked: [src("A"), src("B")], found: 2, checkedAt: "2026-10-01T00:00:00Z" })).toMatch(
      /^2 complaint records found as of 2026-10-01 in A, B\./,
    );
  });
  it("flags invalid counts for review", () => {
    expect(describeComplaintSearch({ sourcesChecked: [src("A")], found: -1, checkedAt: "bad" })).toContain("requires reviewer check");
  });
});

describe("validateRegistrationReference", () => {
  it("accepts plausible shapes without confirming format", () => {
    expect(validateRegistrationReference("  SAMPLE/REF/0001 ")).toEqual({ ok: true, normalized: "SAMPLE/REF/0001", formatConfirmed: false });
  });
  it("rejects empty, short, long, and bad characters", () => {
    expect(validateRegistrationReference("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateRegistrationReference("AB")).toEqual({ ok: false, reason: "too_short" });
    expect(validateRegistrationReference("A".repeat(121))).toEqual({ ok: false, reason: "too_long" });
    expect(validateRegistrationReference("REF<script>")).toEqual({ ok: false, reason: "invalid_characters" });
  });
});

describe("reviewFlagsFor", () => {
  it("always includes core flags until reviewed", () => {
    expect(reviewFlagsFor()).toEqual(["title_verification", "encumbrance_check", "approvals_validity", "land_conversion"]);
    expect(reviewFlagsFor({ landConversionNotApplicable: true })).toEqual(["title_verification", "encumbrance_check", "approvals_validity"]);
  });
  it("removes a flag only for a human reviewer", () => {
    const at = "2026-10-01T00:00:00Z";
    const flags = reviewFlagsFor({
      professionallyReviewed: { title_verification: { reviewerId: "lawyer_1", reviewedAt: at }, encumbrance_check: { reviewerId: "AI", reviewedAt: at } },
    });
    expect(flags).not.toContain("title_verification");
    expect(flags).toContain("encumbrance_check");
  });
});
