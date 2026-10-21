// J1 filters (BHK, construction status, lane) · J3 selecting projects for compare from /projects
import { expect, test, type Page } from "@playwright/test";
import { LANE_B_LOCALITY, LANE_B_TITLE, PROJECT_LAKEVIEW, PROJECT_NORTHWIND } from "./support";

const researched = (page: Page) => page.getByRole("region", { name: "Researched by TrueNest" });
const external = (page: Page) => page.getByRole("region", { name: /not verified by TrueNest/i });

// Fixture units: 2 BHK in Lakeview, Courtyard, Riverside, Hennur. Under construction: Lakeview,
// Riverside, Hennur. Ready to move: Northwind (3 BHK only). Completed: Courtyard.
test.describe("J1 filters", () => {
  test("BHK + status filters narrow the researched results", async ({ page }) => {
    await page.goto("/projects?bhk=2&status=under_construction&lane=researched");
    const list = researched(page);
    for (const name of ["SAMPLE Lakeview Residences", "SAMPLE Riverside Thanisandra", "SAMPLE Hennur Gardens"]) {
      await expect(list.getByRole("link", { name }).first()).toBeVisible();
    }
    for (const name of ["SAMPLE Northwind Heights", "SAMPLE Yelahanka Courtyard", "SAMPLE Orchard Greens", "SAMPLE Jakkur Lakeside"]) {
      await expect(list.getByText(name)).toHaveCount(0);
    }
    await expect(page.getByText(/\(2 BHK, Under construction\)/)).toBeVisible();
  });

  test("filters submitted through the search form update the URL and results", async ({ page }) => {
    await page.goto("/projects");
    await page.getByLabel("Configuration").selectOption("3");
    await page.getByLabel("Construction status").selectOption("ready_to_move");
    await page.getByRole("button", { name: /search/i }).click();
    await expect(page).toHaveURL(/bhk=3/);
    await expect(page).toHaveURL(/status=ready_to_move/);
    await expect(researched(page).getByRole("link", { name: PROJECT_NORTHWIND.name }).first()).toBeVisible();
    await expect(researched(page).getByText(PROJECT_LAKEVIEW.name)).toHaveCount(0);
  });

  test("lane=external shows only the externally discovered section", async ({ page }) => {
    await page.goto(`/projects?locality=${LANE_B_LOCALITY}&lane=external`);
    await expect(external(page)).toBeVisible();
    await expect(external(page).getByText(LANE_B_TITLE).first()).toBeVisible();
    await expect(researched(page)).toHaveCount(0);
    await expect(page.getByText("SAMPLE Riverside Thanisandra")).toHaveCount(0);
  });

  test("lane=researched hides the externally discovered section", async ({ page }) => {
    await page.goto(`/projects?locality=${LANE_B_LOCALITY}&lane=researched`);
    await expect(researched(page).getByText("SAMPLE Riverside Thanisandra").first()).toBeVisible();
    await expect(external(page)).toHaveCount(0);
    await expect(page.getByText(LANE_B_TITLE)).toHaveCount(0);
  });
});

test.describe("J3 compare from the browse page", () => {
  test("ticking two projects and opening the comparison works (compare-param regression)", async ({ page }) => {
    await page.goto("/projects");
    // The checkbox is controlled by the URL (router.replace), so click and wait for the URL
    // rather than using check(), which expects the state to flip synchronously.
    const lakeview = page.getByRole("checkbox", { name: `Compare ${PROJECT_LAKEVIEW.name}` });
    await lakeview.click();
    await expect(page).toHaveURL(new RegExp(`compare=${PROJECT_LAKEVIEW.id}`));
    await expect(lakeview).toBeChecked();
    await expect(page.getByText(/1 of 4 selected for comparison/)).toBeVisible();
    const northwind = page.getByRole("checkbox", { name: `Compare ${PROJECT_NORTHWIND.name}` });
    await expect(northwind).toBeEnabled();
    await northwind.click();
    await expect(page).toHaveURL(new RegExp(`compare=${PROJECT_LAKEVIEW.id}(,|%2C)${PROJECT_NORTHWIND.id}`));
    await expect(northwind).toBeChecked();
    await expect(page.getByText(/2 of 4 selected for comparison/)).toBeVisible();

    await page.getByRole("link", { name: "Compare 2" }).click();
    await expect(page).toHaveURL(/\/compare\?ids=/);
    await expect(page.getByRole("heading", { level: 1, name: /compare projects/i })).toBeVisible();
    await expect(page.getByText(PROJECT_LAKEVIEW.name).first()).toBeVisible();
    await expect(page.getByText(PROJECT_NORTHWIND.name).first()).toBeVisible();
    await expect(page.getByText(/something went wrong|nothing to compare yet/i)).toHaveCount(0);
  });
});
