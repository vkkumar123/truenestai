import "server-only";
import type { Project } from "@/domain/types";
import { findLocalitiesByText } from "@/config/markets";
import { bhkMatches } from "@/domain/search-options";
import {
  clampLimit,
  DEFAULT_PROJECT_LIMIT,
  MAX_PROJECT_LIMIT,
  type ProjectFilter,
  type ProjectRepository,
} from "../types";
import { SAMPLE_PROJECTS } from "./sample-projects";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function matchesText(p: Project, text: string, localityIds: Set<string>): boolean {
  const q = norm(text);
  if (!q) return true;
  return (
    norm(p.name).includes(q) ||
    norm(p.developer.name).includes(q) ||
    p.slug.includes(q.replace(/\s+/g, "-")) ||
    localityIds.has(p.localityId)
  );
}

/** In-memory, read-only. Returns structured clones so callers cannot mutate the fixture. */
export class FixtureProjectRepository implements ProjectRepository {
  constructor(private readonly projects: readonly Project[] = SAMPLE_PROJECTS) {}

  private get published(): Project[] {
    return this.projects.filter((p) => p.published === true);
  }

  async listProjects(filter: ProjectFilter = {}): Promise<Project[]> {
    const limit = clampLimit(filter.limit, DEFAULT_PROJECT_LIMIT, MAX_PROJECT_LIMIT);
    const text = filter.text?.trim() ?? "";
    const textLocalities = new Set(text ? findLocalitiesByText(text).map((l) => l.id) : []);
    return this.published
      .filter((p) => !filter.localityId || p.localityId === filter.localityId)
      .filter((p) => !text || matchesText(p, text, textLocalities))
      .filter(
        (p) =>
          !filter.status ||
          (p.constructionStatus.status === "known" && p.constructionStatus.value === filter.status),
      )
      .filter((p) => !filter.bhk || p.units.some((u) => bhkMatches(u.label, filter.bhk!)))
      .slice(0, limit)
      .map((p) => structuredClone(p));
  }

  async hasSampleData(): Promise<boolean> {
    return this.published.some((p) => p.isSample);
  }

  async getProjectBySlug(slug: string): Promise<Project | null> {
    const p = this.published.find((x) => x.slug === slug);
    return p ? structuredClone(p) : null;
  }

  async getProjectsByIds(ids: string[]): Promise<Project[]> {
    const byId = new Map(this.published.map((p) => [p.id, p]));
    return ids.flatMap((id) => {
      const p = byId.get(id);
      return p ? [structuredClone(p)] : [];
    });
  }
}
