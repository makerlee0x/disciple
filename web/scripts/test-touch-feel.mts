// Mobile plan (2026-11-13): haptics vocabulary + dedupe + settings toggle, hover-media PostCSS, streamed sky plates,
// phone DUMP ALL hold, flight guards. Run: pnpm test:touch-feel
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const rd = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const require = createRequire(import.meta.url);

// minimal browser globals for lib/game/haptics + settings
const store: Record<string, string> = {};
const calls: (number | number[])[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } };
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Android", platform: "Linux", maxTouchPoints: 5, vibrate: (p: number | number[]) => { calls.push(p); return true; } }, configurable: true });
g.addEventListener = () => {}; g.removeEventListener = () => {}; g.dispatchEvent = () => true;

test("haptics: patterns, sfx mapping, dedupe, settings toggle", async () => {
  const h = await import("../lib/game/haptics.ts");
  const s = await import("../lib/game/settings.ts");
  assert.equal(s.DEFAULT_GAME_SETTINGS.haptics, true, "vibration on by default (maker 2026-11-13)");
  assert.equal(s.sanitizeGameSettings({}).haptics, true, "old saves without the key stay on");
  assert.equal(s.sanitizeGameSettings({ haptics: false }).haptics, false);
  assert.equal(h.kindForSfx("ignite", { side: "buy" }), "boost");
  assert.equal(h.kindForSfx("ignite", { side: "sell" }), "dump");
  assert.equal(h.kindForSfx("orbit"), "orbit");
  assert.equal(h.kindForSfx("nope"), null);
  assert.ok(h.haptic("boost", true));
  assert.deepEqual(calls.at(-1), 14);
  assert.equal(h.haptic("boost"), false, "same kind inside 140ms = one buzz (button tap + engine ignite)");
  assert.equal(h.haptic("tap", true), false, "plain tap right after a boost is swallowed");
  assert.ok(h.haptic("fill"));
  assert.deepEqual(calls.at(-1), [10, 40, 18]);
  s.setGameSettings((x) => ({ ...x, haptics: false }));
  assert.equal(h.haptic("orbit"), false, "Vibration off = silent");
});

test("hover styles only on hover devices (PostCSS)", async () => {
  const postcss = require("postcss");
  const plugin = require("../lib/postcss/hover-media.cjs");
  const out = (await postcss([plugin()]).process(".a:hover,.b{c:1} @media (hover:hover){.d:hover{c:2}} .e:not(.f,.g):hover{c:3}", { from: undefined })).css;
  assert.match(out, /^\.b\{c:1\}@media \(hover: hover\)\{\.a:hover\{c:1\}\}/, "split: non-hover selector stays, hover one wrapped");
  assert.equal((out.match(/@media \(hover: hover\)/g) || []).length, 2, "already-wrapped rule not double wrapped");
  assert.match(out, /\.e:not\(\.f,\.g\):hover/, "commas inside :not() are not split");
  assert.match(rd("postcss.config.mjs"), /hover-media\.cjs/);
});

test("engine streams sky plates and starts on the near ones", () => {
  const eng = rd("public/flight/engine.js");
  assert.match(eng, /S\.confirmed\.mcap===null \|\| !skyReady\(\)/, "frame gate = rocket + plates near the current altitude");
  assert.match(eng, /if\(inflight>=3\) break;/, "background plates load 3 at a time");
  assert.match(eng, /assetsReady:\(\)=>loaded>=names\.length/, "assetsReady still = everything (replay / tests)");
  assert.match(eng, /^function haptic\(\)\{\}/m, "engine haptic is a no-op: vibrate does not exist in the worker");
});

test("phone trade bar: fire on press, DUMP ALL needs a hold", () => {
  const bar = rd("components/flight/PhoneTradeBar.tsx"), tb = rd("components/TradeBridge.tsx");
  assert.match(bar, /export const HOLD_MS = 400;/);
  assert.match(bar, /onPointerDown=\{\(e\) => press\(side, e\)\}/);
  assert.match(bar, /if \(!b && p\.dumpAll\) \{[\s\S]*?setTimeout\([\s\S]*?p\.onDump\(\)/, "hold completes → DUMP");
  assert.match(bar, /Hold to dump all/);
  assert.match(bar, /if \(firedByPointer\.current \|\| e\.detail > 0\)/, "pointer-fired trade is not repeated by the click; keyboard click still trades");
  assert.match(tb, /dumpAll=\{[\s\S]*?>= 0\.999\}/);
});

test("flight guards, wake lock, folded overlays", () => {
  const kit = rd("components/TouchKit.tsx"), css = rd("app/globals.css");
  assert.match(kit, /wakeLock\.request\("screen"\)/);
  assert.match(kit, /classList\.add\("ap-flight"\)/);
  assert.match(css, /html\.ap-flight, html\.ap-flight body \{ overscroll-behavior: none; \}/);
  assert.match(css, /font-size: max\(16px, 1em\)/, "inputs don't zoom on iOS");
  assert.match(rd("components/AppShell.tsx"), /<TouchKit \/>/);
  assert.match(rd("components/flight/GameRadio.tsx"), /phone && \(!!layout\.radio\?\.min \|\| !phoneOpen\)/, "radio starts folded on phones");
  assert.match(rd("components/sim/SimMode.tsx"), /data-testid="sim-chip"/, "sim panel folds into a chip on phones");
});
