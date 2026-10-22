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

  const SRC = `'[{"sourceId":"sample-feed","url":"https://example.com/a","observedAt":"2026-10-01T00:00:00Z","documentDate":"2026-09-01"}]'`;
  const setFact = (field: string, value: string, verification = "unverified") =>
    `select public.research_set_fact('p1', '${field}', 'known', '${value}', '${verification}', ${SRC}, '${STAFF_UID}', 'admin') as r`;
  /** research_set_verification(project, field, fact_id, expected_from, to, actor, role, note) */
  const verify = (field: string, from: string, to: string, actor = "u", role = "admin", note: string | null = null) =>
    `select public.research_set_verification('p1', '${field}', $1, '${from}', '${to}', '${actor}', '${role}', ${note === null ? "null" : `'${note}'`}) as r`;
  const currentId = async (q: Client, field: string) =>
    (await q.query("select id from facts where project_id = 'p1' and field = $1 and is_current", [field])).rows[0].id as string;

  /** Makes p1 publish-ready inside the current transaction (3 of 5 completeness points). */
  async function makeReady(q: Client) {
    await q.query(setFact("address", '"SAMPLE Road 1"'));
    await q.query(setFact("rera_numbers", '["TEST/REG/0001"]'));
    await q.query(setFact("construction_status", '"under_construction"'));
    await q.query(verify("rera_numbers", "unverified", "source_confirmed", STAFF_UID), [await currentId(q, "rera_numbers")]);
  }

  it("write RPCs are service-role only", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const sub = role === "anon" ? null : STAFF_UID;
      expect((await errorAs(c, role, sub, setFact("address", '"SAMPLE Road 9"')))?.code).toBe("42501");
      expect((await errorAs(c, role, sub, "select public.research_set_published('p1', true, 'x', 'admin')"))?.code).toBe("42501");
      expect((await errorAs(c, role, sub, "select public.tn_publish_blockers('p1')"))?.code).toBe("42501");
    }
  });

  it("research_set_fact replaces the current fact with sources and audits in one transaction", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      await q.query(setFact("address", '"SAMPLE Road 9"'));
      await q.query(setFact("address", '"SAMPLE Road 10"'));
      return {
        facts: (await q.query("select value, is_current from facts where project_id = 'p1' order by is_current")).rows,
        sources: (await q.query("select count(*)::int as n from fact_sources")).rows[0].n,
        completeness: (await q.query("select completeness from projects where id = 'p1'")).rows[0].completeness,
        audit: (await q.query("select field, action, from_verification, to_verification, actor_id, at is not null as has_at from fact_review_events where action = 'fact_set' and id <> 'e1'")).rows,
      };
    });
    expect(r.facts).toEqual([{ value: "SAMPLE Road 9", is_current: false }, { value: "SAMPLE Road 10", is_current: true }]);
    expect(r.sources).toBe(2);
    expect(Number(r.completeness)).toBe(0.2);
    expect(r.audit).toEqual([
      { field: "address", action: "fact_set", from_verification: "unverified", to_verification: "unverified", actor_id: STAFF_UID, has_at: true },
      { field: "address", action: "fact_set", from_verification: "unverified", to_verification: "unverified", actor_id: STAFF_UID, has_at: true },
    ]);
  });

  it("a failing fact write leaves no partial state (no fact, no audit)", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      const before = (await q.query("select count(*)::int as n from fact_review_events")).rows[0].n;
      await q.query("savepoint s");
      let err: string | null = null;
      try {
        await q.query(`select public.research_set_fact('p1', 'address', 'known', '"x"', 'unverified',
          '[{"sourceId":"sample-feed","url":"http://insecure","observedAt":"2026-10-01T00:00:00Z"}]', 'u', 'admin')`);
      } catch (e) {
        err = (e as { code?: string }).code ?? null;
      }
      await q.query("rollback to savepoint s");
      return {
        err,
        audit: (await q.query("select count(*)::int as n from fact_review_events")).rows[0].n - before,
        facts: (await q.query("select count(*)::int as n from facts where project_id = 'p1'")).rows[0].n,
      };
    });
    expect(r).toEqual({ err: "23514", audit: 0, facts: 0 });
  });

  it("research_set_verification refuses a stale fact id (conflict) and audits a valid change", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      await q.query(setFact("address", '"SAMPLE Road 9"'));
      const old = (await q.query("select id from facts where project_id = 'p1' and is_current")).rows[0].id;
      await q.query(setFact("address", '"SAMPLE Road 10"')); // another tab edited it
      const stale = (await q.query(verify("address", "unverified", "reviewed"), [old])).rows[0].r;
      const cur = (await q.query("select id from facts where project_id = 'p1' and is_current")).rows[0].id;
      // R1: right fact id, but the reviewer saw a different verification than is stored now
      const staleFrom = (await q.query(verify("address", "reviewed", "source_confirmed"), [cur])).rows[0].r;
      const ok = (await q.query(verify("address", "unverified", "reviewed", "u", "admin", "checked"), [cur])).rows[0].r;
      return {
        stale,
        staleFrom,
        ok,
        verification: (await q.query("select verification from facts where id = $1", [cur])).rows[0].verification,
        audit: (await q.query("select from_verification, to_verification, note from fact_review_events where action = 'verification_changed'")).rows,
      };
    });
    expect(r.stale).toEqual({ status: "conflict" });
    expect(r.staleFrom).toEqual({ status: "conflict" });
    expect(r.ok).toMatchObject({ status: "ok", from: "unverified", auto_unpublished: false });
    expect(r.verification).toBe("reviewed");
    expect(r.audit).toEqual([{ from_verification: "unverified", to_verification: "reviewed", note: "checked" }]);
  });

  it("research_set_published re-checks readiness under lock; publishes and audits when ready", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      const notReady = (await q.query("select public.research_set_published('p1', true, 'u', 'admin') as r")).rows[0].r;
      await makeReady(q);
      const blockers = (await q.query("select public.tn_publish_blockers('p1') as b")).rows[0].b;
      const ok = (await q.query("select public.research_set_published('p1', true, 'u', 'admin') as r")).rows[0].r;
      const again = (await q.query("select public.research_set_published('p1', true, 'u', 'admin') as r")).rows[0].r;
      return {
        notReady,
        blockers,
        ok,
        again,
        published: (await q.query("select published from projects where id = 'p1'")).rows[0].published,
        audit: (await q.query("select action from fact_review_events where field = 'published'")).rows.map((x) => x.action),
      };
    });
    expect(r.notReady.status).toBe("not_ready");
    expect(r.notReady.blockers).toEqual(["reraNumbers: not known", "constructionStatus: not known", "completeness 0% is below 60%"]);
    expect(r.blockers).toEqual([]);
    expect(r).toMatchObject({ ok: { status: "ok" }, again: { status: "unchanged" }, published: true, audit: ["published"] });
  });

  it("auto-unpublishes (with audit) when an edit or a dispute breaks readiness (D13)", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      await makeReady(q);
      await q.query("select public.research_set_published('p1', true, 'u', 'admin')");
      // address edit keeps readiness → stays published
      const keep = (await q.query(setFact("address", '"SAMPLE Road 9"'))).rows[0].r;
      // RERA re-edit resets verification → not ready → auto-unpublished
      const drop = (await q.query(setFact("rera_numbers", '["TEST/REG/0002"]'))).rows[0].r;
      const afterEdit = (await q.query("select published from projects where id = 'p1'")).rows[0].published;
      // republish path: verify again, publish, then dispute construction status
      await q.query(verify("rera_numbers", "unverified", "reviewed"), [await currentId(q, "rera_numbers")]);
      await q.query("select public.research_set_published('p1', true, 'u', 'admin')");
      const cs = await currentId(q, "construction_status");
      const dispute = (await q.query(verify("construction_status", "unverified", "disputed", STAFF_UID, "advisor", "conflicting reports"), [cs])).rows[0].r;
      return {
        keep,
        drop,
        afterEdit,
        dispute,
        published: (await q.query("select published from projects where id = 'p1'")).rows[0].published,
        auto: (await q.query("select actor_id, actor_role, note from fact_review_events where action = 'unpublished' order by at, id")).rows,
      };
    });
    expect(r.keep.auto_unpublished).toBe(false);
    expect(r.drop.auto_unpublished).toBe(true);
    expect(r.afterEdit).toBe(false);
    expect(r.dispute.auto_unpublished).toBe(true);
    expect(r.published).toBe(false);
    expect(r.auto).toHaveLength(2);
    for (const a of r.auto) expect(a.note).toBe("auto: failed readiness after edit");
    expect(r.auto.map((a) => a.actor_role).sort()).toEqual(["admin", "advisor"]);
  });

  it("research_create_project creates developer + project + 'created' audit atomically", async () => {
    const r = await asRole(c, "service_role", null, async (q) => {
      const id = (await q.query(`select public.research_create_project('test-new', 'Test New', null, 'New Builder', 'hebbal', 13.03, 77.59, 'locality_centroid', 'u', 'advisor') as id`)).rows[0].id;
      const id2 = (await q.query(`select public.research_create_project('test-new-2', 'Test New 2', 'd1', null, 'hebbal', 13.03, 77.59, 'locality_centroid', 'u', 'advisor') as id`)).rows[0].id;
      return {
        project: (await q.query("select published, is_sample, developer_id <> 'd1' as new_dev from projects where id = $1", [id])).rows[0],
        dev2: (await q.query("select developer_id from projects where id = $1", [id2])).rows[0].developer_id,
        audit: (await q.query("select action from fact_review_events where project_id = $1", [id])).rows,
      };
    });
    expect(r).toEqual({ project: { published: false, is_sample: false, new_dev: true }, dev2: "d1", audit: [{ action: "created" }] });
  });

  it("project_search_index exposes normalised RERA numbers", async () => {
    const rows = await asRole(c, "service_role", null, async (q) => {
      await q.query(setFact("rera_numbers", '["prm/ka/rera 1251"]'));
      return (await q.query("select rera_numbers_normalized from project_search_index where id = 'p1'")).rows;
    });
    expect(rows).toEqual([{ rera_numbers_normalized: ["PRMKARERA1251"] }]);
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
