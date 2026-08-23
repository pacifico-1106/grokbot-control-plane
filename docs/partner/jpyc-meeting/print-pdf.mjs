import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
for (const [h,p] of [["agenda-one-pager.html","agenda-one-pager.pdf"],["architecture-overview.html","architecture-overview.pdf"]]) {
  const page = await browser.newPage();
  await page.goto("file://" + path.join(dir,h), { waitUntil: "networkidle" });
  await page.pdf({ path: path.join(dir,p), format: "A4", printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
  console.log("wrote", p);
  await page.close();
}
await browser.close();
