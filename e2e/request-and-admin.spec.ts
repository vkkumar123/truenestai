// J5 request · J6 consent-aware lead capture · J7 protected admin
// Serial: the admin journey reads the lead submitted earlier (in-memory fixture store, one dev server).
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_DEV_PASSWORD, PROJECT_LAKEVIEW } from "./support";

test.describe.configure({ mode: "serial" });

const BUYER_NAME = `E2E Buyer ${Date.now().toString(36)}`;
const BUYER_EMAIL = "e2e.buyer@example.com";

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
    await expect(page.getByRole("radio", { name: /buyer assistance/i })).toBeChecked();
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

test.describe("J7 admin", () => {
  test("/admin/leads without a session exposes no lead data and ends on the login page", async ({ page }) => {
    // Raw response (no redirects followed): either a 3xx to /admin/login, or a streamed page
    // that redirects client-side. In both cases it must not contain any lead data.
    const raw = await page.request.get("/admin/leads", { maxRedirects: 0 });
    if (raw.status() >= 300 && raw.status() < 400) {
      expect(raw.headers()["location"]).toMatch(/\/admin\/login/);
    } else {
      const body = await raw.text();
      expect(body).not.toContain(BUYER_NAME);
      expect(body).not.toContain(BUYER_EMAIL);
      expect(body).not.toMatch(/Buyer requests/);
    }
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
});
