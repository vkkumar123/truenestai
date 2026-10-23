// M2.5 research job queue (0005_research_jobs.sql). Run with `npm run test:db`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asRole, errorAs, resetAndMigrate, tryConnect } from "./helpers";

const conn = await tryConnect();
const conn2 = conn.client ? await tryConnect() : { client: null };
if (!conn.client) console.warn(`[test:db] SKIPPED research-jobs: ${conn.reason}`);
const d = conn.client && conn2.client ? describe : describe.skip;

const HASH = "a".repeat(64);
const enqueue = (key: string, opts: { hash?: string | null; cache?: number; perDay?: number; perReq?: number } = {}) =>
  [
    "select research_enqueue($1, $2, null, $3, $4, $5, $6) as r",
    [`SAMPLE ${key}`, key, opts.hash ?? null, opts.cache ?? 168, opts.perDay ?? 50, opts.perReq ?? 10],
  ] as const;

d("research_jobs", () => {
  const c = conn.client as Client;
  const c2 = conn2.client as Client;

  beforeAll(async () => {
    await resetAndMigrate(c);
    await c.query(`
      insert into market_phases (id, name, sort_order, active) values ('north-bengaluru', 'North', 1, true);
      insert into zones (id, phase_id, name, boundary) values ('north-core', 'north-bengaluru', 'Z', '{}');
      insert into localities (id, zone_id, name, centroid_lat, centroid_lng) values ('hebbal', 'north-core', 'Hebbal', 13.03, 77.59);
      insert into sources (id, name, type, status, access_method, homepage) values
        ('sample-web-research', 'SAMPLE Web Research', 'fixture', 'approved', 'fixture', 'https://example.com/');
      insert into external_listings (id, source_id, canonical_url, title, limitations, is_sample) values
        ('sample-web-research:x1', 'sample-web-research', 'https://example.com/r/x1', 'SAMPLE X1', '{"Not verified by TrueNest"}', true);
    `);
  });
  afterAll(async () => {
    await c?.end();
    await c2?.end();
  });

  it("has RLS on and no client grants (tables and functions)", async () => {
    const { rows } = await c.query(
      "select relname, relrowsecurity from pg_class where relname in ('research_jobs','research_job_listings') order by relname",
    );
    expect(rows).toEqual([
      { relname: "research_job_listings", relrowsecurity: true },
      { relname: "research_jobs", relrowsecurity: true },
    ]);
    for (const role of ["anon", "authenticated"] as const) {
      expect((await errorAs(c, role, null, "select * from research_jobs"))?.code).toBe("42501");
      expect((await errorAs(c, role, null, "select * from research_job_listings"))?.code).toBe("42501");
      expect((await errorAs(c, role, null, "insert into research_jobs (query_text, query_key) values ('x', 'xyz')"))?.code).toBe("42501");
      const [sql, params] = enqueue("anon key");
      expect((await errorAs(c, role, null, sql, [...params]))?.code).toBe("42501");
      expect((await errorAs(c, role, null, "select research_claim_jobs(1, 15)"))?.code).toBe("42501");
      expect(
        (await errorAs(c, role, null, "select research_finish_job('00000000-0000-4000-8000-000000000000', 'done', 0, null, '{}')"))?.code,
      ).toBe("42501");
    }
    const fns = await c.query(
      "select proname, prosecdef, proconfig from pg_proc where proname in ('research_enqueue','research_claim_jobs','research_finish_job') order by proname",
    );
    for (const f of fns.rows) {
      expect(f.prosecdef).toBe(false); // security invoker
      expect(f.proconfig).toEqual(["search_path=public, pg_temp"]);
    }
  });

  it("enqueue: queued, then active for the same key; validates lengths", async () => {
    await asRole(c, "service_role", null, async (db) => {
      const [sql, p] = enqueue("hebbal zzq");
      const a = (await db.query(sql, [...p])).rows[0].r;
      expect(a.outcome).toBe("queued");
      expect(a.job).not.toHaveProperty("requester_ip_hash");
      const b = (await db.query(sql, [...p])).rows[0].r;
      expect(b).toMatchObject({ outcome: "active", job: { id: a.job.id } });
      const { rows } = await db.query("select count(*)::int as n from research_jobs");
      expect(rows[0].n).toBe(1);
    });
    expect((await errorAs(c, "service_role", null, "insert into research_jobs (query_text, query_key) values ($1, 'abc')", ["x".repeat(101)]))?.code).toBe("23514");
    expect((await errorAs(c, "service_role", null, "insert into research_jobs (query_text, query_key, error_code) values ('x', 'abc', 'Has PII!')"))?.code).toBe("23514");
    // Partial unique index: two active jobs for one key are impossible even without the function.
    expect(
      (await errorAs(c, "service_role", null, "insert into research_jobs (query_text, query_key) values ('a', 'dup'), ('b', 'dup')"))?.code,
    ).toBe("23505");
  });

  it("enqueue: cached within TTL, re-queued after; daily and per-requester caps", async () => {
    await asRole(c, "service_role", null, async (db) => {
      await db.query(`insert into research_jobs (query_text, query_key, status, finished_at, requested_at)
                      values ('SAMPLE old', 'old key', 'no_results', now() - interval '2 hours', now() - interval '3 hours')`);
      const [sql, p] = enqueue("old key", { cache: 24 });
      expect((await db.query(sql, [...p])).rows[0].r).toMatchObject({ outcome: "cached", job: { status: "no_results" } });
      const [sql2, p2] = enqueue("old key", { cache: 1 });
      expect((await db.query(sql2, [...p2])).rows[0].r.outcome).toBe("queued");

      // 2 jobs requested in the last 24h now → a cap of 2 refuses new keys, but not existing ones.
      const [s3, p3] = enqueue("brand new", { perDay: 2 });
      expect((await db.query(s3, [...p3])).rows[0].r).toEqual({ outcome: "daily_cap" });
      const [s4, p4] = enqueue("old key", { perDay: 0 });
      expect((await db.query(s4, [...p4])).rows[0].r.outcome).toBe("active");

      const [s5, p5] = enqueue("req one", { hash: HASH, perReq: 1 });
      expect((await db.query(s5, [...p5])).rows[0].r.outcome).toBe("queued");
      const [s6, p6] = enqueue("req two", { hash: HASH, perReq: 1 });
      expect((await db.query(s6, [...p6])).rows[0].r).toEqual({ outcome: "requester_cap" });
    });
  });

  it("enqueue marks queued jobs older than 30 minutes 'stalled' and treats failures within 6 h as failed_recently", async () => {
    await c.query("delete from research_jobs");
    await asRole(c, "service_role", null, async (db) => {
      await db.query(`insert into research_jobs (query_text, query_key, requested_at) values
        ('SAMPLE stuck', 'stuck key', now() - interval '31 minutes'),
        ('SAMPLE waiting', 'waiting key', now() - interval '5 minutes')`);
      const [sql, p] = enqueue("stuck key");
      expect((await db.query(sql, [...p])).rows[0].r).toMatchObject({ outcome: "failed_recently", job: { status: "failed", error_code: "stalled" } });
      const waiting = (await db.query("select status from research_jobs where query_key = 'waiting key'")).rows[0];
      expect(waiting.status).toBe("queued");
      // A failure older than 6 hours no longer blocks a new job.
      await db.query("update research_jobs set finished_at = now() - interval '7 hours' where query_key = 'stuck key'");
      expect((await db.query(sql, [...p])).rows[0].r.outcome).toBe("queued");
    });
  });

  it("claim uses FOR UPDATE SKIP LOCKED: concurrent workers take disjoint jobs", async () => {
    await c.query("delete from research_jobs");
    await c.query(`insert into research_jobs (query_text, query_key, requested_at) values
      ('SAMPLE a', 'key a', now() - interval '3 minutes'),
      ('SAMPLE b', 'key b', now() - interval '2 minutes'),
      ('SAMPLE c', 'key c', now() - interval '1 minute')`);
    try {
      await c.query("begin; set local role service_role");
      await c2.query("begin; set local role service_role");
      const first = (await c.query("select research_claim_jobs(1, 15) as j")).rows.map((r) => r.j.query_key);
      const second = (await c2.query("select research_claim_jobs(5, 15) as j")).rows.map((r) => r.j.query_key);
      expect(first).toEqual(["key a"]);
      expect(second.sort()).toEqual(["key b", "key c"]);
      const claimed = (await c2.query("select status, attempts from research_jobs where query_key = 'key b'")).rows[0];
      expect(claimed).toEqual({ status: "running", attempts: 1 });
    } finally {
      await c.query("rollback");
      await c2.query("rollback");
    }
  });

  it("claim reclaims stale running jobs with a retry left and abandons the rest", async () => {
    await c.query("delete from research_jobs");
    await c.query(`insert into research_jobs (query_text, query_key, status, started_at, attempts) values
      ('SAMPLE stale', 'stale', 'running', now() - interval '30 minutes', 1),
      ('SAMPLE spent', 'spent', 'running', now() - interval '30 minutes', 2),
      ('SAMPLE fresh', 'fresh', 'running', now() - interval '1 minute', 1)`);
    await asRole(c, "service_role", null, async (db) => {
      const rows = (await db.query("select research_claim_jobs(5, 15) as j")).rows.map((r) => r.j);
      expect(rows.map((j) => [j.query_key, j.attempts])).toEqual([["stale", 2]]);
      const spent = (await db.query("select status, error_code, finished_at is not null as done from research_jobs where query_key = 'spent'")).rows[0];
      expect(spent).toEqual({ status: "failed", error_code: "abandoned", done: true });
      expect((await db.query("select status from research_jobs where query_key = 'fresh'")).rows[0].status).toBe("running");
    });
  });

  it("finish: links listings, only from running, retry once then failed", async () => {
    await c.query("delete from research_jobs");
    const { rows } = await c.query(
      "insert into research_jobs (query_text, query_key, status, started_at, attempts) values ('SAMPLE f', 'fin', 'running', now(), 1) returning id",
    );
    const id = rows[0].id;
    await asRole(c, "service_role", null, async (db) => {
      const done = (await db.query("select research_finish_job($1, 'done', 1, null, array['sample-web-research:x1']) as r", [id])).rows[0].r;
      expect(done).toMatchObject({ status: "done", result_count: 1 });
      expect(done.finished_at).not.toBeNull();
      const links = await db.query("select external_listing_id from research_job_listings where job_id = $1", [id]);
      expect(links.rows).toEqual([{ external_listing_id: "sample-web-research:x1" }]);
      // Not running any more → no-op.
      expect((await db.query("select research_finish_job($1, 'failed', 0, 'timeout', '{}') as r", [id])).rows[0].r).toBeNull();
    });
    expect((await errorAs(c, "service_role", null, "select research_finish_job($1, 'bogus', 0, null, '{}')", [id]))?.code).toBe("22023");

    // Retry semantics: attempt 1 → queued; attempt 2 → forced to failed.
    await asRole(c, "service_role", null, async (db) => {
      await db.query("update research_jobs set status = 'running', finished_at = null, attempts = 1 where id = $1", [id]);
      expect((await db.query("select research_finish_job($1, 'queued', 0, 'timeout', '{}') as r", [id])).rows[0].r).toMatchObject({
        status: "queued",
        finished_at: null,
      });
      await db.query("update research_jobs set status = 'running', attempts = 2 where id = $1", [id]);
      expect((await db.query("select research_finish_job($1, 'queued', 0, 'timeout', '{}') as r", [id])).rows[0].r).toMatchObject({
        status: "failed",
        error_code: "timeout",
      });
    });
  });

  it("deleting a listing (takedown) removes its job link", async () => {
    await asRole(c, "service_role", null, async (db) => {
      const { rows } = await db.query("insert into research_jobs (query_text, query_key, status, finished_at) values ('SAMPLE t', 'take', 'done', now()) returning id");
      await db.query("insert into research_job_listings values ($1, 'sample-web-research:x1')", [rows[0].id]);
      await db.query("delete from external_listings where id = 'sample-web-research:x1'");
      const left = await db.query("select count(*)::int as n from research_job_listings where job_id = $1", [rows[0].id]);
      expect(left.rows[0].n).toBe(0);
    });
  });
});
