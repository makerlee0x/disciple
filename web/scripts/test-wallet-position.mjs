// HUD position from the ACTUAL wallet balance (game/position-from-wallet). maker lee: "should be from actual wallet balance."
// Live test bug (coin GOLDEN): the HUD showed $8.10 (the one $10 buy the ledger tracked) while the wallet held 197.22M
// tokens (≈$230, mostly bought before); DUMP 100% read balanceOf and sold all 197.22M. Now:
//   1. live holdings $ = wallet balanceOf × mark (lib/pnl walletView) = exactly what DUMP 100% sells (liveSell.sellAmountFor)
//   2. PnL / % / avg entry only on the TRACKED (known-cost) part; untracked tokens: value shown, no invented cost basis
//   3. a live sell closes the tracked bag pro-rata to the wallet (receipt bag); stale ledger > wallet shrinks pro-rata
//   4. paper / sim fills unchanged (no bag ⇒ old booking); source wiring: PnlHud ← disciple:holdings ← TradeBridge
//   Run: node scripts/test-wallet-position.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { loadLib } from "./lib/load-ts.mjs";
const dir = path.dirname(fileURLToPath(import.meta.url)), web = path.join(dir, "..");
let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const { mods, cleanup } = await loadLib(["config", "pnl", "flight/fills", "flight/liveSell"], "walletpos-");
const P = mods.pnl, F = mods["flight/fills"], LS = mods["flight/liveSell"];
const SUP = 7e9, E18 = 10n ** 18n;

// ── 1. GOLDEN repro ────────────────────────────────────────────────────────────────────────────────────────────
// mark: $230 / 197.22M tokens; one tracked $10 buy received ≈ 6.95M tokens (worth ≈ $8.10 at the mark)
const walletRaw = 197_220_000n * E18 + 123_456_789n;   // balanceOf (raw, 18 dec)
const wallet = F.units(walletRaw), price = 230 / 197.22e6, mcap = price * SUP;
const trackedTokens = 8.10 / price;
let led = P.applyExactFill(P.emptyPosition(), "buy", { usd: 10, tokens: trackedTokens }, 0, 1);
const old = P.view(led, price, SUP);
ok(near(old.valueUsd, 8.10, 1e-6), `before: ledger-only HUD showed ${P.fmtMoney(old.valueUsd)} (the bug)`);
const wv = P.walletView(led, wallet, price, SUP, 2);
ok(near(wv.size, wallet) && near(wv.valueUsd, wallet * price), `after: HUD holdings = wallet ${P.fmtMoney(wv.valueUsd)} (balanceOf × mark)`);
ok(near(wv.tracked, trackedTokens) && near(wv.untracked, wallet - trackedTokens), `tracked ${P.fmtMoney(wv.trackedUsd)} + untracked ${P.fmtMoney(wv.untrackedUsd)} = holdings`);
ok(near(wv.trackedUsd + wv.untrackedUsd, wv.valueUsd), "tracked $ + untracked $ = holdings $");
ok(near(wv.uPnl, 8.10 - 10, 1e-6) && near(wv.pnlPct, old.pnlPct) && near(wv.costBasis, 10), `PnL only on the tracked $10 buy: ${P.fmtPnl(wv.uPnl)} ${P.fmtPct(wv.pnlPct)} (no invented basis for the rest)`);
ok(near(wv.entryMcap, old.entryMcap), "avg entry = the tracked buys' entry");
// the HUD number and the DUMP 100% amount come from the same balance
const dumpAll = LS.sellAmountFor(walletRaw, { all: true }), dumpHalf = LS.sellAmountFor(walletRaw, { frac: 0.5 });
ok(dumpAll === walletRaw && near(F.units(dumpAll), wv.size), "DUMP 100% sells exactly the balance the HUD shows");
ok(near(F.units(dumpHalf) * price, wv.valueUsd * 0.5, 1e-6), "DUMP 50% sells half of the HUD holdings $");

