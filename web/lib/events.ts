/**
 * DISCIPLE FLOW event listener → normalized ProtocolEvents.
 *  Launchpad: Launched, LaunchTierContext, CreatorTransferred
 *  BondingCurve (per coin): Trade (pre-grad), GraduatedToV4 (→ "Graduate")
 *  DiscipleHook (all coins, filtered by indexed token): Trade (post-grad v4 swaps, any router)
 * Trade.impactBps / mcapAfterUsd come straight from chain and drive bomb tiers + the chart.
 * Legacy Buy/Sell (pre-PR #4 testnet deploy) are still decoded with client-side impact as a fallback.
 * Feeds: flight engine (window "disciple:event" → DiscipleSource in engine.js) and launchpad cards.
 */
import { parseAbi, type Log, type PublicClient } from "viem";
import { bondingCurveAbi, discipleHookAbi, launchpadAbi } from "./abi";
import { deployment } from "./chains";
import { curveParams, publicClient, quoteRawToUsd } from "./protocol-viem";
import { impactPctBetween, spotPriceWad } from "./curveMath";
import type { Address, ProtocolEvent } from "./protocol";

type Cb = (e: ProtocolEvent) => void;
type L = Log & { eventName: string; args: Record<string, unknown> };
const wad = (v: bigint) => Number(v) / 1e18;

const legacyCurveAbi = parseAbi([
  "event Buy(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 snipeFee)",
  "event Sell(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee)",
]);

/** Launchpad-wide events (new rockets → launchpad cards). */
export function watchLaunchpad(cb: Cb, pc: PublicClient = publicClient()): () => void {
  const lp = deployment().launchpad;
  return pc.watchContractEvent({
    address: lp, abi: launchpadAbi, fromBlock: deployment().fromBlock,
    onLogs: (logs) => {
      for (const l of logs as L[]) {
        const a = l.args;
        if (l.eventName === "Launched")
          cb({ type: "Launch", token: a.token as Address, curve: a.curve as Address, creator: a.creator as Address, quote: a.quote as Address,
               name: a.name as string, ticker: a.ticker as string, creatorTaxBps: Number(a.creatorTaxBps), block: l.blockNumber ?? BigInt(0) });
        else if (l.eventName === "LaunchTierContext")
          cb({ type: "LaunchTierContext", token: a.token as Address, startMcapUsd: wad(a.startMcapUsd as bigint), graduationMcapUsd: wad(a.graduationMcapUsd as bigint),
               totalSupply: a.totalSupply as bigint, decimals: Number(a.decimals_) });
        else if (l.eventName === "CreatorTransferred")
          cb({ type: "CreatorTransferred", token: a.token as Address, previousCreator: a.previousCreator as Address, newCreator: a.newCreator as Address });
      }
    },
  });
}

/** Normalize an on-chain Trade (curve or hook) into the engine's TradeEvent. */
export function tradeFromLog(l: L, quotePriceUsd: bigint, venue: "curve" | "hook"): ProtocolEvent {
  const a = l.args as Record<string, bigint | string | boolean>;
  const isBuy = a.isBuy as boolean;
  const quoteAmt = a.quoteAmt as bigint, tokenAmt = a.tokenAmt as bigint;
  const bps = Number(a.impactBps as bigint) * (isBuy ? 1 : -1);
  return {
    type: "Trade", token: a.token as Address, trader: a.trader as Address, side: isBuy ? "buy" : "sell", venue,
    amountIn: isBuy ? quoteAmt : tokenAmt, amountOut: isBuy ? tokenAmt : quoteAmt,
    quoteAmt, tokenAmt, fee: a.fee as bigint, snipeFee: a.snipeFee as bigint,
    usd: quoteRawToUsd(quoteAmt, quotePriceUsd),
    impactBps: bps, impactPct: bps / 100,
    mcapUsd: wad(a.mcapAfterUsd as bigint),
    txHash: l.transactionHash ?? "", block: l.blockNumber ?? BigInt(0),
  };
}

/**
 * Per-coin trade stream: curve Trade + GraduatedToV4, and the hook's Trade for this token
 * (post-grad swaps from DiscipleRouter or any third-party router).
 */
export async function watchCurve(token: Address, curve: Address, cb: Cb, pc: PublicClient = publicClient()): Promise<() => void> {
  const qp = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" });
  const stops: (() => void)[] = [];

  stops.push(pc.watchContractEvent({
    address: curve, abi: bondingCurveAbi,
    onLogs: (logs) => {
      for (const l of logs as L[]) {
        if (l.eventName === "GraduatedToV4") cb({ type: "Graduate", token, poolId: l.args.poolId as `0x${string}` });
        else if (l.eventName === "Trade") cb(tradeFromLog(l, qp, "curve"));
      }
    },
  }));

  const hook = deployment().hook;
  if (hook !== "0x0000000000000000000000000000000000000000")
    stops.push(pc.watchContractEvent({
      address: hook, abi: discipleHookAbi, eventName: "Trade", args: { token },
      onLogs: (logs) => { for (const l of logs as L[]) cb(tradeFromLog(l, qp, "hook")); },
    }));

  // Legacy (pre-PR #4) curves: Buy/Sell without impact → reconstruct spot-to-spot impact.
  const p = await curveParams(pc, curve);
  const mcapAt = (sold: bigint) => quoteRawToUsd((spotPriceWad(p, sold) * p.totalSupply) / BigInt(1e18), qp);
  stops.push(pc.watchContractEvent({
    address: curve, abi: legacyCurveAbi,
    onLogs: async (logs) => {
      for (const l of logs as L[]) {
        const a = l.args as Record<string, bigint | string>;
        const buy = l.eventName === "Buy";
        const after = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "tokensSold", blockNumber: l.blockNumber ?? undefined });
        const dTok = (buy ? a.tokensOut : a.tokensIn) as bigint;
        const before = buy ? after - dTok : after + dTok;
        const quoteAmt = (buy ? a.quoteIn : a.quoteOut) as bigint;
        const pct = impactPctBetween(p, before, after);
        cb({
          type: "Trade", token, trader: (buy ? a.buyer : a.seller) as Address, side: buy ? "buy" : "sell", venue: "curve",
          amountIn: (buy ? a.quoteIn : a.tokensIn) as bigint, amountOut: (buy ? a.tokensOut : a.quoteOut) as bigint,
          usd: quoteRawToUsd(quoteAmt, qp), impactBps: Math.round(pct * 100), impactPct: pct,
          mcapUsd: mcapAt(after), txHash: l.transactionHash ?? "", block: l.blockNumber ?? BigInt(0),
        });
      }
    },
  }));

  return () => stops.forEach((s) => s());
}

/** Bridge to the flight engine: dispatches window "disciple:event" CustomEvents. */
export function toEngine(e: ProtocolEvent) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("disciple:event", {
    detail: JSON.parse(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
  }));
}
