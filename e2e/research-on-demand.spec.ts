// M2.5 on-demand research: a free-text search that misses both lanes starts a research job with a
// POST (Server Action, auto-submitted with JS; a plain form button without JS) and shows an honest state
// (fixture mode: in-memory queue, fake client, no network). The GET render never enqueues.
import { expect, test } from "@playwright/test";
import { applyStaffSession } from "./support";

const MISS = "SAMPLE zzq e2e towers";
const NOJS_MISS = "SAMPLE zzq nojs villas";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** HTML with React's text separators removed, so adjacent text nodes match as one string. */
function textOf(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

function decodeEntities(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

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
    // Free-text result pages are not indexed.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    // Reloading reuses the same job: the server render now reads it as researching.
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: /researching/i })).toBeVisible();
  });

  test("a filtered or researched-only miss offers the unfiltered search that can research it", async ({ page }) => {
    const q = "SAMPLE zzq filtered lofts";
    await page.goto(`/projects?q=${encodeURIComponent(q)}&bhk=3&lane=researched`);
    const hint = page.getByRole("status").filter({ hasText: /Search all results to research/ });
    await expect(hint).toBeVisible();
    // Filters alone never start research.
    await expect(page.getByRole("status").filter({ hasText: /researching/i })).toHaveCount(0);
    await hint.getByRole("link", { name: `Search all results for “${q}”` }).click();
    await expect(page).toHaveURL((u) => u.pathname === "/projects" && u.searchParams.get("q") === q && !u.searchParams.has("bhk") && !u.searchParams.has("lane"));
    await expect(page.getByRole("status").filter({ hasText: /researching/i })).toBeVisible();
  });

  test("without JavaScript, the GET enqueues nothing and the plain form POST starts research", async ({ request }) => {
    // Under cacheComponents the dynamic results stream into a hidden element that an inline script
    // reveals, so a JS-less browser cannot click it. We replay exactly what a no-JS form submit sends:
    // the server-rendered MPA form (method POST, multipart, hidden action fields) to the same URL.
    const url = `/projects?q=${encodeURIComponent(NOJS_MISS)}`;
    const headers = { "user-agent": BROWSER_UA, accept: "text/html" };
    const first = await (await request.get(url, { headers })).text();
    expect(first).toMatch(/does not mean there are no projects/i);
    // The GET only offers the POST; reloading still offers it, so nothing was queued.
    const html = textOf(await (await request.get(url, { headers })).text());
    expect(html).toContain("Research this search");
    expect(html).not.toMatch(/researching “SAMPLE zzq nojs villas”/);

    const form = html.match(/<form action="" encType="multipart\/form-data" method="POST">([\s\S]*?)<\/form>/);
    expect(form, "research form is server-rendered").not.toBeNull();
    const fields: [string, string][] = [];
    for (const m of form![1].matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g)) {
      fields.push([m[1], decodeEntities(m[2] ?? "")]);
    }
    expect(Object.fromEntries(fields).q).toBe(NOJS_MISS);
    // A browser form POST carries Origin; Next rejects Server Action posts whose Origin and Host differ.
    const origin = new URL(test.info().project.use.baseURL ?? "").origin;
    // Built by hand like a browser body: Playwright's `multipart` drops empty fields, and Next needs
    // the empty $ACTION_REF_ field to recognise the form as a Server Action.
    const boundary = "----truenestE2eBoundary";
    const body = fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`;
    const res = await request.post(url, {
      headers: { ...headers, origin, "content-type": `multipart/form-data; boundary=${boundary}` },
      data: Buffer.from(body, "utf8"),
    });
    expect(res.status()).toBe(200);
    const posted = textOf(await res.text());
    expect(posted).toMatch(/researching “SAMPLE zzq nojs villas” now/);
  });

  test("robots.txt keeps crawlers off free-text search, staff pages and internal APIs", async ({ request }) => {
    const res = await request.get("/robots.txt");
    expect(res.ok()).toBe(true);
    const body = await res.text();
    expect(body).toMatch(/Disallow: \/projects\?\*q=/);
    expect(body).toMatch(/Disallow: \/admin/);
    expect(body).toMatch(/Disallow: \/api\//);
  });

  test("staff see the queued job read-only on /admin/research-jobs", async ({ page }) => {
    await page.goto(`/projects?q=${encodeURIComponent(MISS)}`);
    await expect(page.getByRole("status").filter({ hasText: /researching/i })).toBeVisible();
    await applyStaffSession(page, "advisor");
    await page.goto("/admin/research-jobs");
    await expect(page.getByRole("heading", { name: "Research jobs", level: 1 })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: MISS });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Queued|Running/);
    await expect(page.getByRole("navigation", { name: "Staff" }).getByRole("link", { name: "Research jobs" })).toBeVisible();
  });
});
