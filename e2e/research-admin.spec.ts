// M3 staff research tooling (D12/D13): create → add facts with sources → blocked publish →
// admin review → publish → public visibility → audit history; advisor restrictions; Lane B
// "Researched version available" link.
//
// Selectors target src/app/admin/projects/[id]/page.tsx and src/components/admin/*.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_ADMIN_DEV_PASSWORD, E2E_ADVISOR_DEV_PASSWORD, PROJECT_LAKEVIEW } from "./support";


const STAMP = Date.now().toString(36);
const PROJECT_NAME = `SAMPLE E2E Research Residency ${STAMP}`;
const DEVELOPER = "SAMPLE Developer E2E";
const RERA = "SAMPLE-RERA-0901";
const RERA_CORRECTED = "SAMPLE-RERA-0902";
const ADDRESS = "SAMPLE Research Road 9, Hebbal (fictional)";
const SOURCE_URL = "https://example.com/sample/e2e-research";

let projectUrl = ""; // /admin/projects/<id>, captured after creation

type Field = "address" | "reraNumbers" | "constructionStatus" | "declaredPossession";

const ui = {
  /** Fact card on /admin/projects/[id] (Card id="fact-<field>"). */
  fact: (page: Page, field: Field) => page.locator(`#fact-${field}`),
  publishing: (page: Page) => page.getByRole("region", { name: "Publishing" }),
  /** The fact card's header (value, verification badge, sources), excluding the forms' <option>s. */
  factHeader: (page: Page, field: Field) => page.locator(`#fact-${field} > :first-child`),
  history: (page: Page) => page.getByRole("region", { name: "Change history" }),
};

async function signIn(page: Page, password: string) {
  await page.goto("/admin/login");
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/admin\/login/);
  await expect(page.getByRole("navigation", { name: "Staff" })).toBeVisible();
}

/** Opens "Edit fact and sources", marks Known, fills the value and source 1, and saves. */
async function saveFact(page: Page, field: Field, fill: (value: Locator) => Promise<void>) {
  const card = ui.fact(page, field);
  await card.getByText("Edit fact and sources").click();
  await card.getByRole("radio", { name: /^Known/ }).check();
  await fill(card.locator(`#${field}-value`));
  // Source is a select of registry sources ("sample-feed — SAMPLE Feed (fictional fixture)").
  await card.locator(`#${field}-s0-id`).selectOption("sample-feed");
  await card.locator(`#${field}-s0-url`).fill(SOURCE_URL);
  // Observed-at defaults to request time; exercise the client-side "Now" button explicitly.
  const observed = card.locator(`#${field}-s0-obs`);
  await observed.fill("");
  await card.getByRole("button", { name: "Now" }).first().click();
  await expect(observed).toHaveValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  await card.getByRole("button", { name: "Save fact" }).click();
  await expect(card.getByRole("status")).toBeVisible();
  await expect(card.getByRole("alert")).toHaveCount(0);
}

async function setVerification(page: Page, field: Field, label: string) {
  const card = ui.fact(page, field);
  await card.getByLabel("Change verification to").selectOption({ label });
  await card.getByRole("button", { name: "Update verification" }).click();
  await expect(card.getByRole("status").first()).toBeVisible();
}

