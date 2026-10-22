import { describe, expect, it } from "vitest";
import { NOT_VERIFIED } from "../adapter";
import { RESEARCH_LIMITATION, getSource } from "../registry";
import { ResearchClientError, type ResearchClient } from "./client";
import { FakeResearchClient, fakeResult, fakeText } from "./fake-client";
import { researchQuery } from "./run";

const FIXTURE = getSource("sample-web-research")!;
const REAL = getSource("anthropic-web-search")!;
const base = { localityNames: ["SAMPLE"], now: new Date("2026-10-22T00:00:00Z") };

describe("researchQuery registry gate", () => {
  it("refuses the real source while it is proposed, without calling the client", async () => {
    const client = new FakeResearchClient();
    const proposed = { ...REAL, status: "proposed" as const };
    for (const env of ["test", "development", "production"] as const) {
      await expect(researchQuery("hebbal apartments", { ...base, client, source: proposed, env })).rejects.toMatchObject({
        code: "source_not_runnable",
      });
    }
    expect(client.calls).toHaveLength(0);
  });
  it("refuses an approved source outside its environments", async () => {
    const client = new FakeResearchClient();
    const approved = { ...REAL, status: "approved" as const, termsReviewedAt: "2026-10-22", allowedEnvironments: ["production" as const] };
    await expect(researchQuery("hebbal", { ...base, client, source: approved, env: "test" })).rejects.toBeInstanceOf(ResearchClientError);
    expect(client.calls).toHaveLength(0);
  });
  it("refuses a fixture source paired with a non-fake client", async () => {
    const client: ResearchClient = { kind: "anthropic", research: async () => fakeResult([]) };
    await expect(researchQuery("hebbal", { ...base, client, source: FIXTURE, env: "test" })).rejects.toMatchObject({ code: "source_not_runnable" });
  });
});

describe("researchQuery with the fake client", () => {
  it("returns unverified SAMPLE Lane B listings with research limitations; fabricated RERA dropped", async () => {
    const r = await researchQuery("apartments", { ...base, client: new FakeResearchClient(), source: FIXTURE, env: "test" });
    expect(r.listings).toHaveLength(1);
    const l = r.listings[0];
    expect(l.lane).toBe("external");
    expect(l.sourceId).toBe("sample-web-research");
    expect(l.isSample).toBe(true);
    expect(l.canonicalUrl).toMatch(/^https:\/\/example\.com\//);
    expect(l.limitations[0]).toBe(NOT_VERIFIED);
    expect(l.limitations).toContain(RESEARCH_LIMITATION);
    expect(l.discoveredAt).toBe("2026-10-22T00:00:00.000Z");
    expect(l.matchedProjectId).toBeNull();
    expect(r.validation.fieldsDropped).toEqual({ reraNumbers: 1 });
  });
  it("links to a researched project only via a cited RERA number", async () => {
    const project = {
      id: "sample-proj-x",
      developer: { id: "d", name: "SAMPLE Other Developer", isSample: true },
      address: { status: "unknown", value: null, verification: "unverified", sources: [] },
      location: { lat: 13, lng: 77.6, precision: "approximate" },
      name: "SAMPLE Completely Different Name",
      reraNumbers: { status: "known", value: ["SAMPLE/RERA/0001/2026"], verification: "unverified", sources: [] },
    };
    const r = await researchQuery("apartments", {
      ...base,
      client: new FakeResearchClient(),
      source: FIXTURE,
      env: "test",
      resolveProjectsByRera: async (nums) => {
        expect(nums).toEqual(["SAMPLE/RERA/0001/2026"]);
        return [project as never];
      },
    });
    expect(r.listings[0].matchedProjectId).toBe("sample-proj-x");
  });
  it("maps refusal, max_tokens and unparseable output to short error codes", async () => {
    const run = (stop: string, text = "[]") =>
      researchQuery("x query", { ...base, client: new FakeResearchClient(() => fakeResult([fakeText(text)], stop)), source: FIXTURE, env: "test" });
    await expect(run("refusal")).rejects.toMatchObject({ code: "refusal", retryable: false });
    await expect(run("max_tokens")).rejects.toMatchObject({ code: "max_tokens", retryable: false });
    await expect(run("end_turn", "no json")).rejects.toMatchObject({ code: "parse_error", retryable: true });
    await expect(run("end_turn", "[]")).resolves.toMatchObject({ listings: [] });
  });
});
