/** Add cash plan A (maker 2026-11-14): Send crypto routes, Turbo leave choice, Load fuel picks, Across move quotes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coinsFor, netsFor, routeFor, DEPOSIT_COPY, type DepositConfigLike } from "../lib/deposit.ts";
import { leaveAction, loadLeavePref, loadPicks, saveLeavePref, LEAVE_COPY, LOAD_COPY, MOVE_FEE_EST_USD } from "../lib/turbo/leave.ts";
import { ARBITRUM_ID, ARBITRUM_USDC, legs, moveQuoteUrl, parseMoveQuote } from "../lib/bridge/across.ts";
import { FUND_CARD_FEE_EST, FUND_COPY } from "../lib/fund.ts";

const RH = "eip155:4663";
const CFG: DepositConfigLike = { currencies: [
  { symbol: "USDC", chains: [{ caip2: "eip155:8453", address: "0xbase", decimals: 6 }, { caip2: "eip155:42161", address: "0xarb", decimals: 6 }] },
  { symbol: "ETH", chains: [{ caip2: "eip155:1", address: "0x0000000000000000000000000000000000000000", decimals: 18 }] },
] };

test("send crypto: networks follow the live config, USDG on our chain is always direct", () => {
  assert.deepEqual(netsFor("USDC", CFG, RH).map((n) => n.name), ["Base", "Arbitrum"]);
  assert.deepEqual(netsFor("USDC", null, RH).map((n) => n.name), ["Base", "Ethereum", "Arbitrum", "Solana", "Polygon"]);
  assert.deepEqual(netsFor("USDG", CFG, RH).map((n) => n.name), ["Robinhood Chain"]);
  assert.deepEqual(coinsFor(CFG, RH), ["USDC", "ETH", "USDG"]);
  const direct = routeFor("USDG", netsFor("USDG", CFG, RH)[0], CFG, RH);
  assert.equal(direct?.direct, true);
  const swap = routeFor("USDC", netsFor("USDC", CFG, RH)[1], CFG, RH);
  assert.deepEqual([swap?.direct, swap?.sourceCurrency], [false, "0xarb"]);
  assert.equal(routeFor("USDT", { id: "eth", name: "Ethereum", caip2: "eip155:1" }, CFG, RH), null);
});

test("leaving Turbo: no fuel just leaves, otherwise the saved choice (default ask)", () => {
  assert.equal(leaveAction(0, "ask"), "leave");
  assert.equal(leaveAction(0.004, "move"), "leave");
  assert.equal(leaveAction(null, "ask"), "leave");
  assert.equal(leaveAction(13.2, "ask"), "ask");
  assert.equal(leaveAction(13.2, "keep"), "keep");
  assert.equal(leaveAction(13.2, "move"), "move");
  const mem = new Map<string, string>();
  const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } } as unknown as Storage;
  assert.equal(loadLeavePref(s), "ask");
  saveLeavePref("keep", s);
  assert.equal(loadLeavePref(s), "keep");
});

test("load fuel picks: $10 / $20 / $30 / All (whole cash, cents floored)", () => {
  assert.deepEqual(loadPicks(42.109), [{ label: "$10", usd: 10 }, { label: "$20", usd: 20 }, { label: "$30", usd: 30 }, { label: "All", usd: 42.1 }]);
  assert.equal(loadPicks(-5)[3].usd, 0);
});

test("across: request url and calls", () => {
  const usdg = "0x5fc1bbe7f2b3b1c1e1f6d1b0ac1b1a1a1a1a1a1a";
  const { toTurbo, toCash } = legs(4663, usdg);
  assert.deepEqual([toTurbo.destinationChainId, toTurbo.outputToken, toCash.originChainId, toCash.inputToken], [ARBITRUM_ID, ARBITRUM_USDC, ARBITRUM_ID, ARBITRUM_USDC]);
  const u = new URL(moveQuoteUrl({ ...toTurbo, amount: BigInt(20_000_000), depositor: "0xabc", recipient: "0xdef" }));
  assert.equal(u.pathname, "/api/swap/approval");
  assert.deepEqual([u.searchParams.get("amount"), u.searchParams.get("originChainId"), u.searchParams.get("destinationChainId"), u.searchParams.get("tradeType")], ["20000000", "4663", "42161", "exactInput"]);
  const to = "0x" + "11".repeat(20), sp = "0x" + "22".repeat(20);
  const q = parseMoveQuote({ approvalTxns: [{ chainId: 4663, to, data: "0x095ea7b3" }], swapTx: { chainId: 4663, to: sp, data: "0xad5425c6", value: "0" },
    expectedOutputAmount: "19970000", minOutputAmount: "19900000", fees: { total: { amountUsd: "0.03" } }, expectedFillTime: 2 }, 4663);
  assert.deepEqual(q.calls.map((c) => c.to), [to, sp]);
  assert.equal(q.calls[1].value, undefined);
  assert.deepEqual([q.expectedOut, q.minOut, q.feeUsd, q.fillSec], [BigInt(19970000), BigInt(19900000), 0.03, 2]);
  assert.throws(() => parseMoveQuote({}, 4663), /no swapTx/);
  assert.throws(() => parseMoveQuote({ swapTx: { chainId: 42161, to: sp, data: "0x" } }, 4663), /wrong chain/);
  assert.throws(() => parseMoveQuote({ swapTx: { to: "0x12", data: "0x" } }, 4663), /bad tx/);
});

test("copy: plain words, the fee always shows, no chain names outside Send crypto", () => {
  assert.equal(MOVE_FEE_EST_USD, 0.25);
  assert.ok(FUND_CARD_FEE_EST > 0 && FUND_CARD_FEE_EST < 0.1);
  assert.equal(LEAVE_COPY.fee("$0.25"), "About $0.25 move fee");
  assert.equal(LEAVE_COPY.keep, "Keep fuel in Turbo");
  const plain = [FUND_COPY.button, FUND_COPY.sub, FUND_COPY.sendTitle, FUND_COPY.sendSub, LOAD_COPY.lead, LOAD_COPY.sub, LEAVE_COPY.body("$13.20"), LEAVE_COPY.dontAsk].join(" ");
  assert.doesNotMatch(plain, /USDG|USDC|Arbitrum|Robinhood|chain|bridge|token/i);
  assert.match(DEPOSIT_COPY.fee("USDC", "Base"), /Send only USDC on Base/);
});
