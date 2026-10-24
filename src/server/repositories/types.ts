import "server-only";
import type {
  ConstructionStatus,
  Development,
  GeoPoint,
  InfrastructureCategory,
  InfrastructureStage,
  ExternalListing,
  FactAuditEvent,
  FactValue,
  Lead,
  LeadRequestType,
  LeadStatus,
  Project,
  ProjectDocument,
  ResearchFactField,
  StaffRole,
  Developer,
  VerificationState,
} from "@/domain/types";
import type { BhkOption } from "@/domain/search-options";
import type { LeadQualification } from "@/leads/qualification";
import type { DocumentContentType, DocumentStorage } from "../storage/documents";
import type { CurrentFact, FactEntityType } from "./fact-store";

export interface ProjectFilter {
  localityId?: string;
  text?: string; // case-insensitive match on project name, developer name or slug
  status?: ConstructionStatus; // matches constructionStatus only where it is known
  bhk?: BhkOption; // at least one unit label like "2 BHK" ("5+" = 5 or more)
  limit?: number;
}

/**
 * Public read model for Lane A. Implementations return ONLY published projects; callers
 * (services) re-check `published` as defence in depth.
 */
export interface ProjectRepository {
  listProjects(filter?: ProjectFilter): Promise<Project[]>;
  getProjectBySlug(slug: string): Promise<Project | null>;
  /** Unknown or unpublished ids are omitted; result keeps the order of `ids`. */
  getProjectsByIds(ids: string[]): Promise<Project[]>;
  /** True if any published project is SAMPLE data. Side-effect free. */
  hasSampleData(): Promise<boolean>;
  /** Published projects with any of these RERA numbers (compared after normaliseRera). */
  findPublishedProjectsByRera(numbers: string[]): Promise<Project[]>;
}

export interface StoredListingFilter {
  /** Only listings from these sources. */
  sourceIds: string[];
  /** Case-insensitive substring of title or developer name. */
  text?: string;
  localityId?: string;
  limit?: number;
}

export interface ExternalListingRepository {
  getById(id: string): Promise<ExternalListing | null>;
  /** Stored listings (most recently seen first). Used to serve earlier research results. */
  search(filter: StoredListingFilter): Promise<ExternalListing[]>;
  /** Insert or update by (sourceId, sourceRecordId), falling back to id. Returns stored rows. */
  upsertMany(listings: ExternalListing[]): Promise<ExternalListing[]>;
}

/** A lead as stored: the domain Lead plus the server-computed qualification. */
export interface StoredLead extends Lead {
  qualification: LeadQualification | null;
  consentedAt: string;
  /** Staff user id the lead is assigned to (advisors see only their own). Absent/null = unassigned. */
  assignedTo?: string | null;
}

export interface LeadFilter {
  status?: LeadStatus;
  requestType?: LeadRequestType;
  /** Only leads assigned to this staff user (set by the service for advisors). */
  assignedTo?: string;
  limit?: number;
}

/** A staff member leads can be assigned to. No contact details. */
export interface StaffMember {
  userId: string;
  role: "admin" | "advisor";
  displayName: string | null;
}

export type AssignLeadResult =
  | { ok: true; lead: StoredLead; changed: boolean }
  | { ok: false; error: "not_found" | "validation"; message: string };

export type UpdateLeadStatusResult =
  | { ok: true; lead: StoredLead }
  | { ok: false; error: "not_found" | "invalid_transition"; message: string };

export interface LeadRepository {
  create(lead: StoredLead): Promise<StoredLead>;
  /** Newest first. */
  list(filter?: LeadFilter): Promise<StoredLead[]>;
  getById(id: string): Promise<StoredLead | null>;
  /** Enforces LEAD_STATUS_TRANSITIONS; withdrawal erases PII; writes an audit event with actorId. */
  updateStatus(id: string, status: LeadStatus, actorId: string): Promise<UpdateLeadStatusResult>;
  /** Sets (or clears, with null) the assignee; assignee must be staff; withdrawn leads refused. Audited. */
  assign(id: string, assigneeId: string | null, actorId: string): Promise<AssignLeadResult>;
  /** Staff members leads can be assigned to. */
  listStaff(): Promise<StaffMember[]>;
}

export interface NewProjectInput {
  name: string;
  /** Existing developer to attach. When absent, a NEW developer named `developerName` is created. */
  developerId?: string;
  developerName?: string;
  localityId: string; // must be an active locality (src/config/markets)
  lat?: number; // both or neither; default = locality centroid
  lng?: number;
}

