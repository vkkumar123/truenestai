// S4a area developments (0008_developments.sql): constraints, RLS, append-only history, RPCs.
// Run with `npm run test:db`. All rows are SAMPLE fixtures with example.org URLs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asRole, errorAs, resetAndMigrate, tryConnect } from "./helpers";

const conn = await tryConnect();
if (!conn.client) console.warn(`[test:db] SKIPPED developments: ${conn.reason}`);
const d = conn.client ? describe : describe.skip;

const ADMIN_UID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_UID = "00000000-0000-4000-8000-0000000000b2";
const URL_M = "https://example.org/sample-developments/hebbal/metro";
const URL_R = "https://example.org/sample-developments/hebbal/road";
const OBS = "2026-10-24T06:00:00Z";

const metro = { name: "SAMPLE Hebbal Metro Extension", category: "metro", stage: "under_construction", authority: "SAMPLE Metro Authority", expectedCompletion: "December 2029", localityId: "hebbal", sourceUrl: URL_M };
const road = { name: "SAMPLE Hebbal Ring Road Link", category: "ring_road", stage: "proposed", authority: null, expectedCompletion: null, localityId: "hebbal", sourceUrl: URL_R };

d("developments (0008)", () => {
  const c = conn.client as Client;

  async function store(items: unknown[], observedAt = OBS, db: Client = c): Promise<string[]> {
    const { rows } = await db.query("select development_store_research(null, 'hebbal', 'sample-web-research', $1, true, $2::jsonb) as ids", [
      observedAt,
      JSON.stringify(items),
    ]);
    return rows[0].ids;
  }
  async function row(id: string) {
    return (await c.query("select * from infrastructure_items where id = $1", [id])).rows[0];
  }
  const review = async (id: string, version: number, action: string, verification: string | null = null, note: string | null = null) =>
    (await c.query("select development_set_review($1, $2, $3, $4, $5, 'admin', $6) as r", [id, version, action, verification, ADMIN_UID, note])).rows[0].r;
  const update = async (id: string, version: number, fields: Record<string, unknown>) =>
    (await c.query("select development_update($1, $2, $3::jsonb, $4, 'admin') as r", [id, version, JSON.stringify(fields), ADMIN_UID])).rows[0].r;
  const fieldsOf = (r: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    name: r.name,
    category: r.category,
    stage: r.stage,
    authority: r.authority,
    expectedCompletion: r.expected_completion,
    localityIds: r.locality_ids,
    lat: "13.045",
    lng: "77.597",
    locationPrecision: "approximate",
    sourceUrl: r.source_url,
    sourceObservedAt: OBS,
    ...over,
  });

  beforeAll(async () => {
    await resetAndMigrate(c);
    await c.query(`
      insert into market_phases (id, name, sort_order, active) values ('north-bengaluru', 'North', 1, true);
      insert into zones (id, phase_id, name, boundary) values ('north-core', 'north-bengaluru', 'Z', '{}');
      insert into localities (id, zone_id, name, centroid_lat, centroid_lng) values ('hebbal', 'north-core', 'Hebbal', 13.0358, 77.597);
      insert into sources (id, name, type, status, access_method, homepage) values
        ('sample-web-research', 'SAMPLE Web Research', 'fixture', 'approved', 'fixture', 'https://example.com/');
      insert into staff_profiles (user_id, role) values ('${ADMIN_UID}', 'admin');
      insert into infrastructure_items (id, name, category, stage, declared_completion, published, is_sample) values
        ('legacy-pub', 'SAMPLE Legacy Metro', 'metro', 'proposed', '{"status":"unknown","value":null}', true, true);
    `);
  });
  afterAll(async () => {
    await c?.end();
  });

  it("legacy rows stay valid; the new stage and category tiers are accepted, others are not", async () => {
    expect((await row("legacy-pub")).added_by).toBeNull();
    await asRole(c, "service_role", null, async (db) => {
      await db.query("insert into infrastructure_items (id, name, category, stage, published, is_sample) values ('t1', 'SAMPLE T', 'suburban_rail', 'dpr_approved', false, true)");
      await db.query("insert into infrastructure_items (id, name, category, stage, published, is_sample) values ('t2', 'SAMPLE T2', 'zoning', 'shelved', false, true)");
    });
    expect((await errorAs(c, "service_role", null, "insert into infrastructure_items (id, name, category, stage) values ('x', 'SAMPLE', 'metro', 'planned')"))?.code).toBe("23514");
    expect((await errorAs(c, "service_role", null, "insert into infrastructure_items (id, name, category, stage) values ('x', 'SAMPLE', 'tram', 'proposed')"))?.code).toBe("23514");
  });

  it("an S4a row is inserted unverified; research rows need source fields; staff rows need authority and URL", async () => {
    const ins = (cols: string, vals: string) => errorAs(c, "service_role", null, `insert into infrastructure_items (id, name, category, stage, ${cols}) values ('x', 'SAMPLE X', 'metro', 'proposed', ${vals})`);
    expect((await ins("added_by, source_id, source_url, source_observed_at, verification", `'research', 'sample-web-research', '${URL_M}', now(), 'source_confirmed'`))?.code).toBe("23514");
    expect((await ins("added_by, source_url", `'research', '${URL_M}'`))?.code).toBe("23514");
    expect((await ins("added_by, source_url", `'staff', '${URL_M}'`))?.code).toBe("23514");
    expect((await ins("added_by, authority, source_url", `'staff', 'SAMPLE A', 'http://example.org/x'`))?.code).toBe("23514");
    expect((await ins("added_by, authority, source_url, published", `'staff', 'SAMPLE A', '${URL_M}', true`))?.code).toBe("23514"); // no observed date
    expect(await ins("added_by, authority, source_url, source_observed_at", `'staff', 'SAMPLE A', '${URL_M}', now()`)).toBeNull();
  });

  it("research_enqueue records the kind; dev:<locality> keys belong only to area_developments jobs with a locality", async () => {
    await asRole(c, "service_role", null, async (db) => {
      const r = (await db.query("select research_enqueue('Area developments: Hebbal', 'dev:hebbal', 'hebbal', null, 168, 50, 10, 'area_developments') as r")).rows[0].r;
      expect(r).toMatchObject({ outcome: "queued", job: { kind: "area_developments", query_key: "dev:hebbal" } });
      const s = (await db.query("select research_enqueue('SAMPLE q', 'sample q', null, null, 168, 50, 10) as r")).rows[0].r;
      expect(s.job.kind).toBe("search_miss");
    });
    const enq = (key: string, loc: string | null, kind: string) =>
      errorAs(c, "service_role", null, "select research_enqueue('x', $1, $2, null, 168, 50, 10, $3)", [key, loc, kind]);
    expect((await enq("dev:hebbal", "hebbal", "search_miss"))?.code).toBe("23514");
    expect((await enq("hebbal metro", "hebbal", "area_developments"))?.code).toBe("23514");
    expect((await enq("dev:hebbal", null, "area_developments"))?.code).toBe("23514");
    expect((await enq("x y", null, "other_kind"))?.code).toBe("23514");
  });

  it("store_research inserts unverified, unpublished rows with history and a 'researched' audit event", async () => {
    await asRole(c, "service_role", null, async (db) => {
      const ids = await store([metro, road], OBS, db);
      expect(ids).toHaveLength(2);
      const r = (await db.query("select * from infrastructure_items where id = $1", [ids[0]])).rows[0];
      expect(r).toMatchObject({ added_by: "research", verification: "unverified", published: false, is_sample: true, version: 1, source_url: URL_M });
      expect(r.completion_history).toEqual([{ date_claimed: "December 2029", as_of: expect.any(String), source_url: URL_M }]);
      expect(r.declared_completion).toMatchObject({ status: "known", value: "December 2029" });
      const h = (await db.query("select expected_completion from infrastructure_completion_history where development_id = $1", [ids[0]])).rows;
      expect(h).toEqual([{ expected_completion: "December 2029" }]);
      const ev = (await db.query("select action, actor_role, actor_id from infrastructure_review_events where development_id = $1", [ids[0]])).rows;
      expect(ev).toEqual([{ action: "researched", actor_role: "system", actor_id: "system:research" }]);
      // same name (normalised) on the same page = same row; a new date on a pending row appends history
      const again = await store([{ ...metro, name: "sample hebbal  METRO extension", expectedCompletion: "June 2030" }], "2026-11-01T00:00:00Z", db);
      expect(again).toEqual([ids[0]]);
      const v = (await db.query("select revisions_count, expected_completion from developments where development_id = $1", [ids[0]])).rows[0];
      expect(v).toEqual({ revisions_count: 1, expected_completion: "June 2030" });
    });
  });

  describe("with stored rows", () => {
    let metroId = "";
    let roadId = "";
    beforeAll(async () => {
      [metroId, roadId] = await store([metro, road]);
    });

    it("verification changes only through the RPCs; system audit events only record research", async () => {
      expect((await errorAs(c, "service_role", null, "update infrastructure_items set verification = 'source_confirmed' where id = $1", [metroId]))?.code).toBe("42501");
      expect((await errorAs(c, "service_role", null, "update infrastructure_items set added_by = 'staff' where id = $1", [metroId]))?.code).toBe("23514");
      expect(
        (await errorAs(c, "service_role", null, "insert into infrastructure_review_events (development_id, action, actor_id, actor_role) values ($1, 'published', 'system:x', 'system')", [metroId]))?.code,
      ).toBe("23514");
    });

    it("publish: not_ready without an authority; version conflicts; ok with readiness; unchanged on repeat", async () => {
      const rd = await row(roadId);
      expect(await review(roadId, rd.version, "publish")).toEqual({ status: "not_ready", blockers: ["authority: not yet found"] });
      const m = await row(metroId);
      expect(await review(metroId, m.version + 7, "publish")).toEqual({ status: "conflict" });
      expect((await errorAs(c, "service_role", null, "update infrastructure_items set published = true where id = $1", [roadId]))?.code).toBe("42501");
      const ok = await review(metroId, m.version, "publish", "source_confirmed");
      expect(ok.status).toBe("ok");
      expect(await review(metroId, ok.version, "publish", "source_confirmed")).toMatchObject({ status: "unchanged" });
      expect(await row(metroId)).toMatchObject({ published: true, verification: "source_confirmed" });
    });

    it("anon reads published rows only, public columns only; history only for published rows; no review events", async () => {
      await asRole(c, "anon", null, async (db) => {
        const ids = (await db.query("select id from infrastructure_items order by id")).rows.map((r) => r.id);
        expect(ids).toContain(metroId);
        expect(ids).toContain("legacy-pub");
        expect(ids).not.toContain(roadId);
        const view = (await db.query("select development_id, status, authority, revisions_count from developments")).rows.map((r) => r.development_id);
        expect(view).toContain(metroId);
        expect(view).not.toContain(roadId);
        const hist = (await db.query("select distinct development_id from infrastructure_completion_history")).rows.map((r) => r.development_id);
        expect(hist).toEqual([metroId]);
      });
      for (const col of ["pending_change", "research_job_id", "rejection_note", "version", "rejected_at"]) {
        expect((await errorAs(c, "anon", null, `select ${col} from infrastructure_items`))?.code).toBe("42501");
      }
      expect((await errorAs(c, "anon", null, "select * from infrastructure_review_events"))?.code).toBe("42501");
      expect((await errorAs(c, "anon", null, "update infrastructure_items set name = 'x'"))?.code).toBe("42501");
      expect((await errorAs(c, "anon", null, "select development_store_research(null, 'hebbal', 'sample-web-research', now(), true, '[]')"))?.code).toBe("42501");
      expect((await errorAs(c, "authenticated", OTHER_UID, "select development_set_review('x', 1, 'publish', null, 'x', 'admin', null)"))?.code).toBe("42501");
      const staff = await asRole(c, "authenticated", ADMIN_UID, async (db) => (await db.query("select count(*)::int as n from infrastructure_review_events")).rows[0].n);
      const other = await asRole(c, "authenticated", OTHER_UID, async (db) => (await db.query("select count(*)::int as n from infrastructure_review_events")).rows[0].n);
      expect(staff).toBeGreaterThan(0);
      expect(other).toBe(0);
    });

    it("completion history is append-only, even for service_role", async () => {
      expect((await errorAs(c, "service_role", null, "update infrastructure_completion_history set expected_completion = '2040'"))?.code).toBe("42501");
      expect((await errorAs(c, "service_role", null, "delete from infrastructure_completion_history"))?.code).toBe("42501");
      expect(
        (await errorAs(c, "service_role", null, "insert into infrastructure_completion_history (development_id, expected_completion, as_of) values ($1, '2040', now())", [metroId]))?.code,
      ).toBe("42501");
      // even the owner is stopped by the triggers
      await expect(c.query("update infrastructure_completion_history set expected_completion = '2040'")).rejects.toThrow();
      await expect(c.query("delete from infrastructure_review_events")).rejects.toThrow();
      await expect(c.query("truncate infrastructure_completion_history")).rejects.toThrow();
      // a direct write to the derived column is ignored
      await c.query("update infrastructure_items set completion_history = '[]' where id = $1", [metroId]);
      expect((await row(metroId)).completion_history).toHaveLength(1);
    });

    it("re-research keeps a published row and records pending_change; an edit that breaks readiness auto-unpublishes", async () => {
      await store([{ ...metro, stage: "operational" }], "2026-12-01T00:00:00Z");
      const m = await row(metroId);
      expect(m).toMatchObject({ stage: "under_construction", published: true, verification: "source_confirmed", pending_change: { stage: "operational" } });

      const slipped = await update(metroId, m.version, fieldsOf(m, { expectedCompletion: "June 2031" }));
      expect(slipped).toMatchObject({ status: "ok", auto_unpublished: false });
      const m2 = await row(metroId);
      expect(m2).toMatchObject({ verification: "unverified", pending_change: null, published: true, expected_completion: "June 2031" });
      expect(m2.completion_history.map((h: { date_claimed: string }) => h.date_claimed)).toEqual(["December 2029", "June 2031"]);
      expect((await c.query("select revisions_count from developments where development_id = $1", [metroId])).rows[0].revisions_count).toBe(1);

      expect(await update(metroId, m2.version, fieldsOf(m2, { expectedCompletion: "June 2031" }))).toMatchObject({ status: "unchanged" });
      const broke = await update(metroId, m2.version, fieldsOf(m2, { authority: "" }));
      expect(broke).toMatchObject({ status: "ok", auto_unpublished: true });
      expect((await row(metroId)).published).toBe(false);
      const actions = (await c.query("select action, note from infrastructure_review_events where development_id = $1 order by id", [metroId])).rows;
      expect(actions.at(-1)).toEqual({ action: "unpublished", note: "auto: failed readiness after edit" });
    });

    it("reject and restore are audited; a rejected row keeps its values on re-research", async () => {
      const rd = await row(roadId);
      const rej = await review(roadId, rd.version, "reject", null, "no authority page");
      expect(rej.status).toBe("ok");
      expect(await row(roadId)).toMatchObject({ rejection_note: "no authority page", published: false });
      await store([{ ...road, stage: "approved" }], "2026-12-02T00:00:00Z");
      expect(await row(roadId)).toMatchObject({ stage: "proposed", pending_change: { stage: "approved" } });
      const back = await review(roadId, (await row(roadId)).version, "restore");
      expect(back.status).toBe("ok");
      expect((await row(roadId)).rejected_at).toBeNull();
    });

    it("development_create needs an authority URL and starts unverified", async () => {
      const f = { name: "SAMPLE Manual Flyover", category: "flyover", stage: "approved", authority: "SAMPLE Roads Board", localityIds: ["hebbal"], sourceUrl: "https://example.org/sample-manual", sourceObservedAt: OBS };
      const r = (await c.query("select development_create($1::jsonb, true, $2, 'admin') as r", [JSON.stringify(f), ADMIN_UID])).rows[0].r;
      expect(r.status).toBe("ok");
      expect(await row(r.id)).toMatchObject({ added_by: "staff", verification: "unverified", published: false });
      await expect(c.query("select development_create($1::jsonb, true, $2, 'admin')", [JSON.stringify({ ...f, authority: "" }), ADMIN_UID])).rejects.toThrow(/infra_staff_has_authority_url/);
    });
  });

  describe("review round 1 fixes", () => {
    const URL_P = "https://example.org/sample-developments/hebbal/peripheral";
    const URL_E = "https://example.org/sample-developments/hebbal/edited";
    const peripheral = { name: "SAMPLE Hebbal Peripheral Road", category: "ring_road", stage: "proposed", authority: "SAMPLE Roads Board", expectedCompletion: "2028", localityId: "hebbal", sourceUrl: URL_P };
    const edited = { name: "SAMPLE Hebbal Edited Flyover", category: "flyover", stage: "approved", authority: "SAMPLE Roads Board", expectedCompletion: "2029", localityId: "hebbal", sourceUrl: URL_E };
    const anonLastChecked = (id: string) =>
      asRole(c, "anon", null, async (db) => (await db.query("select last_checked_at from infrastructure_items where id = $1", [id])).rows[0]?.last_checked_at as Date | undefined);
    const lastEvent = async (id: string) =>
      (await c.query("select action, note from infrastructure_review_events where development_id = $1 order by id desc limit 1", [id])).rows[0];

    it("H2: research contradicting a published row is recorded, never refreshes its public last-checked date; publish records what it cleared", async () => {
      const [id] = await store([peripheral], "2026-10-24T00:00:00Z");
      const pub = await review(id, (await row(id)).version, "publish");
      expect(pub.status).toBe("ok");
      const shown = await anonLastChecked(id);
      expect(shown?.toISOString()).toBe("2026-10-24T00:00:00.000Z");

      await store([{ ...peripheral, stage: "shelved", expectedCompletion: "2031" }], "2026-12-01T00:00:00Z");
      expect((await anonLastChecked(id))?.toISOString()).toBe("2026-10-24T00:00:00.000Z");
      const r = await row(id);
      expect(r).toMatchObject({ stage: "proposed", expected_completion: "2028", published: true, pending_change: { stage: "shelved", expectedCompletion: "2031" } });
      const ev = await lastEvent(id);
      expect(ev.action).toBe("researched");
      expect(ev.note).toMatch(/differs from the reviewed values.*shelved.*2031/);

      // unpublish, then publish again: the cleared pending change is kept in the audit note
      const un = await review(id, r.version, "unpublish");
      const again = await review(id, un.version, "publish", null, "checked the authority page");
      expect(again.status).toBe("ok");
      expect((await row(id)).pending_change).toBeNull();
      expect((await lastEvent(id)).note).toMatch(/^checked the authority page · cleared pending research change: .*shelved/);

      // research that matches the reviewed values refreshes the date
      await store([peripheral], "2026-12-15T00:00:00Z");
      expect((await anonLastChecked(id))?.toISOString()).toBe("2026-12-15T00:00:00.000Z");
    });

    it("M2: re-research never overwrites a pending draft that staff edited", async () => {
      const [id] = await store([edited]);
      const e = await row(id);
      expect(e.staff_edited_at).toBeNull();
      const u = await update(id, e.version, fieldsOf(e, { stage: "tendered" }));
      expect(u.status).toBe("ok");
      expect((await row(id)).staff_edited_at).not.toBeNull();
      await store([{ ...edited, stage: "under_construction" }], "2026-12-03T00:00:00Z");
      expect(await row(id)).toMatchObject({ stage: "tendered", published: false, pending_change: { stage: "under_construction" } });
    });

    it("M3: S4a rows cannot be inserted published or published outside the review RPC", async () => {
      expect(
        (await errorAs(c, "service_role", null,
          `insert into infrastructure_items (id, name, category, stage, added_by, authority, source_url, source_observed_at, published)
           values ('x-pub', 'SAMPLE X', 'metro', 'proposed', 'staff', 'SAMPLE A', '${URL_M}', now(), true)`))?.code,
      ).toBe("23514");
      const [id] = await store([{ ...edited, name: "SAMPLE Hebbal Direct Publish Try" }]);
      expect((await errorAs(c, "service_role", null, "update infrastructure_items set published = true where id = $1", [id]))?.code).toBe("42501");
      await expect(c.query("update infrastructure_items set published = true where id = $1", [id])).rejects.toThrow(/published only through the audited review RPC/);
      expect((await row(id)).published).toBe(false);
    });

    it("L3: service_role cannot delete or truncate developments", async () => {
      expect((await errorAs(c, "service_role", null, "delete from infrastructure_items where id = 'legacy-pub'"))?.code).toBe("42501");
      expect((await errorAs(c, "service_role", null, "truncate infrastructure_items cascade"))?.code).toBe("42501");
    });

    it("L4: the pre-S4a claim signature never claims an area_developments job; the S4a one does", async () => {
      await asRole(c, "service_role", null, async (db) => {
        await db.query("select research_enqueue('Area developments: Hebbal', 'dev:hebbal', 'hebbal', null, 0, 50, 10, 'area_developments')");
        await db.query("select research_enqueue('SAMPLE claim q', 'sample claim q', null, null, 0, 50, 10)");
        const old = (await db.query("select r from research_claim_jobs(10, 15) r")).rows.map((x) => x.r.kind);
        expect(old).toEqual(["search_miss"]);
        const next = (await db.query("select r from research_claim_jobs(10, 15, array['search_miss','area_developments']) r")).rows.map((x) => x.r.kind);
        expect(next).toEqual(["area_developments"]);
      });
      expect((await errorAs(c, "anon", null, "select research_claim_jobs(1, 15, array['search_miss'])"))?.code).toBe("42501");
    });
  });

  describe("review round 2 fixes", () => {
    it("N1: publish → unpublish → research keeps the reviewed values and records a pending change", async () => {
      const item = { name: "SAMPLE Hebbal Unpublished Link", category: "road", stage: "approved", authority: "SAMPLE Roads Board", expectedCompletion: "2029", localityId: "hebbal", sourceUrl: "https://example.org/sample-developments/hebbal/unpub" };
      const [id] = await store([item]);
      const pub = await review(id, (await row(id)).version, "publish");
      expect((await row(id)).reviewed_at).not.toBeNull();
      const un = await review(id, pub.version, "unpublish");
      expect(un.status).toBe("ok");
      await store([{ ...item, stage: "shelved", authority: "SAMPLE Other Board" }], "2026-12-20T00:00:00Z");
      expect(await row(id)).toMatchObject({
        published: false,
        stage: "approved",
        authority: "SAMPLE Roads Board",
        pending_change: { stage: "shelved", authority: "SAMPLE Other Board" },
      });
    });

    it("N2: two jobs storing the same new item concurrently both succeed on one row", async () => {
      const c2conn = await tryConnect();
      const c2 = c2conn.client as Client;
      try {
        const item = { name: "SAMPLE Hebbal Concurrent Metro", category: "metro", stage: "proposed", authority: null, expectedCompletion: null, localityId: "hebbal", sourceUrl: "https://example.org/sample-developments/hebbal/concurrent" };
        await c.query("begin");
        const first = await store([item], OBS, c); // uncommitted: holds the unique-index entry
        const second = store([item], "2026-10-25T00:00:00Z", c2); // blocks on the unique index
        await new Promise((r) => setTimeout(r, 300));
        await c.query("commit");
        const ids2 = await second;
        expect(ids2).toEqual(first);
        const n = (await c.query("select count(*)::int as n from infrastructure_items where source_url = $1", [item.sourceUrl])).rows[0].n;
        expect(n).toBe(1);
        const notes = (await c.query("select note from infrastructure_review_events where development_id = $1 order by id", [first[0]])).rows.map((r) => r.note);
        expect(notes).toEqual(["found by web research", "seen again by web research (pending draft updated)"]);
      } finally {
        await c.query("rollback").catch(() => {});
        await c2?.end();
      }
    });
  });
});
