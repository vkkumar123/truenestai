// Network-free research client for fixture mode, unit tests and CI. Builds a response shaped like
// the Messages API (web_search_tool_result blocks + cited text blocks + a JSON answer) over
// obviously fictional SAMPLE pages on example.com.
import { findLocalitiesByText, isActiveLocality, listLocalities } from "@/config/markets";
import type { ResearchClient, ResearchClientResult, ResearchContentBlock, ResearchRequest } from "./client";
import { queryKey } from "./query";
import { sampleDevelopmentResponder, type DevelopmentResearchClient, type DevelopmentResearchRequest } from "./developments";

export type FakeResponder = (req: ResearchRequest) => ResearchClientResult | Promise<ResearchClientResult>;

export function fakeSearchResult(urls: { url: string; title: string }[]): ResearchContentBlock {
  return {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_SAMPLE",
    content: urls.map((u) => ({ type: "web_search_result", url: u.url, title: u.title, encrypted_content: "SAMPLE", page_age: null })),
  };
}

export function fakeCitedText(text: string, cites: { url: string; citedText: string }[]): ResearchContentBlock {
  return {
    type: "text",
    text,
    citations: cites.map((c) => ({
      type: "web_search_result_location",
      url: c.url,
      cited_text: c.citedText,
      title: "SAMPLE page",
      encrypted_index: "SAMPLE",
    })),
  };
}

export function fakeText(text: string): ResearchContentBlock {
  return { type: "text", text, citations: null };
}

export function fakeResult(content: ResearchContentBlock[], stopReason = "end_turn"): ResearchClientResult {
  return { content, stopReason, usage: { inputTokens: 1000, outputTokens: 200, webSearchRequests: 1 }, model: "fake-research-model" };
}

/**
 * Default fixture behaviour: one SAMPLE project per query, in the locality the query names (else
 * the first active configured locality), with every stored fact present in a citation, plus one
 * fabricated claim (a RERA number and price that no citation contains) that the validator drops.
 * A query containing "nothing" returns no candidates (exercises the no_results path).
 */
export const sampleResponder: FakeResponder = (req) => {
  if (/\bnothing\b/i.test(req.queryText)) return fakeResult([fakeSearchResult([]), fakeText("I found no matching projects.\n```json\n[]\n```")]);
  const active = listLocalities({ activeOnly: true });
  const loc = findLocalitiesByText(req.localityName ?? req.queryText).find((l) => isActiveLocality(l.id)) ?? active[0];
  const slug = (queryKey(req.queryText) || "query").replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const url = `https://example.com/sample-research/${slug}`;
  const name = `SAMPLE ${loc.name} Research Residences`;
  const cited = `${name} by SAMPLE Research Developer is a fictional project in ${loc.name}. RERA No. SAMPLE/RERA/0001/2026. Price ₹ 1.10 Cr onwards.`;
  const answer = [
    {
      name,
      developerName: "SAMPLE Research Developer",
      localityText: loc.name,
      address: null,
      reraNumbers: ["SAMPLE/RERA/0001/2026", "SAMPLE/RERA/9999/2099"], // the second is not cited: dropped
      priceText: "₹ 1.10 Cr onwards",
      constructionStatus: "Under construction",
      sourceUrl: url,
      quote: cited,
    },
  ];
  return fakeResult([
    fakeSearchResult([{ url, title: `${name} (SAMPLE)` }]),
    fakeCitedText(`${name} is listed with its developer, locality, RERA number and price.`, [{ url, citedText: cited }]),
    fakeText(`\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``),
  ]);
};

export type FakeDevelopmentResponder = (req: DevelopmentResearchRequest) => ResearchClientResult | Promise<ResearchClientResult>;

export class FakeResearchClient implements ResearchClient, DevelopmentResearchClient {
  readonly kind = "fake" as const;
  readonly calls: ResearchRequest[] = [];
  readonly developmentCalls: Omit<DevelopmentResearchRequest, "signal">[] = [];
  constructor(
    private readonly responder: FakeResponder = sampleResponder,
    private readonly developmentResponder: FakeDevelopmentResponder = sampleDevelopmentResponder,
  ) {}

  async researchDevelopments(req: DevelopmentResearchRequest): Promise<ResearchClientResult> {
    const { signal, ...rest } = req;
    this.developmentCalls.push(rest);
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    return this.developmentResponder(req);
  }

  async research(req: ResearchRequest): Promise<ResearchClientResult> {
    this.calls.push({ ...req, signal: undefined });
    if (req.signal?.aborted) throw req.signal.reason ?? new Error("aborted");
    return this.responder(req);
  }
}
