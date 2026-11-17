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
// the flying clouds are shared too: the block between /*FLYSKY{*/ and /*}FLYSKY*/ in the duel engine
const fly = engine.match(/\/\*FLYSKY\{\*\/[\s\S]*?\/\*\}FLYSKY\*\//);
if (!fly) throw new Error("FLYSKY block not found in engine.js");

// relative to /turbo/royale/play.html, so it works under any base path
const assets = {
  ...Object.fromEntries(["rocket", "sky0", "sky1", "sky2", "sky3", "sky4"].map((k) => [k, `../duel/${k}.webp`])),
  skyEth: "../sky-eth.webp",
  skyBtc: "../sky-btc.webp",
  skyPad: "../../home/pad/sky-1280.webp",
  art: "../../art/modes/last-pilot.webp",
};
// rival skins, air-drop pods and gun icons (PR 399 art, shrunk to game size as WebP in ./art)
for (const f of readdirSync(join(root, "web/public/turbo/royale/art"))) if (f.endsWith(".webp")) assets[f.slice(0, -5)] = `art/${f}`;

// bot rockets fly the real Hangar skins (public/turbo/skins/<hull>--<paint>.webp, the same art the launch pad and
// Free play use), named and rarity-tinted from lib/collection.ts PAINTS / HULL_NAMES. The ring-tail (Prestige 1 hull) and
// the classic rocket stay out of the bot pool.
const coll = readFileSync(join(root, "web/lib/collection.ts"), "utf8");
const block = (name) => { const b = coll.match(new RegExp(`export const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\};`)); if (!b) throw new Error(name + " not found in collection.ts"); return b[1]; };
const paints = {};
for (const m2 of block("PAINTS").matchAll(/"?([a-z][\w-]*)"?:\s*\{\s*name:\s*"([^"]+)",\s*rar:\s*"(\w+)"/g)) paints[m2[1]] = [m2[2], m2[3]];
const hullNames = {};
for (const m2 of block("HULL_NAMES").matchAll(/"?([a-z][\w-]*)"?:\s*"([^"]+)"/g)) hullNames[m2[1]] = m2[2];
const skins = [];
for (const f of readdirSync(join(root, "web/public/turbo/skins")).sort()) {
  const mm = f.match(/^([a-z-]+)--([a-z-]+)\.webp$/); if (!mm) continue;
  const [, hull, paint] = mm; if (hull === "ring-tail" || !hullNames[hull] || !paints[paint]) continue;
  skins.push([hull, paint, hullNames[hull], paints[paint][0], paints[paint][1]]);
}
if (skins.length < 20) throw new Error("too few bot skins: " + skins.length);

let s = readFileSync(join(here, "royale.tpl.html"), "utf8");
s = s.replace("/*FLYSKY*/", () => fly[0]).replace("/*DUELCSS*/", () => css).replace("%%ASSETS%%", () => JSON.stringify(assets)).replace("%%SKINS%%", () => JSON.stringify(skins));
writeFileSync(join(root, "web/public/turbo/royale/play.html"), s);
console.log("wrote web/public/turbo/royale/play.html", s.length, "bytes");
