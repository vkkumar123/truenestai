import { describe, expect, it } from "vitest";
import { getLocality, listLocalities } from "@/config/markets";
import { getSource } from "@/discovery";
import {
  DEVELOPMENT_SYSTEM_PROMPT,
  buildDevelopmentUserPrompt,
  developmentNameKey,
  developmentQueryKey,
  isDevelopmentQueryKey,
  nearbyLocalityNames,
  researchLocalityDevelopments,
  sampleDevelopmentNames,
  validateDevelopmentCandidates,
} from "./developments";
import { ResearchClientError } from "./client";
import { extractEvidence } from "./evidence";
import { FakeResearchClient, fakeCitedText, fakeResult, fakeSearchResult, fakeText } from "./fake-client";
import { queryKey } from "./query";
import { matchLocality } from "./validate";

const NOW = new Date("2026-10-24T00:00:00Z");
const [LOC] = listLocalities({ activeOnly: true });
const URL_A = "https://example.org/sample-developments/a";
const URL_B = "https://example.org/sample-developments/b";
const CITED_A = `SAMPLE Alpha Metro Line serving ${LOC.name} is under construction by the SAMPLE Metro Authority and is expected to be completed by December 2029. Fictional SAMPLE text.`;

function evidence(cites: { url: string; citedText: string }[], urls = [URL_A, URL_B]) {
  return extractEvidence([fakeSearchResult(urls.map((url) => ({ url, title: "SAMPLE" }))), fakeCitedText("prose", cites)]);
}

const good = {
  name: "SAMPLE Alpha Metro Line",
  category: "metro",
  localityText: LOC.name,
  stageText: "under construction",
  authority: "SAMPLE Metro Authority",
  expectedCompletion: "December 2029",
  sourceUrl: URL_A,
};

const validate = (c: unknown[], ev = evidence([{ url: URL_A, citedText: CITED_A }])) => validateDevelopmentCandidates(c, ev, { now: NOW });

describe("development validator (anti-fabrication)", () => {
  it("keeps a candidate whose name, stage, authority and date are all in the citation", () => {
    const r = validate([good]);
    expect(r.accepted).toEqual([
      {
        name: "SAMPLE Alpha Metro Line",
        category: "metro",
        stage: "under_construction",
        stageText: "under construction",
        authority: "SAMPLE Metro Authority",
        expectedCompletion: "December 2029",
        localityId: LOC.id,
        sourceUrl: URL_A,
      },
    ]);
    expect(r.dropped).toEqual({});
    expect(r.fieldsDropped).toEqual({});
  });

  it("drops an uncited authority and date but keeps the row", () => {
    const r = validate([{ ...good, authority: "SAMPLE Invented Body", expectedCompletion: "2028" }]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]).toMatchObject({ authority: null, expectedCompletion: null });
    expect(r.fieldsDropped).toEqual({ authority: 1, expectedCompletion: 1 });
  });

  it("derives the stage from the cited phrase, never the model's label; no cited stage, no row", () => {
    expect(validate([{ ...good, stageText: "operational" }]).dropped).toEqual({ stage_not_cited: 1 });
    expect(validate([{ ...good, stageText: null }]).dropped).toEqual({ stage_not_cited: 1 });
    expect(validate([{ ...good, stageText: "SAMPLE Metro Authority" }]).dropped).toEqual({ stage_not_cited: 1 }); // cited but states no tier
  });

  it("requires the URL to be a search result and to be cited, and stores the result's own URL", () => {
    expect(validate([{ ...good, sourceUrl: "https://example.org/not-in-results" }]).dropped).toEqual({ url_not_in_results: 1 });
    expect(validate([{ ...good, sourceUrl: URL_B }]).dropped).toEqual({ no_citation: 1 });
    expect(validate([{ ...good, sourceUrl: "http://example.org/sample-developments/a" }]).dropped).toEqual({ url_not_https: 1 });
    const r = validate([{ ...good, sourceUrl: `${URL_A}/` }]);
    expect(r.accepted[0]?.sourceUrl).toBe(URL_A);
  });

  it("ignores citations for URLs that were not search results", () => {
    const ev = extractEvidence([fakeSearchResult([{ url: URL_B, title: "SAMPLE" }]), fakeCitedText("prose", [{ url: URL_A, citedText: CITED_A }])]);
    expect(validate([good], ev).dropped).toEqual({ url_not_in_results: 1 });
  });

  it("drops a name not in the citation, a promotional name and a fact outside the name's window", () => {
    expect(validate([{ ...good, name: "SAMPLE Beta Metro Line" }]).dropped).toEqual({ name_not_cited: 1 });
    const promo = `SAMPLE Appreciation Corridor serving ${LOC.name} is proposed. Fictional.`;
    expect(validate([{ ...good, name: "SAMPLE Appreciation Corridor", stageText: "proposed", authority: null, expectedCompletion: null }], evidence([{ url: URL_A, citedText: promo }])).dropped).toEqual({ promotional: 1 });
    const far = `SAMPLE Alpha Metro Line serving ${LOC.name} is proposed.${" Filler sentence.".repeat(30)} The SAMPLE Metro Authority expects December 2029.`;
    const r = validate([{ ...good, stageText: "proposed" }], evidence([{ url: URL_A, citedText: far }]));
    expect(r.accepted[0]).toMatchObject({ stage: "proposed", authority: null, expectedCompletion: null });
  });

  it("requires a configured locality that the citation names", () => {
    expect(validate([{ ...good, localityText: "SAMPLE Nowhere Town" }]).dropped).toEqual({ out_of_market: 1 });
    const other = listLocalities({ activeOnly: true }).find((l) => !CITED_A.includes(l.name) && typeof matchLocality(l.name) === "object")!;
    expect(validate([{ ...good, localityText: other.name }]).dropped).toEqual({ locality_not_cited: 1 });
  });

  it("keeps the 5–10 year horizon and drops duplicates, malformed items and items over the limit", () => {
    const old = CITED_A.replace("December 2029", "December 2012");
    expect(validate([{ ...good, expectedCompletion: "December 2012" }], evidence([{ url: URL_A, citedText: old }])).dropped).toEqual({ out_of_horizon: 1 });
    expect(validate([good, { ...good, name: "sample  alpha metro LINE" }]).dropped).toEqual({ duplicate: 1 });
    expect(validate([{ name: 4 }, "x", null]).dropped).toEqual({ malformed: 3 });
    expect(validate(Array.from({ length: 12 }, () => good)).dropped).toEqual({ duplicate: 9, over_limit: 2 });
  });

  it("an expected date without a 4-digit year is dropped", () => {
    const cited = CITED_A.replace("December 2029", "soon");
    const r = validate([{ ...good, expectedCompletion: "soon" }], evidence([{ url: URL_A, citedText: cited }]));
    expect(r.accepted[0].expectedCompletion).toBeNull();
    expect(r.fieldsDropped).toEqual({ expectedCompletion: 1 });
  });
});

