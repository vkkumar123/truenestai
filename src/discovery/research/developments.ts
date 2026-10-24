// Locality-level research of planned infrastructure (S4a, D20). Same evidence rules as the
// listing validator (./validate.ts): a value survives only when it appears verbatim in text the
// API cited for a URL that appeared in this response's web search results, in the same citation
// as the development's name and within FACT_WINDOW characters of it. The model's JSON is only a
// list of claims to check. Results are always unverified drafts for staff review.
import { z } from "zod";
import type { InfrastructureCategory, InfrastructureStage } from "@/domain/types";
import { getLocality, isActiveLocality, listLocalities } from "@/config/markets";
import { haversineMeters } from "@/locality/geo";
import {
  DEVELOPMENT_HORIZON_YEARS,
  DEVELOPMENT_RESEARCH_RADIUS_KM,
  isInfraCategory,
  isPromotionalText,
  markersVoidStage,
  stageFromText,
  stageMarkers,
  withinHorizon,
} from "@/locality/developments";
import { safeHttpsUrl } from "../adapter";
import { normaliseUrl } from "../dedupe";
import { SourceNotRunnableError, assertRunnable, type RuntimeEnv, type SourceEntry } from "../registry";
import { ResearchClientError, type ResearchClient, type ResearchClientResult, type ResearchContentBlock, type ResearchUsage } from "./client";
import { CandidateParseError, extractEvidence, parseCandidates, type ResearchEvidence } from "./evidence";
import { fakeCitedText, fakeResult, fakeSearchResult, fakeText } from "./fake-client";
import { isBlockedPortalUrl } from "./portals";
import { RESEARCH_MAX_SEARCHES } from "./prompt";
import { citedPhrase, matchLocality, nameWindows, words } from "./validate";

/** Most development candidates considered per response. */
export const MAX_DEVELOPMENT_CANDIDATES = 10;
/** Longest stored development name / authority / declared date. */
export const MAX_DEVELOPMENT_NAME = 120;
export const MAX_AUTHORITY = 80;
export const MAX_DECLARED_DATE = 40;

