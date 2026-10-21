import { describe, expect, it } from "vitest";
import type { LeadInput } from "@/domain/types";
import { qualifyLead } from "./qualification";

const minimal: LeadInput = {
  requestType: "buyer_assistance",
  name: "Sample Buyer",
  email: "buyer@example.com",
  phone: null,
  preferredChannel: "email",
  message: null,
  projectId: null,
  externalListingId: null,
  budgetBand: null,
  consent: { contactConsent: true, marketingConsent: false, consentTextVersion: "v" },
  attribution: {},
};

describe("qualifyLead", () => {
  it("scores a bare lead low with an explanation", () => {
    const q = qualifyLead(minimal);
    expect(q).toEqual({ score: 0, tier: "low", reasons: ["No qualifying signals beyond contact details"] });
  });

  it("scores a rich verification lead high and explains each signal", () => {
    const q = qualifyLead({
      ...minimal,
      requestType: "verification",
      projectId: "SAMPLE-P1",
      budgetBand: "50l_1cr",
      message: "Please check the RERA registration and possession timeline for this project.",
      phone: "+919876543210",
    });
    expect(q.score).toBe(95);
    expect(q.tier).toBe("high");
    expect(q.reasons).toHaveLength(5);
    expect(q.reasons[0]).toMatch(/verification/);
  });

  it("is medium for external listing + budget", () => {
    const q = qualifyLead({ ...minimal, externalListingId: "SAMPLE-E1", budgetBand: "under_50l", message: "hi" });
    expect(q.score).toBe(40);
    expect(q.tier).toBe("medium");
  });

  it("is deterministic", () => {
    expect(qualifyLead(minimal)).toEqual(qualifyLead(minimal));
  });
});
