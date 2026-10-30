// DEX-style mcap candles (lib/chart/candles) + paged history (lib/chart/history) for the coin page chart (DexChart).
// tsx --test scripts/test-dex-candles.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { addTick, bucketOf, buildCandles, cleanTicks, defaultTf, fmtMcap, markLast, TFS, type Tick } from "../lib/chart/candles";
import { fetchHistory, fillTick, HISTORY_PAGE } from "../lib/chart/history";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);   // 12:00:00 UTC (aligned to every timeframe incl. D? no: D = 00:00)
const at = (sec: number) => T0 + sec * 1000;
const tk = (sec: number, m: number, usd = 10, side: "buy" | "sell" = "buy", extra: Partial<Tick> = {}): Tick => ({ ts: at(sec), mcapUsd: m, usd, side, ...extra });

test("bucketing per timeframe: 1m / 5m / 1h / 4h / D bucket starts (UTC-aligned, seconds)", () => {
  const ticks = [tk(0, 1000), tk(30, 1100), tk(61, 1200), tk(299, 1300), tk(301, 1400), tk(3599, 1500), tk(3601, 1600)];
  const n = (tf: number) => buildCandles(ticks, tf).map((c) => c.time - T0 / 1000);
  assert.deepEqual(n(60), [0, 60, 240, 300, 3540, 3600]);
  assert.deepEqual(n(300), [0, 300, 3300, 3600]);
  assert.deepEqual(n(3600), [0, 3600]);
  assert.deepEqual(n(14400), [0]);   // 12:00 UTC is a 4h boundary
  assert.deepEqual(n(86400), [-43200]); // the UTC day starts at 00:00
  for (const t of TFS) for (const c of buildCandles(ticks, t.s)) assert.equal(c.time % t.s, 0, `${t.l} bucket aligned`);
  assert.equal(bucketOf(at(119), 60), T0 / 1000 + 60);
});

test("O/H/L/C: open = previous close (candles connect), H/L include the open, C = the last trade", () => {
  const cs = buildCandles([tk(0, 1000), tk(10, 1500), tk(20, 900), tk(30, 1200), tk(70, 1100), tk(80, 1300), tk(200, 800)], 60);
  assert.deepEqual(cs.map((c) => [c.open, c.high, c.low, c.close]), [[1000, 1500, 900, 1200], [1200, 1300, 1100, 1300], [1300, 1300, 800, 800]]);
  for (let i = 1; i < cs.length; i++) assert.equal(cs[i].open, cs[i - 1].close, "connected");
  // first candle opens at the launch mcap when given
  const c0 = buildCandles([tk(0, 1200)], 60, 1000)[0];
  assert.deepEqual([c0.open, c0.high, c0.low, c0.close], [1000, 1200, 1000, 1200]);
});

test("empty buckets are skipped (no filler bars) and the next candle still opens at the previous close", () => {
  const cs = buildCandles([tk(0, 1000), tk(3 * 3600, 2000)], 60);
  assert.equal(cs.length, 2);
  assert.equal(cs[1].time - cs[0].time, 3 * 3600);
  assert.equal(cs[1].open, 1000); assert.equal(cs[1].low, 1000); assert.equal(cs[1].high, 2000);
});

test("volume: Σ $ per bucket with buy / sell split", () => {
  const cs = buildCandles([tk(0, 1000, 25, "buy"), tk(5, 990, 10, "sell"), tk(6, 995, 5.5, "sell"), tk(65, 1001, 7, "buy")], 60);
  assert.equal(cs[0].volume, 40.5); assert.equal(cs[0].buyVol, 25); assert.equal(cs[0].sellVol, 15.5); assert.equal(cs[0].n, 3);
  assert.equal(cs[1].volume, 7); assert.equal(cs[1].sellVol, 0);
  // per timeframe the total is the same
  for (const t of TFS) assert.equal(buildCandles([tk(0, 1000, 25), tk(5, 990, 10, "sell"), tk(6, 995, 5.5, "sell"), tk(65, 1001, 7)], t.s).reduce((a, c) => a + c.volume, 0), 47.5);
});

test("curve → pool continuity: the first post-ascension (hook) candle opens at the last curve close", () => {
  const curve = [tk(0, 30000, 50, "buy", { block: 10, logIndex: 1, id: "0xa:1" }), tk(40, 68000, 900, "buy", { block: 12, logIndex: 3, id: "0xb:3" })];
  const hook = [tk(130, 69000, 20, "buy", { block: 15, logIndex: 0, id: "0xc:0" }), tk(150, 66000, 40, "sell", { block: 16, logIndex: 2, id: "0xd:2" })];
  const cs = buildCandles([...hook, ...curve], 60);   // input order doesn't matter (chain order)
  assert.equal(cs.length, 2);
  assert.equal(cs[1].open, 68000); assert.equal(cs[1].close, 66000); assert.equal(cs[1].high, 69000);
  // same-block ordering by logIndex
  const same = buildCandles([tk(0, 2000, 1, "buy", { block: 5, logIndex: 9 }), tk(0, 1000, 1, "buy", { block: 5, logIndex: 2 })], 60)[0];
  assert.equal(same.open, 1000); assert.equal(same.close, 2000);
});

