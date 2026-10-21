import "server-only";
import type {
  ConstructionStatus,
  Developer,
  FactValue,
  GeoPoint,
  Project,
  ProjectDocument,
  RegulatoryRecord,
  SourceRef,
  UnitConfiguration,
  VerificationState,
} from "@/domain/types";
import { getLocality } from "@/config/markets";
import { NONE_FOUND_STATUS } from "../types";

// OBVIOUSLY FICTIONAL sample data for local development and tests. Not real projects,
// developers, RERA numbers, documents or URLs. Every record has isSample: true.
// Locality ids are references into src/config/markets (the only geography source of truth);
// coordinates are taken from the configured locality centroid.

const SOURCE_ID = "sample-feed";
const OBSERVED = "2026-10-01T09:00:00.000Z";
const CHECKED = "2026-10-15T09:00:00.000Z";

function src(path: string, extra: Partial<SourceRef> = {}): SourceRef {
  return { sourceId: SOURCE_ID, url: `https://example.com/sample/${path}`, observedAt: OBSERVED, documentDate: null, ...extra };
}

function known<T>(value: T, sources: SourceRef[], verification: VerificationState = "unverified"): FactValue<T> {
  return { status: "known", value, verification, sources };
}

/** Not found yet. This is NOT a negative finding. */
function unknown<T>(): FactValue<T> {
  return { status: "unknown", value: null, verification: "unverified", sources: [] };
}

function centroid(localityId: string): GeoPoint {
  const loc = getLocality(localityId);
  if (!loc) throw new Error(`Fixture references unknown locality "${localityId}" (src/config/markets).`);
  return { lat: loc.centroid.lat, lng: loc.centroid.lng, precision: "locality_centroid" };
}

const DEV_A: Developer = { id: "sample-dev-a", name: "SAMPLE Developer A", isSample: true };
const DEV_B: Developer = { id: "sample-dev-b", name: "SAMPLE Developer B", isSample: true };
const DEV_C: Developer = { id: "sample-dev-c", name: "SAMPLE Developer C", isSample: true };

function unit(label: string, slug: string, area?: [number, number], price?: [number, number]): UnitConfiguration {
  return {
    label,
    carpetAreaSqft: area ? known({ min: area[0], max: area[1] }, [src(`${slug}/units`)]) : unknown(),
    priceInr: price ? known({ min: price[0], max: price[1] }, [src(`${slug}/price-sheet`)]) : unknown(),
  };
}

function reraRecord(id: string, slug: string, reference: string): RegulatoryRecord {
  return {
    id,
    kind: "rera_registration",
    reference,
    summary: "SAMPLE registration entry (fictional). Registration is not title clearance.",
    status: known("registered (as shown by SAMPLE source)", [src(`${slug}/rera`)]),
    source: src(`${slug}/rera`),
    verification: "unverified",
  };
}

function doc(id: string, slug: string, title: string, kind: ProjectDocument["kind"], version = 1, documentDate: string | null = null): ProjectDocument {
  return { id, title, kind, version, documentDate, source: src(`${slug}/docs/${id}`, { documentDate }) };
}

interface Spec {
  id: string;
  slug: string;
  name: string;
  developer: Developer;
  localityId: string;
  rera: string[] | null;
  status: ConstructionStatus | null;
  statusVerification?: VerificationState;
  possession: string | null;
  address: string | null;
  units: UnitConfiguration[];
  regulatoryRecords?: RegulatoryRecord[];
  documents?: ProjectDocument[];
  reviewFlags?: string[];
  published?: boolean;
}

function completeness(p: Pick<Project, "address" | "reraNumbers" | "constructionStatus" | "declaredPossession" | "units">): number {
  const facts: FactValue<unknown>[] = [p.address, p.reraNumbers, p.constructionStatus, p.declaredPossession];
  for (const u of p.units) facts.push(u.carpetAreaSqft, u.priceInr);
  const knownCount = facts.filter((f) => f.status === "known").length;
  return facts.length ? Math.round((knownCount / facts.length) * 100) / 100 : 0;
}

