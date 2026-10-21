// J5 request · J6 consent-aware lead capture · J7 protected admin
// Serial: the admin journey reads the lead submitted earlier (in-memory fixture store, one dev server).
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_DEV_PASSWORD, PROJECT_LAKEVIEW } from "./support";

test.describe.configure({ mode: "serial" });

const BUYER_NAME = `E2E Buyer ${Date.now().toString(36)}`;
const BUYER_EMAIL = "e2e.buyer@example.com";

async function fillRequestForm(page: Page) {
  await page.getByLabel(/^(full )?name/i).fill(BUYER_NAME);
  await page.getByLabel(/email/i).first().fill(BUYER_EMAIL);
  // Preferred channel may be a <select> or a radio group.
  const select = page.getByLabel(/how should we contact you|preferred (contact )?channel/i);
  if ((await select.count()) && (await select.first().evaluate((el) => el.tagName === "SELECT"))) {
    await select.first().selectOption("email");
  } else {
    await page.getByRole("radio", { name: /^email$/i }).check();
  }
}

const submitButton = (page: Page) => page.getByRole("button", { name: /submit|send request|request/i }).first();
const contactConsent = (page: Page) => page.getByRole("checkbox", { name: /agree that TrueNest may contact me/i });
const marketingConsent = (page: Page) => page.getByRole("checkbox", { name: /occasional updates/i });

test.describe("J5/J6 request form", () => {
  test("cannot submit without contact consent; marketing consent is unticked by default", async ({ page }) => {
    await page.goto(`/request?project=${PROJECT_LAKEVIEW.id}&type=buyer_assistance`);
    await expect(page.getByText(PROJECT_LAKEVIEW.name).first()).toBeVisible();
    await fillRequestForm(page);
    await expect(contactConsent(page)).not.toBeChecked();
    await expect(marketingConsent(page)).not.toBeChecked();
    await submitButton(page).click();
    // Either native `required` blocks submission or the server returns the consent error.
    const blockedNatively = await contactConsent(page).evaluate((el) => !(el as HTMLInputElement).checkValidity());
    if (!blockedNatively) await expect(page.getByText(/please agree to be contacted/i).first()).toBeVisible();
    await expect(page).toHaveURL(/\/request/);
    await expect(page.getByText(/what happens next/i)).toHaveCount(0);
  });

  test("submits with consent and shows what happens next and how to withdraw", async ({ page }) => {
    await page.goto(`/request?project=${PROJECT_LAKEVIEW.id}&type=buyer_assistance`);
    await fillRequestForm(page);
    await contactConsent(page).check();
    await submitButton(page).click();
    await expect(page.getByText(/what happens next|request (has been )?received|thank you/i).first()).toBeVisible();
    await expect(page.getByText(/withdraw|stop contacting you|delete your request/i).first()).toBeVisible();
  });
});

test.describe("J7 admin", () => {
  test("/admin/leads redirects to the login page without a session", async ({ page }) => {
    await page.goto("/admin/leads");
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByText(BUYER_NAME)).toHaveCount(0);
  });

  test("a wrong password is rejected", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel(/password/i).fill("definitely-not-the-password");
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page.getByText(/incorrect|invalid|wrong|not recognised/i).first()).toBeVisible();
    await page.goto("/admin/leads");
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("the dev password signs in and the submitted lead is listed", async ({ page }) => {
    await page.goto("/admin/login");
    await page.getByLabel(/password/i).fill(E2E_ADMIN_DEV_PASSWORD);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await expect(page).toHaveURL(/\/admin\/leads/);
    await expect(page.getByText(BUYER_NAME).first()).toBeVisible();
    // Admin pages must not be indexed.
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots ?? "").toMatch(/noindex/i);
  });
});
