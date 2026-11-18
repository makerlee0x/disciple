import "server-only";
/**
 * Trade indexer → Upstash (lib/server/kv). Vercel-friendly: no watcher; `indexTrades()` scans
 * [cursor+1, latest] in chunks under a time budget, called by /api/chat/cron and on demand by /api/trades.
 * Source (from deployment().fromBlock): every Trade log emitted by a Launchpad BondingCurve (pre-grad; verified via
 *   launchpad.curveOf(token)), and post-grad the PoolManager Swap of each DISCIPLE pool (slim hook, lib/v4Swap; pools
 *   learned from LockedLP V4PositionSeeded into trades:pools:<launchpad>). Stacks on the old hook still emit its own
 *   Trade (`uint160 sqrtPriceAfter`, LEGACY_HOOK_TRADE); a tx with one never also books its Swap.
 * Keys:
 *   trades:<coin>              zset score=ms member=Fill JSON
 *   trades:w:<addr>:<coin>     zset score=ms member=Fill JSON
 *   trades:w:<addr>            set of coins the wallet traded
 *   trades:seen:<tx>:<li>      SET NX dedupe
 *   trades:cur:<launchpad>     last fully indexed block for that stack (starts at deployment().fromBlock − 1), so a
 *                              redeploy (new launchpad) backfills from its start block automatically. Legacy
 *                              `trades:cur` (≤ v3, unscoped) is ignored.
 *   trades:lock                10s run lock
 *   trades:reindex:lock        reindexFills run lock (60s)
 * After storeFills, the off-chain referral ledger (lib/server/referralLedger) records the 1% fee
 * slice for any fill whose trader has a locked ReferralRegistry referrer — same after-the-fact
 * path, never on the relay / admission path. See referralLedger.ts for keys and FeeMath reuse.
 */
import { decodeEventLog, getAbiItem, type Address, type Hex, type Log, type PublicClient } from "viem";
import { bondingCurveAbi, discipleRouterAbi, feeRouterAbi, launchpadAbi, lockedLPAbi } from "@/lib/abi";
import { hookTradeFromSwap, LEGACY_HOOK_TRADE, POOL_TRADE_EVENT, SWAP_EVENT, traderIndex, type SwapArgs } from "@/lib/v4Swap";
import { deployment, ZERO, usdgRouters } from "@/lib/chains";
export { usdgRouters };
import { serverPc } from "./chat/identity";
import { kv, type Kv } from "./kv";
import { ACH } from "./achKeys";
import { FAIR } from "@/lib/xp";
import { feeIndex, markReferralDirty, recordReferralSlices, type TradeFeeRoutedArgs } from "./referralLedger";

import { coinBasis } from "@/lib/mcap";
import { attachRefunds, fillUsd, FILL_V, usdgAmounts, usdgIndex, usdgKey, type Fill, type UsdgRefundArgs, type UsdgTradeArgs } from "@/lib/trades";
import { usdgDecimals } from "@/lib/usdg";

const CHUNK = BigInt(Math.max(100, Number(process.env.TRADES_CHUNK_BLOCKS) || 5000));
const CURVE_TRADE = getAbiItem({ abi: bondingCurveAbi, name: "Trade" });
const HOOK_TRADE = LEGACY_HOOK_TRADE;
const POOL_SEEDED = getAbiItem({ abi: lockedLPAbi, name: "V4PositionSeeded" });
const poolsKey = (launchpad: string) => `trades:pools:${launchpad.toLowerCase()}`;
const TRADE_EVENTS = [CURVE_TRADE, HOOK_TRADE] as const;
const USDG_TRADE = getAbiItem({ abi: discipleRouterAbi, name: "UsdgTrade" });
const USDG_REFUND = getAbiItem({ abi: discipleRouterAbi, name: "UsdgRefund" });
const FEE_ROUTED = getAbiItem({ abi: feeRouterAbi, name: "TradeFeeRouted" });

