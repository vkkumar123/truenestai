import { defineConfig, devices } from "@playwright/test";
import { E2E_ADMIN_DEV_PASSWORD, E2E_ADVISOR_DEV_PASSWORD, E2E_TEST_ONLY_SESSION_SECRET } from "./e2e/support";

// E2E journeys (J1–J7) run against `next dev` in fixture mode, not `next start`:
// the dev-only admin password login is refused whenever NODE_ENV=production, and fixture
// discovery sources (Lane B) never run in production either.
// Browsers: locally use the preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH); CI installs it.

const PORT = 3200;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one dev server with an in-memory lead store; keep journeys deterministic
  timeout: 90_000, // dev mode compiles routes on first request
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATA_BACKEND: "fixture",
      ADMIN_DEV_PASSWORD: E2E_ADMIN_DEV_PASSWORD,
      ADMIN_DEV_ADVISOR_PASSWORD: E2E_ADVISOR_DEV_PASSWORD,
      SESSION_SECRET: E2E_TEST_ONLY_SESSION_SECRET,
      MIN_RESEARCHED_RESULTS: "3",
      LEAD_RATE_LIMIT_MAX: "100",
      LEAD_RATE_LIMIT_WINDOW_SECONDS: "600",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
