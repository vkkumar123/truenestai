import "server-only";
import type { ExternalListing } from "@/domain/types";
import { clampLimit, type ExternalListingRepository, type StoredListingFilter } from "../types";

/** In-memory store, per server process (dev/test only). */
export class FixtureExternalListingRepository implements ExternalListingRepository {
  private readonly rows = new Map<string, ExternalListing>();

  async getById(id: string): Promise<ExternalListing | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async search(filter: StoredListingFilter): Promise<ExternalListing[]> {
    const text = filter.text?.trim().toLowerCase();
    return [...this.rows.values()]
      .filter((r) => filter.sourceIds.includes(r.sourceId))
      .filter((r) => !filter.localityId || r.localityId === filter.localityId)
      .filter((r) => !text || r.title.toLowerCase().includes(text) || (r.developerName ?? "").toLowerCase().includes(text))
      .sort((a, b) => (b.lastSeenAt ?? b.discoveredAt).localeCompare(a.lastSeenAt ?? a.discoveredAt))
      .slice(0, clampLimit(filter.limit, 20, 50))
      .map((r) => structuredClone(r));
  }

  async upsertMany(listings: ExternalListing[]): Promise<ExternalListing[]> {
    const out: ExternalListing[] = [];
    for (const l of listings) {
      const existing =
        this.rows.get(l.id) ??
        [...this.rows.values()].find((r) => r.sourceId === l.sourceId && l.sourceRecordId !== null && r.sourceRecordId === l.sourceRecordId);
      const id = existing?.id ?? l.id;
      // Like Supabase: an update keeps the first-discovery date.
      const merged: ExternalListing = existing
        ? { ...structuredClone(l), id, discoveredAt: existing.discoveredAt, isSample: l.isSample }
        : structuredClone(l);
      this.rows.set(id, merged);
      out.push(structuredClone(merged));
    }
    return out;
  }
}
