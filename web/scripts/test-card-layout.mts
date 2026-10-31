// pass 3 #4: card layout persistence (per account / guest), restore / reset, viewport clamp — and engine parity.
// tsx --test scripts/test-card-layout.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CARD_IDS, CANVAS_CARDS, DOM_CARDS, LAYOUT_PREFIX, clampOffset, hiddenCards, layoutKey, loadLayout, parseLayout, resetLayout,
  restoreCard, saveLayout, setCard, type Layout,
} from "../lib/game/cardLayout";

const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
const A = "0xAbCdEf0123456789abcdef0123456789ABCDEF01", B = "0x1111111111111111111111111111111111111111";

test("every coin-screen card is covered (canvas + DOM)", () => {
  assert.deepEqual([...CARD_IDS].sort(), ["chart", "chat", "controls", "header", "pnl", "trades"]);
  assert.equal(CANVAS_CARDS.length + DOM_CARDS.length, CARD_IDS.length);
});

test("layout key: per account (lowercased), guest when signed out / junk", () => {
  assert.equal(layoutKey(A), LAYOUT_PREFIX + A.toLowerCase());
  assert.equal(layoutKey(A.toLowerCase()), layoutKey(A));
  for (const g of [null, undefined, "", "0x12", "not-an-address"]) assert.equal(layoutKey(g as string), LAYOUT_PREFIX + "guest");
});

test("save → load round trip, isolated per account and guest", () => {
  const ls = mem();
  const la: Layout = setCard(setCard({}, "chart", { dx: 120, dy: -40 }), "chat", { closed: true });
  saveLayout(ls, A, la);
  saveLayout(ls, null, { trades: { dx: 5, dy: 6, min: true } });
  assert.deepEqual(loadLayout(ls, A), la);
  assert.deepEqual(loadLayout(ls, A.toLowerCase()), la, "same player, any address casing");
  assert.deepEqual(loadLayout(ls, B), {}, "another player starts from the default layout");
  assert.deepEqual(loadLayout(ls, undefined), { trades: { dx: 5, dy: 6, min: true } }, "guest layout separate");
  saveLayout(ls, A, resetLayout());
  assert.equal(ls.m.has(layoutKey(A)), false, "reset removes the saved key");
  assert.ok(ls.m.has(layoutKey(null)), "…without touching the guest layout");
});

test("tolerant parse: junk, unknown ids, non-numbers, a throwing storage", () => {
  assert.deepEqual(parseLayout("{nope"), {});
  assert.deepEqual(parseLayout(null), {});
  assert.deepEqual(parseLayout("[1,2]"), {});
  assert.deepEqual(parseLayout(JSON.stringify({ bogus: { dx: 1 }, chart: { dx: "9", dy: 3.6, min: "yes", closed: true }, pnl: { dx: 0, dy: 0 } })), { chart: { dx: 0, dy: 4, closed: true } });
  const boom = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
  assert.deepEqual(loadLayout(boom, A), {});
  assert.doesNotThrow(() => saveLayout(boom, A, { chart: { dx: 1, dy: 1 } }));
});

test("minimize / close / restore / reset are immutable and drop default cards", () => {
  const l0: Layout = {};
  const l1 = setCard(l0, "header", { min: true });
  assert.deepEqual(l0, {}, "input untouched");
  assert.deepEqual(hiddenCards(l1), ["header"]);
  const l2 = setCard(l1, "trades", { closed: true, dx: 30, dy: 0 });
  assert.deepEqual(hiddenCards(l2), ["header", "trades"]);
  const l3 = restoreCard(l2, "trades");
  assert.deepEqual(l3.trades, { dx: 30, dy: 0 }, "restore keeps the position, clears the flags");
  assert.equal(restoreCard(l3, "header").header, undefined, "restored at 0,0 ⇒ default (not stored)");
  assert.deepEqual(resetLayout(), {});
});

test("clamp to the viewport on resize (raw offset kept, drawn offset clamped)", () => {
  const r = { x: 20, y: 600, w: 310, h: 140 };
  assert.deepEqual(clampOffset(r, { dx: 50, dy: -30 }, 1366, 768), { dx: 50, dy: -30 });
  assert.deepEqual(clampOffset(r, { dx: 5000, dy: 5000 }, 1366, 768), { dx: 1366 - 310 - 20, dy: 768 - 140 - 600 });
  assert.deepEqual(clampOffset(r, { dx: -999, dy: -999 }, 1366, 768), { dx: -20, dy: -600 });
  assert.deepEqual(clampOffset(r, { dx: 900, dy: 0 }, 1000, 768), { dx: 670, dy: 0 }, "window shrank: card pulled back inside");
  assert.deepEqual(clampOffset(r, { dx: 900, dy: 0 }, 1600, 768), { dx: 900, dy: 0 }, "window grew back: the chosen spot returns");
  assert.equal(clampOffset({ x: 20, y: 18, w: 380, h: 190 }, { dx: 300, dy: 0 }, 300, 768).dx, -20, "wider than the window ⇒ pinned left");
});

