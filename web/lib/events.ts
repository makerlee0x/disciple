/**
 * DISCIPLE FLOW event listener → normalized ProtocolEvents.
 *  Launchpad: Launched, LaunchTierContext, CreatorTransferred
 *  BondingCurve (per coin): Trade (pre-grad), GraduatedToV4 (→ "Graduate")
 *  DiscipleHook (all coins, filtered by indexed token): Trade (post-grad v4 swaps, any router)
 * Trade.impactBps / mcapAfterUsd come straight from chain and drive bomb tiers + the chart.
 * Feeds: flight engine (window "disciple:event" → DiscipleSource in engine.js) and launchpad cards.
 */
import type { Log, PublicClient } from "viem";
import { bondingCurveAbi, discipleHookAbi, launchpadAbi } from "./abi";
import { deployment } from "./chains";
import { publicClient, quoteRawToUsd, readMarket } from "./protocol-viem";
import type { Address, ProtocolEvent } from "./protocol";

type Cb = (e: ProtocolEvent) => void;
type L = Log & { eventName: string; args: Record<string, unknown> };
const wad = (v: bigint) => Number(v) / 1e18;

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
export function tradeFromLog(l: L, quotePriceUsd: bigint, venue: "curve" | "hook", mcapPerPriceWad?: number): ProtocolEvent {
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
    // Post-grad Trade.mcapAfterUsd is frozen (FLOW bug): rescale the live pool price via the MarketLens ratio.
    mcapUsd: venue === "hook" && mcapPerPriceWad ? Number(a.priceAfterX18 as bigint) * mcapPerPriceWad : wad(a.mcapAfterUsd as bigint),
    txHash: l.transactionHash ?? "", block: l.blockNumber ?? BigInt(0),
  };
}

/** USD mcap per unit of priceWad from MarketLens (live v4 price × live quote/USD). undefined if no lens. */
export async function lensScale(token: Address, pc: PublicClient = publicClient()): Promise<number | undefined> {
  const m = await readMarket(pc, token);
  return m && m.priceWad > BigInt(0) ? m.mcapUsd / Number(m.priceWad) : undefined;
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
      onLogs: async (logs) => { const k = await lensScale(token, pc); for (const l of logs as L[]) cb(tradeFromLog(l, qp, "hook", k)); },
    }));

  return () => stops.forEach((s) => s());
}

export interface LaunchedCoin {
  token: Address; curve: Address; creator: Address; quote: Address; name: string; ticker: string;
  imageURI: string; mcapUsd: number; graduated: boolean; progressBps: number; block: bigint;
}

/** All launches since the deployment start block, newest first, with live mcap/progress (launchpad home list). */
export async function listLaunches(pc: PublicClient = publicClient()): Promise<LaunchedCoin[]> {
  const lp = deployment().launchpad;
  const logs = await pc.getContractEvents({ address: lp, abi: launchpadAbi, eventName: "Launched", fromBlock: deployment().fromBlock, toBlock: "latest" });
  const coins = await Promise.all((logs as unknown as L[]).map(async (l) => {
    const a = l.args as Record<string, string>;
    const curve = a.curve as Address;
    const c = { address: curve, abi: bondingCurveAbi } as const;
    const [mcap, grad, prog, meta] = await Promise.all([
      readMarket(pc, a.token as Address).then((m) => (m ? BigInt(Math.round(m.mcapUsd * 1e6)) * BigInt(1e12) : pc.readContract({ ...c, functionName: "mcapNow" }))).catch(() => BigInt(0)),
      pc.readContract({ ...c, functionName: "graduated" }).catch(() => false),
      pc.readContract({ ...c, functionName: "progressBps" }).catch(() => BigInt(0)),
      pc.readContract({ address: lp, abi: launchpadAbi, functionName: "metaOf", args: [a.token as Address] }).catch(() => null),
    ]);
    return {
      token: a.token as Address, curve, creator: a.creator as Address, quote: a.quote as Address, name: a.name, ticker: a.ticker,
      imageURI: meta ? String((meta as readonly unknown[])[2] ?? "") : "",
      mcapUsd: wad(mcap as bigint), graduated: grad as boolean, progressBps: Number(prog), block: l.blockNumber ?? BigInt(0),
    };
  }));
  return coins.sort((x, y) => (x.block > y.block ? -1 : 1));
}

/** Backfill a coin's Trades (curve + hook) and graduation from `fromBlock` (default: deployment start block). */
export async function tradeHistory(token: Address, curve: Address, pc: PublicClient = publicClient(), fromBlock = deployment().fromBlock): Promise<ProtocolEvent[]> {
  const qp = await pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" });
  const [curveLogs, hookLogs] = await Promise.all([
    pc.getContractEvents({ address: curve, abi: bondingCurveAbi, fromBlock, toBlock: "latest" }),
    pc.getContractEvents({ address: deployment().hook, abi: discipleHookAbi, eventName: "Trade", args: { token }, fromBlock, toBlock: "latest" }),
  ]);
  const key = (l: L) => (l.blockNumber ?? BigInt(0)) * BigInt(100000) + BigInt(l.logIndex ?? 0);
  const out: { k: bigint; e: ProtocolEvent }[] = [];
  for (const l of curveLogs as unknown as L[]) {
    if (l.eventName === "Trade") out.push({ k: key(l), e: tradeFromLog(l, qp, "curve") });
    else if (l.eventName === "GraduatedToV4") out.push({ k: key(l), e: { type: "Graduate", token, poolId: l.args.poolId as `0x${string}` } });
  }
  const scale = hookLogs.length ? await lensScale(token, pc) : undefined;
  for (const l of hookLogs as unknown as L[]) out.push({ k: key(l), e: tradeFromLog(l, qp, "hook", scale) });
  out.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return out.map((x) => x.e);
}

/** Bridge to the flight engine: dispatches window "disciple:event" CustomEvents. */
export function toEngine(e: ProtocolEvent) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("disciple:event", {
    detail: JSON.parse(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
  }));
}
