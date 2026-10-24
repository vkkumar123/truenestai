// S3a K-RERA document extraction (0007_document_extraction.sql): document_extractions, the
// extraction RPCs, document-linked observations, their constraints and grants, and the D19 source
// precedence in facts_current. Every row is fictional SAMPLE data (example.com / example.org).
// Run with `npm run test:db`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import { asRole, errorAs, resetAndMigrate, tryConnect } from "./helpers";

vi.mock("server-only", () => ({}));

const conn = await tryConnect();
if (!conn.client) console.warn(`[test:db] SKIPPED document-extraction: ${conn.reason}`);
const d = conn.client ? describe : describe.skip;

const STAFF_UID = "55555555-5555-4555-8555-555555555555";
const SHA = "a".repeat(64);

const start = (doc = "doc-rera") =>
  `select extraction_start('${doc}', 'claude-opus-5-5', 'staff-1', 'admin', 10) as r`;

const VALUES = JSON.stringify([
  { attribute: "rera_numbers", value_json: ["SAMPLE/RERA/0042/2026"], page_number: 1, excerpt: "Registration No.: SAMPLE/RERA/0042/2026" },
  { attribute: "total_units", value_num: 240, page_number: 2, excerpt: "Number of Units: 240" },
  { attribute: "rera_completion_date", value_date: "2028-12-31", page_number: 1, excerpt: "Proposed Date of Completion: 31-12-2028" },
  { attribute: "promoter_name", value_text: "SAMPLE Fictional Developers Pvt Ltd", page_number: 1, excerpt: "Promoter: SAMPLE Fictional Developers Pvt Ltd" },
]);

const finish = (id: string, status = "succeeded", values = VALUES, code: string | null = null) => ({
  sql: "select extraction_finish($1, $2, $3, $4::jsonb, 3, '{\"not_cited\": 1, \"personal_data\": 2}'::jsonb, 'staff-1', 'admin') as r",
  params: [id, status, code, values],
});

