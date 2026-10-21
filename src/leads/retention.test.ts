import { describe, expect, it } from "vitest";
import type { Lead } from "@/domain/types";
import { canTransition, computeRetentionUntil, redactLeadForLog, transitionLead, withdrawLead } from "./retention";

const lead: Lead = {
  id: "lead_SAMPLE_1",
  status: "new",
  createdAt: "2026-01-31T10:00:00.000Z",
  retentionUntil: "2027-01-31T10:00:00.000Z",
  requestType: "verification",
  name: "Sample Buyer",
  email: "buyer@example.com",
  phone: "+919876543210",
  preferredChannel: "phone",
  message: "Private message",
  projectId: "SAMPLE-P1",
  externalListingId: null,
  budgetBand: "50l_1cr",
  consent: { contactConsent: true, marketingConsent: true, consentTextVersion: "v" },
  attribution: { utmSource: "s", landingPath: "/x" },
};

describe("computeRetentionUntil", () => {
  it("is 12 months for open and 24 months for closed leads", () => {
    expect(computeRetentionUntil("2026-03-15T00:00:00.000Z", "new")).toBe("2027-03-15T00:00:00.000Z");
    expect(computeRetentionUntil("2026-03-15T00:00:00.000Z", "closed")).toBe("2028-03-15T00:00:00.000Z");
  });
  it("clamps month-end and leap days", () => {
    expect(computeRetentionUntil("2027-02-28T00:00:00.000Z", "closed")).toBe("2029-02-28T00:00:00.000Z");
    expect(computeRetentionUntil("2028-02-29T00:00:00.000Z", "new")).toBe("2029-02-28T00:00:00.000Z");
  });
  it("throws on invalid dates", () => {
    expect(() => computeRetentionUntil("nope", "new")).toThrow();
  });
});

describe("status transitions", () => {
  it("allows forward moves and withdrawal; blocks leaving withdrawn", () => {
    expect(canTransition("new", "contacted")).toBe(true);
    expect(canTransition("closed", "withdrawn")).toBe(true);
    expect(canTransition("withdrawn", "new")).toBe(false);
    expect(canTransition("closed", "new")).toBe(false);
    expect(canTransition("new", "qualified")).toBe(false);
  });
  it("recomputes retention on close", () => {
    const r = transitionLead(lead, "closed");
    expect(r.ok && r.lead.retentionUntil).toBe("2028-01-31T10:00:00.000Z");
    expect(transitionLead(lead, "new").ok).toBe(false);
  });
});

describe("redactLeadForLog", () => {
  it("contains no PII", () => {
    const red = redactLeadForLog(lead);
    expect(red).toEqual({ id: "lead_SAMPLE_1", status: "new", requestType: "verification" });
    const s = JSON.stringify(red);
    for (const pii of ["Sample Buyer", "buyer@example.com", "9876543210", "Private message"]) {
      expect(s).not.toContain(pii);
    }
  });
});

describe("withdrawLead", () => {
  it("withdraws, revokes consent and erases PII", () => {
    const r = withdrawLead({ ...lead, status: "contacted" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lead.status).toBe("withdrawn");
    expect(r.lead.consent.contactConsent).toBe(false);
    expect(r.lead.consent.marketingConsent).toBe(false);
    const s = JSON.stringify(r.lead);
    for (const pii of ["Sample Buyer", "buyer@example.com", "9876543210", "Private message"]) {
      expect(s).not.toContain(pii);
    }
  });
  it("is idempotent", () => {
    const once = withdrawLead(lead);
    if (!once.ok) throw new Error("expected ok");
    expect(withdrawLead(once.lead)).toEqual(once);
  });
});
