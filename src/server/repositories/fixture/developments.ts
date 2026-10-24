import "server-only";
import { randomUUID } from "node:crypto";
import type { DeclaredCompletionRevision, Development } from "@/domain/types";
import { developmentNameKey } from "@/discovery/research/developments";
import { developmentPublishBlockers } from "../development-rules";
import {
  DEVELOPMENT_CONFLICT_MESSAGE,
  type AuditActor,
  type DevelopmentAuditEntry,
  type DevelopmentFields,
  type DevelopmentRepository,
  type DevelopmentReviewAction,
  type DevelopmentWriteResult,
  type StaffDevelopment,
  type StoreResearchedDevelopmentsInput,
} from "../types";

type Row = Omit<StaffDevelopment, "reviewStatus">;

/**
 * In-memory developments store (fixture mode: dev, unit tests, e2e). Mirrors
 * supabase/migrations/0008_developments.sql: version-checked writes with an audit entry each, an
 * append-only completion history, research never overwriting a reviewed row, and readiness
 * (developmentPublishBlockers, kept in sync with tn_development_publish_blockers).
 * Starts empty: buyers see the honest "Not yet researched" state until staff publish something.
 */
export class FixtureDevelopmentRepository implements DevelopmentRepository {
  private readonly rows = new Map<string, Row>();
  private readonly rejected = new Set<string>();
  /** Rows a staff member edited (staff_edited_at in SQL): research never overwrites them. */
  private readonly staffEdited = new Set<string>();
  private readonly audit: DevelopmentAuditEntry[] = [];
  /** Append-only, like infrastructure_completion_history. */
  private readonly history: (DeclaredCompletionRevision & { developmentId: string })[] = [];

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private now(): string {
    return this.clock().toISOString();
  }

  private view(r: Row): StaffDevelopment {
    const reviewStatus = r.published ? "published" : this.rejected.has(r.id) ? "rejected" : "pending";
    return structuredClone({
      ...r,
      reviewStatus,
      completionHistory: this.history.filter((h) => h.developmentId === r.id).map(({ developmentId: _d, ...h }) => (void _d, h)),
    });
  }
  private record(e: Omit<DevelopmentAuditEntry, "id" | "at">) {
    this.audit.push({ ...e, id: String(this.audit.length + 1), at: this.now() });
  }

  private appendHistory(r: Row) {
    if (!r.expectedCompletion) return;
    this.history.push({ developmentId: r.id, expectedCompletion: r.expectedCompletion, asOf: r.sourceObservedAt ?? this.now(), sourceUrl: r.sourceUrl });
  }

  async listPublished(): Promise<Development[]> {
    return [...this.rows.values()].filter((r) => r.published && r.sourceUrl !== null).map((r) => publicView(this.view(r)));
  }

