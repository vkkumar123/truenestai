// M2: lead assignment (admin assigns, advisor sees only assigned leads and cannot reassign) and
// staff document upload/download over real HTTP (POST/GET /api/staff/documents), plus the
// browser upload form on /admin/projects/[id]. Fixture mode, in-memory storage.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PROJECT_LAKEVIEW, staffContext, applyStaffSession, type StaffRoleName } from "./support";

const STAMP = Date.now().toString(36);
const ORIGIN = "http://localhost:3200";
const DOC_PROJECT_ID = "sample-proj-hennur"; // not asserted on by other specs
const PDF = Buffer.from("%PDF-1.7\nSAMPLE fictional e2e document v1\n%%EOF\n");
const PDF_V2 = Buffer.from("%PDF-1.7\nSAMPLE fictional e2e document v2 (longer)\n%%EOF\n");

/** Reuses the session saved by auth.setup.ts (the sign-in form is throttled). */
async function signIn(page: Page, role: StaffRoleName) {
  await applyStaffSession(page, role);
  await page.goto("/admin/leads");
  await expect(page.getByRole("navigation", { name: "Staff" })).toBeVisible();
}

function uploadFields(documentKey: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  return {
    projectId: DOC_PROJECT_ID,
    documentKey,
    title: `SAMPLE e2e document ${STAMP}`,
    kind: "plan",
    documentDate: "2026-09-01",
    sourceId: "sample-feed",
    sourceUrl: "https://example.com/sample/e2e-doc",
    file,
  };
}

const upload = (request: APIRequestContext, documentKey: string, file = { name: "plan.pdf", mimeType: "application/pdf", buffer: PDF }, headers: Record<string, string> = { Origin: ORIGIN }) =>
  request.post("/api/staff/documents", { multipart: uploadFields(documentKey, file), headers, maxRedirects: 0 });

// ---------------------------------------------------------------------------
// Lead assignment
// ---------------------------------------------------------------------------
test.describe.serial("M2 lead assignment", () => {
  const LEAD_NAME = `E2E Assign ${STAMP}`;

  test("a buyer submits a lead; an unassigned advisor does not see it", async ({ page, browser }) => {
    await page.goto(`/request?project=${PROJECT_LAKEVIEW.id}&type=buyer_assistance`);
    await page.getByLabel("Your name").fill(LEAD_NAME);
    await page.getByLabel("Email", { exact: true }).fill(`assign-${STAMP}@example.com`);
    await page.getByLabel(/how should we contact you/i).selectOption("email");
    await page.getByRole("checkbox", { name: /agree that TrueNest may contact me/i }).check();
    await page.getByRole("button", { name: /send request/i }).click();
    await expect(page.getByRole("status").getByText(/your request has been received/i)).toBeVisible();

    const advisor = await staffContext(browser, "advisor");
    await advisor.page.goto("/admin/leads");
    await expect(advisor.page.getByText(LEAD_NAME)).toHaveCount(0);
    // Other specs never assign to the advisor, so the advisor's queue starts empty.
    await expect(advisor.page.getByText("No leads assigned to you yet")).toBeVisible();
    await expect(advisor.page.getByLabel("Assign to")).toHaveCount(0);
    await advisor.context.close();
  });

  test("admin assigns the lead to the advisor; the advisor then sees it and cannot reassign", async ({ browser }) => {
    const admin = await staffContext(browser, "admin");
    await admin.page.goto("/admin/leads");
    const row = admin.page.getByRole("row").filter({ hasText: LEAD_NAME });
    await expect(row).toHaveCount(1);
    const assign = row.getByLabel("Assign to");
    await expect(assign).toHaveValue("");
    await assign.selectOption({ label: "Dev advisor (fixture) (advisor)" });
    await row.getByRole("button", { name: "Assign" }).click();
    await expect(row.locator("[aria-live=polite]").filter({ hasText: /\S/ }).first()).toBeVisible();
    await admin.page.reload();
    await expect(admin.page.getByRole("row").filter({ hasText: LEAD_NAME }).getByLabel("Assign to")).toHaveValue("fixture-dev-advisor");
    await admin.context.close();

    const advisor = await staffContext(browser, "advisor");
    await advisor.page.goto("/admin/leads");
    const mine = advisor.page.getByRole("row").filter({ hasText: LEAD_NAME });
    await expect(mine).toHaveCount(1);
    await expect(mine.getByRole("cell").nth(6)).toHaveText("You");
    await expect(advisor.page.getByLabel("Assign to")).toHaveCount(0);
    await expect(advisor.page.getByRole("button", { name: "Assign" })).toHaveCount(0);
    await expect(advisor.page.getByText("No leads assigned to you yet")).toHaveCount(0);
    // The advisor can work the lead they were given.
    await mine.getByLabel("New status").selectOption("contacted");
    await mine.getByRole("button", { name: "Update" }).click();
    await expect(mine.getByText("Status updated.")).toBeVisible();
    await advisor.context.close();
  });
});

