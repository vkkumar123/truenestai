import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { extractDocument, getDocumentExtractionViews, EXTRACTION_MAX_PAGES } = await import("./document-extraction");
const { uploadProjectDocument } = await import("./documents");
const { updateFact } = await import("./research");
const { createFixtureRepositories } = await import("../repositories/fixture");
const { FACT_ATTRIBUTES } = await import("../repositories/fact-store");
const { StaffAuthError } = await import("../auth");
const { buildSamplePdf, buildSampleReraPdf, EXTRACTION_ATTRIBUTES, ExtractionClientError, FakeExtractionClient, fakeExtractionResult, sampleExtractionResponder } =
  await import("@/research/extraction");

// Every document here is the fictional SAMPLE PDF; every project is a SAMPLE project.
const admin = async () => ({ userId: "staff-1", role: "admin" as const, mode: "fixture" as const, expiresAt: null });
const bot = async () => ({ userId: "ai", role: "admin" as const, mode: "fixture" as const, expiresAt: null });
const noStaff = async () => {
  throw new StaffAuthError("unauthenticated", "Please sign in.");
};
const PROJECT = "sample-proj-lakeview";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

async function setup(over: { sourceId?: string; bytes?: Uint8Array; type?: string; name?: string; sourceUrl?: string | null } = {}) {
  const repos = createFixtureRepositories();
  const up = await uploadProjectDocument(
    {
      projectId: PROJECT,
      documentKey: "rera-certificate",
      title: "SAMPLE registration certificate",
      kind: "rera_certificate",
      sourceId: over.sourceId ?? "k-rera",
      sourceUrl: over.sourceUrl === undefined ? "https://example.org/sample-rera/certificate" : over.sourceUrl,
      file: { name: over.name ?? "sample-rera-certificate.pdf", type: over.type ?? "application/pdf", bytes: over.bytes ?? buildSampleReraPdf() },
    },
    { repos, requireStaff: admin },
  );
  if (!up.ok) throw new Error(up.message);
  return { repos, doc: up.document };
}

