import { describe, expect, it } from "vitest";
import { pointInPolygon } from "@/locality/geo";
import {
  findLocalitiesByText,
  getActiveMarketPhases,
  getLocality,
  getZone,
  isActiveLocality,
  listLocalities,
  listMarketPhases,
  listZones,
  validateMarketConfig,
  type MarketConfig,
} from "./index";
import { MARKET_CONFIG } from "./data";

const clone = (): MarketConfig => structuredClone(MARKET_CONFIG);

describe("market config validation", () => {
  it("bundled config is valid", () => {
    expect(() => validateMarketConfig(MARKET_CONFIG)).not.toThrow();
  });

  it("rejects duplicate locality ids", () => {
    const c = clone();
    c.localities.push({ ...c.localities[0] });
    expect(() => validateMarketConfig(c)).toThrow(/duplicate locality id: hebbal/);
  });

  it("rejects a locality with an unknown zone", () => {
    const c = clone();
    c.localities[0].zoneId = "nowhere";
    expect(() => validateMarketConfig(c)).toThrow(/unknown zone nowhere/);
  });

  it("rejects a zone with an unknown phase", () => {
    const c = clone();
    c.zones[0].phaseId = "nowhere";
    expect(() => validateMarketConfig(c)).toThrow(/unknown phase nowhere/);
  });

  it("rejects non-kebab ids, unclosed rings and wrong centroid precision", () => {
    const a = clone();
    a.localities[0].id = "Hebbal Area";
    expect(() => validateMarketConfig(a)).toThrow();
    const b = clone();
    b.zones[0].boundary.coordinates[0].pop();
    expect(() => validateMarketConfig(b)).toThrow();
    const c = clone() as unknown as { localities: Array<{ centroid: { precision: string } }> };
    c.localities[0].centroid.precision = "exact";
    expect(() => validateMarketConfig(c)).toThrow();
  });

  it("rejects localities attached to an inactive phase", () => {
    const c = clone();
    c.zones.push({ ...c.zones[0], id: "east-zone", phaseId: "east-bengaluru" });
    c.localities[0].zoneId = "east-zone";
    expect(() => validateMarketConfig(c)).toThrow(/inactive phase east-bengaluru/);
  });
});

describe("market phases and zones", () => {
  it("only North Bengaluru is active; three more phases are inactive", () => {
    expect(getActiveMarketPhases().map((p) => p.id)).toEqual(["north-bengaluru"]);
    const inactive = listMarketPhases().filter((p) => !p.active);
    expect(inactive).toHaveLength(3);
    for (const p of inactive) expect(listLocalities({ phaseId: p.id })).toEqual([]);
  });

  it("north zone exists and is pending owner approval", () => {
    const zone = getZone("north-bengaluru");
    expect(zone?.phaseId).toBe("north-bengaluru");
    expect(zone?.boundaryApproval).toBe("pending_owner_approval");
    expect(zone?.assumptions.some((a) => /verification/i.test(a))).toBe(true);
    expect(listZones()).toHaveLength(1);
    expect(getZone("missing")).toBeUndefined();
  });
});

describe("localities", () => {
  const required = ["hebbal", "yelahanka", "devanahalli", "thanisandra", "hennur", "jakkur"];

  it("contains the ids other modules depend on", () => {
    for (const id of required) {
      expect(getLocality(id)?.id).toBe(id);
      expect(isActiveLocality(id)).toBe(true);
    }
  });

  it("has a broad list, all active, with unchecked coverage and centroid precision", () => {
    const all = listLocalities();
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(listLocalities({ activeOnly: true })).toHaveLength(all.length);
    expect(listLocalities({ zoneId: "north-bengaluru" })).toHaveLength(all.length);
    for (const l of all) {
      expect(l.centroid.precision).toBe("locality_centroid");
      expect(l.dataCoverage).toEqual({ sourceIds: [], completeness: 0, lastCheckedAt: null });
    }
  });

  it("every centroid lies inside its zone boundary", () => {
    for (const l of listLocalities()) {
      const zone = getZone(l.zoneId)!;
      expect(pointInPolygon(l.centroid, zone.boundary), l.id).toBe(true);
    }
  });

  it("unknown ids are not active", () => {
    expect(getLocality("koramangala")).toBeUndefined();
    expect(isActiveLocality("koramangala")).toBe(false);
  });
});

describe("findLocalitiesByText", () => {
  it("matches names case-insensitively, exact first", () => {
    const res = findLocalitiesByText("HEBBAL");
    expect(res[0].id).toBe("hebbal");
    expect(res.map((l) => l.id)).toContain("hebbal-kempapura");
  });

  it("matches aliases and partial input", () => {
    expect(findLocalitiesByText("Nagavara")[0].id).toBe("nagawara");
    expect(findLocalitiesByText("bial")[0].id).toBe("kia-airport-area");
    expect(findLocalitiesByText("thani").map((l) => l.id)).toEqual(["thanisandra"]);
  });

  it("finds a locality mentioned inside free text", () => {
    expect(findLocalitiesByText("2 BHK near Jakkur, under 1 cr").map((l) => l.id)).toContain("jakkur");
  });

  it("returns nothing for unrelated or too-short text", () => {
    expect(findLocalitiesByText("koramangala")).toEqual([]);
    expect(findLocalitiesByText("a")).toEqual([]);
    expect(findLocalitiesByText("   ")).toEqual([]);
  });
});
