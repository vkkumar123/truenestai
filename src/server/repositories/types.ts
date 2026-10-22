import "server-only";
import type {
  ConstructionStatus,
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

export interface ExternalListingRepository {
  getById(id: string): Promise<ExternalListing | null>;
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
  /** Publishing re-checks readiness under lock ("not_ready" with blockers). No-op → changed:false, no audit. */
  setPublished(projectId: string, published: boolean, actor: AuditActor): Promise<PublishWriteResult>;
  /** Oldest first. */
  listAudit(projectId: string): Promise<StaffAuditEntry[]>;
}

export interface Repositories {
  backend: "fixture" | "supabase";
  projects: ProjectRepository;
  research: ResearchRepository;
  externalListings: ExternalListingRepository;
  leads: LeadRepository;
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
