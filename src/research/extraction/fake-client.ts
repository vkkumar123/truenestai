// Network-free extraction client for fixture mode, unit tests and CI. It answers like the Messages
// API with citations enabled ("attribute | " text followed by a cited text block carrying a
// page_location citation), reading only the OBVIOUSLY FICTIONAL SAMPLE PDF format (./pdf.ts).
// For SAMPLE documents it also emits three values the validator must drop: one with no citation
// (fabricated), one paraphrased (cited, but not verbatim) and one person's name (personal data).
// Any other PDF yields no values.
import type { ExtractionClient, ExtractionClientResult, ExtractionContentBlock, ExtractionRequest } from "./client";
import { readSamplePdfPages } from "./pdf";

const LABELS: Record<string, string> = {
  "Registration No.": "rera_numbers",
  "Project Name": "project_name",
  Promoter: "promoter_name",
  "Date of Registration": "rera_registration_date",
  "Proposed Date of Completion": "rera_completion_date",
  "Site Address": "address",
  "Total Land Area": "land_area_acres",
  "Number of Units": "total_units",
  "Number of Towers": "towers",
  "Number of Floors": "floors",
  "Plan Sanction": "plan_approvals",
};

export function fakeText(text: string): ExtractionContentBlock {
  return { type: "text", text, citations: null };
}

/** `endPage` is exclusive, as in the API (default: the one page `page`). */
export function fakeCited(text: string, citedText: string, page: number, endPage = page + 1): ExtractionContentBlock {
  return {
    type: "text",
    text,
    citations: [{ type: "page_location", cited_text: citedText, document_index: 0, document_title: null, start_page_number: page, end_page_number: endPage, file_id: null }],
  };
}

export function fakeExtractionResult(content: ExtractionContentBlock[], stopReason = "end_turn"): ExtractionClientResult {
  return { content, stopReason, usage: { inputTokens: 1500, outputTokens: 300 }, model: "fake-extraction-model" };
}

export type FakeExtractionResponder = (req: ExtractionRequest) => ExtractionClientResult | Promise<ExtractionClientResult>;

export const sampleExtractionResponder: FakeExtractionResponder = (req) => {
  const pages = readSamplePdfPages(req.pdf);
  if (!pages.some((p) => p.some((l) => l.includes("SAMPLE") && l.includes("FICTIONAL")))) {
    return fakeExtractionResult([fakeText("No project details found.")]);
  }
  const content: ExtractionContentBlock[] = [];
  pages.forEach((lines, i) => {
    for (const line of lines) {
      const at = line.indexOf(": ");
      if (at === -1) continue;
      const attribute = LABELS[line.slice(0, at)];
      if (!attribute) continue;
      content.push(fakeText(`${attribute} | `), fakeCited(line.slice(at + 2), line, i + 1), fakeText("\n"));
    }
  });
  const unitsLine = pages.flat().find((l) => l.startsWith("Number of Units: "));
  const contactLine = pages[0]?.find((l) => l.startsWith("Contact Person: "));
  // fabricated: no citation at all
  content.push(fakeText("khata_type | A Khata\n"));
  // paraphrased: cited, but the words are not in the cited passage
  if (unitsLine) content.push(fakeText("total_units | "), fakeCited("two hundred and forty", unitsLine, 2), fakeText("\n"));
  // a person: cited verbatim, but personal data
  if (contactLine) content.push(fakeText("promoter_name | "), fakeCited("Mr. Example Person", contactLine, 1), fakeText("\n"));
  return fakeExtractionResult(content);
};

export class FakeExtractionClient implements ExtractionClient {
  readonly kind = "fake" as const;
  readonly model = "fake-extraction-model";
  readonly calls: number[] = [];
  constructor(private readonly responder: FakeExtractionResponder = sampleExtractionResponder) {}
  async extract(req: ExtractionRequest): Promise<ExtractionClientResult> {
    if (req.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    this.calls.push(req.pdf.byteLength);
    return this.responder(req);
  }
}
