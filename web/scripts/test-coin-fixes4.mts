// game/coin-screen-fixes4: holder names, chart tiers off, sign-out un-tags '(you)', no nose-down hold after a sell.
//   Run: npm run test:coin-fixes4
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { holderDisplayName, resolveHolderNames, holderNameNow, _resetHolderNames } from "../lib/flight/holderNames";
import { clearNameCache } from "../lib/nameLookup";
import { defaultUsername, USERNAME_DISPLAY_CAP } from "../lib/defaultUsername";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
const A = "0x3dfe00000000000000000000000000000000bede", B = "0x127f0000000000000000000000000000000aca0".padEnd(42, "0");

test("holder names: @username → default call sign → short address", () => {
  assert.equal(holderDisplayName(A, "maker"), "@maker");
  assert.equal(holderDisplayName(A, null), defaultUsername(A));
  assert.ok(defaultUsername(A).length > 0);
  assert.equal(holderDisplayName("pool", null), "pool");
});

test("holder names: cached across refreshes, de-duped, ≤3 concurrent, no per-row refetch", async () => {
  clearNameCache(); _resetHolderNames();
  let calls = 0, live = 0, peak = 0;
  const fetcher = async (a: string) => { calls++; live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return a === A ? "maker" : null; };
  const addrs = [A, B, ...Array.from({ length: 8 }, (_, i) => "0x" + String(i + 1).repeat(40))];
  assert.equal(await resolveHolderNames([...addrs, A], { fetcher }), true);
  assert.equal(calls, addrs.length); assert.ok(peak <= 3, "peak " + peak);
  assert.equal(holderNameNow(A), "@maker"); assert.equal(holderNameNow(B), defaultUsername(B));
  assert.equal(await resolveHolderNames(addrs, { fetcher }), false);   // next refresh: nothing refetched
  assert.equal(calls, addrs.length);
});

