import "server-only";
import type { ConstructionStatus, ExternalListing, Lead, LeadStatus, Project } from "@/domain/types";
import type { LeadQualification } from "@/leads/qualification";

export interface ProjectFilter {
  localityId?: string;
  text?: string; // case-insensitive match on project name, developer name or slug
  status?: ConstructionStatus; // matches constructionStatus only where it is known
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

export interface Repositories {
  backend: "fixture" | "supabase";
  projects: ProjectRepository;
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
