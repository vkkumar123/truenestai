import { describe, expect, it } from "vitest";
import type { DeclaredCompletionRevision, GeoPoint } from "@/domain/types";
import {
  INFRA_CATEGORIES,
  INFRA_STAGES,
  PLANNED_DISCLAIMER,
  classifyChange,
  describeSlips,
  developmentsNear,
  expectedLabel,
  formatStraightLine,
  isInfraStage,
  isPromotionalText,
  parseDeclaredDate,
  stageFromText,
  stageRank,
  summarizeSlips,
  withinHorizon,
} from "./developments";

const rev = (expectedCompletion: string, asOf: string): DeclaredCompletionRevision => ({ expectedCompletion, asOf, sourceUrl: "https://example.org/sample" });

describe("infrastructure stages", () => {
  it("has the seven constitution tiers with shelved outside the progression", () => {
    expect(INFRA_STAGES).toEqual(["proposed", "approved", "dpr_approved", "tendered", "under_construction", "operational", "shelved"]);
    expect(stageRank("proposed")).toBe(0);
    expect(stageRank("operational")).toBe(5);
    expect(stageRank("shelved")).toBe(-1);
    expect(isInfraStage("dpr_approved")).toBe(true);
    expect(isInfraStage("planned")).toBe(false);
    expect(INFRA_CATEGORIES).toContain("ring_road");
    expect(INFRA_CATEGORIES).toContain("zoning");
  });

  it.each([
    ["Under construction", "under_construction"],
    ["construction is underway", "under_construction"],
    ["work in progress", "under_construction"],
    ["DPR approved", "dpr_approved"],
    ["detailed project report has been approved", "dpr_approved"],
    ["tenders invited", "tendered"],
    ["contract awarded", "tendered"],
    ["sanctioned by the state cabinet", "approved"],
    ["approved", "approved"],
    ["proposed", "proposed"],
    ["in the pipeline", "proposed"],
    ["opened to the public", "operational"],
    ["inaugurated", "operational"],
    ["put on hold", "shelved"],
    ["cancelled", "shelved"],
  ] as const)("stageFromText(%j) = %j", (text, stage) => {
    expect(stageFromText(text)).toBe(stage);
  });

  it("prefers the most specific phrase and returns null for no phrase", () => {
    expect(stageFromText("proposed in 2019, DPR approved in 2023")).toBe("dpr_approved");
    expect(stageFromText("approved earlier but now shelved")).toBe("shelved");
    expect(stageFromText("coming soon")).toBeNull();
    expect(stageFromText("")).toBeNull();
    expect(stageFromText(null)).toBeNull();
  });

  it.each([
    "has not been approved",
    "yet to be approved",
    "DPR yet to be approved",
    "not under construction",
    "expected to be operational by 2027",
    "will be opened",
    "is likely to be tendered",
    "awaiting approval",
    "approval pending",
    "no tender has been floated",
    "hasn't been sanctioned",
    "isn't approved",
    "hasn't been approved",
    "wasn't sanctioned",
    "isn’t approved",
    "to be completed soon",
  ])("a negated or future phrase states no tier: %j", (text) => {
    expect(stageFromText(text)).toBeNull();
  });

  it("future intent still states 'proposed'; negation does not", () => {
    expect(stageFromText("proposed to be built")).toBe("proposed");
    expect(stageFromText("will be built as planned")).toBe("proposed");
    expect(stageFromText("not proposed")).toBeNull();
  });
});

describe("declared dates", () => {
  it.each([
    ["December 2027", 2027, 12],
    ["Dec 2027", 2027, 12],
    ["2027-06", 2027, 6],
    ["2027", 2027, null],
    ["Q3 2028", 2028, 9],
    ["H1 2029", 2029, 6],
    ["mid-2027", 2027, 6],
    ["end of 2030", 2030, 12],
    ["2026-27", 2027, null],
  ] as const)("parseDeclaredDate(%j)", (text, year, month) => {
    expect(parseDeclaredDate(text)).toMatchObject({ year, month });
  });

  it("returns null without a year and orders by end of period", () => {
    expect(parseDeclaredDate("soon")).toBeNull();
    expect(parseDeclaredDate(null)).toBeNull();
    expect(parseDeclaredDate("2027")!.key).toBe(parseDeclaredDate("December 2027")!.key);
    expect(parseDeclaredDate("June 2027")!.key).toBeLessThan(parseDeclaredDate("2027")!.key);
  });

  it("keeps the research horizon to last year … +10 years", () => {
    const now = new Date("2026-10-24T00:00:00Z");
    expect(withinHorizon("December 2027", now)).toBe(true);
    expect(withinHorizon("2025", now)).toBe(true);
    expect(withinHorizon("2036", now)).toBe(true);
    expect(withinHorizon("2037", now)).toBe(false);
    expect(withinHorizon("2019", now)).toBe(false);
    expect(withinHorizon("2045", now)).toBe(false);
    expect(withinHorizon("soon", now)).toBe(false);
  });
});

