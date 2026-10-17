import "server-only";
/**
 * Trade indexer → Upstash (lib/server/kv). Vercel-friendly: no watcher; `indexTrades()` scans
 * [cursor+1, latest] in chunks under a time budget, called by /api/chat/cron and on demand by /api/trades.
 * Source (from deployment().fromBlock): every `Trade(address indexed token, address indexed trader, …)` log (ITradeEvents) emitted by the
 *   DiscipleHook (post-grad) or a Launchpad BondingCurve (pre-grad; verified via launchpad.curveOf(token)).
 * Keys:
 *   trades:<coin>              zset score=ms member=Fill JSON
 *   trades:w:<addr>:<coin>     zset score=ms member=Fill JSON
 *   trades:w:<addr>            set of coins the wallet traded
 *   trades:seen:<tx>:<li>      SET NX dedupe
 *   trades:cur                 last fully indexed block (starts at deployment().fromBlock − 1)
 *   trades:lock                10s run lock
 */
import { decodeEventLog, getAbiItem, type Address, type Hex, type Log } from "viem";
import { discipleHookAbi, launchpadAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { serverPc } from "./chat/identity";
import { kv } from "./kv";
import { fillUsd, type Fill } from "@/lib/trades";

const CHUNK = BigInt(Math.max(100, Number(process.env.TRADES_CHUNK_BLOCKS) || 5000));
const TRADE_EVENT = getAbiItem({ abi: discipleHookAbi, name: "Trade" });
const curveCache = new Map<string, string>();
const blockTs = new Map<bigint, number>();

async function curveOf(coin: Address): Promise<string> {
  const hit = curveCache.get(coin); if (hit) return hit;
  const c = await serverPc().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [coin] }).catch(() => ZERO);
  const v = String(c).toLowerCase(); curveCache.set(coin, v); return v;
}
async function tsOf(bn: bigint): Promise<number> {
  const hit = blockTs.get(bn); if (hit) return hit;
  const b = await serverPc().getBlock({ blockNumber: bn });
  const t = Number(b.timestamp) * 1000; blockTs.set(bn, t); return t;
}

/** Pure: decoded log → Fill (exported for tests). */
export function toFill(log: { transactionHash: string; logIndex: number; blockNumber: bigint }, venue: Fill["venue"], a: {
  token: string; trader: string; isBuy: boolean; tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd: bigint;
}, ts: number): Fill {
  const u = fillUsd(a);
  return {
    id: `${log.transactionHash}:${log.logIndex}`, tx: log.transactionHash, logIndex: log.logIndex, block: Number(log.blockNumber), ts,
    coin: a.token.toLowerCase(), trader: a.trader.toLowerCase(), side: a.isBuy ? "buy" : "sell", venue, ...u,
  };
}

export async function indexTrades(budgetMs = 20_000): Promise<{ indexed: number; cursor: string; latest: string; skipped?: string }> {
  const s = kv(), d = deployment();
  if (d.launchpad === ZERO) return { indexed: 0, cursor: "0", latest: "0", skipped: "not deployed" };
  if (!(await s.setNX("trades:lock", "1", 30))) return { indexed: 0, cursor: (await s.get("trades:cur")) ?? "", latest: "", skipped: "locked" };
  const t0 = Date.now();
  let n = 0;
  try {
    const pc = serverPc();
    const latest = await pc.getBlockNumber();
    const curRaw = await s.get("trades:cur");
    let cur = curRaw ? BigInt(curRaw) : d.fromBlock - BigInt(1);
    const hook = d.hook.toLowerCase();
    let chunk = CHUNK;
    while (cur < latest && Date.now() - t0 < budgetMs) {
      const from = cur + BigInt(1);
      const to = from + chunk - BigInt(1) > latest ? latest : from + chunk - BigInt(1);
      let logs: Log[];
      try {
        // topic0 = Trade (any emitter); emitter verified below.
        logs = (await pc.getLogs({ event: TRADE_EVENT, fromBlock: from, toBlock: to, strict: false } as never)) as Log[];
      } catch (e) {
        if (chunk > BigInt(50)) { chunk = chunk / BigInt(4); continue; } // RPC result/range cap: shrink and retry
        throw e;
      }
      const fills: Fill[] = [];
      for (const l of logs) {
        let dec: { args: Record<string, unknown> };
        try { dec = decodeEventLog({ abi: discipleHookAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as never; } catch { continue; }
        const a = dec.args as { token: string; trader: string; isBuy: boolean; tokenAmt: bigint; priceBeforeX18: bigint; priceAfterX18: bigint; mcapAfterUsd: bigint };
        const src = l.address.toLowerCase();
        const venue: Fill["venue"] | null = src === hook ? "hook" : (await curveOf(a.token.toLowerCase() as Address)) === src ? "curve" : null;
        if (!venue) continue; // spoofed Trade event from an unrelated contract
        const tx = l.transactionHash ?? "", li = l.logIndex ?? 0;
        if (!(await s.setNX(`trades:seen:${tx}:${li}`, "1"))) continue;
        fills.push(toFill({ transactionHash: tx, logIndex: li, blockNumber: l.blockNumber ?? BigInt(0) }, venue, a, await tsOf(l.blockNumber ?? BigInt(0))));
      }
      await storeFills(fills);
      n += fills.length;
      cur = to;
      await s.set("trades:cur", cur.toString());
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
