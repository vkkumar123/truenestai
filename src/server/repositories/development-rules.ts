// Publish readiness for a development. KEEP IN SYNC with tn_development_publish_blockers in
// supabase/migrations/0008_developments.sql (a unit test compares the messages). Pure.
import type { Development } from "@/domain/types";

export const DEVELOPMENT_BLOCKERS = {
  authority: "authority: not yet found",
  sourceUrl: "source: no https link",
  observedAt: "source: no observed date",
} as const;

/** Why a development may not be published yet (empty = ready). */
export function developmentPublishBlockers(d: Pick<Development, "authority" | "sourceUrl" | "sourceObservedAt">): string[] {
  const b: string[] = [];
  if (!d.authority) b.push(DEVELOPMENT_BLOCKERS.authority);
  if (!d.sourceUrl) b.push(DEVELOPMENT_BLOCKERS.sourceUrl);
  if (!d.sourceObservedAt) b.push(DEVELOPMENT_BLOCKERS.observedAt);
  return b;
}
