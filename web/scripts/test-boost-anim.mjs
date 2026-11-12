// game/boost-anim — the rocket heads for the ghost at the CLICK (visual only), ≤ 70 % before the receipt; completes on r.ok;
// eases back (that trade's share only) on failure; nothing booked / dispatched / broadcast before r.ok; up to 3 stacked trades.
//   1. @boostanim curve: cap never exceeded while pending (target AND the engine's spring), hover near the cap, completes on ok,
//      hands over to the real price with no snap, eases back on fail, stale sends ease back
//   2. stacked trades: each ghost projected from the previous pending one, own segment, a failed middle one drops only its share
//   3. engine submit(): nothing booked / dispatched before r.ok (paper + live), failure status "That didn't go through."
//   3b. price impact (needsConfirm / r.warning) is a calm note, never a failure (lee, Oct 30)
//   4. hoverMs / clickToConfirmMs on disciple:op 'filled'; curve constants match lib/flight/tradeSpeed BOOST_ANIM
//   5. #140 safety: no await before aaSend in execCalls
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const eng = fs.readFileSync(path.join(web, "public/flight/engine.js"), "utf8");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const baSrc = block("/* @boostanim", "/* @boostanim-end */");
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const BA = new Function("clamp", "S", baSrc + "\nreturn {baStart,baG,baResolve,baOffset,baConfirm,pendingTip,BA_CAP,BA_TAU_UP,BA_STALE,BA_CONFIRM,BA_FADE};")(clamp, { pending: [] });
const { mods, cleanup } = await loadLib(["flight/tradeSpeed"], "boostanim-");
const TS = mods["flight/tradeSpeed"];

console.log("— 1. the curve");
{ let max = 0; { const M = []; BA.baStart(M, 0, 1, 0); for (let t = 0; t < 29990; t += 5) max = Math.max(max, BA.baOffset(M, 0, t)); }
  const L = []; const e = BA.baStart(L, 0, 1, 0);
  ok(max <= 0.7 + 1e-12 && max > 0.699, `pending: offset never above the 70 % cap (max ${max.toFixed(6)})`);
  ok(BA.baOffset(L, 0, 150) > 0.4, "pending: the rocket is clearly on its way within 150 ms of the click");
  // the engine's altitude spring (simStep: W=10, Z=1, critically damped) chasing real + offset never overshoots the cap
  { const L2 = []; BA.baStart(L2, 0, 1, 0); let alt = 0, v = 0, top = 0; const dt = 1 / 120;
    for (let t = 0; t < 8000; t += dt * 1000) { const err = BA.baOffset(L2, 0, t) - alt; v += (100 * err - 20 * v) * dt; alt += v * dt; top = Math.max(top, alt); }
    ok(top <= 0.7 + 1e-9, `spring: displayed rocket never above the cap before the receipt (top ${top.toFixed(6)})`); }
  ok(BA.baOffset(L, 0, 3000) > 0.69, "slow receipt: hovers near the cap (≈70 %), no landing");
  { const Ls = []; BA.baStart(Ls, 0, -1, 0); let mn = 0; for (let t = 0; t <= 10000; t += 5) mn = Math.min(mn, BA.baOffset(Ls, 0, t));
    ok(mn >= -0.7 - 1e-12, "DUMP: same cap downward"); }
  BA.baResolve(e, true, 3000, L);
  ok(BA.baOffset(L, 0, 3500) > 0.99, "ok: completes to the ghost (real price not in yet)");
  // real price arrives over 0.7 s (public RPC lag): real + offset stays put — no snap
  let prev = 0 + BA.baOffset(L, 0, 3500), jump = 0;
  for (let t = 3500; t <= 4300; t += 5) { const real = clamp((t - 3600) / 700, 0, 1), tot = real + BA.baOffset(L, real, t); jump = Math.max(jump, Math.abs(tot - prev)); prev = tot; }
  ok(jump < 0.01 && near(prev, 1, 1e-3), `ok: hands over to the real price without a snap (max step ${jump.toFixed(4)})`);
  ok(L.length === 0, "ok: entry retired once the real price reached the ghost"); }
