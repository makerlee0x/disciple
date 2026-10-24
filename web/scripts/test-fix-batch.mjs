// GAME fix batch (game/fix-batch-jargon-mode): one check group per fix. Offline: evaluates the engine's own blocks
// (public/flight/engine.js) with stubs + the transpiled lib modules, plus source checks on the React surfaces.
//   1. no phantom gas: the PnL cost basis (incl. the creator's First BOOST seed) and paper cash carry no modelled gas
//   2. BOOST is blocked / greyed out when cash < the selected amount; stale ✕ rows clear when the amount changes
//   3. $TICKER in the MARKET CAP header
//   4. no gas / ETH / slippage / testnet / pair jargon or made-up wallets on game surfaces; dollars only
//   5. TIER line shows the coin's mode + wallet cap, read from the coin (not hardcoded)
//   Run: node scripts/test-fix-batch.mjs   (npm run test:fix-batch)
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const rd = (f) => fs.readFileSync(path.join(web, f), "utf8");
const eng = rd("public/flight/engine.js");
const block = (a, b) => { const i = eng.indexOf(a), j = eng.indexOf(b, i + 1); if (!(i > 0 && j > i)) throw new Error("engine block " + a); return eng.slice(i, j); };
const fmt = (u) => "$" + (+u).toFixed(2);
globalThis.localStorage = { m: {}, getItem(k) { return this.m[k] ?? null; }, setItem(k, v) { this.m[k] = String(v); } };
const { mods, cleanup } = await loadLib(["config", "pnl", "flight/coinRulesLabel"], "fixbatch-");
const P = mods.pnl, R = mods["flight/coinRulesLabel"];

// ───────────── 1. no phantom gas in the cost basis ─────────────
console.log("— 1. no phantom gas");
{ const b = P.applyFill(P.emptyPosition(), "buy", 100, 1e-5);
  ok(near(b.costBasis, 100), `a $100 BUY books a $100 cost basis (got ${b.costBasis}; was $100 + ~$0.01 modelled gas)`);
  const x = P.applyExactFill(P.emptyPosition(), "buy", { usd: 100, tokens: 9.9e6 });
  ok(near(x.costBasis, 100), `exact (receipt) BUY: cost basis = USDG spent, no gas (got ${x.costBasis})`);
  const s = P.seedCreatorBuyPosition("fixbatch:seed", 7e6, 50, 7e9, 1);
  ok(s && near(s.costBasis, 50), `creator First BOOST seed: cost basis = $ spent (got ${s && s.costBasis}; was $50 + gas)`);
  ok(!("gasUsd" in P) && !/from "\.\/config";[^\n]*\bGAS\b/.test(rd("lib/pnl.ts")) && !/import\s*\{[^}]*\bGAS\b[^}]*\}\s*from "\.\/config"/.test(rd("lib/pnl.ts")), "lib/pnl has no gas model (gasUsd / GAS import gone)");
  const hud = rd("components/PnlHud.tsx");
  ok(!/f\.gas/.test(hud), "PnL HUD books fills with gas 0 (never the fill's gas field)");
  ok(/gas:0,/.test(eng) && !/gas:GAS_USD|gas:r\.gas/.test(eng), "engine paper fills carry gas:0");
  ok(!/\bGAS_USD\b/.test(eng) && !/S\.balance\s*\+=[^;\n]*GAS/.test(eng), "paper cash is not charged a modelled gas (GAS_USD gone)");
  // red only because of the buy fee → "incl. $X buy fees"
  const pos = P.applyFill(P.emptyPosition(), "buy", 100, 1e-5), v = P.view(pos, 1e-5, 7e9, Date.now());
  const fee = P.redFromBuyFees(pos, v);
  ok(v.uPnl < 0 && near(fee, 100 * P.FEE), `flat price right after a buy: uPnL ${v.uPnl.toFixed(2)} red only from the buy fee → note ${fee.toFixed(2)}`);
  const v2 = P.view(pos, 0.5e-5, 7e9, Date.now());
  ok(P.redFromBuyFees(pos, v2) === 0, "price really down: no buy-fee note (the loss is not just fees)");
  ok(/pnl-buy-fees/.test(hud) && /redFromBuyFees\((pos, v|\{ \.\.\.pos, costBasis: basis \}, \{ size: tracked \? v\.size : 0, uPnl: v\.uPnl \})\)/.test(hud) && /"pnl\.inclBuyFees": "incl\. \{fee\} buy fees"/.test(rd("lib/game/i18n.ts")), "PnL HUD labels it 'incl. $X buy fees'"); }

