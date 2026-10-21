// Client-safe search option lists shared by the search UI and src/server/services/search.ts.
import type { ConstructionStatus } from "./types";

/** BHK filter values. "5+" matches 5 or more bedrooms. Matched against unit labels like "2 BHK". */
export const BHK_OPTIONS = ["1", "2", "3", "4", "5+"] as const;
export type BhkOption = (typeof BHK_OPTIONS)[number];

/** Construction-status filter values ("unknown" is not filterable: it means not found yet). */
export const CONSTRUCTION_STATUS_OPTIONS = [
  "pre_launch",
  "under_construction",
  "ready_to_move",
  "completed",
  "stalled",
] as const satisfies readonly ConstructionStatus[];
export type ConstructionStatusOption = (typeof CONSTRUCTION_STATUS_OPTIONS)[number];

export const CONSTRUCTION_STATUS_LABELS: Record<ConstructionStatusOption, string> = {
  pre_launch: "Pre-launch",
  under_construction: "Under construction",
  ready_to_move: "Ready to move",
  completed: "Completed",
  stalled: "Stalled",
};

/** all = researched first, external only when researched results are few; researched = Lane A only; external = Lane B only. */
export const SEARCH_LANES = ["all", "researched", "external"] as const;
export type SearchLane = (typeof SEARCH_LANES)[number];

/** Bedroom count parsed from a unit label ("2 BHK", "3BHK + study"), or null (e.g. "Plot"). */
export function bhkFromLabel(label: string): number | null {
  const m = /^\s*(\d+)\s*BHK\b/i.exec(label);
  return m ? Number(m[1]) : null;
}

export function bhkMatches(label: string, bhk: BhkOption): boolean {
  const n = bhkFromLabel(label);
  if (n === null) return false;
  return bhk === "5+" ? n >= 5 : n === Number(bhk);
}
