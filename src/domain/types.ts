// Shared domain contract. Owned by the orchestrator; change only via a DECISIONS.md entry.
// Every material fact carries provenance (FactValue). Missing data is `status: "unknown"`,
// which is never the same as a negative finding.

export type VerificationState =
  | "unverified" // collected, not reviewed
  | "source_confirmed" // matches an authoritative public source on observation date
  | "reviewed" // checked by our reviewer against documents
  | "disputed" // sources disagree
  | "requires_professional_review"; // e.g. title, legal opinions

export type SourceType =
  | "regulator" // e.g. state RERA portal
  | "government"
  | "developer"
  | "listing_portal"
  | "partner_feed"
  | "news"
  | "field_visit"
  | "fixture"; // test/sample data only

export interface SourceRef {
  sourceId: string; // id in the approved source registry
  url: string | null; // canonical URL of the specific page/document
  observedAt: string; // ISO timestamp when we saw it
  documentDate?: string | null; // date printed on the document, if any
  note?: string;
}

/**
 * What kind of claim a fact is (constitution §2), orthogonal to VerificationState (D18, proposed):
 * official = from the builder, RERA or a government body; estimated = derived by us from public
 * signals (always shown with its basis and date, never styled as official); unknown = nothing
 * credible found yet (never a negative finding).
 */
export type FactTruthStatus = "official" | "estimated" | "unknown";

/** The basis of an estimated fact. */
export interface FactEstimateBasis {
  sources: SourceRef[];
  assumptionsVersion?: string;
  signalCount?: number;
}

/** Another live value for the same attribute (constitution §3: contradictions are shown). */
export interface FactConflict<T> {
  value: T | null;
  truth: FactTruthStatus;
  verification?: VerificationState;
  source: SourceRef | null; // null only for a curated value stored without a source
}

export interface FactValue<T> {
  status: "known" | "unknown"; // unknown = we have not found it; not a negative finding
  value: T | null;
  verification: VerificationState;
  sources: SourceRef[];
  // S1a fact store (D18). Optional until every repository fills them.
  truth?: FactTruthStatus;
  lastVerifiedAt?: string;
  ttlHours?: number;
  estimateBasis?: FactEstimateBasis;
  conflicts?: FactConflict<T>[];
}

export type DiscoveryLane = "researched" | "external";

export type ConstructionStatus =
  | "pre_launch"
  | "under_construction"
  | "ready_to_move"
  | "completed"
  | "stalled"
  | "unknown";

export type InfrastructureStage =
  | "proposed"
  | "approved"
  | "tendered"
  | "under_construction"
  | "operational";

export interface GeoPoint {
  lat: number;
  lng: number;
  precision: "exact" | "approximate" | "locality_centroid";
}

export interface Developer {
  id: string;
  name: string;
  isSample: boolean;
}

export interface RegulatoryRecord {
  id: string;
  kind: "rera_registration" | "complaint" | "order" | "extension" | "other_disclosure";
  reference: string | null; // e.g. registration/complaint number as printed
  summary: string;
  status: FactValue<string>;
  source: SourceRef;
  verification: VerificationState;
}

// A search we performed. resultsFound = 0 means "none found in these sources on this date",
// never "none exist". No RegulatorySearch for a kind means "not yet checked".
export interface RegulatorySearch {
  kind: RegulatoryRecord["kind"];
  sourceId: string;
  url: string | null;
  searchedAt: string;
  resultsFound: number;
}

export interface ProjectDocument {
  id: string;
  title: string;
  kind: "approval" | "brochure" | "rera_certificate" | "plan" | "other";
  version: number;
  documentDate: string | null;
  source: SourceRef;
}

export interface UnitConfiguration {
  label: string; // e.g. "2 BHK"
  carpetAreaSqft: FactValue<{ min: number; max: number }>;
  priceInr: FactValue<{ min: number; max: number }>;
}

export interface Project {
  id: string;
  slug: string;
  lane: "researched";
  name: string;
  developer: Developer;
  localityId: string;
  location: GeoPoint;
  address: FactValue<string>;
  reraNumbers: FactValue<string[]>;
  constructionStatus: FactValue<ConstructionStatus>;
  declaredPossession: FactValue<string>; // as declared by developer/RERA, not a promise
  units: UnitConfiguration[];
  regulatoryRecords: RegulatoryRecord[];
  regulatorySearches: RegulatorySearch[];
  documents: ProjectDocument[];
  reviewFlags: string[]; // items requiring qualified professional review
  completeness: number; // 0..1, computed from fact coverage
  lastCheckedAt: string;
  isSample: boolean;
  published: boolean;
}

export interface ExternalListing {
  id: string;
  lane: "external";
  sourceId: string;
  sourceRecordId: string | null;
  canonicalUrl: string;
  title: string; // short factual title only; never copied descriptions
  developerName: string | null;
  localityId: string | null;
  location: GeoPoint | null;
  priceText: string | null; // as shown by source, unverified
  discoveredAt: string;
  lastSeenAt: string | null;
  limitations: string[];
  matchedProjectId: string | null; // set only by dedupe with strong identifiers
  isSample: boolean;
}

export type PropertyResult = Project | ExternalListing;

export interface InfrastructureItem {
  id: string;
  name: string;
  category: "metro" | "rail" | "road" | "airport" | "water" | "power" | "other";
  stage: InfrastructureStage;
  localityIds: string[];
  location: GeoPoint | null;
  declaredCompletion: FactValue<string>; // only with evidence; never a promise
  sources: SourceRef[];
  lastCheckedAt: string;
  isSample: boolean;
}

export interface Amenity {
  id: string;
  name: string;
  category: "school" | "college" | "healthcare" | "retail" | "park" | "transit" | "other";
  location: GeoPoint;
  source: SourceRef;
  isSample: boolean;
}

export type LeadRequestType = "verification" | "buyer_assistance";

export type ContactChannel = "phone" | "email" | "whatsapp";

export interface LeadInput {
  requestType: LeadRequestType;
  name: string;
  email: string | null;
  phone: string | null;
  preferredChannel: ContactChannel;
  message: string | null;
  projectId: string | null;
  externalListingId: string | null;
  budgetBand: string | null;
  consent: {
    contactConsent: boolean; // required to store the lead
    marketingConsent: boolean; // optional, separate
    consentTextVersion: string;
  };
  attribution: { utmSource?: string; utmMedium?: string; utmCampaign?: string; landingPath?: string };
}

export type LeadStatus = "new" | "contacted" | "qualified" | "closed" | "withdrawn";

export interface Lead extends LeadInput {
  id: string;
  status: LeadStatus;
  createdAt: string;
  retentionUntil: string;
}

// ---- M3: staff research write-model (see DECISIONS D12) ----

export type ResearchFactField = "address" | "reraNumbers" | "constructionStatus" | "declaredPossession";

export type StaffRole = "advisor" | "admin";

// Every staff edit or verification change is recorded. actorId is always a human staff id.
export interface FactAuditEvent {
  id: string;
  projectId: string;
  field: ResearchFactField | "published" | "basics" | "documents";
  action:
    | "fact_set"
    | "verification_changed"
    | "published"
    | "unpublished"
    | "basics_updated"
    | "created"
    | "document_uploaded"
    | "document_extracted"; // S3a (0007, D19)
  fromVerification: VerificationState | null;
  toVerification: VerificationState | null;
  actorId: string;
  actorRole: StaffRole;
  at: string;
  note: string | null;
}

export interface PublishReadiness {
  ready: boolean;
  completeness: number; // 0..1
  blockers: string[]; // human-readable reasons publishing is blocked
}
