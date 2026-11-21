/**
 * Phone load + idle-cost check (perf pass 2026-11-21). Opens each page as the iPhone app does (iPhone UA + "DiscipleApp/1")
 * on a throttled phone network and a 4x slower CPU, then reports what it downloaded, when it painted, and what it costs
 * while it just sits there (CPU time per 10 s, visible and hidden; heap; DOM nodes).
 *
 *   pnpm build && pnpm exec next start -p 3100   (any env that serves pages)
 *   node scripts/perf-mobile.mjs [baseUrl] [--net=4g|3g] [--json=out.json] [/path ...]
 */
import { chromium, devices } from "@playwright/test";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a)) || "http://localhost:3100";
const net = (args.find((a) => a.startsWith("--net=")) || "--net=3g").slice(6);
const jsonOut = (args.find((a) => a.startsWith("--json=")) || "").slice(7);
const paths = args.filter((a) => a.startsWith("/"));
const PAGES = paths.length ? paths : ["/", "/turbo", "/turbo/duel", "/turbo/royale", "/turbo/climb", "/duel"];
// DevTools presets: "Fast 3G" ≈ 1.6 Mbps / 150 ms (a phone on a weak signal); "4G" ≈ 9 Mbps / 60 ms
const NET = net === "4g" ? { latency: 60, downloadThroughput: (9e6 / 8), uploadThroughput: (4e6 / 8) } : { latency: 150, downloadThroughput: (1.6e6 / 8) * 0.9, uploadThroughput: (750e3 / 8) * 0.9 };

const phone = devices["iPhone 13"];
const browser = await chromium.launch();
const out = [];
for (const path of PAGES) {
  const ctx = await browser.newContext({ ...phone, userAgent: `${phone.userAgent} DiscipleApp/1`, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, ...NET });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  const reqs = new Map(); let sameJs = 0, sameAll = 0, n = 0, ext = 0;
  cdp.on("Network.responseReceived", (e) => reqs.set(e.requestId, { url: e.response.url, type: e.type }));
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId); if (!r) return;
    n++;
    if (r.url.startsWith(base)) { sameAll += e.encodedDataLength; if (r.type === "Script") sameJs += e.encodedDataLength; } else ext++;
  });
  await page.addInitScript(() => {
    window.__lcp = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
  });
  const t0 = Date.now();
  await page.goto(base + path, { waitUntil: "load", timeout: 180_000 }).catch((e) => console.error(path, e.message));
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(8_000); // let lazy chunks (Privy, sounds) land
  const paint = await page.evaluate(() => ({
    fcp: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0),
    lcp: Math.round(window.__lcp || 0),
    dcl: Math.round(performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? 0),
  }));
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  // idle cost while visible
  const a = await metrics(); await page.waitForTimeout(10_000); const b = await metrics();
  // idle cost while the app is in the background (the page is told it's hidden, as iOS does when you switch apps)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1_000);
  const c = await metrics(); await page.waitForTimeout(10_000); const d = await metrics();
  const row = {
    path, loadMs, ...paint, requests: n, external: ext,
    jsKB: Math.round(sameJs / 1024), totalKB: Math.round(sameAll / 1024),
    cpuVisibleMsPer10s: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
    cpuHiddenMsPer10s: Math.round((d.TaskDuration - c.TaskDuration) * 1000),
    heapMB: +(b.JSHeapUsedSize / 1048576).toFixed(1), nodes: b.Nodes,
  };
  out.push(row);
  console.log(JSON.stringify(row));
  await ctx.close();
}
await browser.close();
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
