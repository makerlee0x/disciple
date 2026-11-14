// Renders the app icon (1024, no transparency) and the launch splash (2732) from the site's brand mark.
// Run from mobile/: node scripts/make-assets.mjs   (needs Playwright's Chromium, as the web e2e suite does)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "web/package.json"));
const { chromium } = require("playwright");
const mark = readFileSync(path.join(root, "web/public/brand/disciple-mark-light.svg"), "utf8");
const set = path.join(root, "mobile/ios/App/App/Assets.xcassets");
const BG = "#0B0C0E";

const page = (size, markPct, glow) => `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:${BG};display:flex;align-items:center;justify-content:center">
<div style="width:${markPct}%;height:${markPct}%;display:flex;${glow ? "filter:drop-shadow(0 0 " + size * 0.03 + "px rgba(242,214,160,.35))" : ""}">${mark.replace(/<svg/, '<svg width="100%" height="100%"')}</div></body></html>`;

const browser = await chromium.launch();
const shot = async (size, pct, glow, out) => {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(page(size, pct, glow));
  await p.screenshot({ path: out, omitBackground: false, type: "png" });
  await p.close();
};
await shot(1024, 72, true, path.join(set, "AppIcon.appiconset/AppIcon-512@2x.png"));
for (const f of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) await shot(2732, 14, true, path.join(set, "Splash.imageset", f));
await browser.close();
console.log("icon + splash written");
