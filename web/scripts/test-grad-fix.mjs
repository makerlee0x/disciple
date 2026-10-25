// GAME graduation fix (lee 7:04 / 7:09 PM CT 2026-10-24): price-move WARNINGS (never block), exact GRADUATE buy from the curve,
// plain trade-error copy — on SITE's real helpers (PR #157: tradeErrorKind, readRouterMaxImpactBps, readGradNeedForToken). Pure helpers run for real (tsx; no RPC); wiring is source-checked.
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { encodeErrorResult, parseAbi } from "viem";
import * as G from "../lib/flight/tradeGate.ts";
import { tradeErrorKind, friendlyError } from "../lib/protocol-viem.ts";
import { AAError } from "../lib/aa/core.ts";
const rd = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const tb = rd("components/TradeBridge.tsx"), bar = rd("components/flight/PhoneTradeBar.tsx"), eng = rd("public/flight/engine.js");
const wb = rd("lib/flight/workerBridge.ts"), ad = rd("lib/flight/gradAdapter.ts"), gate = rd("lib/flight/tradeGate.ts");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
{
  // 1) warning threshold (named constant) + live limit 5000 vs 100000 (FLOW raised the router to 100000 at 7:10 PM CT) vs no cap
  ok(G.BIG_MOVE_BPS === 1000, "BIG_MOVE_BPS named constant = 10%");
  ok(G.moveWarning("buy", 999, 5000).level === "none", "9.99% move: no warning");
  ok(G.moveWarning("buy", 1000, 5000).level === "big", "10% move: big-move warning");
  ok(G.moveWarning("buy", 3800, 5000).text === "Big move: price +38%", "buy copy: Big move: price +38%");
  ok(G.moveWarning("sell", -3800, 5000).text === "Big move: price −38%", "sell copy: price −38%");
  ok(G.moveWarning("buy", 6200, 5000).level === "over" && G.moveWarning("buy", 6200, 5000).text === "Too big for this rocket right now · price +62%", "over the 5000 bps limit: likely-to-fail warning");
  ok(G.moveWarning("buy", 5000, 5000).level === "big", "exactly at the limit: not over");
  ok(G.moveWarning("buy", 6200, 100000).level === "big" && G.moveWarning("buy", 6200, 100000).text === "Big move: price +62%", "limit 100000: same 62% quote is only a big move");
  ok(G.moveWarning("buy", 99_000, 100000).level === "big" && G.moveWarning("buy", 100_001, 100000).level === "over", "limit 100000 is a real cap (≥10000 is NOT treated as no cap)");
  ok(G.hasImpactCap(100000) && G.hasImpactCap(5000) && !G.hasImpactCap(0) && !G.hasImpactCap(null), "only 0 / null = no cap");
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
  ok(/S\.buyWarn=/.test(eng) && !/buyWarn[^\n]*return;/.test(eng) && !/(\bp\.warn|buyWarn)[^\n]*(S\.mode=|selectSell|pending)/.test(eng), "engine: warning tags draw only, never gate select / shoot");
  ok(/S\.buyWarn\.tags\[i\]/.test(eng) && /p\.on&&p\.warn/.test(eng), "engine: buy tiles + sell chips show the tag");
  ok(/on: has, sel: i === sellSel,\n\s*warn: chipTag/.test(tb), "sell chips: `on` stays holdings-only, warn is extra");
  ok(/data-testid="trade-warn"/.test(tb) && /data-testid="trade-warn"/.test(bar), "trade bar + phone bar show the active warning line");
  ok(/liveMaxImpactBps\(\)/.test(tb) && /readRouterMaxImpactBps\(publicClient\(\)\)/.test(ad) && !/10_?000\b/.test(ad) && /moveWarnings\("buy"/.test(tb) && /moveWarnings\("sell"/.test(tb), "TradeBridge reads the live limit + quotes for both sides");
  ok(/"disciple:buywarn"/.test(wb) && /"disciple:gradbuy"/.test(wb), "worker forwards the new events");
  // 3) plain errors via SITE's tradeErrorKind (our classifier shim is gone)
  ok(!existsSync(new URL("../lib/flight/tradeErrorShim.ts", import.meta.url)) && !existsSync(new URL("../lib/flight/gradShim.ts", import.meta.url)), "GAME shims deleted");
  ok(/import \{ tradeErrorKind,[^\n]*from "@\/lib\/protocol-viem"/.test(tb) && /plainTradeMessage\(tradeErrorKind\(e\)\)/.test(tb), "bridge uses SITE's tradeErrorKind");
  const R = parseAbi(["error MinOutTooLow(uint256 minOut, uint256 required)", "error PriceImpactTooHigh(uint256 impactBps, uint256 maxImpactBps)"]);
  const impact = encodeErrorResult({ abi: R, errorName: "PriceImpactTooHigh", args: [12931n, 5000n] });
  const minOut = encodeErrorResult({ abi: R, errorName: "MinOutTooLow", args: [1n, 2n] });
  const msg = (e) => G.plainTradeMessage(tradeErrorKind(e));
  ok(msg(friendlyError(new AAError("Reverted", "x", { revertData: impact }))) === "Too big for this rocket right now. Try a smaller amount.", "PriceImpactTooHigh → plain PRICE_IMPACT copy");
  ok(msg(friendlyError(new AAError("Reverted", "x", { revertData: minOut }))) === "Price moved. Tap again.", "MinOutTooLow → plain MIN_OUT copy");
  ok(msg(friendlyError(new AAError("Reverted", "x", { revertData: undefined, actualGasUsed: 1_915_000n, callGasLimit: 1_800_000n }))) === "That didn't go through. Try again.", "out of gas → plain OUT_OF_GAS copy");
  ok(msg(new Error("not enough USDG")) === null, "OTHER keeps the existing message");
  ok(G.plainTradeMessage("PRICE_IMPACT") === "Too big for this rocket right now. Try a smaller amount.", "PRICE_IMPACT copy");
  ok(G.plainTradeMessage("MIN_OUT") === "Price moved. Tap again.", "MIN_OUT copy");
  ok(G.plainTradeMessage("OUT_OF_GAS") === "That didn't go through. Try again.", "OUT_OF_GAS copy");
  { const dropped = new RegExp(["nothing", "was", "spent"].join(" "), "i");   // removed phrase (paymaster may charge USDG gas)
    ok(!Object.values(G.GAME_COPY).some((t) => dropped.test(t)) && !dropped.test(tb + bar + eng + gate), "OUT_OF_GAS copy makes no 'spent' claim"); }
  ok(G.plainTradeMessage("OTHER") === null, "OTHER keeps the existing message");
  for (const t of Object.values(G.GAME_COPY)) ok(!/router|slippage|min ?out|gas/i.test(t), `no jargon: ${t}`);
  ok(/plainReason\(e\) \?\?/.test(tb), "bridge maps thrown failures (the viem client always throws on failure)");
  const rev = new Function(`${eng.match(/function isOnchainRevert\(reason\)\{[^\n]+/)[0]}\nreturn isOnchainRevert;`)();
  ok(!rev("Too big for this rocket right now. Try a smaller amount.") && !rev("Price moved. Tap again.") && !rev("That didn't go through. Try again.") && rev("reverted"), "engine: plain copy isn't prefixed 'trade failed:'");
  // 4) graduate $ = SITE's GradNeed.usdgIn (router-quoted USDG, SITE's +0.1% included) rounded up to the cent; NO extra margin
  const iron = 284_600n;   // IRON testnet 2026-10-24: usdgIn ≈ 0.2846 USDG
  const usd = G.graduateUsdFromUsdg(iron, 6);
  ok(usd >= 0.29 && usd <= 0.30 && usd === 0.29, `IRON graduate $ (${usd})`);
  ok(G.graduateUsdFromUsdg(null) === null && G.graduateUsdFromUsdg(0n) === null, "usdgIn null / 0 ⇒ hide GRADUATE");
  ok(G.graduateUsdFromUsdg(1000n) === 0.2 && G.GRAD_MIN_USD === 0.2 && /const MIN_SHOT=0\.20;/.test(eng), "floored at the engine's live MIN_SHOT ($0.20; smaller live buys are dropped)");
  ok(G.graduateUsdFromUsdg(1_234_567n) === 1.24, "rounds UP to the cent");
  ok(/readGradNeedForToken\(publicClient\(\), token as Address\)/.test(ad) && /graduateUsdFromUsdg\(n\.usdgIn, /.test(ad) && /n\.usdgIn == null/.test(ad), "adapter: SITE readGradNeedForToken usdgIn as-is; null usdgIn hides");
  ok(!/withGradMargin\(|GRAD_QUOTE_MARGIN_BPS/.test(ad.replace(/\/\*[\s\S]*?\*\//g, "") + gate.replace(/\/\*[\s\S]*?\*\//g, "")) && !/import[^\n]*withGradMargin/.test(ad + gate + tb), "no withGradMargin on the spend (classifier tolerance only)");
  ok(!/graduationFromProbe|GRAD_MARGIN_BPS|quotePriceUsd/.test(gate + ad), "old launch-price conversion + 3% margin removed");
  ok(G.graduateLabel(0.3) === "GRADUATE · $0.30" && G.graduateLabel(0.001) === "GRADUATE · $0.01", "label always cents, never $0");
  ok(G.showGraduate(0.3, [1, 5, 25, 100]) && !G.showGraduate(1.5, [1, 5, 25, 100]) && !G.showGraduate(null, [1]), "GRADUATE only when ≤ smallest preset");
  ok(/shoot\("buy", \{ usd: grad \}\)/.test(tb) && /data-testid="grad-btn"/.test(tb) && /data-testid="grad-btn"/.test(bar), "GRADUATE buys the exact curve amount (desktop + phone)");
  // 5) tier bar: exact amount, never ≈$0
  const fmtUsd = new Function(`${eng.match(/const fmtUsd=[^\n]+/)[0]}\nreturn fmtUsd;`)();
  const fmtNeed = new Function("fmtUsd", `${eng.match(/const fmtNeed=[^\n]+/)[0]}\nreturn fmtNeed;`)(fmtUsd);
  ok(fmtNeed(0.0004) === "$0.01" && fmtNeed(0.281) === "$0.29" && fmtNeed(3.5) === "$3.50" && fmtNeed(12.2) === "$13" && fmtNeed(4321) === "$4.3K", "fmtNeed rounds up to the cent");
  ok(/exact\?`\$\{fmtNeed\(need\)\} to graduate`/.test(eng) && /S\.gradBuyUsd!=null&&nx\.lo>=TB_M1&&m<TB_M1/.test(eng), "tier bar uses the exact curve amount at graduation");
  ok(!/≈\$\{fmtUsd\(need\)\}/.test(eng), "no more ≈${fmtUsd(need)} (≈$0)");
  console.log(`test-grad-fix: ${n} checks passed`);
}
