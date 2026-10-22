// J1 Browse projects · J4 Lane A vs Lane B · mobile layout
import { expect, test } from "@playwright/test";
import { LANE_A_IN_LANE_B_LOCALITY, LANE_B_LOCALITY, LANE_B_TITLE, LANE_B_URL, PROJECT_LAKEVIEW, UNPUBLISHED } from "./support";

test.describe("J1 browse", () => {
  test("landing page loads with a sample-data banner and a way to browse", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/sample data/i).first()).toBeVisible();
    await expect(page.getByText(/fictional/i).first()).toBeVisible();
    await page.getByRole("link", { name: /browse all projects/i }).click();
    await expect(page).toHaveURL(/\/projects/);
  });

  test("/projects lists Lane A (researched) cards, never the unpublished draft", async ({ page }) => {
    await page.goto("/projects");
    await expect(page.getByText(/sample data/i).first()).toBeVisible();
    const lakeview = page.getByRole("link", { name: PROJECT_LAKEVIEW.name }).first();
    await expect(lakeview).toBeVisible();
    // Card shows developer and the RERA ≠ title qualifier.
    await expect(page.getByText("SAMPLE Developer A").first()).toBeVisible();
    await expect(page.getByText(/not title clearance/i).first()).toBeVisible();
    await expect(page.getByText(UNPUBLISHED.name)).toHaveCount(0);
  });
});

test.describe("J4 Lane B (externally discovered)", () => {
  test("a locality with few researched results shows a labelled, linked-out Lane B section", async ({ page }) => {
    await page.goto(`/projects?locality=${LANE_B_LOCALITY}`);
    await expect(page.getByText(LANE_A_IN_LANE_B_LOCALITY).first()).toBeVisible();

    // Section-level label.
    await expect(page.getByText(/not verified by TrueNest/i).first()).toBeVisible();

    // The external listing itself: title, source, canonical link-out, dates, limitations.
    await expect(page.getByText(LANE_B_TITLE).first()).toBeVisible();
    await expect(page.getByText(/Source:\s*SAMPLE Feed/i).first()).toBeVisible();
    const out = page.locator(`a[href="${LANE_B_URL}"]`).first();
    await expect(out).toBeVisible();
    await expect(out).toHaveAttribute("target", "_blank");
    await expect(out).toHaveAttribute("rel", /noopener/);
    await expect(page.getByText(/^Discovered$/).first()).toBeVisible();
    await expect(page.getByText(/^Last seen$/).first()).toBeVisible();
    await expect(page.getByText(/^Limitations$/).first()).toBeVisible();
    await expect(page.getByText(/SAMPLE fictional data for testing only/i).first()).toBeVisible();
    // Primary action is a verification request, not a "verified" claim.
    await expect(page.getByRole("link", { name: /request verification/i }).first()).toBeVisible();
  });

  for (const [query, title] of [
    ["locality=yelahanka", /SAMPLE Lakeview Residency/],
    ["locality=devanahalli", /SAMPLE Orchard Greens.*fictional/],
    ["q=Residency", /SAMPLE Lakeview Residency/],
  ] as const) {
    test(`Lane B also appears, labelled, for ${query}`, async ({ page }) => {
      await page.goto(`/projects?${query}`);
      await expect(page.getByText(title).first()).toBeVisible();
      await expect(page.getByText(/not verified by TrueNest/i).first()).toBeVisible();
      await expect(page.locator('a[target="_blank"][href^="https://example."]').first()).toBeVisible();
    });
  }

  test("the Lane B label never appears on researched (Lane A) cards", async ({ page }) => {
    await page.goto(`/projects?locality=${LANE_B_LOCALITY}`);
    const laneA = page.getByRole("link", { name: LANE_A_IN_LANE_B_LOCALITY }).first();
    await expect(laneA).toBeVisible();
    await expect(laneA).not.toContainText(/not verified by TrueNest/i);
  });
});

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  for (const path of ["/projects", `/projects?locality=${LANE_B_LOCALITY}`]) {
    test(`no horizontal page overflow on ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByText(/sample data/i).first()).toBeVisible();
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `page is ${scrollWidth}px wide in a ${clientWidth}px viewport`).toBeLessThanOrEqual(clientWidth);
    });
  }
});
