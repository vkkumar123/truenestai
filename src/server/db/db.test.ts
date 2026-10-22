import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { buildSeedSql, lit } = await import("./seed");
const { parseMigrateArgs, redactDbUrl, transactionalScript, sha256 } = await import("./migrate");
const { SAMPLE_PROJECTS } = await import("../repositories/fixture/sample-projects");

const ROOT = path.resolve(__dirname, "../../..");

describe("seed builder", () => {
  it("committed supabase/seed/*.sql are up to date (run npm run db:seed:generate)", () => {
    expect(readFileSync(path.join(ROOT, "supabase/seed/seed.sql"), "utf8")).toBe(buildSeedSql({ sample: true }));
    expect(readFileSync(path.join(ROOT, "supabase/seed/reference.sql"), "utf8")).toBe(buildSeedSql({ sample: false }));
  });

  it("reference-only seed contains no projects; full seed uses idempotent conflict clauses", () => {
    const ref = buildSeedSql({ sample: false });
    expect(ref).not.toMatch(/insert into public\.projects/);
    expect(ref).toMatch(/insert into public\.sources/);
    const full = buildSeedSql();
    for (const t of ["developers", "projects", "facts", "fact_sources"]) {
      expect(full).toMatch(new RegExp(`insert into public\\.${t} [\\s\\S]*?on conflict do nothing;`));
    }
    expect(full).toMatch(/insert into public\.localities[\s\S]*?on conflict \(id\) do update set/);
  });

  it("refuses to seed anything that is not an obvious SAMPLE", () => {
    const real = { ...structuredClone(SAMPLE_PROJECTS[0]), name: "Real Project", isSample: false };
    expect(() => buildSeedSql({}, [real])).toThrow(/non-SAMPLE/);
  });

  it("escapes SQL literals", () => {
    expect(lit("O'Brien")).toBe("'O''Brien'");
    expect(lit(null)).toBe("null");
    expect(lit(1.5)).toBe("1.5");
    expect(() => lit(Number.NaN)).toThrow();
    expect(() => lit("a\u0000b")).toThrow();
  });
});

describe("migration runner helpers", () => {
  it("parses CLI args", () => {
    expect(parseMigrateArgs([])).toEqual({ ok: true, args: { seed: "none", dryRun: false, help: false } });
    expect(parseMigrateArgs(["--seed", "--dry-run"])).toMatchObject({ ok: true, args: { seed: "full", dryRun: true } });
    expect(parseMigrateArgs(["--seed=reference"])).toMatchObject({ ok: true, args: { seed: "reference" } });
    expect(parseMigrateArgs(["--seed=everything"])).toMatchObject({ ok: false });
  });

  it("splices the ledger insert inside the migration's own transaction", () => {
    const f = { name: "0009_x.sql", sql: "-- c\nbegin;\nselect 1;\ncommit;\n", checksum: sha256("x") };
    const s = transactionalScript(f);
    expect(s.match(/begin;/g)).toHaveLength(1);
    expect(s.match(/commit;/g)).toHaveLength(1);
    expect(s.indexOf("insert into private.schema_migrations")).toBeLessThan(s.lastIndexOf("commit;"));
    const bare = transactionalScript({ ...f, sql: "select 1;" });
    expect(bare.startsWith("begin;")).toBe(true);
    expect(bare.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("redacts passwords from database URLs", () => {
    expect(redactDbUrl("postgresql://postgres.ref:s3cret@aws-0.pooler.supabase.com:6543/postgres")).toBe(
      "postgresql://postgres.ref:***@aws-0.pooler.supabase.com:6543/postgres",
    );
    expect(redactDbUrl("postgres://u:p@localhost/db")).not.toMatch(/:p@/);
    expect(redactDbUrl("not a url")).toBe("(unparseable database URL)");
  });
});
