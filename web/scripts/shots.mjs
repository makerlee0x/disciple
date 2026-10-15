import { chromium } from "playwright-core";
import fs from "fs";

const BASE = "http://127.0.0.1:3010";
const OUT = "/workspace/disciple-shots";
const pages = [
  { path: "/", file: "home.png", wait: 2500 },
  { path: "/coin/0xc4a21f9d6485fc5893dd4a491b320a83daf4da1d?replay=1", file: "coin.png", wait: 4500 },
  { path: "/create", file: "create.png", wait: 1500 },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome-stable",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const errors = {};

for (const p of pages) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cons = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") cons.push(msg.text());
  });
  page.on("pageerror", (err) => cons.push("PAGEERROR: " + err.message));
  const url = BASE + p.path;
  console.log("goto", url);
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("status", resp?.status());
  await page.waitForTimeout(p.wait);
  await page.screenshot({ path: `${OUT}/${p.file}`, fullPage: p.file !== "coin.png" });
  errors[p.file] = cons;
  await page.close();
  console.log("saved", p.file, "console errors:", cons.length, cons.slice(0, 5));
}

await browser.close();
fs.writeFileSync(`${OUT}/console.json`, JSON.stringify(errors, null, 2));
console.log("DONE", JSON.stringify(errors, null, 2));
