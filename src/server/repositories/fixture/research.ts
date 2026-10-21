import "server-only";
import { randomUUID } from "node:crypto";
import type { FactAuditEvent, FactValue, GeoPoint, Project, ResearchFactField, VerificationState } from "@/domain/types";
import { getLocality, isActiveLocality } from "@/config/markets";
import { computeCompleteness } from "@/research/publish";
import type { NewProjectInput, ResearchRepository } from "../types";
import { slugify, uniqueSlug } from "../slug";

const unknownFact = <T>(): FactValue<T> => ({ status: "unknown", value: null, verification: "unverified", sources: [] });

/**
 * DEV ONLY. Mutates the shared in-memory project list that FixtureProjectRepository reads, so
 * publishing here is visible to public pages in the same server process. Lost on restart.
 */
export class FixtureResearchRepository implements ResearchRepository {
  private readonly audit: FactAuditEvent[] = [];

  constructor(private readonly store: Project[]) {}

  private index(id: string): number {
    return this.store.findIndex((p) => p.id === id);
  }

  private write(i: number, next: Project): Project {
    const withCompleteness: Project = { ...next, completeness: computeCompleteness(next), lastCheckedAt: new Date().toISOString() };
    this.store[i] = withCompleteness;
    return structuredClone(withCompleteness);
  }

  async listAllProjects(): Promise<Project[]> {
    return [...this.store].sort((a, b) => a.name.localeCompare(b.name)).map((p) => structuredClone(p));
  }

  async getProjectByIdForStaff(id: string): Promise<Project | null> {
    const i = this.index(id);
    return i >= 0 ? structuredClone(this.store[i]) : null;
  }

  async createProject(input: NewProjectInput): Promise<Project> {
    if (!isActiveLocality(input.localityId)) throw new Error("Locality is not active.");
    const loc = getLocality(input.localityId)!;
    const location: GeoPoint =
      input.lat !== undefined && input.lng !== undefined
        ? { lat: input.lat, lng: input.lng, precision: "approximate" }
        : { lat: loc.centroid.lat, lng: loc.centroid.lng, precision: "locality_centroid" };
    const slug = uniqueSlug(slugify(`${input.name} ${loc.name}`), new Set(this.store.map((p) => p.slug)));
    const devName = input.developerName.trim();
    const existingDev = this.store.find((p) => p.developer.name.toLowerCase() === devName.toLowerCase())?.developer;
    const project: Project = {
      id: randomUUID(),
      slug,
      lane: "researched",
      name: input.name.trim(),
      developer: existingDev && !existingDev.isSample ? existingDev : { id: randomUUID(), name: devName, isSample: false },
      localityId: input.localityId,
      location,
      address: unknownFact(),
      reraNumbers: unknownFact(),
      constructionStatus: unknownFact(),
      declaredPossession: unknownFact(),
      units: [],
      regulatoryRecords: [],
      regulatorySearches: [],
      documents: [],
      reviewFlags: [],
      completeness: 0,
      lastCheckedAt: new Date().toISOString(),
      isSample: false,
      published: false,
    };
    this.store.push(project);
    return this.write(this.store.length - 1, project);
  }

  async setFact(projectId: string, field: ResearchFactField, fact: FactValue<unknown>): Promise<Project | null> {
    const i = this.index(projectId);
    if (i < 0) return null;
    return this.write(i, { ...this.store[i], [field]: structuredClone(fact) } as Project);
  }

  async setFactVerification(projectId: string, field: ResearchFactField, to: VerificationState): Promise<Project | null> {
    const i = this.index(projectId);
    if (i < 0) return null;
    const current = this.store[i][field] as FactValue<unknown>;
    return this.write(i, { ...this.store[i], [field]: { ...current, verification: to } } as Project);
  }

  async setPublished(projectId: string, published: boolean): Promise<Project | null> {
    const i = this.index(projectId);
    if (i < 0) return null;
    return this.write(i, { ...this.store[i], published });
  }

  async appendAudit(event: FactAuditEvent): Promise<void> {
    this.audit.push(Object.freeze(structuredClone(event)));
  }

  async listAudit(projectId: string): Promise<FactAuditEvent[]> {
    return this.audit.filter((e) => e.projectId === projectId).map((e) => structuredClone(e));
  }
}
