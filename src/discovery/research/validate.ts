// Anti-fabrication validator for web research candidates.
//
// Rule: a field survives only if its value appears in text that the API itself cited for the
// candidate's URL, and that URL appeared in this response's web search results. The model's own
// "quote" is never trusted as evidence. Each fact must also sit in the same citation as the
// candidate's name, within FACT_WINDOW characters of it. A candidate needs an https URL off the blocked
// portal list, a cited name, and a locality that maps to exactly one active configured locality
// (src/config/markets alias matching) and is itself cited. Anything else is dropped and counted.
import { z } from "zod";
import { findLocalitiesByText, isActiveLocality, type Locality } from "@/config/markets";
import { MAX_PRICE_TEXT, MAX_SHORT, MAX_TITLE, safeHttpsUrl, type RawExternalRecord } from "../adapter";
import { normaliseRera, normaliseUrl } from "../dedupe";
import type { Citation, ResearchEvidence } from "./evidence";
import { isBlockedPortalUrl } from "./portals";

/** Most candidates considered per response (the prompt asks for at most this many). */
export const MAX_CANDIDATES = 8;

export type DropReason =
  | "malformed"
  | "url_not_https"
  | "portal_host"
  | "url_not_in_results"
  | "no_citation"
  | "name_not_cited"
  | "out_of_market"
  | "ambiguous_locality"
  | "locality_not_cited"
  | "shared_url"
  | "multiple_projects"
  | "over_limit";

export type FieldName = "developerName" | "address" | "priceText" | "reraNumbers";

export interface ValidatedCandidate extends Omit<RawExternalRecord, "sourceId"> {
  /** All cited RERA numbers (RawExternalRecord.reraNumber carries the first, for dedupe). */
  reraNumbers: string[];
}

export interface ValidationReport {
  accepted: ValidatedCandidate[];
  dropped: Partial<Record<DropReason, number>>;
  /** Fields removed from accepted candidates because their value was not in a citation. */
  fieldsDropped: Partial<Record<FieldName, number>>;
  received: number;
}

const str = (max: number) =>
  z
    .string()
    .max(max * 4)
    .nullish()
    .transform((v) => (v == null ? null : v.trim() || null));

const candidateSchema = z.object({
  name: z.string().trim().min(2).max(MAX_TITLE * 2),
  developerName: str(MAX_SHORT),
  localityText: str(MAX_SHORT),
  address: str(200),
  reraNumbers: z.array(z.string().max(80)).max(5).nullish().transform((v) => v ?? []),
  priceText: str(MAX_PRICE_TEXT),
  constructionStatus: str(60), // requested from the model but never stored (no Lane B field)
  sourceUrl: z.string().max(2048),
  quote: str(600), // the model's own quote: never trusted as evidence
});

