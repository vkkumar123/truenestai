import "server-only";
import type {
  ConstructionStatus,
  ExternalListing,
  FactValue,
  GeoPoint,
  Project,
  ProjectDocument,
  RegulatoryRecord,
  RegulatorySearch,
  SourceRef,
  UnitConfiguration,
  VerificationState,
} from "@/domain/types";
import type { StoredLead } from "../types";

// Row shapes as selected below (see PROJECT_SELECT). numeric columns arrive as strings or numbers.
type Num = number | string;

export interface FactSourceRow {
  source_id: string;
  url: string | null;
  observed_at: string;
  document_date: string | null;
  note: string | null;
}
export interface FactRow {
  id: string;
  unit_id: string | null;
  field: string;
  value: unknown;
  status: "known" | "unknown";
  verification: VerificationState;
  is_current: boolean;
  fact_sources: FactSourceRow[] | null;
}
export interface RegulatoryRow {
  id: string;
  kind: RegulatoryRecord["kind"];
  reference: string | null;
  summary: string;
  status_status: "known" | "unknown";
  status_value: string | null;
  status_verification: VerificationState;
  source_id: string;
  source_url: string | null;
  observed_at: string;
  document_date: string | null;
  verification: VerificationState;
}
export interface RegulatorySearchRow {
  kind: RegulatorySearch["kind"];
  source_id: string;
  url: string | null;
  searched_at: string;
  results_found: number;
}
export interface DocumentRow {
  id: string;
  title: string;
  kind: ProjectDocument["kind"];
  version: number;
  document_date: string | null;
  source_id: string;
  source_url: string | null;
  observed_at: string;
}
export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  locality_id: string;
  lat: Num;
  lng: Num;
  location_precision: GeoPoint["precision"];
  review_flags: string[] | null;
  completeness: Num;
  last_checked_at: string;
  is_sample: boolean;
  published: boolean;
  developer: { id: string; name: string; is_sample: boolean } | null;
  units: { id: string; label: string; sort_order: number }[] | null;
  facts: FactRow[] | null;
  regulatory_records: RegulatoryRow[] | null;
  regulatory_searches: RegulatorySearchRow[] | null;
  project_documents: DocumentRow[] | null;
}

/** Columns safe for public reads (no storage paths). */
export const PROJECT_SELECT = [
  "id, slug, name, locality_id, lat, lng, location_precision, review_flags, completeness, last_checked_at, is_sample, published",
  "developer:developers(id, name, is_sample)",
  "units:project_units(id, label, sort_order)",
  "facts(id, unit_id, field, value, status, verification, is_current, fact_sources(source_id, url, observed_at, document_date, note))",
  "regulatory_records(id, kind, reference, summary, status_status, status_value, status_verification, source_id, source_url, observed_at, document_date, verification)",
  "regulatory_searches(kind, source_id, url, searched_at, results_found)",
  "project_documents(id, title, kind, version, document_date, source_id, source_url, observed_at)",
].join(", ");

const toNum = (n: Num) => (typeof n === "number" ? n : Number(n));

function sourceRef(r: FactSourceRow): SourceRef {
  return { sourceId: r.source_id, url: r.url, observedAt: r.observed_at, documentDate: r.document_date, ...(r.note ? { note: r.note } : {}) };
}

function unknownFact<T>(): FactValue<T> {
  return { status: "unknown", value: null, verification: "unverified", sources: [] };
}

function toFact<T>(row: FactRow | undefined): FactValue<T> {
  if (!row) return unknownFact<T>();
  return {
    status: row.status,
    value: row.status === "known" ? (row.value as T) : null,
    verification: row.verification,
    sources: (row.fact_sources ?? []).map(sourceRef),
  };
}

export function mapProjectRow(row: ProjectRow): Project {
  const facts = (row.facts ?? []).filter((f) => f.is_current);
  const projectFact = (field: string) => facts.find((f) => f.field === field && f.unit_id === null);
  const units: UnitConfiguration[] = [...(row.units ?? [])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((u) => ({
      label: u.label,
      carpetAreaSqft: toFact(facts.find((f) => f.unit_id === u.id && f.field === "unit_carpet_area_sqft")),
      priceInr: toFact(facts.find((f) => f.unit_id === u.id && f.field === "unit_price_inr")),
    }));
  const regulatoryRecords: RegulatoryRecord[] = (row.regulatory_records ?? []).map((r) => {
    const source: SourceRef = { sourceId: r.source_id, url: r.source_url, observedAt: r.observed_at, documentDate: r.document_date };
    return {
      id: r.id,
      kind: r.kind,
      reference: r.reference,
      summary: r.summary,
      status:
        r.status_status === "known"
          ? { status: "known", value: r.status_value, verification: r.status_verification, sources: [source] }
          : unknownFact<string>(),
      source,
      verification: r.verification,
    };
  });
  const documents: ProjectDocument[] = (row.project_documents ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    kind: d.kind,
    version: d.version,
    documentDate: d.document_date,
    source: { sourceId: d.source_id, url: d.source_url, observedAt: d.observed_at, documentDate: d.document_date },
  }));
  if (!row.developer) throw new Error(`Project ${row.id} has no readable developer.`);
  return {
    id: row.id,
    slug: row.slug,
    lane: "researched",
    name: row.name,
    developer: { id: row.developer.id, name: row.developer.name, isSample: row.developer.is_sample },
    localityId: row.locality_id,
    location: { lat: toNum(row.lat), lng: toNum(row.lng), precision: row.location_precision },
    address: toFact<string>(projectFact("address")),
    reraNumbers: toFact<string[]>(projectFact("rera_numbers")),
    constructionStatus: toFact<ConstructionStatus>(projectFact("construction_status")),
    declaredPossession: toFact<string>(projectFact("declared_possession")),
    units,
    regulatoryRecords,
    regulatorySearches: (row.regulatory_searches ?? []).map((s) => ({
      kind: s.kind,
      sourceId: s.source_id,
      url: s.url,
      searchedAt: s.searched_at,
      resultsFound: s.results_found,
    })),
    documents,
    reviewFlags: row.review_flags ?? [],
    completeness: toNum(row.completeness),
    lastCheckedAt: row.last_checked_at,
    isSample: row.is_sample,
    published: row.published,
  };
}

