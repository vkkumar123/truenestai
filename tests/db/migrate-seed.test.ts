// M2: migration runner (ledger, idempotence, checksum guard), generated seed (counts, RLS
// visibility, idempotence) and R4 parity of SQL readiness/completeness with src/research/publish.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { Client } from "pg";
import { asRole, errorAs, migrationFiles, REPO_ROOT, resetSchemas, tryConnect } from "./helpers";

vi.mock("server-only", () => ({}));

const { migrate, MigrationError } = await import("@/server/db/migrate");
const { SAMPLE_PROJECTS } = await import("@/server/repositories/fixture/sample-projects");
const { listLocalities, listMarketPhases, listZones } = await import("@/config/markets");
const { SOURCE_REGISTRY } = await import("@/discovery/registry");
const { computeCompleteness, evaluatePublishReadiness } = await import("@/research/publish");

const conn = await tryConnect();
if (!conn.client) console.warn(`[test:db] SKIPPED migrate-seed: ${conn.reason}`);
const d = conn.client ? describe : describe.skip;

const MIGRATIONS = path.join(REPO_ROOT, "supabase/migrations");
const SEED = path.join(REPO_ROOT, "supabase/seed/seed.sql");
const REFERENCE = path.join(REPO_ROOT, "supabase/seed/reference.sql");

