// Cloud-style exploration shots: STYLES × TIERS → /workspace/disciple-shots/clouds-<style>-<tier>.png (canvas only).
// Usage: BASE=http://127.0.0.1:3070 node scripts/shots-clouds.mjs
import { chromium } from "playwright-core";
import fs from "fs";
const BASE = process.env.BASE || "http://127.0.0.1:3070";
const OUT = process.env.OUT || "/workspace/disciple-shots";
const COIN = "/coin/0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d";
const STYLES = (process.env.STYLES || "current,cel,puff,ink,cirrus").split(",");
const TIERS = [{ name: "low", mcap: 9500 }, { name: "high", mcap: 520000 }].filter((t) => !process.env.TIER || t.name === process.env.TIER);
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome-stable", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
for (const st of STYLES) for (const t of TIERS) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const q = st === "current" ? "" : `&clouds=${st}`;
  await page.goto(`${BASE}${COIN}?replay=1${q}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => window.__flight && window.__flight.assetsReady(), null, { timeout: 120000 });
  const target = await page.evaluate((m) => window.__flight.mcapToAlt(m), t.mcap);
  for (let i = 0; i < 40; i++) {
    await page.evaluate((m) => window.__flight.setMcap(m), t.mcap);
    await page.waitForTimeout(500);
    const ca = await page.evaluate(() => window.__flight.S.camAlt ?? window.__flight.S.displayAlt);
    if (Math.abs(ca - target) < 0.04 && i > 3) break;
  }
  await page.evaluate(() => window.__flightPerf.reset());
  await page.waitForTimeout(3000);   // also a 3 s frame-time sample (headless, shared box: relative numbers only)
  const info = await page.evaluate(() => { const P = window.__flightPerf; return { alt: +window.__flight.S.displayAlt.toFixed(3), mcap: Math.round(window.__flight.markMcap()), frames: P.n, avgMs: +(P.sum / Math.max(1, P.n)).toFixed(2), long25: P.long25, maxMs: +P.max.toFixed(1) }; });
  const file = `${OUT}/clouds-${st}-${t.name}.png`;
  // raw game canvas pixels (skips the DOM panels / dev overlay layered over it)
  const url = await page.evaluate(() => document.getElementById("c").toDataURL("image/png"));
  fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
  console.log(file, JSON.stringify(info), errs.length ? "ERR " + errs.slice(0, 3).join(" | ") : "");
  await page.close();
}
await browser.close();
