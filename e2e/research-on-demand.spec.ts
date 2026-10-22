// M2.5 on-demand research: a free-text search that misses both lanes queues a research job and
// shows an honest "researching" state (fixture mode: in-memory queue, fake client, no network).
import { expect, test } from "@playwright/test";
import { applyStaffSession } from "./support";

const MISS = "SAMPLE zzq e2e towers";

test.describe("on-demand research", () => {
  test("a search miss shows the researching state, not 'no projects exist'", async ({ page }) => {
    await page.goto(`/projects?q=${encodeURIComponent(MISS)}`);
    const status = page.getByRole("status").filter({ hasText: /researching/i });
    await expect(status).toBeVisible();
    await expect(status).toContainText(`We’re researching “${MISS}” now`);
    await expect(status).toContainText(/refresh this page to check/i);
    await expect(status).toContainText(/labelled unverified/i);
    // The empty researched lane still says that missing results are not a negative finding.
    await expect(page.getByText(/does not mean there are no projects/i)).toBeVisible();

    // Reloading reuses the same job instead of queueing another.
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: /researching/i })).toBeVisible();
  });

  test("staff see the queued job read-only on /admin/research-jobs", async ({ page }) => {
    await page.goto(`/projects?q=${encodeURIComponent(MISS)}`);
    await applyStaffSession(page, "advisor");
    await page.goto("/admin/research-jobs");
    await expect(page.getByRole("heading", { name: "Research jobs", level: 1 })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: MISS });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Queued|Running/);
    await expect(page.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Research jobs" })).toBeVisible();
  });
});
