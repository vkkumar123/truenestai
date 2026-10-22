import "server-only";
import { randomUUID } from "node:crypto";
import type { Developer, FactAuditEvent, FactValue, GeoPoint, Project, ResearchFactField, VerificationState } from "@/domain/types";
import { getLocality, isActiveLocality } from "@/config/markets";
import { computeCompleteness, evaluatePublishReadiness } from "@/research/publish";
import { factVersion } from "@/research/verification";
import {
  AUTO_UNPUBLISH_NOTE,
  CONFLICT_MESSAGE,
  type AuditActor,
  type NewProjectInput,
  type PublishWriteResult,
  type ResearchRepository,
  type ResearchWriteResult,
  type StaffAuditEntry,
} from "../types";
import { slugify, uniqueSlug } from "../slug";

const unknownFact = <T>(): FactValue<T> => ({ status: "unknown", value: null, verification: "unverified", sources: [] });
const NOT_FOUND = { ok: false, error: "not_found", message: "Project not found." } as const;

type EventDraft = Omit<FactAuditEvent, "id" | "at" | "actorId" | "actorRole">;

/**
 * DEV ONLY. Mutates the shared in-memory project list that FixtureProjectRepository reads, so
 * publishing here is visible to public pages in the same server process. Lost on restart.
 * Each write computes the next project state and its audit events first, then commits both in
 * one synchronous step (no partial state if anything throws before the commit).
 */
export class FixtureResearchRepository implements ResearchRepository {
  private readonly audit: FactAuditEvent[] = [];

  constructor(private readonly store: Project[]) {}

  private index(id: string): number {
    return this.store.findIndex((p) => p.id === id);
  }

  /** Atomic commit of a project state + its audit events. */
  private commit(i: number, next: Project, events: EventDraft[], actor: AuditActor): Project {
    const at = new Date().toISOString();
    const built: FactAuditEvent[] = events.map((e) => Object.freeze({ ...e, id: randomUUID(), at, actorId: actor.actorId, actorRole: actor.actorRole }));
    const frozen = structuredClone(next);
    // --- commit (synchronous, cannot partially apply) ---
    if (i === this.store.length) this.store.push(frozen);
    else this.store[i] = frozen;
    this.audit.push(...built);
    return structuredClone(frozen);
  }

  /** D13: a published project that fails readiness after a change is unpublished, with audit. */
  private withAutoUnpublish(next: Project, events: EventDraft[]): { next: Project; autoUnpublished: boolean } {
    if (!next.published || evaluatePublishReadiness(next).ready) return { next, autoUnpublished: false };
    events.push({ projectId: next.id, field: "published", action: "unpublished", fromVerification: null, toVerification: null, note: AUTO_UNPUBLISH_NOTE });
    return { next: { ...next, published: false }, autoUnpublished: true };
  }

  async listAllProjects(): Promise<Project[]> {
    return [...this.store].sort((a, b) => a.name.localeCompare(b.name)).map((p) => structuredClone(p));
  }

  async getProjectByIdForStaff(id: string): Promise<Project | null> {
    const i = this.index(id);
    return i >= 0 ? structuredClone(this.store[i]) : null;
  }

  async listDevelopers(): Promise<Developer[]> {
    const byId = new Map<string, Developer>();
    for (const p of this.store) byId.set(p.developer.id, p.developer);
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => ({ ...d }));
  }

  async createProject(input: NewProjectInput, actor: AuditActor): Promise<Project> {
    if (!isActiveLocality(input.localityId)) throw new Error("Locality is not active.");
    const loc = getLocality(input.localityId)!;
    let developer: Developer;
    if (input.developerId) {
      const found = (await this.listDevelopers()).find((d) => d.id === input.developerId);
      if (!found) throw new Error("Developer not found.");
      developer = found;
    } else {
      const name = input.developerName?.trim();
      if (!name) throw new Error("Developer name required.");
      developer = { id: randomUUID(), name, isSample: false }; // always a NEW developer (never merged by name)
    }
    const location: GeoPoint =
      input.lat !== undefined && input.lng !== undefined
        ? { lat: input.lat, lng: input.lng, precision: "approximate" }
        : { lat: loc.centroid.lat, lng: loc.centroid.lng, precision: "locality_centroid" };
    const project: Project = {
      id: randomUUID(),
      slug: uniqueSlug(slugify(`${input.name} ${loc.name}`), new Set(this.store.map((p) => p.slug))),
      lane: "researched",
      name: input.name.trim(),
      developer,
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
    project.completeness = computeCompleteness(project);
    return this.commit(this.store.length, project, [
      { projectId: project.id, field: "basics", action: "created", fromVerification: null, toVerification: null, note: null },
    ], actor);
  }

  async setFact(projectId: string, field: ResearchFactField, fact: FactValue<unknown>, actor: AuditActor): Promise<ResearchWriteResult> {
    const i = this.index(projectId);
    if (i < 0) return NOT_FOUND;
    const current = this.store[i];
    const before = current[field] as FactValue<unknown>;
    const edited = { ...current, [field]: structuredClone(fact), lastCheckedAt: new Date().toISOString() } as Project; // L4: fact edits only
    edited.completeness = computeCompleteness(edited);
    const events: EventDraft[] = [
      { projectId, field, action: "fact_set", fromVerification: before.verification, toVerification: fact.verification, note: null },
    ];
    const { next, autoUnpublished } = this.withAutoUnpublish(edited, events);
    return { ok: true, project: this.commit(i, next, events, actor), autoUnpublished };
  }

  async setFactVerification(
    projectId: string,
    field: ResearchFactField,
    to: VerificationState,
    expectedVersion: string,
    actor: AuditActor,
    note: string | null,
  ): Promise<ResearchWriteResult> {
    const i = this.index(projectId);
    if (i < 0) return NOT_FOUND;
    const current = this.store[i];
    const fact = current[field] as FactValue<unknown>;
    if (factVersion(fact) !== expectedVersion) return { ok: false, error: "conflict", message: CONFLICT_MESSAGE };
    const changed = { ...current, [field]: { ...fact, verification: to } } as Project;
    const events: EventDraft[] = [
      { projectId, field, action: "verification_changed", fromVerification: fact.verification, toVerification: to, note },
    ];
    const { next, autoUnpublished } = this.withAutoUnpublish(changed, events);
    return { ok: true, project: this.commit(i, next, events, actor), autoUnpublished };
  }

  async setPublished(projectId: string, published: boolean, actor: AuditActor): Promise<PublishWriteResult> {
    const i = this.index(projectId);
    if (i < 0) return NOT_FOUND;
    const current = this.store[i];
    if (current.published === published) return { ok: true, project: structuredClone(current), changed: false };
    if (published) {
      const readiness = evaluatePublishReadiness(current);
      if (!readiness.ready) return { ok: false, error: "not_ready", message: "This project is not ready to publish.", blockers: readiness.blockers };
    }
    const project = this.commit(i, { ...current, published }, [
      { projectId, field: "published", action: published ? "published" : "unpublished", fromVerification: null, toVerification: null, note: null },
    ], actor);
    return { ok: true, project, changed: true };
  }

  async listAudit(projectId: string): Promise<StaffAuditEntry[]> {
    // Fixture mode has no staff_profiles: the display name is the actor id.
    return this.audit.filter((e) => e.projectId === projectId).map((e) => ({ ...structuredClone(e), actorName: e.actorId }));
  }
}
