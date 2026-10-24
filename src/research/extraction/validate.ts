// Anti-fabrication + personal-data validator for document extraction (S3a, D19). Pure; no I/O.
//
// The model answers "attribute | value" lines; the API attaches page_location citations
// (cited_text + page numbers) to the text it cites. A value is KEPT only when:
//   1. its attribute is one we asked for (EXTRACTION_ATTRIBUTES);
//   2. the line carries at least one page_location citation;
//   3. the value appears VERBATIM (after whitespace normalisation, case-sensitive) inside one of
//      that line's cited_text passages, as whole tokens (not "40" inside "240", "2" inside "112/2"
//      or "registered" inside "unregistered") — the citation's page is recorded. A citation that
//      spans several pages is not used (we record exactly one page per value); every item of a
//      list attribute must be cited on the same page as the first;
//   4. it contains no personal data (people's names, phone numbers, e-mails, ID numbers); a
//      promoter must read as a company or organisation;
//   5. it parses as the attribute's kind (number / ISO date / list) within a sane range.
// Everything else is dropped and counted by reason. Nothing is ever inferred or repaired.
import { validateRegistrationReference } from "../evidence";
import { getExtractionAttribute, type ExtractionAttribute } from "./catalogue";

export const MAX_EXCERPT_WORDS = 20; // constitution §6; also a DB CHECK
export const MAX_EXCERPT_CHARS = 300; // DB CHECK
export const MAX_TEXT_VALUE_CHARS = 500;
export const MAX_LIST_ITEMS = 20;

export type DropReason =
  | "unknown_attribute"
  | "not_cited"
  | "not_verbatim"
  | "personal_data"
  | "invalid_value"
  | "duplicate"
  | "conflicting"
  | "other_page"
  | "multi_page";

export interface ExtractedValue {
  attribute: string;
  valueText: string | null;
  valueNum: number | null;
  valueDate: string | null;
  valueJson: string[] | null;
  /** 1-based page of the citation that contains the value. */
  pageNumber: number;
  /** <= 20 words from the cited passage, around the value; personal data never included. */
  excerpt: string;
}

export interface ExtractionValidation {
  kept: ExtractedValue[];
  dropped: Partial<Record<DropReason, number>>;
  droppedCount: number;
  /** Candidate lines seen ("attribute | value"); prose lines are ignored, not counted. */
  candidateCount: number;
}

/** Minimal structural view of a response content block (SDK BetaContentBlock fits it). */
export interface BlockLike {
  type: string;
  text?: string;
  citations?: ReadonlyArray<{ type: string; cited_text?: string; start_page_number?: number; end_page_number?: number }> | null;
}

interface PageCitation {
  citedText: string;
  page: number;
  /** Pages covered (end_page_number is exclusive in the API); 1 when the end is missing. */
  span: number;
}

interface Line {
  text: string;
  citations: PageCitation[];
}

export const normalizeWs = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim();

/** Splits the response text into lines, attaching each text block's citations to the lines it touches. */
export function linesFromBlocks(blocks: readonly BlockLike[]): Line[] {
  const lines: Line[] = [];
  let cur: Line = { text: "", citations: [] };
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue;
    const cites: PageCitation[] = [];
    for (const c of b.citations ?? []) {
      if (c.type === "page_location" && typeof c.cited_text === "string" && Number.isInteger(c.start_page_number) && c.start_page_number! >= 1) {
        const end = Number.isInteger(c.end_page_number) ? c.end_page_number! : c.start_page_number! + 1;
        cites.push({ citedText: c.cited_text, page: c.start_page_number!, span: Math.max(1, end - c.start_page_number!) });
      }
    }
    b.text.split("\n").forEach((part, i) => {
      if (i > 0) {
        lines.push(cur);
        cur = { text: "", citations: [] };
      }
      cur.text += part;
      if (part.trim() && cites.length) cur.citations.push(...cites);
    });
  }
  lines.push(cur);
  return lines.filter((l) => l.text.trim() !== "");
}

// ---- personal data ----

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MOBILE = /(?<![\d/])(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d/])/;
const LANDLINE = /(?<![\d/])0\d{2,4}[\s-]\d{6,8}(?![\d/])/;
const AADHAAR = /(?<![\d/])\d{4}[\s-]\d{4}[\s-]\d{4}(?![\d/])|(?<![\d/])\d{12}(?![\d/])/;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/;
const HONORIFIC = /\b(?:Mr|Mrs|Ms|Miss|Mx|Shri|Sri|Smt|Kum|Kumari|Dr)\.?\s+[A-Z]/;
const RELATION = /\b[SDWC]\/[Oo]\b/;
const PERSON_LABEL = /\b(?:aadhaa?r|pan\s*(?:no|number|card)|passport|voter\s*id|din\s*(?:no|number)|mobile|phone|tel|e-?mail|contact\s+person|proprietor|authori[sz]ed\s+signatory)\b/i;