const count = async (c: Client, table: string) => (await c.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;

d("migration runner + seed", () => {
  const c = conn.client as Client;

  beforeAll(async () => {
    await resetSchemas(c);
  });
  afterAll(async () => {
    await c?.end();
  });

  it("applies every migration once, with a ledger, then the seed", async () => {
    const r = await migrate(c, { migrationsDir: MIGRATIONS, seedFiles: [SEED], sampleSeed: true });
    // Every file in supabase/migrations, in order.
    const all = migrationFiles().map((f) => path.basename(f));
    expect(all.slice(0, 7)).toEqual(["0001_core.sql", "0002_research_audit.sql", "0003_m2_live.sql", "0004_m2_review.sql", "0005_research_jobs.sql", "0006_fact_store.sql", "0007_document_extraction.sql"]);
    expect(all).toContain("0008_developments.sql");
    expect(r.applied).toEqual(all);
    expect(r.seeded).toEqual(["seed.sql"]);
    const ledger = (await c.query("select name, length(checksum) as len from private.schema_migrations order by name")).rows;
    expect(ledger).toEqual(r.applied.map((name) => ({ name, len: 64 })));
  });

  it("re-running is a no-op (migrations skipped, seed idempotent)", async () => {
    const before = await Promise.all(["projects", "facts", "fact_sources", "sources", "localities"].map((t) => count(c, t)));
    const r = await migrate(c, { migrationsDir: MIGRATIONS, seedFiles: [SEED, REFERENCE], sampleSeed: true });
    expect(r.applied).toEqual([]);
    expect(r.skipped).toHaveLength(migrationFiles().length);
    const after = await Promise.all(["projects", "facts", "fact_sources", "sources", "localities"].map((t) => count(c, t)));
    expect(after).toEqual(before);
  });

  it("refuses an applied migration whose content changed", async () => {
    await c.query("update private.schema_migrations set checksum = repeat('0', 64) where name = '0002_research_audit.sql'");
    await expect(migrate(c, { migrationsDir: MIGRATIONS })).rejects.toBeInstanceOf(MigrationError);
    const { rows } = await c.query("select checksum from private.schema_migrations where name = '0001_core.sql'");
    await c.query("update private.schema_migrations set checksum = $1 where name = '0002_research_audit.sql'", [
      (await import("@/server/db/migrate")).sha256(
        (await import("node:fs")).readFileSync(path.join(MIGRATIONS, "0002_research_audit.sql"), "utf8"),
      ),
    ]);
    expect(rows).toHaveLength(1);
    expect((await migrate(c, { migrationsDir: MIGRATIONS })).applied).toEqual([]);
  });

  it("seeds geography + the full source registry from repo config", async () => {
    expect(await count(c, "market_phases")).toBe(listMarketPhases().length);
    expect(await count(c, "zones")).toBe(listZones().length);
    expect(await count(c, "localities")).toBe(listLocalities().length);
    const ids = (await c.query("select id, status from sources order by id")).rows;
    expect(ids).toEqual([...SOURCE_REGISTRY].map((s) => ({ id: s.id, status: s.status })).sort((a, b) => a.id.localeCompare(b.id)));
  });

  it("seeds only SAMPLE projects, published exactly as in the fixtures", async () => {
    const rows = (await c.query("select id, name, is_sample, published from projects order by id")).rows;
    expect(rows).toHaveLength(SAMPLE_PROJECTS.length);
    for (const p of SAMPLE_PROJECTS) {
      expect(rows.find((r) => r.id === p.id)).toEqual({ id: p.id, name: p.name, is_sample: true, published: p.published });
    }
    expect(rows.every((r) => String(r.name).startsWith("SAMPLE"))).toBe(true);
    const urls = (await c.query("select url from fact_sources where url is not null")).rows.map((r) => String(r.url));
    expect(urls.every((u) => /^https:\/\/example\.(com|org)\//.test(u))).toBe(true);
  });

  it("anon sees only published sample projects and their children (RLS)", async () => {
    const published = SAMPLE_PROJECTS.filter((p) => p.published).map((p) => p.id).sort();
    const r = await asRole(c, "anon", null, async (q) => ({
      projects: (await q.query("select id from projects order by id")).rows.map((x) => x.id),
      factProjects: [...new Set((await q.query("select project_id from facts")).rows.map((x) => x.project_id))].sort(),
      index: (await q.query("select id from project_search_index order by id")).rows.map((x) => x.id),
    }));
    expect(r.projects).toEqual(published);
    expect(r.factProjects).toEqual(published);
    expect(r.index).toEqual(published);
    expect(published.length).toBeLessThan(SAMPLE_PROJECTS.length); // at least one draft stays hidden
  });

  it("M1: production marker refuses the SAMPLE seed (runner and seed.sql itself); marking refuses SAMPLE data", async () => {
    // A database that already holds SAMPLE projects cannot be marked production.
    await expect(migrate(c, { migrationsDir: MIGRATIONS, markEnvironment: "production" })).rejects.toThrow(/contains SAMPLE projects/);
    await expect(migrate(c, { migrationsDir: MIGRATIONS, markEnvironment: "production", sampleSeed: true, seedFiles: [SEED] }))
      .rejects.toThrow(/being marked production/);
    await c.query("begin");
    try {
      await c.query("delete from projects where is_sample; delete from developers where is_sample");
      await c.query("insert into private.settings (key, value) values ('environment', 'production')");
      await expect(migrate(c, { migrationsDir: MIGRATIONS, seedFiles: [SEED], sampleSeed: true })).rejects.toThrow(/marked production/);
      await c.query("savepoint s");
      // even applying seed.sql directly (psql / SQL editor) is refused
      await expect(c.query((await import("node:fs")).readFileSync(SEED, "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "")))
        .rejects.toThrow(/SAMPLE seed refused/);
      await c.query("rollback to savepoint s");
      expect(await count(c, "projects")).toBe(0);
    } finally {
      await c.query("rollback");
    }
    // the reference seed stays allowed on production
    await c.query("begin");
    try {
      await c.query("insert into private.settings (key, value) values ('environment', 'production')");
      await c.query((await import("node:fs")).readFileSync(REFERENCE, "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
    } finally {
      await c.query("rollback");
    }
    expect((await c.query("select count(*)::int as n from private.settings")).rows[0].n).toBe(0);
    expect((await errorAs(c, "authenticated", null, "select * from private.settings"))?.code).toBe("42501");
  });

  it("0006 L1: marking production is refused while SAMPLE fact observations remain, even after SAMPLE projects are gone", async () => {
    await c.query("begin");
    try {
      const p = SAMPLE_PROJECTS[0];
      await c.query(
        `insert into fact_observations (entity_type, entity_id, attribute, status, source_id, source_type, observed_at, last_verified_at, ttl_hours, added_by, is_sample)
         values ('project', $1, 'oc_status', 'unknown', 'sample-feed', 'search', now(), now(), 72, 'research', true)`,
        [p.id],
      );
      await c.query("delete from projects where is_sample; delete from developers where is_sample");
      await expect(migrate(c, { migrationsDir: MIGRATIONS, markEnvironment: "production" })).rejects.toThrow(/SAMPLE fact observations/);
    } finally {
      await c.query("rollback");
    }
  });

  it("L5: reference seed carries no fixture sources; the SAMPLE seed adds them", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(REFERENCE, "utf8")).not.toMatch(/'fixture'/);
    expect(readFileSync(SEED, "utf8")).toMatch(/'sample-feed'/);
  });

  // R4: SQL readiness/completeness must equal the TS rules on fixture-shaped projects.
  async function compareAll(variant: string, mutate: (p: (typeof SAMPLE_PROJECTS)[number]) => (typeof SAMPLE_PROJECTS)[number]) {
    const projects = SAMPLE_PROJECTS.map((p) => mutate(structuredClone(p)));
    for (const p of projects) {
      const { rows } = await c.query("select public.tn_publish_blockers($1) as b, public.tn_compute_completeness($1)::float8 as c", [p.id]);
      const ts = evaluatePublishReadiness(p);
      expect({ variant, id: p.id, blockers: rows[0].b, completeness: rows[0].c }).toEqual({
        variant, id: p.id, blockers: ts.blockers, completeness: computeCompleteness(p),
      });
    }
  }

  it("R4: tn_publish_blockers / tn_compute_completeness match evaluatePublishReadiness on every SAMPLE project", async () => {
    await compareAll("as seeded", (p) => p);
    const stored = (await c.query("select id, completeness::float8 as c from projects")).rows;
    for (const p of SAMPLE_PROJECTS) expect(stored.find((r) => r.id === p.id)?.c).toBe(p.completeness);
  });

  it("R4: parity holds after verification, dispute, source and unit changes", async () => {
    await c.query("begin");
    try {
      // 1) every RERA fact reviewed; 2) every address disputed; 3) sources removed from possession;
      // 4) all unit prices unknown.
      // 0006: verification changes only inside the audited RPCs (tn.via_rpc); this test stages states directly
      await c.query("select set_config('tn.via_rpc', 'on', true)");
      await c.query("update facts set verification = 'reviewed' where field = 'rera_numbers' and is_current");
      await c.query("update facts set verification = 'disputed' where field = 'address' and is_current");
      await c.query("delete from fact_sources where fact_id in (select id from facts where field = 'declared_possession')");
      // 0006 guard: a fact's value/status never change in place, so supersede with a new current row.
      await c.query(`
        with old as (
          update facts set is_current = false where field = 'unit_price_inr' and is_current
          returning project_id, unit_id, field, verification)
        insert into facts (project_id, unit_id, field, value, status, verification)
          select project_id, unit_id, field, null, 'unknown', verification from old`);
      await compareAll("mutated", (p) => {
        p.reraNumbers.verification = "reviewed";
        p.address.verification = "disputed";
        p.declaredPossession.sources = [];
        p.units = p.units.map((u) => ({ ...u, priceInr: { ...u.priceInr, status: "unknown", value: null } }));
        return p;
      });
    } finally {
      await c.query("rollback");
    }
  });
});