/** Public search for the project's name finds no card/link (the query itself is echoed on the page). */
async function expectNotPublic(page: Page) {
  await page.goto(`/projects?q=${encodeURIComponent(PROJECT_NAME)}&lane=researched`);
  await expect(page.getByText(/^0 results/)).toBeVisible();
  await expect(page.getByRole("link", { name: PROJECT_NAME })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Researched by TrueNest" }).getByText(PROJECT_NAME)).toHaveCount(0);
}

/** Fails with a specific message if a staff action bounced us to the login page. */
async function expectStillSignedIn(page: Page, what: string) {
  expect(new URL(page.url()).pathname, `${what}: redirected to login (getStaffSession returned null after a server action?)`).not.toBe(
    "/admin/login",
  );
}

test.describe.serial("M3 research workflow (admin)", () => {
  // Later tests (and the advisor test below) depend on this project; workers: 1 keeps file order.
  test("admin creates a project: client redirect to its page, listed as unpublished, absent from /projects", async ({ page }) => {
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto("/admin/projects");
    await page.getByRole("link", { name: "New project" }).click();
    await expect(page).toHaveURL(/\/admin\/projects\/new$/);
    await page.getByLabel("Project name").fill(PROJECT_NAME);
    // Default is "New developer"; existing developers are never matched by name.
    await expect(page.getByLabel("Developer", { exact: true })).toHaveValue("");
    await page.getByLabel("New developer name").fill(DEVELOPER);
    await page.getByLabel("Locality").selectOption("hebbal");
    await page.getByRole("button", { name: /create project/i }).click();
    // Client-side router.push after the action succeeds.
    await expect(page).toHaveURL(/\/admin\/projects\/(?!new$)[^/]+$/);
    projectUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_NAME })).toBeVisible();
    await expect(page.getByText("Unpublished").first()).toBeVisible();
    await expect(ui.fact(page, "reraNumbers").getByText(/not yet found/i).first()).toBeVisible();
    await expect(ui.fact(page, "reraNumbers").getByText(/add at least one source before changing verification/i)).toBeVisible();

    await page.goto("/admin/projects");
    const row = page.getByRole("row").filter({ hasText: PROJECT_NAME });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Unpublished")).toBeVisible();
    await expect(row.getByText(/\d+ blockers?/)).toBeVisible();
    await expect(row.getByText("Sample data")).toHaveCount(0);

    await expectNotPublic(page);
  });

  test("admin adds facts with https sources; publish is refused with blockers shown", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl);

    await saveFact(page, "constructionStatus", async (v) => {
      await v.selectOption("under_construction");
    });
    await saveFact(page, "reraNumbers", (v) => v.fill(RERA));
    await saveFact(page, "address", (v) => v.fill(ADDRESS));

    await page.reload();
    for (const [field, text] of [["reraNumbers", RERA], ["address", ADDRESS], ["constructionStatus", "Under construction"]] as const) {
      const card = ui.fact(page, field);
      await expect(card.getByText(text).first()).toBeVisible();
      await expect(ui.factHeader(page, field).getByText("Unverified")).toBeVisible();
      await expect(card.locator(`a[href="${SOURCE_URL}"]`).first()).toBeAttached();
    }

    const publishing = ui.publishing(page);
    await expect(publishing.getByText("Blocking publication")).toBeVisible();
    await expect(publishing.getByText("reraNumbers: must be source_confirmed or reviewed")).toBeVisible();
    await publishing.getByRole("button", { name: "Publish" }).click();
    await expectStillSignedIn(page, "refused publish");
    await expect(publishing.getByRole("alert").filter({ hasText: /not ready to publish/i })).toBeVisible();
    await expect(page.getByText("Unpublished").first()).toBeVisible();

    await expectNotPublic(page);
  });

  test("stale tab: verifying a fact edited in another tab shows a conflict and changes nothing", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl); // tab A: holds the current RERA version
    const pageB = await page.context().newPage();
    await pageB.goto(projectUrl); // tab B: re-saves RERA (new observed time -> new fact version)
    await saveFact(pageB, "reraNumbers", (v) => v.fill(RERA));
    await pageB.close();

    const cardA = ui.fact(page, "reraNumbers");
    await cardA.getByLabel("Change verification to").selectOption({ label: "Reviewed" });
    await cardA.getByRole("button", { name: "Update verification" }).click();
    await expectStillSignedIn(page, "stale verification");
    await expect(cardA.getByRole("alert").filter({ hasText: /changed since you loaded it/i })).toBeVisible();
    await expect(cardA.getByRole("link", { name: "Reload this page" })).toBeVisible();

    await page.reload();
    await expect(ui.factHeader(page, "reraNumbers").getByText("Unverified")).toBeVisible();
    await expect(ui.factHeader(page, "reraNumbers").getByText("Reviewed")).toHaveCount(0);
    await expect(ui.history(page).getByRole("row").filter({ hasText: /verification changed/ })).toHaveCount(0);
    await expect(page.getByText("Unpublished").first()).toBeVisible();
  });

  test("admin marks RERA reviewed, publishes, and the project is public with per-fact badges", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl);
    await setVerification(page, "reraNumbers", "Reviewed");
    await page.reload();
    await expect(ui.factHeader(page, "reraNumbers").getByText("Reviewed")).toBeVisible();
    await expect(ui.publishing(page).getByText("Ready to publish")).toBeVisible();

    await ui.publishing(page).getByRole("button", { name: "Publish" }).click();
    await expectStillSignedIn(page, "publish");
    await expect(ui.publishing(page).getByRole("status")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Published").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "View public page" })).toBeVisible();

    await page.goto(`/projects?q=${encodeURIComponent(PROJECT_NAME)}&lane=researched`);
    const card = page.getByRole("link", { name: PROJECT_NAME }).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_NAME })).toBeVisible();
    const main = page.getByRole("main");
    await expect(main.getByText(RERA).first()).toBeVisible();
    await expect(main.getByText("Reviewed").first()).toBeVisible(); // RERA
    await expect(main.getByText("Unverified").first()).toBeVisible(); // address / construction status
    await expect(main.getByText(/RERA registration is not (proof of clear title|title clearance)/i).first()).toBeVisible();
    await expect(main.getByText(/^Sample data$/)).toHaveCount(0); // staff-created, not a fixture
  });

  test("history lists creation, fact edits, the verification change and publish", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl);
    const history = ui.history(page);
    await expect(history).toBeVisible();
    const rows = history.getByRole("row");
    await expect(rows.filter({ hasText: /created/ })).toHaveCount(1);
    await expect(rows.filter({ hasText: /fact set/ })).toHaveCount(4); // 3 facts + the stale-tab re-save
    await expect(rows.filter({ hasText: /verification changed/ }).filter({ hasText: "Unverified → Reviewed" })).toHaveCount(1);
    await expect(rows.filter({ hasText: /^(?!.*unpublished).*published/ })).toHaveCount(1);
    await expect(rows.filter({ hasText: "RERA registration numbers" }).first()).toBeVisible();
    await expect(rows.filter({ hasText: "admin" }).first()).toBeVisible();
  });

  test("re-editing RERA on a published project auto-unpublishes it with a notice", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADMIN_DEV_PASSWORD);
    await page.goto(projectUrl);
    await expect(page.getByText("Published").first()).toBeVisible();

    const card = ui.fact(page, "reraNumbers");
    await card.getByText("Edit fact and sources").click();
    await card.locator("#reraNumbers-value").fill(RERA_CORRECTED);
    await card.locator("#reraNumbers-s0-id").selectOption("sample-feed");
    await card.getByRole("button", { name: "Now" }).first().click();
    await card.getByRole("button", { name: "Save fact" }).click();
    await expectStillSignedIn(page, "RERA re-edit");
    await expect(card.getByRole("status").filter({ hasText: /fact saved as unverified/i })).toBeVisible();
    const notice = card.getByRole("alert").filter({ hasText: "Project unpublished" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(/no longer meets the publish rules/i);

    await page.reload();
    await expect(page.getByText("Unpublished").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "View public page" })).toHaveCount(0);
    await expect(ui.history(page).getByRole("row").filter({ hasText: "auto: failed readiness after edit" })).toHaveCount(1);
    await expectNotPublic(page);
  });
});

