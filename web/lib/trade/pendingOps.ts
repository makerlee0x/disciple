/**
 * AUDIT (#141 review) — 'pending_unknown'. A receipt / relay timeout (mav2 receipt waits, the self-bundler's 20 s
 * receipt poll in lib/server/fastRelay, the client's short relay-timeout lookup) does NOT prove the trade failed: the
 * op can still land after it. So the trade layer:
 *  - answers ProtocolError("pending_unknown") with the op's ids / nonce (never a failure),
 *  - keeps the press's reservation HELD (Reservations.markUnknown: no TTL, release() refuses it),
 *  - never rebuilds or resends that press while it is unknown,
 *  - watches the op here, in the background, with backoff and a cap (2 min): a UserOperationEvent for its userOpHash
 *    (or the bundle tx receipt), or its nonce key advancing on the EntryPoint.
 * Outcomes: landed + success ⇒ the caller books the fill from the receipt logs and releases "filled"; landed + reverted,
 * nonce used by ANOTHER op, or the cap passed with the nonce not advanced ⇒ "error". The nonce advanced but the event
 * can't be found (outside the log window) ⇒ "landed" (it did execute): released "filled" with no logs, balances re-read.
 * Pure orchestration with injected lookups (tests drive it with fakes); chainWatchDeps() is the viem implementation.
 */
import { decodeEventLog, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { ENTRYPOINT_V07 } from "../aa/constants";
import type { UnknownOpRef } from "../aa/relayOp";
import type { Reservations } from "./reservations";

export type OpLog = { address: Address; data: Hex; topics: Hex[]; blockNumber?: Hex | bigint };
export type OpLanding = { userOpHash?: Hex; txHash: Hex; success: boolean; nonce?: bigint; logs: OpLog[] };
export type WatchDeps = {
  /** The op's UserOperationEvent (by userOpHash, or via the bundle tx receipt): null = not (yet) on-chain. */
  byHash: (op: UnknownOpRef) => Promise<OpLanding | null>;
  /** Has the op's nonce key advanced past `op.nonce` on the EntryPoint? undefined = can't tell (no nonce / RPC hiccup). */
  nonceUsed: (op: UnknownOpRef) => Promise<boolean | undefined>;
  /** The op that used `op.nonce` (UserOperationEvent by sender + nonce): its hash tells ours from another op. */
  byNonce?: (op: UnknownOpRef) => Promise<OpLanding | null>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
};
export type WatchOutcome =
  | { state: "filled"; landing: OpLanding }
  | { state: "reverted"; landing: OpLanding }
  | { state: "landed"; why: string }
  | { state: "dropped"; why: string };
export type WatchOpts = { capMs?: number; firstMs?: number; maxMs?: number; factor?: number };
/** Watch cap: after this with the nonce not advanced, the op is treated as dropped. */
export const WATCH_CAP_MS = 120_000;

const sleepReal = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const quiet = <T,>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

/** Poll until the op lands or is definitely dropped (backoff firstMs × factor^n, ≤ maxMs; cap capMs). Never throws. */
export async function watchUnknownOp(op: UnknownOpRef, deps: WatchDeps, o: WatchOpts = {}): Promise<WatchOutcome> {
  const clock = deps.clock ?? Date.now, sleep = deps.sleep ?? sleepReal;
  const cap = o.capMs ?? WATCH_CAP_MS, maxMs = o.maxMs ?? 15_000, factor = o.factor ?? 2;
  const t0 = clock();
  let delay = o.firstMs ?? 1_000, advanced = false;
  for (;;) {
    const hit = op.userOpHash || op.txHash ? await quiet(deps.byHash(op)) : undefined;
    if (hit) return { state: hit.success ? "filled" : "reverted", landing: hit };
    if (op.nonce !== undefined) {
      const used = await quiet(deps.nonceUsed(op));
      if (used) {
        advanced = true;
        // re-check ours first (it may have landed between the two reads), then who used the nonce
        const again = op.userOpHash || op.txHash ? await quiet(deps.byHash(op)) : undefined;
        if (again) return { state: again.success ? "filled" : "reverted", landing: again };
        const by = deps.byNonce ? await quiet(deps.byNonce(op)) : undefined;
        if (by) {
          if (!op.userOpHash || same(by.userOpHash, op.userOpHash)) return { state: by.success ? "filled" : "reverted", landing: by };
          return { state: "dropped", why: "nonce used by another op" };
        }
      }
    }
    if (clock() - t0 >= cap) return advanced ? { state: "landed", why: "nonce advanced, op event not found" } : { state: "dropped", why: "cap passed, nonce not advanced" };
    await sleep(Math.min(delay, Math.max(0, cap - (clock() - t0))));
    delay = Math.min(delay * factor, maxMs);
  }
}

export type UnknownHooks = {
  /** Book the fill from the receipt logs (as on a normal fill); returns amountOut for the "resolved" event. */
  book: (landing: OpLanding) => bigint | undefined;
  /** It executed but its logs can't be found: drop cached balances so the next read is live. */
  landedUnbooked?: () => void;
  /** Session-cap hold settlement (lib/aa/session): landed ⇒ count as spent, else refund. */
  settle?: (landed: boolean) => void;
  /** After any outcome (e.g. re-quote the route). */
  after?: (landing?: OpLanding) => void;
};
/**
 * Mark `id` pending_unknown in `reg` and settle it in the background when the watcher resolves. Returns the watch
 * promise (never rejects). The press stays held the whole time.
 */
export function holdUnknown(reg: Reservations, id: string, op: UnknownOpRef, deps: WatchDeps, hooks: UnknownHooks, o?: WatchOpts): Promise<WatchOutcome> {
  reg.markUnknown(id, { userOpHash: op.userOpHash, txHash: op.txHash, nonce: op.nonce });
  warn("trade pending (unknown): watching", { id, userOpHash: op.userOpHash, txHash: op.txHash, nonce: op.nonce?.toString() });
  return watchUnknownOp(op, deps, o).then((w) => {
    let amountOut: bigint | undefined, txHash: string | undefined;
    const landed = w.state === "filled" || w.state === "landed";
    try {
      if (w.state === "filled") { amountOut = hooks.book(w.landing); txHash = w.landing.txHash; }
      else if (w.state === "landed") hooks.landedUnbooked?.();
    } catch (e) { warn("late fill booking failed", { id, err: String(e) }); }
    try { hooks.settle?.(landed); } catch { /* */ }
    try { hooks.after?.("landing" in w ? w.landing : undefined); } catch { /* */ }
    warn(`trade pending resolved: ${w.state}`, { id, userOpHash: op.userOpHash, txHash: txHash ?? ("landing" in w ? w.landing.txHash : op.txHash), nonce: op.nonce?.toString(), why: "why" in w ? w.why : undefined });
    reg.resolveUnknown(id, landed ? "filled" : "error", { txHash, amountOut });
    return w;
  });
}
function warn(what: string, d: Record<string, unknown>) { if (typeof console !== "undefined") console.warn(`[disciple] ${what}`, d); }

/* ---------- viem lookups ---------- */
const uoEvent = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)"]);
const epAbi = parseAbi(["function getNonce(address sender, uint192 key) view returns (uint256 nonce)"]);
const LOOKBACK = BigInt(3_000);
type Pc = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getTransactionReceipt" | "readContract">;
const mapLogs = (logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], bn?: bigint): OpLog[] =>
  logs.map((l) => ({ address: l.address, data: l.data, topics: [...l.topics] as Hex[], ...(bn !== undefined ? { blockNumber: bn } : {}) }));