export const cursorKey = (launchpad: string) => `trades:cur:${launchpad.toLowerCase()}`;
const curveCache = new Map<string, string>();
const qpCache = new Map<string, bigint>();
const blockTs = new Map<bigint, number>();

async function curveOf(coin: Address): Promise<string> {
  const hit = curveCache.get(coin); if (hit) return hit;
  const c = await serverPc().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [coin] }).catch(() => ZERO);
  const v = String(c).toLowerCase(); curveCache.set(coin, v); return v;
}
/** Launch-time quote price of a coin's curve (USD WAD per 1e18 quote raw) — the USD basis for hook (post-grad) fills. */
async function quotePriceOf(curve: string): Promise<bigint> {
  const hit = qpCache.get(curve); if (hit !== undefined) return hit;
  const v = await serverPc().readContract({ address: curve as Address, abi: bondingCurveAbi, functionName: "quotePriceUsd" }).catch(() => BigInt(0));
  qpCache.set(curve, v as bigint); return v as bigint;
}
const quoteCache = new Map<string, string>();
/** A coin's quote token (curve.quote(); immutable) — the v4 currency order for hook fills' sqrtPriceAfter → mcap. */
async function quoteOf(curve: string): Promise<string | undefined> {
  const hit = quoteCache.get(curve); if (hit) return hit;
  const q = await serverPc().readContract({ address: curve as Address, abi: bondingCurveAbi, functionName: "quote" }).catch(() => undefined);
  if (!q) return undefined;
  const v = String(q).toLowerCase(); quoteCache.set(curve, v); return v;
}
async function tsOf(bn: bigint): Promise<number> {
  const hit = blockTs.get(bn); if (hit) return hit;
  const b = await serverPc().getBlock({ blockNumber: bn });
  const t = Number(b.timestamp) * 1000; blockTs.set(bn, t); return t;
}

/** Pure: decoded log → Fill (exported for tests). */
export function toFill(log: { transactionHash: string; logIndex: number; blockNumber: bigint }, venue: Fill["venue"], a: {
  token: string; trader: string; isBuy: boolean; tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd?: bigint; quotePriceUsd?: bigint;
  sqrtPriceAfter?: bigint; quote?: string; supplyTokens?: number;
  /** Trade.quoteAmt: quote paid (buy) / received (sell) ⇒ usd = quoteAmt × quotePriceUsd (lib/trades fillUsd) */
  quoteAmt?: bigint;
  /** Trade.impactBps (uncapped) / Trade.snipeFee (quote raw) — stored per fill (achievements bomb rules) */
  impactBps?: bigint; snipeFee?: bigint;
}, ts: number, usdg?: UsdgTradeArgs): Fill {
  const u = fillUsd(a);
  return {
    id: `${log.transactionHash}:${log.logIndex}`, tx: log.transactionHash, logIndex: log.logIndex, block: Number(log.blockNumber), ts,
    coin: a.token.toLowerCase(), trader: a.trader.toLowerCase(), side: a.isBuy ? "buy" : "sell", venue, ...u,
    // same account only (the router trades for msg.sender, so Trade.trader == UsdgTrade.trader — verified on 46630).
    // usdIn is NET of the router's UsdgRefund when usdg.usdgRefund is set (attachRefunds).
    ...usdgAmounts(usdg && usdg.trader.toLowerCase() === a.trader.toLowerCase() ? usdg : undefined, usdgDecimals()),
    ...(a.impactBps !== undefined ? { impactBps: Number(a.impactBps) } : {}),
    priceBeforeX18: a.priceBeforeX18.toString(),
    ...(a.snipeFee !== undefined ? { snipeFee: a.snipeFee.toString() } : {}),
    v: FILL_V,
  };
}

