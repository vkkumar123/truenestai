// Shared constants for e2e journeys. Test-only values: they unlock nothing outside the
// in-memory fixture backend running under `next dev` (see playwright.config.ts).
export const E2E_ADMIN_DEV_PASSWORD = "e2e-admin-password-123";
export const E2E_TEST_ONLY_SESSION_SECRET = "e2e-test-only-session-secret-not-a-real-secret-0"; // 48 chars

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
