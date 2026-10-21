// J3 compare up to 4
import { expect, test } from "@playwright/test";
import { FIVE_PROJECT_IDS, PROJECT_LAKEVIEW, PROJECT_NORTHWIND, UNPUBLISHED } from "./support";

test.describe("J3 compare", () => {
  test("compares two projects side by side with neutral unknown cells", async ({ page }) => {
    await page.goto(`/compare?ids=${PROJECT_LAKEVIEW.id},${PROJECT_NORTHWIND.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(PROJECT_LAKEVIEW.name).first()).toBeVisible();
    await expect(page.getByText(PROJECT_NORTHWIND.name).first()).toBeVisible();
    await expect(page.getByText(/RERA registration \(not title clearance\)/i).first()).toBeVisible();
    // Lakeview's 3 BHK price is unknown -> neutral wording.
    await expect(page.getByText(/not yet found/i).first()).toBeVisible();
  });

  test("more than 4 projects is refused with a clear message", async ({ page }) => {
    await page.goto(`/compare?ids=${FIVE_PROJECT_IDS.join(",")}`);
    await expect(page.getByText(/compare up to 4/i).first()).toBeVisible();
  });

  test("an unpublished id is never shown in a comparison", async ({ page }) => {
    await page.goto(`/compare?ids=${PROJECT_LAKEVIEW.id},${UNPUBLISHED.id}`);
    await expect(page.getByText(PROJECT_LAKEVIEW.name).first()).toBeVisible();
    await expect(page.getByText(UNPUBLISHED.name)).toHaveCount(0);
  });
});
