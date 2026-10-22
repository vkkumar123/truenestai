import "server-only";
import type { FactValue, Project } from "@/domain/types";
import { listMarketPhases, listZones, listLocalities } from "@/config/markets";
import { SOURCE_REGISTRY } from "@/discovery/registry";
import { SAMPLE_PROJECTS } from "../repositories/fixture/sample-projects";

// Builds the idempotent seed SQL from the in-repo sources of truth:
//   reference: market geography (src/config/markets) + source registry (src/discovery/registry)
//              → upserted (`on conflict (id) do update`): the repo config always wins.
//   sample:    the fictional SAMPLE projects (repositories/fixture/sample-projects.ts), is_sample
//              true, published exactly as in the fixtures → `on conflict do nothing`, so re-running
//              never overwrites rows staff have since edited in a dev/staging database.
// Deterministic ids make re-runs no-ops. Output is committed as supabase/seed/*.sql by
// `npm run db:seed:generate`; a unit test fails if the committed file drifts from this builder.

export interface SeedOptions {
  /** Include the fictional SAMPLE projects (default true). Reference data is always included. */
  sample?: boolean;
}

type SqlValue = string | number | boolean | null | undefined | SqlRaw;
class SqlRaw {
  constructor(readonly sql: string) {}
}

/** SQL literal. Strings are single-quoted with quotes doubled (standard_conforming_strings). */
export function lit(v: SqlValue): string {
  if (v instanceof SqlRaw) return v.sql;
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in seed");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v.includes("\u0000")) throw new Error("NUL byte in seed string");
  return `'${v.replace(/'/g, "''")}'`;
}

const textArray = (xs: readonly string[]) => new SqlRaw(xs.length ? `array[${xs.map(lit).join(", ")}]::text[]` : "'{}'::text[]");
const jsonb = (v: unknown) => new SqlRaw(`${lit(JSON.stringify(v))}::jsonb`);

function insert(table: string, rows: Record<string, SqlValue>[], conflict: string): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const values = rows.map((r) => `  (${cols.map((c) => lit(r[c])).join(", ")})`).join(",\n");
  return `insert into public.${table} (${cols.join(", ")}) values\n${values}\n${conflict};\n`;
}

function upsert(table: string, rows: Record<string, SqlValue>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]).filter((c) => c !== "id");
  return insert(table, rows, `on conflict (id) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`);
}

const DB_FIELD = {
  address: "address",
  reraNumbers: "rera_numbers",
  constructionStatus: "construction_status",
  declaredPossession: "declared_possession",
} as const;

function referenceSql(): string {
  const phases = listMarketPhases().map((p) => ({ id: p.id, name: p.name, sort_order: p.order, active: p.active }));
  const zones = listZones().map((z) => ({
    id: z.id,
    phase_id: z.phaseId,
    name: z.name,
    boundary: jsonb(z.boundary),
    boundary_approval: z.boundaryApproval,
    assumptions: textArray(z.assumptions),
  }));
  const localities = listLocalities().map((l) => ({
    id: l.id,
    zone_id: l.zoneId,
    name: l.name,
    centroid_lat: l.centroid.lat,
    centroid_lng: l.centroid.lng,
    aliases: textArray(l.aliases),
    boundary: l.boundary ? jsonb(l.boundary) : null,
  }));
  const sources = SOURCE_REGISTRY.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    status: s.status,
    access_method: s.accessMethod,
    homepage: s.homepage,
    terms_reviewed_at: s.termsReviewedAt,
    rate_limit_per_minute: s.rateLimitPerMinute,
    storage_permissions: textArray(s.storagePermissions),
    allowed_environments: textArray(s.allowedEnvironments),
    listing_limitations: textArray(s.listingLimitations),
    notes: s.notes,
  }));
  return [
    "-- Reference data: market geography + source registry (upserted; repo config wins).",
    upsert("market_phases", phases),
    upsert("zones", zones),
    upsert("localities", localities),
    upsert("sources", sources),
  ].join("\n");
}

interface SampleRows {
  developers: Record<string, SqlValue>[];
  projects: Record<string, SqlValue>[];
  units: Record<string, SqlValue>[];
  facts: Record<string, SqlValue>[];
  factSources: Record<string, SqlValue>[];
  regulatory: Record<string, SqlValue>[];
  searches: Record<string, SqlValue>[];
  documents: Record<string, SqlValue>[];
}