// FOLLOW THE CONFIRMED PRICE (lee, Oct 30): the boost holds until the fill's confirmed price is in, then eases to it
const TXA = "0x" + "a".repeat(64), TXB = "0x" + "b".repeat(64), TXC = "0x" + "c".repeat(64), TXD = "0x" + "d".repeat(64);
{ const L = []; BA.baStart(L, 0, 1, 0); const e = L[0]; BA.baResolve(e, true, 400, L, TXA);
  ok(BA.baOffset(L, 0, 400 + 2500 + 400 + 1) > 0.99, "ok, confirmed price not in yet: still holds at the ghost after 2.9 s (was: a blind fade)");
  BA.baConfirm(L, TXB, false, 5000);
  ok(BA.baOffset(L, 0, 5600) > 0.99 && e.ct == null, "another trader's swap (other tx) doesn't release the hold");
  BA.baConfirm(L, "(state)", false, 5100);
  ok(BA.baOffset(L, 0, 5700) > 0.99 && e.ct == null, "a State / mark update doesn't release it either (may predate the fill)");
  BA.baConfirm(L, TXA.toUpperCase().replace("0X", "0x"), true, 6000);
  // the indexed swap came in at only 40 % of the projected move (smaller impact): ease from the ghost to it, no snap
  let prev = 0.4 + BA.baOffset(L, 0.4, 6000), jump = 0, last = prev;
  for (let t = 6000; t <= 6000 + BA.BA_FADE + 20; t += 5) { const tot = 0.4 + BA.baOffset(L, 0.4, t); jump = Math.max(jump, Math.abs(tot - prev)); prev = tot; last = tot; }
  ok(e.ct === 6000 && near(last, 0.4, 1e-6) && jump < 0.02 && L.length === 0, `own swap (same tx) in ⇒ eases to the confirmed price over ${BA.BA_FADE} ms (max step ${jump.toFixed(4)})`); }
{ const L = []; BA.baStart(L, 0, 1, 0); BA.baConfirm(L, TXC, true, 300); const e = L[0]; BA.baResolve(e, true, 400, L, TXC);
  ok(e.ct === 400 && BA.baOffset(L, 0, 400 + BA.BA_FADE + 1) === 0 && L.length === 0, "the swap landed before the result: eases straight away"); }
{ const L = []; BA.baStart(L, 0, 1, 0); const e = L[0]; BA.baResolve(e, true, 400, L);   // optimistic 'sent': no tx yet
  BA.baConfirm(L, TXB, false, 900); ok(e.ct == null, "no tx: another trader's swap doesn't confirm it");
  BA.baConfirm(L, TXA, true, 1200); ok(e.ct === 1200, "no tx: the next OWN swap confirms it"); }
{ const L = []; BA.baStart(L, 0, 1, 0); BA.baConfirm(L, "paper-1f2e", true, 50); const e = L[0]; BA.baResolve(e, true, 60, L);
  ok(e.ct === 60, "paper: its own swap is emitted before the result ⇒ eases straight away"); }
{ const L = []; BA.baStart(L, 0, 1, 0); const e = L[0]; BA.baResolve(e, true, 400, L, TXD);
  ok(BA.baOffset(L, 0, 400 + BA.BA_CONFIRM - 1) > 0.99, `never confirmed: holds up to the ${BA.BA_CONFIRM / 1000} s fallback`);
  ok(BA.baOffset(L, 0, 400 + BA.BA_CONFIRM + BA.BA_FADE + 1) === 0 && L.length === 0, "never confirmed: then eases back to the real price (timeout fallback)"); }
{ const L = []; BA.baStart(L, 0, 1, 0); BA.baResolve(L[0], true, 400, L, TXA);
  ok(BA.baOffset(L, 1, 900) === 0 && L.length === 0, "real price reaches the ghost before the swap is matched: hands over (progress term)"); }
{ const L = []; const e = BA.baStart(L, 0, 1, 0); const at = BA.baOffset(L, 0, 400); BA.baResolve(e, false, 400, L);
  let prev = at, mono = true; for (let t = 400; t <= 3000; t += 5) { const o = BA.baOffset(L, 0, t); if (o > prev + 1e-12) mono = false; prev = o; }
  ok(mono && prev === 0 && L.length === 0, "fail: eases back to where it was (monotone, from wherever it had reached)");
  ok(near(BA.baOffset([{ ...e, st: "fail", gr: at, tr: 400 }], 0, 401), at, 1e-2), "fail: no jump at the failure instant"); }
{ const L = []; BA.baStart(L, 0, 1, 0); BA.baOffset(L, 0, 100);
  ok(BA.baOffset(L, 0, BA.BA_STALE + 1) <= 0.7 && L[0].st === "fail", "a send that never answers eases back after 30 s (visual only)"); }

