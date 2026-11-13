/**
 * Phone-width layout check (mobile plan 2026-11-13, step 7). Needs a running server:
 *   KV_ALLOW_LOCAL=1 PORT=3100 pnpm start   then   BASE=http://localhost:3100 pnpm test:phone-widths
 * For each page at 360, 390 and 430 px wide (touch, DPR 3): no sideways scroll, and every visible button / link / tab is
 * at least 32 px in its smaller side (the 44 px goal is reported, not failed, so this can gate today and tighten later).
 * SHOTS=dir also saves a screenshot per page and width.
 */
import { createRequire } from "node:module";
// playwright or playwright-core, wherever it is installed (CJS require also honours NODE_PATH)
const req = createRequire(import.meta.url);
const { chromium } = (() => { for (const m of ["playwright", "playwright-core"]) { try { return req(m); } catch { /* next */ } } throw new Error("install playwright to run this check"); })();
import fs from "node:fs";
const BASE = process.env.BASE || "http://localhost:3100";
const PAGES = (process.env.PAGES || "/,/how-it-works,/rocket,/leaderboard,/profile,/flight/sim,/flight/sim?autostart=1&seed=7").split(",");
const WIDTHS = [360, 390, 430];
const SHOTS = process.env.SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let fail = 0;
const browser = await chromium.launch();
for (const w of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  for (const path of PAGES) {
    const page = await ctx.newPage();
    try { await page.goto(BASE + path, { waitUntil: "load", timeout: 60000 }); } catch (e) { console.log(`FAIL ${w}px ${path}: ${String(e).slice(0, 80)}`); fail++; await page.close(); continue; }
    await page.waitForTimeout(2500);
    const r = await page.evaluate(() => {
      const sw = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), vw = innerWidth;
      const small = [], tiny = [];
      for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [role="switch"]')) {
        const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (!b.width || !b.height || cs.visibility === "hidden" || cs.display === "none" || b.bottom < 0 || b.top > innerHeight * 3) continue;
        if (el.closest('[aria-hidden="true"], nav[aria-label="Footer"], footer')) continue;   // footers: text links
        const m = Math.min(b.width, b.height), label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("data-testid") || el.tagName).trim().slice(0, 30);
        if (m < 32) tiny.push(`${label} ${Math.round(b.width)}x${Math.round(b.height)}`); else if (m < 44) small.push(label);
      }
      return { over: sw - vw, tiny, small: small.length };
    });
    const bad = r.over > 1 || r.tiny.length > 0;
    console.log(`${bad ? "FAIL" : "ok  "} ${w}px ${path}: sideways ${r.over > 1 ? r.over + "px" : "none"} · under-32px targets ${r.tiny.length}${r.tiny.length ? " [" + r.tiny.slice(0, 6).join(" | ") + "]" : ""} · 32-43px ${r.small}`);
    if (bad) fail++;
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${w}${path.replace(/[/?&=]/g, "_") || "_lobby"}.png`, timeout: 15000 }).catch(() => {});
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(fail ? `${fail} page(s) need work` : "all phone widths ok");
process.exit(fail ? 1 : 0);
