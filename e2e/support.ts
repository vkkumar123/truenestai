import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
// Shared constants for e2e journeys. Test-only values: they unlock nothing outside the
// in-memory fixture backend running under `next dev` (see playwright.config.ts).
export const E2E_ADMIN_DEV_PASSWORD = "e2e-admin-password-123";
export const E2E_ADVISOR_DEV_PASSWORD = "e2e-advisor-password-456"; // test-only; must differ from the admin one
export const E2E_TEST_ONLY_SESSION_SECRET = "e2e-test-only-session-secret-not-a-real-secret-0"; // 48 chars
/** Test-only worker trigger secret (>= 32 chars); fixture mode only, so the run uses the fake client. */
export const E2E_RESEARCH_RUN_SECRET = "e2e-test-only-research-run-secret-not-real-00"; // 45 chars

// Fixture facts the journeys rely on (src/server/repositories/fixture/sample-projects.ts,
// src/discovery/fixtures.ts). Thanisandra has 1 published researched project (< MIN_RESEARCHED_RESULTS=3),
// so a Thanisandra search also shows the Lane B listing "SAMPLE Riverbend Homes".
export const LANE_B_LOCALITY = "thanisandra";
export const LANE_A_IN_LANE_B_LOCALITY = "SAMPLE Riverside Thanisandra";
export const LANE_B_TITLE = /SAMPLE Riverbend Homes/;
export const LANE_B_URL = "https://example.com/sample/riverbend-homes";

export const PROJECT_MOSTLY_UNKNOWN = { slug: "sample-jakkur-lakeside", name: "SAMPLE Jakkur Lakeside", id: "sample-proj-jakkur" };
export const PROJECT_LAKEVIEW = { slug: "sample-lakeview-residences", name: "SAMPLE Lakeview Residences", id: "sample-proj-lakeview" };
export const PROJECT_NORTHWIND = { slug: "sample-northwind-heights", name: "SAMPLE Northwind Heights", id: "sample-proj-northwind" };
export const UNPUBLISHED = { slug: "sample-unpublished-draft", name: "SAMPLE Unpublished Draft", id: "sample-proj-unpublished" };
export const FIVE_PROJECT_IDS = [
  "sample-proj-lakeview",
  "sample-proj-northwind",
  "sample-proj-orchard",
  "sample-proj-courtyard",
  "sample-proj-riverside",
];

// ---------------------------------------------------------------------------
// Staff sessions. The sign-in action is throttled (10 attempts / 15 min per client, see
// src/server/services/login-throttle.ts), so specs reuse sessions saved once by
// e2e/auth.setup.ts instead of signing in through the UI in every test. Only the tests that are
// about the login form itself use the form.
// ---------------------------------------------------------------------------

export type StaffRoleName = "admin" | "advisor";
export const AUTH_DIR = path.join(os.tmpdir(), "truenest-e2e-auth");
export const authStatePath = (role: StaffRoleName) => path.join(AUTH_DIR, `${role}.json`);
export const STAFF_PASSWORD: Record<StaffRoleName, string> = { admin: E2E_ADMIN_DEV_PASSWORD, advisor: E2E_ADVISOR_DEV_PASSWORD };

/** Adds the saved staff session cookie for `role` to this page's context. */
export async function applyStaffSession(page: Page, role: StaffRoleName) {
  type Cookies = Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>;
  const state = JSON.parse(readFileSync(authStatePath(role), "utf8")) as { cookies: Cookies };
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies);
}

/** A separate browser context signed in as `role` (for multi-user journeys). */
export async function staffContext(browser: Browser, role: StaffRoleName) {
  const context = await browser.newContext({ storageState: authStatePath(role) });
  const page = await context.newPage();
  await page.goto("/admin/leads");
  await expect(page.getByRole("navigation", { name: "Staff" })).toBeVisible();
  return { context, page };
}