/** The human staff member a write is attributed to (audit). */
export interface AuditActor {
  actorId: string;
  actorRole: StaffRole;
}

export type ResearchWriteResult =
  | { ok: true; project: Project; autoUnpublished: boolean }
  | { ok: false; error: "not_found" | "conflict"; message: string };

/** A stored document version, with the staff-only storage fields. */
export interface StoredDocument extends ProjectDocument {
  projectId: string;
  documentKey: string;
  storagePath: string | null;
  contentType: DocumentContentType | null;
  sizeBytes: number | null;
  sha256: string | null;
}

export interface NewDocumentRecord {
  projectId: string;
  documentKey: string;
  title: string;
  kind: ProjectDocument["kind"];
  documentDate: string | null;
  sourceId: string;
  sourceUrl: string | null;
  storagePath: string;
  contentType: DocumentContentType;
  sizeBytes: number;
  sha256: string;
  /** Must equal nextDocumentVersion(); otherwise "conflict" (a concurrent upload won). */
  version: number;
}

export type AddDocumentResult =
  | { ok: true; document: StoredDocument }
  | { ok: false; error: "not_found" | "conflict"; message: string };

export type PublishWriteResult =
  | { ok: true; project: Project; changed: boolean }
  | { ok: false; error: "not_found" | "not_ready"; message: string; blockers?: string[] };

/** Audit event plus a display name for the actor (staff_profiles.display_name, else the id). */
export interface StaffAuditEntry extends FactAuditEvent {
  actorName: string;
}

export const AUTO_UNPUBLISH_NOTE = "auto: failed readiness after edit";
export const CONFLICT_MESSAGE = "This fact changed since you loaded it — reload and review again.";

/**
 * STAFF write model (M3, D12/D13). Never use for public reads: it returns unpublished projects.
 * Callers (services/research.ts) enforce staff session and role rules. Every write applies the
 * change AND its audit event atomically (one SQL transaction in Supabase; a single commit in the
 * fixture). After a fact or verification change, a published project that no longer passes
 * readiness is unpublished in the same transaction (audit note AUTO_UNPUBLISH_NOTE).
 * `completeness` is recomputed on fact writes (computeCompleteness / tn_compute_completeness in SQL).
 */
export interface ResearchRepository {
  listAllProjects(): Promise<Project[]>;
  getProjectByIdForStaff(id: string): Promise<Project | null>;
  listDevelopers(): Promise<Developer[]>;
  /** Unique slug; unpublished; isSample false; every research fact unknown with no sources. Audits "created". */
  createProject(input: NewProjectInput, actor: AuditActor): Promise<Project>;
  /** Replaces the current value (history kept in Supabase). Audits fact_set. */
  setFact(projectId: string, field: ResearchFactField, fact: FactValue<unknown>, actor: AuditActor): Promise<ResearchWriteResult>;
  /**
   * Applies only if factVersion(current fact) === expectedVersion AND (when given) the current
   * verification === expectedFrom, else "conflict". Audits.
   */
  setFactVerification(
    projectId: string,
    field: ResearchFactField,
    to: VerificationState,
    expectedVersion: string,
    actor: AuditActor,
    note: string | null,
    expectedFrom?: VerificationState,
  ): Promise<ResearchWriteResult>;
  /** 1 + highest stored version of (projectId, documentKey); 1 when none. */
  nextDocumentVersion(projectId: string, documentKey: string): Promise<number>;
  /** Inserts a document version + audit ('documents' / 'document_uploaded') atomically. */
  addDocument(record: NewDocumentRecord, actor: AuditActor): Promise<AddDocumentResult>;
  /** Staff-only lookup including the storage path (never expose it publicly). */
  getDocumentForStaff(documentId: string): Promise<StoredDocument | null>;
  /** Whether a document row references this storage path (upload cleanup must not orphan a committed row). */
  documentExistsAtPath(storagePath: string): Promise<boolean>;
  /** Publishing re-checks readiness under lock ("not_ready" with blockers). No-op → changed:false, no audit. */
  setPublished(projectId: string, published: boolean, actor: AuditActor): Promise<PublishWriteResult>;
  /** Oldest first. */
  listAudit(projectId: string): Promise<StaffAuditEntry[]>;
}

// ---- M2.5: on-demand research jobs (docs/RESEARCH_WORKER.md) ----

