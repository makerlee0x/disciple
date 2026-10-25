// Dev-only screenshots of /turbo-lab (practice adapter). Needs a dev server: BASE=http://127.0.0.1:3317 node scripts/turbo-shots.mjs
import { chromium } from "playwright-core";
import fs from "fs";
const BASE = process.env.BASE || "http://127.0.0.1:3317";
const OUT = process.env.OUT || "/workspace/disciple-shots/turbo";
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome-stable", args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function setup(viewport, isMobile = false) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: isMobile ? 2 : 1, isMobile, hasTouch: isMobile });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}/turbo-lab?turbo=1`, { waitUntil: "networkidle", timeout: 120000 });
  await page.evaluate(() => { localStorage.removeItem("disciple.turbo.prefs.v1"); localStorage.setItem("disciple.turbo.fuel.v1", JSON.stringify({ v: 1, usd: 0 })); });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="turbo-root"]', { timeout: 60000 });
  await wait(1200);
  return page;
}
const lab = (page, fn, arg) => page.evaluate(fn, arg);
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log("shot", name); };
const closeAll = (page) => lab(page, async () => { const a = window.__turboLab.adapter; for (const p of await a.getPositions()) if (p.status === "open") await a.close(p.id, 100); });
const pin = (page, frac) => lab(page, async (f) => { const a = window.__turboLab.adapter; const [p] = await a.getPositions(); if (p) a.setPrice(p.market, p.entry + (p.liqPrice - p.entry) * f); }, frac);
const open = async (page, btn) => { await page.click(`[data-testid="${btn}"]`); await wait(300); await lab(page, () => window.__turboLab.adapter.flushFills()); await wait(250); };

// ---------- desktop ----------
{
  const page = await setup({ width: 1440, height: 900 });
  await shot(page, "d0-empty-fuel");
  await page.click('[data-testid="turbo-addfuel"]'); await wait(200);
  await shot(page, "d1-fuel-panel");
  await page.click(".tb-add.big"); await page.click(".tb-fuelpop .tb-edit"); await wait(500);
  await shot(page, "d2-idle");
  await page.click('[data-testid="turbo-boost"]'); await wait(400);
  await shot(page, "d3-long-pending");
  await lab(page, () => window.__turboLab.adapter.flushFills()); await wait(1200);
  await pin(page, -0.25); await wait(150);
  await shot(page, "d4-long-100x");
  await page.click('[data-testid="turbo-close-25"]'); await wait(300);
  await shot(page, "d5-closed-25");
  await closeAll(page); await wait(600);
  await page.click('[data-testid="turbo-lev-3"]'); await wait(300);
  await shot(page, "d6-headsup-1000x");
  await page.click('[data-testid="turbo-headsup-ok"]'); await wait(300);
  await open(page, "turbo-boost"); await pin(page, -0.1); await wait(700);
  await shot(page, "d7-long-1000x-jetstream");
  await closeAll(page); await wait(800);
  await page.click('[data-testid="turbo-share-close"]').catch(() => {});
  await page.click('[data-testid="turbo-lev-1"]'); await wait(200);
  await open(page, "turbo-dump"); await pin(page, -0.1); await wait(700);
  await shot(page, "d8-short-dive-250x");
  await pin(page, 0.6); await wait(300); await shot(page, "d9-danger-hot");
  await pin(page, 0.985); await wait(300); await shot(page, "d10-danger-about-to-blow");
  await pin(page, 1.05); await wait(1100);
  await shot(page, "d11-supernova-early");
  await wait(900); await shot(page, "d12-supernova-mid");
  await page.waitForSelector(".tb-share", { timeout: 8000 }).catch(() => {}); await wait(700);
  await shot(page, "d13-share-wipeout");
  await page.click('[data-testid="turbo-again"]').catch(() => {}); await wait(400);
  // big win share
  await page.click('[data-testid="turbo-lev-0"]'); await wait(200);
  await open(page, "turbo-boost"); await pin(page, -1.2); await wait(300); await closeAll(page);
  await page.waitForSelector(".tb-share", { timeout: 5000 }).catch(() => {}); await wait(700);
  await shot(page, "d14-share-bigwin");
  await page.close();
}
// ---------- phone 390x844 ----------
{
  const page = await setup({ width: 390, height: 844 }, true);
  await page.click('[data-testid="turbo-addfuel"]'); await wait(200);
  await page.click(".tb-add.big"); await page.click(".tb-fuelpop .tb-edit"); await wait(500);
  await shot(page, "p1-idle");
  await page.click('[data-testid="turbo-phone-pick"]'); await wait(400);
  await shot(page, "p2-picker-sheet");
  await page.click('[data-testid="turbo-lev-1"]'); await page.click(".tb-sh-head .tb-edit"); await wait(300);
  await open(page, "turbo-boost"); await pin(page, -0.2); await wait(700);
  await shot(page, "p3-long-250x");
  await page.click('[data-testid="turbo-phone-card"]'); await wait(300);
  await shot(page, "p4-position-card");
  await page.click('[data-testid="turbo-phone-card"]');
  await pin(page, 0.9); await wait(400); await shot(page, "p5-danger");
  await pin(page, 1.05); await wait(1800); await shot(page, "p6-supernova");
  await page.waitForSelector(".tb-share", { timeout: 8000 }).catch(() => {}); await wait(700);
  await shot(page, "p7-share");
  await page.click('[data-testid="turbo-again"]').catch(() => {}); await wait(300);
  await page.click('[data-testid="turbo-phone-pick"]'); await wait(300);
  await page.click('[data-testid="turbo-lev-3"]'); await wait(400);
  await shot(page, "p8-headsup");
  await page.close();
}
await browser.close();
console.log("console errors:", errors.length ? errors.slice(0, 10) : "none");
