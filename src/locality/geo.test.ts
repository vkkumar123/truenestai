import { describe, expect, it } from "vitest";
import { getLocality, type Polygon } from "@/config/markets";
import { boundingBox, haversineMeters, nearestLocality, pointInPolygon, withinRadius } from "./geo";

describe("haversineMeters", () => {
  it("is zero for the same point", () => {
    expect(haversineMeters({ lat: 13, lng: 77.6 }, { lat: 13, lng: 77.6 })).toBe(0);
  });

  it("one degree of latitude is ~111.2 km", () => {
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -1);
  });

  it("London to Paris is ~343.5 km", () => {
    const d = haversineMeters({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 });
    expect(Math.abs(d - 343_500)).toBeLessThan(1_500);
  });

  it("is symmetric", () => {
    const a = { lat: 13.0358, lng: 77.597 };
    const b = { lat: 13.2473, lng: 77.7119 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe("pointInPolygon", () => {
  const square: Polygon = {
    type: "Polygon",
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
      [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]], // hole
    ],
  };

  it("detects inside, outside and holes", () => {
    expect(pointInPolygon({ lat: 2, lng: 2 }, square)).toBe(true);
    expect(pointInPolygon({ lat: 11, lng: 2 }, square)).toBe(false);
    expect(pointInPolygon({ lat: 5, lng: -1 }, square)).toBe(false);
    expect(pointInPolygon({ lat: 5, lng: 5 }, square)).toBe(false);
  });

  it("handles concave shapes", () => {
    const l: Polygon = {
      type: "Polygon",
      coordinates: [[[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4], [0, 0]]],
    };
    expect(pointInPolygon({ lat: 0.5, lng: 3 }, l)).toBe(true);
    expect(pointInPolygon({ lat: 3, lng: 3 }, l)).toBe(false);
  });
});

describe("boundingBox", () => {
  it("contains the circle and is roughly radius-sized", () => {
    const c = { lat: 13.0358, lng: 77.597 };
    const bb = boundingBox(c, 5_000);
    expect(haversineMeters(c, { lat: bb.maxLat, lng: c.lng })).toBeCloseTo(5_000, -1);
    expect(haversineMeters(c, { lat: c.lat, lng: bb.maxLng })).toBeGreaterThanOrEqual(4_999);
    expect(bb.minLat).toBeLessThan(c.lat);
    expect(bb.minLng).toBeLessThan(c.lng);
  });

  it("rejects negative radius", () => {
    expect(() => boundingBox({ lat: 0, lng: 0 }, -1)).toThrow(RangeError);
  });
});

describe("withinRadius", () => {
  const center = { lat: 13.0358, lng: 77.597 };
  const items = [
    { id: "far", location: { lat: 13.2473, lng: 77.7119 } },
    { id: "near", location: { lat: 13.04, lng: 77.6 } },
    { id: "none", location: null },
    { id: "centroid", centroid: { lat: 13.036, lng: 77.597 } },
  ];

  it("filters by distance, nearest first, skipping items without a point", () => {
    expect(withinRadius(items, center, 2_000).map((i) => i.id)).toEqual(["centroid", "near"]);
    expect(withinRadius(items, center, 50_000).map((i) => i.id)).toEqual(["centroid", "near", "far"]);
  });

  it("accepts a custom point accessor", () => {
    const pts = [{ p: { lat: 13.0358, lng: 77.597 } }];
    expect(withinRadius(pts, center, 0, (x) => x.p)).toHaveLength(1);
  });
});

describe("nearestLocality", () => {
  it("returns the configured locality for its own centroid", () => {
    const hebbal = getLocality("hebbal")!;
    const res = nearestLocality(hebbal.centroid);
    expect(res?.locality.id).toBe("hebbal");
    expect(res?.distanceMeters).toBe(0);
  });

  it("finds Devanahalli for a point near the town", () => {
    expect(nearestLocality({ lat: 13.25, lng: 77.715 })?.locality.id).toBe("devanahalli");
  });

  it("returns null with no candidates", () => {
    expect(nearestLocality({ lat: 0, lng: 0 }, [])).toBeNull();
  });
});
