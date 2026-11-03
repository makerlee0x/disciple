// game/coin-screen-fixes4: holder names, chart tiers off, sign-out un-tags '(you)', no nose-down hold after a sell.
//   Run: npm run test:coin-fixes4
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { holderDisplayName, resolveHolderNames, holderNameNow, _resetHolderNames } from "../lib/flight/holderNames";
import { clearNameCache } from "../lib/nameLookup";
import { defaultUsername } from "../lib/defaultUsername";

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
    "return {NAMES,DEFNAMES,nameOf,feedTradeRow,feedRelabel};"].join("\n");
  const E = new Function("window", src)({});
  const feed = [E.feedTradeRow("buy", 3, null, A), E.feedTradeRow("sell", 2, null, B), E.feedTradeRow("buy", 1, "(you)", A)];
  assert.match(feed[0].txt, /0x3dfe…bede$/);
  E.NAMES[A] = "maker"; E.DEFNAMES[B] = defaultUsername(B); E.feedRelabel(feed);
  assert.match(feed[0].txt, /@maker$/); assert.ok(feed[1].txt.endsWith(defaultUsername(B).slice(0, 16))); assert.match(feed[2].txt, /\(you\)$/);
  assert.match(eng, /addEventListener\('disciple:feednames'/);
  assert.ok(!/fetch\('\/api\/profile\/username/.test(eng), "engine must not fetch usernames itself");
  assert.match(fs.readFileSync(path.join(web, "lib/flight/workerBridge.ts"), "utf8"), /"disciple:feednames"/);
});

test("chart: no tier lines / labels", () => {
  const dc = fs.readFileSync(path.join(web, "components/flight/DexChart.tsx"), "utf8");
  assert.ok(!/FLIGHT_TIERS|dex-tier|tierRefs/.test(dc));
});
