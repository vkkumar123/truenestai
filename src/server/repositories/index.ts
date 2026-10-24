import "server-only";
import { dataBackend } from "../env";
import { createFixtureRepositories } from "./fixture";
import { createSupabaseRepositories } from "./supabase";
import type { Repositories } from "./types";

export type * from "./types";
export type { CurrentFact, FactEntityType } from "./fact-store";
export { AUTO_UNPUBLISH_NOTE, CONFLICT_MESSAGE, DEVELOPMENT_CONFLICT_MESSAGE, RESEARCH_FAILURE_COOLDOWN_HOURS, RESEARCH_STALL_MINUTES } from "./types";

// Kept on globalThis so the dev fixture lead store survives hot reloads in one process.
const KEY = Symbol.for("truenest.repositories");
type G = typeof globalThis & { [KEY]?: Repositories };

/**
 * Selects the data backend from DATA_BACKEND (fixture | supabase; default fixture).
 * Throws a ConfigError if supabase is selected without SUPABASE_URL / keys.
 */
export function getRepositories(): Repositories {
  const g = globalThis as G;
  const backend = dataBackend();
  if (g[KEY] && g[KEY]!.backend === backend) return g[KEY]!;
  const repos = backend === "supabase" ? createSupabaseRepositories() : createFixtureRepositories();
  g[KEY] = repos;
  return repos;
}

/** Test hook: inject repositories (or reset with undefined). */
export function setRepositoriesForTesting(repos: Repositories | undefined): void {
  (globalThis as G)[KEY] = repos;
}
