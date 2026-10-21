// M3 audit trail (0002_research_audit.sql). Run with `npm run test:db`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asRole, errorAs, resetAndMigrate, tryConnect } from "./helpers";

const conn = await tryConnect();
if (!conn.client) console.warn(`[test:db] SKIPPED research-audit: ${conn.reason}`);
const d = conn.client ? describe : describe.skip;

const STAFF_UID = "44444444-4444-4444-8444-444444444444";
const OTHER_UID = "55555555-5555-4555-8555-555555555555";

d("fact_review_events", () => {
  const c = conn.client as Client;

  beforeAll(async () => {
    await resetAndMigrate(c);
    await c.query(`
      insert into market_phases (id, name, sort_order, active) values ('north-bengaluru', 'North', 1, true);
      insert into zones (id, phase_id, name, boundary) values ('north-core', 'north-bengaluru', 'Z', '{}');
      insert into localities (id, zone_id, name, centroid_lat, centroid_lng) values ('hebbal', 'north-core', 'Hebbal', 13.03, 77.59);
      insert into developers (id, name) values ('d1', 'SAMPLE Developer A');
      insert into projects (id, slug, name, developer_id, locality_id, lat, lng, location_precision)
        values ('p1', 'sample-p1', 'SAMPLE P1', 'd1', 'hebbal', 13.03, 77.59, 'locality_centroid');
      insert into sources (id, name, type, status, access_method, homepage) values
        ('sample-feed', 'SAMPLE Feed', 'fixture', 'approved', 'fixture', 'https://example.com/');
      insert into staff_profiles (user_id, role) values ('${STAFF_UID}', 'admin');
      insert into fact_review_events (id, project_id, field, action, to_verification, actor_id, actor_role)
        values ('e1', 'p1', 'address', 'fact_set', 'unverified', '${STAFF_UID}', 'admin');
    `);
  });
  afterAll(async () => {
    await c?.end();
  });

  const insert = `insert into fact_review_events (project_id, field, action, actor_id, actor_role)
                  values ('p1', 'published', 'published', 'x', 'admin')`;

  it("has RLS enabled", async () => {
    const { rows } = await c.query("select relrowsecurity from pg_class where relname = 'fact_review_events'");
    expect(rows[0].relrowsecurity).toBe(true);
  });

  it("staff can read; non-staff and anon cannot", async () => {
    const staff = await asRole(c, "authenticated", STAFF_UID, async (q) => (await q.query("select id from fact_review_events")).rows);
    expect(staff).toEqual([{ id: "e1" }]);
    const other = await asRole(c, "authenticated", OTHER_UID, async (q) => (await q.query("select id from fact_review_events")).rows);
    expect(other).toEqual([]);
    expect((await errorAs(c, "anon", null, "select * from fact_review_events"))?.code).toBe("42501");
  });

  it("clients cannot insert, update or delete (even staff)", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const sub = role === "anon" ? null : STAFF_UID;
      expect((await errorAs(c, role, sub, insert))?.code).toBe("42501");
      expect((await errorAs(c, role, sub, "update fact_review_events set note = 'x'"))?.code).toBe("42501");
      expect((await errorAs(c, role, sub, "delete from fact_review_events"))?.code).toBe("42501");
    }
  });

  it("service role can append but never update, delete or truncate", async () => {
    expect(await errorAs(c, "service_role", null, insert)).toBeNull();
    for (const sql of [
      "update fact_review_events set note = 'tamper' where id = 'e1'",
      "delete from fact_review_events where id = 'e1'",
    ]) {
      const err = await errorAs(c, "service_role", null, sql);
      expect(err?.code).toBe("42501");
    }
    // Even the owner (superuser here) is blocked by the trigger.
    const owner = await c.query("begin").then(async () => {
      try {
        await c.query("update fact_review_events set note = 'tamper'");
        return null;
      } catch (e) {
        return (e as Error).message;
      } finally {
        await c.query("rollback");
      }
    });
    expect(owner).toMatch(/append-only/);
  });

  it("research_set_fact replaces the current fact atomically with sources (service role only)", async () => {
    const call = `select public.research_set_fact('p1', 'address', 'known', '"SAMPLE Road 9"', 'unverified',
      '[{"sourceId":"sample-feed","url":"https://example.com/a","observedAt":"2026-10-01T00:00:00Z","documentDate":"2026-09-01"}]', 0.2)`;
    expect((await errorAs(c, "anon", null, call))?.code).toBe("42501");
    expect((await errorAs(c, "authenticated", STAFF_UID, call))?.code).toBe("42501");
    const r = await asRole(c, "service_role", null, async (q) => {
      await q.query(call);
      await q.query(call.replace("SAMPLE Road 9", "SAMPLE Road 10"));
      return {
        facts: (await q.query("select value, is_current from facts where project_id = 'p1' order by is_current")).rows,
        sources: (await q.query("select count(*)::int as n from fact_sources")).rows[0].n,
        completeness: (await q.query("select completeness from projects where id = 'p1'")).rows[0].completeness,
      };
    });
    expect(r.facts).toEqual([{ value: "SAMPLE Road 9", is_current: false }, { value: "SAMPLE Road 10", is_current: true }]);
    expect(r.sources).toBe(2);
    expect(Number(r.completeness)).toBe(0.2);
    const bad = await errorAs(c, "service_role", null,
      `select public.research_set_fact('p1', 'address', 'known', '"x"', 'unverified', '[{"sourceId":"sample-feed","url":"http://insecure","observedAt":"2026-10-01T00:00:00Z"}]', 0)`);
    expect(bad?.code).toBe("23514"); // https check; whole call rolled back
  });

  it("project_search_index exposes developer_name for text search", async () => {
    const rows = await asRole(c, "service_role", null, async (q) =>
      (await q.query("select developer_name from project_search_index where developer_name ilike '%developer a%'")).rows);
    expect(rows).toEqual([{ developer_name: "SAMPLE Developer A" }]);
  });

  it("rejects unknown fields, actions and roles", async () => {
    const err = await errorAs(c, "service_role", null,
      "insert into fact_review_events (project_id, field, action, actor_id, actor_role) values ('p1', 'price', 'fact_set', 'x', 'admin')");
    expect(err?.code).toBe("23514");
    const err2 = await errorAs(c, "service_role", null,
      "insert into fact_review_events (project_id, field, action, actor_id, actor_role) values ('p1', 'address', 'fact_set', 'x', 'ai')");
    expect(err2?.code).toBe("23514");
  });
});
