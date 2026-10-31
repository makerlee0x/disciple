/**
 * DISCIPLE FLOW event listener → normalized ProtocolEvents.
 *  Launchpad: Launched, LaunchTierContext, CreatorTransferred
 *  BondingCurve (per coin): Trade (pre-grad), GraduatedToV4 (→ "Graduate")
 *  AscensionHook (all coins, filtered by indexed token): Trade (post-grad v4 swaps, any router)
 * Trade.impactBps / mcapAfterUsd come straight from chain and drive bomb tiers + the chart.
 * Feeds: flight engine (window "disciple:event" → DiscipleSource in engine.js) and launchpad cards.
 */
import { decodeEventLog, type Log, type PublicClient } from "viem";
import { bondingCurveAbi, ascensionHookAbi, discipleRouterAbi, launchpadAbi } from "./abi";
import { attachRefunds, playerUsd, usdgAmounts, usdgIndex, usdgKey, type UsdgRefundArgs, type UsdgTradeArgs } from "./trades";
import { usdgDecimals } from "./usdg";
import { publishTraderName } from "./nameLookup";
import { deployment } from "./chains";
import { curveOf, publicClient, quoteRawToUsd, readMarket } from "./protocol-viem";
import { coinBasis, hookMcapUsd as hookSqrtMcapUsd, readCoinMcap } from "./mcap";
import { blockOf, txBlock, type BlockLike } from "./fillBook";
import { NOT_GRADUATED, type Address, type GradState, type ProtocolEvent } from "./protocol";

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

/** 1M × 1e18 (Constants.TOTAL_SUPPLY, redeploy pack). */
const SUPPLY_TOKENS = 1_000_000;
/** LEGACY (18-dec quotes only): USD mcap from a Trade's priceAfterX18 (quote raw × 1e18 / token raw, floored on-chain — coarse
 *  at 6-dec USDG) and quotePriceUsd (USD WAD per 1e18 quote raw). Hook Trades use sqrtPriceAfter. */
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
  const real = usdgAmounts(usdg && usdg.trader.toLowerCase() === String(a.trader).toLowerCase() ? usdg : undefined, usdgDecimals());
  const side = isBuy ? "buy" as const : "sell" as const;
  // usd = what the player paid / got (router USDG) when known — the trade status line and the feed agree (live retest #3).
  // Without a UsdgTrade (direct curve/pool trade) it stays the quote value at the launch quote price.
  const quoteUsd = quoteRawToUsd(quoteAmt, quotePriceUsd);
  return {
    type: "Trade", token: a.token as Address, trader: a.trader as Address, side, venue,
    amountIn: isBuy ? quoteAmt : tokenAmt, amountOut: isBuy ? tokenAmt : quoteAmt,
    quoteAmt, tokenAmt, fee: a.fee as bigint, snipeFee: a.snipeFee as bigint,
    usd: playerUsd({ side, usd: quoteUsd, ...real }) || quoteUsd,
    ...real,
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
  // SITE job 7 (GAME contract): every update to the engine carries the coin's graduation state next to mcapUsd —
  // { graduated, poolId, graduatedAt } (lib/protocol GradState) on "State", "Trade" and "Graduate" alike. Set from the
  // server (DiscipleFeed → GET /api/coin/grad, falls back to the curve read) and flipped by a live GraduatedToV4.
  let grad: GradState = { ...NOT_GRADUATED };
  const out = (e: ProtocolEvent | StateEvent) => emit({ ...e, ...grad } as ProtocolEvent);
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
      } else if (e.type === "Graduate") {
        grad = { graduated: true, poolId: e.poolId ?? grad.poolId, graduatedAt: e.graduatedAt ?? grad.graduatedAt };
      }
      out(e);
    },
    /** Live mcap read at block `atBlock` (or later): applied unless a newer Trade was already applied. */
    state(mcapUsd: number, atBlock: bigint) {
      const k = atBlock * BigInt(100000) + BigInt(99999);
      if (!(mcapUsd > 0) || k < lastK) return false;
      lastK = k;
      if (Math.abs(mcapUsd - lastMcap) < 1e-9 * Math.max(1, mcapUsd)) return false;
      lastMcap = mcapUsd;
      out({ type: "State", mcapUsd });
      return true;
    },
    /** Graduation state from the server / curve read. Never un-graduates; a known poolId / graduatedAt is kept. */
    setGrad(g: Partial<GradState> | null | undefined) {
      if (!g) return;
      grad = {
        graduated: grad.graduated || g.graduated === true,
        poolId: grad.poolId ?? (typeof g.poolId === "string" && /^0x[0-9a-fA-F]{64}$/.test(g.poolId) ? g.poolId as `0x${string}` : null),
        graduatedAt: grad.graduatedAt ?? (typeof g.graduatedAt === "number" && g.graduatedAt > 0 ? g.graduatedAt : null),
      };
    },
    /** Re-send the current mcap (with the graduation fields) as a "State" — e.g. right after setGrad on page load. */
    resend() { if (lastMcap > 0) out({ type: "State", mcapUsd: lastMcap }); },
    get grad(): GradState { return { ...grad }; },
    get mcap() { return lastMcap; },
  };
}
/** The engine's mcap snapshot (not a chain event): window "disciple:event" detail { type: "State", mcapUsd, ...GradState }. */
export type StateEvent = { type: "State"; mcapUsd: number };
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
export type LogPoller = {
  stop: () => void; kick: () => void;
  /** one poll now; resolves when it (or the one already running) finished */
  tick: () => Promise<void>;
  /** highest block this poller has scanned up to */
  head: () => bigint;
  /** was a log of this tx delivered? */
  has: (txHash: string) => boolean;
};
export function pollLogs(o: {
  pc: PublicClient; fromBlock: bigint; fetch: (from: bigint, to: bigint) => Promise<L[]>; onLogs: (logs: L[]) => void;
  everyMs?: number; rescan?: bigint;
}): LogPoller {
  const rescan = o.rescan ?? LIVE_RESCAN_BLOCKS;
  let head = o.fromBlock - BigInt(1), alive = true, again = false, inflight: Promise<void> | null = null;
  const seen = new Map<string, bigint>();
  const tick = (): Promise<void> => {
    if (!alive) return Promise.resolve();
    if (inflight) { again = true; return inflight; }
    inflight = run().finally(() => { inflight = null; if (again && alive) { again = false; void tick(); } });
    return inflight;
  };
  const run = async () => {
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
  };
  const iv = setInterval(tick, o.everyMs ?? LIVE_POLL_MS);
  void tick();
  return {
    stop: () => { alive = false; clearInterval(iv); }, kick: () => { void tick(); }, tick, head: () => head,
    has: (tx) => { const p = String(tx).toLowerCase() + ":"; for (const k of seen.keys()) if (k.toLowerCase().startsWith(p)) return true; return false; },
  };
}