/** A document-linked observation insert (as extraction_finish would write it). */
function docObs(o: Record<string, string | number | null> = {}) {
  const row: Record<string, string | number | null> = {
    entity_type: "project", entity_id: "p1", attribute: "total_units", value_num: 240, status: "official",
    source_id: "sample-regulator", source_url: null, source_type: "rera", observed_at: "2026-10-01T00:00:00Z",
    last_verified_at: "2026-10-01T00:00:00Z", ttl_hours: 2160, excerpt: "Number of Units: 240", added_by: "extraction",
    is_sample: "true", document_id: "doc-rera", page_number: 2, ...o,
  };
  const cols = Object.keys(row);
  return { sql: `insert into fact_observations (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, params: cols.map((k) => row[k]) };
}

d("document extraction (0007)", () => {
  const c = conn.client as Client;

  beforeAll(async () => {
    await resetAndMigrate(c);
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
        ('sample-regulator', 'SAMPLE Regulator', 'regulator', 'proposed', 'link_out_only', 'https://example.org/'),
        ('sample-builder', 'SAMPLE Builder Site', 'developer', 'proposed', 'manual', 'https://example.com/');
      insert into staff_profiles (user_id, role) values ('${STAFF_UID}', 'admin');
      insert into project_documents (id, project_id, document_key, title, kind, version, source_id, source_url, observed_at, storage_path, content_type, size_bytes, sha256, uploaded_by) values
        ('doc-rera',  'p1', 'rera-certificate', 'SAMPLE certificate', 'rera_certificate', 1, 'sample-regulator', 'https://example.org/sample-rera/p1-v1', '2026-10-01T00:00:00Z', 'p1/rera-certificate/v1/a.pdf', 'application/pdf', 1000, '${SHA}', 'staff-1'),
        ('doc-rera2', 'p1', 'rera-certificate', 'SAMPLE certificate', 'rera_certificate', 2, 'sample-regulator', 'https://example.org/sample-rera/p1', '2026-10-05T00:00:00Z', 'p1/rera-certificate/v2/a.pdf', 'application/pdf', 1000, '${SHA}', 'staff-1'),
        ('doc-brochure', 'p1', 'brochure', 'SAMPLE brochure', 'brochure', 1, 'sample-builder', 'https://example.com/sample/p1/brochure', '2026-10-01T00:00:00Z', 'p1/brochure/v1/a.pdf', 'application/pdf', 1000, '${SHA}', 'staff-1'),
        ('doc-nourl', 'p1', 'legacy-certificate', 'SAMPLE legacy certificate', 'rera_certificate', 1, 'sample-regulator', null, '2026-10-01T00:00:00Z', 'p1/legacy-certificate/v1/a.pdf', 'application/pdf', 1000, '${SHA}', 'staff-1'),
        ('doc-p2', 'p2', 'rera-certificate', 'SAMPLE certificate', 'rera_certificate', 1, 'sample-regulator', null, '2026-10-01T00:00:00Z', 'p2/rera-certificate/v1/a.pdf', 'application/pdf', 1000, '${SHA}', 'staff-1');
    `);
  });
  afterAll(async () => {
    await c?.end();
  });

  it("RLS on; no anon/authenticated access to the table or the RPCs; service role cannot delete", async () => {
    const { rows } = await c.query("select relrowsecurity from pg_class where relname = 'document_extractions'");
    expect(rows[0].relrowsecurity).toBe(true);
    for (const role of ["anon", "authenticated"] as const) {
      const sub = role === "anon" ? null : STAFF_UID;
      expect((await errorAs(c, role, sub, "select * from document_extractions"))?.code).toBe("42501");
      expect((await errorAs(c, role, sub, start()))?.code).toBe("42501");
      expect((await errorAs(c, role, sub, finish("x").sql, finish("x").params))?.code).toBe("42501");
    }
    const priv = (await c.query(
      "select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants where grantee = 'service_role' and table_name = 'document_extractions'",
    )).rows[0].p;
    expect(priv).toBe("INSERT,SELECT,UPDATE");
    const fc = (await c.query(
      "select string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants where grantee = 'service_role' and table_name = 'facts_current'",
    )).rows[0].p;
    expect(fc).toBe("SELECT");
    expect((await errorAs(c, "anon", null, "select * from facts_current"))?.code).toBe("42501");
  });

  it("start → finish writes unverified official rera observations with document + page, counts and one audit event; idempotent", async () => {
    const out = await asRole(c, "service_role", null, async (q) => {
      const s1 = (await q.query(start())).rows[0].r;
      const s2 = (await q.query(start())).rows[0].r;
      const f = finish(s1.extraction.id);
      const fin = (await q.query(f.sql, f.params)).rows[0].r;
      const again = (await q.query(f.sql, f.params)).rows[0].r;
      const s3 = (await q.query(start())).rows[0].r;
      const obs = (await q.query(
        "select attribute, value_text, value_num, value_date::text, value_json, status, source_type, verification, added_by, document_id, page_number, excerpt, source_url, is_sample from fact_observations where document_id = 'doc-rera' order by attribute",
      )).rows;
      const audit = (await q.query("select field, action, note from fact_review_events where action = 'document_extracted'")).rows;
      return { s1, s2, fin, again, s3, obs, audit };
    });
    expect(out.s1).toMatchObject({ outcome: "started", extraction: { status: "running", attempts: 1, project_id: "p1", document_sha256: SHA } });
    expect(out.s2.outcome).toBe("in_progress");
    expect(out.fin).toMatchObject({ status: "ok", extraction: { status: "succeeded", kept_count: 4, dropped_count: 3, dropped_reasons: { not_cited: 1, personal_data: 2 } } });
    expect(out.again.status).toBe("not_running");
    expect(out.s3.outcome).toBe("done");
    expect(out.obs).toHaveLength(4);
    for (const o of out.obs) {
      expect(o).toMatchObject({ status: "official", source_type: "rera", verification: "unverified", added_by: "extraction", document_id: "doc-rera", source_url: "https://example.org/sample-rera/p1-v1", is_sample: true });
    }
    expect(out.obs.find((o) => o.attribute === "total_units")).toMatchObject({ value_num: "240", page_number: 2 });
    expect(out.obs.find((o) => o.attribute === "rera_numbers").value_json).toEqual(["SAMPLE/RERA/0042/2026"]);
    expect(out.audit).toEqual([
      { field: "documents", action: "document_extracted", note: "document extraction succeeded: SAMPLE certificate v1, 4 value(s) kept, 3 dropped" },
    ]);
  });

  it("failed extractions may be retried; unsupported and succeeded are final; error codes are required", async () => {
    const out = await asRole(c, "service_role", null, async (q) => {
      const s1 = (await q.query(start())).rows[0].r;
      const f1 = finish(s1.extraction.id, "failed", "[]", "timeout");
      await q.query(f1.sql, f1.params);
      const retry = (await q.query(start())).rows[0].r;
      const u = finish(retry.extraction.id, "unsupported", "[]", "not_pdf");
      await q.query(u.sql, u.params);
      const after = (await q.query(start())).rows[0].r;
      const obs = (await q.query("select count(*)::int as n from fact_observations where document_id = 'doc-rera'")).rows[0].n;
      return { retry, after, obs };
    });
    expect(out.retry).toMatchObject({ outcome: "started", extraction: { attempts: 2, status: "running" } });
    expect(out.after).toMatchObject({ outcome: "done", extraction: { status: "unsupported", error_code: "not_pdf" } });
    expect(out.obs).toBe(0);
    const setup = `insert into document_extractions (id, document_id, project_id, status, requested_by, requested_role) values ('x1', 'doc-rera', 'p1', 'running', 's', 'admin');`;
    // a failed/unsupported outcome without an error code, a direct terminal → running change, a delete
    expect((await errorAs(c, "service_role", null, "update document_extractions set status = 'failed', finished_at = now() where id = 'x1'", [], setup))?.code).toBe("23514");
    expect((await errorAs(c, "service_role", null,
      "update document_extractions set status = 'succeeded', finished_at = now() where id = 'x1'; update document_extractions set status = 'running', finished_at = null where id = 'x1'", [], setup))?.code).toBe("23514");
    expect((await errorAs(c, "service_role", null, "insert into document_extractions (document_id, project_id, status, requested_by, requested_role) values ('doc-p2', 'p1', 'running', 's', 'admin')"))?.code).toBe("23514");
    expect((await errorAs(c, "service_role", null, "delete from document_extractions where id = 'x1'", [], setup))?.code).toBe("42501");
    // TRUNCATE is refused even for the owner (superuser here)
    await c.query("begin");
    try {
      await c.query(setup);
      await expect(c.query("truncate document_extractions")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await c.query("rollback");
    }
  });

  it("only regulator (or fixture) documents can be extracted into observations", async () => {
    const e = await asRole(c, "service_role", null, async (q) => {
      const s = (await q.query(start("doc-brochure"))).rows[0].r;
      const f = finish(s.extraction.id);
      try {
        await q.query(f.sql, f.params);
        return null;
      } catch (err) {
        return (err as { code?: string }).code;
      }
    });
    expect(e).toBe("23514");
  });

  it("finishing as succeeded is refused for a document without a source URL (constitution §1) and for a duplicate attribute", async () => {
    const run = (doc: string, values: string) =>
      asRole(c, "service_role", null, async (q) => {
        const s = (await q.query(start(doc))).rows[0].r;
        const f = finish(s.extraction.id, "succeeded", values);
        try {
          await q.query(f.sql, f.params);
          return null;
        } catch (err) {
          return (err as { message?: string }).message;
        }
      });
    expect(await run("doc-nourl", VALUES)).toMatch(/without a source URL/);
    const dup = JSON.stringify([
      { attribute: "total_units", value_num: 240, page_number: 2, excerpt: "Number of Units: 240" },
      { attribute: "total_units", value_num: 250, page_number: 2, excerpt: "Number of Units: 250" },
    ]);
    expect(await run("doc-rera2", dup)).toMatch(/duplicate attribute/);
    // an unsupported outcome for the URL-less document is still recorded (nothing stored)
    const done = await asRole(c, "service_role", null, async (q) => {
      const s = (await q.query(start("doc-nourl"))).rows[0].r;
      const f = finish(s.extraction.id, "unsupported", "[]", "source_url_missing");
      return (await q.query(f.sql, f.params)).rows[0].r;
    });
    expect(done).toMatchObject({ status: "ok", extraction: { status: "unsupported", error_code: "source_url_missing", kept_count: 0 } });
  });

  it("document observations: constraints keep provenance, the 0006 guarantees and the document's project", async () => {
    const err = async (o: Record<string, string | number | null>) => {
      const x = docObs(o);
      return (await errorAs(c, "service_role", null, x.sql, x.params))?.code;
    };
    expect(await err({})).toBeUndefined(); // the baseline row is valid (no URL needed with a document)
    expect(await err({ excerpt: null })).toBe("23514");
    expect(await err({ added_by: "crawl" })).toBe("23514");
    expect(await err({ source_type: "builder" })).toBe("23514");
    expect(await err({ page_number: null })).toBe("23514");
    expect(await err({ document_id: null })).toBe("23514"); // page without a document, and no source_url
    expect(await err({ verification: "reviewed" })).toBe("23514");
    expect(await err({ excerpt: Array.from({ length: 21 }, () => "w").join(" ") })).toBe("23514");
    expect(await err({ entity_id: "p2" })).toBe("23514"); // not the document's project
    expect(await err({ source_id: "sample-feed", source_type: "fixture" })).toBe("23514"); // not the document's source
    expect(await err({ document_id: "missing" })).toBe("23503");
    // rows without a document are unchanged: a known value still needs a source URL
    expect(await err({ document_id: null, page_number: null, added_by: "crawl", excerpt: null })).toBe("23514");
    // document_id is identity
    const x = docObs();
    const changed = await asRole(c, "service_role", null, async (q) => {
      await q.query(x.sql, x.params);
      try {
        await q.query("update fact_observations set document_id = 'doc-rera2' where document_id = 'doc-rera'");
        return null;
      } catch (e) {
        return (e as { code?: string }).code;
      }
    });
    expect(changed).toBe("23514");
  });

  it("one value per attribute per document version; two versions both stay; deleting a document keeps history", async () => {
    const out = await asRole(c, "service_role", null, async (q) => {
      const a = docObs();
      await q.query(a.sql, a.params);
      const dup = await q.query("savepoint s").then(async () => {
        try {
          await q.query(a.sql, a.params);
          return null;
        } catch (e) {
          await q.query("rollback to savepoint s");
          return (e as { code?: string }).code;
        }
      });
      const b = docObs({ document_id: "doc-rera2", value_num: 250, excerpt: "Number of Units: 250", observed_at: "2026-10-05T00:00:00Z", last_verified_at: "2026-10-05T00:00:00Z" });
      await q.query(b.sql, b.params);
      const current = (await q.query("select value_num, conflict_count, has_disagreement from facts_current where entity_id = 'p1' and attribute = 'total_units'")).rows[0];
      return { dup, current };
    });
    expect(out.dup).toBe("23505");
    expect(out.current).toEqual({ value_num: "250", conflict_count: 1, has_disagreement: true });
    // cascade delete of a document (SAMPLE cleanup) removes its observations into history, with the link
    await c.query("begin");
    let hist;
    try {
      const a = docObs();
      await c.query(a.sql, a.params);
      await c.query("delete from project_documents where id = 'doc-rera'");
      hist = {
        live: (await c.query("select count(*)::int as n from fact_observations where document_id = 'doc-rera'")).rows[0].n,
        history: (await c.query("select operation, document_id, page_number from fact_observations_history where document_id = 'doc-rera'")).rows,
      };
    } finally {
      await c.query("rollback");
    }
    expect(hist).toEqual({ live: 0, history: [{ operation: "DELETE", document_id: "doc-rera", page_number: 2 }] });
  });

  it("D19: a K-RERA document value beats a newer builder-site value; both appear (rera first) and nothing is hidden", async () => {
    const rows = await asRole(c, "service_role", null, async (q) => {
      const rera = docObs({ attribute: "rera_completion_date", value_num: null, value_date: "2028-12-31", excerpt: "Proposed Date of Completion: 31-12-2028", page_number: 1, ttl_hours: 168 });
      await q.query(rera.sql, rera.params);
      // newer official builder value (crawl of the builder site)
      await q.query(
        `insert into fact_observations (entity_type, entity_id, attribute, value_date, status, source_id, source_url, source_type, observed_at, last_verified_at, ttl_hours, added_by, is_sample)
         values ('project', 'p1', 'rera_completion_date', '2028-06-30', 'official', 'sample-builder', 'https://example.com/sample/p1/possession', 'builder', '2026-10-20T00:00:00Z', '2026-10-20T00:00:00Z', 168, 'crawl', true),
                ('project', 'p1', 'rera_completion_date', '2029-01-31', 'official', 'sample-feed', 'https://example.org/sample/p1/other', 'fixture', '2026-10-21T00:00:00Z', '2026-10-21T00:00:00Z', 168, 'crawl', true)`,
      );
      return (await q.query(
        "select value_date::text, source_type, conflict_count, has_disagreement, conflicts from facts_current where entity_id = 'p1' and attribute = 'rera_completion_date'",
      )).rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value_date: "2028-12-31", source_type: "rera", conflict_count: 2, has_disagreement: true });
    expect(rows[0].conflicts.map((x: Record<string, unknown>) => [x.source_type, x.value_date])).toEqual([
      ["builder", "2028-06-30"],
      ["fixture", "2029-01-31"],
    ]);
  });

  it("D19: a verified curated value still wins outright over a K-RERA observation", async () => {
    const rows = await asRole(c, "service_role", null, async (q) => {
      await q.query(`select research_set_fact('p1', 'address', 'known', '"SAMPLE Road 9 (curated)"'::jsonb, 'reviewed',
        '[{"sourceId":"sample-builder","url":"https://example.com/sample/p1/address","observedAt":"2026-01-01T00:00:00Z"}]'::jsonb, 'staff-1', 'admin')`);
      const a = docObs({ attribute: "address", value_num: null, value_text: "SAMPLE Road 1 (document)", excerpt: "Site Address: SAMPLE Road 1 (document)", page_number: 2 });
      await q.query(a.sql, a.params);
      return (await q.query("select origin, value_text, conflicts from facts_current where entity_id = 'p1' and attribute = 'address'")).rows;
    });
    expect(rows[0]).toMatchObject({ origin: "curated", value_text: "SAMPLE Road 9 (curated)" });
    expect(rows[0].conflicts.map((x: Record<string, unknown>) => [x.origin, x.source_type, x.value_text])).toEqual([["observation", "rera", "SAMPLE Road 1 (document)"]]);
  });
});
