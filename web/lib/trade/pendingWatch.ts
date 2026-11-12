/**
 * SITE watcher for a press whose op was SENT but whose outcome is unknown (relay timeout, lost answer, a dropped
 * connection after the send). Before this, main had GAME's 'pending_unknown' plumbing (lib/flight/reservationsShim
 * markUnknown / resolveUnknown, TradeBridge pendingUnknown) but nothing ever called it: a timed-out press was shown as
 * "That didn't go through", its reservation was released, and the op landed a few seconds later (lee's Oct 26 prod
 * test: "didn't go through" + fills anyway, sells sized from cash/tokens that were still being spent).
 *
 * Now: keep the press held (markUnknown), look the op up on-chain by its userOpHash (EntryPoint UserOperationEvent)
 * and settle it (resolveUnknown filled | error). NEVER resends anything. Pure-ish: the reads are injected for tests.
 */
import type { Address, Hex, PublicClient } from "viem";
import { parseAbiItem } from "viem";
import { RESERVATIONS } from "@/lib/trade/reservations";

const ENTRYPOINT_V07: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const UOE = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)");

export type PendingIds = { userOpHash?: string; txHash?: string; sender?: string; nonce?: bigint };
export type Found = { success: boolean; txHash: string } | null;
/** Ids an AAError / ProtocolError carries for a sent op (extra.userOpHash / txHash / sender / nonce). */
export function pendingIds(e: unknown): PendingIds {
  const x = (e as { extra?: Record<string, unknown> } | null)?.extra ?? {};
  const s = (k: string) => (typeof x[k] === "string" ? (x[k] as string) : undefined);
  return { userOpHash: s("userOpHash"), txHash: s("txHash"), sender: s("sender"), nonce: typeof x.nonce === "bigint" ? x.nonce : undefined };
}
/** Was this error thrown AFTER the op was sent with an unknown outcome? (AA / protocol code "Timeout" = sent, not confirmed.) */
export const isSentUnknown = (e: unknown) => (e as { code?: unknown } | null)?.code === "Timeout";

/** One on-chain lookup: the op's UserOperationEvent in the last ~600 blocks (≈ 100 s on RH testnet). */
export async function lookupOp(pc: PublicClient, ids: PendingIds): Promise<Found> {
  if (!ids.userOpHash) return null;
  const head = await pc.getBlockNumber();
  const ev = await pc.getLogs({ address: ENTRYPOINT_V07, event: UOE, args: { userOpHash: ids.userOpHash as Hex }, fromBlock: head > BigInt(600) ? head - BigInt(600) : BigInt(0), toBlock: head });
  const l = ev[ev.length - 1];
  return l ? { success: !!l.args.success, txHash: l.transactionHash as string } : null;
}

export const WATCH_MS = 120_000, WATCH_EVERY_MS = 1500;
/**
 * Hold `pressId` as unknown and settle it from the chain. Returns the outcome ("filled" | "error"); "error" also when the op
 * never shows up within WATCH_MS (dropped). Without a userOpHash it can't look anything up: the hold then ends on the
 * registry TTL like before (returns "gone" right away; balances re-read by the caller).
 */
export async function watchPending(pressId: string, ids: PendingIds, o: {
  lookup: (ids: PendingIds) => Promise<Found>; reg?: Pick<typeof RESERVATIONS, "markUnknown" | "resolveUnknown" | "has">;
  waitMs?: number; everyMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
}): Promise<"filled" | "error" | "gone"> {
  const reg = o.reg ?? RESERVATIONS, now = o.now ?? Date.now, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!ids.userOpHash || !reg.has(pressId)) return "gone";
  reg.markUnknown(pressId, { userOpHash: ids.userOpHash, txHash: ids.txHash, nonce: ids.nonce });
  const until = now() + (o.waitMs ?? WATCH_MS);
  for (;;) {
    let f: Found = null;
    try { f = await o.lookup(ids); } catch (e) { console.warn("[disciple] pending trade lookup failed, retrying", { pressId, message: String((e as Error)?.message ?? e).slice(0, 160) }); }
    if (f) {
      const out = f.success ? "filled" : "error";
      console.warn(`[disciple] pending trade settled: ${out}`, { pressId, userOpHash: ids.userOpHash, txHash: f.txHash });
      reg.resolveUnknown(pressId, out, { txHash: f.txHash });
      return out;
    }
    if (now() > until) {
      console.warn("[disciple] pending trade not found on-chain in time: treated as not sent", { pressId, userOpHash: ids.userOpHash });
      reg.resolveUnknown(pressId, "error");
      return "error";
    }
    await sleep(o.everyMs ?? WATCH_EVERY_MS);
  }
}
