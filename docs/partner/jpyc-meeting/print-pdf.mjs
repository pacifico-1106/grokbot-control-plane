import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const executablePath = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "/usr/bin/google-chrome-stable";
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
for (const [h,p] of [["agenda-one-pager.html","agenda-one-pager.pdf"],["architecture-overview.html","architecture-overview.pdf"]]) {
  const page = await browser.newPage();
  await page.goto("file://" + path.join(dir,h), { waitUntil: "networkidle" });
  await page.pdf({ path: path.join(dir,p), format: "A4", printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
  console.log("wrote", p);
  await page.close();
}
await browser.close();