describe("slip history", () => {
  it("one declaration: no revisions", () => {
    const s = summarizeSlips([rev("December 2027", "2026-01-01")]);
    expect(s).toMatchObject({ declarations: 1, revisions: 0, slips: 0, netMonths: 0 });
    expect(describeSlips(s)).toBe("No revisions recorded yet (one declaration seen).");
    expect(describeSlips(summarizeSlips([]))).toBe("No declared date recorded yet.");
  });

  it("restating the same date is not a revision", () => {
    const s = summarizeSlips([rev("December 2027", "2026-01-01"), rev("december 2027 ", "2026-06-01")]);
    expect(s.revisions).toBe(0);
    expect(describeSlips(s)).toBe("Declared date unchanged across the declarations we recorded.");
  });

  it("counts slips and net months, sorted by when each was seen (input order ignored)", () => {
    const s = summarizeSlips([rev("June 2029", "2026-06-01"), rev("December 2027", "2024-01-01"), rev("2028", "2025-03-01")]);
    expect(s).toMatchObject({ declarations: 3, revisions: 2, slips: 2, advances: 0, netMonths: 18 });
    expect(s.first!.expectedCompletion).toBe("December 2027");
    expect(s.latest!.expectedCompletion).toBe("June 2029");
    expect(describeSlips(s)).toBe("Declared date revised 2 times (slipped twice, 18 months later than first declared).");
  });

  it("an advance is recorded as brought forward, an unparseable change as unclear", () => {
    const s = summarizeSlips([rev("2030", "2025-01-01"), rev("2029", "2026-01-01")]);
    expect(s).toMatchObject({ revisions: 1, slips: 0, advances: 1, netMonths: -12 });
    expect(describeSlips(s)).toBe("Declared date revised once (brought forward once).");
    expect(classifyChange("2029", "to be announced")).toEqual({ change: "unclear", months: null });
    expect(classifyChange("Q1 2028", "March 2028")).toEqual({ change: "restated", months: 0 });
  });
});

describe("straight-line distance", () => {
  it("formats km with one decimal and short distances in metres", () => {
    expect(formatStraightLine(2340)).toBe("2.3 km straight-line");
    expect(formatStraightLine(1000)).toBe("1.0 km straight-line");
    expect(formatStraightLine(454)).toBe("450 m straight-line");
    expect(formatStraightLine(995)).toBe("1.0 km straight-line"); // never "1000 m"
    expect(formatStraightLine(950)).toBe("1.0 km straight-line");
    expect(formatStraightLine(940)).toBe("940 m straight-line");
    expect(formatStraightLine(2)).toBe("10 m straight-line");
    expect(formatStraightLine(NaN)).toBe("Distance not available");
  });

  const center = { lat: 13.0358, lng: 77.597 };
  const at = (lat: number, lng: number): GeoPoint => ({ lat, lng, precision: "approximate" });
  const items = [
    { name: "SAMPLE Far", location: at(13.2, 77.7), localityIds: ["hebbal"] }, // ~21 km: left out
    { name: "SAMPLE Near", location: at(13.045, 77.597), localityIds: ["yelahanka"] }, // ~1 km
    { name: "SAMPLE Mid", location: at(13.07, 77.6), localityIds: [] }, // ~3.8 km
    { name: "SAMPLE Unmapped B", location: null, localityIds: ["hebbal"] },
    { name: "SAMPLE Unmapped A", location: null, localityIds: ["hebbal"] },
    { name: "SAMPLE Unmapped elsewhere", location: null, localityIds: ["yelahanka"] },
  ];

  it("lists mapped items within the radius nearest first, then unmapped ones for the locality", () => {
    const r = developmentsNear(items, center, "hebbal");
    expect(r.map((x) => x.development.name)).toEqual(["SAMPLE Near", "SAMPLE Mid", "SAMPLE Unmapped A", "SAMPLE Unmapped B"]);
    expect(r[0].distanceMeters).toBeGreaterThan(900);
    expect(r[0].distanceMeters).toBeLessThan(1100);
    expect(r[2].distanceMeters).toBeNull();
    expect(developmentsNear(items, center, null).map((x) => x.development.name)).toEqual(["SAMPLE Near", "SAMPLE Mid"]);
    expect(developmentsNear(items, center, "hebbal", 2000).map((x) => x.development.name)).toEqual(["SAMPLE Near", "SAMPLE Unmapped A", "SAMPLE Unmapped B"]);
  });
});

describe("buyer wording", () => {
  it("attributes dates to the source and never predicts returns", () => {
    expect(expectedLabel("December 2027")).toBe("Expected (declared) December 2027");
    expect(expectedLabel(null)).toBe("Expected date: not yet declared by a source we found");
    expect(PLANNED_DISCLAIMER).toBe("Plans can change, be delayed or be cancelled. Not a prediction of property prices or returns.");
    expect(isPromotionalText("Metro to boost property appreciation")).toBe(true);
    expect(isPromotionalText("Guaranteed returns corridor")).toBe(true);
    expect(isPromotionalText("SAMPLE Hebbal Metro Extension")).toBe(false);
  });
});
