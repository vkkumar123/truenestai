// Small PDF helpers. Pure; no I/O; no PDF library.
// - estimatePdfPageCount: a heuristic page count from "/Type /Page" objects, used for the page
//   cap. It can under-count PDFs whose page objects sit in compressed object streams; the API's
//   own limits still apply there.
// - buildSamplePdf / readSamplePdfPages: build and read the OBVIOUSLY FICTIONAL SAMPLE test PDF
//   (uncompressed text, one content stream per page). Only for fixtures, tests and the fake client;
//   readSamplePdfPages does not understand real-world PDFs and is never used on them for facts.

const latin1 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
};

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && latin1(bytes.subarray(0, 5)) === "%PDF-";
}

/** Count of page objects ("/Type /Page", not "/Pages"); 0 when none are visible. */
export function estimatePdfPageCount(bytes: Uint8Array): number {
  return (latin1(bytes).match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

const escapePdfText = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A minimal valid PDF 1.4 with one page per entry, each line drawn with Helvetica (ASCII only). */
export function buildSamplePdf(pages: readonly (readonly string[])[]): Uint8Array {
  for (const page of pages) for (const line of page) if (!/^[\x20-\x7e]*$/.test(line)) throw new Error("SAMPLE PDF text must be printable ASCII");
  const objects: string[] = [];
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then per page: page object + content stream
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, i) => {
    const content = lines.map((l, j) => `BT /F1 11 Tf 56 ${780 - j * 18} Td (${escapePdfText(l)}) Tj ET`).join("\n");
    objects[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objects[5 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

/** Text lines per page of a PDF made by buildSamplePdf (uncompressed "(text) Tj" streams), else []. */
export function readSamplePdfPages(bytes: Uint8Array): string[][] {
  const s = latin1(bytes);
  const pages: string[][] = [];
  for (const m of s.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    const lines = [...m[1].matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((t) => t[1].replace(/\\(.)/g, "$1"));
    pages.push(lines);
  }
  return pages;
}

/**
 * The SAMPLE registration document used by fixture mode, tests and the e2e journey. Every value
 * is fictional; "SAMPLE" and "FICTIONAL" are printed on every page. The contact line exists only
 * to prove personal data is never stored (the number is a dummy).
 */
export const SAMPLE_RERA_PDF_PAGES: readonly (readonly string[])[] = [
  [
    "SAMPLE - FICTIONAL TEST DOCUMENT - NOT A REAL RERA CERTIFICATE",
    "Form C (SAMPLE): Registration Certificate of Project",
    "Registration No.: SAMPLE/RERA/0042/2026",
    "Project Name: SAMPLE Lakeview Residences",
    "Promoter: SAMPLE Fictional Developers Pvt Ltd",
    "Date of Registration: 15-01-2026",
    "Proposed Date of Completion: 31-12-2028",
    "Contact Person: Mr. Example Person, Phone 9000000000",
  ],
  [
    "SAMPLE - FICTIONAL TEST DOCUMENT",
    "Site Address: SAMPLE Road 1, Hebbal (fictional)",
    "Total Land Area: 2.5 Acres",
    "Number of Units: 240",
    "Number of Towers: 3",
    "Number of Floors: 14",
    "Plan Sanction: SAMPLE/PS/0001/2025",
  ],
];

export function buildSampleReraPdf(): Uint8Array {
  return buildSamplePdf(SAMPLE_RERA_PDF_PAGES);
}
