import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseEnv } from "../../env";
import type { Repositories } from "../types";
import { createAnonClient, createServiceRoleClient } from "./client";
import { SupabaseExternalListingRepository } from "./external-listings";
import { SupabaseLeadRepository } from "./leads";
import { SupabaseProjectRepository } from "./projects";
import { SupabaseResearchRepository } from "./research";
import { SupabaseDocumentStorage } from "../../storage/documents";

export { SupabaseProjectRepository, SupabaseExternalListingRepository, SupabaseLeadRepository, SupabaseResearchRepository };

/** Validates env eagerly (clear error), creates the service-role client lazily on first use. */
export function createSupabaseRepositories(): Repositories {
  supabaseEnv(process.env, { requireServiceRole: true });
  const anon = createAnonClient();
  let service: SupabaseClient | null = null;
  const serviceClient = () => (service ??= createServiceRoleClient());
  return {
    backend: "supabase",
    projects: new SupabaseProjectRepository(anon),
    research: new SupabaseResearchRepository(serviceClient),
    externalListings: new SupabaseExternalListingRepository(anon, serviceClient),
    leads: new SupabaseLeadRepository(serviceClient),
    documentStorage: new SupabaseDocumentStorage(serviceClient),
  };
}