  async listForStaff(filter: { localityId?: string; limit?: number }): Promise<StaffDevelopment[]> {
    return [...this.rows.values()]
      .filter((r) => !filter.localityId || r.localityIds.includes(filter.localityId) || r.researchLocalityId === filter.localityId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name))
      .slice(0, filter.limit ?? 200)
      .map((r) => this.view(r));
  }

  async getForStaff(id: string): Promise<StaffDevelopment | null> {
    const r = this.rows.get(id);
    return r ? this.view(r) : null;
  }

  async storeResearched(input: StoreResearchedDevelopmentsInput): Promise<string[]> {
    const ids: string[] = [];
    for (const it of input.items) {
      const existing = [...this.rows.values()].find(
        (r) => r.addedBy === "research" && developmentNameKey(r.name) === developmentNameKey(it.name) && r.sourceUrl === it.sourceUrl,
      );
      if (!existing) {
        const now = this.now();
        const row: Row = {
          id: randomUUID(),
          name: it.name,
          category: it.category,
          stage: it.stage,
          authority: it.authority,
          expectedCompletion: it.expectedCompletion,
          announcedDate: null,
          completionHistory: [],
          localityIds: [it.localityId],
          location: null,
          sourceId: input.sourceId,
          sourceUrl: it.sourceUrl,
          sourceObservedAt: input.observedAt,
          lastCheckedAt: input.observedAt,
          verification: "unverified",
          addedBy: "research",
          isSample: input.isSample,
          published: false,
          rejectionNote: null,
          pendingChange: null,
          researchJobId: input.jobId,
          researchLocalityId: input.researchLocalityId,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.rows.set(row.id, row);
        this.appendHistory(row);
        this.record({ developmentId: row.id, action: "researched", fromVerification: null, toVerification: null, actorId: "system:research", actorRole: "system", note: "found by web research" });
        ids.push(row.id);
        continue;
      }
      const r = existing;
      // Same rules as development_store_research: a pending draft takes the new values; a reviewed
      // row (published, rejected or edited by staff) keeps its values, gets pending_change on a
      // contradiction, and its last-checked date is refreshed only when research matches it.
      const pending = !r.published && !this.rejected.has(r.id) && !this.staffEdited.has(r.id);
      r.researchJobId = input.jobId;
      let note: string;
      if (pending) {
        const prevDate = r.expectedCompletion;
        r.lastCheckedAt = input.observedAt;
        r.category = it.category;
        r.stage = it.stage;
        r.authority = it.authority;
        r.expectedCompletion = it.expectedCompletion ?? r.expectedCompletion;
        r.sourceObservedAt = input.observedAt;
        r.verification = "unverified";
        r.pendingChange = null;
        if (r.expectedCompletion && r.expectedCompletion !== prevDate) this.appendHistory(r);
        note = "seen again by web research (pending draft updated)";
      } else if (
        it.stage !== r.stage ||
        (it.authority !== null && it.authority !== r.authority) ||
        (it.expectedCompletion !== null && it.expectedCompletion !== r.expectedCompletion)
      ) {
        r.pendingChange = { stage: it.stage, authority: it.authority, expectedCompletion: it.expectedCompletion, observedAt: input.observedAt };
        note = `research differs from the reviewed values (not applied): ${JSON.stringify(r.pendingChange)}`.slice(0, 1000);
      } else if (r.pendingChange === null) {
        r.lastCheckedAt = input.observedAt;
        note = "seen again by web research (matches the reviewed values)";
      } else {
        note = "seen again by web research (an earlier pending change is still open)";
      }
      r.version += 1;
      r.updatedAt = this.now();
      this.record({ developmentId: r.id, action: "researched", fromVerification: null, toVerification: null, actorId: "system:research", actorRole: "system", note });
      ids.push(r.id);
    }
    return ids;
  }

  async create(fields: DevelopmentFields, isSample: boolean, actor: AuditActor): Promise<StaffDevelopment> {
    const now = this.now();
    const row: Row = {
      ...structuredClone(fields),
      id: randomUUID(),
      completionHistory: [],
      lastCheckedAt: now,
      verification: "unverified",
      addedBy: "staff",
      isSample,
      published: false,
      rejectionNote: null,
      pendingChange: null,
      researchJobId: null,
      researchLocalityId: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    this.appendHistory(row);
    this.record({ developmentId: row.id, action: "created", fromVerification: null, toVerification: "unverified", ...actor, note: null });
    return this.view(row);
  }

  private duplicateName(id: string, r: Row, name: string, sourceUrl: string | null): boolean {
    if (r.addedBy !== "research") return false;
    return [...this.rows.values()].some(
      (o) => o.id !== id && o.addedBy === "research" && developmentNameKey(o.name) === developmentNameKey(name) && o.sourceUrl === sourceUrl,
    );
  }

  async update(id: string, expectedVersion: number, fields: DevelopmentFields, actor: AuditActor): Promise<DevelopmentWriteResult> {
    const r = this.rows.get(id);
    if (!r) return { ok: false, error: "not_found", message: "Development not found." };
    if (r.version !== expectedVersion) return { ok: false, error: "conflict", message: DEVELOPMENT_CONFLICT_MESSAGE };
    if (this.duplicateName(id, r, fields.name, fields.sourceUrl))
      return { ok: false, error: "duplicate", message: "Another researched development has this name and source link." };
    const before = JSON.stringify(editable(r));
    const next = { ...r, ...structuredClone(fields), sourceId: r.sourceId, pendingChange: null };
    const after = JSON.stringify(editable(next));
    if (before === after && r.pendingChange === null) return { ok: true, development: this.view(r), changed: false, autoUnpublished: false };
    const fromVerification = r.verification;
    const prevDate = r.expectedCompletion;
    const cleared = r.pendingChange;
    Object.assign(r, next, { lastCheckedAt: this.now(), verification: "unverified", version: r.version + 1, updatedAt: this.now() });
    this.staffEdited.add(id);
    if (r.expectedCompletion && r.expectedCompletion !== prevDate) this.appendHistory(r);
    this.record({
      developmentId: id,
      action: "edited",
      fromVerification,
      toVerification: r.verification,
      ...actor,
      note: cleared ? `cleared pending research change: ${JSON.stringify(cleared)}`.slice(0, 1000) : null,
    });
    let autoUnpublished = false;
    if (r.published && developmentPublishBlockers(r).length) {
      r.published = false;
      this.record({ developmentId: id, action: "unpublished", fromVerification: null, toVerification: null, ...actor, note: "auto: failed readiness after edit" });
      autoUnpublished = true;
    }
    return { ok: true, development: this.view(r), changed: true, autoUnpublished };
  }

  async review(
    id: string,
    expectedVersion: number,
    action: DevelopmentReviewAction,
    verification: "unverified" | "source_confirmed" | null,
    note: string | null,
    actor: AuditActor,
  ): Promise<DevelopmentWriteResult> {
    const r = this.rows.get(id);
    if (!r) return { ok: false, error: "not_found", message: "Development not found." };
    if (r.version !== expectedVersion) return { ok: false, error: "conflict", message: DEVELOPMENT_CONFLICT_MESSAGE };
    const isRejected = this.rejected.has(id);
    const unchanged =
      (action === "publish" && r.published && (verification ?? r.verification) === r.verification) ||
      (action === "unpublish" && !r.published) ||
      (action === "reject" && isRejected) ||
      (action === "restore" && !isRejected);
    if (unchanged) return { ok: true, development: this.view(r), changed: false, autoUnpublished: false };
    const from = r.verification;
    const clearedChange = action === "publish" ? r.pendingChange : null;
    if (action === "publish") {
      const blockers = developmentPublishBlockers(r);
      if (blockers.length) return { ok: false, error: "not_ready", message: "Not ready to publish.", blockers };
      r.published = true;
      this.rejected.delete(id);
      r.rejectionNote = null;
      r.verification = verification ?? r.verification;
      r.pendingChange = null;
    } else if (action === "unpublish") {
      r.published = false;
    } else if (action === "reject") {
      r.published = false;
      this.rejected.add(id);
      r.rejectionNote = note?.trim().slice(0, 1000) || null;
    } else {
      this.rejected.delete(id);
      r.rejectionNote = null;
    }
    r.version += 1;
    r.updatedAt = this.now();
    const label = ({ publish: "published", unpublish: "unpublished", reject: "rejected", restore: "restored" } as const)[action];
    const parts = [note?.trim() || null, clearedChange ? `cleared pending research change: ${JSON.stringify(clearedChange)}` : null].filter(Boolean);
    this.record({ developmentId: id, action: label, fromVerification: from, toVerification: r.verification, ...actor, note: parts.join(" · ").slice(0, 1000) || null });
    return { ok: true, development: this.view(r), changed: true, autoUnpublished: false };
  }

  async listAudit(id: string): Promise<DevelopmentAuditEntry[]> {
    return this.audit.filter((e) => e.developmentId === id).map((e) => ({ ...e }));
  }
}

function editable(r: Row) {
  const { name, category, stage, authority, expectedCompletion, announcedDate, localityIds, location, sourceUrl, sourceObservedAt } = r;
  return { name, category, stage, authority, expectedCompletion, announcedDate, localityIds, location, sourceUrl, sourceObservedAt };
}

/** The buyer-visible part of a row (no review state). */
export function publicView(d: StaffDevelopment): Development {
  return {
    id: d.id,
    name: d.name,
    category: d.category,
    stage: d.stage,
    authority: d.authority,
    expectedCompletion: d.expectedCompletion,
    announcedDate: d.announcedDate,
    completionHistory: d.completionHistory,
    localityIds: d.localityIds,
    location: d.location,
    sourceId: d.sourceId,
    sourceUrl: d.sourceUrl,
    sourceObservedAt: d.sourceObservedAt,
    lastCheckedAt: d.lastCheckedAt,
    verification: d.verification,
    addedBy: d.addedBy,
    isSample: d.isSample,
  };
}
