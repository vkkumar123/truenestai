import { describe, expect, it } from "vitest";
import type { FactValue, Project, VerificationState } from "@/domain/types";
import { PUBLISH_ROLE, computeCompleteness, evaluatePublishReadiness } from "./publish";

const src = [{ sourceId: "SAMPLE_rera", url: "https://example.org/s", observedAt: "2026-10-01T10:00:00Z" }];
const known = <T,>(value: T, verification: VerificationState = "unverified"): FactValue<T> => ({ status: "known", value, verification, sources: src });
const unknown = <T,>(): FactValue<T> => ({ status: "unknown", value: null, verification: "unverified", sources: [] });

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "SAMPLE-p1",
    slug: "sample-p1",
    lane: "researched",
    name: "SAMPLE Project",
    developer: { id: "SAMPLE-d1", name: "SAMPLE Developer", isSample: true },
    localityId: "sample-locality",
    location: { lat: 13.1, lng: 77.6, precision: "approximate" },
    address: known("SAMPLE 1 Example Road"),
    reraNumbers: known(["SAMPLE/REF/0001"], "source_confirmed"),
    constructionStatus: known("under_construction"),
    declaredPossession: unknown(),
    units: [],
    regulatoryRecords: [],
    regulatorySearches: [],
    documents: [],
    reviewFlags: [],
    completeness: 0,
    lastCheckedAt: "2026-10-01T10:00:00Z",
    isSample: true,
    published: false,
    ...overrides,
  };
}

describe("computeCompleteness", () => {
  it("counts 4 fields + a unit with known price and area", () => {
    expect(computeCompleteness(project())).toBe(0.6);
    expect(
      computeCompleteness(
        project({
          declaredPossession: known("2027-12"),
          units: [{ label: "2 BHK", carpetAreaSqft: known({ min: 900, max: 1000 }), priceInr: known({ min: 1, max: 2 }) }],
        }),
      ),
    ).toBe(1);
    expect(computeCompleteness(project({ units: [{ label: "2 BHK", carpetAreaSqft: unknown(), priceInr: known({ min: 1, max: 2 }) }] }))).toBe(0.6);
  });
});

describe("evaluatePublishReadiness", () => {
  it("is ready when all rules pass", () => {
    expect(evaluatePublishReadiness(project())).toEqual({ ready: true, completeness: 0.6, blockers: [] });
    expect(PUBLISH_ROLE).toBe("admin");
  });
  it("blocks unconfirmed or unknown RERA numbers", () => {
    expect(evaluatePublishReadiness(project({ reraNumbers: known(["SAMPLE/REF/0001"]) })).blockers).toContain(
      "reraNumbers: must be source_confirmed or reviewed",
    );
    const r = evaluatePublishReadiness(project({ reraNumbers: unknown() }));
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("reraNumbers: not known");
  });
  it("blocks known facts without sources and disputed facts", () => {
    const r = evaluatePublishReadiness(project({ address: { ...known("SAMPLE 1 Example Road"), sources: [] }, declaredPossession: { ...unknown(), verification: "disputed" } }));
    expect(r.blockers).toEqual(expect.arrayContaining(["address: known value has no source", "declaredPossession: disputed"]));
  });
  it("blocks unknown construction status and low completeness", () => {
    const r = evaluatePublishReadiness(project({ constructionStatus: unknown(), address: unknown() }));
    expect(r.blockers).toContain("constructionStatus: not known");
    expect(r.blockers).toContain("completeness 20% is below 60%");
  });
});
