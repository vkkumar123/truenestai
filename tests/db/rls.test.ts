// Migration + RLS tests. Run with `npm run test:db` against DATABASE_URL_TEST.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { asRole, errorAs, resetAndMigrate, tryConnect, DATABASE_URL_TEST } from "./helpers";

const conn = await tryConnect();
if (!conn.client) {
  console.warn(
    `[test:db] SKIPPED: cannot reach test Postgres at ${DATABASE_URL_TEST.replace(/\/\/[^@]*@/, "//***@")} ` +
      `(${conn.reason}). Start Postgres or set DATABASE_URL_TEST.`,
  );
}
const d = conn.client ? describe : describe.skip;

const STAFF_UID = "11111111-1111-4111-8111-111111111111";
const OTHER_UID = "22222222-2222-4222-8222-222222222222";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const CONSENT_VERSION = "2026-10-21.v1";

async function seed(c: Client) {
  await c.query(`
    insert into market_phases (id, name, sort_order, active) values ('north-bengaluru', 'North Bengaluru', 1, true);
    insert into zones (id, phase_id, name, boundary) values
      ('north-core', 'north-bengaluru', 'SAMPLE zone', '{"type":"Polygon","coordinates":[]}');
    insert into localities (id, zone_id, name, centroid_lat, centroid_lng) values
      ('hebbal', 'north-core', 'Hebbal', 13.035, 77.597);
    insert into sources (id, name, type, status, access_method, homepage) values
      ('sample-feed', 'SAMPLE Feed', 'fixture', 'approved', 'fixture', 'https://example.com/'),
      ('candidate-portal', 'Candidate', 'listing_portal', 'proposed', 'link_out_only', 'https://example.org/');
    insert into developers (id, name, is_sample) values ('dev-a', 'SAMPLE Developer A', true),
      ('dev-hidden', 'SAMPLE Developer Hidden', true);
    insert into projects (id, slug, name, developer_id, locality_id, lat, lng, location_precision, is_sample, published) values
      ('p-pub', 'sample-pub', 'SAMPLE Published', 'dev-a', 'hebbal', 13.03, 77.59, 'approximate', true, true),
      ('p-hidden', 'sample-hidden', 'SAMPLE Unpublished', 'dev-hidden', 'hebbal', 13.04, 77.60, 'approximate', true, false);
    insert into facts (id, project_id, field, value, status, verification) values
      ('f-pub', 'p-pub', 'rera_numbers', '["SAMPLE-RERA-0001"]', 'known', 'unverified'),
      ('f-pub-unknown', 'p-pub', 'declared_possession', null, 'unknown', 'unverified'),
      ('f-hidden', 'p-hidden', 'rera_numbers', '["SAMPLE-RERA-0099"]', 'known', 'unverified'),
      ('f-pub-status', 'p-pub', 'construction_status', '"under_construction"', 'known', 'unverified');
    insert into project_units (project_id, label) values ('p-pub', '2 BHK'), ('p-pub', '3BHK + study'), ('p-pub', 'Plot'),
      ('p-hidden', '4 BHK');
    insert into fact_sources (fact_id, source_id, url, observed_at) values
      ('f-pub', 'sample-feed', 'https://example.com/a', now()),
      ('f-hidden', 'sample-feed', 'https://example.com/h', now());
    insert into regulatory_records (project_id, kind, summary, status_status, status_value, source_id, observed_at) values
      ('p-hidden', 'complaint', 'SAMPLE complaint', 'known', 'pending', 'sample-feed', now());
    insert into regulatory_searches (project_id, kind, source_id, url, searched_at, results_found) values
      ('p-pub', 'complaint', 'sample-feed', 'https://example.com/s', now(), 0),
      ('p-hidden', 'complaint', 'sample-feed', 'https://example.com/s2', now(), 1);
    insert into project_documents (project_id, document_key, title, kind, source_id, observed_at, storage_path) values
      ('p-pub', 'brochure', 'SAMPLE brochure', 'brochure', 'sample-feed', now(), 'private/x.pdf');
    insert into external_listings (id, source_id, source_record_id, canonical_url, title, limitations, is_sample) values
      ('sample-feed:X1', 'sample-feed', 'X1', 'https://example.com/x1', 'SAMPLE X1', '{"Not verified by TrueNest"}', true);
    insert into infrastructure_items (id, name, category, stage, declared_completion, published, is_sample) values
      ('i-pub', 'SAMPLE Metro', 'metro', 'proposed', '{"status":"unknown","value":null}', true, true),
      ('i-draft', 'SAMPLE Draft Road', 'road', 'proposed', '{"status":"unknown","value":null}', false, true);
    insert into staff_profiles (user_id, role) values ('${STAFF_UID}', 'advisor');
    insert into leads (id, request_type, name, email, preferred_channel, contact_consent, consent_text_version)
      values ('${LEAD_ID}', 'verification', 'SAMPLE Buyer', 'buyer@example.com', 'email', true, '${CONSENT_VERSION}');
  `);
}

