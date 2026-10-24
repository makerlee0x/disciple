/**
 * DISCIPLE FLOW event listener → normalized ProtocolEvents.
 *  Launchpad: Launched, LaunchTierContext, CreatorTransferred
 *  BondingCurve (per coin): Trade (pre-grad), GraduatedToV4 (→ "Graduate")
 *  DiscipleHook (all coins, filtered by indexed token): Trade (post-grad v4 swaps, any router)
 * Trade.impactBps / mcapAfterUsd come straight from chain and drive bomb tiers + the chart.
 * Feeds: flight engine (window "disciple:event" → DiscipleSource in engine.js) and launchpad cards.
 */
import type { Log, PublicClient } from "viem";
import { bondingCurveAbi, discipleHookAbi, discipleRouterAbi, launchpadAbi } from "./abi";
import { usdgAmounts, usdgIndex, usdgKey, type UsdgTradeArgs } from "./trades";
import { usdgDecimals } from "./usdg";
import { deployment } from "./chains";
import { publicClient, quoteRawToUsd, readMarket } from "./protocol-viem";
import { coinBasis, hookMcapUsd as hookSqrtMcapUsd } from "./mcap";
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

/** 7B × 1e18 (Constants.TOTAL_SUPPLY). */
const SUPPLY_TOKENS = 7_000_000_000;
/** LEGACY (18-dec quotes only): USD mcap from a Trade's priceAfterX18 (quote raw × 1e18 / token raw, floored on-chain — a
 *  single-digit integer at 6-dec USDG) and quotePriceUsd (USD WAD per 1e18 quote raw). Hook Trades use sqrtPriceAfter. */
export const hookMcapUsd = (priceAfterX18: bigint | undefined, quotePriceUsd: bigint) =>
  priceAfterX18 ? (Number(priceAfterX18) / 1e18) * (Number(quotePriceUsd) / 1e18) * SUPPLY_TOKENS : 0;

/** Hook-Trade context: the coin's quote token (v4 currency order) and its own total supply (whole tokens, lib/mcap coinBasis). */
export type HookCtx = { quote?: string; supplyTokens?: number };

/** v4 hook Trade → $ mcap: lib/mcap (sqrtPriceAfter × the LAUNCH quote price × the coin's own supply) — the same basis as
 *  the header/cards, the hook's altitude events and /api/trades. Legacy priceAfterX18 fallback. */
export function hookTradeMcapUsd(a: { token: string; sqrtPriceAfter?: bigint; priceAfterX18?: bigint }, quotePriceUsd: bigint, ctx?: HookCtx): number {
  if (a.sqrtPriceAfter !== undefined && a.sqrtPriceAfter > BigInt(0) && ctx?.quote)
    return hookSqrtMcapUsd(a.sqrtPriceAfter, a.token, ctx.quote, quotePriceUsd, ctx.supplyTokens ?? SUPPLY_TOKENS);
  return hookMcapUsd(a.priceAfterX18, quotePriceUsd);
}

/** Normalize an on-chain Trade (curve or hook) into the engine's TradeEvent. */
export function tradeFromLog(l: L, quotePriceUsd: bigint, venue: "curve" | "hook", hook?: HookCtx, usdg?: UsdgTradeArgs): ProtocolEvent {
  const a = l.args as Record<string, bigint | string | boolean>;
  const isBuy = a.isBuy as boolean;
  const quoteAmt = a.quoteAmt as bigint, tokenAmt = a.tokenAmt as bigint;
  const bps = Number(a.impactBps as bigint) * (isBuy ? 1 : -1);
  return {
    type: "Trade", token: a.token as Address, trader: a.trader as Address, side: isBuy ? "buy" : "sell", venue,
    amountIn: isBuy ? quoteAmt : tokenAmt, amountOut: isBuy ? tokenAmt : quoteAmt,
    quoteAmt, tokenAmt, fee: a.fee as bigint, snipeFee: a.snipeFee as bigint,
    usd: quoteRawToUsd(quoteAmt, quotePriceUsd),
    ...usdgAmounts(usdg && usdg.trader.toLowerCase() === String(a.trader).toLowerCase() ? usdg : undefined, usdgDecimals()),
    impactBps: bps, impactPct: bps / 100,
    // v4 hook Trade has NO mcapAfterUsd (gas G-1: last field is sqrtPriceAfter). Post-grad mcap = sqrtPriceAfter × the
    // coin's launch quote price (lib/mcap) — never the floored priceAfterX18 (6-dec USDG, FLOW #115). Curve Trades
    // still carry mcapAfterUsd.
    mcapUsd: venue === "hook"
      ? hookTradeMcapUsd({ token: String(a.token), sqrtPriceAfter: a.sqrtPriceAfter as bigint | undefined, priceAfterX18: a.priceAfterX18 as bigint }, quotePriceUsd, hook)
      : wad(a.mcapAfterUsd as bigint),
    txHash: l.transactionHash ?? "", block: l.blockNumber ?? BigInt(0), logIndex: l.logIndex ?? 0,
  };
}

