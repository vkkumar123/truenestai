import { MARKET_CONFIG } from "./data";
import { validateMarketConfig, type Locality, type MarketPhase, type Zone } from "./schema";

export * from "./schema";

// Validate at module load: an invalid config must fail fast.
const config = validateMarketConfig(MARKET_CONFIG);

const phaseById = new Map(config.phases.map((p) => [p.id, p]));
const zoneById = new Map(config.zones.map((z) => [z.id, z]));
const localityById = new Map(config.localities.map((l) => [l.id, l]));

export interface LocalityFilter {
  zoneId?: string;
  phaseId?: string;
  activeOnly?: boolean;
}

export function listMarketPhases(): MarketPhase[] {
  return [...config.phases].sort((a, b) => a.order - b.order);
}

export function getActiveMarketPhases(): MarketPhase[] {
  return listMarketPhases().filter((p) => p.active);
}

export function getZone(id: string): Zone | undefined {
  return zoneById.get(id);
}

export function listZones(): Zone[] {
  return [...config.zones];
}

export function getLocality(id: string): Locality | undefined {
  return localityById.get(id);
}

function phaseOfLocality(loc: Locality): MarketPhase | undefined {
  const zone = zoneById.get(loc.zoneId);
  return zone ? phaseById.get(zone.phaseId) : undefined;
}

export function listLocalities(filter: LocalityFilter = {}): Locality[] {
  return config.localities.filter((loc) => {
    if (filter.zoneId && loc.zoneId !== filter.zoneId) return false;
    const phase = phaseOfLocality(loc);
    if (filter.phaseId && phase?.id !== filter.phaseId) return false;
    if (filter.activeOnly && !phase?.active) return false;
    return true;
  });
}

/** True only for a configured locality whose phase is active (i.e. may be collected). */
export function isActiveLocality(id: string): boolean {
  const loc = localityById.get(id);
  return loc ? phaseOfLocality(loc)?.active === true : false;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Case-insensitive match on locality name and aliases. Matches when the query is part of a
 * name/alias ("thani" -> Thanisandra) or a whole name/alias appears in the query
 * ("2bhk near Hebbal" -> Hebbal). Exact matches are returned first.
 */
export function findLocalitiesByText(text: string): Locality[] {
  const q = normalize(text);
  if (q.length < 2) return [];
  const padded = ` ${q} `;
  const scored: Array<{ loc: Locality; score: number }> = [];
  for (const loc of config.localities) {
    let best = 0;
    for (const term of [loc.name, ...loc.aliases].map(normalize)) {
      if (term === q) best = Math.max(best, 3);
      else if (padded.includes(` ${term} `)) best = Math.max(best, 2);
      else if (term.includes(q)) best = Math.max(best, 1);
    }
    if (best > 0) scored.push({ loc, score: best });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.loc.name.localeCompare(b.loc.name))
    .map((s) => s.loc);
}
