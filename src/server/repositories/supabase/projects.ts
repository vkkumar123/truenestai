import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Project } from "@/domain/types";
import { findLocalitiesByText } from "@/config/markets";
import { clampLimit, DEFAULT_PROJECT_LIMIT, MAX_PROJECT_LIMIT, type ProjectFilter, type ProjectRepository } from "../types";
import { mapProjectRow, PROJECT_SELECT, type ProjectRow } from "./mappers";

/** Escapes a term for a PostgREST `ilike` inside an `or=(...)` filter. */
function ilikeTerm(text: string): string {
  return `*${text.replace(/[%*,()\\."]/g, " ").trim()}*`;
}

/**
 * Public reads with the ANON client: RLS returns only published projects and their children.
 * `.eq("published", true)` is repeated as defence in depth.
 */
export class SupabaseProjectRepository implements ProjectRepository {
  constructor(private readonly db: SupabaseClient) {}

  async listProjects(filter: ProjectFilter = {}): Promise<Project[]> {
    const limit = clampLimit(filter.limit, DEFAULT_PROJECT_LIMIT, MAX_PROJECT_LIMIT);
    if (limit === 0) return [];
    let q = this.db.from("projects").select(PROJECT_SELECT).eq("published", true).order("name").limit(limit);
    if (filter.localityId) q = q.eq("locality_id", filter.localityId);
    const text = filter.text?.trim();
    if (text) {
      const term = ilikeTerm(text);
      const ors = [`name.ilike.${term}`, `slug.ilike.${term}`];
      const locIds = findLocalitiesByText(text).map((l) => l.id);
      if (locIds.length) ors.push(`locality_id.in.(${locIds.join(",")})`);
      q = q.or(ors.join(","));
    }
    const { data, error } = await q;
    if (error) throw new Error(`listProjects failed: ${error.message}`);
    let projects = (data as unknown as ProjectRow[]).map(mapProjectRow).filter((p) => p.published);
    if (filter.status) {
      projects = projects.filter((p) => p.constructionStatus.status === "known" && p.constructionStatus.value === filter.status);
    }
    return projects;
  }

  async getProjectBySlug(slug: string): Promise<Project | null> {
    const { data, error } = await this.db.from("projects").select(PROJECT_SELECT).eq("slug", slug).eq("published", true).maybeSingle();
    if (error) throw new Error(`getProjectBySlug failed: ${error.message}`);
    return data ? mapProjectRow(data as unknown as ProjectRow) : null;
  }

  async getProjectsByIds(ids: string[]): Promise<Project[]> {
    if (!ids.length) return [];
    const { data, error } = await this.db.from("projects").select(PROJECT_SELECT).in("id", ids).eq("published", true);
    if (error) throw new Error(`getProjectsByIds failed: ${error.message}`);
    const byId = new Map((data as unknown as ProjectRow[]).map((r) => [r.id, mapProjectRow(r)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }
}