// ---------------------------------------------------------------------------
// Document upload / download over HTTP
// ---------------------------------------------------------------------------
test.describe("M2 document upload API", () => {
  test("401 without a session for upload and download", async ({ playwright }) => {
    const anon = await playwright.request.newContext({ baseURL: ORIGIN });
    const r = await upload(anon, `anon-${STAMP}`);
    expect(r.status()).toBe(401);
    expect(await r.json()).toMatchObject({ ok: false, error: "unauthenticated" });
    const d = await anon.get("/api/staff/documents/any-document-id", { maxRedirects: 0 });
    expect(d.status()).toBe(401);
    await anon.dispose();
  });

  test("cross-origin and missing Origin are refused even with a staff session", async ({ page }) => {
    await signIn(page, "admin");
    const cases: Record<string, string>[] = [{ Origin: "https://evil.example.com" }, {}];
    for (const headers of cases) {
      const r = await upload(page.request, `xorigin-${STAMP}`, undefined, headers);
      expect(r.status(), JSON.stringify(headers)).toBe(403);
      expect(await r.json()).toMatchObject({ ok: false, error: "cross_origin" });
    }
  });

  test("a body over 15 MB + 64 KB is refused with 413", async ({ page }) => {
    await signIn(page, "admin");
    const big = Buffer.alloc(15 * 1024 * 1024 + 64 * 1024 + 1, 0x41);
    big.write("%PDF-1.7\n", 0);
    const r = await upload(page.request, `big-${STAMP}`, { name: "big.pdf", mimeType: "application/pdf", buffer: big });
    expect(r.status()).toBe(413);
    expect(await r.json()).toMatchObject({ ok: false, error: "too_large" });
  });

  test("a wrong file type, a mislabelled file and an empty file are refused with 422", async ({ page }) => {
    await signIn(page, "admin");
    const files = [
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("SAMPLE plain text") },
      { name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("SAMPLE not really a pdf") },
      { name: "empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) },
    ];
    for (const file of files) {
      const r = await upload(page.request, `bad-${STAMP}`, file);
      expect(r.status(), file.name).toBe(422);
      expect(await r.json()).toMatchObject({ ok: false, error: "validation" });
    }
  });

  test("same documentKey gives version 1 then 2 (advisor may upload too); downloads return identical bytes", async ({ page, browser }) => {
    await signIn(page, "admin");
    const key = `versioned-${STAMP}`;
    const r1 = await upload(page.request, key);
    expect(r1.status()).toBe(201);
    const b1 = await r1.json();
    expect(b1).toMatchObject({ ok: true, projectId: DOC_PROJECT_ID, version: 1 });

    // Per src/server/services/documents.ts any staff role may upload: the advisor adds v2.
    const advisor = await staffContext(browser, "advisor");
    const r2 = await upload(advisor.page.request, key, { name: "plan-v2.pdf", mimeType: "application/pdf", buffer: PDF_V2 });
    expect(r2.status()).toBe(201);
    const b2 = await r2.json();
    expect(b2).toMatchObject({ ok: true, version: 2 });
    expect(b2.documentId).not.toBe(b1.documentId);
    await advisor.context.close();

    for (const [id, bytes] of [[b1.documentId, PDF], [b2.documentId, PDF_V2]] as const) {
      const d = await page.request.get(`/api/staff/documents/${encodeURIComponent(id)}`, { maxRedirects: 0 });
      expect(d.status()).toBe(200);
      expect(d.headers()["content-type"]).toBe("application/pdf");
      expect(d.headers()["cache-control"]).toMatch(/no-store/);
      expect(d.headers()["content-disposition"]).toMatch(/^attachment;/);
      expect(Buffer.compare(await d.body(), bytes)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Browser upload form (document-upload-form.tsx uses fetch)
// ---------------------------------------------------------------------------
test.describe("M2 document upload form", () => {
  test("uploads from /admin/projects/[id], lists the version and downloads the same bytes", async ({ page }) => {
    await signIn(page, "admin");
    await page.goto(`/admin/projects/${PROJECT_LAKEVIEW.id}`);
    const docs = page.getByRole("region", { name: "Documents" });
    await docs.getByText("Upload a document or new version").click();

    const title = `SAMPLE e2e form upload ${STAMP}`;
    // Client-side check first: an empty submission is caught before any request.
    await docs.getByRole("button", { name: "Upload document" }).click();
    await expect(docs.getByLabel("Title")).toBeFocused(); // native `required` blocks submit

    await docs.getByLabel("Title").fill(title);
    await docs.getByLabel("Document key").fill(`form-upload-${STAMP}`);
    await docs.getByLabel("Kind").selectOption("brochure");
    await docs.getByLabel("Source", { exact: true }).selectOption("sample-feed");
    await docs.getByLabel(/^File/).setInputFiles({ name: "brochure.pdf", mimeType: "application/pdf", buffer: PDF });
    const posted = page.waitForResponse((r) => r.url().endsWith("/api/staff/documents") && r.request().method() === "POST");
    await docs.getByRole("button", { name: "Upload document" }).click();
    expect((await posted).status()).toBe(201);
    await expect(docs.getByRole("status").filter({ hasText: "Document uploaded (version 1)." })).toBeVisible();

    // router.refresh() lists the new document with a staff-only download link.
    const item = docs.getByRole("listitem").filter({ hasText: title }).first();
    await expect(item.getByText("Version 1", { exact: true })).toBeVisible();
    const link = item.getByRole("link", { name: new RegExp(`Download version 1 of ${title}`) });
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/api\/staff\/documents\//);
    const d = await page.request.get(href!);
    expect(d.status()).toBe(200);
    expect(Buffer.compare(await d.body(), PDF)).toBe(0);

    // A non-PDF/PNG/JPEG file is refused client-side with a message.
    await docs.getByLabel(/^File/).setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("SAMPLE") });
    await docs.getByLabel("Title").fill(title);
    await docs.getByLabel("Document key").fill(`form-upload-${STAMP}`);
    await docs.getByLabel("Source", { exact: true }).selectOption("sample-feed");
    await docs.getByRole("button", { name: "Upload document" }).click();
    await expect(docs.getByRole("alert").filter({ hasText: "Only PDF, PNG or JPEG files can be uploaded." })).toBeVisible();
  });
});