// ───────────── 2. BOOST vs cash ─────────────
console.log("— 2. BOOST cash check");
function tradeEnv({ live = false, balance = 100, liveCash = null, usd = 10, sim = false } = {}) {
  const E = { submits: [], flashes: [] };
  const S = { fuelers: { you: 0 }, hold: { tokens: 1e3, valueUsd: 5 }, liveBag: live ? { tokens: 100 } : null, flashes: E.flashes, mode: 0, balance, liveCash, confirmed: { mcap: 7e4 }, promoLeft: 0 };
  const env = { S, MAX_PENDING: 3, MODES: [{ usd }], hasTokens: () => true, noTokens() {}, isLive: () => live, markMcap: () => 7e4, source: { supply: 7e9, isSim: sim },
    MIN_SHOT: 0.2, PROMO_GAS: false, GAS_USD: 0, applyThrust() {}, srcImpact: () => 1, fmtShot: fmt, window: live ? { __discipleTrade() {} } : {},
    submit: (side, u, force, opt) => E.submits.push({ side, usd: u, opt }) };
  E.trade = new Function(...Object.keys(env), block("/* @trade", "/* @trade-end */") + "\nreturn trade;")(...Object.values(env));
  return E; }
{ let E = tradeEnv({ balance: 5, usd: 10 }); E.trade("buy");
  ok(E.submits.length === 0 && E.flashes.some((f) => /NOT ENOUGH CASH/.test(f.txt) && /\$10\.00/.test(f.txt) && /\$5\.00/.test(f.txt)), "paper: $10 BOOST with $5 cash is blocked, flash says both $ amounts");
  E = tradeEnv({ balance: 50, usd: 10 }); E.trade("buy"); ok(E.submits.length === 1, "paper: $10 BOOST with $50 cash goes through");
  E = tradeEnv({ live: true, liveCash: 3, usd: 100 }); E.trade("buy");
  ok(E.submits.length === 0, "live: $100 BOOST with $3 cash never leaves the engine (was: a failed '✕ not enough cash' row per press)");
  E = tradeEnv({ live: true, liveCash: 250, usd: 100 }); E.trade("buy"); ok(E.submits.length === 1, "live: enough cash → submitted");
  E = tradeEnv({ live: true, liveCash: null, usd: 100 }); E.trade("buy"); ok(E.submits.length === 1, "live: cash unknown yet → not blocked (the trade path still checks)");
  E = tradeEnv({ live: true, liveCash: 0, usd: 10 }); E.trade("sell", { usd: 5, frac: 0.5 }); ok(E.submits.length === 1, "sells never need cash");
  E = tradeEnv({ balance: 100, usd: 0.1 }); E.trade("buy");
  ok(E.submits.length === 0 && E.flashes.some((f) => /^MINIMUM BUY \$0\.20$/.test(f.txt)), "below the $0.20 minimum: blocked with 'MINIMUM BUY $0.20' (no gas wording)"); }
