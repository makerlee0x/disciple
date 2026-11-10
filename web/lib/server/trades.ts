import "server-only";
/**
 * Trade indexer → Upstash (lib/server/kv). Vercel-friendly: no watcher; `indexTrades()` scans
 * [cursor+1, latest] in chunks under a time budget, called by /api/chat/cron and on demand by /api/trades.
 * Source (from deployment().fromBlock): every Trade log emitted by the AscensionHook (post-grad) or a Launchpad BondingCurve
 *   (pre-grad; verified via launchpad.curveOf(token)). v4 has TWO Trade signatures (different topic0): the curve's ends
 *   in `uint256 mcapAfterUsd`, the hook's in `uint160 sqrtPriceAfter` (gas G-1) — both are fetched and decoded.
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
 */
import { decodeEventLog, getAbiItem, type Address, type Hex, type Log, type PublicClient } from "viem";
import { bondingCurveAbi, ascensionHookAbi, discipleRouterAbi, launchpadAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { serverPc } from "./chat/identity";
import { kv, type Kv } from "./kv";
import { ACH } from "./achKeys";
import { coinBasis } from "@/lib/mcap";
import { attachRefunds, fillUsd, FILL_V, usdgAmounts, usdgIndex, usdgKey, type Fill, type UsdgRefundArgs, type UsdgTradeArgs } from "@/lib/trades";
import { usdgDecimals } from "@/lib/usdg";

const CHUNK = BigInt(Math.max(100, Number(process.env.TRADES_CHUNK_BLOCKS) || 5000));
const CURVE_TRADE = getAbiItem({ abi: bondingCurveAbi, name: "Trade" });
const HOOK_TRADE = getAbiItem({ abi: ascensionHookAbi, name: "Trade" });
const TRADE_EVENTS = [CURVE_TRADE, HOOK_TRADE] as const;
const USDG_TRADE = getAbiItem({ abi: discipleRouterAbi, name: "UsdgTrade" });
const USDG_REFUND = getAbiItem({ abi: discipleRouterAbi, name: "UsdgRefund" });
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
      // DiscipleRouter UsdgTrade in the same range (address-filtered: the RH RPC serves those over any range) ⇒ real USDG in/out
      const router = d.router;
      const usdgLogs = router === ZERO ? [] : ((await pc.getLogs({ address: router, event: USDG_TRADE, fromBlock: from, toBlock: to }).catch(() => [])) as unknown as { transactionHash: string; args: UsdgTradeArgs }[]);
      // …and its UsdgRefund (graduating buy / First BOOST over the cap) ⇒ usdIn is the NET paid. Router address only.
      const refundLogs = router === ZERO || !usdgLogs.length ? [] : ((await pc.getLogs({ address: router, event: USDG_REFUND, fromBlock: from, toBlock: to }).catch(() => [])) as unknown as { transactionHash: string; args: UsdgRefundArgs }[]);
      const usdg = usdgIndex(attachRefunds(usdgLogs.map((x) => ({ tx: x.transactionHash, args: x.args })), refundLogs.map((x) => ({ tx: x.transactionHash, args: x.args }))));
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
      await storeFills(fills);
      n += fills.length;
      cur = to;
      await s.set(ck, cur.toString());
    }
    return { indexed: n, cursor: cur.toString(), latest: latest.toString() };
  } finally {
    await s.del("trades:lock").catch(() => {});
  }
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
  if (fills.length) await s.zadd(ACH.dirty(), fills.map((f) => ({ score: Date.now(), member: `${f.trader}|${f.id}` })));
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
 */
export function usdgFromReceiptLogs(logs: readonly RLog[], router: string, logIndex: number, a: { token: string; isBuy: boolean }): UsdgTradeArgs | undefined {
  const r = router.toLowerCase(), tok = a.token.toLowerCase();
  const sorted = [...logs].sort((x, y) => Number(x.logIndex) - Number(y.logIndex));
  const trades: { tx: string; args: UsdgTradeArgs }[] = [], refunds: { tx: string; args: UsdgRefundArgs }[] = [];
  let nth = 0;
  for (const l of sorted) {
    const t = { data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] };
    if (l.address.toLowerCase() === r) {
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
        const src = l.address.toLowerCase();
        let a: TradeArgs;
        try { a = (decodeEventLog({ abi: [src === hook ? HOOK_TRADE : CURVE_TRADE], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as unknown as { args: TradeArgs }).args; }
        catch { out.missing++; continue; }
        const venue = await prepareTrade(pc, a, src, hook);
        if (!venue) { out.missing++; continue; }
        const usdg = d.router === ZERO ? undefined : usdgFromReceiptLogs(r!.logs as unknown as RLog[], d.router, f.logIndex, a);
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