export type ResearchJobStatus = "queued" | "running" | "done" | "no_results" | "failed";
/** search_miss = a buyer search found nothing (M2.5); area_developments = staff-requested locality development research (S4a). */
export type ResearchJobKind = "search_miss" | "area_developments";

/** A research job. queryText is the buyer's raw query: staff-visible, never logged. */
export interface ResearchJob {
  id: string;
  kind: ResearchJobKind;
  queryText: string;
  queryKey: string;
  localityId: string | null;
  status: ResearchJobStatus;
  attempts: number;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultCount: number;
  errorCode: string | null;
}

export interface EnqueueResearchInput {
  queryText: string;
  queryKey: string;
  localityId: string | null;
  requesterIpHash: string | null;
  /** A done/no_results job for the same key finished within this many hours is reused. */
  cacheHours: number;
  /** Global cap on jobs requested in the last 24 hours. */
  maxPerDay: number;
  /** Cap per requesterIpHash in the last 24 hours (ignored when the hash is null). */
  maxPerRequesterPerDay: number;
  /** Default search_miss. area_developments keys are developmentQueryKey(localityId). */
  kind?: ResearchJobKind;
}

export type EnqueueResearchResult =
  | { outcome: "queued"; job: ResearchJob }
  | { outcome: "active"; job: ResearchJob } // already queued or running
  | { outcome: "cached"; job: ResearchJob } // done/no_results within the cache TTL
  | { outcome: "failed_recently"; job: ResearchJob } // failed (incl. stalled) within 6 hours
  | { outcome: "daily_cap" }
  | { outcome: "requester_cap" };

export interface FinishResearchInput {
  status: "done" | "no_results" | "failed" | "queued"; // queued = retry later
  resultCount: number;
  errorCode: string | null;
  listingIds: string[];
}

export interface ResearchJobWithListings extends ResearchJob {
  listings: ExternalListing[];
}

/** Queued jobs not picked up for this long are failed with error_code 'stalled' on the next enqueue. */
export const RESEARCH_STALL_MINUTES = 30;
/** A failed job for a key blocks re-research of that key for this long ("unavailable"). */
export const RESEARCH_FAILURE_COOLDOWN_HOURS = 6;

/**
 * Research job queue (service role only in Supabase). enqueue and claim are atomic in SQL
 * (research_enqueue / research_claim_jobs with FOR UPDATE SKIP LOCKED).
 */
export interface ResearchJobRepository {
  enqueue(input: EnqueueResearchInput): Promise<EnqueueResearchResult>;
  /** Newest jobs for this key first (read-only; for rendering the page state without side effects). */
  listForQuery(queryKey: string, limit: number): Promise<ResearchJob[]>;
  /**
   * Marks up to `limit` queued jobs (and running jobs stale for staleMinutes with a retry left)
   * running; attempts + 1. Stale running jobs with attempts >= 2 become failed ('abandoned').
   */
  claim(limit: number, staleMinutes: number): Promise<ResearchJob[]>;
  /** Records the outcome and links the stored listings. Only a running job can be finished. */
  finish(id: string, input: FinishResearchInput): Promise<ResearchJob | null>;
  /** Listings of the newest done job for queryKey finished within cacheHours (empty if none). */
  listingsForQuery(queryKey: string, cacheHours: number): Promise<ExternalListing[]>;
  /** Newest first, with linked listings. Staff only (callers enforce the session). */
  listRecent(limit: number): Promise<ResearchJobWithListings[]>;
}

// ---- S1a: fact store read model (0006_fact_store.sql, D18 proposed) ----

/**
 * READ-ONLY access to facts_current (service role in Supabase; no anon grant yet, nothing renders
 * from it). One CurrentFact per attribute; contradicting values are in fact.conflicts, never hidden.
 * Inputs are validated (zod); a malformed key throws.
 */
export interface FactStoreRepository {
  /** Every current attribute of one entity, sorted by attribute. */
  listCurrent(entityType: FactEntityType, entityId: string): Promise<CurrentFact[]>;
  getCurrent(entityType: FactEntityType, entityId: string, attribute: string): Promise<CurrentFact | null>;
}

// ---- S4a: planned area developments (0008_developments.sql, D20) ----

export type DevelopmentReviewStatus = "pending" | "published" | "rejected";

/** What research saw on a row staff had already published or rejected (never applied automatically). */
export interface DevelopmentPendingChange {
  stage: InfrastructureStage | null;
  authority: string | null;
  expectedCompletion: string | null;
  observedAt: string | null;
}

