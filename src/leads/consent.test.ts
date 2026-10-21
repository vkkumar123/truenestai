import { describe, expect, it } from "vitest";
import { CONSENT_COPY, CONSENT_TEXT_VERSION } from "./consent";

describe("consent copy", () => {
  it("has a dated version and is marked draft", () => {
    expect(CONSENT_TEXT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
    expect(CONSENT_COPY.status).toBe("draft_pending_legal_review");
    expect(CONSENT_COPY.version).toBe(CONSENT_TEXT_VERSION);
  });
  it("discloses commercial relationships and disclaims guarantees", () => {
    expect(CONSENT_COPY.commercialDisclosure).toMatch(/fees/);
    expect(CONSENT_COPY.commercialDisclosure).toMatch(/not legal advice/);
    expect(CONSENT_COPY.commercialDisclosure).toMatch(/does not guarantee title, safety or returns/);
  });
  it("after-submit copy promises sharing only with the buyer's agreement", () => {
    expect(CONSENT_COPY.afterSubmit).toMatch(/not share your details with a developer or partner unless you agree/);
  });
  it("marks marketing consent as optional", () => {
    expect(CONSENT_COPY.marketingConsent).toMatch(/^Optional/);
  });
});
