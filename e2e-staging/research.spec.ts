import { expect, test } from "@playwright/test";

// End-to-end proof of on-demand research on a deployed environment:
// unfiltered search miss → research starts (Server Action) → scheduled worker runs →
// results stored in the DB → the same search now shows them (or the honest "searched" state).
const QUERY = process.env.SMOKE_QUERY || "Assetz";
const url = `/projects?q=${encodeURIComponent(QUERY)}`;

test("real data mode: no sample-data banner", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByText("all projects shown are fictional")).toHaveCount(0);
});

test(`search miss for "${QUERY}" is researched and served from the DB`, async ({ page }) => {
  await page.goto(url);
  const results = page.locator("section[aria-labelledby='external-heading'] a[href^='https://']");
  const researching = page.getByText(/We’re researching/);
  const searchedNone = page.getByText(/We searched public web sources/);
  const unavailable = page.getByText(/We can’t research/);

  // First load: either results already exist (earlier run) or research starts.
  await expect(results.first().or(researching).or(searchedNone.first()).or(unavailable.first())).toBeVisible({ timeout: 60_000 });
  if (await unavailable.first().isVisible()) throw new Error("Research is unavailable on this environment (worker not configured or recently failed)");

  // Poll for up to 12 minutes: the worker runs every 2 minutes and a job can take ~2 minutes.
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    if (await results.first().isVisible()) break;
    if (!(await researching.isVisible()) && (await searchedNone.first().isVisible())) break;
    await page.waitForTimeout(30_000);
    await page.goto(url);
  }
  const body = (await page.locator("main").innerText()).slice(0, 4000);
  console.log("---- page text ----\n" + body);
  await expect(researching).toHaveCount(0);
  const count = await results.count();
  console.log(`external result links shown: ${count}`);
  for (const href of await results.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) console.log("source:", href);
});
