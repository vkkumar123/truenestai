import { describe, expect, it } from "vitest";
import { canSetVerification, verificationAfterFactEdit } from "./verification";

const advisor = { id: "staff_adv", role: "advisor" as const };
const admin = { id: "staff_admin", role: "admin" as const };

describe("canSetVerification", () => {
  it("lets advisors dispute or flag for professional review", () => {
    expect(canSetVerification("unverified", "disputed", advisor)).toEqual({ ok: true });
    expect(canSetVerification("unverified", "requires_professional_review", advisor)).toEqual({ ok: true });
  });
  it("lets advisors reset to unverified only from disputed", () => {
    expect(canSetVerification("disputed", "unverified", advisor)).toEqual({ ok: true });
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
