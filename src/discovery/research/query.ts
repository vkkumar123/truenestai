// Query normalisation for on-demand research jobs (no I/O).

/** Longest raw query we accept or store (matches the search box and research_jobs.query_text). */
export const MAX_QUERY_TEXT = 100;
/** Shortest normalised key worth researching. */
export const MIN_QUERY_KEY = 3;

/** Raw query as shown back to the buyer: control characters removed, whitespace collapsed, cut to 100. */
export function cleanQueryText(input: string | null | undefined): string {
  return String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_TEXT);
}

/**
 * Normalised dedupe key: NFKC, lower-case, letters/digits only, unique words sorted, joined by
 * single spaces. "2BHK  Hebbal!" and "hebbal 2bhk" share a key. Returns "" when too short.
 */
export function queryKey(input: string | null | undefined, localityId?: string | null): string {
  const words = cleanQueryText(input)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const text = [...new Set(words)].sort().join(" ");
  if (text.length < MIN_QUERY_KEY) return "";
  const key = localityId ? `${text} @${localityId}` : text;
  return key.slice(0, 160);
}
