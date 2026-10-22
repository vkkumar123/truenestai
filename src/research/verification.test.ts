import { describe, expect, it } from "vitest";
import type { FactValue } from "@/domain/types";
import { canSetVerification, factVersion, verificationAfterFactEdit } from "./verification";

const advisor = { id: "staff_adv", role: "advisor" as const };
const admin = { id: "staff_admin", role: "admin" as const };

describe("canSetVerification", () => {
  it("lets advisors dispute or flag for professional review", () => {
    expect(canSetVerification("unverified", "disputed", advisor)).toEqual({ ok: true });
    expect(canSetVerification("unverified", "requires_professional_review", advisor)).toEqual({ ok: true });
  });
  it("makes reset to unverified admin-only, including from disputed", () => {
    expect(canSetVerification("disputed", "unverified", advisor).ok).toBe(false);
    expect(canSetVerification("disputed", "unverified", admin)).toEqual({ ok: true });
    expect(canSetVerification("reviewed", "unverified", advisor).ok).toBe(false);
    expect(canSetVerification("reviewed", "unverified", admin).ok).toBe(true);
  });
  it("reserves source_confirmed and reviewed for admins", () => {
    expect(canSetVerification("unverified", "source_confirmed", advisor).ok).toBe(false);
    expect(canSetVerification("unverified", "reviewed", advisor).ok).toBe(false);
    expect(canSetVerification("unverified", "source_confirmed", admin)).toEqual({ ok: true });
    expect(canSetVerification("source_confirmed", "reviewed", admin)).toEqual({ ok: true });
  });
  it("always refuses automated actors, even as admin", () => {
    for (const id of ["ai", "System", " bot "]) {
      expect(canSetVerification("unverified", "reviewed", { id, role: "admin" }).ok).toBe(false);
      expect(canSetVerification("unverified", "disputed", { id, role: "advisor" }).ok).toBe(false);
    }
  });
  it("refuses no-op and missing actor id", () => {
    expect(canSetVerification("disputed", "disputed", admin).ok).toBe(false);
    expect(canSetVerification("unverified", "disputed", { id: "", role: "admin" }).ok).toBe(false);
  });
  it("fact edits reset to unverified", () => {
    expect(verificationAfterFactEdit()).toBe("unverified");
  });
});

describe("factVersion", () => {
  const a = { sourceId: "SAMPLE_a", url: "https://example.org/a", observedAt: "2026-10-01T10:00:00Z" };
  const b = { sourceId: "SAMPLE_b", url: "https://example.org/b", observedAt: "2026-10-01T10:00:00Z", documentDate: null };
  const fact: FactValue<unknown> = { status: "known", value: { min: 1, max: 2 }, verification: "unverified", sources: [a, b] };

  it("is deterministic and ignores key order and source order", () => {
    const v = factVersion(fact);
    expect(v).toMatch(/^v1-[0-9a-f]{8}-[0-9a-z]+$/);
    expect(factVersion({ ...fact })).toBe(v);
    expect(factVersion({ ...fact, value: { max: 2, min: 1 }, sources: [b, a] })).toBe(v);
  });
  it("changes when status, value, verification or sources change", () => {
    const v = factVersion(fact);
    expect(factVersion({ ...fact, verification: "disputed" })).not.toBe(v);
    expect(factVersion({ ...fact, value: { min: 1, max: 3 } })).not.toBe(v);
    expect(factVersion({ ...fact, status: "unknown" })).not.toBe(v);
    expect(factVersion({ ...fact, sources: [a] })).not.toBe(v);
    expect(factVersion({ ...fact, sources: [a, { ...b, note: "x" }] })).not.toBe(v);
  });
});
