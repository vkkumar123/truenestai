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
  /**
   * True when `seedFiles` include fictional SAMPLE projects (seed.sql). Refused when the database is
   * marked `private.settings.environment = 'production'` (checked before anything is applied).
   */
  sampleSeed?: boolean;
  /** Writes the deployment marker after migrating. "production" is refused if SAMPLE projects exist. */
  markEnvironment?: DeploymentEnvironment;
  log?: (line: string) => void;
}

export type DeploymentEnvironment = "production" | "staging" | "development";

/** The deployment marker (private.settings, 0004), or null when absent / not migrated yet. */
export async function databaseEnvironment(client: SqlClient): Promise<string | null> {
  const { rows } = await client.query("select to_regclass('private.settings') is not null as ok");
  if (!rows[0]?.ok) return null;
  const r = await client.query("select value from private.settings where key = 'environment'");
  return r.rows[0] ? String(r.rows[0].value) : null;
}

export async function migrate(client: SqlClient, opts: MigrateOptions): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const files = readMigrationFiles(opts.migrationsDir);
  const result: MigrateResult = { applied: [], skipped: [], seeded: [] };
  await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    if (opts.sampleSeed && opts.markEnvironment === "production") {
      throw new MigrationError("Refusing to seed SAMPLE projects into a database being marked production.");
    }
    if (opts.sampleSeed && (await databaseEnvironment(client)) === "production") {
      throw new MigrationError("This database is marked production: the SAMPLE seed is refused. Use --seed=reference.");
    }
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
    if (opts.markEnvironment) {
      if (opts.markEnvironment === "production") {
        const { rows } = await client.query(
          "select to_regclass('public.projects') is not null and exists (select 1 from public.projects where is_sample) as has_sample",
        ).catch(() => ({ rows: [{ has_sample: false }] }));
        if (rows[0]?.has_sample) {
          throw new MigrationError("Refusing to mark production: the database contains SAMPLE projects (is_sample = true). Remove them first.");
        }
        // 0006: observations carry their own is_sample (they survive deleting the project).
        // Checked in two steps so a database without the table (dry run before 0006) never errors.
        const hasTable = (await client.query("select to_regclass('public.fact_observations') is not null as ok")).rows[0]?.ok;
        const obs = hasTable
          ? await client.query("select exists (select 1 from public.fact_observations where is_sample) as has_sample")
          : { rows: [{ has_sample: false }] };
        if (obs.rows[0]?.has_sample) {
          throw new MigrationError("Refusing to mark production: the database contains SAMPLE fact observations (is_sample = true). Remove them first.");
        }
      }
      log(`${opts.dryRun ? "would mark" : "marking"} environment = ${opts.markEnvironment}`);
      if (!opts.dryRun) {
        await client.query(
          `insert into private.settings (key, value) values ('environment', $1)
           on conflict (key) do update set value = excluded.value, updated_at = now()`,
          [opts.markEnvironment],
        );
      }
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
  allowSample: boolean;
  markProduction: boolean;
  dryRun: boolean;
  help: boolean;
}

/**
 * `--seed` / `--seed=reference` (geography + source registry; safe everywhere),
 * `--seed=full --allow-sample` (also fictional SAMPLE projects; staging/dev only),
 * `--mark-production`, `--dry-run`, `--help`.
 */
export function parseMigrateArgs(argv: readonly string[]): { ok: true; args: MigrateCliArgs } | { ok: false; error: string } {
  const args: MigrateCliArgs = { seed: "none", allowSample: false, markProduction: false, dryRun: false, help: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--seed" || a === "--seed=reference") args.seed = "reference";
    else if (a === "--seed=full") args.seed = "full";
    else if (a === "--allow-sample") args.allowSample = true;
    else if (a === "--mark-production") args.markProduction = true;
    else return { ok: false, error: `Unknown argument: ${a.slice(0, 40)}` };
  }
  if (args.seed === "full" && !args.allowSample) {
    return { ok: false, error: "--seed=full loads fictional SAMPLE projects (some published); add --allow-sample to confirm (never on production)." };
  }
  if (args.allowSample && args.seed !== "full") return { ok: false, error: "--allow-sample is only valid with --seed=full." };
  if (args.markProduction && args.seed === "full") return { ok: false, error: "--mark-production cannot be combined with --seed=full." };
  return { ok: true, args };
}
