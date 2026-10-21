// J2 project details and evidence
import { expect, test } from "@playwright/test";
import { PROJECT_LAKEVIEW, PROJECT_MOSTLY_UNKNOWN, UNPUBLISHED } from "./support";

test.describe("J2 project detail", () => {
  test("unknown facts render as 'Not yet found', never as a negative finding", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_MOSTLY_UNKNOWN.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_MOSTLY_UNKNOWN.name })).toBeVisible();
    await expect(page.getByText(/not yet found/i).first()).toBeVisible();
    // Unknown RERA must not be presented as "unregistered" / "no RERA".
    await expect(page.getByText(/\bunregistered\b|\bno rera\b|not registered/i)).toHaveCount(0);
  });

  test("shows the RERA-is-not-title notice and per-fact sources", async ({ page }) => {
    await page.goto(`/projects/${PROJECT_LAKEVIEW.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_LAKEVIEW.name })).toBeVisible();
    await expect(page.getByText(/RERA registration is not (proof of clear title|title clearance)/i).first()).toBeVisible();
    await expect(page.getByText("SAMPLE-RERA-0001").first()).toBeVisible();
    // Evidence affordance: at least one source link to the fixture source domain.
    await expect(page.locator('a[href^="https://example.com/"]').first()).toBeAttached();
    await expect(page.getByText(/sample data/i).first()).toBeVisible();
  });

  test("an unpublished project is not reachable", async ({ page }) => {
    const res = await page.goto(`/projects/${UNPUBLISHED.slug}`);
    expect(res?.status()).toBe(404);
    await expect(page.getByText(UNPUBLISHED.name)).toHaveCount(0);
  });
});