/** Lower-case letters/digits (any script) separated by single spaces, padded for whole-word checks. */
function words(s: string): string {
  return ` ${s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const canon = (s: string) => s.normalize("NFKC").toLowerCase();

/** Characters either side of the candidate's name that a fact must fall within (same citation). */
export const FACT_WINDOW = 200;

/** Whole-word, punctuation-insensitive containment. */
export function citedPhrase(value: string, cited: string): boolean {
  const v = words(value);
  return v.trim().length >= 2 && words(cited).includes(v);
}

/**
 * Price text: case- and spacing-insensitive, must contain a digit, and must not start or end in
 * the middle of a number ("45 L" does not match "1.45 L"; "5 Cr" does not match "2.5 Cr" or "25 Cr").
 */
export function citedPrice(value: string, cited: string): boolean {
  const v = canon(value).trim();
  if (!/\d/.test(v)) return false;
  const pieces = v.match(/\d[\d.,]*|[^\d\s]+/gu);
  if (!pieces) return false;
  // Number boundaries only where the value itself starts/ends with a digit.
  const head = /^\d/.test(pieces[0]) ? "(?<![\\d.])" : "";
  const tail = /\d$/.test(pieces[pieces.length - 1]) ? "(?!\\.?\\d)" : "";
  const re = new RegExp(`${head}${pieces.map(escapeRe).join("\\s*")}${tail}`, "u");
  return re.test(canon(cited));
}

/** Whitespace-delimited tokens with surrounding punctuation trimmed (slashes and hyphens kept inside). */
function tokens(text: string): string[] {
  return canon(text)
    .split(/[\s,;:()[\]{}"'<>|]+/u)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

/**
 * RERA number: equal, as A-Z0-9, to one WHOLE token of the citation (no fragments of a longer
 * number, no splices across tokens). Needs >= 8 characters and a digit.
 */
export function citedRera(value: string, cited: string): boolean {
  const v = normaliseRera(value);
  if (!v || v.length < 8 || !/\d/.test(v)) return false;
  return tokens(cited).some((t) => normaliseRera(t) === v);
}

/** Distinct project-registration-shaped tokens (e.g. PRM/KA/RERA/…/PR/…; agent "AG" numbers excluded). */
export function reraTokens(text: string): string[] {
  const out = new Set<string>();
  for (const t of tokens(text)) {
    const segs = t.toUpperCase().split(/[/\-]+/).filter(Boolean);
    if (segs.length < 4 || !segs.includes("RERA") || segs.includes("AG")) continue;
    if ((t.match(/\d/g) ?? []).length < 4) continue;
    out.add(normaliseRera(t)!);
  }
  return [...out];
}

/** Slices of `cited` within FACT_WINDOW characters of each whole-word occurrence of `name`. */
export function nameWindows(name: string, cited: string): string[] {
  const parts = canon(name).match(/[\p{L}\p{N}]+/gu);
  if (!parts?.length) return [];
  const text = canon(cited);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(escapeRe).join("[^\\p{L}\\p{N}]+")}(?![\\p{L}\\p{N}])`, "gu");
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    // Widen to whitespace so a window edge never cuts a number or registration into a fragment.
    let start = Math.max(0, m.index - FACT_WINDOW);
    while (start > 0 && !/\s/u.test(text[start - 1])) start--;
    let end = Math.min(text.length, m.index + m[0].length + FACT_WINDOW);
    while (end < text.length && !/\s/u.test(text[end])) end++;
    out.push(text.slice(start, end));
  }
  return out;
}

function localityTerms(loc: Locality): string[] {
  return [loc.name, ...loc.aliases];
}

/**
 * The single active configured locality whose name or an alias appears as a whole term in `text`
 * (via the existing alias matching). "none" when nothing matches, "ambiguous" for several.
 */
export function matchLocality(text: string | null): { locality: Locality; term: string } | "none" | "ambiguous" {
  if (!text) return "none";
  const hits = new Map<string, { locality: Locality; term: string }>();
  for (const loc of findLocalitiesByText(text)) {
    if (!isActiveLocality(loc.id)) continue;
    const term = localityTerms(loc).find((t) => citedPhrase(t, text));
    if (term) hits.set(loc.id, { locality: loc, term });
  }
  if (hits.size === 0) return "none";
  if (hits.size > 1) return "ambiguous";
  return [...hits.values()][0];
}

function inc<K extends string>(m: Partial<Record<K, number>>, k: K) {
  m[k] = (m[k] ?? 0) + 1;
}