/** Chain-order key of a Trade (block, logIndex). */
export const tradeKey = (e: { block: bigint | string | number; logIndex?: number }) => BigInt(e.block) * BigInt(100000) + BigInt(e.logIndex ?? 0);

/**
 * Keeps the engine's mcap in CHAIN order. Hook Trade batches are normalized asynchronously (lens scale RPC), so
 * a slower, OLDER batch (e.g. the buys before a DUMP) could land after the newer sell and put the HUD/rocket
 * back up while the chart had already drawn the dip. An out-of-order Trade still reaches the engine (feed,
 * thrust, bombs) but carries the newest known mcap; State reconciles (reads at block B) only move it forward.
 */
export function mcapOrderer(emit: Cb) {
  let lastK = BigInt(-1), lastMcap = 0;
  // Every Trade reaches the engine at most once (tx:logIndex). The engine has no dedupe of its own: a repeat drew a second
  // "▲ BOOST" row + chart tick (viem's getLogs fallback re-delivered a range whenever a lagging node's lower blockNumber
  // rewound its cursor).
  let seen = new Set<string>();
  return {
    trade(e: ProtocolEvent) {
      if (e.type === "Trade") {
        if (e.txHash) {
          const id = `${e.txHash.toLowerCase()}:${e.logIndex ?? 0}`;
          if (seen.has(id)) return;
          seen.add(id); if (seen.size > 2000) seen = new Set(Array.from(seen).slice(-1000));
        }
        const k = tradeKey(e);
        if (k >= lastK) { lastK = k; lastMcap = e.mcapUsd; } else if (lastMcap > 0) e = { ...e, mcapUsd: lastMcap };
      }
      emit(e);
    },
    /** Live mcap read at block `atBlock` (or later): applied unless a newer Trade was already applied. */
    state(mcapUsd: number, atBlock: bigint) {
      const k = atBlock * BigInt(100000) + BigInt(99999);
      if (!(mcapUsd > 0) || k < lastK) return false;
      lastK = k;
      if (Math.abs(mcapUsd - lastMcap) < 1e-9 * Math.max(1, mcapUsd)) return false;
      lastMcap = mcapUsd;
      emit({ type: "State", mcapUsd } as never);
      return true;
    },
    get mcap() { return lastMcap; },
  };
}
export type McapOrderer = ReturnType<typeof mcapOrderer>;

/** RH testnet RPC: ~4 blocks/s, no eth_newFilter, and its load-balanced nodes lag each other by a few blocks. */
const LIVE_POLL_MS = 1500;
/** Blocks re-scanned on every poll (≈30 s at 4 blocks/s): logs a lagging node didn't have yet are picked up next time. */
const LIVE_RESCAN_BLOCKS = BigInt(120);

/**
 * Lag-tolerant log poller. viem's watchContractEvent falls back to getLogs(previous+1 … head) when the RPC has no
 * filters (RH testnet), then moves `previous` to `head` even when the getLogs landed on a node that was still a few
 * blocks behind (it answers [] for blocks it doesn't have yet, no error) ⇒ that trade never reached the engine (TRADES
 * empty after a buy, mcap/rocket only caught up at the next 8 s reconcile). Here every poll re-scans the last
 * LIVE_RESCAN_BLOCKS and dedupes by tx:logIndex, and starts at `fromBlock` (the block the page read its state at), so no
 * trade between the state read and the first poll is skipped either. `kick()` polls now (own trade just landed).
 */
export function pollLogs(o: {
  pc: PublicClient; fromBlock: bigint; fetch: (from: bigint, to: bigint) => Promise<L[]>; onLogs: (logs: L[]) => void;
  everyMs?: number; rescan?: bigint;
}): { stop: () => void; kick: () => void } {
  const rescan = o.rescan ?? LIVE_RESCAN_BLOCKS;
  let head = o.fromBlock - BigInt(1), alive = true, busy = false, again = false;
  const seen = new Map<string, bigint>();
  const tick = async () => {
    if (!alive) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const h = await o.pc.getBlockNumber();
      if (h > head) head = h;
      const lo = head - rescan, from = lo > o.fromBlock ? lo : o.fromBlock;
      if (from <= head) {
        const logs = await o.fetch(from, head);
        const fresh = logs.filter((l) => {
          const k = `${l.transactionHash}:${l.logIndex}`;
          if (seen.has(k)) return false;
          seen.set(k, l.blockNumber ?? head); return true;
        }).sort((a, b) => Number(tradeKey({ block: a.blockNumber ?? BigInt(0), logIndex: a.logIndex ?? 0 }) - tradeKey({ block: b.blockNumber ?? BigInt(0), logIndex: b.logIndex ?? 0 })));
        for (const [k, b] of seen) if (b < from) seen.delete(k);
        if (alive && fresh.length) o.onLogs(fresh);
      }
    } catch { /* RPC hiccup: the rescan window covers it next poll */ }
    finally { busy = false; if (again && alive) { again = false; void tick(); } }
  };
  const iv = setInterval(tick, o.everyMs ?? LIVE_POLL_MS);
  void tick();
  return { stop: () => { alive = false; clearInterval(iv); }, kick: () => { void tick(); } };
}

