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
  ResearchFactField,
  VerificationState,
} from "@/domain/types";
import type { BhkOption } from "@/domain/search-options";
import type { LeadQualification } from "@/leads/qualification";

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
}

export interface LeadFilter {
  status?: LeadStatus;
  requestType?: LeadRequestType;
  limit?: number;
}

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
}

export interface NewProjectInput {
  name: string;
  developerName: string;
  localityId: string; // must be an active locality (src/config/markets)
  lat?: number; // both or neither; default = locality centroid
  lng?: number;
}

/**
 * STAFF write model (M3, D12). Never use for public reads: it returns unpublished projects.
 * Callers (services/research.ts) enforce staff session, roles and publish rules. Every write
 * recomputes `completeness` with computeCompleteness (src/research/publish.ts).
 */
export interface ResearchRepository {
  listAllProjects(): Promise<Project[]>;
  getProjectByIdForStaff(id: string): Promise<Project | null>;
  /** Unique slug; unpublished; isSample false; every research fact unknown with no sources. */
  createProject(input: NewProjectInput): Promise<Project>;
  /** Replaces the current value (history kept where the backend supports it). null if no project. */
  setFact(projectId: string, field: ResearchFactField, fact: FactValue<unknown>): Promise<Project | null>;
  setFactVerification(projectId: string, field: ResearchFactField, to: VerificationState): Promise<Project | null>;
  setPublished(projectId: string, published: boolean): Promise<Project | null>;
  appendAudit(event: FactAuditEvent): Promise<void>;
  /** Oldest first. */
  listAudit(projectId: string): Promise<FactAuditEvent[]>;
}

export interface Repositories {
  backend: "fixture" | "supabase";
  projects: ProjectRepository;
  research: ResearchRepository;
  externalListings: ExternalListingRepository;
  leads: LeadRepository;
}

export const DEFAULT_PROJECT_LIMIT = 20;
export const MAX_PROJECT_LIMIT = 50;
export const DEFAULT_LEAD_LIMIT = 50;
export const MAX_LEAD_LIMIT = 200;

export function clampLimit(n: number | undefined, def: number, max: number): number {
  if (n === undefined || !Number.isFinite(n)) return def;
  return Math.max(0, Math.min(max, Math.floor(n)));
}