// ── 2. no tracked buys at all (pre-existing bag only) ─────────────────────────────────────────────────────────
const w0 = P.walletView(P.emptyPosition(), wallet, price, SUP);
ok(near(w0.valueUsd, wallet * price) && w0.uPnl === 0 && w0.pnlPct === 0 && w0.tracked === 0 && w0.costBasis === 0 && w0.entryMcap === 0,
  "untracked-only wallet: holdings shown, PnL 0 / % 0 / no avg entry (nothing invented)");
ok(w0.bonus === P.walletView(P.emptyPosition(), 0, price, SUP).bonus, "points multiplier not boosted by untracked tokens (same as an empty bag)");
// paper / sim path unchanged: wallet null ⇒ view(ledger)
const pv = P.view(led, price, SUP, 2);
ok(near(pv.valueUsd, 8.10, 1e-6), "paper / sim: HUD = ledger (view) as before");

// ── 3. live sells split tracked / untracked pro-rata ──────────────────────────────────────────────────────────
{ // 50% DUMP of the GOLDEN wallet: closes 50% of the tracked bag, realized gets only the tracked share of the proceeds
  const sold = wallet * 0.5, usdOut = sold * price * (1 - P.FEE), fee = sold * price * P.FEE;
  const s = P.applyExactFill(led, "sell", { usd: usdOut, tokens: sold, feeUsd: fee, bag: wallet }, 0, 3);
  ok(near(s.size, trackedTokens * 0.5) && near(s.costBasis, 5), `50% DUMP: tracked bag halves (${P.fmtMoney(s.costBasis)} basis left)`);
  ok(near(s.realized, (8.10 * 0.5) - 5, 1e-6), `realized = tracked share only: ${P.fmtPnl(s.realized)} (not the untracked $${(sold * price - 4.05).toFixed(2)})`);
  const w2 = P.walletView(s, wallet - sold, price, SUP);
  ok(near(w2.valueUsd, (wallet - sold) * price) && near(w2.uPnl, 4.05 - 5, 1e-6), "after 50%: HUD holdings = remaining wallet, uPnL on the remaining tracked half");
  // old behaviour (no bag): the whole ledger closed on a 50% wallet sell
  const legacy = P.applyExactFill(led, "sell", { usd: usdOut, tokens: sold, feeUsd: fee }, 0, 3);
  ok(legacy.size === 0, "without bag (paper / old callers): a sell larger than the ledger still closes the ledger (unchanged)");
}
{ // 100% DUMP: everything closes
  const usdOut = wallet * price * (1 - P.FEE), fee = wallet * price * P.FEE;
  const s = P.applyExactFill(led, "sell", { usd: usdOut, tokens: wallet, feeUsd: fee, bag: wallet }, 0, 3);
  ok(s.size === 0 && s.costBasis === 0 && near(s.realized, 8.10 - 10, 1e-6), `100% DUMP: ledger flat, realized ${P.fmtPnl(s.realized)} on the tracked $10 only`);
  ok(P.walletView(s, 0, price, SUP).valueUsd === 0, "HUD holdings $0 after DUMP 100%");
}
{ // estimate (applyFill, % sell) and receipt agree on the tracked share; reconcileFill carries the receipt's bag
  const est = P.bookPending(led, [], { id: "0xa", side: "sell", est: { usd: wallet * price * 0.25, price, gas: 0, at: 4, frac: 0.25, bag: wallet } });
  ok(near(est.pos.size, trackedTokens * 0.75), "estimate: 25% sell closes 25% of the tracked bag");
  const sold = wallet * 0.25;
  const r = P.reconcileFill(est.pending, "0xa", { usd: sold * price * (1 - P.FEE), tokens: sold, feeUsd: sold * price * P.FEE, bag: wallet });
  ok(r && near(r.pos.size, trackedTokens * 0.75) && r.pending.length === 0, "receipt (exact, bag) reconciles to the same tracked share");
  // $ sell (custom $) with bag: closes the tracked share of the tokens sold
  const d = P.applyFill(led, "sell", wallet * price * 0.1, price, 0, 5, undefined, wallet);
  ok(near(d.size, trackedTokens * 0.9), "custom $ sell (estimate): pro-rata on the tracked bag");
}