/**
 * Per-coin trade stream: curve Trade + GraduatedToV4, and the hook's Trade for this token
 * (post-grad swaps from DiscipleRouter or any third-party router). Batches are processed strictly in arrival
 * order (one promise chain) and the lens scale is cached, so a slow RPC can't reorder a DUMP behind older buys.
 * `fromBlock`: first block to stream (DiscipleFeed passes the block after its state read). Own trades (TradeBridge
 * "disciple:livetrade" / "disciple:fillreceipt") trigger an immediate poll.
 */
export async function watchCurve(token: Address, curve: Address, cb: Cb, pc: PublicClient = publicClient(), order: McapOrderer = mcapOrderer(cb), fromBlock?: bigint): Promise<() => void> {
  const [qp, quote] = await Promise.all([
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" }),
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quote" }).catch(() => undefined),
  ]);
  const start = fromBlock ?? (await pc.getBlockNumber()) + BigInt(1);
  const stops: (() => void)[] = [], kicks: (() => void)[] = [];
  let chain: Promise<void> = Promise.resolve();
  const inOrder = (f: () => Promise<void> | void) => { chain = chain.then(f).catch(() => undefined); };
  // immutable per coin (lib/mcap): quote token + the coin's own supply
  const hookCtx: Promise<HookCtx> = coinBasis(pc, token, curve).then((b) => ({ quote: b.quote, supplyTokens: b.supplyTokens }), () => ({ quote }));

  const c = pollLogs({
    pc, fromBlock: start,
    fetch: (from, to) => pc.getContractEvents({ address: curve, abi: bondingCurveAbi, fromBlock: from, toBlock: to }) as unknown as Promise<L[]>,
    onLogs: (logs) => inOrder(() => {
      for (const l of logs) {
        if (l.eventName === "GraduatedToV4") order.trade({ type: "Graduate", token, poolId: l.args.poolId as `0x${string}` });
        else if (l.eventName === "Trade") order.trade(tradeFromLog(l, qp, "curve"));
      }
    }),
  });
  stops.push(c.stop); kicks.push(c.kick);

  const hook = deployment().hook;
  if (hook !== "0x0000000000000000000000000000000000000000") {
    const h = pollLogs({
      pc, fromBlock: start,
      fetch: (from, to) => pc.getContractEvents({ address: hook, abi: discipleHookAbi, eventName: "Trade", args: { token }, fromBlock: from, toBlock: to }) as unknown as Promise<L[]>,
      onLogs: (logs) => inOrder(async () => { const k = await hookCtx; for (const l of logs) order.trade(tradeFromLog(l, qp, "hook", k)); }),
    });
    stops.push(h.stop); kicks.push(h.kick);
  }

  if (typeof window !== "undefined") {
    // own trade: poll right away and again shortly after (the receipt node can be ahead of the getLogs node)
    const own = () => { kicks.forEach((k) => k()); setTimeout(() => kicks.forEach((k) => k()), 700); };
    window.addEventListener("disciple:livetrade", own); window.addEventListener("disciple:fillreceipt", own);
    stops.push(() => { window.removeEventListener("disciple:livetrade", own); window.removeEventListener("disciple:fillreceipt", own); });
  }
  return () => stops.forEach((s) => s());
}

/**
 * Self-heal for the engine's mcap: re-read the live market (lib/mcap.ts readCoinMcap via readMarket) every `everyMs`
 * and right after the player's own trade (window "disciple:livetrade"), through the same orderer. Covers a
 * dropped event filter or a missed log — the HUD/rocket converge to chain state within one interval.
 */
