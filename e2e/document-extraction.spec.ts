// S3a K-RERA document extraction (D21), fixture mode: a staff member uploads the fictional SAMPLE
// registration PDF with source K-RERA, runs "Extract details", and sees the extracted values with
// page numbers, excerpts, the "Unverified — needs review" label, the limitation notice and a
// conflict marker. An image upload comes back as unsupported. The fake extraction client never
// touches the network. Nothing here is promoted (no curated fact or public page changes).
import { expect, test, type Page } from "@playwright/test";
import { buildSampleReraPdf } from "../src/research/extraction/pdf";
import { PROJECT_NORTHWIND, applyStaffSession } from "./support";

const STAMP = Date.now().toString(36);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function uploadDocument(page: Page, title: string, key: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  const docs = page.getByRole("region", { name: "Documents" });
  await docs.getByText("Upload a document or new version").click();
  await expect(docs.getByLabel(/^Source URL \(https; required for K-RERA documents and RERA certificates\)/)).toBeVisible();
  await docs.getByLabel("Title").fill(title);
  await docs.getByLabel("Document key").fill(key);
  await docs.getByLabel("Kind").selectOption("rera_certificate");
  await docs.getByLabel("Source", { exact: true }).selectOption("k-rera");
  await docs.getByLabel(/^Source URL/).fill("https://example.org/sample-rera/northwind-certificate");
  await docs.getByLabel(/^File/).setInputFiles(file);
  await docs.getByRole("button", { name: "Upload document" }).click();
  await expect(docs.getByRole("status").filter({ hasText: "Document uploaded (version 1)." })).toBeVisible();
  const item = docs.getByRole("listitem").filter({ hasText: title }).first();
  await expect(item.getByText("Version 1", { exact: true })).toBeVisible();
  return item;
}

test.describe("S3a K-RERA document extraction (admin)", () => {
  test("staff upload the SAMPLE PDF, run extraction and see values with page numbers, unverified", async ({ page }) => {
    await applyStaffSession(page, "admin");
    await page.goto(`/admin/projects/${PROJECT_NORTHWIND.id}`);
    await expect(page.getByText(/never\s+accesses K-RERA automatically/)).toBeVisible();

    const title = `SAMPLE e2e RERA certificate ${STAMP}`;
    const item = await uploadDocument(page, title, `rera-cert-${STAMP}`, {
      name: "sample-rera-certificate.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(buildSampleReraPdf()),
    });

    await item.getByRole("button", { name: `Extract details from version 1 of ${title}` }).click();
    const results = item.getByTestId("extraction-results");
    await expect(results).toBeVisible({ timeout: 60_000 });
    await expect(results.getByText("AI-extracted from the uploaded document, not verified by TrueNest", { exact: false })).toBeVisible();
    await expect(results.getByText(/RERA registration is not title clearance/)).toBeVisible();
    await expect(results.getByText(/11 value\(s\) kept; 3 dropped/)).toBeVisible();

    const table = results.getByRole("region", { name: `Extracted details from version 1 of ${title}` });
    const row = (label: string) => table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });
    await expect(row("RERA registration number")).toContainText("SAMPLE/RERA/0042/2026");
    await expect(row("RERA registration number").getByTestId("page")).toHaveText("p. 1");
    await expect(row("Number of units")).toContainText("240");
    await expect(row("Number of units").getByTestId("page")).toHaveText("p. 2");
    await expect(row("Completion date declared to RERA")).toContainText("2028-12-31");
    await expect(row("Completion date declared to RERA")).toContainText("Proposed Date of Completion: 31-12-2028");
    await expect(row("Promoter (company)")).toContainText("SAMPLE Fictional Developers Pvt Ltd");
    await expect(table.getByText("Unverified — needs review")).toHaveCount(11);
    // the curated SAMPLE RERA number of this project disagrees: shown, not hidden
    await expect(row("RERA registration number").getByTestId("conflict")).toContainText("SAMPLE-RERA-0002");
    // the person named on the SAMPLE page is never shown or stored
    await expect(results).not.toContainText("Example Person");
    await expect(results).not.toContainText("9000000000");

    // final: no second "Extract details" button for this version; the audit trail records the run
    await expect(item.getByRole("button", { name: /Extract details/ })).toHaveCount(0);
    const history = page.getByRole("region", { name: "Change history" });
    await expect(history.getByText(`document extraction succeeded: ${title} v1, 11 value(s) kept, 3 dropped`)).toBeVisible();
  });

  test("an image upload is shown as unsupported (no OCR)", async ({ page }) => {
    await applyStaffSession(page, "admin");
    await page.goto(`/admin/projects/${PROJECT_NORTHWIND.id}`);
    const title = `SAMPLE e2e scanned page ${STAMP}`;
    const item = await uploadDocument(page, title, `scan-${STAMP}`, { name: "scan.png", mimeType: "image/png", buffer: PNG });
    await item.getByRole("button", { name: `Extract details from version 1 of ${title}` }).click();
    await expect(item.getByTestId("extraction-unsupported")).toContainText("Only PDF documents can be extracted");
    await expect(item.getByTestId("extraction-results")).toHaveCount(0);
  });
});
