import "server-only";
/**
 * Plain transfers away (not trades) for streak and crew-mission XP, read from the achievements cron's per-(wallet, coin)
 * scan (lib/server/achievements transfersOut, key XPK.transfers). Vercel Security Review on PR #355: holds rebuilt
 * from fills alone kept paying after the tokens were sent to another wallet.
 *
 * Each transfer out becomes a sell for $0 (it leaves the position and drops its cost share). `verifiedTo` is the time
 * of the scan's cursor block: holds are only trusted up to it, so anything after the last scan pays nothing yet.
 * A missing or stale scan queues the wallet for the cron (ACH.dirty) so it catches up.
 */
import type { StreakFill } from "@/lib/streaks";
import { serverPc } from "./chat/identity";
import { ACH } from "./achKeys";
import { kv, type Kv } from "./kv";
import { XPK, type TransferOut } from "./xp";

export type VerifiedOuts = { outs: StreakFill[]; verifiedTo: number };

const blockTs = new Map<string, number>();
async function tsOf(block: string): Promise<number> {
  const hit = blockTs.get(block); if (hit !== undefined) return hit;
  const t = Number((await serverPc().getBlock({ blockNumber: BigInt(block) })).timestamp) * 1000;
  blockTs.set(block, t); return t;
}
const parse = <T,>(v: string | null): T | null => { if (!v) return null; try { return JSON.parse(v) as T; } catch { return null; } };

/** One wallet on one coin: its transfers out as $0 sells and how far the scan reaches (-Infinity: not scanned). */
export async function verifiedOuts(walletIn: string, coin: string, needTs: number, s: Kv = kv()): Promise<VerifiedOuts> {
  const w = walletIn.toLowerCase();
  const c = parse<{ cursor: string; outs: TransferOut[] }>(await s.get(XPK.transfers(w, coin)).catch(() => null));
  let verifiedTo = -Infinity;
  if (c?.cursor && /^\d+$/.test(c.cursor)) verifiedTo = await tsOf(c.cursor).catch(() => -Infinity);
  if (verifiedTo < needTs) await s.zadd(ACH.dirty(), [{ score: Date.now(), member: `${w}|hold-check` }]).catch(() => {});
  const outs = (c?.outs ?? []).filter((x) => x.tokens > 0).map((x): StreakFill => ({ ts: x.ts, block: x.block, logIndex: x.logIndex, side: "sell", tokens: x.tokens, usd: 0, out: true }));
  return { outs, verifiedTo };
}