export type TradeArgs = { token: string; trader: string; isBuy: boolean; tokenAmt: bigint; quoteAmt?: bigint; impactBps?: bigint; snipeFee?: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd?: bigint; quotePriceUsd?: bigint; sqrtPriceAfter?: bigint; quote?: string; supplyTokens?: number };
/**
 * Verify the emitter and fill in the USD basis of a decoded Trade (mutates `a`): venue (null = spoofed / foreign), the coin's
 * launch quote price (both venues: usd = quoteAmt × quotePriceUsd), and for hook trades the quote (currency order) for the
 * sqrtPriceAfter → mcap math (full precision; priceAfterX18 is floored to single digits at 6-dec USDG — FLOW #115).
 * USD basis = lib/mcap (launch quote price × the coin's OWN supply) — the same number the header/cards show.
 */
async function prepareTrade(pc: PublicClient | ReturnType<typeof serverPc>, a: TradeArgs, src: string, hook: string): Promise<Fill["venue"] | null> {
  const curve = await curveOf(a.token.toLowerCase() as Address);
  const venue: Fill["venue"] | null = src === hook ? (curve !== ZERO.toLowerCase() ? "hook" : null) : curve === src ? "curve" : null;
  if (!venue) return null;
  const basis = await coinBasis(pc as unknown as PublicClient, a.token as Address, curve as Address).catch(() => null);
  a.quotePriceUsd = basis?.launchQuoteUsd ?? await quotePriceOf(curve);
  if (venue === "hook") {
    delete a.mcapAfterUsd;
    a.quote = basis ? basis.quote.toLowerCase() : await quoteOf(curve);
  } else delete a.sqrtPriceAfter;
  a.supplyTokens = basis?.supplyTokens;
  return venue;
}

