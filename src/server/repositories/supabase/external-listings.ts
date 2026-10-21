import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExternalListing } from "@/domain/types";
import type { ExternalListingRepository } from "../types";
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
