import "server-only";
/**
 * Server-emitted graduation lines from chain logs (unspoofable). Trades are NOT posted to chat (lee 2026-10-26 test 2:
 * "this is a chat bar, not a trade bar"); they live in the trade table, which reads fills, not chat.
 * Source (RH testnet 46630 via ACTIVE_CHAIN RPC): BondingCurve(curveOf(coin)) GraduatedToV4.
 * Vercel-friendly: no long-lived watcher. `catchUp(coin)` scans [cursor+1, latest] and is called
 *   (a) on demand from the SSE loop every ~3s while anyone is subscribed (guarded by a 10s store lock), and
 *   (b) by /api/chat/cron for recently active coins (backup; needs a Vercel cron or external pinger).
 * Dedupe: chat:seen:<tx>:<logIndex> SET NX (7d). First scan starts at latest-BACKFILL blocks (no deep backfill).
 */
import { decodeEventLog, type Address, type Hex, type Log } from "viem";
import { bondingCurveAbi, launchpadAbi } from "@/lib/abi";
import { deployment, ZERO } from "@/lib/chains";
import { chatStore } from "./store";
import { serverPc } from "./identity";
import { ulid } from "@/lib/chat/ulid";
import type { ChatMsg } from "@/lib/chat/types";

// First scan per coin looks back this many blocks (CHAT_BACKFILL_BLOCKS, default 300 ≈ a few minutes).
const BACKFILL = BigInt(Math.max(1, Number(process.env.CHAT_BACKFILL_BLOCKS) || 300));
const MAX_RANGE = BACKFILL > BigInt(5000) ? BACKFILL : BigInt(5000);
const curveCache = new Map<string, Address>();

async function curveOf(coin: Address): Promise<Address | null> {
  const hit = curveCache.get(coin); if (hit) return hit;
  const c = await serverPc().readContract({ address: deployment().launchpad, abi: launchpadAbi, functionName: "curveOf", args: [coin] }).catch(() => null);
  if (!c || c === ZERO) return null;
  curveCache.set(coin, c as Address); return c as Address;
}

/** GraduatedToV4 logs among a curve's logs, in chain order. */
function decodeGraduations(logs: Log[]): Log[] {
  const out: Log[] = [];
  for (const l of logs) {
    try { if (decodeEventLog({ abi: bondingCurveAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).eventName === "GraduatedToV4") out.push(l); } catch { /* other event */ }
  }
  return out.sort((x, y) => Number((x.blockNumber ?? BigInt(0)) - (y.blockNumber ?? BigInt(0))) || (x.logIndex ?? 0) - (y.logIndex ?? 0));
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
    const logs = await pc.getLogs({ address: curve, fromBlock: from, toBlock: latest });
    const evs = decodeGraduations(logs as Log[]);
    let n = 0;
    for (const l of evs) {
      const tx = l.transactionHash ?? "", li = l.logIndex ?? 0, blk = Number(l.blockNumber ?? 0);
      if (!(await st.setNX(`chat:seen:${tx}:${li}`, "1", 7 * 86400))) continue;
      const msg: ChatMsg = { id: ulid(), coin, kind: "event", from: null, ts: Date.now(), text: "ASCENDED to Uniswap v4 :rocket:", meta: { event: "graduate", tx, logIndex: li, block: blk } };
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