export async function indexTrades(budgetMs = 20_000): Promise<{ indexed: number; cursor: string; latest: string; skipped?: string }> {
  const s = kv(), d = deployment();
  if (d.launchpad === ZERO) return { indexed: 0, cursor: "0", latest: "0", skipped: "not deployed" };
  const ck = cursorKey(d.launchpad);
  if (!(await s.setNX("trades:lock", "1", 30))) return { indexed: 0, cursor: (await s.get(ck)) ?? "", latest: "", skipped: "locked" };
  const t0 = Date.now();
  let n = 0;
  try {
    const pc = serverPc();
    const latest = await pc.getBlockNumber();
    const curRaw = await s.get(ck);
    let cur = curRaw ? BigInt(curRaw) : d.fromBlock - BigInt(1);
    const hook = d.hook.toLowerCase();
    let chunk = CHUNK;
    while (cur < latest && Date.now() - t0 < budgetMs) {
      const from = cur + BigInt(1);
      const to = from + chunk - BigInt(1) > latest ? latest : from + chunk - BigInt(1);
      let logs: Log[];
      try {
        // topic0 = Trade (any emitter); emitter verified below.
        logs = (await pc.getLogs({ events: TRADE_EVENTS, fromBlock: from, toBlock: to, strict: false } as never)) as Log[];
      } catch (e) {
        if (chunk > BigInt(50)) { chunk = chunk / BigInt(4); continue; } // RPC result/range cap: shrink and retry
        throw e;
      }
      // DiscipleRouter UsdgTrade in the same range (address-filtered: the RH RPC serves those over any range) ⇒ real USDG in/out.
      // Same pattern as d.router, also watching deployment().gaslessRouter (gasless Permit2 fills emit there).
      const routers = usdgRouters(d);
      const usdgLogs = routers.length === 0 ? [] : ((await pc.getLogs({ address: routers, event: USDG_TRADE, fromBlock: from, toBlock: to }).catch(() => [])) as unknown as { transactionHash: string; args: UsdgTradeArgs }[]);
      // …and UsdgRefund on the same routers (graduating buy / First BOOST over the cap) ⇒ usdIn is the NET paid.
      const refundLogs = routers.length === 0 || !usdgLogs.length ? [] : ((await pc.getLogs({ address: routers, event: USDG_REFUND, fromBlock: from, toBlock: to }).catch(() => [])) as unknown as { transactionHash: string; args: UsdgRefundArgs }[]);
      const usdg = usdgIndex(attachRefunds(usdgLogs.map((x) => ({ tx: x.transactionHash, args: x.args })), refundLogs.map((x) => ({ tx: x.transactionHash, args: x.args }))));
      // FeeRouter.TradeFeeRouted in the same range: exact 33/33/33/1 split (referralLedger prefers this over fill math).
      const feeLogs = d.feeRouter && d.feeRouter.toLowerCase() !== ZERO.toLowerCase()
        ? ((await pc.getLogs({ address: d.feeRouter, event: FEE_ROUTED, fromBlock: from, toBlock: to }).catch(() => [])) as unknown as { transactionHash: string; args: TradeFeeRoutedArgs }[])
        : [];
      const fees = feeIndex(feeLogs.map((x) => ({ tx: x.transactionHash, args: x.args })));
      const fills: Fill[] = [];
      for (const l of logs) {
        let dec: { args: Record<string, unknown> };
        const src = l.address.toLowerCase();
        const fromHook = src === hook;
        // decode with the emitter's own signature (hook: sqrtPriceAfter; curve: mcapAfterUsd)
        try { dec = decodeEventLog({ abi: [fromHook ? HOOK_TRADE : CURVE_TRADE], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as never; } catch { continue; }
        const a = dec.args as TradeArgs;
        const venue = await prepareTrade(pc, a, src, hook);
        if (!venue) continue; // spoofed Trade event from an unrelated contract (or a hook trade of a foreign token)
        const tx = l.transactionHash ?? "", li = l.logIndex ?? 0;
        if (!(await s.setNX(`trades:seen:${tx}:${li}`, "1"))) continue;
        fills.push(toFill({ transactionHash: tx, logIndex: li, blockNumber: l.blockNumber ?? BigInt(0) }, venue, a, await tsOf(l.blockNumber ?? BigInt(0)), usdg.get(usdgKey(tx, a.token, a.isBuy))?.shift()));
      }
      // Slim hook: post-grad trades come from the PoolManager Swap of each DISCIPLE pool (none on old-hook txs).
      const legacyTx = new Set(logs.filter((l) => l.address.toLowerCase() === hook).map((l) => String(l.transactionHash).toLowerCase()));
      for (const sw of await swapTrades(pc, d, from, to, usdgLogs, routers, legacyTx)) {
        const a = sw.a;
        const venue = await prepareTrade(pc, a, hook, hook);
        if (!venue) continue;
        const tx = sw.l.transactionHash ?? "", li = sw.l.logIndex ?? 0;
        if (!(await s.setNX(`trades:seen:${tx}:${li}`, "1"))) continue;
        fills.push(toFill({ transactionHash: tx, logIndex: li, blockNumber: sw.l.blockNumber ?? BigInt(0) }, venue, a, await tsOf(sw.l.blockNumber ?? BigInt(0)), usdg.get(usdgKey(tx, a.token, a.isBuy))?.shift()));
      }
      await storeFills(fills);
      // After-the-fact only. A ledger failure must not fail the trade index; dirty fills are drained by the CSV/cron path.
      if (fills.length) await recordReferralSlices(fills, fees).catch((e) => console.warn("[referral-ledger]", (e as Error).message));
      n += fills.length;
      cur = to;
      await s.set(ck, cur.toString());
    }
    return { indexed: n, cursor: cur.toString(), latest: latest.toString() };
  } finally {
    await s.del("trades:lock").catch(() => {});
  }
}

/**
 * PoolManager Swaps of the stack's DISCIPLE pools in [from, to], as hook-Trade args (lib/v4Swap). Pools are learned from
 * LockedLP V4PositionSeeded (graduation) into trades:pools:<launchpad>. The trader is our router's PoolTrade / UsdgTrade
 * in the same tx, else the tx sender. Throws on an RPC range error so the caller shrinks the chunk.
 */
async function swapTrades(
  pc: ReturnType<typeof serverPc>, d: ReturnType<typeof deployment>, from: bigint, to: bigint,
  usdgLogs: { transactionHash: string; args: UsdgTradeArgs }[], routers: Address[], legacyTx: Set<string>,
): Promise<{ l: Log; a: TradeArgs }[]> {
  if (d.poolManager === ZERO || d.lockedLP === ZERO || d.hook === ZERO) return [];
  const s = kv(), pk = poolsKey(d.launchpad);
  const seeded = (await pc.getLogs({ address: d.lockedLP, event: POOL_SEEDED, fromBlock: from, toBlock: to })) as unknown as { args: { token: string; poolId: string } }[];
  if (seeded.length) await s.sadd(pk, ...seeded.map((x) => `${x.args.poolId.toLowerCase()}|${x.args.token.toLowerCase()}`));
  const tokOf = new Map<string, string>();
  for (const m of await s.smembers(pk)) { const [id, t] = m.split("|"); if (id && t) tokOf.set(id, t); }
  if (!tokOf.size) return [];
  const ids = Array.from(tokOf.keys()) as Hex[];
  const swaps: (Log & { args: SwapArgs })[] = [];
  for (let i = 0; i < ids.length; i += 100)
    swaps.push(...((await pc.getLogs({ address: d.poolManager, event: SWAP_EVENT, args: { id: ids.slice(i, i + 100) }, fromBlock: from, toBlock: to })) as unknown as (Log & { args: SwapArgs })[]));
  if (!swaps.length) return [];
  const pt = routers.length === 0 ? [] : ((await pc.getLogs({ address: routers, event: POOL_TRADE_EVENT, fromBlock: from, toBlock: to }).catch(() => [])) as unknown as { transactionHash: string; args: { trader: string; token: string; isBuy: boolean } }[]);
  const who = traderIndex([...pt, ...usdgLogs].map((x) => ({ tx: x.transactionHash, trader: String(x.args.trader), token: String(x.args.token), isBuy: Boolean(x.args.isBuy) })));
  const out: { l: Log; a: TradeArgs }[] = [];
  for (const sw of swaps) {
    const tx = String(sw.transactionHash ?? "");
    if (legacyTx.has(tx.toLowerCase())) continue;
    const token = tokOf.get(String(sw.args.id).toLowerCase()); if (!token) continue;
    const curve = await curveOf(token as Address);
    const quote = curve === ZERO.toLowerCase() ? undefined : await quoteOf(curve);
    if (!quote) continue;
    const pre = hookTradeFromSwap(sw.args, token, quote, ZERO);
    let trader = who(tx, token, pre.isBuy);
    if (!trader && tx) trader = await pc.getTransaction({ hash: tx as Hex }).then((t) => t.from, () => undefined);
    out.push({ l: sw, a: { ...pre, trader: (trader ?? sw.args.sender ?? ZERO).toLowerCase() } });
  }
  return out;
}

export async function storeFills(fills: Fill[]) {
  const s = kv();
  const byKey = new Map<string, { score: number; member: string }[]>();
  const push = (k: string, f: Fill) => { const l = byKey.get(k) ?? []; l.push({ score: f.ts, member: JSON.stringify(f) }); byKey.set(k, l); };
  for (const f of fills) { push(`trades:${f.coin}`, f); push(`trades:w:${f.trader}:${f.coin}`, f); }
  for (const [k, items] of Array.from(byKey.entries())) await s.zadd(k, items);
  const coinsBy = new Map<string, Set<string>>();
  for (const f of fills) (coinsBy.get(f.trader) ?? coinsBy.set(f.trader, new Set()).get(f.trader)!).add(f.coin);
  for (const [w, cs] of Array.from(coinsBy.entries())) await s.sadd(`trades:w:${w}`, ...Array.from(cs));
  // achievements engine: re-score these wallets on the next /api/cron/achievements (one member per fill ⇒ never lost)
  if (fills.length) {
    await s.zadd(ACH.dirty(), fills.map((f) => ({ score: Date.now(), member: `${f.trader}|${f.id}` })));
    await markReferralDirty(fills);
    // "Hold through a bomb" (lib/xp FAIR.holdBombImpactBps): a 5%+ dump re-scores the rocket's recent pilots, whose own
    // fills didn't change (the mission then sets a timer for the end of its 10 minutes)
    for (const f of fills) {
      if (f.side !== "sell" || !(Math.abs(f.impactBps ?? 0) >= FAIR.holdBombImpactBps)) continue;
      const ws = new Set<string>();
      for (const m of await s.zrange(`trades:${f.coin}`, 1000, true)) { try { const t = (JSON.parse(m) as Fill).trader; if (t && t !== f.trader) ws.add(t.toLowerCase()); } catch { /* skip */ } }
      if (ws.size) await s.zadd(ACH.dirty(), Array.from(ws).map((w) => ({ score: Date.now(), member: `${w}|bomb:${f.id}` })));
    }
  }
}

const byOrder = (a: Fill, b: Fill) => a.block - b.block || a.logIndex - b.logIndex;
export const TRADES_MAX_LIMIT = 5000;
/** Fills oldest→newest. order "asc" (default) = the oldest `limit`; "desc" = the newest `limit` (ZRANGE … REV), still returned oldest→newest.
 *  offset skips that many from the chosen end first (paging the full history: the coin chart reads asc pages of 5000). */
export async function tradesOf(coin: string, wallet?: string | null, limit = 1000, order: "asc" | "desc" = "asc", offset = 0): Promise<Fill[]> {
  const k = wallet ? `trades:w:${wallet.toLowerCase()}:${coin.toLowerCase()}` : `trades:${coin.toLowerCase()}`;
  const n = Math.min(TRADES_MAX_LIMIT, Math.max(1, Math.floor(limit) || 1));
  const raw = await kv().zrange(k, n, order === "desc", Math.max(0, Math.floor(offset) || 0));
  const seen = new Set<string>();
  return raw.map((r) => JSON.parse(r) as Fill).filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))).sort(byOrder);
}
export async function coinsOf(wallet: string): Promise<string[]> { return kv().smembers(`trades:w:${wallet.toLowerCase()}`); }

