import { chromium } from "playwright-core";
const BASE = process.env.BASE || "http://127.0.0.1:3011";
const OUT = "/workspace/disciple-shots";
const URL_ = BASE + "/coin/0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d?replay=1&graduated=1&zoom=1";
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome-stable", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(() => localStorage.removeItem("disciple.tw.v1"));
await page.waitForSelector('[data-testid="tw-open"]', { timeout: 30000 });
await page.waitForTimeout(2500);
// place a tramp
await page.click('[data-testid="tw-open"]');
await page.waitForSelector('[data-testid="tw-modal"]');
await page.locator('input[type=range]').first().fill("-4");
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/tw-modal.png` });
await page.click('[data-testid="tw-confirm"]');
// place a wall
await page.click('[data-testid="tw-open"]');
await page.click('[data-testid="tw-kind-wall"]');
await page.locator('input[type=range]').first().fill("3");
await page.waitForTimeout(300);
await page.click('[data-testid="tw-confirm"]');
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/tw-chart.png` });
// heading invariant check
const h = await page.evaluate(() => { const S = window.__flight.S; return { aim: S.aimDisp, shakes: (S.camShakes || []).length }; });
console.log("heading", JSON.stringify(h), "pageerrors", errs);
await browser.close();
