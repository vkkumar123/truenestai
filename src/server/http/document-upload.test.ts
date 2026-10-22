import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

const { handleDocumentUpload, isSameOrigin, MAX_UPLOAD_BODY_BYTES } = await import("./document-upload");
const { createFixtureRepositories } = await import("../repositories/fixture");
const { StaffAuthError } = await import("../auth");

const staff = async () => ({ userId: "staff-1", role: "admin" as const, mode: "fixture" as const, expiresAt: null });
const noStaff = async () => {
  throw new StaffAuthError("unauthenticated", "Please sign in.");
};
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function form(over: Record<string, string> = {}, file: Blob | null = new Blob([PDF], { type: "application/pdf" })) {
  const f = new FormData();
  const fields = { projectId: "sample-proj-lakeview", documentKey: "site-plan", title: "SAMPLE plan", kind: "plan", sourceId: "sample-feed", ...over };
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  if (file) f.set("file", file, "plan.pdf");
  return f;
}

async function req(body: FormData, headers: Record<string, string> = {}) {
  // Materialise the multipart body so Content-Length is known, as a browser would send it.
  const r = new Request("http://localhost:3000/api/staff/documents", { method: "POST", body });
  const bytes = new Uint8Array(await r.arrayBuffer());
  return new Request("http://localhost:3000/api/staff/documents", {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": r.headers.get("content-type")!,
      "content-length": String(bytes.byteLength),
      host: "localhost:3000",
      origin: "http://localhost:3000",
      ...headers,
    },
  });
}

describe("POST /api/staff/documents handler", () => {
  it("checks same origin", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(isSameOrigin(h({ host: "a.example.com", origin: "https://a.example.com" }))).toBe(true);
    expect(isSameOrigin(h({ host: "a.example.com", origin: "https://evil.example.com" }))).toBe(false);
    expect(isSameOrigin(h({ host: "a.example.com" }))).toBe(false);
    expect(isSameOrigin(h({ host: "a.example.com", origin: "null" }))).toBe(false);
    expect(isSameOrigin(h({ host: "internal:8080", "x-forwarded-host": "a.example.com", origin: "https://a.example.com" }))).toBe(true);
  });

  it("uploads for staff and returns JSON with the new version", async () => {
    const repos = createFixtureRepositories();
    const onUploaded = vi.fn();
    const r1 = await handleDocumentUpload(await req(form()), { repos, requireStaff: staff, onUploaded });
    expect(r1.status).toBe(201);
    expect(await r1.json()).toMatchObject({ ok: true, projectId: "sample-proj-lakeview", version: 1, documentId: expect.any(String) });
    const r2 = await handleDocumentUpload(await req(form()), { repos, requireStaff: staff });
    expect(await r2.json()).toMatchObject({ ok: true, version: 2 });
    expect(onUploaded).toHaveBeenCalledWith("sample-proj-lakeview");
    expect(r1.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("refuses cross-origin before checking the session, and unauthenticated before parsing", async () => {
    const auth = vi.fn(staff);
    const x = await handleDocumentUpload(await req(form(), { origin: "https://evil.example.com" }), { requireStaff: auth });
    expect(x.status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
    const r = new Request("http://localhost:3000/api/staff/documents", {
      method: "POST", body: "not multipart", headers: { host: "localhost:3000", origin: "http://localhost:3000" },
    });
    const spy = vi.spyOn(r, "formData");
    const u = await handleDocumentUpload(r, { requireStaff: noStaff });
    expect(u.status).toBe(401);
    expect(await u.json()).toMatchObject({ ok: false, error: "unauthenticated" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects oversize or unknown-length bodies before parsing", async () => {
    const big = new Request("http://localhost:3000/api/staff/documents", {
      method: "POST", body: "x",
      headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_UPLOAD_BODY_BYTES + 1) },
    });
    const spy = vi.spyOn(big, "formData");
    const r = await handleDocumentUpload(big, { requireStaff: staff });
    expect(r.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
    const noLen = new Request("http://localhost:3000/api/staff/documents", {
      method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "multipart/form-data; boundary=x" },
    });
    expect((await handleDocumentUpload(noLen, { requireStaff: staff })).status).toBe(411);
  });

  it("maps validation and not-found errors to JSON", async () => {
    const repos = createFixtureRepositories();
    const html = new Blob(["<html></html>"], { type: "application/pdf" });
    const v = await handleDocumentUpload(await req(form({}, html)), { repos, requireStaff: staff });
    expect(v.status).toBe(422);
    expect(await v.json()).toMatchObject({ ok: false, error: "validation", errors: [expect.stringMatching(/only application\/pdf/)] });
    const nf = await handleDocumentUpload(await req(form({ projectId: "nope" })), { repos, requireStaff: staff });
    expect(nf.status).toBe(404);
  });
});
