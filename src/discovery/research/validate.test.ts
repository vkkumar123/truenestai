import { describe, expect, it } from "vitest";
import { listLocalities } from "@/config/markets";
import { extractEvidence, parseCandidates } from "./evidence";
import { fakeCitedText, fakeSearchResult, fakeText } from "./fake-client";
import { isBlockedPortalUrl } from "./portals";
import { queryKey } from "./query";
import { citedPrice, citedRera, matchLocality, validateCandidates } from "./validate";

const [LOC, LOC2] = listLocalities({ activeOnly: true });
const URL_A = "https://example.com/sample/a";
const URL_B = "https://example.org/sample/b";
const CITED_A = `SAMPLE Alpha Homes by SAMPLE Builder Co is in ${LOC.name}. RERA No. PRM/KA/RERA/1251/309/PR/000001. Price ₹ 95 Lakh onwards. Address: 1 SAMPLE Street, ${LOC.name}.`;

function evidence(cites: { url: string; citedText: string }[], urls = [URL_A, URL_B]) {
  return extractEvidence([fakeSearchResult(urls.map((url) => ({ url, title: "SAMPLE" }))), fakeCitedText("prose", cites)]);
}

const good = {
  name: "SAMPLE Alpha Homes",
  developerName: "SAMPLE Builder Co",
  localityText: LOC.name,
  address: `1 SAMPLE Street, ${LOC.name}`,
  reraNumbers: ["PRM/KA/RERA/1251/309/PR/000001"],
  priceText: "₹ 95 Lakh onwards",
  constructionStatus: "Under construction",
  sourceUrl: URL_A,
  quote: "whatever the model says",
};