test("empty history, junk and duplicates", () => {
  assert.deepEqual(buildCandles([], 60), []);
  assert.deepEqual(buildCandles([tk(0, 0), tk(1, NaN), { ts: NaN, mcapUsd: 5 }, tk(2, -3)], 60), []);
  const d = cleanTicks([tk(0, 1000, 10, "buy", { id: "x:1" }), tk(0, 1000, 10, "buy", { id: "x:1" })]);
  assert.equal(d.length, 1);
  assert.equal(defaultTf([]), 300);
});

test("a single trade = one candle (open = close = its mcap unless a launch mcap is given)", () => {
  const cs = buildCandles([tk(42, 7200, 3)], 300);
  assert.equal(cs.length, 1);
  assert.deepEqual([cs[0].open, cs[0].high, cs[0].low, cs[0].close, cs[0].volume], [7200, 7200, 7200, 7200, 3]);
  assert.equal(defaultTf([tk(0, 1)]), 300);
});

test("live: addTick extends the last candle or opens a connected new one; markLast only moves the current candle", () => {
  const cs = buildCandles([tk(0, 1000)], 60);
  addTick(cs, tk(30, 1200, 5), 60);
  assert.equal(cs.length, 1); assert.equal(cs[0].close, 1200); assert.equal(cs[0].volume, 15);
  addTick(cs, tk(65, 1100, 5, "sell"), 60);
  assert.equal(cs.length, 2); assert.equal(cs[1].open, 1200); assert.equal(cs[1].low, 1100);
  // an older (out of order) tick widens its own bucket only
  addTick(cs, tk(10, 1500, 1), 60);
  assert.equal(cs.length, 2); assert.equal(cs[0].high, 1500); assert.equal(cs[0].close, 1200);
  assert.equal(markLast(cs, 1150, at(90), 60), true); assert.equal(cs[1].close, 1150);
  assert.equal(markLast(cs, 1300, at(200), 60), false, "a new bucket without a trade adds no candle"); assert.equal(cs.length, 2);
});

test("default timeframe from the trading span", () => {
  const span = (s: number) => defaultTf([tk(0, 1), tk(s, 2)]);
  assert.equal(span(17 * 60), 60); assert.equal(span(20 * 3600), 300); assert.equal(span(5 * 86400), 3600); assert.equal(span(30 * 86400), 14400); assert.equal(span(200 * 86400), 86400);
});

test("$ mcap labels", () => {
  assert.equal(fmtMcap(7200), "$7.2K"); assert.equal(fmtMcap(7234), "$7.23K"); assert.equal(fmtMcap(1.3e6), "$1.3M"); assert.equal(fmtMcap(1e6), "$1M"); assert.equal(fmtMcap(33400), "$33.4K");
  assert.equal(fmtMcap(812), "$812"); assert.equal(fmtMcap(2.45e9), "$2.45B"); assert.equal(fmtMcap(450000), "$450K"); assert.equal(fmtMcap(5.5), "$5.50"); assert.equal(fmtMcap(40000), "$40K");
});

test("history: pages /api/trades with ?offset= until a short page; fills → ticks (router $ when known)", async () => {
  const mk = (i: number) => ({ id: `0x${i}:0`, ts: at(i), mcapUsd: 1000 + i, usd: 1, usdIn: 2, side: "buy", block: i, logIndex: 0 });
  const total = HISTORY_PAGE * 2 + 7, urls: string[] = [];
  const f = async (u: string) => { urls.push(u); const off = Number(new URL(u, "http://x").searchParams.get("offset") || 0);
    const fills = Array.from({ length: Math.max(0, Math.min(HISTORY_PAGE, total - off)) }, (_, k) => mk(off + k)); return { ok: true, json: async () => ({ fills }) }; };
  const r = await fetchHistory("0xabc", f);
  assert.equal(r.pages, 3); assert.equal(r.ticks.length, total); assert.equal(r.capped, false);
  assert.match(urls[0], /limit=5000&order=asc$/); assert.match(urls[2], /offset=10000$/);
  assert.equal(r.ticks[0].usd, 2, "buy: usdIn");
  assert.equal(fillTick({ ts: 1, mcapUsd: 5, usd: 3, usdOut: 4, side: "sell" })!.usd, 4, "sell: usdOut");
  assert.equal(fillTick({ ts: 1, mcapUsd: 5, usd: 3, side: "sell" })!.usd, 3, "older fills: usd");
  const e = await fetchHistory("0xabc", async () => ({ ok: true, json: async () => ({ fills: [] }) }));
  assert.equal(e.ticks.length, 0); assert.equal(e.pages, 1);
  await assert.rejects(fetchHistory("0xabc", async () => ({ ok: false, json: async () => null })));
});