/** Queue key for a locality's development research (never produced by queryKey(): it has a colon). */
export function developmentQueryKey(localityId: string): string {
  return `dev:${localityId}`;
}
export function isDevelopmentQueryKey(key: string): boolean {
  return key.startsWith("dev:");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const DEVELOPMENT_SYSTEM_PROMPT = [
  "You look up planned public infrastructure in North Bengaluru, India, for a buyer-information service.",
  "Use the web search tool to find metro lines and stations, suburban rail, roads and road widening, flyovers, ring roads (such as STRR and PRR), airport expansion and master-plan or zoning changes.",
  "Prefer official pages of the responsible authority (for example BMRCL, K-RIDE, BDA, BBMP, NHAI, KIADB, BIAL) and government notices; news reports are acceptable. Do not use property listing portals or builder marketing pages.",
  "Report only facts written on the pages you found: the development's name, its current stage, the responsible authority and the expected completion date exactly as the page writes them. Never guess or complete a value.",
  "Never predict or comment on property prices, appreciation, rental yields or investment returns, and never state a completion date as certain.",
  "Do not include personal data.",
].join(" ");

function tagSafe(s: string): string {
  return s.replace(/[<>]/g, " ");
}

export function buildDevelopmentUserPrompt(input: { localityName: string; nearbyNames: string[]; now: Date }): string {
  const y = input.now.getUTCFullYear();
  return [
    `Locality: <locality>${tagSafe(input.localityName)}</locality>, North Bengaluru, Karnataka, India.`,
    input.nearbyNames.length ? `Nearby localities we also cover: ${input.nearbyNames.map(tagSafe).join(", ")}.` : "",
    "",
    `1. Search the web (at most ${RESEARCH_MAX_SEARCHES} searches) for public infrastructure planned, approved or under construction within about ${DEVELOPMENT_RESEARCH_RADIUS_KM} km of this locality that is expected between ${y} and ${y + DEVELOPMENT_HORIZON_YEARS}, or recently opened.`,
    `2. For each development (at most ${MAX_DEVELOPMENT_CANDIDATES}), write one short paragraph citing the page that states its name, the locality or area it serves, its stage (for example proposed, approved, DPR approved, tendered, under construction, operational, shelved), the authority responsible and the expected completion date, each exactly as the page writes them. Skip any fact the page does not state.`,
    "3. Finish with one ```json fenced block holding an array. Each item:",
    '{"name": string, "category": "metro"|"suburban_rail"|"rail"|"road"|"flyover"|"ring_road"|"airport"|"zoning"|"water"|"power"|"other", "localityText": string|null, "stageText": string|null, "authority": string|null, "expectedCompletion": string|null, "sourceUrl": string}',
    "Copy name, localityText, stageText, authority and expectedCompletion verbatim from the page at sourceUrl, which must be the exact URL of the page the facts came from. Use null when the page does not state a value. Output [] if no page you found names a development near this locality.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type DevelopmentDropReason =
  | "malformed"
  | "url_not_https"
  | "portal_host"
  | "url_not_in_results"
  | "no_citation"
  | "name_not_cited"
  | "promotional"
  | "stage_not_cited"
  | "out_of_market"
  | "ambiguous_locality"
  | "locality_not_cited"
  | "out_of_horizon"
  | "duplicate"
  | "over_limit";

export type DevelopmentFieldName = "authority" | "expectedCompletion";

export interface ValidatedDevelopment {
  name: string;
  /** Our classification of the item (the model's, checked against the enum); not a cited fact. */
  category: InfrastructureCategory;
  /** Derived from the cited stage phrase, never from the model's own label. */
  stage: InfrastructureStage;
  /** The cited stage phrase, as written on the page. */
  stageText: string;
  authority: string | null;
  expectedCompletion: string | null;
  localityId: string;
  /** The URL exactly as the web search tool returned it. */
  sourceUrl: string;
}

export interface DevelopmentValidationReport {
  accepted: ValidatedDevelopment[];
  dropped: Partial<Record<DevelopmentDropReason, number>>;
  fieldsDropped: Partial<Record<DevelopmentFieldName, number>>;
  received: number;
}

const s = (max: number) =>
  z
    .string()
    .max(max * 4)
    .nullish()
    .transform((v) => (v == null ? null : v.replace(/\s+/g, " ").trim() || null));

const candidateSchema = z.object({
  name: z.string().trim().min(3).max(MAX_DEVELOPMENT_NAME * 2),
  category: z.string().max(40).nullish(),
  localityText: s(100),
  stageText: s(80),
  authority: s(MAX_AUTHORITY),
  expectedCompletion: s(MAX_DECLARED_DATE),
  sourceUrl: z.string().max(2048),
});

function inc<K extends string>(m: Partial<Record<K, number>>, k: K) {
  m[k] = (m[k] ?? 0) + 1;
}

/** Same normalisation as infrastructure_items.name_key in SQL (lower-case alphanumerics, single spaces). */
export function developmentNameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Words just before a cited stage phrase that are checked for negation/future markers. */
const STAGE_PREFIX_WORDS = 4;

/**
 * True when at least one cited occurrence of the stage phrase is not negated or future-tense by
 * the few words before it ("has not been approved", "yet to be tendered", "will be operational").
 */
export function stageAffirmedInWindows(stageText: string, stage: InfrastructureStage, windows: readonly string[]): boolean {
  const phrase = words(stageText);
  for (const w of windows) {
    const text = words(w);
    for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
      const before = text.slice(0, at).trim().split(" ").slice(-STAGE_PREFIX_WORDS).join(" ");
      if (!markersVoidStage(stageMarkers(`${before} ${phrase}`), stage)) return true;
    }
  }
  return false;
}

/** A unit after a 4-digit number means it is an amount or a distance, not a year. */
const NOT_A_YEAR_AFTER = /^\s*(crores?|cr|lakhs?|lacs?|km|kms|m|mn|million|sq|ft)\b/;
const NOT_A_YEAR_BEFORE = /(rs\.?|inr|₹)\s*$/;

/**
 * A declared date must state a year 2000–2100 that is not an amount ("Rs 2,030 crore", "2030 km")
 * and, on the page, must not be cut out of a longer token: "2027" taken from "2027-28" would
 * shorten a financial year, so the whole "2027-28" must be the declared value.
 */
export function declaredDateOk(value: string, windows: readonly string[]): boolean {
  const v = value.normalize("NFKC").toLowerCase();
  const years = [...v.matchAll(/(?<![\d,.])(\d{4})(?![\d,.])/g)];
  if (!years.some((m) => Number(m[1]) >= 2000 && Number(m[1]) <= 2100)) return false;
  for (const m of years) {
    if (NOT_A_YEAR_AFTER.test(v.slice(m.index + 4)) || NOT_A_YEAR_BEFORE.test(v.slice(0, m.index))) return false;
  }
  const needle = v.replace(/\s+/g, " ").trim();
  let found = false;
  for (const w of windows) {
    const text = w.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      found = true;
      const after = text.slice(at + needle.length);
      const before = text.slice(0, at);
      if (/^\s*[-–/]\s*\d{2}\b/.test(after) || /\d[-–/]\s*$/.test(before)) return false; // part of a financial year
      // "2027, says BMRCL" is a year; "2,030" or "20301" is not
      if (/\d$/.test(needle) && (NOT_A_YEAR_AFTER.test(after) || /^(\d|,\d)/.test(after))) return false;
      if (/^\d/.test(needle) && (NOT_A_YEAR_BEFORE.test(before) || /[\d,.]$/.test(before))) return false;
    }
  }
  // The value was copied from the page, so it must be found as written; otherwise it is not kept.
  return found;
}

export function validateDevelopmentCandidates(
  candidates: readonly unknown[],
  evidence: ResearchEvidence,
  opts: { now: Date },
): DevelopmentValidationReport {
  const dropped: DevelopmentValidationReport["dropped"] = {};
  const fieldsDropped: DevelopmentValidationReport["fieldsDropped"] = {};
  const resultUrls = new Map<string, string>();
  for (const u of evidence.searchResultUrls) {
    const k = normaliseUrl(u);
    if (!resultUrls.has(k)) resultUrls.set(k, u);
  }
  const citedByUrl = new Map<string, string[]>();
  for (const c of evidence.citations) {
    const key = normaliseUrl(c.url);
    if (!resultUrls.has(key)) continue;
    citedByUrl.set(key, [...(citedByUrl.get(key) ?? []), c.citedText]);
  }

  const accepted: ValidatedDevelopment[] = [];
  const seen = new Set<string>();
  candidates.forEach((raw, i) => {
    if (i >= MAX_DEVELOPMENT_CANDIDATES) return inc(dropped, "over_limit");
    const parsed = candidateSchema.safeParse(raw);
    if (!parsed.success) return inc(dropped, "malformed");
    const c = parsed.data;
    const name = c.name.replace(/\s+/g, " ").trim();
    if (name.length > MAX_DEVELOPMENT_NAME) return inc(dropped, "malformed");

    const claimed = safeHttpsUrl(c.sourceUrl);
    if (!claimed) return inc(dropped, "url_not_https");
    if (isBlockedPortalUrl(claimed)) return inc(dropped, "portal_host");
    const urlKey = normaliseUrl(claimed);
    const resultUrl = resultUrls.get(urlKey);
    if (!resultUrl) return inc(dropped, "url_not_in_results");
    const url = safeHttpsUrl(resultUrl);
    if (!url) return inc(dropped, "url_not_https");
    if (isBlockedPortalUrl(url)) return inc(dropped, "portal_host");
    const cited = citedByUrl.get(urlKey) ?? [];
    if (!cited.length) return inc(dropped, "no_citation");

    const wins = cited.flatMap((t) => nameWindows(name, t));
    if (!wins.length) return inc(dropped, "name_not_cited");
    if (isPromotionalText(name)) return inc(dropped, "promotional");
    const inWindow = (v: string) => wins.some((w) => citedPhrase(v, w));

    // Stage: the cited phrase decides the tier (constitution §5: no tier, no row). A negated or
    // future phrase ("has not been approved", "will be opened") states no tier, on its own or in
    // the words just before it on the page.
    const stage = c.stageText && inWindow(c.stageText) ? stageFromText(c.stageText) : null;
    if (!stage || !c.stageText || !stageAffirmedInWindows(c.stageText, stage, wins)) return inc(dropped, "stage_not_cited");

    // Locality: named in the same citation as the development, near its name (not elsewhere on the page).
    const loc = matchLocality(c.localityText);
    if (loc === "none") return inc(dropped, "out_of_market");
    if (loc === "ambiguous") return inc(dropped, "ambiguous_locality");
    const { locality, term } = loc;
    if (!wins.some((w) => citedPhrase(term, w) || citedPhrase(locality.name, w))) return inc(dropped, "locality_not_cited");

    let authority: string | null = null;
    if (c.authority) {
      if (inWindow(c.authority) && !isPromotionalText(c.authority)) authority = c.authority;
      else inc(fieldsDropped, "authority");
    }
    let expectedCompletion: string | null = null;
    if (c.expectedCompletion) {
      if (inWindow(c.expectedCompletion) && declaredDateOk(c.expectedCompletion, wins)) expectedCompletion = c.expectedCompletion;
      else inc(fieldsDropped, "expectedCompletion");
    }
    // Next 5–10 years: a cited date far outside the horizon (or long past) is not a plan for buyers.
    if (expectedCompletion && !withinHorizon(expectedCompletion, opts.now)) return inc(dropped, "out_of_horizon");

    const key = `${developmentNameKey(name)}|${urlKey}`;
    if (seen.has(key)) return inc(dropped, "duplicate");
    seen.add(key);
    accepted.push({
      name,
      category: isInfraCategory(c.category) ? c.category : "other",
      stage,
      stageText: c.stageText,
      authority,
      expectedCompletion,
      localityId: locality.id,
      sourceUrl: url,
    });
  });
  return { accepted, dropped, fieldsDropped, received: candidates.length };
}

// ---------------------------------------------------------------------------
// One research call for one locality
// ---------------------------------------------------------------------------

export interface DevelopmentResearchRequest {
  localityName: string;
  nearbyNames: string[];
  now: Date;
  signal?: AbortSignal;
}

/** A client that can also run the development prompt (the Anthropic client and the fake one). */
export interface DevelopmentResearchClient extends ResearchClient {
  researchDevelopments(req: DevelopmentResearchRequest): Promise<ResearchClientResult>;
}

export function canResearchDevelopments(c: ResearchClient): c is DevelopmentResearchClient {
  return typeof (c as Partial<DevelopmentResearchClient>).researchDevelopments === "function";
}

export interface DevelopmentResearchResult {
  developments: ValidatedDevelopment[];
  validation: Omit<DevelopmentValidationReport, "accepted"> & { accepted: number };
  usage: ResearchUsage;
  stopReason: string | null;
  evidence: { searchResultBlocks: number; searchErrors: number; resultUrls: number; citations: number };
}

/** Localities whose centroid is within the research radius of `localityId` (config only). */
export function nearbyLocalityNames(localityId: string): string[] {
  const loc = getLocality(localityId);
  if (!loc) return [];
  const r = DEVELOPMENT_RESEARCH_RADIUS_KM * 1000;
  return listLocalities({ activeOnly: true })
    .filter((l) => l.id !== loc.id && haversineMeters(loc.centroid, l.centroid) <= r)
    .map((l) => l.name)
    .slice(0, 12);
}

/** Policy gate (DATA_SOURCE_POLICY §11.3): the source's registry entry must permit storing development fields. */
export function mayStoreDevelopments(source: Pick<SourceEntry, "storagePermissions">): boolean {
  return source.storagePermissions.includes("development_fields");
}

export async function researchLocalityDevelopments(
  localityId: string,
  opts: { client: ResearchClient; source: SourceEntry; env: RuntimeEnv; now: Date; signal?: AbortSignal },
): Promise<DevelopmentResearchResult> {
  try {
    assertRunnable(opts.source, opts.env);
  } catch (e) {
    if (e instanceof SourceNotRunnableError) throw new ResearchClientError("source_not_runnable", false);
    throw e;
  }
  if (!mayStoreDevelopments(opts.source)) throw new ResearchClientError("source_not_runnable", false);
  if (opts.source.type === "fixture" && opts.client.kind !== "fake") throw new ResearchClientError("source_not_runnable", false);
  if (!canResearchDevelopments(opts.client)) throw new ResearchClientError("config", false);
  const locality = getLocality(localityId);
  if (!locality || !isActiveLocality(localityId)) throw new ResearchClientError("bad_request", false);

  const res = await opts.client.researchDevelopments({
    localityName: locality.name,
    nearbyNames: nearbyLocalityNames(localityId),
    now: opts.now,
    signal: opts.signal,
  });
  if (res.stopReason === "refusal") throw new ResearchClientError("refusal", false, res.usage);
  if (res.stopReason === "max_tokens") throw new ResearchClientError("max_tokens", false, res.usage);
  const evidence = extractEvidence(res.content);
  let candidates: unknown[];
  try {
    candidates = parseCandidates(evidence.text);
  } catch (e) {
    if (e instanceof CandidateParseError) throw new ResearchClientError("parse_error", true, res.usage);
    throw e;
  }
  if (candidates.length > 0 && evidence.searchResultBlocks === 0) throw new ResearchClientError("no_evidence", false, res.usage);
  const report = validateDevelopmentCandidates(candidates, evidence, { now: opts.now });
  return {
    developments: report.accepted,
    validation: { received: report.received, accepted: report.accepted.length, dropped: report.dropped, fieldsDropped: report.fieldsDropped },
    usage: res.usage,
    stopReason: res.stopReason,
    evidence: {
      searchResultBlocks: evidence.searchResultBlocks,
      searchErrors: evidence.searchErrors,
      resultUrls: evidence.searchResultUrls.length,
      citations: evidence.citations.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture responder (network-free; obviously fictional SAMPLE pages on example.org)
// ---------------------------------------------------------------------------

/** Fictional development names the fixture responder returns for a locality. */
export function sampleDevelopmentNames(localityName: string) {
  return {
    metro: `SAMPLE ${localityName} Metro Extension`,
    road: `SAMPLE ${localityName} Ring Road Link`,
    fabricated: `SAMPLE ${localityName} Sky Tram`,
  };
}

/**
 * One SAMPLE metro extension with every value cited; one SAMPLE road whose authority and date
 * are NOT in the citation (both fields are dropped); and one fabricated item with no citation
 * (dropped). A locality name containing "nothing" returns no candidates.
 */
export function sampleDevelopmentResponder(req: DevelopmentResearchRequest): ResearchClientResult {
  if (/\bnothing\b/i.test(req.localityName)) return fakeResult([fakeSearchResult([]), fakeText("No developments found.\n```json\n[]\n```")]);
  const y = req.now.getUTCFullYear();
  const n = sampleDevelopmentNames(req.localityName);
  const slug = req.localityName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const metroUrl = `https://example.org/sample-developments/${slug}/metro`;
  const roadUrl = `https://example.org/sample-developments/${slug}/road`;
  const metroCited = `${n.metro} near ${req.localityName} is under construction by the SAMPLE Metro Authority and is expected to be completed by December ${y + 3}. This is fictional SAMPLE text.`;
  const roadCited = `${n.road} serving ${req.localityName} is proposed. This is fictional SAMPLE text.`;
  const answer = [
    { name: n.metro, category: "metro", localityText: req.localityName, stageText: "under construction", authority: "SAMPLE Metro Authority", expectedCompletion: `December ${y + 3}`, sourceUrl: metroUrl },
    // authority and date are not in the citation: both fields are dropped, the row is kept
    { name: n.road, category: "ring_road", localityText: req.localityName, stageText: "proposed", authority: "SAMPLE Roads Board", expectedCompletion: `${y + 6}`, sourceUrl: roadUrl },
    // not on any page from the search: dropped
    { name: n.fabricated, category: "other", localityText: req.localityName, stageText: "approved", authority: "SAMPLE Authority", expectedCompletion: `${y + 2}`, sourceUrl: `https://example.org/sample-developments/${slug}/uncited` },
  ];
  const content: ResearchContentBlock[] = [
    fakeSearchResult([
      { url: metroUrl, title: `${n.metro} (SAMPLE)` },
      { url: roadUrl, title: `${n.road} (SAMPLE)` },
    ]),
    fakeCitedText(`${n.metro} is described with its stage, authority and expected date.`, [{ url: metroUrl, citedText: metroCited }]),
    fakeCitedText(` ${n.road} is described as proposed.`, [{ url: roadUrl, citedText: roadCited }]),
    fakeText(`\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``),
  ];
  return fakeResult(content);
}