/**
 * Pure (tests): a stored fill rebuilt from its decoded + prepared Trade (prepareTrade) — same id/tx/ts. `usdg` = the
 * router's UsdgTrade for this fill re-read from the receipt (usdgFromReceiptLogs, refund attached) ⇒ usdIn/usdOut are
 * recomputed (net of UsdgRefund). Without it (undefined: receipt had no router leg we could match) the stored
 * usdIn/usdOut are kept — never dropped.
 */
export function revalueFill(f: Fill, venue: Fill["venue"], a: TradeArgs, usdg?: UsdgTradeArgs): Fill {
  const nf: Fill = toFill({ transactionHash: f.tx, logIndex: f.logIndex, blockNumber: BigInt(f.block) }, venue, a, f.ts, usdg);
  if (!usdg) {
    if (f.usdIn !== undefined) nf.usdIn = f.usdIn;
    if (f.usdOut !== undefined) nf.usdOut = f.usdOut;
  }
  return nf;
}
type RLog = { address: string; topics: readonly string[]; data: string; logIndex: number | bigint | null };
/**
 * Pure (tests): the router UsdgTrade (with its UsdgRefund attached) for the Trade log at `logIndex` in a receipt. Matched
 * like the indexer: the n-th Trade of (token, side) in the tx takes the n-th UsdgTrade of (token, side), by log order.
 * `router` is one address or the list from usdgRouters() (regular + gasless).
 */
