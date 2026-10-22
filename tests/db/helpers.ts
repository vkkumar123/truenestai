import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

export const DATABASE_URL_TEST =
  process.env.DATABASE_URL_TEST ?? "postgres://tn_test:tn_test@localhost:5432/truenest_test";

const ROOT = path.resolve(__dirname, "../..");
const SHIM = path.join(__dirname, "supabase-shim.sql");
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

/** Returns a connected client, or null (with the reason) when the DB is unreachable. */
export async function tryConnect(): Promise<{ client: Client | null; reason?: string }> {
  const client = new Client({ connectionString: DATABASE_URL_TEST, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return { client };
  } catch (err) {
    await client.end().catch(() => {});
    return { client: null, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

/** Drops and recreates public + auth schemas, then applies the shim and every migration in order. */
export async function resetAndMigrate(client: Client): Promise<void> {
  await client.query("drop schema if exists public cascade; drop schema if exists auth cascade;");
  await client.query("create schema public; grant usage on schema public to public;");
  await client.query(readFileSync(SHIM, "utf8"));
  for (const file of migrationFiles()) {
    await client.query(readFileSync(file, "utf8"));
  }
}

export type DbRole = "anon" | "authenticated" | "service_role";

/**
 * Runs `fn` inside a transaction as `role` with `request.jwt.claim.sub = sub`, then rolls back,
 * so every assertion starts from the same seeded state.
 */
export async function asRole<T>(
  client: Client,
  role: DbRole,
  sub: string | null,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [sub ?? ""]);
    return await fn(client);
  } finally {
    await client.query("rollback");
  }
}

/** Like asRole, but resolves to the Postgres error (or null if the statement succeeded). */
export async function errorAs(
  client: Client,
  role: DbRole,
  sub: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<{ code?: string; message: string } | null> {
  return asRole(client, role, sub, async (c) => {
    try {
      await c.query(sql, params);
      return null;
    } catch (err) {
      const e = err as { code?: string; message: string };
      return { code: e.code, message: e.message };
    }
  });
}
