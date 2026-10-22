// M2: the SQL readiness check (tn_publish_blockers) must use the same constants as
// src/research/publish.ts. Parses the migration file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLISH_MIN_COMPLETENESS, PUBLISH_ROLE } from "@/research/publish";

const sql = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/0002_research_audit.sql"), "utf8");

describe("SQL publish rules stay in sync with src/research/publish.ts", () => {
  it("minimum completeness matches", () => {
    const m = /c_min_completeness\s+constant\s+numeric\s*:=\s*([0-9.]+)/.exec(sql);
    expect(m, "c_min_completeness not found in 0002 migration").not.toBeNull();
    expect(Number(m![1])).toBe(PUBLISH_MIN_COMPLETENESS);
  });

  it("RERA verification states match the TS blocker rule", () => {
    const m = /c_rera_ok\s+constant\s+text\[\]\s*:=\s*array\[([^\]]+)\]/.exec(sql);
    expect(m).not.toBeNull();
    const states = m![1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
    expect(states).toEqual(["reviewed", "source_confirmed"]);
  });

  it("publish role is admin (service-layer check; SQL is service-role only)", () => {
    expect(PUBLISH_ROLE).toBe("admin");
    expect(sql).toMatch(/grant execute on function %s to service_role/);
  });
});