/** True when the text looks like it contains personal data about an individual. Conservative. */
export function containsPersonalData(text: string): boolean {
  return [EMAIL, MOBILE, LANDLINE, AADHAAR, PAN, HONORIFIC, RELATION, PERSON_LABEL].some((re) => re.test(text));
}

const ORGANISATION =
  /\b(?:pvt|private|ltd|limited|llp|inc|corporation|corp|company|co\.|developers?|builders?|constructions?|infra\w*|estates?|realty|realtors|projects?|homes|housing|properties|ventures|enterprises|associates|group|trust|society|board|authority|firm)\b/i;

/** A promoter value must read as a company or organisation (else it may be an individual). */
export function looksLikeOrganisation(text: string): boolean {
  return ORGANISATION.test(text);
}

// ---- value parsing ----

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2060 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s ? s : null;
}

const month = (name: string) => {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i === -1 ? 0 : i + 1;
};

/**
 * A printed date → ISO 'YYYY-MM-DD', or null. Numeric dates are read day-first (Indian usage:
 * 31-12-2028, 31/12/2028, 31.12.2028); also 2028-12-31, "31 December 2028", "December 31, 2028".
 * A month-only date ("Dec 2028") is null: we never invent a day.
 */
export function parsePrintedDate(v: string): string | null {
  const s = normalizeWs(v);
  let m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return isoDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/.exec(s);
  if (m) return isoDate(+m[3], month(m[2]), +m[1]);
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) return isoDate(+m[3], month(m[1]), +m[2]);
  return null;
}

