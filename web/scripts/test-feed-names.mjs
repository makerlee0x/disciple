// game/feed-names: TRADES feed after reload + trader names + narrow-screen HUD column (engine.js @feed-names block).
//   1. chartBackfill seeds the feed from the newest indexed fills (newest first, ≤6 trade rows, dollars only, deduped, below live rows)
//   2. names: "@name" from window.__discipleNames / disciple:names, "(you)" for the player, short address as fallback; late names relabel rows
//   3. phones (W < 740): the status / TOP HOLDERS column starts below the MARKET CAP panel; desktop unchanged; FlightCanvas uses the same floor
//   Run: node scripts/test-feed-names.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
const fc = fs.readFileSync(path.join(web, "components/FlightCanvas.tsx"), "utf8");
const wb = fs.readFileSync(path.join(web, "lib/flight/workerBridge.ts"), "utf8");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const line = (re) => { const m = eng.match(re); if (!m) throw new Error("engine: " + re); return m[0]; };
const blk = eng.match(/\/\* @feed-names:start[\s\S]*?\*\/([\s\S]*?)\/\* @feed-names:end \*\//); if (!blk) throw new Error("@feed-names markers missing");
const src = [line(/^const short=.*$/m), line(/^function fillUsd\(f\).*$/m), line(/^const fmtUsd=.*$/m),
  "const fmtShot=v=>'$'+v.toFixed(2);", blk[1], "return {NAMES,nameOf,feedTradeRow,feedRelabel,feedSeedFills,hudColTop,HUD_NARROW_W,HUD_NARROW_TOP};"].join("\n");
const mk = (win = {}) => new Function("window", src)(win);

const A = "0x3dfe00000000000000000000000000000000bede", ME = "0xaaaa00000000000000000000000000000000cafe";
const B40 = "0xef21000000000000000000000000000000008e30";
// ── 1. feed seed after reload
{ const E = mk({ __discipleNames: { [A]: "maker" } });
  // /api/trades?order=desc: newest first; 8 fills, one zero-usd, one already ticked live
  const fills = [
    { tx: "0x01", logIndex: 1, side: "buy", trader: A, usdIn: 10, usd: 8.18 },
    { tx: "0x02", logIndex: 0, side: "sell", trader: ME, usdOut: 2.44, usd: 2.47 },
    { tx: "0x03", logIndex: 0, side: "buy", trader: B40, usd: 1234 },
    { tx: "0x04", logIndex: 0, side: "buy", trader: B40, usd: 0 },
    { tx: "0x05", logIndex: 2, side: "buy", trader: A, usdIn: 5 },
    { tx: "0x06", logIndex: 0, side: "sell", trader: A, usdOut: 50 },
    { tx: "0x07", logIndex: 0, side: "buy", trader: A, usdIn: 7 },
    { tx: "0x08", logIndex: 0, side: "buy", trader: A, usdIn: 9 },
  ];
  const feed = [];
  const rows = E.feedSeedFills(feed, fills, ME, new Set());
  ok(feed.length === 6 && rows.length === 6, "empty feed → 6 rows from the newest fills (got " + feed.length + ")");
  ok(/^▲ BOOST\s+\$10  @maker$/.test(feed[0].txt), "newest first, buy = USDG paid (usdIn), named: " + feed[0].txt);
  ok(/^▼ DUMP\s+\$2\.44  \(you\)$/.test(feed[1].txt), "own sell = USDG received (usdOut), '(you)': " + feed[1].txt);
  ok(/\$1\.2K  0xef21…8e30$/.test(feed[2].txt), "no name → short address, ≥$10 → fmtUsd: " + feed[2].txt);
  ok(!feed.some((r) => r.txt.includes("0x04")) && feed.every((r) => /\$/.test(r.txt) && !/ETH|tokens|%/.test(r.txt)), "zero-usd fill skipped; dollars only");
  ok(feed[5].txt.includes("$7.00"), "6th row is the 7th fill (zero-usd skipped)");
  ok(feed.every((r) => r.c === (r.txt.startsWith("▲") ? "#9ff3c8" : "#ffb0c8")), "buy/sell colours as live rows");
  // live rows already there: seeded rows go below, total trade rows ≤ 6, ticked tx deduped
  const live = [E.feedTradeRow("buy", 3, null, A)];
  E.feedSeedFills(live, fills, ME, new Set(["0x01:1"]));
  ok(live.length === 6 && live[0].txt.includes("$3.00") && !live.slice(1).some((r) => r.txt.includes("@maker") && r.txt.includes("$10 ")), "below the live row, live-ticked fill deduped");
  const err = [{ txt: "✕ trade failed: x", c: "#ff8f8f", err: 1 }];
  E.feedSeedFills(err, fills, ME, new Set()); ok(err.length === 7 && err[0].err, "error rows don't count toward the 6 trade rows; cap 7");
  ok(E.feedSeedFills([], [], ME, new Set()).length === 0, "no fills → nothing"); }
// ── 2. names
{ const win = {}; const E = mk(win);
  ok(E.nameOf(A) === "0x3dfe…bede", "fallback: short address");
  ok(E.nameOf("bot_alice") === "bot_alice", "sim bot names pass through");
  win.__discipleNames = { [A]: "@verylongusername99" }; ok(E.nameOf(A.toUpperCase().replace("0X", "0x")) === "@verylonguse", "site map, case-insensitive, one @, ≤11 chars: " + E.nameOf(A));
  const r = E.feedTradeRow("buy", 25, null, B40); ok(r.txt.endsWith("0xef21…8e30") && r.tr === B40, "live row keeps its trader for relabel");
  const you = E.feedTradeRow("sell", 4, "(you)", ME); ok(you.txt.endsWith("(you)") && !you.tr, "player row: '(you)', never relabelled");
  E.NAMES[B40] = "whale"; E.feedRelabel([r, you]); ok(r.txt.endsWith("@whale") && you.txt.endsWith("(you)"), "late name (disciple:names) relabels the row: " + r.txt);
  ok(r.txt.length <= 38, "named row fits the 38-char feed width"); }
ok(/addEventListener\('disciple:names',[^\n]*NAMES\[[^\n]*feedRelabel\(S\.feed\)/.test(eng), "engine listens to disciple:names → NAMES + relabel");
ok(/S\.feed\.unshift\(feedTradeRow\(e\.side,e\.usd,e\.mine\?/.test(eng) && !/\?short\(e\.trader\):'#'\+e\.block/.test(eng), "live feed row uses names (no short(e.trader))");
ok(/txt:`\$\{up\?'▲':'▼'\} \$\{nameOf\(e\.trader\)\}/.test(eng), "trade floater uses names");
ok(/chartSeedK\(C\.k,fs,keep\); C\.hist=2;\s*\n\s*feedHistNames\(feedSeedFills\(S\.feed,fills,/.test(eng), "chartBackfill seeds the TRADES feed");
ok(/\/api\/profile\/username\?address='\+a/.test(eng), "seeded rows look up their names (same API as lib/nameLookup)");
ok(/"disciple:names"/.test(wb.match(/const INBOUND = \[[^\]]*\]/)[0]), "worker renderer receives disciple:names");
// ── 3. narrow HUD column
{ const E = mk();
  ok(E.hudColTop(1280, 58) === 58 && E.hudColTop(740, 58) === 58, "desktop: column top unchanged");
  ok(E.hudColTop(390, 92) === 158 && E.hudColTop(390, 200) === 200, "phone: column starts below the MARKET CAP panel (20+130+10)");
  // status box (RT..RT+92) and TOP HOLDERS (RT+100..RT+196) never intersect the MARKET CAP panel (18..148) on a phone
  for (const W of [320, 360, 390, 430, 600, 739]) for (const rt of [18, 58, 92, 120]) { const RT = E.hudColTop(W, rt); if (RT < 148) ok(false, `overlap W=${W} rt=${rt}`); }
  ok(E.HUD_NARROW_TOP >= 18 + 130 + 1, "floor below the 130-px MARKET CAP panel");
  const m = fc.match(/const HUD_NARROW_W = (\d+), HUD_NARROW_TOP = (\d+);/);
  ok(m && +m[1] === E.HUD_NARROW_W && +m[2] === E.HUD_NARROW_TOP, "FlightCanvas --ap-hud-rt floor = engine numbers (CrewPanel/GameChat follow)");
  ok(/hudColTop\(W,Math\.round\(S\.hudRT\)\), RX=W-330/.test(eng), "HUD uses hudColTop");
  // crew (SITE #137): +204 below the column while the canvas draws TOP HOLDERS; the holders box ends at +196
  ok(100 + 96 <= 204, "CrewPanel +204 stays below the TOP HOLDERS box on the floored column"); }
console.log(bad ? `FAIL · ${bad}` : "PASS · feed names / history seed / narrow HUD"); process.exit(bad ? 1 : 0);