describe("extractDocument (fixture repositories + fake client)", () => {
  it("catalogue kinds of the requested attributes match fact_attributes", () => {
    for (const a of EXTRACTION_ATTRIBUTES) {
      const f = FACT_ATTRIBUTES.find((x) => x.entityType === "project" && x.attribute === a.attribute);
      expect(f, a.attribute).toBeDefined();
      expect(f!.valueKind).toBe(a.kind);
    }
  });

  it("requires a staff session and refuses automated actors", async () => {
    const { repos, doc } = await setup();
    await expect(extractDocument(doc.id, { repos, requireStaff: noStaff })).rejects.toBeInstanceOf(StaffAuthError);
    expect(await extractDocument(doc.id, { repos, requireStaff: bot })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await extractDocument("missing", { repos, requireStaff: admin })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("stores only cited verbatim values as unverified official rera observations with page + excerpt; audited", async () => {
    const { repos, doc } = await setup();
    const client = new FakeExtractionClient();
    const r = await extractDocument(doc.id, { repos, requireStaff: admin, client });
    expect(r).toMatchObject({ ok: true, outcome: "succeeded", extraction: { status: "succeeded", keptCount: 11, droppedCount: 3 } });
    if (!r.ok) throw new Error();
    expect(r.extraction.droppedReasons).toEqual({ not_cited: 1, not_verbatim: 1, personal_data: 1 });
    const obs = await repos.documentExtractions.listObservationsForProject(PROJECT);
    expect(obs).toHaveLength(11);
    for (const o of obs) {
      expect(o).toMatchObject({ documentId: doc.id, truthStatus: "official", sourceType: "rera", verification: "unverified" });
      expect(o.pageNumber).toBeGreaterThanOrEqual(1);
      expect(o.excerpt.split(" ").length).toBeLessThanOrEqual(20);
    }
    expect(obs.find((o) => o.attribute === "total_units")).toMatchObject({ valueNum: 240, pageNumber: 2 });
    expect(JSON.stringify(obs)).not.toMatch(/Example Person|9000000000/);
    const audit = await repos.research.listAudit(PROJECT);
    expect(audit.filter((e) => e.action === "document_extracted").map((e) => e.note)).toEqual([
      "document extraction succeeded: SAMPLE registration certificate v1, 11 value(s) kept, 3 dropped",
    ]);
    // facts_current now sees the K-RERA values; the curated SAMPLE RERA number disagrees and both are shown
    const rera = await repos.factStore.getCurrent("project", PROJECT, "rera_numbers");
    expect(rera).toMatchObject({ sourceType: "rera", addedBy: "extraction", hasDisagreement: true });
    expect(rera!.fact.conflicts).toHaveLength(1);
  });

  it("is idempotent per document version: a second run returns the stored result without calling the model", async () => {
    const { repos, doc } = await setup();
    const client = new FakeExtractionClient();
    await extractDocument(doc.id, { repos, requireStaff: admin, client });
    const again = await extractDocument(doc.id, { repos, requireStaff: admin, client });
    expect(again).toMatchObject({ ok: true, outcome: "already_done", extraction: { keptCount: 11, attempts: 1 } });
    expect(client.calls).toHaveLength(1);
    expect(await repos.documentExtractions.listObservationsForProject(PROJECT)).toHaveLength(11);
  });

  it("images, non-regulator sources and oversized page counts are unsupported (final, no model call)", async () => {
    const client = new FakeExtractionClient();
    const img = await setup({ bytes: PNG, type: "image/png", name: "scan.png" });
    expect(await extractDocument(img.doc.id, { repos: img.repos, requireStaff: admin, client })).toMatchObject({
      outcome: "unsupported", extraction: { status: "unsupported", errorCode: "not_pdf" },
    });
    const brochure = await setup({ sourceId: "anthropic-web-search" });
    expect(await extractDocument(brochure.doc.id, { repos: brochure.repos, requireStaff: admin, client })).toMatchObject({
      outcome: "unsupported", extraction: { errorCode: "source_not_supported" },
    });
    const big = await setup({ bytes: buildSamplePdf(Array.from({ length: EXTRACTION_MAX_PAGES + 1 }, () => ["SAMPLE - FICTIONAL page"])) });
    expect(await extractDocument(big.doc.id, { repos: big.repos, requireStaff: admin, client })).toMatchObject({
      outcome: "unsupported", extraction: { errorCode: "too_many_pages" },
    });
    expect(client.calls).toHaveLength(0);
    // final: a second request does not re-run it
    expect(await extractDocument(img.doc.id, { repos: img.repos, requireStaff: admin, client })).toMatchObject({ outcome: "already_done" });
  });

  it("a SAMPLE fixture-source document is extracted with source_type fixture", async () => {
    const { repos, doc } = await setup({ sourceId: "sample-feed" });
    await extractDocument(doc.id, { repos, requireStaff: admin, client: new FakeExtractionClient() });
    const obs = await repos.documentExtractions.listObservationsForProject(PROJECT);
    expect(new Set(obs.map((o) => o.sourceType))).toEqual(new Set(["fixture"]));
  });

  it("a timeout or API error fails the extraction (audited, nothing stored); staff can retry", async () => {
    const { repos, doc } = await setup();
    const slow = new FakeExtractionClient(async (req) => {
      await new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));
      return fakeExtractionResult([]);
    });
    const r = await extractDocument(doc.id, { repos, requireStaff: admin, client: slow, timeoutMs: 20 });
    expect(r).toMatchObject({ outcome: "failed", extraction: { status: "failed", errorCode: "timeout", keptCount: 0 } });
    const broken = new FakeExtractionClient(() => {
      throw new ExtractionClientError("rate_limited");
    });
    expect(await extractDocument(doc.id, { repos, requireStaff: admin, client: broken })).toMatchObject({ outcome: "failed", extraction: { errorCode: "rate_limited", attempts: 2 } });
    expect(await repos.documentExtractions.listObservationsForProject(PROJECT)).toEqual([]);
    const ok = await extractDocument(doc.id, { repos, requireStaff: admin, client: new FakeExtractionClient(sampleExtractionResponder) });
    expect(ok).toMatchObject({ outcome: "succeeded", extraction: { attempts: 3, keptCount: 11 } });
    const notes = (await repos.research.listAudit(PROJECT)).filter((e) => e.action === "document_extracted").map((e) => e.note);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toMatch(/failed.*\(timeout\)$/);
  });

  it("a refusal fails the extraction", async () => {
    const { repos, doc } = await setup();
    const refusing = new FakeExtractionClient(() => fakeExtractionResult([], "refusal"));
    expect(await extractDocument(doc.id, { repos, requireStaff: admin, client: refusing })).toMatchObject({ extraction: { errorCode: "refused" } });
  });

  it("the admin view lists values per document with page, excerpt, conflict and promotion via the audited edit", async () => {
    const { repos, doc } = await setup();
    await extractDocument(doc.id, { repos, requireStaff: admin, client: new FakeExtractionClient() });
    const views = await getDocumentExtractionViews(PROJECT, { repos, requireStaff: admin });
    const v = views[doc.id];
    expect(v.extraction?.status).toBe("succeeded");
    const rera = v.values.find((x) => x.attribute === "rera_numbers")!;
    expect(rera).toMatchObject({ display: "SAMPLE/RERA/0042/2026", pageNumber: 1, verification: "unverified" });
    expect(rera.conflict).toMatchObject({ winner: "this" });
    expect(rera.promote).toMatchObject({ field: "reraNumbers", values: ["SAMPLE/RERA/0042/2026"], source: { sourceId: "k-rera", url: "https://example.org/sample-rera/certificate" } });
    expect(v.values.find((x) => x.attribute === "total_units")).toMatchObject({ promote: null, promoteBlocked: null });
    // promotion goes through the existing audited edit and is saved UNVERIFIED
    const saved = await updateFact(
      { projectId: PROJECT, field: rera.promote!.field, status: "known", value: rera.promote!.values, sources: [{ ...rera.promote!.source, documentDate: undefined }] },
      { repos, requireStaff: admin },
    );
    expect(saved).toMatchObject({ ok: true });
    if (!saved.ok) throw new Error();
    expect(saved.project.reraNumbers).toMatchObject({ value: ["SAMPLE/RERA/0042/2026"], verification: "unverified" });
    // no document URL → no promotion offered, with the reason
    const noUrl = await setup({ sourceUrl: null });
    await extractDocument(noUrl.doc.id, { repos: noUrl.repos, requireStaff: admin, client: new FakeExtractionClient() });
    const address = (await getDocumentExtractionViews(PROJECT, { repos: noUrl.repos, requireStaff: admin }))[noUrl.doc.id].values.find((x) => x.attribute === "address")!;
    expect(address.promote).toBeNull();
    expect(address.promoteBlocked).toMatch(/source URL/);
  });
});