export function usdgFromReceiptLogs(logs: readonly RLog[], router: string | readonly string[], logIndex: number, a: { token: string; isBuy: boolean }): UsdgTradeArgs | undefined {
  const routers = new Set((typeof router === "string" ? [router] : router).map((x) => x.toLowerCase()).filter((x) => x && x !== ZERO.toLowerCase()));
  const tok = a.token.toLowerCase();
  const sorted = [...logs].sort((x, y) => Number(x.logIndex) - Number(y.logIndex));
  const trades: { tx: string; args: UsdgTradeArgs }[] = [], refunds: { tx: string; args: UsdgRefundArgs }[] = [];
  let nth = 0;
  for (const l of sorted) {
    const t = { data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] };
    if (routers.has(l.address.toLowerCase())) {
      try {
        const ev = decodeEventLog({ abi: [USDG_TRADE, USDG_REFUND], ...t }) as unknown as { eventName: string; args: Record<string, unknown> };
        if (ev.eventName === "UsdgTrade") trades.push({ tx: "r", args: ev.args as unknown as UsdgTradeArgs });
        else if (ev.eventName === "UsdgRefund") refunds.push({ tx: "r", args: ev.args as unknown as UsdgRefundArgs });
      } catch { /* other router event */ }
      continue;
    }
    if (Number(l.logIndex) >= logIndex) continue;
    try {
      const ev = decodeEventLog({ abi: [CURVE_TRADE], ...t }) as unknown as { args: { token: string; isBuy: boolean } };
      if (ev.args.token.toLowerCase() === tok && ev.args.isBuy === a.isBuy) nth++;
    } catch {
      try {
        const ev = decodeEventLog({ abi: [HOOK_TRADE], ...t }) as unknown as { args: { token: string; isBuy: boolean } };
        if (ev.args.token.toLowerCase() === tok && ev.args.isBuy === a.isBuy) nth++;
      } catch { /* not a Trade */ }
    }
  }
  attachRefunds(trades, refunds);
  const mine = trades.filter((x) => String(x.args.token).toLowerCase() === tok && x.args.isBuy === a.isBuy);
  return mine[nth]?.args;
}
/** Swap one stored fill member for its revalued JSON in the coin + wallet zsets (add first: a crash never loses the fill; tradesOf dedupes by id). */
export async function replaceFill(s: Pick<Kv, "zadd" | "zrem">, coin: string, oldMember: string, nf: Fill): Promise<void> {
  const nm = JSON.stringify(nf), wk = `trades:w:${nf.trader}:${coin}`;
  await s.zadd(`trades:${coin}`, [{ score: nf.ts, member: nm }]);
  await s.zadd(wk, [{ score: nf.ts, member: nm }]);
  await s.zrem(`trades:${coin}`, oldMember);
  await s.zrem(wk, oldMember);
  // a re-indexed fill (net usdIn, impactBps) can change achievements ⇒ re-score its wallet
  await s.zadd(ACH.dirty(), [{ score: Date.now(), member: `${nf.trader}|re:${nf.id}:${nf.v ?? 0}` }]);
}

