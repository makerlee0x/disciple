/**
 * DISCIPLE FLOW event listener → normalized ProtocolEvents.
 *  Launchpad: Launched, LaunchTierContext, CreatorTransferred
 *  BondingCurve (per coin): Buy, Sell (→ "Trade" with impactPct), GraduatedToV4 (→ "Graduate")
 * Feeds: flight engine (window "disciple:event" → DiscipleSource in engine.js) and launchpad cards.
 * Only DISCIPLE coins use this; the AI/WETH v3 demo keeps its own Swap path.
 */
import type { Log, PublicClient } from "viem";
import { bondingCurveAbi, launchpadAbi } from "./abi";
import { deployment } from "./chains";
import { curveParams, publicClient } from "./protocol-viem";
import { impactPctBetween, spotPriceWad } from "./curveMath";
import type { Address, ProtocolEvent } from "./protocol";

type Cb = (e: ProtocolEvent) => void;
const wad = (v: bigint) => Number(v) / 1e18;

/** Launchpad-wide events (new rockets → launchpad cards). */
export function watchLaunchpad(cb: Cb, pc: PublicClient = publicClient()): () => void {
  const lp = deployment().launchpad;
  return pc.watchContractEvent({
    address: lp, abi: launchpadAbi, fromBlock: deployment().fromBlock,
    onLogs: (logs) => {
      for (const l of logs as (Log & { eventName: string; args: Record<string, unknown> })[]) {
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

/**
 * Per-coin trade stream. Buy/Sell events carry no impact or price (contract API gap), so we
 * reconstruct tokensSold per block (read at the log's block) and derive spot-to-spot impact.
 */
export async function watchCurve(token: Address, curve: Address, cb: Cb, pc: PublicClient = publicClient()): Promise<() => void> {
  const p = await curveParams(pc, curve);
  const qp = (await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" })) as bigint;
  const mcapAt = (sold: bigint) => wad((((spotPriceWad(p, sold) * p.totalSupply) / BigInt(1e18)) * qp) / BigInt(1e18));
  return pc.watchContractEvent({
    address: curve, abi: bondingCurveAbi,
    onLogs: async (logs) => {
      for (const l of logs as (Log & { eventName: string; args: Record<string, bigint | string> })[]) {
        const a = l.args;
        if (l.eventName === "GraduatedToV4") { cb({ type: "Graduate", token, poolId: a.poolId as `0x${string}` }); continue; }
        if (l.eventName !== "Buy" && l.eventName !== "Sell") continue;
        const buy = l.eventName === "Buy";
        // state AFTER this block; approximate "before" by undoing this trade's token delta
        const after = (await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "tokensSold", blockNumber: l.blockNumber ?? undefined })) as bigint;
        const dTok = (buy ? a.tokensOut : a.tokensIn) as bigint;
        const before = buy ? after - dTok : after + dTok;
        const quoteAmt = (buy ? a.quoteIn : a.quoteOut) as bigint;
        cb({
          type: "Trade", token, trader: (buy ? a.buyer : a.seller) as Address, side: buy ? "buy" : "sell",
          amountIn: (buy ? a.quoteIn : a.tokensIn) as bigint, amountOut: (buy ? a.tokensOut : a.quoteOut) as bigint,
          usd: wad((quoteAmt * qp) / BigInt(1e18)),
          impactPct: impactPctBetween(p, before, after),
          mcapUsd: mcapAt(after), txHash: l.transactionHash ?? "", block: l.blockNumber ?? BigInt(0),
        });
      }
    },
  });
}

/** Bridge to the flight engine: dispatches window "disciple:event" CustomEvents. */
export function toEngine(e: ProtocolEvent) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("disciple:event", {
    detail: JSON.parse(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
  }));
}