export function reconcileMcap(token: Address, order: McapOrderer, pc: PublicClient = publicClient(), everyMs = 8000, read: (b: bigint) => Promise<number | null> = async () => {
  const m = await readMarket(pc, token);   // THE mcap (lib/mcap.ts), pre- and post-grad
  if (m) return m.mcapUsd;
  const { readCurveState } = await import("./protocol-viem");
  return (await readCurveState(pc, token)).mcapUsd;
}): () => void {
  let alive = true, busy = false;
  const tick = async () => {
    if (!alive || busy) return; busy = true;
    try { const b = await pc.getBlockNumber(); const m = await read(b); if (alive && m) order.state(m, b); } catch { /* next tick */ } finally { busy = false; }
  };
  const iv = setInterval(tick, everyMs);
  const after = () => { setTimeout(tick, 1200); setTimeout(tick, 4000); };
  if (typeof window !== "undefined") window.addEventListener("disciple:livetrade", after);
  return () => { alive = false; clearInterval(iv); if (typeof window !== "undefined") window.removeEventListener("disciple:livetrade", after); };
}

export interface LaunchedCoin {
  token: Address; curve: Address; creator: Address; quote: Address; name: string; ticker: string;
  /** moderated-store URL of the coin image (/api/image/<id>), "" if the on-chain imageURI isn't moderated */
  imageURI: string; mcapUsd: number; graduated: boolean; progressBps: number; block: bigint;
}

/** All launches since the deployment start block, newest first, with live mcap/progress (launchpad home list).
 * `resolveImages` maps on-chain imageURIs to moderated-store srcs (default: lib/coinImages, browser fetch; the server
 * passes its own KV-backed resolver). */
export async function listLaunches(pc: PublicClient = publicClient(), resolveImages?: (uris: string[]) => Promise<Map<string, string>>): Promise<LaunchedCoin[]> {
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
  // W-3e: render only moderated images. imageURI is replaced by its moderated-store URL (/api/image/<id>), or "" when
  // that exact URI never passed /api/moderate-image (e.g. set by calling the contract directly) ⇒ PairArt fallback.
  const resolve = resolveImages ?? (await import("./coinImages")).moderatedSrcs;
  const srcs = await resolve(coins.map((c) => c.imageURI));
  for (const c of coins) c.imageURI = srcs.get(c.imageURI) ?? "";
  return coins.sort((x, y) => (x.block > y.block ? -1 : 1));
}

/** Backfill a coin's Trades (curve + hook) and graduation from `fromBlock` (default: deployment start block). */
export async function tradeHistory(token: Address, curve: Address, pc: PublicClient = publicClient(), fromBlock = deployment().fromBlock): Promise<ProtocolEvent[]> {
  const [qp, quote] = await Promise.all([
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" }),
    pc.readContract({ address: curve, abi: bondingCurveAbi, functionName: "quote" }).catch(() => undefined),
  ]);
  const router = deployment().router;
  const [curveLogs, hookLogs, routerLogs] = await Promise.all([
    pc.getContractEvents({ address: curve, abi: bondingCurveAbi, fromBlock, toBlock: "latest" }),
    pc.getContractEvents({ address: deployment().hook, abi: discipleHookAbi, eventName: "Trade", args: { token }, fromBlock, toBlock: "latest" }),
    router === "0x0000000000000000000000000000000000000000" ? Promise.resolve([])
      : pc.getContractEvents({ address: router, abi: discipleRouterAbi, eventName: "UsdgTrade", args: { token }, fromBlock, toBlock: "latest" }).catch(() => []),
  ]);
  // real USDG in/out of router trades, matched by (tx, token, side)
  const usdg = usdgIndex((routerLogs as unknown as L[]).map((l) => ({ tx: l.transactionHash ?? "", args: l.args as unknown as UsdgTradeArgs })));
  const take = (l: L) => usdg.get(usdgKey(l.transactionHash ?? "", String(l.args.token), Boolean(l.args.isBuy)))?.shift();
  const key = (l: L) => (l.blockNumber ?? BigInt(0)) * BigInt(100000) + BigInt(l.logIndex ?? 0);
  const out: { k: bigint; e: ProtocolEvent }[] = [];
  for (const l of curveLogs as unknown as L[]) {
    if (l.eventName === "Trade") out.push({ k: key(l), e: tradeFromLog(l, qp, "curve", undefined, take(l)) });
    else if (l.eventName === "GraduatedToV4") out.push({ k: key(l), e: { type: "Graduate", token, poolId: l.args.poolId as `0x${string}` } });
  }
  const scale: HookCtx | undefined = hookLogs.length
    ? await coinBasis(pc, token, curve).then((b) => ({ quote: b.quote, supplyTokens: b.supplyTokens }), () => ({ quote }))
    : undefined;
  for (const l of hookLogs as unknown as L[]) out.push({ k: key(l), e: tradeFromLog(l, qp, "hook", scale, take(l)) });
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
