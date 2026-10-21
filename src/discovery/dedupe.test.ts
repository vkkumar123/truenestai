import { describe, expect, it } from "vitest";
import type { Project } from "@/domain/types";
import { normalizeRecord, type RawExternalRecord } from "./adapter";
import { dedupe, distanceMeters, normaliseUrl } from "./dedupe";
import { SAMPLE_RECORDS } from "./fixtures";
import { getSource } from "./registry";

const now = new Date("2026-10-01T00:00:00Z");
const norm = (r: RawExternalRecord) => normalizeRecord(r, getSource(r.sourceId)!, now);
const all = SAMPLE_RECORDS.map(norm);
const clusterOf = (res: ReturnType<typeof dedupe>, id: string) => res.clusters.find((c) => c.memberIds.includes(id))!;

describe("dedupe", () => {
  const res = dedupe(all);

  it("normalises canonical URLs", () => {
    expect(normaliseUrl("https://WWW.example.com/a/?utm_source=x#h")).toBe(normaliseUrl("http://example.com/a"));
  });
  it("merges same project across sources by canonical URL", () => {
    const c = clusterOf(res, "sample-feed:SAMPLE-001");
    expect(c.memberIds).toContain("sample-feed-mirror:SAMPLE-001");
    expect(c.reasons).toContain("canonical_url");
  });
  it("merges by same developer + coordinates within 150 m", () => {
    const c = clusterOf(res, "sample-feed:SAMPLE-003");
    expect(c.memberIds).toContain("sample-feed-mirror:SAMPLE-MIRROR-003");
    expect(c.reasons).toContain("developer_coordinates");
  });
  it("does not merge near-identical names with different developer/location; flags for review", () => {
    expect(clusterOf(res, "sample-feed:SAMPLE-002").memberIds).toEqual(["sample-feed:SAMPLE-002"]);
    expect(res.reviewFlags).toContainEqual({ kind: "possible_duplicate", reason: "similar_name_only", ids: ["sample-feed:SAMPLE-001", "sample-feed:SAMPLE-002"] });
    expect(res.clusters).toHaveLength(4);
  });
  it("merges by RERA number and by source+sourceRecordId", () => {
    const base = SAMPLE_RECORDS[0];
    const rera = norm({ ...base, sourceRecordId: "OTHER", canonicalUrl: "https://example.com/other", reraNumber: "sample rera 0001" });
    expect(dedupe([all[0], rera]).clusters[0].reasons).toEqual(["rera_number"]);
    const sameId = norm({ ...base, canonicalUrl: "https://example.com/moved", reraNumber: null });
    expect(dedupe([all[0], sameId]).clusters[0].reasons).toEqual(["source_record_id"]);
  });
  it("same developer but far apart and different address does not merge", () => {
    const far = norm({ ...SAMPLE_RECORDS[3], sourceRecordId: "FAR", canonicalUrl: "https://example.com/far", address: "SAMPLE elsewhere", location: { lat: 13.26, lng: 77.73, precision: "exact" } });
    expect(distanceMeters(all[3].listing.location!, far.listing.location!)).toBeGreaterThan(150);
    expect(dedupe([all[3], far]).clusters).toHaveLength(2);
  });
  it("conflicting RERA numbers block a strong-key merge and are flagged", () => {
    const conflict = norm({ ...SAMPLE_RECORDS[0], reraNumber: "SAMPLE-RERA-9999" });
    const r = dedupe([all[0], conflict]);
    expect(r.clusters).toHaveLength(2);
    expect(r.reviewFlags[0].reason).toBe("conflicting_rera");
  });
  it("matches researched projects only by RERA; name-only similarity is flagged", () => {
    const fv = <T,>(value: T) => ({ status: "known" as const, value, verification: "unverified" as const, sources: [] });
    const project = {
      id: "sample-project-1", name: "SAMPLE Lakeview Residences (fictional)", developer: { id: "d", name: "SAMPLE Developer A", isSample: true },
      reraNumbers: fv(["SAMPLE-RERA-0001"]), address: fv("SAMPLE Road 1, Hebbal (fictional)"), location: { lat: 13.0358, lng: 77.597, precision: "approximate" },
    } as unknown as Project;
    const r = dedupe(all, [project]);
    expect(clusterOf(r, "sample-feed:SAMPLE-001").listing.matchedProjectId).toBe("sample-project-1");
    expect(clusterOf(r, "sample-feed:SAMPLE-002").listing.matchedProjectId).toBeNull();
    expect(r.reviewFlags).toContainEqual({ kind: "possible_duplicate", reason: "similar_name_only", ids: ["sample-feed:SAMPLE-002", "sample-project-1"] });
  });
});
