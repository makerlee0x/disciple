import "server-only";
/**
 * Trade indexer → Upstash (lib/server/kv). Vercel-friendly: no watcher; `indexTrades()` scans
 * [cursor+1, latest] in chunks under a time budget, called by /api/chat/cron and on demand by /api/trades.
 * Source (from deployment().fromBlock): every Trade log emitted by the DiscipleHook (post-grad) or a Launchpad BondingCurve
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
 */
import { decodeEventLog, getAbiItem, type Address, type Hex, type Log } from "viem";
import { bondingCurveAbi, discipleHookAbi, discipleRouterAbi, launchpadAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { serverPc } from "./chat/identity";
import { kv } from "./kv";
import { fillUsd, usdgAmounts, usdgIndex, usdgKey, type Fill, type UsdgTradeArgs } from "@/lib/trades";
import { usdgDecimals } from "@/lib/usdg";

const CHUNK = BigInt(Math.max(100, Number(process.env.TRADES_CHUNK_BLOCKS) || 5000));
const CURVE_TRADE = getAbiItem({ abi: bondingCurveAbi, name: "Trade" });
const HOOK_TRADE = getAbiItem({ abi: discipleHookAbi, name: "Trade" });
const TRADE_EVENTS = [CURVE_TRADE, HOOK_TRADE] as const;
const USDG_TRADE = getAbiItem({ abi: discipleRouterAbi, name: "UsdgTrade" });
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
async function tsOf(bn: bigint): Promise<number> {
  const hit = blockTs.get(bn); if (hit) return hit;
  const b = await serverPc().getBlock({ blockNumber: bn });
  const t = Number(b.timestamp) * 1000; blockTs.set(bn, t); return t;
}

/** Pure: decoded log → Fill (exported for tests). */
export function toFill(log: { transactionHash: string; logIndex: number; blockNumber: bigint }, venue: Fill["venue"], a: {
  token: string; trader: string; isBuy: boolean; tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd?: bigint; quotePriceUsd?: bigint;
}, ts: number, usdg?: UsdgTradeArgs): Fill {
  const u = fillUsd(a);
  return {
    id: `${log.transactionHash}:${log.logIndex}`, tx: log.transactionHash, logIndex: log.logIndex, block: Number(log.blockNumber), ts,
    coin: a.token.toLowerCase(), trader: a.trader.toLowerCase(), side: a.isBuy ? "buy" : "sell", venue, ...u,
    // same account only (the router trades for msg.sender, so Trade.trader == UsdgTrade.trader — verified on 46630)
    ...usdgAmounts(usdg && usdg.trader.toLowerCase() === a.trader.toLowerCase() ? usdg : undefined, usdgDecimals()),
  };
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
      const usdg = usdgIndex(usdgLogs.map((x) => ({ tx: x.transactionHash, args: x.args })));
      const fills: Fill[] = [];
      for (const l of logs) {
        let dec: { args: Record<string, unknown> };
        const src = l.address.toLowerCase();
        const fromHook = src === hook;
        // decode with the emitter's own signature (hook: sqrtPriceAfter; curve: mcapAfterUsd)
        try { dec = decodeEventLog({ abi: [fromHook ? HOOK_TRADE : CURVE_TRADE], data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as never; } catch { continue; }
        const a = dec.args as { token: string; trader: string; isBuy: boolean; tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd?: bigint; quotePriceUsd?: bigint };
        const curve = await curveOf(a.token.toLowerCase() as Address);
        const venue: Fill["venue"] | null = fromHook ? (curve !== ZERO.toLowerCase() ? "hook" : null) : curve === src ? "curve" : null;
        if (!venue) continue; // spoofed Trade event from an unrelated contract (or a hook trade of a foreign token)
        if (venue === "hook") { delete a.mcapAfterUsd; a.quotePriceUsd = await quotePriceOf(curve); }
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
}

const byOrder = (a: Fill, b: Fill) => a.block - b.block || a.logIndex - b.logIndex;
export const TRADES_MAX_LIMIT = 5000;
/** Fills oldest→newest. order "asc" (default) = the oldest `limit`; "desc" = the newest `limit` (ZRANGE … REV), still returned oldest→newest. */
export async function tradesOf(coin: string, wallet?: string | null, limit = 1000, order: "asc" | "desc" = "asc"): Promise<Fill[]> {
  const k = wallet ? `trades:w:${wallet.toLowerCase()}:${coin.toLowerCase()}` : `trades:${coin.toLowerCase()}`;
  const n = Math.min(TRADES_MAX_LIMIT, Math.max(1, Math.floor(limit) || 1));
  const raw = await kv().zrange(k, n, order === "desc");
  const seen = new Set<string>();
  return raw.map((r) => JSON.parse(r) as Fill).filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true))).sort(byOrder);
}
export async function coinsOf(wallet: string): Promise<string[]> { return kv().smembers(`trades:w:${wallet.toLowerCase()}`); }
