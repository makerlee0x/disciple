import { chromium } from "playwright-core";
import fs from "fs";
const BASE = "http://127.0.0.1:3051";
const OUT = "/workspace/disciple-shots";
const AI_ICON = "https://cdn.dexscreener.com/cms/images/U6RIzs8Fm7Jar6GE?width=256&height=256&quality=95&format=png";
const shots = [
  { path: "/create", file: "launch.png", wait: 1500 },
  { path: "/create", file: "launch-advanced.png", wait: 1500, act: async (p) => { await p.getByRole("button", { name: /ADVANCED/ }).click(); await p.waitForTimeout(300); } },
  { path: "/", file: "home-verified.png", wait: 3000, act: async (p) => { await p.getByRole("button", { name: "Verified only" }).click(); await p.waitForTimeout(400); } },
  { path: "/coin/0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d?replay=1", file: "coin-crew.png", wait: 6000, full: false },
  { path: "/coin/0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d?replay=1&cs=AI&icon=" + encodeURIComponent(AI_ICON), file: "rocket-decal.png", wait: 7000, full: false },
  { path: "/create", file: "create-decal.png", wait: 1500, act: async (p) => {
      await p.getByRole("button", { name: /ADVANCED/ }).click();
      await p.setInputFiles('input[type="file"]', "public/test-icons/wide.png");
      await p.waitForSelector("text=Icon approved", { timeout: 60000 });
      await p.waitForTimeout(800);
  } },
  { path: "/coin/0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d?replay=1&cs=AI&icon=" + encodeURIComponent(AI_ICON), file: "share-card.png", wait: 7000, share: true },
];
const browser = await chromium.launch({ headless: true, executablePath: "/usr/bin/google-chrome-stable", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const errors = {};
for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const cons = [];
  page.on("console", (m) => { if (m.type() === "error") cons.push(m.text()); });
  page.on("pageerror", (e) => cons.push("PAGEERROR: " + e.message));
  await page.goto(BASE + s.path, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(s.wait);
  if (s.act) await s.act(page);
  if (s.share) {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Share rocket card" }).click()]);
    await dl.saveAs(`${OUT}/${s.file}`);
  } else await page.screenshot({ path: `${OUT}/${s.file}`, fullPage: s.full !== false });
  errors[s.file] = cons;
  await page.close();
}
await browser.close();
fs.writeFileSync(`${OUT}/console.json`, JSON.stringify(errors, null, 2));
console.log(JSON.stringify(errors, null, 2));