test("sign-out / switch: '(you)' rows lose the tag unless they belong to the current wallet", () => {
  const blk = eng.match(/\/\* @feed-names:start[\s\S]*?\*\/([\s\S]*?)\/\* @feed-names:end \*\//)!;
  const line = (re: RegExp) => eng.match(re)![0];
  const src = [line(/^const short=.*$/m), line(/^function fillUsd\(f\).*$/m), line(/^const fmtUsd=.*$/m), "const fmtShot=v=>'$'+v.toFixed(2);", blk[1],
    "return {feedTradeRow,feedUnown,feedRelabel};"].join("\n");
  const E = new Function("window", src)({ __discipleNames: { [A]: "maker" } });
  const feed = [E.feedTradeRow("sell", 5, "(you)", A), E.feedTradeRow("buy", 3, "(you)", null), E.feedTradeRow("buy", 2, null, B)];
  E.feedUnown(feed, A); assert.match(feed[0].txt, /\(you\)$/);          // same wallet keeps it
  E.feedUnown(feed, ""); assert.match(feed[0].txt, /@maker$/); assert.match(feed[1].txt, /\?$/);
  assert.ok(!feed.some((r: { txt: string }) => r.txt.includes("(you)")));
  assert.match(eng, /disciple:wallet'[\s\S]{0,200}feedUnown\(S\.feed,S\.wallet\)/);
});

test("rocket: neither buys nor sells push the nose (angle follows price only)", () => {
  const fn = eng.match(/function applyThrust\([\s\S]*?\n}/)![0];
  assert.ok(!/S\.fight=clamp\(/.test(fn), "a trade still pushes S.fight");
  assert.ok(!/S\.fight\s*[+-]=/.test(eng) && !/S\.fight=clamp\(/.test(eng), "no other S.fight push");
});

test("TRADES names: @username → default call sign → short address; engine asks the site, no direct per-row fetch", async () => {
  const { feedNameMap } = await import("../lib/flight/feedNames");
  clearNameCache(); _resetHolderNames();
  await resolveHolderNames([A, B], { fetcher: async (a) => (a === A ? "maker" : null) });
  assert.deepEqual(feedNameMap([A, B, "x"]), { [A]: "@maker", [B]: defaultUsername(B) });
  const blk = eng.match(/\/\* @feed-names:start[\s\S]*?\*\/([\s\S]*?)\/\* @feed-names:end \*\//)!;
  const line = (re: RegExp) => eng.match(re)![0];
  const src = [line(/^const short=.*$/m), line(/^function fillUsd\(f\).*$/m), line(/^const fmtUsd=.*$/m), "const fmtShot=v=>'$'+v.toFixed(2);", blk[1],
    "return {NAMES,DEFNAMES,nameOf,feedTradeRow,feedRelabel,TRADE_NAME_FONT_FLOOR,TRADE_NAME_FONT_DESK,TRADE_NAME_FONT_PHONE,tradeNameInitial,fitTradeName,tradeRowParts};"].join("\n");
  const E = new Function("window", src)({ __usernameDisplayCap: USERNAME_DISPLAY_CAP });
  const feed = [E.feedTradeRow("buy", 3, null, A), E.feedTradeRow("sell", 2, null, B), E.feedTradeRow("buy", 1, "(you)", A)];
  assert.match(feed[0].txt, /0x3dfe…bede$/);
  E.NAMES[A] = "maker"; E.DEFNAMES[B] = defaultUsername(B); E.feedRelabel(feed);
  assert.match(feed[0].txt, /@maker$/); assert.ok(feed[1].txt.endsWith(defaultUsername(B))); assert.ok(defaultUsername(B).length <= USERNAME_DISPLAY_CAP); assert.match(feed[2].txt, /\(you\)$/);
  assert.match(eng, /addEventListener\('disciple:feednames'/);
  assert.ok(!/fetch\('\/api\/profile\/username/.test(eng), "engine must not fetch usernames itself");
  assert.match(fs.readFileSync(path.join(web, "lib/flight/workerBridge.ts"), "utf8"), /"disciple:feednames"/);
});

test("TRADES name column: shrink font to 9px, then first-word initial; 22-char name on desktop + phone widths", async () => {
  const { createCanvas } = await import("@napi-rs/canvas");
  const blk = eng.match(/\/\* @feed-names:start[\s\S]*?\*\/([\s\S]*?)\/\* @feed-names:end \*\//)!;
  const line = (re: RegExp) => eng.match(re)![0];
  const src = [line(/^const short=.*$/m), line(/^function fillUsd\(f\).*$/m), line(/^const fmtUsd=.*$/m), "const fmtShot=v=>'$'+v.toFixed(2);", blk[1],
    "return {TRADE_NAME_FONT_FLOOR,TRADE_NAME_FONT_DESK,TRADE_NAME_FONT_PHONE,tradeNameInitial,fitTradeName,tradeRowParts,feedTradeRow};"].join("\n");
  const E = new Function("window", src)({});
  assert.equal(E.TRADE_NAME_FONT_FLOOR, 9);
  assert.equal(E.tradeNameInitial("Pathfinder Afterburner"), "P. Afterburner");
  assert.equal(E.tradeNameInitial("@verylongusername99"), "@verylongusername99");
  assert.match(eng, /cardBegin\('trades',20,H-160,310,140\)/);
  assert.match(eng, /cAva=30, cTag=70, cUsd=66, cAgo=34/);
  const ctx = createCanvas(400, 40).getContext("2d");
  const tools = (family: string, weight: string) => ({
    family, weight,
    setFont: (px: number) => { ctx.font = (weight ? weight + " " : "") + px + "px " + family; },
    measure: (t: string) => ctx.measureText(t).width,
  });
  const desk = tools("ui-monospace,monospace", "");
  const phone = tools('ui-monospace,Menlo,"DejaVu Sans Mono",monospace', "bold");
  const phoneCol = (vw: number) => { const iw = (vw - 2 * 16) - 8; return Math.max(40, iw - 30 - 70 - 66 - 34 - 4 * 8); };
  const row = E.feedTradeRow("buy", 10, "@maker", "0x" + "11".repeat(20));
  const pre = E.tradeRowParts(row).pre as string;
  desk.setFont(12);
  const wDesk = (310 - 32 - 74) - desk.measure(pre);
  const full = E.fitTradeName("@maker", wDesk, { start: 12, floor: 9, ...desk });
  assert.equal(full.mode, "full"); assert.equal(full.size, 12); assert.equal(full.text, "@maker");
  const shr = E.fitTradeName("Starfarer Ion", wDesk, { start: 12, floor: 9, ...desk });
  assert.equal(shr.mode, "shrink"); assert.equal(shr.text, "Starfarer Ion"); assert.ok(shr.size < 12 && shr.size >= 9);
  const ini = E.fitTradeName("Pathfinder Afterburner", wDesk, { start: 12, floor: 9, ...desk });
  assert.equal(ini.mode, "initial"); assert.equal(ini.text, "P. Afterburner");
  const ph430 = E.fitTradeName("Pathfinder Afterburner", phoneCol(430), { start: 14, floor: 9, ...phone });
  assert.equal(ph430.mode, "shrink"); assert.equal(ph430.text, "Pathfinder Afterburner");
  const ph760 = E.fitTradeName("Pathfinder Afterburner", phoneCol(760), { start: 14, floor: 9, ...phone });
  assert.equal(ph760.mode, "full"); assert.equal(ph760.size, 14);
  const ph390 = E.fitTradeName("Pathfinder Afterburner", phoneCol(390), { start: 14, floor: 9, ...phone });
  assert.equal(ph390.mode, "initial"); assert.equal(ph390.text, "P. Afterburner");
});

test("chart: no tier lines / labels", () => {
  const dc = fs.readFileSync(path.join(web, "components/flight/DexChart.tsx"), "utf8");
  assert.ok(!/FLIGHT_TIERS|dex-tier|tierRefs/.test(dc));
});
