// Pure geospatial helpers. Inputs are WGS84 degrees; polygons use GeoJSON [lng, lat] order.

import { listLocalities, type Locality, type Polygon } from "@/config/markets";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export const EARTH_RADIUS_METERS = 6_371_008.8; // IUGG mean radius

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function inRing(point: LatLng, ring: number[][]): boolean {
  // Ray casting; x = lng, y = lat.
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > point.lat !== yj > point.lat;
    if (crosses && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True when the point is inside the outer ring and not inside any hole. Edges are not guaranteed. */
export function pointInPolygon(point: LatLng, polygon: Polygon): boolean {
  const [outer, ...holes] = polygon.coordinates;
  if (!outer || !inRing(point, outer)) return false;
  return !holes.some((hole) => inRing(point, hole));
}

/** Lat/lng box that fully contains the circle of `radiusMeters` around `center` (no antimeridian handling). */
export function boundingBox(center: LatLng, radiusMeters: number): BoundingBox {
  if (radiusMeters < 0) throw new RangeError("radiusMeters must be >= 0");
  const angular = radiusMeters / EARTH_RADIUS_METERS;
  const dLat = toDeg(angular);
  const cosLat = Math.cos(toRad(center.lat));
  const dLng = cosLat < 1e-12 ? 180 : Math.min(180, toDeg(angular / cosLat));
  return {
    minLat: Math.max(-90, center.lat - dLat),
    maxLat: Math.min(90, center.lat + dLat),
    minLng: Math.max(-180, center.lng - dLng),
    maxLng: Math.min(180, center.lng + dLng),
  };
}

type Located = { location?: LatLng | null; centroid?: LatLng | null };

const defaultPoint = (item: Located): LatLng | null => item.location ?? item.centroid ?? null;

/**
 * Items within `radiusMeters` of `center` (inclusive), nearest first. Items without a point are
 * skipped. Uses `location`, then `centroid`, unless `getPoint` is given.
 */
export function withinRadius<T>(
  items: readonly T[],
  center: LatLng,
  radiusMeters: number,
  getPoint: (item: T) => LatLng | null = defaultPoint as (item: T) => LatLng | null,
): T[] {
  return items
    .map((item) => {
      const p = getPoint(item);
      return { item, d: p ? haversineMeters(center, p) : Number.POSITIVE_INFINITY };
    })
    .filter((x) => x.d <= radiusMeters)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.item);
}

/**
 * Nearest locality centroid to `point`. Defaults to active localities from market config.
 * Centroids are approximate, so treat the result as a hint, not an address resolution.
 */
export function nearestLocality(
  point: LatLng,
  candidates: readonly Locality[] = listLocalities({ activeOnly: true }),
): { locality: Locality; distanceMeters: number } | null {
  let best: { locality: Locality; distanceMeters: number } | null = null;
  for (const locality of candidates) {
    const distanceMeters = haversineMeters(point, locality.centroid);
    if (!best || distanceMeters < best.distanceMeters) best = { locality, distanceMeters };
  }
  return best;
}
