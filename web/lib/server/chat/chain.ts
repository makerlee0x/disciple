import "server-only";
/**
 * Server-emitted trade/graduate lines from chain logs (unspoofable, covers every trader).
 * Sources (RH testnet 46630 via ACTIVE_CHAIN RPC):
 *   BondingCurve(curveOf(coin)): Trade (pre-grad), GraduatedToV4
 *   DiscipleHook: Trade filtered by indexed token (post-grad v4 swaps, any router)
 * Vercel-friendly: no long-lived watcher. `catchUp(coin)` scans [cursor+1, latest] and is called
 *   (a) on demand from the SSE loop every ~3s while anyone is subscribed (guarded by a 10s store lock), and
 *   (b) by /api/chat/cron for recently active coins (backup; needs a Vercel cron or external pinger).
 * Dedupe: chat:seen:<tx>:<logIndex> SET NX (7d). First scan starts at latest-BACKFILL blocks (no deep backfill).
 */
import { decodeEventLog, type Address, type Hex, type Log } from "viem";
import { bondingCurveAbi, discipleHookAbi, launchpadAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { chatStore } from "./store";
import { serverPc } from "./identity";
import { ulid } from "@/lib/chat/ulid";
import type { ChatMsg } from "@/lib/chat/types";

// First scan per coin looks back this many blocks (CHAT_BACKFILL_BLOCKS, default 300 ≈ a few minutes).
const BACKFILL = BigInt(Math.max(1, Number(process.env.CHAT_BACKFILL_BLOCKS) || 300));
const MAX_RANGE = BACKFILL > BigInt(5000) ? BACKFILL : BigInt(5000);
const curveCache = new Map<string, Address>();
const qpCache = new Map<string, { v: bigint; at: number }>();
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmtUsd = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(v >= 10 ? 0 : 2)}`);

async function curveOf(coin: Address): Promise<Address | null> {
  const hit = curveCache.get(coin); if (hit) return hit;
  const c = await serverPc().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [coin] }).catch(() => null);
  if (!c || c === ZERO) return null;
  curveCache.set(coin, c as Address); return c as Address;
}
async function quotePrice(curve: Address): Promise<bigint> {
  const hit = qpCache.get(curve); if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = await serverPc().readContract({ address: curve, abi: bondingCurveAbi, functionName: "quotePriceUsd" }).catch(() => BigInt(0));
  qpCache.set(curve, { v: v as bigint, at: Date.now() }); return v as bigint;
}

/** Pure: decoded Trade args → chat event message (exported for tests). */
export function tradeMsg(coin: string, a: { trader: string; isBuy: boolean; quoteAmt: bigint; impactBps: bigint | number }, qp: bigint, tx: string, logIndex: number, block: number, now = Date.now()): ChatMsg {
  const usd = Number((a.quoteAmt * qp) / BigInt(1e18)) / 1e18;
  const bps = Number(a.impactBps) * (a.isBuy ? 1 : -1);
  const side = a.isBuy ? "buy" : "sell";
  const pct = `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
  return {
    id: ulid(now), coin, kind: "event", from: { addr: a.trader.toLowerCase() }, ts: now,
    text: `${short(a.trader)} ${a.isBuy ? "bought" : "sold"} ${fmtUsd(usd)} (${pct})`,
    meta: { event: side, usd, tx, impactBps: bps, logIndex, block },
  };
}

type Decoded = { log: Log; eventName: string; args: Record<string, unknown> };
function decode(abi: typeof bondingCurveAbi | typeof discipleHookAbi, logs: Log[]): Decoded[] {
  const out: Decoded[] = [];
  for (const l of logs) {
    try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); out.push({ log: l, eventName: d.eventName as string, args: (d.args ?? {}) as Record<string, unknown> }); } catch { /* other event */ }
  }
  return out;
}

export async function catchUp(coinIn: string): Promise<number> {
  const coin = coinIn.toLowerCase() as Address;
  const st = chatStore();
  if (!(await st.setNX(`chat:lock:${coin}`, "1", 10))) return 0;
  try {
    const pc = serverPc();
    const curve = await curveOf(coin);
    if (!curve) return 0;
    const latest = await pc.getBlockNumber();
    const curRaw = await st.get(`chat:cur:${coin}`);
    let from = curRaw ? BigInt(curRaw) + BigInt(1) : latest - BACKFILL;
    if (from > latest) return 0;
    if (latest - from > MAX_RANGE) from = latest - MAX_RANGE;
    const hook = deployment().hook;
    const [cLogs, hLogs] = await Promise.all([
      pc.getLogs({ address: curve, fromBlock: from, toBlock: latest }),
      hook !== ZERO
        ? pc.getContractEvents({ address: hook, abi: discipleHookAbi, eventName: "Trade", args: { token: coin }, fromBlock: from, toBlock: latest }).catch(() => [] as Log[])
        : Promise.resolve([] as Log[]),
    ]);
    const evs = [...decode(bondingCurveAbi, cLogs as Log[]), ...decode(discipleHookAbi, hLogs as Log[])]
      .filter((d) => d.eventName === "Trade" || d.eventName === "GraduatedToV4")
      .sort((x, y) => Number((x.log.blockNumber ?? BigInt(0)) - (y.log.blockNumber ?? BigInt(0))) || (x.log.logIndex ?? 0) - (y.log.logIndex ?? 0));
    const qp = evs.length ? await quotePrice(curve) : BigInt(0);
    let n = 0;
    for (const d of evs) {
      const tx = d.log.transactionHash ?? "", li = d.log.logIndex ?? 0, blk = Number(d.log.blockNumber ?? 0);
      if (d.eventName === "Trade" && String(d.args.token).toLowerCase() !== coin) continue;
      if (!(await st.setNX(`chat:seen:${tx}:${li}`, "1", 7 * 86400))) continue;
      const msg: ChatMsg = d.eventName === "Trade"
        ? tradeMsg(coin, d.args as never, qp, tx, li, blk)
        : { id: ulid(), coin, kind: "event", from: null, ts: Date.now(), text: "GRADUATED to Uniswap v4 :rocket:", meta: { event: "graduate", tx, logIndex: li, block: blk } };
      await st.append(coin, msg); n++;
    }
    await st.set(`chat:cur:${coin}`, latest.toString());
    return n;
  } catch (e) {
    console.warn("[chat] catchUp failed", coin, (e as Error).message);
    return 0;
  } finally {
    await st.del(`chat:lock:${coin}`).catch(() => {});
  }
}
