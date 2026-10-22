// Data freshness classification for locality coverage, infrastructure and amenity records.

export type FreshnessState = "fresh" | "aging" | "stale" | "never_checked";

export interface FreshnessThresholds {
  /** Age in days up to which data is "fresh" (inclusive). */
  freshDays: number;
  /** Age in days up to which data is "aging" (inclusive); older is "stale". */
  staleDays: number;
}

export const DEFAULT_FRESHNESS_THRESHOLDS: FreshnessThresholds = { freshDays: 30, staleDays: 90 };

const DAY_MS = 86_400_000;

export function freshnessState(
  lastCheckedAt: string | Date | null | undefined,
  now: Date = new Date(),
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
): FreshnessState {
  const { freshDays, staleDays } = thresholds;
  if (!(freshDays >= 0 && staleDays >= freshDays)) {
    throw new RangeError("thresholds must satisfy 0 <= freshDays <= staleDays");
  }
  if (lastCheckedAt === null || lastCheckedAt === undefined || lastCheckedAt === "") {
    return "never_checked";
  }
  const checked = lastCheckedAt instanceof Date ? lastCheckedAt : new Date(lastCheckedAt);
  if (Number.isNaN(checked.getTime())) throw new TypeError(`invalid lastCheckedAt: ${String(lastCheckedAt)}`);

  // Future timestamps (clock skew) count as age 0.
  const ageDays = Math.max(0, now.getTime() - checked.getTime()) / DAY_MS;
  if (ageDays <= freshDays) return "fresh";
  if (ageDays <= staleDays) return "aging";
  return "stale";
}