test.describe("M3 advisor restrictions", () => {
  test("advisor sees no Publish control and cannot choose Reviewed / Source confirmed", async ({ page }) => {
    test.skip(!projectUrl, "depends on the create test");
    await signIn(page, E2E_ADVISOR_DEV_PASSWORD);
    await expect(page.getByRole("navigation", { name: "Staff" }).locator("..").getByText("advisor")).toBeVisible();
    await page.goto(projectUrl);
    await expectStillSignedIn(page, "advisor opening project");
    await expect(page.getByRole("heading", { level: 1, name: PROJECT_NAME })).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Publish|Unpublish)$/ })).toHaveCount(0);
    await expect(ui.publishing(page).getByText("Only an admin can publish or unpublish.")).toBeVisible();

    for (const field of ["reraNumbers", "address", "constructionStatus"] as const) {
      const card = ui.fact(page, field);
      await expect(card.getByText("Only an admin can mark a fact Source confirmed or Reviewed.")).toBeVisible();
      const select = card.getByLabel("Change verification to");
      if (await select.count()) {
        const labels = await select.locator("option").allTextContents();
        expect(labels, field).not.toContain("Reviewed");
        expect(labels, field).not.toContain("Source confirmed");
        expect(labels, field).not.toContain("Unverified"); // resets are admin-only
      }
    }
    // Advisors can still edit facts (always saved as Unverified).
    await expect(ui.fact(page, "address").getByText("Edit fact and sources")).toBeVisible();
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