// ── 4. stale ledger (tokens left the wallet outside the game) ─────────────────────────────────────────────────
{
  const big = P.applyExactFill(P.emptyPosition(), "buy", { usd: 100, tokens: 1e6 }, 0, 1);
  const v = P.walletView(big, 4e5, 1e-4, SUP);
  ok(near(v.size, 4e5) && near(v.tracked, 4e5) && near(v.costBasis, 40) && v.untracked === 0, "ledger > wallet: HUD = wallet, basis scaled pro-rata (40% of $100)");
  const s = P.shrinkToWallet(big, 4e5);
  ok(near(s.size, 4e5) && near(s.costBasis, 40) && s.realized === 0, "shrinkToWallet: pro-rata basis, nothing booked to realized (proceeds unknown)");
  ok(P.shrinkToWallet(big, 2e6) === big, "shrinkToWallet never grows the ledger");
  ok(P.shrinkToWallet(big, 0).size === 0, "wallet emptied elsewhere ⇒ ledger flat");
  const sell = P.applyExactFill(big, "sell", { usd: 40, tokens: 4e5, feeUsd: 0.4, bag: 4e5 }, 0, 2);
  ok(sell.size === 0 && near(sell.realized, 40.4 - 40), "100% DUMP of a stale ledger: settles to the wallet first, then closes it all");
}

// ── 5. wiring (source checks) ─────────────────────────────────────────────────────────────────────────────────
const hud = fs.readFileSync(path.join(web, "components/PnlHud.tsx"), "utf8"), tb = fs.readFileSync(path.join(web, "components/TradeBridge.tsx"), "utf8");
ok(/addEventListener\("disciple:holdings"/.test(hud) && /walletView\(pos, wallet\.tokens/.test(hud), "PnlHud: live position = walletView(ledger, disciple:holdings tokens)");
ok(/wallet \? walletView[\s\S]{0,80}: null/.test(hud) && /\?\? view\(pos, price/.test(hud), "PnlHud: no wallet (paper / sim) ⇒ ledger view");
ok(!/amt\(v\.size\)/.test(hud), "PnlHud: holdings shown in dollars only (no token amount)");
const poll = tb.slice(tb.indexOf("const [liveHas, setLiveHas]"), tb.indexOf("const [liveCash, setLiveCash]"));
ok(/freshSellBalance\(\(\) => ownBalance\(pc, token as Address, me, \(\) => tokenBalance/.test(poll), "TradeBridge: HUD balance read = freshSellBalance (the read DUMP sizes from)");
ok(/addEventListener\("disciple:ownbalance"/.test(poll) && /addEventListener\("disciple:livetrade"/.test(poll) && /void poll\(\)/.test(poll), "TradeBridge: refreshed on load, after each trade and when a receipt lands");
ok(/settled/.test(poll), "TradeBridge: holdings carry `settled` (ledger only shrinks when no own trade is in flight)");
ok(/bag = units\(bal\)/.test(tb) && /bookReceipt\(r\.txHash, side, (rp, )?bag\)/.test(tb), "TradeBridge: sell receipt carries the balance it was sized from");
const sim = fs.readFileSync(path.join(web, "components/sim/SimMode.tsx"), "utf8");
ok(/<TradeBridge token="SIMULATOR"/.test(sim) && /if \(!live\) \{ setLiveHas\(null\); dispatchEvent\(new CustomEvent\("disciple:holdings", \{ detail: null \}\)\)/.test(poll),
  "sim: TradeBridge token SIMULATOR is never live ⇒ holdings null ⇒ the sim's own ledger stays the position");

cleanup();
console.log(bad ? `\n${bad} FAILED` : "\nall wallet-position checks passed");
process.exit(bad ? 1 : 0);
