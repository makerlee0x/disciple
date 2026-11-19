/**
 * Own fill → engine Trade straight from the relay's receipt logs (maker 2026-11-18: sells felt ~1 s slower than buys and
 * the chart lagged the fill). lib/events receiptTradeLogs builds the same rows the log poller would, with no RPC.
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, toHex, type Abi, type AbiEvent } from "viem";
import { bondingCurveAbi, discipleRouterAbi } from "../lib/abi";
import { mcapOrderer, receiptTradeLogs, tradeFromLog, type RawReceiptLog } from "../lib/events";
import { disciplePoolId, SWAP_EVENT } from "../lib/v4Swap";
import type { ProtocolEvent } from "../lib/protocol";
import { usdgDecimals } from "../lib/usdg";

const TOKEN = "0x1000000000000000000000000000000000000001";
const QUOTE = "0x2000000000000000000000000000000000000002";
const CURVE = "0x3000000000000000000000000000000000000003";
const ROUTER = "0x4000000000000000000000000000000000000004";
const PM = "0x5000000000000000000000000000000000000005";
const HOOK = "0x6000000000000000000000000000000000000006";
const ME = "0x9292000000000000000000000000000000000000";
const TX = "0x" + "ab".repeat(32);
const WAD = BigInt(10) ** BigInt(18);
const USDG = BigInt(10) ** BigInt(usdgDecimals());   // the chain's USDG decimals (lib/usdg)

function log(abi: Abi | readonly AbiEvent[], eventName: string, args: Record<string, unknown>, address: string, logIndex: number, block = 1234): RawReceiptLog {
  const ev = (abi as readonly AbiEvent[]).find((x) => x.type === "event" && x.name === eventName)!;
  const topics = encodeEventTopics({ abi: [ev], eventName, args: Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]])) } as never) as string[];
  const rest = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(rest, rest.map((i) => args[i.name!]) as never);
  return { address, topics, data, blockNumber: toHex(block), logIndex: toHex(logIndex), transactionHash: TX };
}
const curveTrade = (isBuy: boolean, mcapAfterUsd: bigint, i: number) => {
  const ev = (bondingCurveAbi as readonly AbiEvent[]).find((x) => x.type === "event" && x.name === "Trade")!;
  const args: Record<string, unknown> = { token: TOKEN, trader: ME };
  for (const inp of ev.inputs) if (!(inp.name! in args)) args[inp.name!] = inp.type === "bool" ? isBuy : inp.name === "mcapAfterUsd" ? mcapAfterUsd : inp.name === "impactBps" ? BigInt(120) : BigInt(10) ** BigInt(18);
  return log(bondingCurveAbi, "Trade", args, CURVE, i);
};
const usdgTrade = (isBuy: boolean, i: number) => log(discipleRouterAbi, "UsdgTrade",
  { trader: ME, token: TOKEN, isBuy, amountIn: isBuy ? BigInt(25) * USDG : BigInt(1000) * WAD, amountOut: isBuy ? BigInt(1000) * WAD : BigInt(24) * USDG, viaCurve: true }, ROUTER, i);
const opts = { token: TOKEN, curve: CURVE, quote: QUOTE, trader: ME, hook: HOOK, poolManager: PM, routers: [ROUTER] };

describe("receiptTradeLogs", () => {
  it("a curve sell: the Trade row, its post-trade mcap and the router's USDG, from the receipt alone", () => {
    const got = receiptTradeLogs([curveTrade(false, BigInt(42_000) * WAD, 3), usdgTrade(false, 4)], opts);
    expect(got.curve).toHaveLength(1);
    expect(got.hook).toHaveLength(0);
    const e = tradeFromLog(got.curve[0], WAD, "curve", undefined, (got.curve[0] as never as { usdg: never }).usdg) as Extract<ProtocolEvent, { type: "Trade" }>;
    expect(e.side).toBe("sell");
    expect(e.mcapUsd).toBeCloseTo(42_000, 6);
    expect(e.block).toBe(BigInt(1234));
    expect(e.logIndex).toBe(3);
    expect(e.txHash).toBe(TX);
    expect(e.usd).toBeCloseTo(24, 6);   // the USDG the player got, not the quote value
  });

  it("buys and sells decode the same way (no side gets a slower path)", () => {
    const b = receiptTradeLogs([curveTrade(true, BigInt(50_000) * WAD, 1), usdgTrade(true, 2)], opts);
    const s = receiptTradeLogs([curveTrade(false, BigInt(49_000) * WAD, 1), usdgTrade(false, 2)], opts);
    expect(b.curve).toHaveLength(1); expect(s.curve).toHaveLength(1);
  });

  it("post-grad: the coin pool's PoolManager Swap becomes the hook Trade, credited to the trader; other pools are skipped", () => {
    const id = disciplePoolId(TOKEN, QUOTE, HOOK);
    const Q96 = BigInt(2) ** BigInt(96);
    const swap = (pid: string, i: number) => log([SWAP_EVENT], "Swap", { id: pid, sender: ROUTER, amount0: -(BigInt(10) ** BigInt(20)), amount1: BigInt(99) * BigInt(10) ** BigInt(18), sqrtPriceX96: Q96 - Q96 / BigInt(100), liquidity: BigInt(10) ** BigInt(24), tick: 0, fee: 0 }, PM, i);
    const got = receiptTradeLogs([swap("0x" + "11".repeat(32), 1), swap(id, 2), usdgTrade(false, 3)], opts);
    expect(got.hook).toHaveLength(1);
    expect(String(got.hook[0].args.trader).toLowerCase()).toBe(ME);
    expect(got.hook[0].args.isBuy).toBe(false);
  });

  it("a log with no block / index can't be ordered: nothing (the poller delivers it as before)", () => {
    const l = curveTrade(false, WAD, 1); delete l.logIndex;
    expect(receiptTradeLogs([l], opts)).toEqual({ curve: [], hook: [] });
  });

  it("the poller's later copy of the same log is dropped by the orderer (no second row)", () => {
    const out: ProtocolEvent[] = [], order = mcapOrderer((e) => out.push(e));
    const got = receiptTradeLogs([curveTrade(false, BigInt(42_000) * WAD, 3)], opts);
    order.trade(tradeFromLog(got.curve[0], WAD, "curve"));
    order.trade(tradeFromLog({ ...got.curve[0] }, WAD, "curve"));   // same tx:logIndex from getLogs ~0.7 s later
    expect(out.filter((e) => e.type === "Trade")).toHaveLength(1);
  });
});