/**
 * Own fill landed (relay receipt at `minBlock`, tx `txHash`): poll until every poller scanned ≥ minBlock and one of them
 * delivered the tx, retrying briefly while the getLogs node is behind (SITE #137: the public RPC serves the block
 * ~0.7 s after the relay's receipt). No block known ⇒ the old "now + 700 ms" pair of polls. Never synthesizes a row.
 */
export async function pollUntilFill(pollers: Pick<LogPoller, "tick" | "head" | "has">[], minBlock: bigint | undefined, txHash: string | undefined,
  o: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (minBlock === undefined) { await Promise.all(pollers.map((p) => p.tick())); await sleep(700); await Promise.all(pollers.map((p) => p.tick())); return false; }
  const tries = o.tries ?? 16, delay = o.delayMs ?? 150;
  let pastHead = 0;
  for (let i = 0; i < tries; i++) {
    await Promise.all(pollers.map((p) => p.tick()));
    if (txHash && pollers.some((p) => p.has(txHash))) return true;
    if (pollers.every((p) => p.head() >= minBlock) && (!txHash || ++pastHead >= 3)) return !txHash;   // not a trade of this coin
    await sleep(delay);
  }
  return false;
}

/** Definitive per-tx answers (receipt found): UsdgTrade args or null (no router leg). Last 512 kept. */
const RECEIPT_USDG = new Map<string, UsdgTradeArgs | null>();
/**
 * The router's UsdgTrade for (tx, token, side, trader) from the tx's receipt. A missing receipt means the node is behind
 * ⇒ brief retry; still missing ⇒ undefined (the row keeps its quote value; nothing is guessed). Cached once definitive.
 */