function cashEnv({ live = false, balance = 100, sim = false, usd = 10 } = {}) {
  const L = {}, out = [];
  const S = { feed: [], balance, mode: 0, customBuyUsd: 0 };
  const env = { S, MAX_PENDING: 3, MODES: [{ usd }, { usd: 25 }], source: { isSim: sim }, window: live ? { __discipleTrade() {} } : {}, MIN_SHOT: 0.2, fmtMoney: fmt, fmtShot: fmt,
    keepIf: (arr, pred) => { const k = arr.filter(pred); arr.length = 0; arr.push(...k); return arr; },
    addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); }, dispatchEvent: (e) => out.push(e), CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } } };
  const C = new Function(...Object.keys(env), block("/* @cash", "/* @cash-end */") + block("/* @rules", "/* @rules-end */") + "\nreturn {activeBuyUsd,cashNow,boostShort,noteBuyAmount,cashLineText,pushPaperCash,tierRulesText};")(...Object.values(env));
  C.emit = (t, d) => (L[t] || []).forEach((f) => f({ detail: d })); C.S = S; C.out = out; return C; }
{ let C = cashEnv({ balance: 5, usd: 10 });
  ok(C.boostShort() && /^PAPER \$5\.00 · not enough cash for \$10\.00$/.test(C.cashLineText()), `paper HUD line: "${C.cashLineText()}"`);
  C = cashEnv({ live: true, usd: 10 }); C.emit("disciple:cash", { usd: 42.1 });
  ok(!C.boostShort() && C.cashLineText() === "CASH $42.10", `live HUD line in dollars from disciple:cash: "${C.cashLineText()}"`);
  C.emit("disciple:cash", { usd: 4 }); ok(C.boostShort(), "live cash drops below the amount → BOOST short");
  C = cashEnv({ sim: true, balance: 1, usd: 10 }); ok(!C.boostShort() && C.cashLineText() === "SIM $1.00", "simulator: its own balance check, plain 'SIM $x' line");
  C = cashEnv({ balance: 100 }); C.noteBuyAmount();
  C.S.feed.push({ txt: "✕ not enough cash: need $100.00, have $3.00", err: 1 }, { txt: "▲ you BOOST $10" }, { txt: "✕ not enough cash: need $100.00, have $3.00", err: 1 });
  C.noteBuyAmount(); ok(C.S.feed.length === 3, "same amount: rows stay");
  C.S.mode = 1; C.noteBuyAmount(); ok(C.S.feed.length === 1 && !C.S.feed[0].err, "amount changes (preset 1 → 2): stale ✕ error rows leave the TRADES feed");
  C.S.feed.push({ txt: "✕ x", err: 1 }); C.S.customBuyUsd = 3; C.emit("disciple:custombuy", { usd: 3 }); C.noteBuyAmount(); ok(C.S.feed.length === 1, "custom $ change also clears them");
  C = cashEnv({ balance: 77 }); C.pushPaperCash(); ok(C.out.some((e) => e.type === "disciple:papercash" && e.detail.usd === 77), "engine pushes paper cash to the trade bar (disciple:papercash)");
  ok(/S\.feed\[0\]\.txt===txt/.test(eng), "the same failure again doesn't stack another row");
  ok(/noteBuyAmount\(\); pushPaperCash\(\);/.test(block("function pushAmmo", "function setAmmoTier")), "preset / tier changes run the amount check (pushAmmo)");
  const tb = rd("components/TradeBridge.tsx");
  const boostBtn = tb.slice(tb.indexOf('data-testid="buy-btn"'), tb.indexOf('data-testid="sell-btn"'));
  ok(/aria-disabled=\{short( \|\| full)?\} disabled=\{short( \|\| full)?\}/.test(boostBtn) && /opacity: short( \|\| full)? \? 0\.4 : 1/.test(boostBtn) && /cursor: short( \|\| full)? \? "not-allowed"/.test(boostBtn), "BOOST button greys out + disables when short (same pattern as DUMP; rapid-tap: also when 3 are in flight)");
  ok(/const short = (rawLive \? !canSpend\(CASH_RAW\.v!, shotUsd, dec\) : )?(cashUsd|spendable) != null && (cashUsd|spendable) \+ 1e-9 < shotUsd/.test(tb) && /const cashUsd = live \? liveCash : paperCash/.test(tb), "short = cash (live USDG / paper balance; live: minus pending reservations + gas) < the active BOOST amount (custom $ wins)");
  ok(/ownBalance\(pc, usdg, me, \(\) => balanceHint\(pc, usdg, me, 4000\)\), decimalsOf\(pc, usdg\)/.test(tb) && /new CustomEvent\("disciple:cash"/.test(tb), "live cash = the account's USDG, pushed to the engine (disciple:cash)");
  ok(/setLast\(\(l\) => \(l\.startsWith\("✕"\) \? "" : l\)\); setHint\(""\); \}, \[amtKey\]\)/.test(tb), "trade bar drops a stale ✕ line when the amount changes");
  const wb = rd("lib/flight/workerBridge.ts");
  ok(['"disciple:cash"', '"disciple:coinrules"'].every((e) => wb.includes(e)), "worker render path forwards disciple:cash + disciple:coinrules to the engine"); }

