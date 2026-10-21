// M3 staff research tooling (D12/D13): create → add facts with sources → blocked publish →
// admin review → publish → public visibility → audit history; advisor restrictions; Lane B
// "Researched version available" link.
//
// DRAFT: written while /admin/projects/[id] was still being built. Every UI assumption about the
// project detail page is collected in `ui` below so it can be adjusted in one place.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_ADMIN_DEV_PASSWORD, E2E_ADVISOR_DEV_PASSWORD, PROJECT_LAKEVIEW } from "./support";

test.describe.configure({ mode: "serial" });

const STAMP = Date.now().toString(36);
const PROJECT_NAME = `SAMPLE E2E Research Residency ${STAMP}`;
const DEVELOPER = "SAMPLE Developer E2E";
const RERA = "SAMPLE-RERA-0901";
const ADDRESS = "SAMPLE Research Road 9, Hebbal (fictional)";
const SOURCE_URL = "https://example.com/sample/e2e-research";
const OBSERVED_DATE = "2026-10-01";

let projectUrl = ""; // /admin/projects/<id>, captured after creation

const ui = {
  /** Section of the staff project page for one fact, found by its heading. */
  factSection: (page: Page, label: RegExp) =>
    page.locator("section, fieldset, [role=group]").filter({ has: page.getByRole("heading", { name: label }) }).first(),
  address: /^address/i,
  rera: /RERA/i,
  status: /construction status/i,
  publishButton: (page: Page) => page.getByRole("button", { name: /^publish/i }),
  blockers: (page: Page) => page.getByRole("region", { name: /blockers|publish readiness/i }).or(page.getByText(/blocker/i)).first(),
  audit: (page: Page) => page.getByRole("region", { name: /audit|history/i }).or(page.locator("section").filter({ has: page.getByRole("heading", { name: /audit|history/i }) })).first(),
};

async function signIn(page: Page, password: string) {
  await page.goto("/admin/login");
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/admin(\/|$)/);
  await expect(page).not.toHaveURL(/\/admin\/login/);
}

/** Fill a fact form inside `section`: known value + one https source with an observed date. */
async function saveFact(section: Locator, fill: (s: Locator) => Promise<void>) {
  const known = section.getByRole("radio", { name: /^known/i });
  if (await known.count()) await known.check();
  await fill(section);
  await section.getByLabel(/source (id|name)/i).first().fill("sample-e2e-source");
  await section.getByLabel(/source url|url/i).first().fill(SOURCE_URL);
  await section.getByLabel(/observed/i).first().fill(OBSERVED_DATE);
  await section.getByRole("button", { name: /save|update fact|set fact/i }).first().click();
  await expect(section.getByText(/saved|updated/i).first()).toBeVisible();
}

async function setVerification(section: Locator, label: RegExp) {
  const option = await matchOption(section, label);
  expect(option, `verification option matching ${label}`).not.toBeNull();
  await section.getByLabel(/verification/i).first().selectOption({ label: option! });
  await section.getByRole("button", { name: /update verification|change verification|set verification|update/i }).first().click();
}

async function matchOption(section: Locator, label: RegExp): Promise<string | null> {
  const opts = await section.getByLabel(/verification/i).first().locator("option").allTextContents();
  return opts.find((o) => label.test(o)) ?? null;
}

