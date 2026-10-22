// Applies supabase/migrations/*.sql in order (ledger: private.schema_migrations), then optionally
// the idempotent seed. Connection: SUPABASE_DB_URL (Postgres connection string; secret — never
// printed). Run via npm scripts:
//   npm run db:migrate                      migrations only
//   npm run db:seed                         migrations + supabase/seed/seed.sql (reference + SAMPLE projects)
//   npm run db:migrate -- --seed=reference  migrations + geography/sources only (production)
//   npm run db:migrate -- --dry-run         list what would run
import path from "node:path";
import { Client } from "pg";
import { migrate, parseMigrateArgs, redactDbUrl } from "../src/server/db/migrate";

const ROOT = path.resolve(__dirname, "..");
const USAGE = "Usage: db-migrate [--seed | --seed=full | --seed=reference] [--dry-run]";

async function main(): Promise<number> {
  const parsed = parseMigrateArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  if (parsed.args.help) {
    console.log(USAGE);
    return 0;
  }
  const url = process.env.SUPABASE_DB_URL?.trim();
  if (!url) {
    console.error("SUPABASE_DB_URL is not set (see .env.example and docs/SUPABASE_SETUP.md).");
    return 2;
  }
  const seedFiles =
    parsed.args.seed === "full"
      ? [path.join(ROOT, "supabase/seed/seed.sql")]
      : parsed.args.seed === "reference"
        ? [path.join(ROOT, "supabase/seed/reference.sql")]
        : [];
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  console.log(`database: ${redactDbUrl(url)}`);
  try {
    await client.connect();
    const r = await migrate(client, {
      migrationsDir: path.join(ROOT, "supabase/migrations"),
      seedFiles,
      dryRun: parsed.args.dryRun,
      log: (line) => console.log(line),
    });
    console.log(
      `${parsed.args.dryRun ? "dry run: " : ""}applied ${r.applied.length}, already applied ${r.skipped.length}, seed files ${r.seeded.length}`,
    );
    if (parsed.args.seed === "full") console.log("note: SAMPLE (fictional) projects are seeded — use --seed=reference for production.");
    return 0;
  } catch (e) {
    // pg error messages do not include the connection password; still print only name/code/message.
    const err = e as { name?: string; code?: string; message?: string };
    console.error(`migration failed: ${err.name ?? "Error"}${err.code ? ` (${err.code})` : ""}: ${err.message ?? ""}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().then((code) => process.exit(code));
