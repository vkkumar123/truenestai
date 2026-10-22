import type { DiscoveryAdapter, DiscoveryQuery, RawExternalRecord } from "../adapter";
import { SAMPLE_RECORDS } from "../fixtures";

export function filterRecords(records: readonly RawExternalRecord[], sourceId: string, q: DiscoveryQuery) {
  const text = q.text?.trim().toLowerCase();
  return records
    .filter((r) => r.sourceId === sourceId)
    .filter((r) => !q.localityId || r.localityId === q.localityId)
    .filter((r) => !text || r.title.toLowerCase().includes(text) || (r.developerName ?? "").toLowerCase().includes(text))
    .map((r) => ({ ...r }));
}

/** In-memory adapter over fictional fixtures. No network access. */
export function createFixtureAdapter(
  sourceId: string,
  records: readonly RawExternalRecord[] = SAMPLE_RECORDS,
): DiscoveryAdapter {
  return { sourceId, search: async (q) => filterRecords(records, sourceId, q) };
}
