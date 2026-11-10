// game/feed-names: TRADES feed after reload + trader names + narrow-screen HUD column (engine.js @feed-names block).
//   1. chartBackfill seeds the feed from the newest indexed fills (newest first, ≤6 trade rows, dollars only, deduped, below live rows)
//   2. names: "@name" from window.__discipleNames / disciple:names, "(you)" for the player, short address as fallback; late names relabel rows
//   3. phones (W ≤ 760): the status / TOP HOLDERS column starts below the MARKET CAP panel; desktop unchanged; FlightCanvas uses the same floor
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
  "const fmtShot=v=>'$'+v.toFixed(2);", blk[1], "return {NAMES,DEFNAMES,nameOf,feedTradeRow,feedRelabel,feedSeedFills,hudColTop,HUD_NARROW_W,HUD_NARROW_TOP,TRADE_NAME_FONT_FLOOR,TRADE_NAME_FONT_DESK,TRADE_NAME_FONT_PHONE,tradeNameInitial,fitTradeName,tradeRowParts};"].join("\n");
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
  win.__discipleNames = { [A]: "@verylongusername99" };
  ok(E.nameOf(A.toUpperCase().replace("0X", "0x")) === "@verylongusername99", "no cap: claimed names are not truncated: " + E.nameOf(A));
  win.__usernameDisplayCap = 22;
  ok(E.nameOf(A) === "@verylongusername99", "cap = longest default (22): 20-char @name stays whole");
  win.__usernameDisplayCap = 11;
  ok(E.nameOf(A) === "@verylongus" && E.nameOf(A).length === 11, "cap includes the @: 11 clips @verylongusername99 → @verylongus");
  delete win.__discipleNames[A];
  E.DEFNAMES[A] = "Pathfinder Afterburner"; // 22 chars, the cap
  win.__usernameDisplayCap = 22;
  ok(E.nameOf(A) === "Pathfinder Afterburner", "default at the cap is not truncated");
  E.DEFNAMES[A] = "Pathfinder AfterburnerX";
  ok(E.nameOf(A) === "Pathfinder Afterburner", "one char over the cap is clipped");
  delete win.__usernameDisplayCap; delete E.DEFNAMES[A];
  const r = E.feedTradeRow("buy", 25, null, B40); ok(r.txt.endsWith("0xef21…8e30") && r.tr === B40, "live row keeps its trader for relabel");
  const you = E.feedTradeRow("sell", 4, "(you)", ME); ok(you.txt.endsWith("(you)") && you.own === 1 && you.tr === ME, "player row: '(you)', keeps its wallet (un-tagged on sign-out / switch)");
  E.feedRelabel([you]); ok(you.txt.endsWith("(you)"), "player row never relabelled by names");
  E.NAMES[B40] = "whale"; E.feedRelabel([r, you]); ok(r.txt.endsWith("@whale") && you.txt.endsWith("(you)"), "late name (disciple:names) relabels the row: " + r.txt);
  ok(r.txt.length <= 38, "named row fits the 38-char feed width"); }