console.log("— 2. stacked trades (3 in flight)");
{ const L = []; const a = BA.baStart(L, 0, 1, 0), b = BA.baStart(L, 1, 2, 50), c = BA.baStart(L, 2, 3, 100); let max = 0;
  for (let t = 0; t <= 5000; t += 5) max = Math.max(max, BA.baOffset(L, 0, t));
  ok(max <= 3 * 0.7 + 1e-12, "3 pending: each its own segment, each ≤ 70 % (sum ≤ 2.1 segments)");
  BA.baResolve(b, false, 5000, L);
  ok(near(c.base, 1) && near(a.base, 0), "middle fails: the later segment now starts where the failed one started");
  BA.baResolve(a, true, 5000, L); BA.baResolve(c, true, 5000, L);
  const o = BA.baOffset(L, 0, 6500);
  ok(near(o, 2, 1e-3), `middle fails: only its share eases back — the rocket rests at 2 ok segments (${o.toFixed(4)})`);
  ok(BA.baOffset(L, 2, 6600) === 0 && L.length === 0, "real price catches up to 2 segments: all entries hand over"); }
{ const L = []; const a = BA.baStart(L, 0, 1, 0), b = BA.baStart(L, 1, 2, 0); BA.baResolve(b, true, 1000, L);
  ok(near(BA.baOffset(L, 0, 2000), 0.7 + 1, 1e-3), "out-of-order receipts: the later one completes, the earlier still capped at 70 %"); void a; }

console.log("— 3. engine submit(): nothing booked or broadcast before r.ok");
const trBlock = block("/* @trade (sliced", "// Pre-flight failures");
function engine({ live = false } = {}) {
  const E = { thrust: [], events: [], res: [] }; let now = 1;
  const S = { fuelers: { you: 0 }, hold: { tokens: 1e6, valueUsd: 50 }, liveBag: live ? { tokens: 1e6 } : null, flashes: [], feed: [], mode: 0, balance: 1e3, liveCash: 1e3,
    confirmed: { mcap: 7e4 }, pending: [], cooldownUntil: 0, buyBoost: 0, score: 0, simF: 1 };
  class CE { constructor(t, o) { this.type = t; this.detail = o && o.detail; } }
  const env = { S, MODES: [{ usd: 10 }], hasTokens: () => true, noTokens() {}, isLive: () => live, markMcap: () => 7e4, MIN_SHOT: 0.2, fmtShot: String,
    window: live ? { __discipleTrade() {} } : {}, applyThrust: (side, usd, pct) => E.thrust.push({ side, usd, pct }),
    source: { supply: 7e9, impact: () => 1.02, submitTrade: () => new Promise((r) => E.res.push(r)) }, srcImpact: () => 1.02, fillMcapEst: () => 7e4, MAX_PENDING: 3, COOLDOWN_MS: 0,
    performance: { now: () => now }, mcapToAlt: (m) => Math.log10(m), shownMcap: () => S.confirmed.mcap, clamp, pushPaperCash() { E.events.push({ type: "papercash" }); },
    dispatchEvent: (e) => E.events.push(e), CustomEvent: CE, SESSION: null, isOnchainRevert: () => true, setTimeout: () => 0 };
  E.trade = new Function(...Object.keys(env), trBlock + "\nreturn trade;")(...Object.values(env));
  E.S = S; E.at = (t) => { now = t; };
  E.settle = async (i, r) => { E.res[i](r); await new Promise((x) => setImmediate(x)); };
  return E; }
for (const live of [false, true]) { const E = engine({ live }), tag = live ? "live" : "paper";
  E.trade("buy"); E.at(60); E.trade("buy"); E.at(120); E.trade("buy");
  const P = E.S.pending, A = E.S.boostAnim;
  ok(P.length === 3 && A.length === 3 && A.every((e) => e.st === "pending"), `${tag}: 3 taps → 3 pending ghosts, 3 animation segments`);
  ok(near(P[0].proj, 7e4 * 1.02) && near(P[1].proj, 7e4 * 1.02 ** 2) && near(P[2].proj, 7e4 * 1.02 ** 3), `${tag}: ghosts stack (each projected from the previous pending one)`);
  ok(near(A[1].base, Math.log10(P[0].proj)) && near(A[2].base, Math.log10(P[1].proj)), `${tag}: each press owns its segment (previous ghost → its ghost)`);
  ok(E.events.filter((e) => e.type !== "disciple:inflight").length === 0 && E.S.balance === 1e3 && E.S.fuelers.you === 0 && E.S.score === 0 && E.thrust.length === 0 && E.S.buyBoost === 0,
    `${tag}: before any receipt — no event dispatched (no paperfill / cash / broadcast; only the in-flight count), balance / points / fuel untouched, no flare`);
  E.at(400); await E.settle(1, { ok: false, reason: "Price moved" });
  ok(A[1].st === "fail" && E.S.flashes.some((f) => f.txt === "That didn't go through.") && E.S.feed[0] && /Price moved/.test(E.S.feed[0].txt), `${tag}: failure → eases back + "That didn't go through." (reason kept in the TRADES row)`);
  ok(near(P[2].proj, 7e4 * 1.02 ** 2) && near(A[2].base, Math.log10(7e4 * 1.02)), `${tag}: later ghost drops by the failed step`);
  ok(!E.events.some((e) => e.type === "disciple:paperfill") && E.S.balance === 1e3, `${tag}: a failed trade books nothing`);
  E.at(450); await E.settle(0, { ok: true, txHash: "0x" + "ab".repeat(32), pre: 7e4, post: 7.14e4 });
  ok(A[0].st === "ok" && E.events.filter((e) => e.type === "disciple:paperfill").length === 1, `${tag}: r.ok → completes + books exactly once (then, not before)`);
  ok(A[2].st === "pending", `${tag}: the 3rd trade still waits on its own receipt`); }

