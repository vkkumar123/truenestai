import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseEnv } from "../../env";

const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

/** Anon-key client: RLS applies (published data only, insert-only leads). */
export function createAnonClient(): SupabaseClient {
  const env = supabaseEnv();
  return createClient(env.url, env.anonKey, noSession);
}

/**
 * Service-role client: BYPASSES RLS. Server-only (workers, staff-gated services).
 * Never pass it, its key, or its raw results to client components or logs.
 */
export function createServiceRoleClient(): SupabaseClient {
  const env = supabaseEnv(process.env, { requireServiceRole: true });
  return createClient(env.url, env.serviceRoleKey!, noSession);
}
