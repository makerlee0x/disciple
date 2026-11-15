// Builds web/public/turbo/royale/play.html (Turbo Royale, practice mode) from royale.tpl.html.
// The page uses the Trading Duel's own CSS, pulled from web/public/turbo/duel/engine.js, so the two modes always look the same.
// Run from the repo root: node tools/royale/build.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const engine = readFileSync(join(root, "web/public/turbo/duel/engine.js"), "utf8");
const m = engine.match(/const CSS=(".*?");\n/s);
if (!m) throw new Error("duel CSS not found in engine.js");
const css = JSON.parse(m[1]);

// relative to /turbo/royale/play.html, so it works under any base path
const assets = {
  ...Object.fromEntries(["rocket", "sky0", "sky1", "sky2", "sky3", "sky4"].map((k) => [k, `../duel/${k}.webp`])),
  skyEth: "../sky-eth.webp",
  skyBtc: "../sky-btc.webp",
  art: "../../art/modes/last-pilot.webp",
};
// rival skins, air-drop pods and gun icons (PR 399 art, shrunk to game size as WebP in ./art)
for (const f of readdirSync(join(root, "web/public/turbo/royale/art"))) if (f.endsWith(".webp")) assets[f.slice(0, -5)] = `art/${f}`;

let s = readFileSync(join(here, "royale.tpl.html"), "utf8");
s = s.replace("/*DUELCSS*/", () => css).replace("%%ASSETS%%", () => JSON.stringify(assets));
writeFileSync(join(root, "web/public/turbo/royale/play.html"), s);
console.log("wrote web/public/turbo/royale/play.html", s.length, "bytes");