console.log("— 3b. price impact never blocks or fails a trade (lee): a non-blocking note only");
{ const IMP = "High price impact: this buy moves the price over 10%. You'll get about 1.2K coins.";
  const realRevert = new Function(block("function isOnchainRevert(", "\n// DOM ammo") + "\nreturn isOnchainRevert;")();
  ok(!realRevert(IMP) && !realRevert("Wallet limit: this coin's mode caps each wallet at 2%.") && realRevert("execution reverted"), "isOnchainRevert: impact / wallet-limit notes are never 'reverted'");
  for (const extra of [{}, { unknown: true }]) { const E = engine({ live: true }), tag = extra.unknown ? "needsConfirm + unknown (SITE #201)" : "needsConfirm";
    E.trade("buy"); E.at(60); E.trade("buy"); const A = E.S.boostAnim, p1 = E.S.pending[1];
    E.at(200); await E.settle(0, { ok: false, reason: IMP, needsConfirm: "impact", ...extra });
    ok(!E.S.feed.some((f) => f.err) && !E.S.flashes.some((f) => f.txt === "That didn't go through."), `${tag}: no ✕ failure row, no "That didn't go through."`);
    ok(E.S.flashes.some((f) => f.txt === IMP && f.c), `${tag}: the plain note shows as a calm flash`);
    ok(A[0].st === "fail" && E.S.pending.length === 1 && E.S.pending[0] === p1 && near(p1.proj, 7e4 * 1.02), `${tag}: nothing was sent — the boost eases back, the slot frees, the next ghost drops by that step`);
    ok(!E.events.some((e) => e.type === "disciple:paperfill") && E.thrust.length === 0, `${tag}: books nothing, no thrust`); }
  { const E = engine({ live: true }); E.trade("buy"); E.at(300); await E.settle(0, { ok: true, txHash: "0x" + "cd".repeat(32), warning: IMP });
    ok(E.S.boostAnim[0].st === "ok" && E.events.filter((e) => e.type === "disciple:paperfill").length === 1 && !E.S.feed.some((f) => f.err) && E.S.flashes.some((f) => f.txt === IMP),
      "sent with a warning (r.ok + r.warning): fills normally, note shown, never a failure"); } }

console.log("— 4. hoverMs on disciple:op 'filled'");
ok(TS.BOOST_ANIM.cap === BA.BA_CAP && TS.BOOST_ANIM.tauUpMs === BA.BA_TAU_UP, "tradeSpeed BOOST_ANIM matches engine @boostanim (cap 0.7, τ 140 ms)");
ok(TS.boostHoverMs(300) === 0 && TS.boostHoverMs(TS.BOOST_HOVER_FROM_MS + 1000) === 1000 && TS.boostHoverMs(undefined) === 0, `boostHoverMs: 0 under ${Math.round(TS.BOOST_HOVER_FROM_MS)} ms, then the time at the cap`);
{ const g = BA.baG({ st: "pending", t0: 0 }, TS.BOOST_HOVER_FROM_MS); ok(near(g, 0.97 * 0.7, 1e-9), "hover starts where the engine curve reaches 97 % of the cap"); }
const tb = fs.readFileSync(path.join(web, "components/TradeBridge.tsx"), "utf8");
ok(/phase: "filled"[^\n]*clickToConfirmMs: ms\.confirm, hoverMs: boostHoverMs\(performance\.now\(\) - t0\)/.test(tb), "TradeBridge 'filled' event carries clickToConfirmMs + hoverMs");

console.log("— 5. #140 asTrade safety");
{ const w = fs.readFileSync(path.join(web, "lib/wallet.ts"), "utf8"), i = w.indexOf("export async function execCalls"), j = w.indexOf("aaSend(", i);
  ok(i > 0 && j > i && !/await/.test(w.slice(i, j).replace(/await\s*$/, "")), "execCalls: no await before aaSend (shared session global stays synchronous)"); }
ok(!/dispatchEvent|postMessage|fetch\(|\.send\(|S\.balance|S\.score|fuelers/.test(baSrc.replace(/\/\*[\s\S]*?\*\//g, "")), "@boostanim code: no dispatch / post / fetch / send / booking");

cleanup();
console.log(bad ? `\n${bad} boost-anim check(s) FAILED` : "\nall boost-anim checks passed"); process.exit(bad ? 1 : 0);