/**
 * Re-value stored fills (SITE job 7): every fill without usdBasis "quote" (indexed with the old tokens × mid-price
 * estimate) is rebuilt from its own Trade log (tx receipt, same logIndex) with toFill — usd = quoteAmt × the coin's launch
 * quote price — keeping id/ts and the router's real usdIn/usdOut. The old JSON member is replaced (ZREM + ZADD) in
 * trades:<coin> and trades:w:<trader>:<coin>. usdIn/usdOut are recomputed from the receipt's UsdgTrade + UsdgRefund (net
 * paid). Idempotent: fills already on usdBasis "quote" AND schema FILL_V are skipped without RPC, so re-running converges
 * and is cheap; bumping FILL_V (lib/trades) rebuilds every older fill once. Scope: one coin, or "all" (every coin the Launchpad launched since fromBlock).
 * dryRun reports what would change and writes nothing. Stops at budgetMs; `done: false` ⇒ run again.
 */
export async function reindexFills(scope: { coin: string } | "all", o: { dryRun?: boolean; budgetMs?: number } = {}): Promise<{
  coins: number; scanned: number; changed: number; skipped: number; missing: number; done: boolean; dryRun: boolean;
  samples: { id: string; coin: string; side: Fill["side"]; usdBefore: number; usdAfter: number; usdInBefore?: number; usdInAfter?: number }[];
}> {
  const s = kv(), d = deployment(), pc = serverPc(), t0 = Date.now(), budget = o.budgetMs ?? 45_000, dryRun = !!o.dryRun;
  const out = { coins: 0, scanned: 0, changed: 0, skipped: 0, missing: 0, done: true, dryRun, samples: [] as { id: string; coin: string; side: Fill["side"]; usdBefore: number; usdAfter: number; usdInBefore?: number; usdInAfter?: number }[] };
  if (d.launchpad === ZERO) return out;
  if (!dryRun && !(await s.setNX("trades:reindex:lock", "1", 60))) throw new Error("reindex already running");
  try {
    const coins = scope === "all"
      ? Array.from(new Set((await pc.getContractEvents({ address: d.launchpad, abi: launchpadAbi, eventName: "Launched", fromBlock: d.fromBlock, toBlock: "latest" }))
        .map((l) => String((l.args as { token: string }).token).toLowerCase())))
      : [scope.coin.toLowerCase()];
    const hook = d.hook.toLowerCase();
    const receipts = new Map<string, Promise<{ logs: Log[] } | null>>();
    const receipt = (tx: string) => {
      let r = receipts.get(tx);
      if (!r) { r = pc.getTransactionReceipt({ hash: tx as Hex }).then((x) => x as unknown as { logs: Log[] }, () => null); receipts.set(tx, r); }
      return r;
    };
    for (const coin of coins) {
      if (Date.now() - t0 > budget) { out.done = false; break; }
      out.coins++;
      const members = await s.zrange(`trades:${coin}`, 1_000_000);
      for (const m of members) {
        if (Date.now() - t0 > budget) { out.done = false; break; }
        out.scanned++;
        let f: Fill;
        try { f = JSON.parse(m) as Fill; } catch { out.missing++; continue; }
        if (f.usdBasis === "quote" && (f.v ?? 0) >= FILL_V) { out.skipped++; continue; }
        const r = await receipt(f.tx);
        const l = r?.logs.find((x) => Number(x.logIndex) === f.logIndex);
        if (!l) { out.missing++; continue; }
        let src = l.address.toLowerCase();
        let a: TradeArgs;
        try {
          if (src === d.poolManager.toLowerCase()) {
            // slim-hook fill: rebuilt from its PoolManager Swap (trader kept from the stored fill)
            const sw = (decodeEventLog({ abi: [SWAP_EVENT], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { args: SwapArgs }).args;
            const curve = await curveOf(coin as Address);
            const quote = curve === ZERO.toLowerCase() ? undefined : await quoteOf(curve);
            if (!quote) throw new Error("no quote");
            a = hookTradeFromSwap(sw, coin, quote, f.trader);
            src = hook;
          } else a = (decodeEventLog({ abi: [src === hook ? HOOK_TRADE : CURVE_TRADE], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { args: TradeArgs }).args;
        }
        catch { out.missing++; continue; }
        const venue = await prepareTrade(pc, a, src, hook);
        if (!venue) { out.missing++; continue; }
        const routers = usdgRouters(d);
        const usdg = routers.length === 0 ? undefined : usdgFromReceiptLogs(r!.logs as unknown as RLog[], routers, f.logIndex, a);
        const nf = revalueFill(f, venue, a, usdg);
        const nm = JSON.stringify(nf);
        if (nm === m) { out.skipped++; continue; }
        out.changed++;
        if (out.samples.length < 20) out.samples.push({ id: f.id, coin, side: f.side, usdBefore: f.usd, usdAfter: nf.usd, usdInBefore: f.usdIn, usdInAfter: nf.usdIn });
        if (dryRun) continue;
        await replaceFill(s, coin, m, nf);
      }
      if (!out.done) break;
    }
    return out;
  } finally {
    if (!dryRun) await s.del("trades:reindex:lock").catch(() => {});
  }
}
