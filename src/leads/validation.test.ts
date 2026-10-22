import { describe, expect, it } from "vitest";
import { CONSENT_TEXT_VERSION } from "./consent";
import { normaliseIndianMobile, parseLeadInput } from "./validation";

// Obviously fictional test numbers (not real subscribers). Do not replace with realistic numbers.
const SAMPLE_PHONE_LOCAL = "6000000001";
const SAMPLE_PHONE_E164 = "+916000000001";

const base = {
  requestType: "verification",
  name: "  Sample Buyer  ",
  email: "buyer@example.com",
  phone: "",
  preferredChannel: "email",
  message: "",
  projectId: "SAMPLE-PROJECT-1",
  externalListingId: "",
  budgetBand: "1cr_1_5cr",
  contactConsent: "on",
  consentTextVersion: CONSENT_TEXT_VERSION,
  website: "",
};

function errs(raw: unknown) {
  const r = parseLeadInput(raw);
  if (r.ok) throw new Error("expected failure");
  return r.errors;
}

describe("parseLeadInput", () => {
  it("accepts a FormData-style object and produces LeadInput", () => {
    const r = parseLeadInput({ ...base, landingPath: "/projects/sample", utmSource: "x", unknownField: "dropped" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      requestType: "verification",
      name: "Sample Buyer",
      email: "buyer@example.com",
      phone: null,
      preferredChannel: "email",
      message: null,
      projectId: "SAMPLE-PROJECT-1",
      externalListingId: null,
      budgetBand: "1cr_1_5cr",
      consent: { contactConsent: true, marketingConsent: false, consentTextVersion: CONSENT_TEXT_VERSION },
      attribution: { utmSource: "x", landingPath: "/projects/sample" },
    });
    expect(r.value).not.toHaveProperty("website");
    expect(r.value).not.toHaveProperty("unknownField");
  });

  it("accepts nested consent/attribution objects", () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest.contactConsent;
    delete rest.consentTextVersion;
    const r = parseLeadInput({
      ...rest,
      consent: { contactConsent: true, marketingConsent: "true", consentTextVersion: CONSENT_TEXT_VERSION },
      attribution: { utmMedium: "cpc" },
    });
    expect(r.ok && r.value.consent.marketingConsent).toBe(true);
    expect(r.ok && r.value.attribution).toEqual({ utmMedium: "cpc" });
  });

  it("rejects missing or false contact consent", () => {
    const noConsent: Record<string, unknown> = { ...base };
    delete noConsent.contactConsent;
    expect(errs(noConsent).contactConsent).toMatch(/agree/);
    expect(errs({ ...base, contactConsent: "false" }).contactConsent).toBeDefined();
    expect(errs({ ...base, contactConsent: false }).contactConsent).toBeDefined();
  });

  it("rejects a stale consent text version", () => {
    expect(errs({ ...base, consentTextVersion: "2020-01-01.v1" }).consentTextVersion).toMatch(/reload/);
  });

  it("rejects a filled honeypot", () => {
    expect(errs({ ...base, website: "http://spam.example.com" }).website).toBeDefined();
  });

  it("requires at least one contact method", () => {
    expect(errs({ ...base, email: "", phone: "" }).phone).toMatch(/email address or a mobile/);
  });

  it("rejects channel without matching contact detail", () => {
    expect(errs({ ...base, preferredChannel: "whatsapp" }).preferredChannel).toMatch(/mobile/);
    expect(errs({ ...base, email: "", phone: SAMPLE_PHONE_LOCAL, preferredChannel: "email" }).preferredChannel).toMatch(
      /email/,
    );
  });

  it("normalises phone and accepts whatsapp with phone", () => {
    const r = parseLeadInput({ ...base, email: "", phone: "+91 60000-00001", preferredChannel: "whatsapp" });
    expect(r.ok && r.value.phone).toBe(SAMPLE_PHONE_E164);
  });

  it("rejects invalid phone and email", () => {
    expect(errs({ ...base, phone: "12345" }).phone).toMatch(/10-digit/);
    expect(errs({ ...base, email: "not-an-email" }).email).toMatch(/valid email/);
  });

  it("rejects both projectId and externalListingId", () => {
    expect(errs({ ...base, externalListingId: "SAMPLE-EXT-1" }).projectId).toMatch(/only one/);
  });

  it("enforces name, message, budget and attribution limits", () => {
    expect(errs({ ...base, name: " A " }).name).toBeDefined();
    expect(errs({ ...base, name: "x".repeat(81) }).name).toBeDefined();
    expect(errs({ ...base, message: "x".repeat(1001) }).message).toMatch(/1000/);
    expect(parseLeadInput({ ...base, message: "x".repeat(1000) }).ok).toBe(true);
    expect(errs({ ...base, budgetBand: "unlimited" }).budgetBand).toBeDefined();
    expect(errs({ ...base, landingPath: "https://evil.example.com" }).landingPath).toBeDefined();
    expect(errs({ ...base, landingPath: "//evil.example.com" }).landingPath).toBeDefined();
    expect(errs({ ...base, utmSource: "x".repeat(101) }).utmSource).toBeDefined();
  });

  it("rejects non-object input", () => {
    expect(errs(null).form).toBeDefined();
    expect(errs("hello").form).toBeDefined();
  });
});

describe("normaliseIndianMobile", () => {
  it.each([
    [SAMPLE_PHONE_LOCAL, SAMPLE_PHONE_E164],
    ["+91 60000 00001", SAMPLE_PHONE_E164],
    ["+91-60000-00001", SAMPLE_PHONE_E164],
    ["916000000001", SAMPLE_PHONE_E164],
    ["06000000001", SAMPLE_PHONE_E164],
    ["(600) 000-0001", SAMPLE_PHONE_E164],
    ["9000000002", "+919000000002"],
  ])("%s → %s", (input, out) => expect(normaliseIndianMobile(input)).toBe(out));

  it.each(["5000000001", "600000000", "60000000011", "+1 5550000001", "+44 6000000001", "abcdefghij"])(
    "rejects %s",
    (input) => expect(normaliseIndianMobile(input)).toBeNull(),
  );
});