function build(s: Spec): Project {
  const base = {
    address: s.address ? known(s.address, [src(`${s.slug}/overview`)]) : unknown<string>(),
    reraNumbers: s.rera ? known(s.rera, [src(`${s.slug}/rera`)]) : unknown<string[]>(),
    constructionStatus: s.status
      ? known(s.status, [src(`${s.slug}/progress`)], s.statusVerification ?? "unverified")
      : unknown<ConstructionStatus>(),
    declaredPossession: s.possession ? known(s.possession, [src(`${s.slug}/rera`)]) : unknown<string>(),
    units: s.units,
  };
  return {
    id: s.id,
    slug: s.slug,
    lane: "researched",
    name: s.name,
    developer: s.developer,
    localityId: s.localityId,
    location: centroid(s.localityId),
    ...base,
    regulatoryRecords: s.regulatoryRecords ?? [],
    documents: s.documents ?? [],
    reviewFlags: s.reviewFlags ?? [],
    completeness: completeness(base),
    lastCheckedAt: CHECKED,
    isSample: true,
    published: s.published ?? true,
  };
}

const TITLE_FLAG = "Title and land records require review by a qualified advocate (not performed by TrueNest).";

export const SAMPLE_PROJECTS: readonly Project[] = [
  build({
    id: "sample-proj-lakeview",
    slug: "sample-lakeview-residences",
    name: "SAMPLE Lakeview Residences",
    developer: DEV_A,
    localityId: "hebbal",
    rera: ["SAMPLE-RERA-0001"],
    status: "under_construction",
    possession: "2028-12 (as declared in SAMPLE registration)",
    address: "SAMPLE Road 1, Hebbal (fictional)",
    units: [unit("2 BHK", "sample-lakeview-residences", [1050, 1180]), unit("3 BHK", "sample-lakeview-residences")],
    regulatoryRecords: [
      reraRecord("sample-reg-lakeview-rera", "sample-lakeview-residences", "SAMPLE-RERA-0001"),
      {
        id: "sample-reg-lakeview-complaint",
        kind: "complaint",
        reference: "SAMPLE-CMP-0001",
        summary: "SAMPLE complaint about delayed handover (fictional). Outcome not known.",
        status: known("pending (as shown by SAMPLE source)", [src("sample-lakeview-residences/complaints")]),
        source: src("sample-lakeview-residences/complaints", { documentDate: "2026-08-20" }),
        verification: "unverified",
      },
    ],
    documents: [
      doc("sample-doc-lakeview-brochure-v2", "sample-lakeview-residences", "SAMPLE Brochure", "brochure", 2, "2026-07-01"),
      doc("sample-doc-lakeview-rera-cert", "sample-lakeview-residences", "SAMPLE RERA certificate", "rera_certificate", 1, "2025-03-10"),
    ],
    reviewFlags: [TITLE_FLAG, "A complaint is listed against this SAMPLE project; outcome unknown."],
  }),
  build({
    id: "sample-proj-northwind",
    slug: "sample-northwind-heights",
    name: "SAMPLE Northwind Heights",
    developer: DEV_B,
    localityId: "hebbal",
    rera: ["SAMPLE-RERA-0002"],
    status: "ready_to_move",
    possession: "2026-06 (as declared in SAMPLE registration)",
    address: "SAMPLE Avenue 2, Hebbal (fictional)",
    units: [unit("3 BHK", "sample-northwind-heights", [1400, 1550], [15000000, 17500000])],
    // A search WAS performed and found nothing. Shown as "none found in <source> on <date>",
    // never as "no complaints" / "clean". Contrast with Orchard Greens (never searched = unknown).
    regulatoryRecords: [
      reraRecord("sample-reg-northwind-rera", "sample-northwind-heights", "SAMPLE-RERA-0002"),
      {
        id: "sample-reg-northwind-complaint-search",
        kind: "complaint",
        reference: null,
        summary:
          "No complaints were found in the SAMPLE source search on the observed date. This is not proof that none exist.",
        status: known(NONE_FOUND_STATUS, [src("sample-northwind-heights/complaints")]),
        source: src("sample-northwind-heights/complaints"),
        verification: "unverified",
      },
    ],
    documents: [doc("sample-doc-northwind-plan", "sample-northwind-heights", "SAMPLE Floor plan", "plan", 1, "2025-11-02")],
    reviewFlags: [TITLE_FLAG],
  }),
  build({
    id: "sample-proj-orchard",
    slug: "sample-orchard-greens",
    name: "SAMPLE Orchard Greens",
    developer: DEV_C,
    localityId: "devanahalli",
    rera: null, // not found yet — unknown, NOT "unregistered"
    status: "pre_launch",
    possession: null,
    address: null,
    units: [unit("Plot", "sample-orchard-greens")],
    reviewFlags: [TITLE_FLAG, "RERA registration not yet found; registration status unknown."],
  }),
  build({
    id: "sample-proj-courtyard",
    slug: "sample-yelahanka-courtyard",
    name: "SAMPLE Yelahanka Courtyard",
    developer: DEV_A,
    localityId: "yelahanka",
    rera: ["SAMPLE-RERA-0004"],
    status: "completed",
    possession: "2025-09 (as declared in SAMPLE registration)",
    address: "SAMPLE Lane 4, Yelahanka (fictional)",
    units: [unit("2 BHK", "sample-yelahanka-courtyard", [980, 1050], [8500000, 9200000])],
    regulatoryRecords: [reraRecord("sample-reg-courtyard-rera", "sample-yelahanka-courtyard", "SAMPLE-RERA-0004")],
    documents: [doc("sample-doc-courtyard-oc", "sample-yelahanka-courtyard", "SAMPLE Occupancy approval", "approval", 1, "2025-08-15")],
    reviewFlags: [TITLE_FLAG],
  }),
  build({
    id: "sample-proj-riverside",
    slug: "sample-riverside-thanisandra",
    name: "SAMPLE Riverside Thanisandra",
    developer: DEV_B,
    localityId: "thanisandra",
    rera: ["SAMPLE-RERA-0005"],
    status: "under_construction",
    statusVerification: "disputed", // sources disagree on progress
    possession: null,
    address: "SAMPLE Street 5, Thanisandra (fictional)",
    units: [unit("2 BHK", "sample-riverside-thanisandra"), unit("3 BHK", "sample-riverside-thanisandra", [1300, 1420])],
    regulatoryRecords: [reraRecord("sample-reg-riverside-rera", "sample-riverside-thanisandra", "SAMPLE-RERA-0005")],
    reviewFlags: [TITLE_FLAG, "SAMPLE sources disagree on construction progress."],
  }),
  build({
    id: "sample-proj-hennur",
    slug: "sample-hennur-gardens",
    name: "SAMPLE Hennur Gardens",
    developer: DEV_C,
    localityId: "hennur",
    rera: ["SAMPLE-RERA-0006"],
    status: "under_construction",
    possession: "2027-03 (as declared in SAMPLE registration)",
    address: "SAMPLE Cross 6, Hennur (fictional)",
    units: [unit("1 BHK", "sample-hennur-gardens", [620, 700], [5200000, 5900000]), unit("2 BHK", "sample-hennur-gardens", [1000, 1100])],
    regulatoryRecords: [reraRecord("sample-reg-hennur-rera", "sample-hennur-gardens", "SAMPLE-RERA-0006")],
    documents: [
      doc("sample-doc-hennur-brochure-v1", "sample-hennur-gardens", "SAMPLE Brochure", "brochure", 1, "2026-01-05"),
    ],
    reviewFlags: [TITLE_FLAG],
  }),
  build({
    id: "sample-proj-jakkur",
    slug: "sample-jakkur-lakeside",
    name: "SAMPLE Jakkur Lakeside",
    developer: DEV_A,
    localityId: "jakkur",
    rera: null,
    status: null,
    possession: null,
    address: "SAMPLE Road 7, Jakkur (fictional)",
    units: [],
    reviewFlags: [TITLE_FLAG, "Most facts not yet collected for this SAMPLE project."],
  }),
  // MUST NEVER appear publicly (tests assert this).
  build({
    id: "sample-proj-unpublished",
    slug: "sample-unpublished-draft",
    name: "SAMPLE Unpublished Draft",
    developer: DEV_B,
    localityId: "hebbal",
    rera: ["SAMPLE-RERA-0099"],
    status: "under_construction",
    possession: null,
    address: "SAMPLE Draft Road, Hebbal (fictional)",
    units: [],
    reviewFlags: ["Draft: pending human review."],
    published: false,
  }),
];
