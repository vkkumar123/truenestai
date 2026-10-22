// J5 request · J6 consent-aware lead capture · J7 protected admin
// Serial: the admin journey reads the lead submitted earlier (in-memory fixture store, one dev server).
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_DEV_PASSWORD, LANE_B_LOCALITY, applyStaffSession, LANE_B_TITLE, PROJECT_LAKEVIEW } from "./support";

test.describe.configure({ mode: "serial" });

const BUYER_NAME = `E2E Buyer ${Date.now().toString(36)}`;
const BUYER_EMAIL = "e2e.buyer@example.com";
const VERIFY_NAME = `E2E Verifier ${Date.now().toString(36)}`;
const SAMPLE_PHONE = "6000000001"; // obviously fictional SAMPLE number

/** Reuses the admin session saved by auth.setup.ts (the sign-in form is throttled). */
async function signIn(page: Page) {
  await applyStaffSession(page, "admin");
  await page.goto("/admin/leads");
  await expect(page.getByRole("heading", { name: /buyer requests/i })).toBeVisible();
}

const leadRow = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });
const statusCell = (page: Page, name: string) => leadRow(page, name).getByRole("cell").nth(4);

async function fillRequestForm(page: Page) {
  await page.getByLabel("Your name").fill(BUYER_NAME);
  await page.getByLabel("Email", { exact: true }).fill(BUYER_EMAIL);
  await page.getByLabel(/how should we contact you/i).selectOption("email");
}

const submitButton = (page: Page) => page.getByRole("button", { name: /send request/i });
const contactConsent = (page: Page) => page.getByRole("checkbox", { name: /agree that TrueNest may contact me/i });
const marketingConsent = (page: Page) => page.getByRole("checkbox", { name: /occasional updates/i });

test.describe("J5/J6 request form", () => {
  test("cannot submit without contact consent; marketing consent is unticked by default", async ({ page }) => {
    await page.goto(`/request?project=${PROJECT_LAKEVIEW.id}&type=buyer_assistance`);
    await expect(page.getByText(PROJECT_LAKEVIEW.name).first()).toBeVisible();
    await expect(page.getByRole("radio", { name: /help me find a home/i })).toBeChecked();
    await fillRequestForm(page);
    await expect(contactConsent(page)).not.toBeChecked();
    await expect(marketingConsent(page)).not.toBeChecked();
    await submitButton(page).click();
    // The form is noValidate: the server rejects the submission and explains why.
    await expect(page.getByText(/please agree to be contacted/i).first()).toBeVisible();
    await expect(contactConsent(page)).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/request/);
    await expect(page.getByText(/what happens next/i)).toHaveCount(0);
    // Entered values survive the failed submit.
    await expect(page.getByLabel("Your name")).toHaveValue(BUYER_NAME);
  });

  test("submits with consent and shows what happens next and how to withdraw", async ({ page }) => {
    await page.goto(`/request?project=${PROJECT_LAKEVIEW.id}&type=buyer_assistance`);
    await fillRequestForm(page);
    await contactConsent(page).check();
    await submitButton(page).click();
    const confirmation = page.getByRole("status");
    await expect(confirmation.getByText(/your request has been received/i)).toBeVisible();
    await expect(confirmation.getByText(/what happens next/i)).toBeVisible();
    await expect(confirmation.getByText(/stop contacting you or delete your request/i)).toBeVisible();
  });
});

test.describe("J4/J5 Lane B verification request", () => {
  test("Request verification from a Lane B card submits a verification lead", async ({ page }) => {
    await page.goto(`/projects?locality=${LANE_B_LOCALITY}&lane=external`);
    await page.getByRole("link", { name: /request verification of SAMPLE Riverbend Homes/i }).click();
    await expect(page).toHaveURL(/\/request\?listing=.+type=verification/);
    await expect(page.getByRole("radio", { name: /verify a property/i })).toBeChecked();
    await page.getByLabel("Your name").fill(VERIFY_NAME);
    await page.getByLabel(/mobile number/i).fill(SAMPLE_PHONE);
    await page.getByLabel(/how should we contact you/i).selectOption("whatsapp");
    await contactConsent(page).check();
    await submitButton(page).click();
    await expect(page.getByRole("status").getByText(/your request has been received/i)).toBeVisible();
  });
});

test.describe("J7 admin", () => {
  test("/admin/leads without a session is a 307 to /admin/login and exposes no lead data", async ({ page }) => {
    const raw = await page.request.get("/admin/leads", { maxRedirects: 0 });
    expect(raw.status()).toBe(307);
    expect(raw.headers()["location"]).toMatch(/\/admin\/login\?next=%2Fadmin%2Fleads$/);
    const body = await raw.text();
    expect(body).not.toContain(BUYER_NAME);
    expect(body).not.toContain(BUYER_EMAIL);
    await page.goto("/admin/leads");
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByRole("heading", { name: /staff sign-in/i })).toBeVisible();
    await expect(page.getByText(BUYER_NAME)).toHaveCount(0);
  });

  test("a wrong password is rejected", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel(/password/i).fill("definitely-not-the-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("alert").filter({ hasText: /incorrect sign-in details/i })).toBeVisible();
    await page.goto("/admin/leads");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("the dev password signs in and the submitted lead is listed", async ({ page }) => {
    // Real form sign-in (most other staff tests reuse the session from auth.setup.ts).
    await page.goto("/admin/login");
    await page.getByLabel(/password/i).fill(E2E_ADMIN_DEV_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/admin\/leads/);
    await expect(page.getByRole("heading", { name: /buyer requests/i })).toBeVisible();
    await expect(page.getByText(BUYER_NAME).first()).toBeVisible();
    // Admin pages must not be indexed.
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots ?? "").toMatch(/noindex/i);
  });

  test("changing a lead's status persists across a reload", async ({ page }) => {
    await signIn(page);
    await expect(statusCell(page, BUYER_NAME)).toHaveText("New");
    const row = leadRow(page, BUYER_NAME);
    await row.getByLabel("New status").selectOption("contacted");
    await row.getByRole("button", { name: "Update" }).click();
    await expect(row.getByText("Status updated.")).toBeVisible();
    await page.reload();
    await expect(statusCell(page, BUYER_NAME)).toHaveText("Contacted");
    await page.getByRole("navigation", { name: "Status" }).getByRole("link", { name: "Contacted" }).click();
    await expect(page).toHaveURL(/status=contacted/);
    await expect(leadRow(page, BUYER_NAME)).toHaveCount(1);
  });

  test("request-type filter shows the Lane B lead with its subject labelled not verified", async ({ page }) => {
    await signIn(page);
    await page.getByRole("navigation", { name: "Request type" }).getByRole("link", { name: "Verify a property" }).click();
    await expect(page).toHaveURL(/requestType=verification/);
    const row = leadRow(page, VERIFY_NAME);
    await expect(row).toHaveCount(1);
    await expect(row.getByText(LANE_B_TITLE)).toBeVisible();
    await expect(row.getByText(/not verified by TrueNest/i)).toBeVisible();
    await expect(row.getByText(/Source: SAMPLE Feed/)).toBeVisible();
    await expect(row.getByText("+916000000001")).toBeVisible();
    // The buyer-assistance lead is filtered out.
    await expect(leadRow(page, BUYER_NAME)).toHaveCount(0);
  });
});