const insertLead = (consent: boolean, status = "new") => [
  `insert into leads (request_type, name, email, preferred_channel, contact_consent, consent_text_version, status)
   values ('buyer_assistance', 'SAMPLE Person', 'p@example.com', 'email', $1, $2, $3)`,
  [consent, CONSENT_VERSION, status],
] as const;

d("migrations + RLS", () => {
  const c = conn.client as Client;

  beforeAll(async () => {
    await resetAndMigrate(c);
    await seed(c);
  });
  afterAll(async () => {
    await c?.end();
  });

  it("enables RLS on every public table", async () => {
    const { rows } = await c.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("migration does not define auth.uid() (shim is test-only)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../../supabase/migrations/0001_core.sql", import.meta.url), "utf8");
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function\s+auth\./i);
    expect(sql).not.toMatch(/create\s+role/i);
  });

  describe("anon", () => {
    it("reads only published projects", async () => {
      const rows = await asRole(c, "anon", null, async (q) => (await q.query("select id from projects order by id")).rows);
      expect(rows).toEqual([{ id: "p-pub" }]);
    });

    it("cannot read children of unpublished projects", async () => {
      const r = await asRole(c, "anon", null, async (q) => ({
        facts: (await q.query("select id from facts order by id")).rows.map((x) => x.id),
        factSources: (await q.query("select fact_id from fact_sources")).rows.map((x) => x.fact_id),
        reg: (await q.query("select id from regulatory_records")).rows,
        searches: (await q.query("select project_id, results_found from regulatory_searches")).rows,
        devs: (await q.query("select id from developers")).rows.map((x) => x.id),
      }));
      expect(r.facts).toEqual(["f-pub", "f-pub-status", "f-pub-unknown"]);
      expect(r.factSources).toEqual(["f-pub"]);
      expect(r.reg).toEqual([]);
      expect(r.searches).toEqual([{ project_id: "p-pub", results_found: 0 }]);
      expect(r.devs).toEqual(["dev-a"]);
    });

    it("keeps unknown facts distinct from values (unknown has null value)", async () => {
      const rows = await asRole(c, "anon", null, async (q) =>
        (await q.query("select status, value from facts where id = 'f-pub-unknown'")).rows,
      );
      expect(rows).toEqual([{ status: "unknown", value: null }]);
      const err = await errorAs(c, "service_role", null,
        `insert into facts (project_id, field, value, status) values ('p-pub', 'address', null, 'known')`);
      expect(err?.code).toBe("23514");
    });

    it("cannot read document storage paths", async () => {
      const err = await errorAs(c, "anon", null, "select storage_path from project_documents");
      expect(err?.code).toBe("42501");
      const rows = await asRole(c, "anon", null, async (q) => (await q.query("select title from project_documents")).rows);
      expect(rows).toEqual([{ title: "SAMPLE brochure" }]);
    });

    it("reads reference data, approved sources, external listings, published infrastructure", async () => {
      const r = await asRole(c, "anon", null, async (q) => ({
        loc: (await q.query("select id from localities")).rows.length,
        src: (await q.query("select id from sources")).rows.map((x) => x.id),
        ext: (await q.query("select id from external_listings")).rows.length,
        infra: (await q.query("select id from infrastructure_items")).rows.map((x) => x.id),
      }));
      expect(r).toEqual({ loc: 1, src: ["sample-feed"], ext: 1, infra: ["i-pub"] });
    });

    it("cannot read source_observations or staff_profiles", async () => {
      expect((await errorAs(c, "anon", null, "select * from source_observations"))?.code).toBe("42501");
      expect((await errorAs(c, "anon", null, "select * from staff_profiles"))?.code).toBe("42501");
    });

    it("cannot read leads", async () => {
      const err = await errorAs(c, "anon", null, "select * from leads");
      expect(err?.code).toBe("42501");
    });

    it("cannot insert leads at all (server stores leads with the service role)", async () => {
      for (const consent of [true, false]) {
        const [sql, params] = insertLead(consent);
        const err = await errorAs(c, "anon", null, sql, [...params]);
        expect(err?.code).toBe("42501");
      }
      const [sql, params] = insertLead(true);
      expect((await errorAs(c, "authenticated", OTHER_UID, sql, [...params]))?.code).toBe("42501");
      expect((await errorAs(c, "authenticated", STAFF_UID, sql, [...params]))?.code).toBe("42501");
    });

    it("search index view shows only published projects with current facts", async () => {
      const rows = await asRole(c, "anon", null, async (q) =>
        (await q.query("select id, construction_status, bhk_counts, max_bhk from project_search_index order by id")).rows,
      );
      expect(rows).toEqual([{ id: "p-pub", construction_status: "under_construction", bhk_counts: [2, 3], max_bhk: 3 }]);
    });

    it("cannot insert or update projects or facts", async () => {
      const ins = await errorAs(c, "anon", null,
        `insert into projects (slug, name, developer_id, locality_id, lat, lng, location_precision)
         values ('x', 'x', 'dev-a', 'hebbal', 13, 77, 'exact')`);
      expect(ins?.code).toBe("42501");
      const upd = await errorAs(c, "anon", null, "update projects set published = true where id = 'p-hidden'");
      expect(upd?.code).toBe("42501");
      const fact = await errorAs(c, "anon", null,
        `insert into facts (project_id, field, value, status) values ('p-pub', 'address', '"x"', 'known')`);
      expect(fact?.code).toBe("42501");
    });
  });

  describe("authenticated", () => {
    it("staff can read and update leads", async () => {
      const r = await asRole(c, "authenticated", STAFF_UID, async (q) => {
        const before = (await q.query("select id, status from leads")).rows;
        const upd = await q.query("update leads set status = 'contacted' where id = $1", [LEAD_ID]);
        await q.query(
          "insert into lead_events (lead_id, actor_id, event_type, from_status, to_status) values ($1, $2, 'status_changed', 'new', 'contacted')",
          [LEAD_ID, STAFF_UID],
        );
        return { before, updated: upd.rowCount };
      });
      expect(r.before).toEqual([{ id: LEAD_ID, status: "new" }]);
      expect(r.updated).toBe(1);
    });

    it("staff cannot make an invalid status transition", async () => {
      const err = await errorAs(c, "authenticated", STAFF_UID, "update leads set status = 'qualified' where id = $1", [LEAD_ID]);
      expect(err?.message).toMatch(/invalid lead status transition/);
    });

    it("staff cannot write audit events as someone else", async () => {
      const err = await errorAs(c, "authenticated", STAFF_UID,
        "insert into lead_events (lead_id, actor_id, event_type) values ($1, $2, 'status_changed')", [LEAD_ID, OTHER_UID]);
      expect(err?.message).toMatch(/row-level security/);
    });

    it("non-staff authenticated users cannot read or update leads", async () => {
      const r = await asRole(c, "authenticated", OTHER_UID, async (q) => ({
        rows: (await q.query("select * from leads")).rows,
        updated: (await q.query("update leads set status = 'contacted' where id = $1", [LEAD_ID])).rowCount,
        staff: (await q.query("select public.is_staff() as s")).rows[0].s,
      }));
      expect(r).toEqual({ rows: [], updated: 0, staff: false });
    });

    it("signed-in users see only their own staff profile", async () => {
      const own = await asRole(c, "authenticated", STAFF_UID, async (q) => (await q.query("select role from staff_profiles")).rows);
      const other = await asRole(c, "authenticated", OTHER_UID, async (q) => (await q.query("select role from staff_profiles")).rows);
      expect(own).toEqual([{ role: "advisor" }]);
      expect(other).toEqual([]);
    });

    it("staff cannot write projects (service role only)", async () => {
      const err = await errorAs(c, "authenticated", STAFF_UID, "update projects set published = true where id = 'p-hidden'");
      expect(err?.code).toBe("42501");
    });

    it("authenticated non-staff cannot self-promote via staff_profiles", async () => {
      const err = await errorAs(c, "authenticated", OTHER_UID,
        "insert into staff_profiles (user_id, role) values ($1, 'admin')", [OTHER_UID]);
      expect(err?.code).toBe("42501");
    });
  });

  describe("service_role", () => {
    it("bypasses RLS for server-side workers", async () => {
      const r = await asRole(c, "service_role", null, async (q) => ({
        projects: (await q.query("select count(*)::int as n from projects")).rows[0].n,
        leads: (await q.query("select count(*)::int as n from leads")).rows[0].n,
      }));
      expect(r).toEqual({ projects: 2, leads: 1 });
    });
  });

  describe("constraints", () => {
    it("rejects duplicate external listings per (source_id, source_record_id)", async () => {
      const err = await errorAs(c, "service_role", null,
        `insert into external_listings (id, source_id, source_record_id, canonical_url, title, limitations)
         values ('dup', 'sample-feed', 'X1', 'https://example.com/other', 'SAMPLE dup', '{"x"}')`);
      expect(err?.code).toBe("23505");
    });

    it("rejects an approved non-fixture source without a terms review", async () => {
      const err = await errorAs(c, "service_role", null, "update sources set status = 'approved' where id = 'candidate-portal'");
      expect(err?.code).toBe("23514");
    });

    it("service role can insert a consented lead and an audit event is written", async () => {
      const r = await asRole(c, "service_role", null, async (q) => {
        const [sql, params] = insertLead(true);
        await q.query(sql, [...params]);
        return (await q.query("select count(*)::int as n from lead_events where event_type = 'created'")).rows[0].n;
      });
      expect(r).toBe(2);
    });

    it("rejects non-https source URLs", async () => {
      for (const sql of [
        "insert into fact_sources (fact_id, source_id, url, observed_at) values ('f-pub', 'sample-feed', 'http://example.com/x', now())",
        "insert into regulatory_records (project_id, kind, summary, status_status, source_id, source_url, observed_at) values ('p-pub', 'order', 's', 'unknown', 'sample-feed', 'javascript:alert(1)', now())",
        "insert into regulatory_searches (project_id, kind, source_id, url, searched_at, results_found) values ('p-pub', 'order', 'sample-feed', 'ftp://example.com', now(), 0)",
        "insert into project_documents (project_id, document_key, title, kind, source_id, source_url, observed_at) values ('p-pub', 'k', 't', 'other', 'sample-feed', 'http://example.com', now())",
      ]) {
        expect((await errorAs(c, "service_role", null, sql))?.code).toBe("23514");
      }
      expect(await errorAs(c, "service_role", null,
        "insert into fact_sources (fact_id, source_id, url, observed_at) values ('f-pub', 'sample-feed', null, now())")).toBeNull();
    });

    it("freezes personal data on withdrawn leads, for every role", async () => {
      const err = await asRole(c, "service_role", null, async (q) => {
        await q.query("update leads set status = 'withdrawn', name = '[erased]', email = null, phone = null, contact_consent = false where id = $1", [LEAD_ID]);
        try {
          await q.query("update leads set email = 'again@example.com' where id = $1", [LEAD_ID]);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      });
      expect(err).toMatch(/withdrawn lead personal data cannot be changed/);
    });

    it("rejects a lead without consent even from the service role", async () => {
      const [sql, params] = insertLead(false);
      const err = await errorAs(c, "service_role", null, sql, [...params]);
      expect(err?.code).toBe("23514");
    });
  });
});
