import { describe, expect, it } from "vitest";
import { InvalidRecordError, NOT_VERIFIED, MAX_TITLE, normalize, normalizeRecord, safeHttpsUrl, type RawExternalRecord } from "./adapter";
import { getSource } from "./registry";

const now = new Date("2026-10-01T00:00:00Z");
const raw: RawExternalRecord = {
  sourceId: "sample-feed",
  sourceRecordId: "SAMPLE-X",
  canonicalUrl: "https://example.com/sample/x",
  title: `<b>SAMPLE</b>\n Very   long ${"name ".repeat(50)}`,
  developerName: "SAMPLE Developer Z",
  priceText: "₹ SAMPLE",
  reraNumber: "SAMPLE-RERA-9",
};

describe("normalize", () => {
  it("labels as external, unverified, sample, with source limitations", () => {
    const l = normalize(raw, getSource("sample-feed")!, now);
    expect(l.lane).toBe("external");
    expect(l.isSample).toBe(true);
    expect(l.limitations[0]).toBe(NOT_VERIFIED);
    expect(l.limitations.some((x) => x.includes("SAMPLE fictional"))).toBe(true);
    expect(l.discoveredAt).toBe(now.toISOString());
    expect(l.matchedProjectId).toBeNull();
  });
  it("strips tags/whitespace and caps title length", () => {
    const l = normalize(raw, getSource("sample-feed")!, now);
    expect(l.title).not.toMatch(/<|\n|  /);
    expect(l.title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(l.title.startsWith("SAMPLE Very long")).toBe(true);
  });
  it("drops fields the source does not permit storing", () => {
    const src = { ...getSource("sample-feed")!, type: "listing_portal" as const, storagePermissions: ["canonical_url" as const], listingLimitations: [] };
    const r = normalizeRecord(raw, src, now);
    expect(r.listing.isSample).toBe(false);
    expect(r.listing.developerName).toBeNull();
    expect(r.listing.priceText).toBeNull();
    expect(r.listing.sourceRecordId).toBeNull();
    expect(r.reraNumber).toBeNull();
    expect(r.listing.title).toBe(`Listing on ${src.name}`);
    expect(r.listing.limitations).toContain(NOT_VERIFIED);
  });
  it("rejects non-https or malformed canonical URLs and keeps valid ones unmodified", () => {
    const src = getSource("sample-feed")!;
    for (const bad of ["http://example.com/x", "javascript:alert(1)", "not a url", "", "https://exa mple.com/x"])
      expect(() => normalize({ ...raw, canonicalUrl: bad }, src, now)).toThrow(InvalidRecordError);
    const odd = "https://example.com/sample/a<b>?q=<x>";
    expect(normalize({ ...raw, canonicalUrl: odd }, src, now).canonicalUrl).toBe(odd);
    expect(safeHttpsUrl(" https://example.com/ok ")).toBe("https://example.com/ok");
  });
});