describe("research validator (anti-fabrication)", () => {
  it("keeps a candidate whose every field is in the API's citation for a search-result URL", () => {
    const r = validateCandidates([good], evidence([{ url: URL_A, citedText: CITED_A }]));
    expect(r.accepted).toHaveLength(1);
    const a = r.accepted[0];
    expect(a).toMatchObject({
      title: "SAMPLE Alpha Homes",
      developerName: "SAMPLE Builder Co",
      localityId: LOC.id,
      priceText: "₹ 95 Lakh onwards",
      reraNumber: "PRM/KA/RERA/1251/309/PR/000001",
      canonicalUrl: URL_A,
    });
    expect(r.fieldsDropped).toEqual({});
  });

  it("drops a fabricated RERA number and price that no citation contains", () => {
    const r = validateCandidates(
      [{ ...good, reraNumbers: ["PRM/KA/RERA/1251/309/PR/999999"], priceText: "₹ 49 Lakh" }],
      evidence([{ url: URL_A, citedText: CITED_A }]),
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].reraNumber).toBeNull();
    expect(r.accepted[0].reraNumbers).toEqual([]);
    expect(r.accepted[0].priceText).toBeNull();
    expect(r.fieldsDropped).toEqual({ reraNumbers: 1, priceText: 1 });
  });

  it("ignores the model's own quote: a value only in `quote` is still dropped", () => {
    const r = validateCandidates(
      [{ ...good, developerName: "SAMPLE Invented Developer", quote: "SAMPLE Invented Developer" }],
      evidence([{ url: URL_A, citedText: CITED_A }]),
    );
    expect(r.accepted[0].developerName).toBeNull();
  });

  it("drops a URL that was not in this response's web search results", () => {
    const fabricated = "https://example.com/sample/never-returned";
    const r = validateCandidates([{ ...good, sourceUrl: fabricated }], evidence([{ url: fabricated, citedText: CITED_A }]));
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped).toEqual({ url_not_in_results: 1 });
  });

  it("drops a search-result URL with no citation, and citations pointing elsewhere do not count", () => {
    const r = validateCandidates([good], evidence([{ url: URL_B, citedText: CITED_A }]));
    expect(r.dropped).toEqual({ no_citation: 1 });
  });

  it("drops non-https URLs", () => {
    const http = "http://example.com/sample/a";
    const r = validateCandidates([{ ...good, sourceUrl: http }], evidence([{ url: http, citedText: CITED_A }], [http]));
    expect(r.dropped).toEqual({ url_not_https: 1 });
  });

  it("drops candidates whose name is not cited", () => {
    const r = validateCandidates([{ ...good, name: "SAMPLE Beta Towers" }], evidence([{ url: URL_A, citedText: CITED_A }]));
    expect(r.dropped).toEqual({ name_not_cited: 1 });
  });

  it("drops an out-of-market locality", () => {
    const cited = "SAMPLE Faraway Homes is a project in Mysuru.";
    const r = validateCandidates(
      [{ ...good, name: "SAMPLE Faraway Homes", localityText: "Mysuru", address: null }],
      evidence([{ url: URL_A, citedText: cited }]),
    );
    expect(r.dropped).toEqual({ out_of_market: 1 });
  });

  it("drops a configured locality the citation does not mention", () => {
    const cited = "SAMPLE Alpha Homes by SAMPLE Builder Co.";
    const r = validateCandidates([good], evidence([{ url: URL_A, citedText: cited }]));
    expect(r.dropped).toEqual({ locality_not_cited: 1 });
  });

  it("drops an ambiguous locality (two configured localities in one locality text)", () => {
    const text = `${LOC.name} and ${LOC2.name}`;
    const r = validateCandidates([{ ...good, localityText: text, address: null }], evidence([{ url: URL_A, citedText: `${CITED_A} ${LOC2.name}` }]));
    expect(r.dropped).toEqual({ ambiguous_locality: 1 });
  });

  it("drops listing-portal hosts (and subdomains) even when cited", () => {
    for (const host of ["www.99acres.com", "magicbricks.com", "housing.com", "www.nobroker.in", "commonfloor.com", "squareyards.com", "www.makaan.com"]) {
      const url = `https://${host}/sample-listing`;
      const r = validateCandidates([{ ...good, sourceUrl: url }], evidence([{ url, citedText: CITED_A }], [url]));
      expect(r.dropped, host).toEqual({ portal_host: 1 });
    }
    expect(isBlockedPortalUrl("https://notmagicbricks.com.example.com/x")).toBe(false);
    expect(isBlockedPortalUrl("https://bengaluru.housing.com/x")).toBe(true);
  });

  it("drops malformed items and caps the candidate count", () => {
    const many = Array.from({ length: 10 }, () => good);
    const r = validateCandidates([42, { name: "x" }, ...many], evidence([{ url: URL_A, citedText: CITED_A }]));
    expect(r.dropped.malformed).toBe(2);
    expect(r.dropped.over_limit).toBe(4);
    expect(r.accepted).toHaveLength(1); // same URL + same name → one record
  });

  it("drops every candidate when one page names different projects", () => {
    const cited = `${CITED_A} SAMPLE Gamma Villas in ${LOC.name}.`;
    const r = validateCandidates([good, { ...good, name: "SAMPLE Gamma Villas" }], evidence([{ url: URL_A, citedText: cited }]));
    expect(r.accepted).toHaveLength(0);
    expect(r.dropped).toEqual({ shared_url: 2 });
  });

  it("field matchers are strict", () => {
    expect(citedRera("PRM KA RERA 1251 309 PR 000001", CITED_A)).toBe(true);
    expect(citedRera("1251", CITED_A)).toBe(false); // too short to be meaningful
    expect(citedPrice("₹95 lakh onwards", CITED_A)).toBe(true);
    expect(citedPrice("onwards", CITED_A)).toBe(false); // no digit
    expect(matchLocality("Mysuru")).toBe("none");
    expect(matchLocality(`near ${LOC.name}`)).toMatchObject({ locality: { id: LOC.id } });
  });
});

describe("evidence extraction", () => {
  it("collects result URLs, web citations and the JSON answer; error results do not add URLs", () => {
    const ev = extractEvidence([
      fakeSearchResult([{ url: URL_A, title: "A" }]),
      { type: "web_search_tool_result", tool_use_id: "x", content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" } },
      fakeCitedText("Alpha.", [{ url: URL_A, citedText: "SAMPLE Alpha" }]),
      fakeText('\n```json\n[{"name":"SAMPLE Alpha"}]\n```'),
    ]);
    expect(ev.searchResultUrls).toEqual([URL_A]);
    expect(ev.citations).toEqual([{ url: URL_A, citedText: "SAMPLE Alpha" }]);
    expect(ev.searchErrors).toBe(1);
    expect(parseCandidates(ev.text)).toEqual([{ name: "SAMPLE Alpha" }]);
  });
  it("parseCandidates throws when there is no array", () => {
    expect(() => parseCandidates("no json here")).toThrow(/JSON array/);
    expect(parseCandidates("text\n[]")).toEqual([]);
  });
});

describe("queryKey", () => {
  it("normalises case, punctuation, order and duplicates", () => {
    expect(queryKey("2BHK  Hebbal!")).toBe(queryKey("hebbal, 2bhk 2BHK"));
    expect(queryKey("ab")).toBe("");
    expect(queryKey("Hebbal", "hebbal")).toBe("hebbal @hebbal");
  });
});
