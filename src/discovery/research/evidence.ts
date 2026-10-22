// Turns a Messages API response into the evidence the validator trusts: the URLs that actually
// came back from the web search tool, and the text the API itself cited for each URL. The
// model's own JSON is only a list of *claims* to check against that evidence.
import type { ResearchContentBlock } from "./client";

export interface Citation {
  url: string;
  citedText: string;
}

export interface ResearchEvidence {
  /** URLs present in web_search_tool_result blocks of this response. */
  searchResultUrls: string[];
  /** web_search_result_location citations attached to text blocks of this response. */
  citations: Citation[];
  /** All text blocks joined in order (the model's prose + its JSON answer). */
  text: string;
  /** web_search_tool_result blocks that carried an error object instead of results. */
  searchErrors: number;
}

export function extractEvidence(content: readonly ResearchContentBlock[]): ResearchEvidence {
  const urls = new Set<string>();
  const citations: Citation[] = [];
  const texts: string[] = [];
  let searchErrors = 0;
  for (const block of content) {
    if (block.type === "web_search_tool_result") {
      // Success content is a list of results; an error is a single object.
      if (Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === "web_search_result" && typeof r.url === "string") urls.add(r.url);
      } else {
        searchErrors++;
      }
    } else if (block.type === "text") {
      texts.push(block.text);
      for (const c of block.citations ?? []) {
        if (c.type === "web_search_result_location" && typeof c.url === "string" && typeof c.cited_text === "string") {
          citations.push({ url: c.url, citedText: c.cited_text });
        }
      }
    }
  }
  return { searchResultUrls: [...urls], citations, text: texts.join(""), searchErrors };
}

export class CandidateParseError extends Error {
  constructor() {
    super("research response did not contain a JSON array of candidates");
    this.name = "CandidateParseError";
  }
}

/**
 * The candidate array from the model's answer: the LAST ```json fenced block, else the last
 * top-level [...] in the text. Throws CandidateParseError when none parses to an array.
 */
export function parseCandidates(text: string): unknown[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const tries = fences.reverse();
  const lastOpen = text.lastIndexOf("\n[");
  const start = lastOpen >= 0 ? lastOpen + 1 : text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) tries.push(text.slice(start, end + 1));
  for (const t of tries) {
    try {
      const parsed: unknown = JSON.parse(t.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  throw new CandidateParseError();
}
