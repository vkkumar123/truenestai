import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExternalListing } from "@/domain/types";
import { clampLimit, type ExternalListingRepository, type StoredListingFilter } from "../types";
import { externalListingToRow, mapExternalListingRow, type ExternalListingRow } from "./mappers";

/** Reads use the anon client; upserts need the service-role client (workers only). */
export class SupabaseExternalListingRepository implements ExternalListingRepository {
  constructor(
    private readonly reader: SupabaseClient,
    private readonly writer: () => SupabaseClient,
  ) {}

  async getById(id: string): Promise<ExternalListing | null> {
    const { data, error } = await this.reader.from("external_listings").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(`getById failed: ${error.message}`);
    return data ? mapExternalListingRow(data as ExternalListingRow) : null;
  }

  async search(filter: StoredListingFilter): Promise<ExternalListing[]> {
    if (!filter.sourceIds.length) return [];
    let q = this.reader.from("external_listings").select("*").in("source_id", filter.sourceIds);
    if (filter.localityId) q = q.eq("locality_id", filter.localityId);
    const text = filter.text?.trim();
    if (text) {
      // Escape LIKE wildcards and PostgREST or() syntax characters.
      const t = text.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/[,()"]/g, " ");
      q = q.or(`title.ilike.%${t}%,developer_name.ilike.%${t}%`);
    }
    const { data, error } = await q
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(clampLimit(filter.limit, 20, 50));
    if (error) throw new Error(`search failed: ${error.message}`);
    return (data as ExternalListingRow[]).map(mapExternalListingRow);
  }

  async upsertMany(listings: ExternalListing[]): Promise<ExternalListing[]> {
    if (!listings.length) return [];
    // discovered_at is omitted so an update keeps the first-discovery date (insert defaults to now()).
    const rows = listings.map((l) => {
      const row: Partial<ReturnType<typeof externalListingToRow>> = externalListingToRow(l);
      delete row.discovered_at;
      return row;
    });
    const { data, error } = await this.writer()
      .from("external_listings")
      .upsert(rows, { onConflict: "id" })
      .select("*");
    if (error) throw new Error(`upsertMany failed: ${error.message}`);
    return (data as ExternalListingRow[]).map(mapExternalListingRow);
  }
}
