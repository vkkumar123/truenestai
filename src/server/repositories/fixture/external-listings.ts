import "server-only";
import type { ExternalListing } from "@/domain/types";
import type { ExternalListingRepository } from "../types";

/** In-memory store, per server process (dev/test only). */
export class FixtureExternalListingRepository implements ExternalListingRepository {
  private readonly rows = new Map<string, ExternalListing>();

  async getById(id: string): Promise<ExternalListing | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async upsertMany(listings: ExternalListing[]): Promise<ExternalListing[]> {
    const out: ExternalListing[] = [];
    for (const l of listings) {
      const existing = [...this.rows.values()].find(
        (r) => r.sourceId === l.sourceId && l.sourceRecordId !== null && r.sourceRecordId === l.sourceRecordId,
      );
      const id = existing?.id ?? l.id;
      const merged: ExternalListing = existing
        ? { ...l, id, discoveredAt: existing.discoveredAt, isSample: l.isSample }
        : structuredClone(l);
      this.rows.set(id, merged);
      out.push(structuredClone(merged));
    }
    return out;
  }
}