/** EntryPoint v0.7 lookups for the watcher (sender = the smart account). */
export function chainWatchDeps(pc: Pc, sender: Address, entryPoint: Address = ENTRYPOINT_V07): WatchDeps {
  async function landingOf(txHash: Hex, hash?: Hex, nonce?: bigint): Promise<OpLanding | null> {
    const rc = await pc.getTransactionReceipt({ hash: txHash }).catch(() => null);
    if (!rc) return null;
    for (const l of rc.logs) {
      if (l.address.toLowerCase() !== entryPoint.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: uoEvent, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (!same(ev.args.sender, sender)) continue;
        if (hash ? same(ev.args.userOpHash, hash) : nonce !== undefined && ev.args.nonce === nonce)
          return { userOpHash: ev.args.userOpHash, txHash: rc.transactionHash, success: ev.args.success, nonce: ev.args.nonce, logs: mapLogs(rc.logs as never, rc.blockNumber) };
      } catch { /* other event */ }
    }
    return null;
  }
  async function window() { const head = await pc.getBlockNumber(); return { fromBlock: head > LOOKBACK ? head - LOOKBACK : BigInt(0), toBlock: head }; }
  return {
    async byHash(op) {
      if (op.txHash) { const l = await landingOf(op.txHash, op.userOpHash, op.nonce); if (l) return l; }
      if (!op.userOpHash) return null;
      const ev = await pc.getLogs({ address: entryPoint, event: uoEvent[0], args: { userOpHash: op.userOpHash, sender }, ...(await window()) });
      const last = ev[ev.length - 1];
      return last?.transactionHash ? landingOf(last.transactionHash, op.userOpHash) : null;
    },
    async nonceUsed(op) {
      if (op.nonce === undefined) return undefined;
      const key = op.nonce >> BigInt(64);
      const cur = await pc.readContract({ address: entryPoint, abi: epAbi, functionName: "getNonce", args: [sender, key] });
      return cur > op.nonce;
    },
    async byNonce(op) {
      if (op.nonce === undefined) return null;
      const ev = await pc.getLogs({ address: entryPoint, event: uoEvent[0], args: { sender }, ...(await window()) });
      const m = ev.filter((e) => e.args.nonce === op.nonce).pop();
      return m?.transactionHash ? landingOf(m.transactionHash, m.args.userOpHash) : null;
    },
  };
}