export function validateCandidates(candidates: readonly unknown[], evidence: ResearchEvidence): ValidationReport {
  const dropped: ValidationReport["dropped"] = {};
  const fieldsDropped: ValidationReport["fieldsDropped"] = {};
  // Normalised URL → the URL exactly as the web search tool returned it (what we store).
  const resultUrls = new Map<string, string>();
  for (const u of evidence.searchResultUrls) {
    const k = normaliseUrl(u);
    if (!resultUrls.has(k)) resultUrls.set(k, u);
  }
  const citedByUrl = new Map<string, string[]>();
  for (const c of evidence.citations as Citation[]) {
    const key = normaliseUrl(c.url);
    if (!resultUrls.has(key)) continue; // a citation must point at a page from this response's results
    citedByUrl.set(key, [...(citedByUrl.get(key) ?? []), c.citedText]);
  }

  const accepted: (ValidatedCandidate & { urlKey: string })[] = [];
  candidates.forEach((raw, i) => {
    if (i >= MAX_CANDIDATES) return inc(dropped, "over_limit");
    const parsed = candidateSchema.safeParse(raw);
    if (!parsed.success) return inc(dropped, "malformed");
    const c = parsed.data;

    const claimed = safeHttpsUrl(c.sourceUrl);
    if (!claimed) return inc(dropped, "url_not_https");
    if (isBlockedPortalUrl(claimed)) return inc(dropped, "portal_host");
    const urlKey = normaliseUrl(claimed);
    const resultUrl = resultUrls.get(urlKey);
    if (!resultUrl) return inc(dropped, "url_not_in_results");
    // Store the search result's own URL, never the model's spelling of it.
    const url = safeHttpsUrl(resultUrl);
    if (!url) return inc(dropped, "url_not_https");
    if (isBlockedPortalUrl(url)) return inc(dropped, "portal_host");
    const cited = citedByUrl.get(urlKey) ?? [];
    if (!cited.length) return inc(dropped, "no_citation");
    // A page whose citations name several registrations is a multi-project page: facts on it
    // cannot be attributed to one project safely.
    if (new Set(cited.flatMap(reraTokens)).size > 1) return inc(dropped, "multiple_projects");

    // Every fact must sit in the same citation as the name, within FACT_WINDOW characters of it.
    const windows = cited.flatMap((t) => nameWindows(c.name, t));
    if (!windows.length) return inc(dropped, "name_not_cited");
    const isCited = (check: (v: string, t: string) => boolean, v: string) => windows.some((w) => check(v, w));

    // Locality from the stated locality first, then the address.
    let loc = matchLocality(c.localityText);
    if (loc === "none") loc = matchLocality(c.address);
    if (loc === "none") return inc(dropped, "out_of_market");
    if (loc === "ambiguous") return inc(dropped, "ambiguous_locality");
    const { locality } = loc;
    if (!localityTerms(locality).some((t) => isCited(citedPhrase, t))) return inc(dropped, "locality_not_cited");

    const keep = (field: FieldName, v: string | null, check: (v: string, t: string) => boolean): string | null => {
      if (!v) return null;
      if (isCited(check, v)) return v;
      inc(fieldsDropped, field);
      return null;
    };
    const developerName = keep("developerName", c.developerName, citedPhrase);
    const address = keep("address", c.address, citedPhrase);
    const priceText = keep("priceText", c.priceText, citedPrice);
    const reraNumbers: string[] = [];
    for (const r of c.reraNumbers) {
      const v = r.trim();
      if (v && isCited(citedRera, v)) {
        if (!reraNumbers.some((x) => normaliseRera(x) === normaliseRera(v))) reraNumbers.push(v);
      } else inc(fieldsDropped, "reraNumbers");
    }

    accepted.push({
      urlKey,
      sourceRecordId: null,
      canonicalUrl: url,
      title: c.name,
      developerName,
      localityId: locality.id,
      address,
      location: null,
      reraNumber: reraNumbers[0] ?? null,
      reraNumbers,
      priceText,
      lastSeenAt: null,
    });
  });

  // One page, one record: a page that lists several different projects cannot be attributed to
  // one stored listing safely (canonical URL is a strong dedupe key), so all of them are dropped.
  const byUrl = new Map<string, typeof accepted>();
  for (const a of accepted) byUrl.set(a.urlKey, [...(byUrl.get(a.urlKey) ?? []), a]);
  const out: ValidatedCandidate[] = [];
  for (const group of byUrl.values()) {
    const names = new Set(group.map((g) => words(g.title)));
    if (names.size > 1) {
      for (let i = 0; i < group.length; i++) inc(dropped, "shared_url");
      continue;
    }
    const { urlKey: _urlKey, ...first } = group[0];
    void _urlKey;
    out.push(first);
  }
  return { accepted: out, dropped, fieldsDropped, received: candidates.length };
}