ok(/addEventListener\('disciple:names',[^\n]*NAMES\[[^\n]*feedRelabel\(S\.feed\)/.test(eng), "engine listens to disciple:names → NAMES + relabel");
ok(/S\.feed\.unshift\(feedTradeRow\(e\.side,e\.usd,e\.mine\?/.test(eng) && !/\?short\(e\.trader\):'#'\+e\.block/.test(eng), "live feed row uses names (no short(e.trader))");
ok(/txt:`\$\{up\?'▲':'▼'\} \$\{nameOf\(e\.trader\)\}/.test(eng), "trade floater uses names");
ok(/chartSeedK\(C\.k,fs,keep\); C\.hist=2;\s*\n\s*feedHistNames\(feedSeedFills\(S\.feed,fills,/.test(eng), "chartBackfill seeds the TRADES feed");
ok(/dispatchEvent\(new CustomEvent\('disciple:names-want'/.test(eng) && !/fetch\('\/api\/profile\/username/.test(eng), "seeded rows ask the site for names (lib/nameLookup cache via 'disciple:names-want'), no direct fetch");
ok(/"disciple:names"/.test(wb.match(/const INBOUND = \[[^\]]*\]/)[0]), "worker renderer receives disciple:names");
ok(/__usernameDisplayCap/.test(wb.match(/const GLOBALS = \[[^\]]*\]/)[0]), "worker globals include __usernameDisplayCap");
ok(/publishUsernameDisplayCap/.test(fc) && /USERNAME_DISPLAY_CAP = DEFAULT_USERNAME_MAX_LEN/.test(fs.readFileSync(path.join(web, "lib/defaultUsername.ts"), "utf8")), "FlightCanvas publishes USERNAME_DISPLAY_CAP (single constant = longest default)");
// ── 3. narrow HUD column
{ const E = mk();
  ok(E.hudColTop(1280, 58) === 58 && E.hudColTop(761, 58) === 58, "desktop: column top unchanged");
  ok(E.hudColTop(390, 92) === 158 && E.hudColTop(390, 200) === 200, "phone: column starts below the MARKET CAP panel (20+130+10)");
  ok(E.hudColTop(760, 58) === 158, "≤760 matches site chrome (phone floor)");
  // status box (RT..RT+92) and TOP HOLDERS (RT+100..RT+196) never intersect the MARKET CAP panel (18..148) on a phone
  for (const W of [320, 360, 390, 430, 600, 739, 760]) for (const rt of [18, 58, 92, 120]) { const RT = E.hudColTop(W, rt); if (RT < 148) ok(false, `overlap W=${W} rt=${rt}`); }
  ok(E.HUD_NARROW_TOP >= 18 + 130 + 1, "floor below the 130-px MARKET CAP panel");
  const m = fc.match(/const HUD_NARROW_W = (\d+), HUD_NARROW_TOP = (\d+);/);
  ok(m && +m[1] === E.HUD_NARROW_W && +m[2] === E.HUD_NARROW_TOP, "FlightCanvas --ap-hud-rt floor = engine numbers (CrewPanel/GameChat follow)");
  ok(/hudColTop\(W,Math\.round\(S\.hudRT\)\), RX=W-330/.test(eng), "HUD uses hudColTop");
  // crew (SITE #137): +204 below the column while the canvas draws TOP HOLDERS; the holders box ends at +196
  ok(100 + 96 <= 204, "CrewPanel +204 stays below the TOP HOLDERS box on the floored column"); }

// ── 4. TRADES name column: shrink font to 9px, then first-word initial (card width + phone columns unchanged)
{ const { createCanvas } = await import("@napi-rs/canvas");
  const E = mk();
  ok(E.TRADE_NAME_FONT_FLOOR === 9 && E.TRADE_NAME_FONT_DESK === 12 && E.TRADE_NAME_FONT_PHONE === 14, "font floor is 9px; start 12px desktop / 14px phone");
  ok(E.tradeNameInitial("Pathfinder Afterburner") === "P. Afterburner", "first word → initial");
  ok(E.tradeNameInitial("@verylongusername99") === "@verylongusername99", "claimed @handle with no space is not abbreviated");
  ok(/cardBegin\('trades',20,H-160,310,140\)/.test(eng) && /const FX=20, FY=H, FW=310;/.test(eng), "desktop TRADES card stays 310×140");
  ok(/cAva=30, cTag=70, cUsd=66, cAgo=34, cNm=Math\.max\(40,iw-cAva-cTag-cUsd-cAgo-4\*gap\)/.test(eng), "phone FEED column widths unchanged");
  const ctx = createCanvas(400, 40).getContext("2d");
  const tools = (family, weight) => ({
    family, weight,
    setFont: (px) => { ctx.font = (weight ? weight + " " : "") + px + "px " + family; },
    measure: (t) => ctx.measureText(t).width,
  });
  const desk = tools("ui-monospace,monospace", "");
  const phone = tools('ui-monospace,Menlo,"DejaVu Sans Mono",monospace', "bold");
  const phoneCol = (vw) => { const iw = (vw - 2 * 16) - 8; return Math.max(40, iw - 30 - 70 - 66 - 34 - 4 * 8); };
  const deskCol = (pre) => { desk.setFont(E.TRADE_NAME_FONT_DESK); return (310 - 32 - 74) - desk.measure(pre); };
  const row = E.feedTradeRow("buy", 10, "@maker", "0x" + "11".repeat(20));
  const parts = E.tradeRowParts(row);
  ok(parts && parts.name === "@maker" && parts.pre.includes("BOOST"), "tradeRowParts splits prefix / name");
  const wDesk = deskCol(parts.pre);
  const full = E.fitTradeName("@maker", wDesk, { start: 12, floor: 9, ...desk });
  ok(full.mode === "full" && full.size === 12 && full.text === "@maker", "fits at full size (@maker @ 12px desktop): " + full.mode + " " + full.size);
  const shrinkName = "Starfarer Ion";
  const shr = E.fitTradeName(shrinkName, wDesk, { start: 12, floor: 9, ...desk });
  ok(shr.mode === "shrink" && shr.size < 12 && shr.size >= 9 && shr.text === shrinkName, "fits after shrink (Starfarer Ion desktop): " + shr.mode + " " + shr.size);
  const long = "Pathfinder Afterburner";
  const ini = E.fitTradeName(long, wDesk, { start: 12, floor: 9, ...desk });
  ok(ini.mode === "initial" && ini.text === "P. Afterburner" && ini.size >= 9 && ini.size <= 12, "22-char desktop falls back to initial: " + ini.mode + " " + ini.size + " " + ini.text);
  desk.setFont(ini.size); ok(desk.measure(ini.text) <= wDesk, "desktop initial actually fits the name column");
  const handle = E.fitTradeName("@verylongusername99", wDesk, { start: 12, floor: 9, ...desk });
  ok(handle.mode === "ellipsis" && handle.text.startsWith("@") && handle.text.endsWith("…") && !/^[A-Z]\. /.test(handle.text), "claimed @handle with no space keeps @ and uses phFit ellipsis");
  const ph430 = E.fitTradeName(long, phoneCol(430), { start: 14, floor: 9, ...phone });
  ok(ph430.mode === "shrink" && ph430.text === long && ph430.size < 14 && ph430.size >= 9, "22-char phone 430px width fits after shrink: " + ph430.mode + " " + ph430.size);
  const ph390 = E.fitTradeName(long, phoneCol(390), { start: 14, floor: 9, ...phone });
  ok(ph390.mode === "initial" && ph390.text === "P. Afterburner" && ph390.size >= 9, "22-char phone 390px width falls back to initial: " + ph390.mode + " " + ph390.size);
  const ph760 = E.fitTradeName(long, phoneCol(760), { start: 14, floor: 9, ...phone });
  ok(ph760.mode === "full" && ph760.size === 14 && ph760.text === long, "22-char phone 760px width fits at full 14px");
  const ph320 = E.fitTradeName(long, phoneCol(320), { start: 14, floor: 9, ...phone });
  ok(ph320.size === 9 && ph320.text !== long && (ph320.mode === "initial" || ph320.mode === "ellipsis"), "22-char phone 320px: initial then ellipsis if still tight: " + ph320.mode + " " + ph320.text);
}
console.log(bad ? `FAIL · ${bad}` : "PASS · feed names / history seed / narrow HUD"); process.exit(bad ? 1 : 0);