export async function usdgFromReceipt(pc: Pick<PublicClient, "getTransactionReceipt">, router: Address, tx: `0x${string}`, token: string, isBuy: boolean, trader: string,
  o: { tries?: number; delayMs?: number } = {}): Promise<UsdgTradeArgs | undefined> {
  if (!router || /^0x0{40}$/i.test(router)) return undefined;
  const k = `${tx.toLowerCase()}|${token.toLowerCase()}|${isBuy ? 1 : 0}|${trader.toLowerCase()}`;
  if (RECEIPT_USDG.has(k)) return RECEIPT_USDG.get(k) ?? undefined;
  const tries = o.tries ?? 4, delay = o.delayMs ?? 150;
  for (let i = 0; i < tries; i++) {
    const rc = await pc.getTransactionReceipt({ hash: tx }).catch(() => null);
    if (rc) {
      let hit: UsdgTradeArgs | null = null;
      const refunds: { tx: string; args: UsdgRefundArgs }[] = [];
      for (const l of rc.logs) {
        if (l.address.toLowerCase() !== router.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: discipleRouterAbi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
          if (ev.eventName === "UsdgRefund") { refunds.push({ tx, args: ev.args as unknown as UsdgRefundArgs }); continue; }
          if (ev.eventName !== "UsdgTrade" || hit) continue;
          const a = ev.args as unknown as UsdgTradeArgs;
          if (String(a.token).toLowerCase() === token.toLowerCase() && Boolean(a.isBuy) === isBuy && String(a.trader).toLowerCase() === trader.toLowerCase()) hit = a;
        } catch { /* another router event */ }
      }
      // usdIn NET of the router's UsdgRefund (graduating buy / First BOOST over the cap)
      if (hit && refunds.length) hit = attachRefunds([{ tx, args: hit }], refunds)[0].args;
      RECEIPT_USDG.set(k, hit); while (RECEIPT_USDG.size > 512) RECEIPT_USDG.delete(RECEIPT_USDG.keys().next().value as string);
      return hit ?? undefined;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delay));
  }
  return undefined;
}

/**
 * THE mcap (lib/mcap readCoinMcap) read AT block `b` — reconcileMcap labels the value with `b`, so a `latest` read served
 * by a lagging node must not carry it (it rolled the HUD mcap / graduation progress back past our own fill). A node
 * without `b` yet ⇒ brief retry, then null (this tick is skipped). Legacy curves (no marketCapQuote, no lens) keep the
 * old curve-state read.
 */
