import { describe, expect, it } from "vitest";
import type { Project } from "@/domain/types";
import { createFixtureAdapter } from "./adapters/fixture-adapter";
import { discoverExternal, discoverExternalWithReport, discoverSampleSync, NOT_VERIFIED, type DiscoveryAdapter } from "./index";

const now = new Date("2026-10-01T00:00:00Z");

describe("discoverExternal", () => {
  it("returns deduped, labelled fixture listings in test", async () => {
    const out = await discoverExternal({}, { env: "test", now });
    expect(out).toHaveLength(4);
    expect(out.every((l) => l.isSample && l.lane === "external" && l.limitations.includes(NOT_VERIFIED))).toBe(true);
  });
  it("returns [] in production (no approved non-fixture sources)", async () => {
    const r = await discoverExternalWithReport({}, { env: "production", now });
    expect(r.listings).toEqual([]);
    expect(r.skipped.map((s) => s.sourceId)).toEqual(["sample-feed", "sample-feed-mirror"]);
    expect(discoverSampleSync({}, { env: "production", now })).toEqual([]);
  });
  it("skips adapters for proposed or unknown sources", async () => {
    let called = false;
    const spy: DiscoveryAdapter = { sourceId: "99acres", search: async () => ((called = true), []) };
    const r = await discoverExternalWithReport({}, { env: "development", adapters: [spy, { ...spy, sourceId: "nope" }], now });
    expect(called).toBe(false);
    expect(r.skipped).toHaveLength(2);
  });
  it("isolates a failing adapter", async () => {
    const bad: DiscoveryAdapter = { sourceId: "sample-feed-mirror", search: async () => { throw new Error("boom"); } };
    const r = await discoverExternalWithReport({}, { env: "test", adapters: [createFixtureAdapter("sample-feed"), bad], now });
    expect(r.errors).toEqual([{ sourceId: "sample-feed-mirror", message: "boom" }]);
    expect(r.listings.length).toBe(4);
  });
  it("applies limit, locality and text filters", async () => {
    expect(await discoverExternal({ limit: 2 }, { env: "test", now })).toHaveLength(2);
    expect(await discoverExternal({ limit: 0 }, { env: "test", now })).toHaveLength(0);
    const heb = await discoverExternal({ localityId: "hebbal" }, { env: "test", now });
    expect(heb).toHaveLength(1);
    expect((await discoverExternal({ text: "riverbend" }, { env: "test", now }))[0].title).toContain("Riverbend");
    expect(discoverSampleSync({ limit: 3 }, { env: "development", now })).toHaveLength(3);
  });
  it("drops records with invalid URLs and reports them without failing the batch", async () => {
    const records = [
      { sourceId: "sample-feed", sourceRecordId: "OK", canonicalUrl: "https://example.com/ok", title: "SAMPLE Ok (fictional)" },
      { sourceId: "sample-feed", sourceRecordId: "BAD", canonicalUrl: "http://example.com/bad", title: "SAMPLE Bad (fictional)" },
    ];
    const r = await discoverExternalWithReport({}, { env: "test", adapters: [createFixtureAdapter("sample-feed", records)], now });
    expect(r.listings.map((l) => l.sourceRecordId)).toEqual(["OK"]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/BAD.*https/);
  });
  describe("resolveProjectsByRera hook", () => {
    const fv = <T,>(value: T) => ({ status: "known" as const, value, verification: "unverified" as const, sources: [] });
    const project = {
      id: "sample-project-1", name: "SAMPLE Researched (fictional)", developer: { id: "d", name: "SAMPLE Developer Q", isSample: true },
      reraNumbers: fv(["SAMPLE-RERA-0001"]), address: fv(null), location: { lat: 0, lng: 0, precision: "locality_centroid" },
    } as unknown as Project;

    it("is called once with the batch's RERA numbers and sets matchedProjectId", async () => {
      const calls: string[][] = [];
      const r = await discoverExternalWithReport({}, {
        env: "test", now,
        resolveProjectsByRera: async (nums) => (calls.push(nums), [project]),
      });
      expect(calls).toEqual([["SAMPLE-RERA-0001"]]);
      expect(r.listings.find((l) => l.sourceRecordId === "SAMPLE-001")!.matchedProjectId).toBe("sample-project-1");
      expect(r.listings.filter((l) => l.matchedProjectId)).toHaveLength(1);
    });
    it("isolates hook errors", async () => {
      const r = await discoverExternalWithReport({}, {
        env: "test", now,
        resolveProjectsByRera: async () => { throw new Error("db down"); },
      });
      expect(r.listings).toHaveLength(4);
      expect(r.errors).toEqual([{ sourceId: "resolveProjectsByRera", message: "db down" }]);
    });
  });
});
