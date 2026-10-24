import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { uploadProjectDocument, getDocumentDownload } = await import("./documents");
const { createFixtureRepositories } = await import("../repositories/fixture");
const { StaffAuthError } = await import("../auth");
const { documentStoragePath, safeFileName, sniffContentType, MAX_DOCUMENT_BYTES, SupabaseDocumentStorage } = await import("../storage/documents");

const admin = async () => ({ userId: "staff-1", role: "admin" as const, mode: "fixture" as const, expiresAt: null });
const advisor = async () => ({ userId: "staff-2", role: "advisor" as const, mode: "fixture" as const, expiresAt: null });
const noStaff = async () => {
  throw new StaffAuthError("unauthenticated", "Please sign in.");
};

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");
const PROJECT = "sample-proj-lakeview";

const input = (over: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  documentKey: "site-plan",
  title: "SAMPLE site plan",
  kind: "plan",
  sourceId: "sample-feed",
  sourceUrl: "https://example.com/sample/site-plan",
  file: { name: "Site Plan (final).PDF", type: "application/pdf", bytes: PDF },
  ...over,
});

describe("document storage helpers", () => {
  it("sniffs PDF/PNG/JPEG by magic bytes and rejects anything else", () => {
    expect(sniffContentType(PDF)).toBe("application/pdf");
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffContentType(HTML)).toBeNull();
  });

  it("Supabase read() returns the bytes of a non-sniffable object with contentType null; a missing object is null", async () => {
    const objects: Record<string, Uint8Array> = { "p/k/v1/a.pdf": PDF, "p/k/v1/b.pdf": HTML };
    const db = {
      storage: {
        from: () => ({
          download: async (path: string) =>
            objects[path]
              ? { data: new Blob([objects[path] as BlobPart]), error: null }
              : { data: null, error: Object.assign(new Error("Object not found"), { statusCode: "404" }) },
        }),
      },
    };
    const storage = new SupabaseDocumentStorage(() => db as never);
    expect(await storage.read("p/k/v1/a.pdf")).toEqual({ bytes: PDF, contentType: "application/pdf" });
    expect(await storage.read("p/k/v1/b.pdf")).toEqual({ bytes: HTML, contentType: null });
    expect(await storage.read("p/k/v1/missing.pdf")).toBeNull();
  });

  it("builds safe, versioned paths", () => {
    expect(safeFileName("../../etc/passwd", "application/pdf")).toBe("passwd.pdf");
    expect(safeFileName("Site Plan (final).PDF", "application/pdf")).toBe("Site-Plan-final.pdf");
    expect(safeFileName("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
    expect(safeFileName(".htaccess", "image/png")).toBe("htaccess.png");
    expect(documentStoragePath("p1", "site-plan", 2, "a.pdf")).toBe("p1/site-plan/v2/a.pdf");
    expect(() => documentStoragePath("p1/../x", "k", 1, "a.pdf")).toThrow();
    expect(() => documentStoragePath("p1", "Bad Key", 1, "a.pdf")).toThrow();
  });
});

describe("uploadProjectDocument (fixture storage)", () => {
  it("requires a staff session", async () => {
    await expect(uploadProjectDocument(input(), { repos: createFixtureRepositories(), requireStaff: noStaff })).rejects.toBeInstanceOf(StaffAuthError);
    await expect(getDocumentDownload("x", { repos: createFixtureRepositories(), requireStaff: noStaff })).rejects.toBeInstanceOf(StaffAuthError);
  });

  it("stores versioned immutable objects, records the document and audits it", async () => {
    const repos = createFixtureRepositories();
    const v1 = await uploadProjectDocument(input(), { repos, requireStaff: advisor });
    if (!v1.ok) throw new Error(JSON.stringify(v1));
    expect(v1.document).toMatchObject({
      projectId: PROJECT, documentKey: "site-plan", version: 1, kind: "plan", contentType: "application/pdf", sizeBytes: PDF.byteLength,
      storagePath: `${PROJECT}/site-plan/v1/Site-Plan-final.pdf`,
      source: { sourceId: "sample-feed", url: "https://example.com/sample/site-plan" },
    });
    expect(v1.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    const v2 = await uploadProjectDocument(input({ file: { name: "plan.png", type: "image/png", bytes: PNG } }), { repos, requireStaff: admin });
    if (!v2.ok) throw new Error("expected ok");
    expect(v2.document.version).toBe(2);
    expect(v2.document.storagePath).toBe(`${PROJECT}/site-plan/v2/plan.png`);

    const project = await repos.research.getProjectByIdForStaff(PROJECT);
    expect(project?.documents.filter((d) => d.title === "SAMPLE site plan").map((d) => d.version)).toEqual([1, 2]);
    const audit = (await repos.research.listAudit(PROJECT)).filter((e) => e.action === "document_uploaded" && e.field === "documents").map((e) => e.note);
    expect(audit).toEqual(["document uploaded: site-plan v1 (plan)", "document uploaded: site-plan v2 (plan)"]);

    const dl = await getDocumentDownload(v1.document.id, { repos, requireStaff: advisor });
    expect(dl).toMatchObject({ kind: "bytes", contentType: "application/pdf", fileName: "Site-Plan-final.pdf" });
    if (dl?.kind === "bytes") expect([...dl.bytes]).toEqual([...PDF]);
    expect(await getDocumentDownload("missing", { repos, requireStaff: advisor })).toBeNull();
  });

  it("rejects disallowed or mislabelled content, oversize files, bad metadata and unknown sources", async () => {
    const repos = createFixtureRepositories();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ file: { name: "x.pdf", type: "application/pdf", bytes: HTML } }, /only application\/pdf/],
      [{ file: { name: "x.pdf", type: "application/pdf", bytes: PNG } }, /does not match/],
      [{ file: { name: "x.pdf", type: "application/pdf", bytes: new Uint8Array() } }, /choose a file/],
      [{ file: { name: "x.pdf", type: "application/pdf", bytes: new Uint8Array(MAX_DOCUMENT_BYTES + 1) } }, /15 MB/],
      [{ documentKey: "../etc" }, /documentKey/],
      [{ kind: "contract" }, /kind/],
      [{ sourceUrl: "http://example.com/x" }, /sourceUrl/],
      [{ sourceId: "no-such-source" }, /Unknown source/],
      // D19: a RERA certificate or a K-RERA (regulator) document needs the page it was downloaded from
      [{ kind: "rera_certificate", sourceUrl: "" }, /sourceUrl: required for K-RERA documents and RERA certificates/],
      [{ sourceId: "k-rera", sourceUrl: null }, /sourceUrl: required for K-RERA/],
      [{ title: "" }, /title/],
    ];
    for (const [i, [over, re]] of cases.entries()) {
      const r = await uploadProjectDocument(input(over), { repos, requireStaff: admin });
      expect(r.ok, `case ${i}`).toBe(false);
      if (!r.ok) expect(r.errors?.join(" "), `case ${i}`).toMatch(re);
    }
    expect((repos.documentStorage as unknown as { size: number }).size).toBe(0);
    expect(await uploadProjectDocument(input({ projectId: "nope" }), { repos, requireStaff: admin })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("a lost version race returns conflict and removes the orphaned object", async () => {
    const repos = createFixtureRepositories();
    const real = repos.research.nextDocumentVersion.bind(repos.research);
    await uploadProjectDocument(input(), { repos, requireStaff: admin });
    // stale version read (another upload won meanwhile) → storage put sees an existing object
    repos.research.nextDocumentVersion = async () => 1;
    expect(await uploadProjectDocument(input(), { repos, requireStaff: admin })).toMatchObject({ ok: false, error: "conflict" });
    // storage put succeeds at a new path but the DB says the version is taken → object removed
    repos.research.nextDocumentVersion = async (p, k) => (await real(p, k)) + 1;
    expect(await uploadProjectDocument(input(), { repos, requireStaff: admin })).toMatchObject({ ok: false, error: "conflict" });
    expect((repos.documentStorage as unknown as { size: number }).size).toBe(1);
  });

  it("L4: an error after the row committed does not delete the stored object", async () => {
    const repos = createFixtureRepositories();
    const realAdd = repos.research.addDocument.bind(repos.research);
    repos.research.addDocument = async (rec, actor) => {
      await realAdd(rec, actor); // row committed…
      throw new Error("response lost"); // …but the caller sees a failure
    };
    await expect(uploadProjectDocument(input(), { repos, requireStaff: admin })).rejects.toThrow(/response lost/);
    expect((repos.documentStorage as unknown as { size: number }).size).toBe(1);
    // a failure BEFORE any row exists still cleans up
    repos.research.addDocument = async () => {
      throw new Error("db down");
    };
    await expect(uploadProjectDocument(input(), { repos, requireStaff: admin })).rejects.toThrow(/db down/);
    expect((repos.documentStorage as unknown as { size: number }).size).toBe(1);
  });
});