describe("development research keys and prompt", () => {
  it("queue keys never collide with search-miss keys", () => {
    expect(developmentQueryKey("hebbal")).toBe("dev:hebbal");
    expect(isDevelopmentQueryKey("dev:hebbal")).toBe(true);
    expect(isDevelopmentQueryKey(queryKey("dev hebbal"))).toBe(false);
    expect(queryKey("dev:hebbal")).not.toContain(":");
    expect(developmentNameKey("SAMPLE  Hebbal—Metro (Phase 2)")).toBe("sample hebbal metro phase 2");
  });

  it("names the locality and horizon, asks for verbatim facts and forbids return predictions", () => {
    const p = buildDevelopmentUserPrompt({ localityName: "Heb<bal>", nearbyNames: ["Yelahanka"], now: NOW });
    expect(p).toContain("<locality>Heb bal </locality>");
    expect(p).toContain("between 2026 and 2036");
    expect(p).toContain("within about 5 km");
    expect(p).toContain("verbatim");
    expect(DEVELOPMENT_SYSTEM_PROMPT).toMatch(/Never predict or comment on property prices/);
  });

  it("nearby localities come from the market config", () => {
    const hebbal = getLocality("hebbal");
    expect(hebbal).toBeTruthy();
    const names = nearbyLocalityNames("hebbal");
    expect(names).not.toContain(hebbal!.name);
    expect(nearbyLocalityNames("not-a-locality")).toEqual([]);
  });
});

describe("researchLocalityDevelopments with the fake client (network-free)", () => {
  const source = getSource("sample-web-research")!;

  it("keeps the cited SAMPLE metro, keeps the road without uncited fields, drops the fabricated item", async () => {
    const client = new FakeResearchClient();
    const r = await researchLocalityDevelopments("hebbal", { client, source, env: "test", now: NOW });
    const n = sampleDevelopmentNames("Hebbal");
    expect(r.developments.map((d) => d.name)).toEqual([n.metro, n.road]);
    expect(r.developments[0]).toMatchObject({ stage: "under_construction", authority: "SAMPLE Metro Authority", expectedCompletion: "December 2029", localityId: "hebbal" });
    expect(r.developments[0].sourceUrl).toMatch(/^https:\/\/example\.org\/sample-developments\//);
    expect(r.developments[1]).toMatchObject({ stage: "proposed", authority: null, expectedCompletion: null });
    expect(r.validation).toMatchObject({ received: 3, accepted: 2, dropped: { url_not_in_results: 1 }, fieldsDropped: { authority: 1, expectedCompletion: 1 } });
    expect(client.developmentCalls).toHaveLength(1);
    expect(client.developmentCalls[0].localityName).toBe("Hebbal");
  });

  it("refuses an inactive or unknown locality, a refusal, and candidates with no search results", async () => {
    const client = new FakeResearchClient();
    await expect(researchLocalityDevelopments("nope", { client, source, env: "test", now: NOW })).rejects.toMatchObject({ code: "bad_request" });
    const refusing = new FakeResearchClient(undefined, () => fakeResult([fakeText("no")], "refusal"));
    await expect(researchLocalityDevelopments("hebbal", { client: refusing, source, env: "test", now: NOW })).rejects.toMatchObject({ code: "refusal" });
    const noSearch = new FakeResearchClient(undefined, () => fakeResult([fakeText('```json\n[{"name":"SAMPLE X","sourceUrl":"https://example.org/x"}]\n```')]));
    await expect(researchLocalityDevelopments("hebbal", { client: noSearch, source, env: "test", now: NOW })).rejects.toBeInstanceOf(ResearchClientError);
  });

  it("the fixture source never runs in production", async () => {
    await expect(researchLocalityDevelopments("hebbal", { client: new FakeResearchClient(), source, env: "production", now: NOW })).rejects.toMatchObject({
      code: "source_not_runnable",
    });
  });
});
