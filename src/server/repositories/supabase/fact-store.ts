import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FACTS_CURRENT_COLUMNS,
  factAttributeSchema,
  factEntityIdSchema,
  factEntityTypeSchema,
  mapFactsCurrentRow,
  type CurrentFact,
  type FactEntityType,
} from "../fact-store";
import type { FactStoreRepository } from "../types";

/**
 * Read-only facts_current access. Service role only (the view and its tables have no
 * anon/authenticated grants). Never pass rows to client components unfiltered: requiresReview
 * and truth must be honoured by whatever renders them (constitution §2, C7).
 */
export class SupabaseFactStoreRepository implements FactStoreRepository {
  constructor(private readonly db: () => SupabaseClient) {}

  async listCurrent(entityType: FactEntityType, entityId: string): Promise<CurrentFact[]> {
    const { data, error } = await this.db()
      .from("facts_current")
      .select(FACTS_CURRENT_COLUMNS)
      .eq("entity_type", factEntityTypeSchema.parse(entityType))
      .eq("entity_id", factEntityIdSchema.parse(entityId))
      .order("attribute", { ascending: true });
    if (error) throw new Error(`facts_current read failed (${error.code ?? "unknown"})`);
    return (data ?? []).map(mapFactsCurrentRow);
  }

  async getCurrent(entityType: FactEntityType, entityId: string, attribute: string): Promise<CurrentFact | null> {
    const { data, error } = await this.db()
      .from("facts_current")
      .select(FACTS_CURRENT_COLUMNS)
      .eq("entity_type", factEntityTypeSchema.parse(entityType))
      .eq("entity_id", factEntityIdSchema.parse(entityId))
      .eq("attribute", factAttributeSchema.parse(attribute))
      .maybeSingle();
    if (error) throw new Error(`facts_current read failed (${error.code ?? "unknown"})`);
    return data ? mapFactsCurrentRow(data) : null;
  }
}
