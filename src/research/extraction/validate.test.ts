import { describe, expect, it } from "vitest";
import {
  buildExcerpt,
  buildSampleReraPdf,
  containsPersonalData,
  estimatePdfPageCount,
  fakeCited,
  fakeText,
  isPdf,
  parsePrintedDate,
  parsePrintedNumber,
  readSamplePdfPages,
  SAMPLE_RERA_PDF_PAGES,
  sampleExtractionResponder,
  validateExtraction,
  getExtractionAttribute,
  type BlockLike,
} from ".";

// All text here is fictional SAMPLE data.
const line = (attr: string, value: string, cited?: string, page = 1): BlockLike[] =>
  cited === undefined ? [fakeText(`${attr} | ${value}\n`)] : [fakeText(`${attr} | `), fakeCited(value, cited, page), fakeText("\n")];

describe("validateExtraction (anti-fabrication)", () => {
  it("keeps a value that appears verbatim in its citation, with the citation's page and a short excerpt", () => {
    const r = validateExtraction(line("rera_numbers", "SAMPLE/RERA/0042/2026", "Registration No.: SAMPLE/RERA/0042/2026", 3));
    expect(r.droppedCount).toBe(0);
    expect(r.kept).toEqual([
      {
        attribute: "rera_numbers", valueText: null, valueNum: null, valueDate: null, valueJson: ["SAMPLE/RERA/0042/2026"],
        pageNumber: 3, excerpt: "Registration No.: SAMPLE/RERA/0042/2026",
      },
    ]);
  });

  it("accepts a citation that covers the whole line, and whitespace differences only", () => {
    const blocks: BlockLike[] = [fakeCited("project_name | SAMPLE   Lakeview\nResidences", "Project Name: SAMPLE Lakeview Residences", 1)];
    // the newline splits the value across two lines: the first line's value is a verbatim prefix
    expect(validateExtraction(blocks).kept[0]).toMatchObject({ attribute: "project_name", valueText: "SAMPLE Lakeview" });
    const r = validateExtraction(line("project_name", "SAMPLE  Lakeview  Residences", "Project Name:\nSAMPLE Lakeview Residences"));
    expect(r.kept[0].valueText).toBe("SAMPLE Lakeview Residences");
  });

  it("drops a value with no citation (fabricated)", () => {
    const r = validateExtraction(line("khata_type", "A Khata"));
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ not_cited: 1 });
  });

  it("drops a paraphrased value even when the line is cited", () => {
    const r = validateExtraction([
      ...line("total_units", "two hundred and forty", "Number of Units: 240", 2),
      ...line("rera_completion_date", "2028-12-31", "Proposed Date of Completion: 31-12-2028", 1), // reformatted, not as printed
      ...line("promoter_name", "SAMPLE fictional developers pvt ltd", "Promoter: SAMPLE Fictional Developers Pvt Ltd"), // case differs
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ not_verbatim: 3 });
  });

  it("drops personal data: people's names, phone numbers, e-mails, ID numbers, and an individual as promoter", () => {
    const cited = "Contact Person: Mr. Example Person, Phone 9000000000, sample.person@example.com, PAN ABCDE1234F, Aadhaar 1234 5678 9012";
    const r = validateExtraction([
      ...line("promoter_name", "Mr. Example Person", cited),
      ...line("address", "Phone 9000000000", cited),
      ...line("address", "sample.person@example.com", cited),
      ...line("oc_status", "PAN ABCDE1234F", cited),
      ...line("khata_type", "Aadhaar 1234 5678 9012", cited),
      ...line("promoter_name", "Example Person", "Promoter: Example Person"), // no organisation marker
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ personal_data: 6 });
  });

  it("an excerpt never carries personal data next to a kept value", () => {
    const r = validateExtraction(line("total_units", "240", "Mr. Example Person, Phone 9000000000 states Number of Units: 240", 2));
    expect(r.kept[0]).toMatchObject({ valueNum: 240, excerpt: "240", pageNumber: 2 });
  });

  it("drops unknown attributes, unreadable values, duplicates and in-document conflicts; ignores prose", () => {
    const cited = "Number of Towers: 3. Number of Towers: 4. Land: 2 Acres 10 Guntas. Registration No.: SAMPLE/RERA/0042/2026";
    const r = validateExtraction([
      fakeText("Here are the details I found:\n"),
      ...line("price", "3", cited),
      ...line("towers", "3", cited),
      ...line("towers", "3", cited),
      ...line("towers", "4", cited),
      ...line("land_area_acres", "2 Acres 10 Guntas", cited),
      ...line("rera_numbers", "SAMPLE/RERA/0042/2026", cited),
      ...line("rera_numbers", "SAMPLE/RERA/0042/2026", cited),
      fakeText("END"),
    ]);
    expect(r.kept.map((k) => [k.attribute, k.valueNum ?? k.valueJson])).toEqual([["towers", 3], ["rera_numbers", ["SAMPLE/RERA/0042/2026"]]]);
    expect(r.dropped).toEqual({ unknown_attribute: 1, duplicate: 2, conflicting: 1, invalid_value: 1 });
    expect(r.candidateCount).toBe(7);
  });

  it("parses printed dates day-first and never invents a day; numbers need exactly one figure in range", () => {
    expect(parsePrintedDate("31-12-2028")).toBe("2028-12-31");
    expect(parsePrintedDate("31/12/2028")).toBe("2028-12-31");
    expect(parsePrintedDate("31st December 2028")).toBe("2028-12-31");
    expect(parsePrintedDate("December 31, 2028")).toBe("2028-12-31");
    expect(parsePrintedDate("2028-12-31")).toBe("2028-12-31");
    expect(parsePrintedDate("Dec 2028")).toBeNull();
    expect(parsePrintedDate("31-02-2028")).toBeNull();
    const units = getExtractionAttribute("total_units")!;
    const land = getExtractionAttribute("land_area_acres")!;
    expect(parsePrintedNumber("1,240", units)).toBe(1240);
    expect(parsePrintedNumber("240 units", units)).toBe(240);
    expect(parsePrintedNumber("2.5", units)).toBeNull();
    expect(parsePrintedNumber("2.5 Acres", land)).toBe(2.5);
    expect(parsePrintedNumber("10117 Sq.m", land)).toBeNull();
  });

  it("excerpts are at most 20 words around the value", () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const ex = buildExcerpt(`${long} VALUE ${long}`, "VALUE");
    expect(ex.split(" ")).toHaveLength(20);
    expect(ex).toContain("VALUE");
    expect(containsPersonalData("SAMPLE/RERA/0042/2026 and SAMPLE/PS/0001/2025")).toBe(false);
  });
});

