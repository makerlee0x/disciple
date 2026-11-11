/**
 * Desktop (1280x800) and phone (390x844) screenshots for the header gear, sidebar mini profile, and Deposit screen.
 * Uses NEXT_PUBLIC_SHOT_MOCK=1 (a mocked signed-in state). Not used in Production.
 *
 *   NEXT_PUBLIC_SHOT_MOCK=1 npx next dev -p 3017
 *   node scripts/shots-header-sidebar.mjs
 *
 * PLAYWRIGHT_CORE can point at a local playwright-core install if it is not in node_modules.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const pwCandidates = [
  process.env.PLAYWRIGHT_CORE,
  "playwright-core",
  "/tmp/pw-shots/node_modules/playwright-core",
].filter(Boolean);
let chromium;
for (const cand of pwCandidates) {
  try {
    ({ chromium } = require(cand));
    break;
  } catch {
    /* try next */
  }
}
if (!chromium) throw new Error("playwright-core not found; set PLAYWRIGHT_CORE");

const BASE = process.env.SHOT_BASE || "http://127.0.0.1:3017";
const OUT = process.env.SHOT_OUT || "/workspace/v1-header-shots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME || "/usr/bin/google-chrome-stable",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

async function gotoRetry(page, url) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    } catch (err) {
      last = err;
      console.warn("goto retry", i + 1, err.message);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw last;
}

async function dismissOverlays(page) {
  const close = page.locator('button[aria-label="Close How DISCIPLE works"]');
  if (await close.isVisible().catch(() => false)) await close.click();
}

async function shot({ name, viewport, path: urlPath, setup }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.addInitScript(() => {
    try { localStorage.setItem("dsc_hiw_seen_v1", "1"); } catch { /* ignore */ }
  });
  const cons = [];
  page.on("pageerror", (err) => cons.push("PAGEERROR: " + err.message));
  const resp = await gotoRetry(page, BASE + urlPath);
  await page.waitForTimeout(1500);
  await dismissOverlays(page);
  if (setup) await setup(page);
  await page.waitForTimeout(500);
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  await page.close();
  console.log("saved", file, "status", resp?.status(), "errors", cons.slice(0, 3));
}

const desktop = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };

const openDrawer = async (page) => {
  const reopen = page.locator("#apReopen");
  if (await reopen.isVisible().catch(() => false)) await reopen.click();
  else {
    const tog = page.locator("#apSide .ap-tog, #apSide button[aria-label='Toggle menu']").first();
    if (await tog.isVisible().catch(() => false)) await tog.click();
  }
  await page.waitForSelector('[data-testid="side-account"]', { timeout: 8000 });
};

await shot({ name: "desktop-header.png", viewport: desktop, path: "/" });
await shot({ name: "desktop-sidebar.png", viewport: desktop, path: "/" });
await shot({ name: "desktop-deposit.png", viewport: desktop, path: "/wallet" });
await shot({ name: "phone-header.png", viewport: phone, path: "/" });
await shot({ name: "phone-sidebar.png", viewport: phone, path: "/", setup: openDrawer });
await shot({ name: "phone-deposit.png", viewport: phone, path: "/wallet" });

await browser.close();
console.log("DONE", OUT);
