import "server-only";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Applies supabase/migrations/*.sql in filename order, recording each in a ledger
// (private.schema_migrations: name, sha256 checksum, applied_at). Each migration and its ledger
// row commit in ONE transaction. An already-applied file whose checksum changed is an error
// (never edit an applied migration — add a new one). A session advisory lock stops two runners
// from interleaving. Used by scripts/db-migrate.ts and by the DB tests.
// NOTE: this ledger is separate from the Supabase CLI's (supabase_migrations.schema_migrations);
// use one tool per database (docs/SUPABASE_SETUP.md).

/** Minimal pg-compatible client surface (pg.Client satisfies it). */
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  seeded: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

const LOCK_KEY = 727_270_001; // arbitrary constant for pg_advisory_lock
const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readMigrationFiles(dir: string): MigrationFile[] {
  const names = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const n of names) {
    if (!MIGRATION_NAME.test(n)) throw new MigrationError(`Unexpected migration file name: ${n} (expected NNNN_name.sql)`);
  }
  return names.map((name) => {
    const sql = readFileSync(path.join(dir, name), "utf8");
    return { name, sql, checksum: sha256(sql) };
  });
}

const LEADING_BEGIN = /^(?:\s|--[^\n]*\n)*begin\s*;/i;
const TRAILING_COMMIT = /commit\s*;\s*(?:--[^\n]*\s*)*$/i;

/**
 * The migration's SQL plus the ledger insert, as one transaction. Files that already wrap
 * themselves in begin/commit get the ledger insert spliced in before their final commit.
 */
export function transactionalScript(file: MigrationFile): string {
  const ledger =
    `insert into private.schema_migrations (name, checksum) values ('${file.name}', '${file.checksum}');`;
  if (LEADING_BEGIN.test(file.sql) && TRAILING_COMMIT.test(file.sql)) {
    return file.sql.replace(TRAILING_COMMIT, `\n${ledger}\ncommit;\n`);
  }
  return `begin;\n${file.sql}\n;\n${ledger}\ncommit;\n`;
}

async function ensureLedger(client: SqlClient): Promise<void> {
  await client.query(`
    create schema if not exists private;
    revoke all on schema private from public;
    create table if not exists private.schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
    revoke all on private.schema_migrations from public;
  `);
}

export async function appliedMigrations(client: SqlClient): Promise<Map<string, string>> {
  const { rows } = await client.query("select name, checksum from private.schema_migrations order by name");
  return new Map(rows.map((r) => [String(r.name), String(r.checksum)]));
}

export interface MigrateOptions {
  migrationsDir: string;
  /** Seed SQL files applied after migrations, in order (they must be idempotent). */
  seedFiles?: string[];
  /** Report what would run without changing anything. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export async function migrate(client: SqlClient, opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const files = readMigrationFiles(opts.migrationsDir);
  const result: MigrateResult = { applied: [], skipped: [], seeded: [] };
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    if (!opts.dryRun) await ensureLedger(client);
    const done = opts.dryRun
      ? await appliedMigrations(client).catch(() => new Map<string, string>())
      : await appliedMigrations(client);
    for (const f of files) {
      const prior = done.get(f.name);
      if (prior !== undefined) {
        if (prior !== f.checksum) {
          throw new MigrationError(`${f.name} was already applied with a different checksum. Never edit an applied migration; add a new one.`);
        }
        result.skipped.push(f.name);
        continue;
      }
      log(`${opts.dryRun ? "would apply" : "applying"} ${f.name}`);
      if (!opts.dryRun) await client.query(transactionalScript(f));
      result.applied.push(f.name);
    }
    for (const seed of opts.seedFiles ?? []) {
      const name = path.basename(seed);
      log(`${opts.dryRun ? "would seed" : "seeding"} ${name}`);
      if (!opts.dryRun) await client.query(readFileSync(seed, "utf8"));
      result.seeded.push(name);
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

/** For logs: a connection string with any password removed. Never log the raw URL. */
export function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return `${u.protocol}//${u.username ? `${u.username}${u.password ? ":***" : ""}@` : ""}${u.host}${u.pathname}`;
  } catch {
    return "(unparseable database URL)";
  }
}

export interface MigrateCliArgs {
  seed: "none" | "reference" | "full";
  dryRun: boolean;
  help: boolean;
}

/** `--seed` / `--seed=full` (reference + SAMPLE projects), `--seed=reference`, `--dry-run`, `--help`. */
export function parseMigrateArgs(argv: readonly string[]): { ok: true; args: MigrateCliArgs } | { ok: false; error: string } {
  const args: MigrateCliArgs = { seed: "none", dryRun: false, help: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--seed" || a === "--seed=full") args.seed = "full";
    else if (a === "--seed=reference") args.seed = "reference";
    else return { ok: false, error: `Unknown argument: ${a.slice(0, 40)}` };
  }
  return { ok: true, args };
}