/** A development with its staff-only review state. Never pass to public pages. */
export interface StaffDevelopment extends Development {
  published: boolean;
  reviewStatus: DevelopmentReviewStatus;
  rejectionNote: string | null;
  pendingChange: DevelopmentPendingChange | null;
  researchJobId: string | null;
  researchLocalityId: string | null;
  /** Optimistic-concurrency token: edits and review actions must post the version they saw. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Editable fields (staff create / edit). */
export interface DevelopmentFields {
  name: string;
  category: InfrastructureCategory;
  stage: InfrastructureStage;
  authority: string | null;
  expectedCompletion: string | null;
  announcedDate: string | null;
  localityIds: string[];
  location: GeoPoint | null;
  sourceId: string | null;
  sourceUrl: string | null;
  sourceObservedAt: string | null;
}

/** One validated, cited research item (src/discovery/research/developments.ts). */
export interface ResearchedDevelopmentInput {
  name: string;
  category: InfrastructureCategory;
  stage: InfrastructureStage;
  authority: string | null;
  expectedCompletion: string | null;
  localityId: string;
  sourceUrl: string;
}

export interface StoreResearchedDevelopmentsInput {
  jobId: string;
  researchLocalityId: string;
  sourceId: string;
  observedAt: string;
  isSample: boolean;
  items: ResearchedDevelopmentInput[];
}

export type DevelopmentReviewAction = "publish" | "unpublish" | "reject" | "restore";

export type DevelopmentWriteResult =
  | { ok: true; development: StaffDevelopment; changed: boolean; autoUnpublished: boolean }
  | { ok: false; error: "not_found" | "conflict" | "not_ready" | "duplicate"; message: string; blockers?: string[] };

export interface DevelopmentAuditEntry {
  id: string;
  developmentId: string;
  action: "researched" | "created" | "edited" | "published" | "unpublished" | "rejected" | "restored";
  fromVerification: VerificationState | null;
  toVerification: VerificationState | null;
  actorId: string;
  actorRole: "advisor" | "admin" | "system";
  at: string;
  note: string | null;
}

export const DEVELOPMENT_CONFLICT_MESSAGE = "This development changed since you loaded it — reload and review again.";

/**
 * Developments store. listPublished is the PUBLIC read (published rows only; anon key + RLS in
 * Supabase). Everything else is staff/worker-only (service role); callers enforce the session.
 * Every write applies the change and its audit event atomically, and keeps the append-only
 * completion history (a changed declared date appends one entry).
 */
export interface DevelopmentRepository {
  listPublished(): Promise<Development[]>;
  /** Rows listed for the locality or researched for it; newest first. */
  listForStaff(filter: { localityId?: string; limit?: number }): Promise<StaffDevelopment[]>;
  getForStaff(id: string): Promise<StaffDevelopment | null>;
  /** Upsert by (name, cited URL). Pending rows take new values; reviewed rows get pendingChange. Returns ids. */
  storeResearched(input: StoreResearchedDevelopmentsInput): Promise<string[]>;
  create(fields: DevelopmentFields, isSample: boolean, actor: AuditActor): Promise<StaffDevelopment>;
  update(id: string, expectedVersion: number, fields: DevelopmentFields, actor: AuditActor): Promise<DevelopmentWriteResult>;
  review(
    id: string,
    expectedVersion: number,
    action: DevelopmentReviewAction,
    verification: "unverified" | "source_confirmed" | null,
    note: string | null,
    actor: AuditActor,
  ): Promise<DevelopmentWriteResult>;
  /** Oldest first. */
  listAudit(id: string): Promise<DevelopmentAuditEntry[]>;
}

export interface Repositories {
  backend: "fixture" | "supabase";
  projects: ProjectRepository;
  research: ResearchRepository;
  externalListings: ExternalListingRepository;
  researchJobs: ResearchJobRepository;
  leads: LeadRepository;
  /** Read-only fact store (facts_current). */
  factStore: FactStoreRepository;
  /** Planned area developments (S4a). */
  developments: DevelopmentRepository;
  /** Object storage for project documents (private; server-side access only). */
  documentStorage: DocumentStorage;
}

export const DEFAULT_PROJECT_LIMIT = 20;
export const MAX_PROJECT_LIMIT = 50;
export const DEFAULT_LEAD_LIMIT = 50;
export const MAX_LEAD_LIMIT = 200;

export function clampLimit(n: number | undefined, def: number, max: number): number {
  if (n === undefined || !Number.isFinite(n)) return def;
  return Math.max(0, Math.min(max, Math.floor(n)));
}
