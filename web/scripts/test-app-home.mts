// iPhone app home (concept C, maker 2026-11-16): the Flying now shelf and the Live rockets sheet (search + sorts).
//   pnpm test:app-home
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { flyingNow, liveRockets } from "../lib/home/appHome";
import type { HomeCoin } from "../lib/home/trending";

const coin = (name: string, o: Partial<HomeCoin> & { vol?: number; chg?: number | null; crew?: number | null } = {}): HomeCoin => ({
  token: "0x" + name.toLowerCase().padEnd(40, "0"), name, ticker: name.toUpperCase().slice(0, 5), pair: "USDG", pairSym: "USDG", icon: "", creator: "x",
  mcapUsd: 10_000, graduated: false, progressBps: 1000, block: 1, launchedAt: null, mode: 1,
  stats: o.vol == null && o.crew == null ? null : { vol24: o.vol ?? 0, trades24: 1, bombs24: 0, chg24: o.chg ?? null, crew: o.crew ?? null, lastTs: null },
  ...o,
});

const A = coin("Alpha", { vol: 500, chg: 10, crew: 3, block: 1, progressBps: 9000 });
const B = coin("Bravo", { vol: 900, chg: -5, crew: 40, block: 2, progressBps: 2000 });
const C = coin("Charlie", { block: 5, progressBps: 5000 });
const G = coin("Grad", { vol: 9999, chg: 50, crew: 99, block: 3, graduated: true });
const all = [A, B, C, G];
const names = (l: HomeCoin[]) => l.map((c) => c.name);

test("Flying now: climbers, then volume, then newest; never a graduated rocket", () => {
  assert.deepEqual(names(flyingNow(all)), ["Alpha", "Bravo", "Charlie"]);
  assert.deepEqual(names(flyingNow(all, 2)), ["Alpha", "Bravo"]);
  assert.deepEqual(flyingNow([]), []);
});

test("Live rockets: trending puts traded rockets first, then the newest", () => {
  assert.deepEqual(names(liveRockets(all, "", "trend")), ["Grad", "Bravo", "Alpha", "Charlie"]);
});
test("Live rockets: new, near orbit (curve only), biggest crew", () => {
  assert.deepEqual(names(liveRockets(all, "", "new")), ["Charlie", "Grad", "Bravo", "Alpha"]);
  assert.deepEqual(names(liveRockets(all, "", "orbit")), ["Alpha", "Charlie", "Bravo"]);
  assert.deepEqual(names(liveRockets(all, "", "crew")), ["Grad", "Bravo", "Alpha", "Charlie"]);
});
test("Live rockets: search by name or ticker, $ prefix and case ignored", () => {
  assert.deepEqual(names(liveRockets(all, "brav", "trend")), ["Bravo"]);
  assert.deepEqual(names(liveRockets(all, "$CHARL", "trend")), ["Charlie"]);
  assert.deepEqual(liveRockets(all, "zzz", "trend"), []);
});

test("the app gets html.app before paint, and the website's home and tab bar stay as they are", () => {
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /DiscipleApp\//);
  const css = readFileSync(new URL("../app/brand-tokens-v3.css", import.meta.url), "utf8");
  assert.match(css, /\.app-only, \.lb-tabs\.lb-appdock \{ display: none; \}/);
  assert.match(css, /html\.app \.app-web \{ display: none; \}/);
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /<AppSwitch web=\{web\} app=\{<AppHome/);
});
