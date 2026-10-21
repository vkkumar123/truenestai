import { z } from "zod";

// Market geography config schemas. All geometry is approximate unless stated otherwise.
// GeoJSON order: positions are [lng, lat].

export const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const idSchema = z.string().regex(KEBAB_ID, "id must be kebab-case");

const positionSchema = z.tuple([
  z.number().min(-180).max(180), // lng
  z.number().min(-90).max(90), // lat
]);

const linearRingSchema = z
  .array(positionSchema)
  .min(4, "a ring needs at least 4 positions (closed triangle)")
  .refine((ring) => {
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  }, "ring must be closed (first position equals last)");

export const polygonSchema = z.object({
  type: z.literal("Polygon"),
  // coordinates[0] = outer ring, coordinates[1..] = holes
  coordinates: z.array(linearRingSchema).min(1),
});

export const boundaryApprovalSchema = z.enum(["pending_owner_approval", "approved"]);

export const marketPhaseSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  order: z.number().int().positive(),
  active: z.boolean(),
});

export const zoneSchema = z.object({
  id: idSchema,
  phaseId: idSchema,
  name: z.string().min(1),
  boundary: polygonSchema,
  boundaryApproval: boundaryApprovalSchema,
  assumptions: z.array(z.string().min(1)).min(1),
});

export const localityCentroidSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  precision: z.literal("locality_centroid"),
});

export const dataCoverageSchema = z.object({
  sourceIds: z.array(z.string().min(1)),
  completeness: z.number().min(0).max(1),
  lastCheckedAt: z.iso.datetime({ offset: true }).nullable(),
});

export const localitySchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  zoneId: idSchema,
  centroid: localityCentroidSchema,
  aliases: z.array(z.string().min(1)),
  boundary: polygonSchema.nullable().optional(),
  dataCoverage: dataCoverageSchema,
});

export const marketConfigSchema = z.object({
  phases: z.array(marketPhaseSchema).min(1),
  zones: z.array(zoneSchema),
  localities: z.array(localitySchema),
});

export type Polygon = z.infer<typeof polygonSchema>;
export type BoundaryApproval = z.infer<typeof boundaryApprovalSchema>;
export type MarketPhase = z.infer<typeof marketPhaseSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type Locality = z.infer<typeof localitySchema>;
export type DataCoverage = z.infer<typeof dataCoverageSchema>;
export type MarketConfig = z.infer<typeof marketConfigSchema>;

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/**
 * Parses and cross-validates a market config. Throws on any problem.
 * Rules: schema-valid; unique ids per kind; zone.phaseId exists; locality.zoneId exists;
 * phase `order` unique; inactive phases carry no localities (they must not be collected).
 */
export function validateMarketConfig(raw: unknown): MarketConfig {
  const config = marketConfigSchema.parse(raw);
  const errors: string[] = [];

  for (const [kind, ids] of [
    ["phase", config.phases.map((p) => p.id)],
    ["zone", config.zones.map((z) => z.id)],
    ["locality", config.localities.map((l) => l.id)],
  ] as const) {
    for (const d of duplicates([...ids])) errors.push(`duplicate ${kind} id: ${d}`);
  }
  for (const d of duplicates(config.phases.map((p) => String(p.order)))) {
    errors.push(`duplicate phase order: ${d}`);
  }

  const phases = new Map(config.phases.map((p) => [p.id, p]));
  const zones = new Map(config.zones.map((z) => [z.id, z]));

  for (const zone of config.zones) {
    if (!phases.has(zone.phaseId)) errors.push(`zone ${zone.id}: unknown phase ${zone.phaseId}`);
  }
  for (const loc of config.localities) {
    const zone = zones.get(loc.zoneId);
    if (!zone) {
      errors.push(`locality ${loc.id}: unknown zone ${loc.zoneId}`);
      continue;
    }
    const phase = phases.get(zone.phaseId);
    if (phase && !phase.active) {
      errors.push(`locality ${loc.id}: belongs to inactive phase ${phase.id}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid market config:\n- ${errors.join("\n- ")}`);
  }
  return config;
}
