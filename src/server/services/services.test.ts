import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalListing } from "@/domain/types";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { createFixtureRepositories, SAMPLE_PROJECTS } = await import("../repositories/fixture");
const { searchProperties } = await import("./search");
const { getComparison, MAX_COMPARE } = await import("./compare");
const { submitLead, listLeads, updateLeadStatus, getLead } = await import("./leads");
const { FixedWindowRateLimiter } = await import("./rate-limit");
const { StaffAuthError } = await import("../auth");
const { CONSENT_TEXT_VERSION } = await import("@/leads/consent");

const UNPUBLISHED = SAMPLE_PROJECTS.find((p) => !p.published)!;
const staff = async () => ({ userId: "staff-1", role: "advisor" as const, mode: "fixture" as const, expiresAt: null });
const noStaff = async (): Promise<never> => {
  throw new StaffAuthError("unauthenticated");
};

function listing(id: string, matchedProjectId: string | null = null): ExternalListing {
  return {
    id,
    lane: "external",
    sourceId: "sample-feed",
    sourceRecordId: id,
    canonicalUrl: `https://example.com/sample/${id}`,
    title: `SAMPLE ${id}`,
    developerName: null,
    localityId: "hebbal",
    location: null,
    priceText: null,
    discoveredAt: "2026-10-01T00:00:00.000Z",
    lastSeenAt: null,
    limitations: ["Not verified by TrueNest"],
    matchedProjectId,
    isSample: true,
  };
}

beforeEach(() => {
  vi.stubEnv("DATA_BACKEND", "fixture");
});
afterEach(() => vi.unstubAllEnvs());