describe("SAMPLE PDF + fake client", () => {
  it("builds a fictional two-page PDF the helpers can read", () => {
    const pdf = buildSampleReraPdf();
    expect(isPdf(pdf)).toBe(true);
    expect(estimatePdfPageCount(pdf)).toBe(2);
    expect(readSamplePdfPages(pdf)).toEqual(SAMPLE_RERA_PDF_PAGES);
    for (const page of SAMPLE_RERA_PDF_PAGES) expect(page[0]).toMatch(/^SAMPLE - FICTIONAL/);
  });

  it("the fake response yields the document's values with pages; the fabricated, paraphrased and personal values are dropped", async () => {
    const res = await sampleExtractionResponder({ pdf: buildSampleReraPdf() });
    const r = validateExtraction(res.content);
    expect(Object.fromEntries(r.kept.map((k) => [k.attribute, [k.valueText ?? k.valueNum ?? k.valueDate ?? k.valueJson, k.pageNumber]]))).toEqual({
      rera_numbers: [["SAMPLE/RERA/0042/2026"], 1],
      project_name: ["SAMPLE Lakeview Residences", 1],
      promoter_name: ["SAMPLE Fictional Developers Pvt Ltd", 1],
      rera_registration_date: ["2026-01-15", 1],
      rera_completion_date: ["2028-12-31", 1],
      address: ["SAMPLE Road 1, Hebbal (fictional)", 2],
      land_area_acres: [2.5, 2],
      total_units: [240, 2],
      towers: [3, 2],
      floors: [14, 2],
      plan_approvals: [["SAMPLE/PS/0001/2025"], 2],
    });
    expect(r.dropped).toEqual({ not_cited: 1, not_verbatim: 1, personal_data: 1 });
    for (const k of r.kept) expect(k.excerpt.split(" ").length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(r.kept)).not.toMatch(/Example Person|9000000000/);
  });

  it("a non-SAMPLE PDF yields nothing", async () => {
    const res = await sampleExtractionResponder({ pdf: new TextEncoder().encode("%PDF-1.4\n%%EOF") });
    expect(validateExtraction(res.content).kept).toEqual([]);
  });
});
