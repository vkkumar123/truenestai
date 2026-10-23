// Diagnostic only: runs one real buyer search on staging in a browser and reports what renders.
import { chromium } from "@playwright/test";

const base = process.env.STAGING_URL;
const q = process.env.QUERY || "Assetz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const browser = await chromium.launch();
const page = await browser.newPage({ userAgent: UA });
page.on("response", (r) => {
  if (r.request().method() === "POST") console.log(`POST ${r.url()} -> ${r.status()}`);
});
const url = `${base}/projects?q=${encodeURIComponent(q)}`;
const text = async () => (await page.locator("main").innerText().catch(() => page.locator("body").innerText())).replace(/\n{2,}/g, "\n").slice(0, 2500);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(8000);
console.log("=== first load ===\n" + (await text()));
await page.screenshot({ path: "shot-0.png", fullPage: true });
for (let i = 1; i <= 9; i++) {
  await page.waitForTimeout(60_000);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(5000);
  const t = await text();
  console.log(`=== reload ${i} ===\n` + t.slice(0, 1200));
  if (/^\s*[1-9]\d* results?/m.test(t)) {
    await page.screenshot({ path: "shot-final.png", fullPage: true });
    break;
  }
}
await page.screenshot({ path: "shot-final.png", fullPage: true });
await browser.close();
