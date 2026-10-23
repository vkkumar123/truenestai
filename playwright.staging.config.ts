import { defineConfig, devices } from "@playwright/test";

// Live smoke tests against a deployed environment (no local server). Run only from the
// "Staging smoke" workflow: `STAGING_URL=https://… npx playwright test -c playwright.staging.config.ts`.
// They use real data and may start one paid research job per run.
const BASE_URL = process.env.STAGING_URL;
if (!BASE_URL) throw new Error("STAGING_URL is required for staging smoke tests");

export default defineConfig({
  testDir: "./e2e-staging",
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure", navigationTimeout: 60_000, ...devices["Desktop Chrome"] },
});
