// GAME graduation fix (lee 7:04 / 7:09 PM CT 2026-10-24): price-move WARNINGS (never block), exact GRADUATE buy from the curve
// (SITE shim), plain trade-error copy. Pure helpers run for real (lib/flight/tradeGate + tradeErrorShim); wiring is source-checked.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { loadLib } from "./lib/load-ts.mjs";
const rd = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const tb = rd("components/TradeBridge.tsx"), bar = rd("components/flight/PhoneTradeBar.tsx"), eng = rd("public/flight/engine.js");
const wb = rd("lib/flight/workerBridge.ts"), shim = rd("lib/flight/gradShim.ts"), gate = rd("lib/flight/tradeGate.ts");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const { mods, cleanup } = await loadLib(["flight/tradeGate", "flight/tradeErrorShim"], "gradfix-");
const G = mods["flight/tradeGate"], E = mods["flight/tradeErrorShim"];
try {
  // 1) warning threshold (named constant) + live limit 5000 vs no cap
  ok(G.BIG_MOVE_BPS === 1000, "BIG_MOVE_BPS named constant = 10%");
  ok(G.moveWarning("buy", 999, 5000).level === "none", "9.99% move: no warning");
  ok(G.moveWarning("buy", 1000, 5000).level === "big", "10% move: big-move warning");
  ok(G.moveWarning("buy", 3800, 5000).text === "Big move: price +38%", "buy copy: Big move: price +38%");
  ok(G.moveWarning("sell", -3800, 5000).text === "Big move: price −38%", "sell copy: price −38%");
  ok(G.moveWarning("buy", 6200, 5000).level === "over" && G.moveWarning("buy", 6200, 5000).text === "Too big for this rocket right now · price +62%", "over the 5000 bps limit: likely-to-fail warning");
  ok(G.moveWarning("buy", 5000, 5000).level === "big", "exactly at the limit: not over");
  for (const off of [0, null, undefined, NaN, -1]) ok(G.moveWarning("buy", 9000, off).level === "big", `limit ${off}: no cap ⇒ no over-limit warning (big-move still shown)`);
  ok(G.moveWarning("buy", null, 5000).level === "none" && G.moveWarning("buy", NaN, 5000).level === "none", "unknown quote: no warning");
  ok(G.moveWarning("buy", 1500, 5000, 2000).level === "none", "threshold is tunable");
  const ws = G.moveWarnings("buy", [100, 1200, 6000, null], 5000);
  ok(ws.map((w) => w.level).join() === "none,big,over,none", "moveWarnings maps each preset");
  ok(ws.map((w) => G.chipTag("buy", w)).join() === ",+12%,+60%!,", "chip tags");
  ok(!/gatePresets|disabled|blocked\s*:/.test(gate.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")), "tradeGate has no gate / disable API");
  // 2) NO BLOCK: warnings never disable / block / confirm anything
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const tbc = strip(tb);
  ok(!/confirm\(/.test(tbc) && !/confirm\(/.test(strip(bar)), "no confirm dialog");
  ok(!/disabled=\{[^}]*(warn|Warn|over|impact)/.test(tbc) && !/disabled=\{[^}]*(warn|Warn|over|impact)/.test(strip(bar)), "no button disabled by a price-move warning");
  ok(!/(warn|Warn)[^\n]*\breturn \{ ok: false/.test(tbc), "the bridge never refuses a trade for a warning");
  const main = (p) => execSync(`git show origin/main:web/${p}`, { cwd: new URL("..", import.meta.url) }).toString();
  const boostDis = (s) => (s.match(/aria-label="buy"[^\n]*/) || [""])[0];
  ok(boostDis(tb) === boostDis(main("components/TradeBridge.tsx")), "BOOST button line unchanged from main (still only cash / min gating)");
  ok(/onPickBuy : p\.onPickSell\)\(i\); setSheet\(null\)/.test(bar) && !/ph-opt[^\n]*disabled=\{[^}]*tags/.test(bar), "sheet options stay tappable with a warning");
  ok((eng.match(/S\.buyWarn/g) || []).every((_, i, a) => true) && !/buyWarn[^\n]*return;/.test(eng) && !/(\bp\.warn|buyWarn)[^\n]*(S\.mode=|selectSell|pending)/.test(eng), "engine: warning tags draw only, never gate select / shoot");
  ok(/S\.buyWarn\.tags\[i\]/.test(eng) && /p\.on&&p\.warn/.test(eng), "engine: buy tiles + sell chips show the tag");
  ok(/on: has, sel: i === sellSel,\n\s*warn: chipTag/.test(tb), "sell chips: `on` stays holdings-only, warn is extra");
  ok(/data-testid="trade-warn"/.test(tb) && /data-testid="trade-warn"/.test(bar), "trade bar + phone bar show the active warning line");
  ok(/getMaxImpactBps\(\)/.test(tb) && /moveWarnings\("buy"/.test(tb) && /moveWarnings\("sell"/.test(tb), "TradeBridge reads the live limit + quotes for both sides");
  ok(/"disciple:buywarn"/.test(wb) && /"disciple:gradbuy"/.test(wb), "worker forwards the new events");
  // 3) plain errors via the classifier shim
  const C = (e, c) => E.classifyTradeError(e, c);
  ok(C({ code: "PriceImpactTooHigh", message: "router cap" }) === "PRICE_IMPACT", "PriceImpactTooHigh → PRICE_IMPACT");
  ok(C(new Error("PriceImpactTooHigh(7712, 5000)")) === "PRICE_IMPACT", "message-only price impact");
  ok(C({ code: "PreExecHookReverted", message: "x" }) === "MIN_OUT" && C(new Error("MinOutTooLow")) === "MIN_OUT", "MinOutTooLow (wrapped) → MIN_OUT");
  ok(C(new Error("AA95 out of gas")) === "OUT_OF_GAS" && C({ code: "Reverted", message: "reverted", extra: { revertData: "0x" } }) === "OUT_OF_GAS", "gas / empty revert → OUT_OF_GAS");
  ok(C({ code: "Estimate", message: "e" }, { graduating: true }) === "OUT_OF_GAS" && C({ code: "Estimate", message: "e" }) === "OTHER", "graduating estimate failure → OUT_OF_GAS only when graduating");
  ok(C(new Error("not enough USDG")) === "OTHER", "everything else OTHER");
  ok(G.plainTradeMessage("PRICE_IMPACT") === "Too big for this rocket right now. Try a smaller amount.", "PRICE_IMPACT copy");
  ok(G.plainTradeMessage("MIN_OUT") === "Price moved. Tap again.", "MIN_OUT copy");
  ok(G.plainTradeMessage("OUT_OF_GAS") === "That didn't go through. Nothing was spent. Try again.", "OUT_OF_GAS copy");
  ok(G.plainTradeMessage("OTHER") === null, "OTHER keeps the existing message");
  for (const t of Object.values(G.GAME_COPY)) ok(!/router|slippage|min ?out|gas/i.test(t), `no jargon: ${t}`);
  ok(/plainReason\(e, side, usd\)/.test(tb) && /plainReason\(\{ message: r\.reason \}/.test(tb), "bridge maps thrown + !ok failures");
  const rev = new Function(`${eng.match(/function isOnchainRevert\(reason\)\{[^\n]+/)[0]}\nreturn isOnchainRevert;`)();
  ok(!rev("Too big for this rocket right now. Try a smaller amount.") && !rev("Price moved. Tap again.") && !rev("That didn't go through. Nothing was spent. Try again.") && rev("reverted"), "engine: plain copy isn't prefixed 'trade failed:'");
  // 4) graduate maths from the shim
  const probe = 10n ** 24n;
  const g = G.graduationFromProbe(probe, { tokensOut: 8_310000000000000000n, graduates: true, refund: probe - 114_200000000000000000n });
  ok(g && g.inputNeeded === 114_200000000000000000n && g.remainingTokens === 8_310000000000000000n, "inputNeeded = probe − refund, remainingTokens = tokensOut");
  ok(G.graduationFromProbe(probe, { tokensOut: 1n, graduates: false, refund: 0n }) === null, "not graduating ⇒ null");
  // STRATEGY-quoted IRON: 114.2 STRATEGY × $0.00245 ≈ $0.2798 → +3% +1¢ → ceil cents
  const qp = 2_450000000000000n;   // $0.00245 per STRATEGY (USD WAD)
  const usd = G.graduateUsd({ inputNeeded: g.inputNeeded, quoteIsUsdg: false, usdgDecimals: 6, quotePriceUsd: qp, minShot: 0.2 });
  ok(usd === G.ceilCents(0.27979 * 1.03 + 0.01) && usd === 0.30, `IRON graduate $ (${usd})`);
  ok(G.graduateUsd({ inputNeeded: 1_234_567n, quoteIsUsdg: true, usdgDecimals: 6, quotePriceUsd: 0n, minShot: 0.2 }) === G.ceilCents(1.234567 * 1.03 + 0.01), "USDG-quoted 1:1");
  ok(G.graduateUsd({ inputNeeded: 1000n, quoteIsUsdg: true, usdgDecimals: 6, quotePriceUsd: 0n, minShot: 0.2 }) === 0.2, "never below MIN_SHOT");
  ok(G.graduateLabel(0.3) === "GRADUATE · $0.30" && G.graduateLabel(0.001) === "GRADUATE · $0.01", "label always cents, never $0");
  ok(G.showGraduate(0.3, [1, 5, 25, 100]) && !G.showGraduate(1.5, [1, 5, 25, 100]) && !G.showGraduate(null, [1]), "GRADUATE only when ≤ smallest preset");
  ok(/export async function getMaxImpactBps\(\): Promise<number>/.test(shim) && /export async function getGraduationBuy\(token: [^)]*\): Promise<\{ remainingTokens: bigint; inputNeeded: bigint; quoteToken: string \} \| null>/.test(shim), "SITE shim signatures");
  ok(/TODO\(SITE\)/.test(shim) && /TODO\(SITE/.test(rd("lib/flight/tradeErrorShim.ts")), "shims carry TODO(SITE)");
  ok(/shoot\("buy", \{ usd: grad \}\)/.test(tb) && /data-testid="grad-btn"/.test(tb) && /data-testid="grad-btn"/.test(bar), "GRADUATE buys the exact curve amount (desktop + phone)");
  // 5) tier bar: exact amount, never ≈$0
  const fmtUsd = new Function(`${eng.match(/const fmtUsd=[^\n]+/)[0]}\nreturn fmtUsd;`)();
  const fmtNeed = new Function("fmtUsd", `${eng.match(/const fmtNeed=[^\n]+/)[0]}\nreturn fmtNeed;`)(fmtUsd);
  ok(fmtNeed(0.0004) === "$0.01" && fmtNeed(0.281) === "$0.29" && fmtNeed(3.5) === "$3.50" && fmtNeed(12.2) === "$13" && fmtNeed(4321) === "$4.3K", "fmtNeed rounds up to the cent");
  ok(/exact\?`\$\{fmtNeed\(need\)\} to graduate`/.test(eng) && /S\.gradBuyUsd!=null&&nx\.lo>=TB_M1&&m<TB_M1/.test(eng), "tier bar uses the exact curve amount at graduation");
  ok(!/≈\$\{fmtUsd\(need\)\}/.test(eng), "no more ≈${fmtUsd(need)} (≈$0)");
  console.log(`test-grad-fix: ${n} checks passed`);
} finally { cleanup(); }