export interface ExternalListingRow {
  id: string;
  source_id: string;
  source_record_id: string | null;
  canonical_url: string;
  title: string;
  developer_name: string | null;
  locality_id: string | null;
  lat: Num | null;
  lng: Num | null;
  location_precision: GeoPoint["precision"] | null;
  price_text: string | null;
  discovered_at: string;
  last_seen_at: string | null;
  limitations: string[];
  matched_project_id: string | null;
  is_sample: boolean;
}

export function mapExternalListingRow(r: ExternalListingRow): ExternalListing {
  return {
    id: r.id,
    lane: "external",
    sourceId: r.source_id,
    sourceRecordId: r.source_record_id,
    canonicalUrl: r.canonical_url,
    title: r.title,
    developerName: r.developer_name,
    localityId: r.locality_id,
    location:
      r.lat !== null && r.lng !== null && r.location_precision
        ? { lat: toNum(r.lat), lng: toNum(r.lng), precision: r.location_precision }
        : null,
    priceText: r.price_text,
    discoveredAt: r.discovered_at,
    lastSeenAt: r.last_seen_at,
    limitations: r.limitations,
    matchedProjectId: r.matched_project_id,
    isSample: r.is_sample,
  };
}

export function externalListingToRow(l: ExternalListing): ExternalListingRow {
  return {
    id: l.id,
    source_id: l.sourceId,
    source_record_id: l.sourceRecordId,
    canonical_url: l.canonicalUrl,
    title: l.title,
    developer_name: l.developerName,
    locality_id: l.localityId,
    lat: l.location?.lat ?? null,
    lng: l.location?.lng ?? null,
    location_precision: l.location?.precision ?? null,
    price_text: l.priceText,
    discovered_at: l.discoveredAt,
    last_seen_at: l.lastSeenAt,
    limitations: l.limitations,
    matched_project_id: l.matchedProjectId,
    is_sample: l.isSample,
  };
}

export interface LeadRow {
  id: string;
  request_type: StoredLead["requestType"];
  name: string;
  email: string | null;
  phone: string | null;
  preferred_channel: StoredLead["preferredChannel"];
  message: string | null;
  project_id: string | null;
  external_listing_id: string | null;
  budget_band: string | null;
  contact_consent: boolean;
  marketing_consent: boolean;
  consent_text_version: string;
  consented_at: string;
  status: StoredLead["status"];
  qualification_score: number | null;
  qualification_tier: "high" | "medium" | "low" | null;
  qualification_reasons: string[] | null;
  attribution: StoredLead["attribution"] | null;
  created_at: string;
  retention_until: string;
}

export function mapLeadRow(r: LeadRow): StoredLead {
  return {
    id: r.id,
    requestType: r.request_type,
    name: r.name,
    email: r.email,
    phone: r.phone,
    preferredChannel: r.preferred_channel,
    message: r.message,
    projectId: r.project_id,
    externalListingId: r.external_listing_id,
    budgetBand: r.budget_band,
    consent: {
      contactConsent: r.contact_consent,
      marketingConsent: r.marketing_consent,
      consentTextVersion: r.consent_text_version,
    },
    attribution: r.attribution ?? {},
    status: r.status,
    createdAt: r.created_at,
    retentionUntil: r.retention_until,
    consentedAt: r.consented_at,
    qualification:
      r.qualification_score !== null && r.qualification_tier !== null
        ? { score: r.qualification_score, tier: r.qualification_tier, reasons: r.qualification_reasons ?? [] }
        : null,
  };
}

export function leadToRow(l: StoredLead): LeadRow {
  return {
    id: l.id,
    request_type: l.requestType,
    name: l.name,
    email: l.email,
    phone: l.phone,
    preferred_channel: l.preferredChannel,
    message: l.message,
    project_id: l.projectId,
    external_listing_id: l.externalListingId,
    budget_band: l.budgetBand,
    contact_consent: l.consent.contactConsent,
    marketing_consent: l.consent.marketingConsent,
    consent_text_version: l.consent.consentTextVersion,
    consented_at: l.consentedAt,
    status: l.status,
    qualification_score: l.qualification?.score ?? null,
    qualification_tier: l.qualification?.tier ?? null,
    qualification_reasons: l.qualification?.reasons ?? null,
    attribution: l.attribution,
    created_at: l.createdAt,
    retention_until: l.retentionUntil,
  };
}
