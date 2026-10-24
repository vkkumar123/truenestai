// S4a area developments: staff research a locality (fixture mode: in-memory queue, fake research
// client, SAMPLE pages on example.org, no network), review and publish one item, then a buyer sees
// it on a SAMPLE project page under the disclaimer. Unpublished items never reach buyers.
// This file sorts before research-on-demand.spec.ts, so the worker run here only finds its own job.
import { expect, test } from "@playwright/test";
import { E2E_RESEARCH_RUN_SECRET, PROJECT_LAKEVIEW, applyStaffSession } from "./support";

const METRO = "SAMPLE Hebbal Metro Extension";
const ROAD = "SAMPLE Hebbal Ring Road Link";
const FABRICATED = "SAMPLE Hebbal Sky Tram";
const FAR_PROJECT = "sample-orchard-greens"; // Devanahalli: far from Hebbal
const HEADING = "Planned around here (next 5–10 years)";
const DISCLAIMER = "Plans can change, be delayed or be cancelled. Not a prediction of property prices or returns.";

test.describe("area developments (S4a)", () => {
  test("staff research → edit → publish; the buyer sees it with the disclaimer", async ({ page, request }) => {
    // Before anything is published: an honest "Not yet researched" state, never "nothing planned".
    await page.goto(`/projects/${PROJECT_LAKEVIEW.slug}`);
    const planned = page.getByRole("region", { name: HEADING });
    await expect(planned).toBeVisible();
    await expect(planned.getByRole("note")).toContainText(DISCLAIMER);
    await expect(planned.getByRole("status")).toContainText("Not yet researched");
    await expect(planned).toContainText("This does not mean nothing is planned here.");

    // 1. Staff ask for research (queues a job on the existing research queue).
    await applyStaffSession(page, "admin");
    await page.goto("/admin/developments?locality=hebbal");
    await expect(page.getByRole("heading", { name: "Research for Hebbal" })).toBeVisible();
    await page.getByRole("button", { name: "Research area developments" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Research queued for Hebbal" })).toBeVisible();

    // 2. The scheduler's worker run (same endpoint Cloud Scheduler calls).
    const run = await request.post("/api/internal/research/run", { headers: { "x-research-secret": E2E_RESEARCH_RUN_SECRET } });
    expect(run.status()).toBe(200);
    const body = (await run.json()) as { outcomes: { status: string; resultCount: number }[] };
    expect(body.outcomes).toEqual([expect.objectContaining({ status: "done", resultCount: 2 })]);

    // 3. Researched drafts: unverified, pending, SAMPLE; the uncited item was dropped by the validator.
    await page.reload();
    const metro = page.getByRole("article", { name: METRO });
    await expect(metro).toBeVisible();
    await expect(metro).toContainText("Pending review");
    await expect(metro).toContainText("Automated research");
    await expect(metro).toContainText("Sample data");
    await expect(metro).toContainText("SAMPLE Metro Authority");
    const road = page.getByRole("article", { name: ROAD });
    await expect(road).toContainText("authority: not yet found");
    await expect(page.getByRole("article", { name: FABRICATED })).toHaveCount(0);

    // 4. Staff map it (research never sets coordinates).
    await metro.getByText("Edit details").click();
    await metro.getByLabel("Latitude (optional)").fill("13.045");
    await metro.getByLabel("Longitude (optional)").fill("77.597");
    await metro.getByRole("button", { name: "Save changes" }).click();
    await expect(metro.getByRole("status").filter({ hasText: "Saved as unverified." })).toBeVisible();

    // 5. Admin publishes.
    await page.reload();
    const metro2 = page.getByRole("article", { name: METRO });
    await expect(metro2).toContainText("13.045, 77.597");
    await metro2.getByRole("button", { name: "Publish", exact: true }).click();
    // The page re-renders with the published state (the publish form is replaced by Unpublish).
    await expect(metro2.getByRole("button", { name: "Unpublish" })).toBeVisible();
    await expect(metro2).not.toContainText("Pending review");
    await metro2.getByText(/^Review history/).click();
    await expect(metro2.getByRole("cell", { name: "published", exact: true })).toBeVisible();

    // 6. A buyer (signed out) sees the published item only.
    await page.context().clearCookies();
    await page.goto(`/projects/${PROJECT_LAKEVIEW.slug}`);
    const section = page.getByRole("region", { name: HEADING });
    await expect(section.getByRole("note")).toContainText(DISCLAIMER);
    const item = section.getByRole("listitem", { name: METRO });
    await expect(item).toBeVisible();
    await expect(item).toContainText("Stage: Under construction");
    await expect(item).toContainText("SAMPLE Metro Authority");
    await expect(item).toContainText(/Expected \(declared\) December \d{4}/);
    await expect(item).toContainText("not a TrueNest estimate or guarantee");
    await expect(item).toContainText(/\d+(\.\d)? km straight-line from this project|\d+ m straight-line from this project/);
    await expect(item).toContainText("Sample data — fictional");
    await expect(item).toContainText(/Seen on the source .* · Last checked /);
    await expect(item.getByRole("link")).toHaveAttribute("href", /^https:\/\/example\.org\/sample-developments\/hebbal\/metro$/);
    await expect(section.getByRole("listitem", { name: ROAD })).toHaveCount(0);
    await expect(page.getByText(/appreciat|guaranteed returns/i)).toHaveCount(0);

    // A project far away still shows the honest empty state.
    await page.goto(`/projects/${FAR_PROJECT}`);
    const far = page.getByRole("region", { name: HEADING });
    await expect(far.getByRole("status")).toContainText("Not yet researched");
  });
});
