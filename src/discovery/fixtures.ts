// Obviously fictional Lane B fixtures. Not real properties, developers, URLs or RERA numbers.
// localityIds are ids defined by src/config/markets (North Bengaluru); listed here only as fixture data.
import type { RawExternalRecord } from "./adapter";

export const SAMPLE_RECORDS: readonly RawExternalRecord[] = [
  {
    // A1: same project as A2 (different source, same canonical URL) -> must merge.
    sourceId: "sample-feed",
    sourceRecordId: "SAMPLE-001",
    canonicalUrl: "https://example.com/sample/lakeview-residences",
    title: "SAMPLE Lakeview Residences (fictional)",
    developerName: "SAMPLE Developer A",
    localityId: "hebbal",
    address: "SAMPLE Road 1, Hebbal (fictional)",
    location: { lat: 13.0358, lng: 77.597, precision: "approximate" },
    reraNumber: "SAMPLE-RERA-0001",
    priceText: "₹ SAMPLE",
  },
  {
    // A2: mirror of A1; URL differs only by www/case/trailing slash/tracking params.
    sourceId: "sample-feed-mirror",
    sourceRecordId: "SAMPLE-001",
    canonicalUrl: "https://WWW.example.com/sample/lakeview-residences/?utm_source=sample#top",
    title: "SAMPLE Lakeview Residences (fictional)",
    developerName: "SAMPLE Developer A",
    localityId: "hebbal",
    priceText: "₹ SAMPLE",
  },
  {
    // B: near-identical name to A but different developer and locality -> must NOT merge.
    sourceId: "sample-feed",
    sourceRecordId: "SAMPLE-002",
    canonicalUrl: "https://example.com/sample/lakeview-residency",
    title: "SAMPLE Lakeview Residency (fictional)",
    developerName: "SAMPLE Developer B",
    localityId: "yelahanka",
    address: "SAMPLE Avenue 2, Yelahanka (fictional)",
    location: { lat: 13.1007, lng: 77.5963, precision: "approximate" },
    priceText: "₹ SAMPLE",
  },
  {
    // C1: merges with C2 by same developer + coordinates within 150 m.
    sourceId: "sample-feed",
    sourceRecordId: "SAMPLE-003",
    canonicalUrl: "https://example.com/sample/orchard-greens",
    title: "SAMPLE Orchard Greens (fictional)",
    developerName: "SAMPLE Developer C Pvt Ltd",
    localityId: "devanahalli",
    address: "SAMPLE Lane 3, Devanahalli (fictional)",
    location: { lat: 13.2473, lng: 77.7119, precision: "exact" },
    priceText: "₹ SAMPLE",
  },
  {
    sourceId: "sample-feed-mirror",
    sourceRecordId: "SAMPLE-MIRROR-003",
    canonicalUrl: "https://example.org/sample/orchard-greens-tower-b",
    title: "SAMPLE Orchard Greens Tower B (fictional)",
    developerName: "SAMPLE Developer C",
    localityId: "devanahalli",
    location: { lat: 13.2478, lng: 77.7123, precision: "exact" },
    priceText: "₹ SAMPLE",
  },
  {
    sourceId: "sample-feed",
    sourceRecordId: "SAMPLE-004",
    canonicalUrl: "https://example.com/sample/riverbend-homes",
    title: "SAMPLE Riverbend Homes (fictional)",
    developerName: "SAMPLE Developer D",
    localityId: "thanisandra",
    address: "SAMPLE Street 4, Thanisandra (fictional)",
    location: { lat: 13.0569, lng: 77.6331, precision: "approximate" },
    priceText: "₹ SAMPLE",
  },
];