export async function readMcapAt(pc: PublicClient, token: Address, b: bigint, o: { tries?: number; delayMs?: number } = {}): Promise<number | null> {
  const tries = o.tries ?? 3, delay = o.delayMs ?? 150;
  for (let i = 0; i < tries; i++) {
    try { return (await readCoinMcap(pc, token, await curveOf(pc, token), b)).mcapUsd; }
    catch (e) {
      if (/unknown coin|no marketCapQuote/i.test(String((e as Error)?.message))) {
        const { readCurveState } = await import("./protocol-viem");
        return (await readCurveState(pc, token)).mcapUsd;
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

/** Unix seconds of a block (GraduatedToV4 → graduatedAt); null when the read fails (the engine still gets graduated + poolId). */
export async function blockTs(pc: Pick<PublicClient, "getBlock">, block: bigint | null | undefined): Promise<number | null> {
  if (block === null || block === undefined) return null;
  try { return Number((await pc.getBlock({ blockNumber: block })).timestamp); } catch { return null; }
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
  const stops: (() => void)[] = [], kicks: (() => void)[] = [], pollers: LogPoller[] = [];
  let chain: Promise<void> = Promise.resolve();
  const inOrder = (f: () => Promise<void> | void) => { chain = chain.then(f).catch(() => undefined); };
  // immutable per coin (lib/mcap): quote token + the coin's own supply
  const hookCtx: Promise<HookCtx> = coinBasis(pc, token, curve).then((b) => ({ quote: b.quote, supplyTokens: b.supplyTokens }), () => ({ quote }));

  // Live retest #3: live Trades carry the router's real USDG too (was history-only), so the feed shows what the player
  // paid/got — the same $ as the trade status line — instead of the quote value at the launch price ($8.18 for a $10 buy).
  const router = deployment().router;
  const withUsdg = async (from: bigint, to: bigint, logs: Promise<L[]>): Promise<L[]> => {
    const [ls, rl] = await Promise.all([
      logs,
      router === "0x0000000000000000000000000000000000000000" ? Promise.resolve([] as L[])
        : (pc.getContractEvents({ address: router, abi: discipleRouterAbi, eventName: "UsdgTrade", args: { token }, fromBlock: from, toBlock: to }) as unknown as Promise<L[]>)
          .catch((e) => { console.warn("[disciple] live UsdgTrade read failed; feed falls back to quote value", e); return [] as L[]; }),
    ]);
    // UsdgRefund of the same txs (only when a router buy is in range) ⇒ usdIn is the NET paid
    const refunds = router === "0x0000000000000000000000000000000000000000" || !rl.some((l) => Boolean(l.args.isBuy)) ? [] as L[]
      : await (pc.getContractEvents({ address: router, abi: discipleRouterAbi, eventName: "UsdgRefund", args: { token }, fromBlock: from, toBlock: to }) as unknown as Promise<L[]>).catch(() => [] as L[]);
    const idx = usdgIndex(attachRefunds(rl.map((l) => ({ tx: l.transactionHash ?? "", args: l.args as unknown as UsdgTradeArgs })),
      refunds.map((l) => ({ tx: l.transactionHash ?? "", args: l.args as unknown as UsdgRefundArgs }))));
    for (const l of ls) if (l.eventName === "Trade") (l as L & { usdg?: UsdgTradeArgs }).usdg = idx.get(usdgKey(l.transactionHash ?? "", String(l.args.token), Boolean(l.args.isBuy)))?.shift();
    // SITE #137: the UsdgTrade getLogs can land on a node that is behind the one that served the Trade (it answers []
    // for blocks it doesn't have, no error) ⇒ the row showed the quote value instead of the USDG paid. For a Trade with
    // no match, the tx's own receipt decides (a missing receipt = node behind ⇒ brief retry).
    await Promise.all(ls.filter((l) => l.eventName === "Trade" && !usdgOf(l) && l.transactionHash).map(async (l) => {
      const u = await usdgFromReceipt(pc, router, l.transactionHash as `0x${string}`, token, Boolean(l.args.isBuy), String(l.args.trader));
      if (u) (l as L & { usdg?: UsdgTradeArgs }).usdg = u;
    }));
    return ls;
  };
  const usdgOf = (l: L) => (l as L & { usdg?: UsdgTradeArgs }).usdg;
  const c = pollLogs({
    pc, fromBlock: start,
    fetch: (from, to) => withUsdg(from, to, pc.getContractEvents({ address: curve, abi: bondingCurveAbi, fromBlock: from, toBlock: to }) as unknown as Promise<L[]>),
    onLogs: (logs) => inOrder(async () => {
      for (const l of logs) {
        if (l.eventName === "GraduatedToV4") order.trade({ type: "Graduate", token, poolId: l.args.poolId as `0x${string}`, graduatedAt: await blockTs(pc, l.blockNumber) });
        else if (l.eventName === "Trade") order.trade(tradeFromLog(l, qp, "curve", undefined, usdgOf(l)));
      }
    }),
  });
  stops.push(c.stop); kicks.push(c.kick); pollers.push(c);

  const hook = deployment().hook;
  if (hook !== "0x0000000000000000000000000000000000000000") {
    const h = pollLogs({
      pc, fromBlock: start,
      fetch: (from, to) => withUsdg(from, to, pc.getContractEvents({ address: hook, abi: ascensionHookAbi, eventName: "Trade", args: { token }, fromBlock: from, toBlock: to }) as unknown as Promise<L[]>),
      onLogs: (logs) => inOrder(async () => { const k = await hookCtx; for (const l of logs) order.trade(tradeFromLog(l, qp, "hook", k, usdgOf(l))); }),
    });
    stops.push(h.stop); kicks.push(h.kick); pollers.push(h);
  }

  if (typeof window !== "undefined") {
    // own trade: the relay's receipt block (disciple:op confirmed / the fillreceipt detail) ⇒ poll until the getLogs node
    // has that block and the tx's row arrived (brief retries); the row itself always comes from the chain's logs
    const busyTx = new Set<string>();
    const ownFill = (txHash: string | undefined, b: BlockLike) => {
      const k = String(txHash || "").toLowerCase();
      if (k && busyTx.has(k)) return;
      if (k) busyTx.add(k);
      void pollUntilFill(pollers, blockOf(b) ?? txBlock(txHash), txHash).finally(() => { if (k) busyTx.delete(k); });
    };
    const onOp = (e: Event) => { const d = (e as CustomEvent<{ phase?: string; txHash?: string; blockNumber?: BlockLike }>).detail; if (d?.phase === "confirmed" && d.blockNumber !== undefined) ownFill(d.txHash, d.blockNumber); };
    const onFill = (e: Event) => { const d = (e as CustomEvent<{ txHash?: string; blockNumber?: BlockLike }>).detail; ownFill(d?.txHash, d?.blockNumber); };
    const own = () => { kicks.forEach((k) => k()); setTimeout(() => kicks.forEach((k) => k()), 700); };
    window.addEventListener("disciple:livetrade", own); window.addEventListener("disciple:fillreceipt", onFill); window.addEventListener("disciple:op", onOp);
    stops.push(() => { window.removeEventListener("disciple:livetrade", own); window.removeEventListener("disciple:fillreceipt", onFill); window.removeEventListener("disciple:op", onOp); });
  }
  return () => stops.forEach((s) => s());
}

/**
 * Self-heal for the engine's mcap: re-read the live market (lib/mcap.ts readCoinMcap, pinned at the block it is labelled with: readMcapAt) every `everyMs`
 * and right after the player's own trade (window "disciple:livetrade"), through the same orderer. Covers a
 * dropped event filter or a missed log — the HUD/rocket converge to chain state within one interval.
 */
export function reconcileMcap(token: Address, order: McapOrderer, pc: PublicClient = publicClient(), everyMs = 8000, read: (b: bigint) => Promise<number | null> = (b) => readMcapAt(pc, token, b)): () => void {
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
  imageURI: string; mcapUsd: number; graduated: boolean;
  /** curve.progressBps() (0–10000, 10000 once graduated); null when the read failed */
  progressBps: number | null; block: bigint;
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
      pc.readContract({ ...c, functionName: "progressBps" }).catch(() => null),
      pc.readContract({ address: lp, abi: launchpadAbi, functionName: "metaOf", args: [a.token as Address] }).catch(() => null),
    ]);
    return {
      token: a.token as Address, curve, creator: a.creator as Address, quote: a.quote as Address, name: a.name, ticker: a.ticker,
      imageURI: meta ? String((meta as readonly unknown[])[2] ?? "") : "",
      mcapUsd: wad(mcap as bigint), graduated: grad as boolean, progressBps: prog == null ? null : Number(prog), block: l.blockNumber ?? BigInt(0),
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
  const [curveLogs, hookLogs, routerLogs, refundLogs] = await Promise.all([
    pc.getContractEvents({ address: curve, abi: bondingCurveAbi, fromBlock, toBlock: "latest" }),
    pc.getContractEvents({ address: deployment().hook, abi: ascensionHookAbi, eventName: "Trade", args: { token }, fromBlock, toBlock: "latest" }),
    router === "0x0000000000000000000000000000000000000000" ? Promise.resolve([])
      : pc.getContractEvents({ address: router, abi: discipleRouterAbi, eventName: "UsdgTrade", args: { token }, fromBlock, toBlock: "latest" }).catch(() => []),
    router === "0x0000000000000000000000000000000000000000" ? Promise.resolve([])
      : pc.getContractEvents({ address: router, abi: discipleRouterAbi, eventName: "UsdgRefund", args: { token }, fromBlock, toBlock: "latest" }).catch(() => []),
  ]);
  // real USDG in/out of router trades, matched by (tx, token, side); buys net of the router's UsdgRefund
  const usdg = usdgIndex(attachRefunds((routerLogs as unknown as L[]).map((l) => ({ tx: l.transactionHash ?? "", args: l.args as unknown as UsdgTradeArgs })),
    (refundLogs as unknown as L[]).map((l) => ({ tx: l.transactionHash ?? "", args: l.args as unknown as UsdgRefundArgs }))));
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
  if (e.type === "Trade") publishTraderName(e.trader);   // live retest #5: feed names (window.__discipleNames, cached lookup)
  window.dispatchEvent(new CustomEvent("disciple:event", {
    detail: JSON.parse(JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
  }));
}
