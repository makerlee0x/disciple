// GAME graduation fix (lee 7:04 / 7:09 PM CT 2026-10-24): price-move WARNINGS (never block), exact "$X to graduate" tier label
// (no GRADUATE button, lee 7:56 PM CT),
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
  const boostDis = (s) => ((s.match(/aria-label="buy"[^\n]*/) || [""])[0].match(/disabled=\{[^}]*\}/) || [""])[0];   // the gating expr (post-grad adds hover handlers to the line)
  // rapid-tap (#147) adds the 3-in-flight cap (`|| full`) — not a price-move gate; everything else must match main
  ok(boostDis(tb).replace(/ \|\| full\b/, "") === boostDis(main("components/TradeBridge.tsx")), "BOOST button line unchanged from main (still only cash / min gating, + rapid-tap in-flight cap)");
  ok(/onPickBuy : p\.onPickSell\)\(i\); setSheet\(null\)/.test(bar) && !/ph-opt[^\n]*disabled=\{[^}]*tags/.test(bar), "sheet options stay tappable with a warning");
  ok(/S\.buyWarn=/.test(eng) && !/buyWarn[^\n]*return;/.test(eng) && !/(\bp\.warn|buyWarn)[^\n]*(S\.mode=|selectSell|pending)/.test(eng), "engine: warning tags draw only, never gate select / shoot");
  ok(/S\.buyWarn\.tags\[i\]/.test(eng) && /p\.on&&p\.warn/.test(eng), "engine: buy tiles + sell chips show the tag");
  ok(/on: has, sel: i === sellSel,\n\s*warn: chipTag/.test(tb), "sell chips: `on` stays holdings-only, warn is extra");
  ok(/data-testid="trade-warn"/.test(tb) && /data-testid="trade-warn"/.test(bar), "trade bar + phone bar show the active warning line");
  ok(/liveMaxImpactBps\(\)/.test(tb) && /readRouterMaxImpactBps\(publicClient\(\)\)/.test(ad) && !/10_?000\b/.test(ad) && /moveWarnings\("buy"/.test(tb) && /moveWarnings\("sell"/.test(tb), "TradeBridge reads the live limit + quotes for both sides");
  ok(/"disciple:buywarn"/.test(wb) && /"disciple:gradneed"/.test(wb), "worker forwards the new events");
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
  // 4) tier-bar need = SITE's GradNeed.usdgIn (router-quoted USDG, SITE's +0.1% included) rounded up to the cent; label only
  const need = G.needUsdFromUsdg(284_600n, 6);   // IRON testnet 2026-10-24: usdgIn ≈ 0.2846 USDG
  ok(need === 0.29, `IRON need $ (${need})`);
  ok(G.needUsdFromUsdg(null) === null && G.needUsdFromUsdg(0n) === null, "usdgIn null / 0 ⇒ engine keeps its estimate");
  ok(G.needUsdFromUsdg(1000n) === 0.01 && G.needUsdFromUsdg(1_234_567n) === 1.24, "rounds UP to the cent (no buy floor: it's a label)");
  ok(/readGradNeedForToken\(publicClient\(\), token as Address\)/.test(ad) && /needUsdFromUsdg\(n\.usdgIn, /.test(ad) && /n\.usdgIn == null/.test(ad), "adapter: SITE readGradNeedForToken usdgIn as-is");
  ok(!/withGradMargin|GRAD_QUOTE_MARGIN_BPS|graduationFromProbe|GRAD_MARGIN_BPS|quotePriceUsd/.test(ad.replace(/\/\*[\s\S]*?\*\//g, "") + gate.replace(/\/\*[\s\S]*?\*\//g, "")), "no margins / launch-price maths");
  // GRADUATE button removed everywhere (lee 7:56 PM CT)
  ok(!/grad-btn|ph-grad|graduateLabel|showGraduate|GRAD_MIN_USD|graduateUsdFromUsdg|graduateBuyUsd|usd: grad\b|GRADUATE ·/.test(tb + bar + eng + gate + ad), "no GRADUATE button / chip / amount logic");
  ok(!("graduateLabel" in G) && !("showGraduate" in G) && !("GRAD_MIN_USD" in G), "tradeGate exports no GRADUATE helpers");
  ok(/"disciple:gradneed"/.test(tb) && /graduationStatus\(token\)/.test(tb) && !/disciple:gradbuy/.test(tb + eng + wb), "TradeBridge sends only the tier-bar need");
  // 5) tier bar: exact amount, never ≈$0
  const fmtUsd = new Function(`${eng.match(/const fmtUsd=[^\n]+/)[0]}\nreturn fmtUsd;`)();
  const fmtNeed = new Function("fmtUsd", `${eng.match(/const fmtNeed=[^\n]+/)[0]}\nreturn fmtNeed;`)(fmtUsd);
  ok(fmtNeed(0.0004) === "$0.01" && fmtNeed(0.281) === "$0.29" && fmtNeed(3.5) === "$3.50" && fmtNeed(12.2) === "$13" && fmtNeed(4321) === "$4.3K", "fmtNeed rounds up to the cent");
  ok(/const nt=tierNeedText\(m,nx,[^\n]*S\.tierNeedText=nt/.test(eng) && /exact:S\.gradNeedUsd/.test(eng), "tier bar need line = tierNeedText(exact curve amount | estimate)");
  ok(!/≈\$\{fmtUsd\(need\)\}/.test(eng), "no more ≈${fmtUsd(need)} (≈$0)");
  // ---- post-grad fixes (play-test 8:26–8:30 PM CT on $SGRAD) ----
  // 6) estimate vs exact: ONE line — exact "$X to graduate" when known, else "≈$X … (est.)", never both, never ≈$0, nothing once graduated
  const grab = (re) => { const m = eng.match(re); assert.ok(m, "engine source: " + re); return m[0]; };
  const TB_M1 = 33333;
  const tierNeedText = new Function("fmtNeed", "TB_M1", `${grab(/function tierNeedText\(m,nx,o\)\{[\s\S]*?\n  const need=o\.est;[^\n]*\n/)}\nreturn tierNeedText;`)(fmtNeed, TB_M1);
  const nx = { lo: TB_M1 };
  ok(tierNeedText(30000, nx, { exact: 812.4, est: 900 }) === "$813 to graduate", "exact known ⇒ only '$X to graduate'");
  ok(!/≈|est/.test(tierNeedText(30000, nx, { exact: 812.4, est: 900 })), "exact ⇒ no estimate alongside");
  ok(tierNeedText(30000, nx, { exact: null, est: 900 }) === "≈$900 buys needed (est.)", "no exact ⇒ estimate, clearly marked ≈ … (est.)");
  ok(tierNeedText(30000, nx, { exact: null, est: 0 }) === "" && tierNeedText(30000, nx, { exact: 0, est: 0.0 }) === "" && tierNeedText(30000, nx, { exact: null, est: NaN }) === "", "never ≈$0 / ≈NaN");
  ok(tierNeedText(30000, nx, { graduated: true, exact: 812, est: 900 }) === "" && tierNeedText(40000, { lo: 55000 }, { graduated: true, est: 9000 }) === "", "graduated ⇒ no need text at all");
  ok(tierNeedText(30000, null, { exact: 5 }) === "", "top tier ⇒ nothing");
  // 7) graduated flag: SITE State payload graduated:true on load ≡ live Graduate event; missing ⇒ default false; sticky
  const S = { gradNeedUsd: 120, gradInfo: null, graduated: false };
  const setGraduated = new Function("S", "DiscipleSource", "source", `${grab(/function setGraduated\(on,d\)\{[\s\S]*?\n  try\{[^\n]*\n/)}\nreturn setGraduated;`)(S, class {}, undefined);
  const handler = grab(/if\(e\.graduated===true\)\{[^\n]*/);
  const onEvent = new Function("setGraduated", `return function(e){ ${handler} };`)(setGraduated);
  const src = {}; onEvent.call(src, { type: "State", mcapUsd: 33400 });
  ok(S.graduated === false && !src.graduated, "State without `graduated` ⇒ stays false (default)");
  onEvent.call(src, { type: "State", mcapUsd: 33400, graduated: true, poolId: "0xabc", graduatedAt: 1793149800 });
  ok(S.graduated === true && src.graduated === true && S.gradNeedUsd === null, "simulated State {graduated:true} on load ⇒ graduated, need cleared");
  ok(S.gradInfo.poolId === "0xabc" && S.gradInfo.graduatedAt === 1793149800, "poolId / graduatedAt kept (optional)");
  onEvent.call(src, { type: "Trade", mcapUsd: 34000 });
  ok(S.graduated === true, "later events without the flag keep it (sticky)");
  onEvent.call(src, { type: "State", mcapUsd: 34000, graduated: false, poolId: null, graduatedAt: null });
  ok(S.graduated === true && S.gradInfo.poolId === "0xabc", "graduated:false never un-graduates (sticky — a coin never goes back)");
  { // SITE #158: the first State waits ≤2.5 s for /api/coin/grad and is re-sent when the answer is late ⇒ a late flip to true
    const S2 = { gradNeedUsd: 50, gradInfo: null, graduated: false };
    const sg2 = new Function("S", "DiscipleSource", "source", `${grab(/function setGraduated\(on,d\)\{[\s\S]*?\n  try\{[^\n]*\n/)}\nreturn setGraduated;`)(S2, class {}, undefined);
    const on2 = new Function("setGraduated", `return function(e){ ${handler} };`)(sg2), s2 = {};
    on2.call(s2, { type: "State", mcapUsd: 33400, graduated: false, poolId: null, graduatedAt: null });
    ok(S2.graduated === false, "first State (server late): not graduated yet");
    on2.call(s2, { type: "Trade", mcapUsd: 33400, graduated: false, poolId: null, graduatedAt: null });
    on2.call(s2, { type: "State", mcapUsd: 33400, graduated: true, poolId: "0x" + "ab".repeat(32), graduatedAt: 1793149800 });
    ok(S2.graduated === true && s2.graduated === true && S2.gradInfo.poolId === "0x" + "ab".repeat(32), "re-sent State graduated:true flips the HUD"); }
  ok(!/setGraduated\(false/.test(eng), "nothing ever un-graduates");
  ok(/else if\(e\.type==='Graduate'\)\{ this\.graduated=true; setGraduated\(true,e\);/.test(eng), "live Graduate event → same setGraduated(true)");
  ok(/if\(d\.graduated===true\) setGraduated\(true,d\)/.test(eng), "TradeBridge curve read (gradneed {graduated}) → setGraduated");
  ok(/if ?\(S\.graduated\)\{[^\n]*S\.gradBadge=GRAD_BADGE[^\n]*drawGradBadgeDesk/.test(eng), "desktop tier bar → GRADUATED badge");
  ok(/S\.graduated&&\(!nx\|\|curveTierProgress\(nx\)\)/.test(eng) && /GRAD_BADGE/.test(grab(/function drawPhonePill[\s\S]*?\nfunction /)), "phone pill: curve progress hidden, GRADUATED badge");
  ok(/const GRAD_BADGE='GRADUATED · trading on Uniswap';\s*\/\/ PLACEHOLDER/.test(eng), "badge copy marked PLACEHOLDER");
  ok(/'graduated', 'phoneHolderTags', 'gradBadge', 'tierNeedText'/.test(rd("public/flight/worker.js")), "worker renderer mirrors graduated / badge / need text");
  ok(/send\(live \? st\.usd : null, st\.graduated\)/.test(tb) && /\[valid, live, token\]/.test(tb), "curve read runs for every viewer; exact $ only when live");
  // 8) big-move warning: only the side being tapped / previewed
  const bw = { level: "big", text: "Big move: price +38%", pct: 38 }, sw = { level: "over", text: "Too big · price −62%", pct: 62 };
  ok(G.activeWarning(null, bw, sw, true).text === "", "no active side ⇒ no warning");
  ok(G.activeWarning("buy", bw, sw, true).text === "BOOST: Big move: price +38%" && !G.activeWarning("buy", bw, sw, true).over, "buy side ⇒ only BOOST warning");
  ok(G.activeWarning("sell", bw, sw, true).text === "DUMP: Too big · price −62%" && G.activeWarning("sell", bw, sw, true).over, "sell side ⇒ only DUMP warning");
  ok(G.activeWarning("sell", bw, sw, false).text === "", "sell side with nothing to sell ⇒ nothing");
  ok(!/BOOST: [^\n]*·[^\n]*DUMP:/.test(G.activeWarning("buy", bw, sw, true).text), "never both sides");
  ok(/activeWarning\(phone \? phoneSide : deskSide, buyWarn, sellWarn, has\)/.test(tb) && !/\.join\(" · "\)/.test(tb.match(/const \{ text: warnText[^\n]*/)[0]), "TradeBridge: warn line from the active side only");
  ok((tb.match(/\{\.\.\.hoverSide\("buy"\)\}/g) || []).length >= 2 && (tb.match(/\{\.\.\.hoverSide\("sell"\)\}/g) || []).length >= 3, "desktop: hover / focus on buy + sell controls sets the side");
  ok(/onSide=\{setPhoneSide\}/.test(tb) && /onPointerDown=\{\(\) => p\.onSide\?\.\(side\)\}/.test(bar) && /p\.onSide\?\.\(buy \? "buy" : "sell"\); \(buy \? p\.onPickBuy/.test(bar), "phone: touching a side / picking an amount sets the side");
  ok(/liveMaxImpactBps/.test(tb), "router-limit read kept");
  // 9) holders: tagged rows (kind pool | locker | burn) never ranked, friendly names; 0x…dEaD = burn
  const H = await import("../lib/flight/holders.ts");
  const base = { totalSupplyRaw: 10n ** 24n, priceUsd: 0.0000334 };
  const api = { holders: [
    { address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", balance: "157391735427547906468412", kind: "pool" },
    { address: "0x1111111111111111111111111111111111111111", balance: "50000000000000000000000" },
    { address: "0x000000000000000000000000000000000000dEaD", balance: "40000000000000000000000" },
    { address: "0xa5aaddd75f1bc3b8fb3ecc8845eab0cfa5faed8c", balance: "139537263542902666165", label: "locker" },
    { address: "0x2222222222222222222222222222222222222222", balance: "1000000000000000000" } ], asOfBlock: "1" };
  const r = H.normalizeApiHolders(api, base).rows;
  ok(r.map((x) => x.label || "-").join() === "pool,burn,locker,-,-", `tagged rows on top, then the ranked holders (lee 9:19 PM CT) (${r.map((x) => x.label || "-").join()})`);
  ok(r.filter((x) => !x.label)[0].address === "0x1111111111111111111111111111111111111111", "real holders ranked from #1 below the tagged rows (pool is not #1)");
  ok(H.holderLabelText("pool") === "Pool" && H.holderLabelText("burn") === "Burned" && H.holderLabelText("locker") === "Locked LP" && H.holderLabelText(null) === "", "friendly names");
  const un = H.normalizeApiHolders({ holders: [{ address: "0xe320b53046b263e2b1cefc363aa78c1df5b70bf9", balance: "842400000000000000000000", label: null }] }, base).rows;
  ok(un[0].label === null, "untagged unknown address left alone (no hard-coded guesses)");
  const known = H.normalizeApiHolders({ holders: [{ address: "0xe320b53046b263e2b1cefc363aa78c1df5b70bf9", balance: "1", label: null }] }, { ...base, labels: { "0xe320b53046b263e2b1cefc363aa78c1df5b70bf9": "locker" } }).rows;
  ok(known[0].label === "locker", "client-known pool / locker address labels an untagged row");
  ok(!/BURN_ADDRS|0x000000000000000000000000000000000000dead/i.test(rd("lib/flight/holders.ts")) && /kindOf\(a\) === "burn"/.test(rd("lib/flight/holders.ts")), "burn fallback = SITE kindOf / BURN_ADDRESSES (no GAME table)");
  ok(/holderKinds\(d, \{ lockers: anonLaunchers/.test(rd("components/flight/HoldersBridge.tsx")), "untagged-row fallback = SITE holderKinds");
  const hk = H.normalizeApiHolders({ holders: [
    { address: "0x3333333333333333333333333333333333333333", balance: "9", kind: "holder" },
    { address: "0x4444444444444444444444444444444444444444", balance: "8", kind: "locker" },
    { address: "0x0000000000000000000000000000000000000000", balance: "7" } ] }, { ...base, labels: { "0x3333333333333333333333333333333333333333": "locker" } }).rows;
  ok(hk.map((x) => x.label || "-").join() === "locker,burn,-", `kind 'holder' is ranked unlabelled (API truth), locker tagged, 0x0 = burn (${hk.map((x) => x.label || "-").join()})`);
  { const gc = rd("components/gamechat/GameChat.tsx");
    ok(/\{r\.label \? holderLabelText\(r\.label\) : r\.mine \? "you" : r\.who\}/.test(gc), "desktop holders list: tagged rows show their name");
    ok(gc.indexOf('data-testid="holders-tagged"') > 0 && gc.indexOf('data-testid="holders-tagged"') < gc.indexOf("ranked.map((r, i) => row(r, i))") && /sys\.map\(\(r\) => row\(r, null\)\)/.test(gc), "desktop: tagged rows on top, greyed, unranked; ranked from #1 below"); }
  ok(/items=h\?h\.system\.concat\(h\.items\.slice\(0,10\)\)/.test(eng), "engine → GameChat: tagged rows first");
  ok(/HOLDER_KIND=\{pool:'Pool',locker:'Locked LP',burn:'Burned',curve:'Bonding curve'\}/.test(eng) && /sysAll\.slice/.test(eng), "phone holders tab: tagged rows named (PLACEHOLDER copy)");
  console.log(`test-grad-fix: ${n} checks passed`);
}
