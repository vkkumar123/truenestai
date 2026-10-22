// Regenerates supabase/seed/seed.sql (reference + SAMPLE projects) and supabase/seed/reference.sql
// (geography + source registry only) from the in-repo sources of truth.
// Run: npm run db:seed:generate   (tsx --conditions=react-server scripts/generate-seed.ts)
// `--check` exits 1 if the committed files are stale (for CI).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSeedSql } from "../src/server/db/seed";

const ROOT = path.resolve(__dirname, "..");
export const SEED_FILES = {
  full: path.join(ROOT, "supabase/seed/seed.sql"),
  reference: path.join(ROOT, "supabase/seed/reference.sql"),
};

const outputs: [string, string][] = [
  [SEED_FILES.full, buildSeedSql({ sample: true })],
  [SEED_FILES.reference, buildSeedSql({ sample: false })],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [file, sql] of outputs) {
  const rel = path.relative(ROOT, file);
  if (check) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // missing counts as stale
    }
    if (current !== sql) {
      console.error(`stale: ${rel} (run npm run db:seed:generate)`);
      stale++;
    }
  } else {
    writeFileSync(file, sql);
    console.log(`wrote ${rel} (${sql.length} bytes)`);
  }
}
if (stale) process.exit(1);
