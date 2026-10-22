// Signs in once per staff role through the real login form and saves the session for the specs
// (see applyStaffSession / staffContext in ./support). Keeps the suite under the sign-in throttle.
import { mkdirSync } from "node:fs";
import { expect, test as setup } from "@playwright/test";
import { AUTH_DIR, authStatePath, STAFF_PASSWORD, type StaffRoleName } from "./support";

for (const role of ["admin", "advisor"] as StaffRoleName[]) {
  setup(`sign in as ${role}`, async ({ page }) => {
    mkdirSync(AUTH_DIR, { recursive: true });
    await page.goto("/admin/login");
    await page.getByLabel(/password/i).fill(STAFF_PASSWORD[role]);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/admin\/login/);
    const nav = page.getByRole("navigation", { name: "Staff" });
    await expect(nav).toBeVisible();
    await expect(nav.locator("..").getByText(role, { exact: true })).toBeVisible();
    await page.context().storageState({ path: authStatePath(role) });
  });
}