test("API paging: kv.zrange offset (mem + Upstash) and the route's ?offset=", () => {
  const kv = readFileSync(new URL("../lib/server/kv.ts", import.meta.url), "utf8"), tr = readFileSync(new URL("../lib/server/trades.ts", import.meta.url), "utf8"),
    rt = readFileSync(new URL("../app/api/trades/route.ts", import.meta.url), "utf8");
  assert.match(kv, /\.slice\(o, o \+ limit\)/); assert.match(kv, /\["ZRANGE", k, o, o \+ limit - 1, "REV"\] : \["ZRANGE", k, o, o \+ limit - 1\]/);
  assert.match(tr, /zrange\(k, n, order === "desc", Math\.max\(0, Math\.floor\(offset\) \|\| 0\)\)/);
  assert.match(rt, /searchParams\.get\("offset"\)/); assert.match(rt, /tradesOf\(coin, wallet, limit, order, offset\)/);
});

test("DexChart: lightweight-charts loaded client-side only, attribution on, axis drag / dbl-click reset / pan / pinch", () => {
  const src = readFileSync(new URL("../components/flight/DexChart.tsx", import.meta.url), "utf8"), page = readFileSync(new URL("../app/coin/[address]/page.tsx", import.meta.url), "utf8");
  assert.match(src, /import\("lightweight-charts"\)/);
  assert.doesNotMatch(src.replace(/import type[^\n]*/g, ""), /from "lightweight-charts"/, "no static value import");
  assert.match(src, /attributionLogo: true/);
  assert.match(src, /axisPressedMouseMove: \{ time: true, price: true \}, axisDoubleClickReset: \{ time: true, price: true \}/);
  assert.match(src, /handleScroll: \{ mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true/);
  assert.match(src, /pinch: true/); assert.match(src, /autoSize: true/);
  assert.match(src, /data-card="chart"/); assert.match(src, /html\.ap-phone\[data-ph-sheet="chart"\] \.dex-chart/);
  assert.match(page, /<DexChart coin=\{address\}/);
});

test("DexChart reskin: the old chart-map game skin (CHART_STYLE palette, Georgia title, log axis, gold tag, tiers, live ring)", () => {
  const src = readFileSync(new URL("../components/flight/DexChart.tsx", import.meta.url), "utf8");
  for (const c of ['up: "#3ddc97"', 'down: "#ff5c7a"', 'frameMid: "#2a2638"', 'titleBg: "rgba(24,20,36,.92)"', 'grid: "rgba(190,200,255,.10)"', 'marker: "#9ff3c8"', 'tagFg: "#1a1630"'])
    assert.ok(src.includes(c), c);
  assert.match(src, /Georgia/); assert.match(src, /PriceScaleMode\.Logarithmic/);
  assert.match(src, /axisLabelColor: C\.gold, axisLabelTextColor: C\.tagFg/, "gold current-value tag, dark text");
  assert.match(src, /for \(const t of FLIGHT_TIERS\) candle\.createPriceLine\(/, "tier thresholds as price lines");
  assert.match(src, /data-testid="dex-live-ring"/); assert.match(src, /@keyframes dexPulse/); assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /pointerEvents: "none", zIndex: 2/, "overlay never eats pan / pinch / crosshair input");
  assert.doesNotMatch(src, /ABCDEFGH|GRID_COLS/, "no A–H / 1–5 grid labels");
});

test("chart title: exactly one $ whether or not the ticker carries one (desktop + phone share the title)", async () => {
  const { chartTitle, chartTicker } = await import("../lib/chart/candles");
  for (const t of ["SGRAD", "$SGRAD", "$$SGRAD", " $sgrad ", "sgrad"]) { assert.equal(chartTitle(t), "$SGRAD", t); assert.doesNotMatch(chartTitle(t), /\$\$/); }
  assert.equal(chartTitle(null), "PRICE"); assert.equal(chartTitle("$"), "PRICE"); assert.equal(chartTicker("$ABCDEFGHIJKL"), "ABCDEFGHIJ");
  const src = readFileSync(new URL("../components/flight/DexChart.tsx", import.meta.url), "utf8");
  assert.match(src, /const label = chartTicker\(ticker\)/); assert.doesNotMatch(src, /`\$\$\{label\}`/);
  assert.equal((src.match(/data-testid="dex-title-dollar"/g) || []).length, 1, "one $ glyph in the single (desktop + phone) title");
});