test.describe("M3 research workflow (admin)", () => {
  test("admin creates a project: listed as unpublished, absent from /projects", async ({ page }) => {
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto("/admin/projects/new");
    await page.getByLabel("Project name").fill(PROJECT_NAME);
    await page.getByLabel("Developer name").fill(DEVELOPER);
    await page.getByLabel("Locality").selectOption("hebbal");
    await page.getByRole("button", { name: /create project/i }).click();
    await expect(page).toHaveURL(/\/admin\/projects\/[^/]+$/);
    await expect(page).not.toHaveURL(/\/new$/);
    projectUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_NAME })).toBeVisible();
    await expect(page.getByText(/not yet found/i).first()).toBeVisible();

    await page.goto("/admin/projects");
    const row = page.getByRole("row").filter({ hasText: PROJECT_NAME });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Unpublished")).toBeVisible();
    await expect(row.getByText(/\d+ blockers?/)).toBeVisible();

    await page.goto(`/projects?q=${encodeURIComponent(PROJECT_NAME)}&lane=researched`);
    await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
  });

  test("admin adds facts with https sources; publish is blocked with blockers shown", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl);

    await saveFact(ui.factSection(page, ui.status), async (s) => {
      await s.getByLabel(/value|construction status/i).first().selectOption("under_construction");
    });
    await saveFact(ui.factSection(page, ui.rera), (s) => s.getByLabel(/value|registration/i).first().fill(RERA));
    await saveFact(ui.factSection(page, ui.address), (s) => s.getByLabel(/value|address/i).first().fill(ADDRESS));

    await page.reload();
    await expect(page.getByText(RERA).first()).toBeVisible();
    await expect(page.getByText(ADDRESS).first()).toBeVisible();
    // Every edited fact starts unverified.
    await expect(ui.factSection(page, ui.rera).getByText("Unverified").first()).toBeVisible();

    // RERA is unverified -> publishing is blocked and the blocker is explained.
    await expect(page.getByText(/reraNumbers: must be source_confirmed or reviewed|RERA.*(source confirmed|reviewed)/i).first()).toBeVisible();
    const publish = ui.publishButton(page);
    if (await publish.isEnabled()) {
      await publish.click();
      await expect(page.getByText(/not ready to publish/i).first()).toBeVisible();
    } else {
      await expect(publish).toBeDisabled();
    }
    await page.goto(`/projects?q=${encodeURIComponent(PROJECT_NAME)}&lane=researched`);
    await expect(page.getByText(PROJECT_NAME)).toHaveCount(0);
  });

  test("admin marks RERA reviewed, publishes, and the project is public with per-fact badges", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl);
    await setVerification(ui.factSection(page, ui.rera), /^reviewed/i);
    await expect(ui.factSection(page, ui.rera).getByText("Reviewed").first()).toBeVisible();

    await ui.publishButton(page).click();
    await expect(page.getByText(/^published$/i).first()).toBeVisible();

    await page.goto(`/projects?q=${encodeURIComponent(PROJECT_NAME)}&lane=researched`);
    const card = page.getByRole("link", { name: PROJECT_NAME }).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_NAME })).toBeVisible();
    await expect(page.getByText(RERA).first()).toBeVisible();
    await expect(page.getByText("Reviewed").first()).toBeVisible(); // RERA
    await expect(page.getByText("Unverified").first()).toBeVisible(); // address / construction status
    await expect(page.getByText(/RERA registration is not (proof of clear title|title clearance)/i).first()).toBeVisible();
    // Staff-created projects are not sample data.
    await expect(page.getByRole("main").getByText(/^Sample data$/)).toHaveCount(0);
  });

  test("audit history lists creation, fact edits, verification change and publish", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl);
    const audit = ui.audit(page);
    await expect(audit).toBeVisible();
    for (const re of [/created/i, /fact.?set|fact (added|updated|changed)/i, /verification.?changed|verification/i, /published/i]) {
      await expect(audit.getByText(re).first()).toBeVisible();
    }
    await expect(audit.getByText(/fixture-dev-admin|admin/).first()).toBeVisible();
  });
});

test.describe("M3 advisor restrictions", () => {
  test("advisor sees no Publish control and cannot choose Reviewed / Source confirmed", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADVISOR_DEV_PASSWORD);
    await page.goto(projectUrl);
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_NAME })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(publish|unpublish)/i })).toHaveCount(0);

    for (const label of [ui.rera, ui.address, ui.status]) {
      const select = ui.factSection(page, label).getByLabel(/verification/i).first();
      if (!(await select.count())) continue;
      for (const forbidden of ["Reviewed", "Source confirmed"]) {
        const opt = select.locator("option", { hasText: new RegExp(`^${forbidden}`) });
        const n = await opt.count();
        for (let i = 0; i < n; i++) await expect(opt.nth(i)).toBeDisabled();
      }
    }
  });
});

test.describe("Lane B link to the researched version", () => {
  test("RERA-matched sample listing under lane=external links to the researched project", async ({ page }) => {
    await page.goto("/projects?locality=hebbal&lane=external");
    const link = page.getByRole("link", { name: new RegExp(`Researched version available.*${PROJECT_LAKEVIEW.name}`) });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", `/projects/${PROJECT_LAKEVIEW.slug}`);
    // The listing stays labelled unverified even though a researched version exists.
    await expect(page.getByText(/not verified by TrueNest/i).first()).toBeVisible();
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_LAKEVIEW.name })).toBeVisible();
  });
});