// ───────────── 3. $TICKER in the mcap header ─────────────
console.log("— 3. ticker in header");
{ const S = { coinRules: null }; let source = { ticker: "" }; const q = new Map();
  const env = { S, Q: { get: (k) => q.get(k) ?? null } };
  const T = new Function(...Object.keys(env), "let source;" + block("function coinTicker", "function grassLine") + "\nreturn {coinTicker, set:(s)=>{source=s;}};")(...Object.values(env));
  T.set(source); q.set("cs", "doge");
  ok(T.coinTicker() === "DOGE", "no coin data yet: falls back to the page's ?cs call sign");
  S.coinRules = { ticker: "$pepe" }; ok(T.coinTicker() === "PEPE", "the coin's own symbol (disciple:coinrules) wins");
  S.coinRules = { ticker: "<script>" }; ok(T.coinTicker() === "DOGE", "junk symbols are ignored");
  const hud = block("function drawHud(){", "// progress to next tier");
  ok(/\(coinTicker\(\)\?'\$'\+coinTicker\(\)\+' · ':''\)\+'MARKET CAP · confirmed'/.test(hud), "header draws '$TICKER · MARKET CAP · confirmed'");
  const lbl = new Function("coinTicker", block("function chartPoolLabel", "\nconst p2") + "\nreturn chartPoolLabel;");
  ok(lbl(() => "PEPE")() === "$PEPE" && lbl(() => "")() === "PRICE", "chart title is '$TICKER' (was 'COIN/STRATEGY 1%')"); }

