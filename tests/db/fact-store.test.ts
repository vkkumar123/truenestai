// S1a fact store (0006_fact_store.sql): catalogue, fact_observations, append-only history,
// facts_current precedence + conflicts + is_stale, curated-facts backfill and guard.
// Every row here is fictional SAMPLE data with example.com / example.org URLs.
// Run with `npm run test:db`.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { asRole, errorAs, migrationFiles, resetSchemas, tryConnect } from "./helpers";

vi.mock("server-only", () => ({}));
const { mapFactsCurrentRow } = await import("@/server/repositories/fact-store");

const conn = await tryConnect();
if (!conn.client) console.warn(`[test:db] SKIPPED fact-store: ${conn.reason}`);
const d = conn.client ? describe : describe.skip;

const STAFF_UID = "44444444-4444-4444-8444-444444444444";

/** One observation insert. `o` overrides the defaults (a known, official builder date). */
function obs(o: Record<string, string | number | null> = {}): { sql: string; params: unknown[] } {
  const row: Record<string, string | number | null> = {
    entity_type: "project",
    entity_id: "p1",
    attribute: "promised_possession",
    value_date: "2026-12-31",
    status: "official",
    source_id: "sample-builder",
    source_url: "https://example.com/sample/p1/possession",
    source_type: "builder",
    observed_at: "2026-09-01T00:00:00Z",
    last_verified_at: "2026-09-01T00:00:00Z",
    ttl_hours: 168,
    added_by: "crawl",
    is_sample: "true",
    ...o,
  };
  const cols = Object.keys(row);
  return {
    sql: `insert into fact_observations (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    params: cols.map((c) => row[c]),
  };
}

d("fact store (0006)", () => {
  const c = conn.client as Client;

  beforeAll(async () => {
    // Apply 0001–0005, add curated facts, then 0006 — so the backfill runs over existing rows.
    await resetSchemas(c);
    const files = migrationFiles();
    const last = files.findIndex((f) => f.endsWith("0006_fact_store.sql"));
    expect(last).toBeGreaterThan(0);
    for (const f of files.slice(0, last)) await c.query(readFileSync(f, "utf8"));
    await c.query(`
      insert into market_phases (id, name, sort_order, active) values ('north-bengaluru', 'North', 1, true);
      insert into zones (id, phase_id, name, boundary) values ('north-core', 'north-bengaluru', 'Z', '{}');
      insert into localities (id, zone_id, name, centroid_lat, centroid_lng) values ('hebbal', 'north-core', 'Hebbal', 13.03, 77.59);
      insert into developers (id, name, is_sample) values ('d1', 'SAMPLE Developer A', true);
      insert into projects (id, slug, name, developer_id, locality_id, lat, lng, location_precision, is_sample)
        values ('p1', 'sample-p1', 'SAMPLE P1', 'd1', 'hebbal', 13.03, 77.59, 'locality_centroid', true),
               ('p2', 'sample-p2', 'SAMPLE P2', 'd1', 'hebbal', 13.03, 77.59, 'locality_centroid', true);
      insert into sources (id, name, type, status, access_method, homepage) values
        ('sample-feed', 'SAMPLE Feed', 'fixture', 'approved', 'fixture', 'https://example.com/'),
        ('sample-builder', 'SAMPLE Builder Site', 'developer', 'proposed', 'manual', 'https://example.com/'),
        ('sample-regulator', 'SAMPLE Regulator', 'regulator', 'proposed', 'link_out_only', 'https://example.org/'),
        ('sample-news', 'SAMPLE News', 'news', 'proposed', 'manual', 'https://example.org/');
      insert into staff_profiles (user_id, role) values ('${STAFF_UID}', 'admin');
      -- pre-0006 curated facts: one per backfill rule
      insert into facts (id, project_id, field, value, status, verification) values
        ('f-dev',  'p2', 'declared_possession', '"2027-03 (SAMPLE)"', 'known', 'unverified'),
        ('f-news', 'p2', 'address', '"SAMPLE Road 2"', 'known', 'unverified'),
        ('f-unk',  'p2', 'construction_status', null, 'unknown', 'unverified');
      insert into fact_sources (fact_id, source_id, url, observed_at) values
        ('f-dev',  'sample-builder', 'https://example.com/sample/p2', '2026-08-01T00:00:00Z'),
        ('f-news', 'sample-news', 'https://example.org/sample/p2', '2026-08-02T00:00:00Z');
    `);
    await c.query(readFileSync(files[last], "utf8"));
  });
  afterAll(async () => {
    await c?.end();
  });

  it("backfills curated facts: developer/regulator/government → official, other → estimated, unknown stays unknown", async () => {
    const { rows } = await c.query(
      "select id, truth_status, last_verified_at::text as lv, ttl_hours from facts where project_id = 'p2' order by id",
    );
    expect(rows).toEqual([
      { id: "f-dev", truth_status: "official", lv: "2026-08-01 00:00:00+00", ttl_hours: null },
      { id: "f-news", truth_status: "estimated", lv: "2026-08-02 00:00:00+00", ttl_hours: null },
      { id: "f-unk", truth_status: "unknown", lv: null, ttl_hours: null },
    ]);
  });

  it("seeds the spec 02 attribute catalogue (metadata only) with proposed legal flags", async () => {
    const { rows } = await c.query("select entity_type, count(*)::int as n from fact_attributes group by 1 order by 1");
    expect(rows).toEqual([
      { entity_type: "development", n: 5 },
      { entity_type: "locality", n: 6 },
      { entity_type: "project", n: 28 },
    ]);
    const legal = (await c.query("select attribute from fact_attributes where legally_significant order by 1")).rows.map((r) => r.attribute);
    expect(legal).toEqual([
      "bank_approvals", "khata_type", "land_title_summary", "oc_status", "rera_complaints_count",
      "rera_completion_date", "rera_extension_count", "rera_registration_date", "rera_status",
    ]);
    expect((await c.query("select count(*)::int as n from fact_attributes where legal_flag_status <> 'proposed'")).rows[0].n).toBe(0);
    expect((await c.query("select attribute from fact_attributes where legacy_field = 'declared_possession'")).rows).toEqual([
      { attribute: "promised_possession" },
    ]);
    // no property data: the store starts empty
    expect((await c.query("select count(*)::int as n from fact_observations")).rows[0].n).toBe(0);
  });

  it("has RLS on every new table and no anon/authenticated access to tables or views", async () => {
    const { rows } = await c.query(
      "select relname, relrowsecurity from pg_class where relname in ('fact_attributes','fact_observations','fact_observations_history') order by 1",
    );
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(rows).toHaveLength(3);
    for (const role of ["anon", "authenticated"] as const) {
      const sub = role === "anon" ? null : STAFF_UID;
      for (const rel of ["fact_attributes", "fact_observations", "fact_observations_history", "facts_current", "facts_history"]) {
        expect((await errorAs(c, role, sub, `select * from ${rel}`))?.code, `${role} ${rel}`).toBe("42501");
      }
      const ins = obs({ added_by: "staff" });
      expect((await errorAs(c, role, sub, ins.sql, ins.params))?.code).toBe("42501");
    }
    // the catalogue is migration-managed: service role reads it but cannot change it
    expect((await errorAs(c, "service_role", null, "update fact_attributes set default_ttl_hours = 1"))?.code).toBe("42501");
  });

  it("conflict: builder vs RERA possession dates are both kept; the newer official row wins and the other is in conflicts", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      await q.query(obs().sql, obs().params); // builder: 2026-12-31, observed 2026-09-01
      const rera = obs({
        value_date: "2027-06-30", source_id: "sample-regulator", source_url: "https://example.org/sample/p1/rera-extension",
        source_type: "rera", observed_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-01T00:00:00Z",
      });
      await q.query(rera.sql, rera.params);
      const est = obs({
        value_date: "2028-01-31", status: "estimated", source_id: "sample-news", source_url: "https://example.org/sample/p1/news",
        source_type: "news", observed_at: "2026-10-10T00:00:00Z", last_verified_at: "2026-10-10T00:00:00Z",
        estimate_basis: JSON.stringify({ sources: ["https://example.org/sample/p1/news"], signalCount: 1 }),
      });
      await q.query(est.sql, est.params);
      return (await q.query(
        "select value_date::text, truth_status, source_type, conflict_count, has_disagreement, conflicts from facts_current where entity_id = 'p1' and attribute = 'promised_possession'",
      )).rows;
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ value_date: "2027-06-30", truth_status: "official", source_type: "rera", conflict_count: 2, has_disagreement: true });
    // official before estimated even though the estimate is newer; nothing is hidden
    expect(r[0].conflicts.map((x: Record<string, unknown>) => [x.value_date, x.truth_status, x.source_type, x.source_url])).toEqual([
      ["2026-12-31", "official", "builder", "https://example.com/sample/p1/possession"],
      ["2028-01-31", "estimated", "news", "https://example.org/sample/p1/news"],
    ]);
  });

  it("facts_current rows (as PostgREST JSON) map through the server repository mapper", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      await q.query(obs().sql, obs().params);
      const rera = obs({ value_date: "2027-06-30", source_id: "sample-regulator", source_url: "https://example.org/sample/p1/rera", source_type: "rera", observed_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-01T00:00:00Z" });
      await q.query(rera.sql, rera.params);
      return (await q.query("select to_jsonb(f) as j from facts_current f where entity_id = 'p1'")).rows.map((x) => x.j);
    });
    const [f] = r.map(mapFactsCurrentRow);
    expect(f.fact).toMatchObject({
      status: "known", value: "2027-06-30", truth: "official", ttlHours: 168, lastVerifiedAt: "2026-10-01T00:00:00.000Z",
      sources: [{ sourceId: "sample-regulator", url: "https://example.org/sample/p1/rera", observedAt: "2026-10-01T00:00:00.000Z" }],
      conflicts: [{ value: "2026-12-31", truth: "official", verification: "unverified", source: { sourceId: "sample-builder", url: "https://example.com/sample/p1/possession", observedAt: "2026-09-01T00:00:00.000Z" } }],
    });
    expect(f).toMatchObject({ sourceType: "rera", hasDisagreement: true, isStale: true, isSample: true });
  });

  it("a staff-reviewed curated value wins over newer observations; an unverified one does not", async () => {
    const SRC = JSON.stringify([{ sourceId: "sample-builder", url: "https://example.com/sample/p1/brochure", observedAt: "2026-08-01T00:00:00Z" }]);
    const r = await asRole(c, "service_role", null, async (q) => {
      const rera = obs({ value_date: "2027-06-30", source_id: "sample-regulator", source_url: "https://example.org/sample/p1/rera", source_type: "rera", observed_at: "2026-10-01T00:00:00Z", last_verified_at: "2026-10-01T00:00:00Z" });
      await q.query(rera.sql, rera.params);
      const set = await q.query(
        "select public.research_set_fact('p1', 'declared_possession', 'known', '\"2026-12 (SAMPLE brochure)\"', 'unverified', $1, $2, 'admin') as r",
        [SRC, STAFF_UID],
      );
      const factId = set.rows[0].r.fact_id as string;
      const pick = async () => (await q.query(
        "select origin, fact_id, value_text, value_date::text, truth_status, verification, source_type from facts_current where entity_id = 'p1' and attribute = 'promised_possession'",
      )).rows[0];
      const before = await pick();
      await q.query("select public.research_set_verification('p1', 'declared_possession', $1, 'unverified', 'reviewed', $2, 'admin', null)", [factId, STAFF_UID]);
      const after = await pick();
      const conflicts = (await q.query("select conflicts from facts_current where entity_id = 'p1' and attribute = 'promised_possession'")).rows[0].conflicts;
      return { before, after, conflicts, factId };
    });
    expect(r.before).toMatchObject({ origin: "observation", value_date: "2027-06-30", source_type: "rera" });
    expect(r.after).toMatchObject({
      origin: "curated", fact_id: r.factId, value_text: "2026-12 (SAMPLE brochure)", truth_status: "official",
      verification: "reviewed", source_type: "builder",
    });
    expect(r.conflicts.map((x: Record<string, unknown>) => x.source_type)).toEqual(["rera"]);
  });

  it("unknown: an 'unknown' row inside its TTL is not stale (suppresses re-research); past its TTL it is", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      const fresh = obs({
        attribute: "oc_status", value_date: null, status: "unknown", source_id: "sample-feed", source_url: null,
        source_type: "search", added_by: "research",
        observed_at: new Date(Date.now() - 3_600_000).toISOString(), last_verified_at: new Date(Date.now() - 3_600_000).toISOString(), ttl_hours: 72,
      });
      await q.query(fresh.sql, fresh.params);
      const old = obs({
        attribute: "khata_type", value_date: null, status: "unknown", source_id: "sample-feed", source_url: null,
        source_type: "search", added_by: "research",
        observed_at: new Date(Date.now() - 100 * 3_600_000).toISOString(), last_verified_at: new Date(Date.now() - 100 * 3_600_000).toISOString(), ttl_hours: 72,
      });
      await q.query(old.sql, old.params);
      return (await q.query(
        "select attribute, truth_status, value_text, value_num, value_date, value_json, is_stale, requires_review, conflicts from facts_current where entity_id = 'p1' and truth_status = 'unknown' order by attribute",
      )).rows;
    });
    expect(r).toEqual([
      { attribute: "khata_type", truth_status: "unknown", value_text: null, value_num: null, value_date: null, value_json: null, is_stale: true, requires_review: true, conflicts: [] },
      { attribute: "oc_status", truth_status: "unknown", value_text: null, value_num: null, value_date: null, value_json: null, is_stale: false, requires_review: true, conflicts: [] },
    ]);
  });

  it("an automated row can never be inserted (or updated, or relabelled) as verified", async () => {
    for (const addedBy of ["crawl", "research", "extraction"]) {
      for (const v of ["source_confirmed", "reviewed", "disputed", "requires_professional_review"]) {
        const ins = obs({ added_by: addedBy, verification: v });
        expect((await errorAs(c, "service_role", null, ins.sql, ins.params))?.code, `${addedBy} ${v}`).toBe("23514");
      }
    }
    const staff = obs({ added_by: "staff", verification: "reviewed" });
    expect(await errorAs(c, "service_role", null, staff.sql, staff.params)).toBeNull();
    const auto = obs();
    // inline the default (crawl) row as superuser setup SQL, then try to raise or relabel it
    const setup = auto.sql.replace(" returning id", "").replace(/\$(\d+)/g, (_, i) => {
      const v = auto.params[Number(i) - 1];
      return v === null ? "null" : typeof v === "number" ? String(v) : `'${v}'`;
    });
    expect((await errorAs(c, "service_role", null, "update fact_observations set verification = 'reviewed'", [], setup))?.code).toBe("23514");
    expect((await errorAs(c, "service_role", null, "update fact_observations set added_by = 'staff'", [], setup))?.code).toBe("23514");
  });

  it("rejects values without provenance, estimates without a basis, long excerpts, wrong kinds and unknown entities", async () => {
    const cases: Array<[string, Record<string, string | number | null>, string]> = [
      ["known without source_url", { source_url: null }, "23514"],
      ["unknown with a value", { status: "unknown" }, "23514"],
      ["estimate without basis", { status: "estimated" }, "23514"],
      ["basis on an official row", { estimate_basis: "{}" }, "23514"],
      ["excerpt over 20 words", { excerpt: Array.from({ length: 21 }, (_, i) => `w${i}`).join(" ") }, "23514"],
      ["wrong value kind", { value_date: null, value_text: "December 2026" }, "23514"],
      ["unknown attribute", { attribute: "not_in_catalogue" }, "23503"],
      ["attribute of another entity type", { attribute: "avg_psf" }, "23503"],
      ["unknown project", { entity_id: "no-such-project" }, "23503"],
      ["non-https url", { source_url: "http://example.com/x" }, "23514"],
      ["verified before observed", { last_verified_at: "2026-08-01T00:00:00Z" }, "23514"],
    ];
    for (const [name, o, code] of cases) {
      const ins = obs(o);
      expect((await errorAs(c, "service_role", null, ins.sql, ins.params))?.code, name).toBe(code);
    }
    const locality = obs({ entity_type: "locality", entity_id: "hebbal", attribute: "flooding_note", value_date: null, value_text: "SAMPLE note" });
    expect(await errorAs(c, "service_role", null, locality.sql, locality.params)).toBeNull();
  });

  it("history: every update/delete is captured; history cannot be updated, deleted or truncated, even by service_role or the owner", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      const id = (await q.query(obs().sql, obs().params)).rows[0].id as string;
      await q.query("update fact_observations set value_date = '2027-03-31', observed_at = '2026-10-05T00:00:00Z', last_verified_at = '2026-10-05T00:00:00Z' where id = $1", [id]);
      await q.query("update fact_observations set value_date = value_date where id = $1", [id]); // no-op: not history
      await q.query("delete from fact_observations where id = $1", [id]);
      const history = (await q.query(
        "select observation_id, value_date::text, operation from fact_observations_history order by history_id",
      )).rows;
      const view = (await q.query(
        "select origin, value_date::text, operation, superseded_at is not null as has_ts from facts_history where origin = 'observation' order by superseded_at, operation desc",
      )).rows;
      const errors: Record<string, string | undefined> = {};
      for (const sql of ["update fact_observations_history set value_text = 'tamper'", "delete from fact_observations_history"]) {
        await q.query("savepoint s");
        try {
          await q.query(sql);
        } catch (e) {
          errors[sql.split(" ")[0]] = (e as { code?: string }).code;
        }
        await q.query("rollback to savepoint s");
      }
      return { id, history, view, errors };
    });
    expect(r.history).toEqual([
      { observation_id: r.id, value_date: "2026-12-31", operation: "UPDATE" },
      { observation_id: r.id, value_date: "2027-03-31", operation: "DELETE" },
    ]);
    expect(r.view).toEqual([
      { origin: "observation", value_date: "2026-12-31", operation: "UPDATE", has_ts: true },
      { origin: "observation", value_date: "2027-03-31", operation: "DELETE", has_ts: true },
    ]);
    expect(r.errors).toEqual({ update: "42501", delete: "42501" });

    // Even the owner (superuser here) is blocked by the trigger, including TRUNCATE.
    await c.query("begin");
    try {
      await c.query(obs().sql, obs().params);
      await c.query("delete from fact_observations");
      for (const sql of [
        "update fact_observations_history set value_text = 'tamper'",
        "delete from fact_observations_history",
        "truncate fact_observations_history",
        "truncate fact_observations",
      ]) {
        await c.query("savepoint s");
        await expect(c.query(sql), sql).rejects.toThrow(/append-only/);
        await c.query("rollback to savepoint s");
      }
    } finally {
      await c.query("rollback");
    }
  });

  it("curated facts guard: value/status/field/created_at never change in place and rows are never deleted directly", async () => {
    for (const sql of [
      "update facts set value = '\"SAMPLE Road 99\"' where id = 'f-news'",
      "update facts set status = 'unknown', value = null where id = 'f-news'",
      "update facts set field = 'address' where id = 'f-dev'",
      "update facts set created_at = now() where id = 'f-dev'",
      "delete from facts where id = 'f-dev'",
    ]) {
      expect((await errorAs(c, "service_role", null, sql))?.code, sql).toBe("42501");
    }
    // allowed: supersede (is_current), verification, truth/TTL columns
    expect(await errorAs(c, "service_role", null,
      "update facts set is_current = false, verification = 'reviewed', truth_status = 'official', ttl_hours = 24, last_verified_at = now() where id = 'f-dev'")).toBeNull();
    expect((await errorAs(c, "service_role", null, "update facts set truth_status = 'official' where id = 'f-unk'"))?.code).toBe("23514");
    // superseded curated rows appear in facts_history; current ones in facts_current
    const r = await asRole(c, "service_role", null, async (q) => {
      await q.query("update facts set is_current = false where id = 'f-dev'");
      await q.query("insert into facts (id, project_id, field, value, status) values ('f-dev2', 'p2', 'declared_possession', '\"2027-09 (SAMPLE)\"', 'known')");
      return {
        history: (await q.query("select fact_id, attribute, legacy_field, value_text, operation, superseded_at is not null as has_ts from facts_history where origin = 'curated'")).rows,
        current: (await q.query("select fact_id, truth_status, ttl_hours from facts_current where entity_id = 'p2'")).rows,
      };
    });
    expect(r.history).toEqual([
      { fact_id: "f-dev", attribute: "promised_possession", legacy_field: "declared_possession", value_text: "2027-03 (SAMPLE)", operation: "SUPERSEDED", has_ts: true },
    ]);
    // no source yet → derived as estimated; TTL falls back to the catalogue default
    expect(r.current).toEqual([{ fact_id: "f-dev2", truth_status: "estimated", ttl_hours: 168 }]);
    // deleting the project still cascades (SAMPLE clean-up path in migrate.ts)
    expect(await errorAs(c, "service_role", null, "delete from projects where id = 'p2'")).toBeNull();
  });
});