/** Exactly one number in the printed value (Indian digit grouping allowed), else null. */
export function parsePrintedNumber(v: string, attr: ExtractionAttribute): number | null {
  const s = normalizeWs(v);
  const nums = s.match(/\d[\d,]*(?:\.\d+)?/g);
  if (!nums || nums.length !== 1) return null;
  const n = Number(nums[0].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  if (attr.attribute === "land_area_acres") {
    const rest = s.replace(nums[0], "").trim();
    if (rest !== "" && !/^acres?\.?$/i.test(rest)) return null; // other units are never converted
  }
  if (attr.integer && !Number.isInteger(n)) return null;
  if (attr.range && (n < attr.range[0] || n > attr.range[1])) return null;
  return n;
}

// ---- verbatim match ----

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Index of the value inside the (whitespace-normalised) cited text as whole tokens, or -1. The value
 * may not touch a letter or digit, nor continue through a joiner ("/", ".", ",", "-") into one:
 * "2" is not in "112/2", "40" is not in "240" or "1,240", "registered" is not in "unregistered";
 * "3" is in "Towers: 3." and "240" in "Units: 240".
 */
export function findVerbatim(citedText: string, value: string): number {
  const v = normalizeWs(value);
  if (!v) return -1;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}][/.,\\-])${escapeRegExp(v)}(?![\\p{L}\\p{N}])(?![/.,\\-][\\p{L}\\p{N}])`,
    "u",
  );
  const m = re.exec(normalizeWs(citedText));
  return m ? m.index : -1;
}

// ---- excerpt ----

/** <= 20 words of the cited passage around the value (the value itself when the window holds personal data). */
export function buildExcerpt(citedText: string, value: string, index?: number): string {
  const cited = normalizeWs(citedText);
  const val = normalizeWs(value);
  const valueWords = val.split(" ");
  const clamp = (words: string[]) => {
    let out = words.slice(0, MAX_EXCERPT_WORDS).join(" ");
    while (out.length > MAX_EXCERPT_CHARS && out.includes(" ")) out = out.slice(0, out.lastIndexOf(" "));
    return out.slice(0, MAX_EXCERPT_CHARS);
  };
  const at = index !== undefined && index >= 0 && cited.startsWith(val, index) ? index : cited.indexOf(val);
  if (at === -1 || valueWords.length >= MAX_EXCERPT_WORDS) return clamp(valueWords);
  const before = cited.slice(0, at).trim();
  const after = cited.slice(at + val.length).trim();
  const beforeWords = before ? before.split(" ") : [];
  const afterWords = after ? after.split(" ") : [];
  const room = MAX_EXCERPT_WORDS - valueWords.length;
  const nBefore = Math.min(beforeWords.length, Math.ceil(room / 2));
  const nAfter = Math.min(afterWords.length, room - nBefore);
  const window = [...beforeWords.slice(beforeWords.length - nBefore), ...valueWords, ...afterWords.slice(0, nAfter)];
  const excerpt = clamp(window);
  return containsPersonalData(excerpt) ? clamp(valueWords) : excerpt;
}

// ---- the validator ----

const LINE = /^\s*[-*•]?\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\|\s*(.+?)\s*$/;
const stripQuotes = (v: string) => v.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();

/** Validates a response's content blocks. Never throws on odd input; unknown shapes are ignored. */
export function validateExtraction(blocks: readonly BlockLike[]): ExtractionValidation {
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (r: DropReason) => (dropped[r] = (dropped[r] ?? 0) + 1);
  const scalars = new Map<string, ExtractedValue>();
  const lists = new Map<string, ExtractedValue>();
  let candidateCount = 0;

  for (const line of linesFromBlocks(blocks)) {
    const m = LINE.exec(line.text);
    if (!m) continue; // prose, "END", headings: not a value
    candidateCount++;
    const attr = getExtractionAttribute(m[1].toLowerCase());
    const value = normalizeWs(stripQuotes(m[2]));
    if (!attr) {
      drop("unknown_attribute");
      continue;
    }
    if (!value) {
      drop("invalid_value");
      continue;
    }
    if (line.citations.length === 0) {
      drop("not_cited");
      continue;
    }
    const matches = line.citations.map((c) => ({ c, at: findVerbatim(c.citedText, value) })).filter((x) => x.at >= 0);
    if (matches.length === 0) {
      drop("not_verbatim");
      continue;
    }
    const onePage = matches.filter((x) => x.c.span === 1);
    if (onePage.length === 0) {
      drop("multi_page");
      continue;
    }
    // a list keeps one page: later items must be cited on the first item's page
    const listed = attr.kind === "json" ? lists.get(attr.attribute) : undefined;
    const match = listed === undefined ? onePage[0] : onePage.find((x) => x.c.page === listed.pageNumber);
    if (!match) {
      drop(listed?.valueJson!.includes(value) ? "duplicate" : "other_page");
      continue;
    }
    const cite = match.c;
    const excerptOf = () => buildExcerpt(cite.citedText, value, match.at);
    if (containsPersonalData(value) || (attr.attribute === "promoter_name" && !looksLikeOrganisation(value))) {
      drop("personal_data");
      continue;
    }
    const base = { attribute: attr.attribute, valueText: null, valueNum: null, valueDate: null, valueJson: null, pageNumber: cite.page };

    if (attr.kind === "json") {
      if (value.length > MAX_TEXT_VALUE_CHARS || (attr.attribute === "rera_numbers" && !validateRegistrationReference(value).ok)) {
        drop("invalid_value");
        continue;
      }
      const existing = lists.get(attr.attribute);
      if (existing?.valueJson!.includes(value)) {
        drop("duplicate");
        continue;
      }
      if (existing && existing.valueJson!.length >= MAX_LIST_ITEMS) {
        drop("invalid_value");
        continue;
      }
      if (existing) existing.valueJson!.push(value);
      else lists.set(attr.attribute, { ...base, valueJson: [value], excerpt: excerptOf() });
      continue;
    }

    let next: ExtractedValue | null = null;
    if (attr.kind === "text") {
      next = value.length <= MAX_TEXT_VALUE_CHARS ? { ...base, valueText: value, excerpt: "" } : null;
    } else if (attr.kind === "number") {
      const n = parsePrintedNumber(value, attr);
      next = n === null ? null : { ...base, valueNum: n, excerpt: "" };
    } else {
      const d = parsePrintedDate(value);
      next = d === null ? null : { ...base, valueDate: d, excerpt: "" };
    }
    if (!next) {
      drop("invalid_value");
      continue;
    }
    const prev = scalars.get(attr.attribute);
    if (prev) {
      const same = prev.valueText === next.valueText && prev.valueNum === next.valueNum && prev.valueDate === next.valueDate;
      drop(same ? "duplicate" : "conflicting");
      continue;
    }
    scalars.set(attr.attribute, { ...next, excerpt: excerptOf() });
  }

  const kept = [...scalars.values(), ...lists.values()];
  const droppedCount = Object.values(dropped).reduce((a, b) => a + (b ?? 0), 0);
  return { kept, dropped, droppedCount, candidateCount };
}