function addFact(rows: SampleRows, id: string, projectId: string, unitId: string | null, field: string, f: FactValue<unknown>) {
  rows.facts.push({
    id,
    project_id: projectId,
    unit_id: unitId,
    field,
    value: f.status === "known" ? jsonb(f.value) : null,
    status: f.status,
    verification: f.verification,
    is_current: true,
  });
  f.sources.forEach((s, j) =>
    rows.factSources.push({
      id: `${id}:s${j + 1}`,
      fact_id: id,
      source_id: s.sourceId,
      url: s.url,
      observed_at: s.observedAt,
      document_date: s.documentDate ?? null,
      note: s.note ?? null,
    }),
  );
}

function sampleRows(projects: readonly Project[]): SampleRows {
  const rows: SampleRows = { developers: [], projects: [], units: [], facts: [], factSources: [], regulatory: [], searches: [], documents: [] };
  const devs = new Map<string, Project["developer"]>();
  for (const p of projects) {
    if (!p.isSample || !p.name.startsWith("SAMPLE")) throw new Error(`refusing to seed non-SAMPLE project ${p.id}`);
    devs.set(p.developer.id, p.developer);
    rows.projects.push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      developer_id: p.developer.id,
      locality_id: p.localityId,
      lat: p.location.lat,
      lng: p.location.lng,
      location_precision: p.location.precision,
      review_flags: textArray(p.reviewFlags),
      completeness: p.completeness,
      last_checked_at: p.lastCheckedAt,
      is_sample: true,
      published: p.published,
    });
    for (const [key, field] of Object.entries(DB_FIELD) as [keyof typeof DB_FIELD, string][]) {
      addFact(rows, `${p.id}:${field}`, p.id, null, field, p[key] as FactValue<unknown>);
    }
    p.units.forEach((u, i) => {
      const unitId = `${p.id}:u${i + 1}`;
      rows.units.push({ id: unitId, project_id: p.id, label: u.label, sort_order: i });
      addFact(rows, `${unitId}:carpet`, p.id, unitId, "unit_carpet_area_sqft", u.carpetAreaSqft);
      addFact(rows, `${unitId}:price`, p.id, unitId, "unit_price_inr", u.priceInr);
    });
    for (const r of p.regulatoryRecords) {
      rows.regulatory.push({
        id: r.id,
        project_id: p.id,
        kind: r.kind,
        reference: r.reference,
        summary: r.summary,
        status_status: r.status.status,
        status_value: r.status.status === "known" ? r.status.value : null,
        status_verification: r.status.verification,
        source_id: r.source.sourceId,
        source_url: r.source.url,
        observed_at: r.source.observedAt,
        document_date: r.source.documentDate ?? null,
        verification: r.verification,
      });
    }
    p.regulatorySearches.forEach((s, i) =>
      rows.searches.push({
        id: `${p.id}:search${i + 1}`,
        project_id: p.id,
        kind: s.kind,
        source_id: s.sourceId,
        url: s.url,
        searched_at: s.searchedAt,
        results_found: s.resultsFound,
      }),
    );
    for (const d of p.documents) {
      rows.documents.push({
        id: d.id,
        project_id: p.id,
        document_key: d.id,
        title: d.title,
        kind: d.kind,
        version: d.version,
        document_date: d.documentDate,
        source_id: d.source.sourceId,
        source_url: d.source.url,
        observed_at: d.source.observedAt,
        storage_path: null, // SAMPLE documents have no stored file
      });
    }
  }
  rows.developers = [...devs.values()].map((d) => {
    if (!d.isSample) throw new Error(`refusing to seed non-sample developer ${d.id}`);
    return { id: d.id, name: d.name, is_sample: true };
  });
  return rows;
}

function sampleSql(projects: readonly Project[]): string {
  const r = sampleRows(projects);
  const nothing = "on conflict do nothing";
  return [
    "-- FICTIONAL SAMPLE projects (is_sample = true; published as in the fixtures). Never real data.",
    "-- `on conflict do nothing`: re-running never overwrites rows edited since.",
    insert("developers", r.developers, nothing),
    insert("projects", r.projects, nothing),
    insert("project_units", r.units, nothing),
    insert("facts", r.facts, nothing),
    insert("fact_sources", r.factSources, nothing),
    insert("regulatory_records", r.regulatory, nothing),
    insert("regulatory_searches", r.searches, nothing),
    insert("project_documents", r.documents, nothing),
  ].join("\n");
}

export const SEED_HEADER =
  "-- GENERATED by `npm run db:seed:generate` (scripts/generate-seed.ts → src/server/db/seed.ts). DO NOT EDIT.\n" +
  "-- Idempotent: safe to apply repeatedly (npm run db:seed).\n";

export function buildSeedSql(opts: SeedOptions = {}, projects: readonly Project[] = SAMPLE_PROJECTS): string {
  const parts = [SEED_HEADER, "begin;\n", referenceSql()];
  if (opts.sample !== false) parts.push(sampleSql(projects));
  parts.push("commit;\n");
  return parts.join("\n");
}