describe("fixture data", () => {
  it("is obviously fictional and spans the required localities", () => {
    for (const p of SAMPLE_PROJECTS) {
      expect(p.isSample).toBe(true);
      expect(p.name).toMatch(/^SAMPLE /);
      expect(p.developer.name).toMatch(/^SAMPLE Developer [ABC]$/);
      for (const r of p.reraNumbers.value ?? []) expect(r).toMatch(/^SAMPLE-RERA-\d{4}$/);
      for (const s of [...p.reraNumbers.sources, ...p.documents.map((d) => d.source)]) expect(s.url).toMatch(/^https:\/\/example\.com\//);
    }
    const locs = new Set(SAMPLE_PROJECTS.filter((p) => p.published).map((p) => p.localityId));
    for (const id of ["hebbal", "yelahanka", "devanahalli", "thanisandra", "hennur", "jakkur"]) expect(locs.has(id)).toBe(true);
    expect(SAMPLE_PROJECTS.some((p) => p.reraNumbers.status === "unknown")).toBe(true);
  });
});

describe("searchProperties", () => {
  it("never returns unpublished projects (by text, locality, slug or id)", async () => {
    const repos = createFixtureRepositories();
    const discover = vi.fn(async () => ({ listings: [], errors: [] }));
    for (const q of [{ text: "Unpublished" }, { localityId: "hebbal" }, { text: "SAMPLE" }, {}]) {
      const r = await searchProperties(q, { repos, discover, minResearched: 0 });
      expect(r.researched.find((p) => p.id === UNPUBLISHED.id)).toBeUndefined();
      expect(r.researched.every((p) => p.published)).toBe(true);
    }
    expect(await repos.projects.getProjectBySlug(UNPUBLISHED.slug)).toBeNull();
    expect(await repos.projects.getProjectsByIds([UNPUBLISHED.id])).toEqual([]);
  });

  it("queries Lane B only when researched results are below the threshold", async () => {
    const repos = createFixtureRepositories();
    const discover = vi.fn(async () => ({ listings: [listing("x1")], errors: [] }));
    const enough = await searchProperties({ localityId: "hebbal" }, { repos, discover, minResearched: 2 });
    expect(enough.researched).toHaveLength(2);
    expect(discover).not.toHaveBeenCalled();
    expect(enough).toMatchObject({ external: [], externalQueried: false });

    const few = await searchProperties({ localityId: "hebbal" }, { repos, discover, minResearched: 3 });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(few.externalQueried).toBe(true);
    expect(few.external.map((l) => l.id)).toEqual(["x1"]);
  });

  it("defaults MIN_RESEARCHED_RESULTS to 3 and honours the env override", async () => {
    const repos = createFixtureRepositories();
    const discover = vi.fn(async () => ({ listings: [], errors: [] }));
    await searchProperties({ localityId: "hebbal" }, { repos, discover }); // 2 < 3
    expect(discover).toHaveBeenCalledTimes(1);
    vi.stubEnv("MIN_RESEARCHED_RESULTS", "1");
    await searchProperties({ localityId: "hebbal" }, { repos, discover });
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("excludes external listings matched to a returned researched project", async () => {
    const repos = createFixtureRepositories();
    const discover = vi.fn(async () => ({
      listings: [listing("dup", "sample-proj-lakeview"), listing("other-match", "not-returned"), listing("free")],
      errors: [],
    }));
    const r = await searchProperties({ localityId: "hebbal" }, { repos, discover, minResearched: 10 });
    expect(r.external.map((l) => l.id)).toEqual(["other-match", "free"]);
  });

  it("uses real Lane B fixtures: RERA-matched sample listing is excluded", async () => {
    const repos = createFixtureRepositories();
    const { discoverExternalWithReport } = await import("@/discovery");
    let raw: ExternalListing[] = [];
    const discover = async (...args: Parameters<typeof discoverExternalWithReport>) => {
      const rep = await discoverExternalWithReport(...args);
      raw = rep.listings;
      return rep;
    };
    const r = await searchProperties({ localityId: "hebbal" }, { repos, discover, minResearched: 10 });
    expect(raw.some((l) => l.matchedProjectId === "sample-proj-lakeview")).toBe(true);
    expect(r.researched.map((p) => p.id)).toContain("sample-proj-lakeview");
    expect(r.external.every((l) => l.lane === "external" && l.limitations.length > 0)).toBe(true);
    expect(r.external.find((l) => l.matchedProjectId === "sample-proj-lakeview")).toBeUndefined();
  });

  it("reports discovery errors as user-safe messages without throwing", async () => {
    const repos = createFixtureRepositories();
    const discover = vi.fn(async () => ({ listings: [], errors: [{ sourceId: "sample-feed", message: "ECONNRESET at 10.0.0.1" }] }));
    const r = await searchProperties({ text: "nothing-matches-this" }, { repos, discover });
    expect(r.externalErrors).toHaveLength(1);
    expect(r.externalErrors![0]).not.toMatch(/10\.0\.0\.1/);
    const thrower = vi.fn(async () => {
      throw new Error("boom");
    });
    const r2 = await searchProperties({}, { repos, discover: thrower, minResearched: 50 });
    expect(r2.externalErrors).toEqual(["External listings are unavailable right now."]);
  });

  it("returns nothing for an unknown locality id", async () => {
    const r = await searchProperties({ localityId: "not-a-locality" }, { repos: createFixtureRepositories() });
    expect(r.researched).toEqual([]);
  });
});

describe("getComparison", () => {
  it(`rejects more than ${MAX_COMPARE} projects and empty input`, async () => {
    const repos = createFixtureRepositories();
    const ids = SAMPLE_PROJECTS.filter((p) => p.published).slice(0, 5).map((p) => p.id);
    expect(await getComparison(ids, { repos })).toMatchObject({ ok: false, error: "too_many" });
    expect(await getComparison([], { repos })).toMatchObject({ ok: false, error: "none" });
    const ok = await getComparison(ids.slice(0, 4), { repos });
    expect(ok.ok).toBe(true);
  });

  it("aligns rows to projects, keeps unknown distinct, and hides unpublished", async () => {
    const repos = createFixtureRepositories();
    const r = await getComparison(["sample-proj-lakeview", "sample-proj-orchard", "sample-proj-northwind", UNPUBLISHED.id], { repos });
    if (!r.ok) throw new Error("expected ok");
    expect(r.projects.map((p) => p.id)).toEqual(["sample-proj-lakeview", "sample-proj-orchard", "sample-proj-northwind"]);
    expect(r.missingIds).toEqual([UNPUBLISHED.id]);
    for (const row of r.rows) expect(row.cells.map((c) => c.projectId)).toEqual(r.projects.map((p) => p.id));
    const rera = r.rows.find((x) => x.key === "reraNumbers")!;
    expect(rera.cells[0]).toMatchObject({ status: "known", value: "SAMPLE-RERA-0001", verification: "unverified" });
    expect(rera.cells[1]).toMatchObject({ status: "unknown", value: null });
    const complaints = r.rows.find((x) => x.key === "complaints")!;
    expect(complaints.cells[0]).toMatchObject({ status: "known", value: expect.stringMatching(/^1 listed/) });
    expect(complaints.cells[1]).toMatchObject({ status: "unknown" }); // never searched
    expect(complaints.cells[2]).toMatchObject({ status: "known", value: expect.stringMatching(/None found .*not proof/) });
  });
});

const validLead = {
  requestType: "verification",
  name: "SAMPLE Buyer",
  email: "buyer@example.com",
  phone: "",
  preferredChannel: "email",
  message: "Please verify this SAMPLE project.",
  projectId: "sample-proj-lakeview",
  externalListingId: "",
  budgetBand: "",
  contactConsent: "on",
  consentTextVersion: CONSENT_TEXT_VERSION,
  website: "",
};

describe("submitLead", () => {
  const limiter = () => new FixedWindowRateLimiter(100, 60_000);

  it("requires contact consent and stores nothing without it", async () => {
    const repos = createFixtureRepositories();
    const noConsent: Record<string, string> = { ...validLead };
    delete noConsent.contactConsent;
    const r = await submitLead(noConsent, { ipKey: "1.1.1.1" }, { repos, limiter: limiter() });
    expect(r).toMatchObject({ ok: false, reason: "validation" });
    if (!r.ok) expect(r.errors.contactConsent).toBeDefined();
    expect(await repos.leads.list()).toEqual([]);
  });

  it("stores a consented lead as new with retention, qualification and consent version", async () => {
    const repos = createFixtureRepositories();
    const now = new Date("2026-10-21T10:00:00.000Z");
    const r = await submitLead(validLead, { ipKey: "1.1.1.1", now }, { repos, limiter: limiter() });
    expect(r.ok).toBe(true);
    const [lead] = await repos.leads.list();
    expect(lead).toMatchObject({
      status: "new",
      createdAt: now.toISOString(),
      retentionUntil: "2027-10-21T10:00:00.000Z",
      consent: { contactConsent: true, marketingConsent: false, consentTextVersion: CONSENT_TEXT_VERSION },
    });
    expect(lead.qualification?.score).toBeGreaterThan(0);
  });

  it("rejects a lead referencing an unpublished project", async () => {
    const repos = createFixtureRepositories();
    const r = await submitLead({ ...validLead, projectId: UNPUBLISHED.id }, { ipKey: "x" }, { repos, limiter: limiter() });
    expect(r).toMatchObject({ ok: false, reason: "validation", errors: { projectId: expect.any(String) } });
  });

  it("rate-limits per ip key", async () => {
    const repos = createFixtureRepositories();
    const l = new FixedWindowRateLimiter(2, 60_000);
    const ctx = { ipKey: "9.9.9.9" };
    expect((await submitLead(validLead, ctx, { repos, limiter: l })).ok).toBe(true);
    expect((await submitLead(validLead, ctx, { repos, limiter: l })).ok).toBe(true);
    expect(await submitLead(validLead, ctx, { repos, limiter: l })).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((await submitLead(validLead, { ipKey: "8.8.8.8" }, { repos, limiter: l })).ok).toBe(true);
  });

  it("never logs personal data", async () => {
    vi.stubEnv("TN_LOG_IN_TESTS", "1");
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await submitLead(validLead, { ipKey: "1.1.1.1" }, { repos: createFixtureRepositories(), limiter: limiter() });
    const out = spy.mock.calls.flat().join(" ");
    expect(out).toContain("lead.created");
    expect(out).not.toMatch(/buyer@example\.com|SAMPLE Buyer|verify this/);
    spy.mockRestore();
  });
});

describe("staff-only lead access", () => {
  it("listLeads / getLead / updateLeadStatus require a staff session", async () => {
    const repos = createFixtureRepositories();
    await expect(listLeads({}, { repos, requireStaff: noStaff })).rejects.toBeInstanceOf(StaffAuthError);
    await expect(getLead("x", { repos, requireStaff: noStaff })).rejects.toBeInstanceOf(StaffAuthError);
    await expect(updateLeadStatus("x", "contacted", { repos, requireStaff: noStaff })).rejects.toBeInstanceOf(StaffAuthError);
  });

  it("uses the real session check by default (no cookie => rejected)", async () => {
    await expect(listLeads({}, { repos: createFixtureRepositories() })).rejects.toBeInstanceOf(StaffAuthError);
  });

  it("staff can list and transition leads; invalid transitions and withdrawal erasure are enforced", async () => {
    const repos = createFixtureRepositories();
    const r = await submitLead(validLead, { ipKey: "a" }, { repos, limiter: new FixedWindowRateLimiter(10, 1000) });
    if (!r.ok) throw new Error("expected ok");
    expect(await listLeads({}, { repos, requireStaff: staff })).toHaveLength(1);
    expect(await updateLeadStatus(r.leadId, "qualified", { repos, requireStaff: staff })).toMatchObject({ ok: false, error: "invalid_transition" });
    expect(await updateLeadStatus(r.leadId, "contacted", { repos, requireStaff: staff })).toMatchObject({ ok: true });
    const w = await updateLeadStatus(r.leadId, "withdrawn", { repos, requireStaff: staff });
    if (!w.ok) throw new Error("expected ok");
    expect(w.lead).toMatchObject({ status: "withdrawn", email: null, name: "[erased]", consent: { contactConsent: false } });
    expect(w.lead.retentionUntil > w.lead.createdAt).toBe(true);
    expect(await updateLeadStatus("missing", "contacted", { repos, requireStaff: staff })).toMatchObject({ ok: false, error: "not_found" });
  });
});