test("engine cardOff (canvas cards) == clampOffset (DOM cards)", () => {
  const eng = readFileSync(new URL("../public/flight/engine.js", import.meta.url), "utf8");
  const i = eng.indexOf("function cardOff(r,c,W,H){"), j = eng.indexOf("/* @cards-math-end */", i);
  assert.ok(i > 0 && j > i);
  const cardOff = new Function(eng.slice(i, j) + "\nreturn cardOff;")() as (r: object, c: object, W: number, H: number) => { dx: number; dy: number };
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 500; k++) {
    const r = { x: Math.round(rnd() * 900), y: Math.round(rnd() * 700), w: 40 + Math.round(rnd() * 500), h: 40 + Math.round(rnd() * 400) };
    const d = { dx: Math.round((rnd() - 0.5) * 3000), dy: Math.round((rnd() - 0.5) * 3000) }, vw = 300 + Math.round(rnd() * 1800), vh = 300 + Math.round(rnd() * 1000);
    assert.deepEqual(cardOff(r, d, vw, vh), clampOffset(r, d, vw, vh), JSON.stringify({ r, d, vw, vh }));
  }
});

test("store + chrome wiring: per-account load, engine publish, phone neutral", () => {
  const st = readFileSync(new URL("../lib/game/cardLayoutStore.ts", import.meta.url), "utf8");
  const ch = readFileSync(new URL("../components/flight/CardChrome.tsx", import.meta.url), "utf8");
  assert.match(st, /onWallet\(/);
  assert.match(st, /loadLayout\(/);
  assert.match(st, /saveLayout\(/);
  assert.match(st, /__cardLayout/);
  assert.match(st, /disciple:cardlayout/);
  assert.match(ch, /layout-reset/);
  assert.match(ch, /layout-show-/);
  assert.match(ch, /card-close-/);
  assert.match(ch, /card-min-/);
  assert.match(ch, /setPointerCapture/);
  assert.match(readFileSync(new URL("../app/coin/[address]/page.tsx", import.meta.url), "utf8"), /<CardChrome \/>/);
});

// ---- DEX chart card size (Oct 30): resizable, saved in the per-account layout, clamped to the viewport
import { RESIZABLE, clampSize } from "../lib/game/cardLayout";
test("chart card: a DOM card with a saved size (w / h) that round-trips per account", () => {
  assert.ok(DOM_CARDS.includes("chart") && !CANVAS_CARDS.includes("chart"));
  const ls = mem(), l = setCard({}, "chart", { w: 760, h: 420 });
  assert.deepEqual(l.chart, { dx: 0, dy: 0, w: 760, h: 420 }, "size alone is kept (not a 'default' card)");
  saveLayout(ls, A, l);
  assert.deepEqual(loadLayout(ls, A).chart, { dx: 0, dy: 0, w: 760, h: 420 });
  assert.deepEqual(loadLayout(ls, B), {}, "other accounts unaffected");
  const moved = setCard(l, "chart", { dx: 40, dy: -10 });
  assert.deepEqual(moved.chart, { dx: 40, dy: -10, w: 760, h: 420 }, "moving keeps the size");
  assert.equal(setCard(l, "chart", { w: 0, h: 0 }).chart, undefined, "reset size ⇒ default card dropped");
  assert.equal(setCard({}, "pnl", { w: 500, h: 500 }).pnl, undefined, "non-resizable cards never store a size");
  assert.deepEqual(parseLayout(JSON.stringify({ chart: { dx: 0, dy: 0, w: 10, h: 5 } })).chart, { dx: 0, dy: 0, w: RESIZABLE.chart!.minW, h: RESIZABLE.chart!.minH }, "junk-small sizes raised to the minimum");
  assert.equal(parseLayout(JSON.stringify({ pnl: { w: 400, h: 300 } })).pnl, undefined);
});

test("chart card size clamp: default, min, and never larger than the viewport", () => {
  const z = RESIZABLE.chart!;
  assert.deepEqual(clampSize("chart", undefined, 1440, 900), { w: z.defW, h: z.defH });
  assert.deepEqual(clampSize("chart", { w: 5000, h: 5000 }, 1440, 900), { w: 1440 - 16, h: 900 - 16 });
  assert.deepEqual(clampSize("chart", { w: 50, h: 50 }, 1440, 900), { w: z.minW, h: z.minH });
  assert.deepEqual(clampSize("chart", { w: 800, h: 500 }, 1440, 900), { w: 800, h: 500 });
  // a resized card near the edge: the offset clamp keeps the whole (bigger) card on screen
  const s = clampSize("chart", { w: 900, h: 600 }, 1280, 720);
  assert.deepEqual(clampOffset({ x: 84, y: 470, ...s }, { dx: 0, dy: 0 }, 1280, 720), { dx: 0, dy: 720 - 600 - 470 });
});