// ───────────── 4. jargon ─────────────
console.log("— 4. jargon");
{ const banned = ["gas ~$", "gas would eat", "(onchain only)", "onchain + your paper", "COIN/STRATEGY", "STRATEGY 1%", "below min shot", "BELOW MIN SHOT", "no gas", "0xA11…ce", "0xB0b…42", "0xC4t…77", "tx reverted", "TX REVERTED", "slippage guard", "on-chain balances", "INSUFFICIENT DEPOSITED"];
  const code = eng.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");   // comments may say what it WAS
  ok(code.length > eng.length * 0.5 && code.includes("function drawHud(){"), "comment strip kept the code");
  for (const b of banned) ok(!code.includes(b), `engine.js code has no "${b}"`);
  // every HUD string the engine draws or pushes as a row/flash: no gas / ETH / slippage / testnet / pair wording
  const lits = [];
  for (const m of eng.matchAll(/(?:fillText\(|txt:|kothTitle=)([^;]{0,300})/g)) for (const s of m[1].matchAll(/'([^'\n]*)'|`([^`\n]*)`/g)) lits.push(s[1] ?? s[2]);
  const jar = lits.filter((s) => /\bgas\b|\bETH\b|\bWETH\b|slippage|testnet|\bpair\b|onchain|on-chain|\bgwei\b/i.test(s));
  ok(lits.length > 50 && jar.length === 0, `engine HUD text (${lits.length} strings) is jargon-free${jar.length ? ": " + jar.join(" | ") : ""}`);
  ok(/fuelers:\{'you':0\}/.test(eng) && /e\.trader\?short\(e\.trader\):null; if\(who\)/.test(eng), "no made-up wallets seeded or credited for unknown traders");
  const tb = rd("components/TradeBridge.tsx");
  ok(!/b\.venue/.test(tb) && !/✓ \$\{r\.txHash/.test(tb), "trade bar: no venue name / tx hash in the status line");
  const i18n = rd("lib/game/i18n.ts"), pctTitles = [...i18n.matchAll(/"pnl\.pctTitle": "([^"]*)"/g)].map((m) => m[1]);
  ok(pctTitles.length >= 5 && pctTitles.every((s) => !/gas|ガス|가스/i.test(s)), "PnL % tooltip (all languages) no longer mentions gas");
  ok(!/sell gas/.test(rd("components/PnlHud.tsx")), "PnL HUD exit-fee tooltip has no 'sell gas'");
  ok(/>Price protection <Icon/.test(rd("components/trade/SwapSettingsModal.tsx")), "Swap settings say 'Price protection' (not 'Slippage')"); }

// ───────────── 5. mode + cap on the TIER line ─────────────
console.log("— 5. mode + cap on the TIER line");
{ const SUP = BigInt(7e9) * BigInt(1e18), pct = (bps) => (SUP * BigInt(bps)) / BigInt(10000);
  ok(R.capBpsOf(R.UINT_MAX, SUP) === null, "netCapNow = uint256 max → no cap");
  ok(R.capBpsOf(pct(100), SUP) === 100 && R.capBpsOf(pct(333), SUP) === 333 && R.capBpsOf(pct(777), SUP) === 777, "netCapNow tokens → bps of supply (1%, 3.33%, 7.77%)");
  ok(R.rulesLabel(0, null) === "TRENCH · no cap", "TRENCH · no cap");
  ok(R.rulesLabel(1, 100) === "EASY · cap 1%", "EASY · cap 1%");
  ok(R.rulesLabel(2, 333) === "HARD · cap 3.33%" && R.rulesLabel(1, 525.6) === "EASY · cap 5.26%", "HARD · cap 3.33% (dynamic caps keep ≤ 2 decimals)");
  const C = cashEnv(); ok(C.tierRulesText() === "", "no coin data → no rules text (nothing hardcoded)");
  C.emit("disciple:coinrules", { label: "EASY · cap 1%" }); ok(C.tierRulesText() === "EASY · cap 1%", "disciple:coinrules → TIER line text");
  C.emit("disciple:coinrules", null); ok(C.tierRulesText() === "", "cleared when the page drops it");
  const hud = block("function drawHud(){", "// progress to next tier");
  ok(/TIER \$\{ti\} · \$\{t\.name\}`,36,108\);\s*\{ const rl=tierRulesText\(\); if\(rl\)/.test(hud) && /ctx\.fillText\('  ·  '\+rl,x,108\)/.test(hud), "TIER line: 'TIER n · NAME  ·  <mode · cap>'");
  const cr = rd("lib/flight/coinRules.ts");
  ok(/functionName: "netCapNow"/.test(cr) && /coinFacts\(pc, token\)/.test(cr) && /functionName: "symbol"/.test(cr), "rules are read from the coin: BondingCurve.mode() (coinFacts) + netCapNow() + symbol");
  ok(/readCoinRules\(pc, token as Address\)/.test(rd("components/TradeBridge.tsx")) && /setInterval\(poll, 15_000\)/.test(rd("components/TradeBridge.tsx")), "TradeBridge polls them (caps move with mcap after the mode-rules-v2 redeploy)"); }

cleanup();
console.log(bad ? `\n${bad} FAILED` : "\nall fix-batch checks passed");
process.exit(bad ? 1 : 0);
