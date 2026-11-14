// Phone flight upgrades (maker 2026-11-14): tilt mapping, Core Haptics rumble levels, Live Activity numbers, the "last trade"
// share window, STYLE FILL XP, and the engine's trick / calm / tilt / rumble hooks. Run: pnpm test:phone-flight
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const rd = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

test("tilt: dead zone, linear, clamped, sign", async () => {
  const { tiltShare, TILT_RANGE_DEG, TILT_DEAD_DEG } = await import("../components/flight/TiltSteer.tsx");
  assert.equal(tiltShare(1, 0), 0, "inside the dead zone");
  assert.equal(tiltShare(TILT_RANGE_DEG, 0), 1);
  assert.equal(tiltShare(-90, 0), -1, "clamped");
  assert.ok(tiltShare(12, 5) > 0 && tiltShare(-2, 5) < 0, "relative to neutral");
  assert.ok(Math.abs(tiltShare(TILT_DEAD_DEG + (TILT_RANGE_DEG - TILT_DEAD_DEG) / 2, 0) - 0.5) < 1e-9);
  assert.equal(tiltShare(NaN, 0), 0);
});

test("rumble: coasting hum < hard climb, sinking near silent, capped", async () => {
  const { rumbleLevel } = await import("../components/flight/NativeRumble.tsx");
  const coast = rumbleLevel({ v: 0.3, climb: 0 }), climb = rumbleLevel({ v: 1, climb: 1, pending: 1 }), sink = rumbleLevel({ v: 0.5, climb: -0.6 });
  assert.ok(coast.intensity < climb.intensity && coast.sharpness < climb.sharpness);
  assert.ok(sink.intensity <= 0.05);
  assert.ok(climb.intensity <= 0.75 && climb.sharpness <= 0.9);
});

test("live activity numbers: value from share, pnl, zone progress, closed", async () => {
  const { liveFlightNumbers } = await import("../lib/liveFlight.ts");
  const n = liveFlightNumbers({ mcap: 15_000, share: 0.002, investedUsd: 20 });
  assert.equal(n.valueUsd, 30); assert.equal(n.pnlUsd, 10); assert.equal(n.pnlPct, 50);
  assert.equal(n.zone, "OZONE"); assert.equal(n.nextZone, "STRATOSPHERE"); assert.ok(n.zoneProgress > 0.49 && n.zoneProgress < 0.51);
  const c = liveFlightNumbers({ mcap: 0, valueUsd: 12, investedUsd: 20, closed: true });
  assert.equal(c.closed, true); assert.equal(c.pnlUsd, -8);
});

test("share: the last trade starts at the buy that opened the latest position", async () => {
  const { lastTradeStart, pnlFromFills } = await import("../lib/sharePnl.ts");
  const f = (i: number, side: "buy" | "sell", tokens: number, usd: number, mcap: number) => ({ ts: 1000 * i, block: i, logIndex: 0, tx: "0x" + i, side, tokens, usd, mcapUsd: mcap, trader: "0xabc", coin: "0xc" });
  const fills = [f(1, "buy", 100, 10, 5000), f(2, "sell", 100, 12, 6000), f(3, "buy", 50, 10, 9000), f(4, "buy", 50, 10, 10000), f(5, "sell", 40, 9, 11000)] as never[];
  assert.equal(lastTradeStart(fills), 2, "second round trip, still open");
  assert.equal(lastTradeStart([f(1, "buy", 1, 1, 1), f(2, "sell", 1, 1, 1)] as never[]), 0, "closed: the last closed trade");
  assert.equal(lastTradeStart([f(1, "sell", 1, 1, 1)] as never[]), -1);
  const all = pnlFromFills("0xabc", "0xc", fills, 12_000, 9_000), last = pnlFromFills("0xabc", "0xc", fills, 12_000, 9_000, { trade: "last" });
  assert.equal(all.startTs, 1000); assert.equal(last.startTs, 3000);
  assert.equal(last.investedUsd, 20, "only this trade's buys");
});

test("style XP: needs your own $5+ buy near the claim, gap, daily cap, combo pay", async () => {
  const { evaluateStyles } = await import("../lib/missionsEval.ts");
  const { STYLE, styleXp, dayPeriod } = await import("../lib/xp.ts");
  const day = dayPeriod(Date.UTC(2026, 10, 14, 12)), t = day.start + 3_600_000;
  const buy = (ts: number, usd = 10, coin = "0xc") => ({ coin, ts, block: ts, logIndex: 0, side: "buy" as const, tokens: 1, usd });
  const fills = [buy(t + 2000), buy(t + 60_000, 2), buy(t + 120_000, 10, "0xd")];
  const claims = [{ coin: "0xc", at: t, combo: 3 }, { coin: "0xc", at: t + 60_000, combo: 1 }, { coin: "0xc", at: t + 120_000, combo: 1 }, { coin: "0xc", at: t + 3000, combo: 1 }];
  const ok = evaluateStyles({ wallet: "0xme", fills, claims, asOf: t + 999_999 }, day);
  assert.deepEqual(ok.map((c) => c.at), [t], "small buy, wrong coin and a too-soon repeat don't pay");
  assert.equal(styleXp(1), STYLE.xp); assert.equal(styleXp(3), STYLE.xp + 2 * STYLE.comboXp); assert.equal(styleXp(99), styleXp(STYLE.maxCombo));
  const many = Array.from({ length: 20 }, (_, i) => ({ coin: "0xc", at: t + i * 60_000, combo: 1 }));
  const fillsMany = many.map((c) => buy(c.at + 1000));
  assert.equal(evaluateStyles({ wallet: "0xme", fills: fillsMany, claims: many, asOf: t + 1e9 }, day).length, STYLE.perDay);
});

test("engine hooks: tricks, combos, style fill, calm zoom, tilt, rumble", () => {
  const e = rd("public/flight/engine.js");
  assert.match(e, /@tricks/); assert.match(e, /function trickGesture/); assert.match(e, /e\.code==='KeyQ'\|\|e\.code==='KeyE'/);
  assert.match(e, /styleFill\(\); \}/, "a confirmed BOOST checks for a style fill");
  assert.match(e, /disciple:calm/); assert.match(e, /h=150\*\(1\+\(CALM_ZOOM-1\)\*S\.calmK\)/);
  assert.match(e, /disciple:tilt/); assert.match(e, /S\.tilt!=null&&!S\.drag/, "a finger on the sky wins over tilt");
  assert.match(e, /disciple:thrust/); assert.match(e, /if\(!S\.rumble\|\|/, "nothing is published unless the app asks");
});
