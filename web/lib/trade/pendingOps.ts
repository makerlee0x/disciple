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
import { unknownOpOf, type UnknownOpRef } from "../aa/relayOp";
import type { Reservations } from "./reservations";
import type { RelayUnclearReason } from "../aa/relayTypes";

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
/* ---------- FLOW #141: 'unclear' relay errors ⇒ pending_unknown ---------- */
// FLOW #141 landed on main: the reason union is relayTypes' own (was a local mirror)
export type RelayUnclearReasonLike = RelayUnclearReason;
// mirrors RelayErrorData from FLOW #141 (lib/aa/relayTypes.ts); swap to import at rebase
// relayNonce = the RELAYER EOA nonce of the handleOps tx; `nonce` (bigint) is only on RelayTimeoutExtra: the op's EntryPoint nonce
export type RelayErrorDataLike = { txHash?: Hex; userOpHash?: Hex; revert?: Hex; relayNonce?: number; unclear?: true; reason?: RelayUnclearReasonLike };
// mirrors RelayTimeoutExtra from FLOW #141 (= RelayUnclearInfo & { userOpHash, sender, nonce?: bigint }); swap to import at rebase
export type RelayTimeoutExtraLike = RelayErrorDataLike & { sender?: string; nonce?: bigint };
export type RelayUnclear = { reason: RelayUnclearReasonLike; userOpHash?: Hex; txHash?: Hex; relayNonce?: number };
const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const hash32 = (v: unknown) => (typeof v === "string" && HASH32.test(v) ? (v as Hex) : undefined);

/**
 * FLOW #141's rule: `err.code === "Timeout" && err.extra?.unclear === true` ⇒ the outcome is unknown (the tx may still
 * land). Works on an AAError from mav2 and on a ProtocolError from protocol-viem (#141 gives it .extra). null otherwise
 * (a definite revert carries txHash / nonce but no unclear flag).
 */
export function relayUnclearOf(e: unknown): RelayUnclear | null {
  const x = e as { code?: unknown; extra?: unknown } | null;
  if (!x || typeof x !== "object" || x.code !== "Timeout") return null;
  const ex = x.extra as (RelayTimeoutExtraLike & Record<string, unknown>) | undefined;
  if (!ex || typeof ex !== "object" || ex.unclear !== true) return null;
  const reason: RelayUnclearReasonLike = ex.reason === "stream-lost" || ex.reason === "network" ? ex.reason : "receipt-timeout";
  const relayNonce = typeof ex.relayNonce === "number" && Number.isSafeInteger(ex.relayNonce) && ex.relayNonce >= 0 ? ex.relayNonce : undefined;
  return { reason, userOpHash: hash32(ex.userOpHash), txHash: hash32(ex.txHash), ...(relayNonce !== undefined ? { relayNonce } : {}) };
}

/** A send error whose op may still land: the ids to watch, plus FLOW's unclear reason / relayer nonce when flagged. */
export type PendingSend = UnknownOpRef & { unclear?: true; reason?: RelayUnclearReasonLike; relayNonce?: number };
/**
 * unclear-flagged timeouts (FLOW #141) and plain timeouts (today's mav2, no flag) alike; a definite answer (revert, no
 * flag) is null. Same decision as unknownOpOf, so lib/aa/session's held session spend always gets settled by the watcher.
 */
export function pendingOpOf(e: unknown): PendingSend | null {
  const op = unknownOpOf(e);
  if (!op) return null;
  const u = relayUnclearOf(e);
  if (!u) return op;
  return { ...op, userOpHash: op.userOpHash ?? u.userOpHash, txHash: op.txHash ?? u.txHash, unclear: true, reason: u.reason, ...(u.relayNonce !== undefined ? { relayNonce: u.relayNonce } : {}) };
}

/** The ids GAME gets on ProtocolError("pending_unknown").op (structurally protocol-viem's PendingOpRef). */
export type PendingOpIds = { reservationId: string; userOpHash?: string; txHash?: string; nonce?: bigint; relayNonce?: number };
/**
 * Trade layer: a send error ⇒ pending_unknown? If so, keep press `id` held (markUnknown) and start the watcher (cap
 * 2 min, never resends); returns the op ids for ProtocolError("pending_unknown"). null ⇒ a normal error (the caller
 * releases the hold as usual). `known` = ids the caller already had, used where the error carries none. Reason / ids go
 * to console.warn("[disciple] …") only, never into player copy.
 */
export function startPendingOp(reg: Reservations, id: string, e: unknown, deps: (sender?: string) => WatchDeps, hooks: UnknownHooks,
  known: { userOpHash?: Hex; txHash?: Hex; nonce?: bigint } = {}, o?: WatchOpts): { op: PendingOpIds; watch: Promise<WatchOutcome> | null; unclear?: PendingSend } | null {
  const p = pendingOpOf(e);
  if (!p) return null;
  const ref: UnknownOpRef = { userOpHash: p.userOpHash ?? known.userOpHash, txHash: p.txHash ?? known.txHash, nonce: p.nonce ?? known.nonce, sender: p.sender };
  if (p.unclear) warn(`trade pending (unclear relay outcome: ${p.reason})`, { id, reason: p.reason, userOpHash: ref.userOpHash, txHash: ref.txHash, relayNonce: p.relayNonce, nonce: ref.nonce?.toString() });
  const op: PendingOpIds = { reservationId: id, userOpHash: ref.userOpHash, txHash: ref.txHash, nonce: ref.nonce, ...(p.relayNonce !== undefined ? { relayNonce: p.relayNonce } : {}) };
  const res = { op, ...(p.unclear ? { unclear: p } : {}) };
  return { ...res, watch: watchOrKeep(reg, id, ref, deps(p.sender), hooks, o) };
}
/** Nothing to look up on-chain? */
const noIds = (op: { userOpHash?: string; txHash?: string; nonce?: bigint }) => !op.userOpHash && !op.txHash && op.nonce === undefined;
/**
 * Mark unknown + watch, or, when the op has NO ids (e.g. mav2's standard-path sendUserOperation timeout), keep the normal
 * hold: nothing to watch, so it is not marked unknown and the 60 s TTL ends it; the session-spend hold is re-synced from
 * the chain when the TTL passes (settle(false) ⇒ re-read, never resend). Returns the watch, or null when only held.
 */
function watchOrKeep(reg: Reservations, id: string, ref: UnknownOpRef, deps: WatchDeps, hooks: UnknownHooks, o?: WatchOpts): Promise<WatchOutcome> | null {
  if (!noIds(ref)) return holdUnknown(reg, id, ref, deps, hooks, o);
  warn("trade pending (no op ids): held until the reservation TTL, not watched", { id });
  if (hooks.settle && typeof setTimeout !== "undefined") { const t = setTimeout(() => { try { hooks.settle!(false); } catch { /* */ } }, reg.ttlMs); (t as { unref?: () => void }).unref?.(); }
  return null;
}
/**
 * Backstop for a press that came back pending_unknown WITHOUT being marked (the error was mapped outside sendTrade, e.g.
 * by friendlyError): mark it unknown and watch it, so it is never released as 'timeout' and still gets its "resolved"
 * event. No-op (null) when the press isn't held or is already unknown (sendTrade's watcher owns it).
 */
export function holdLate(reg: Reservations, id: string, op: { userOpHash?: string; txHash?: string; nonce?: bigint } | undefined, deps: WatchDeps, hooks: UnknownHooks, o?: WatchOpts): Promise<WatchOutcome> | null {
  if (!reg.has(id) || reg.isUnknown(id)) return null;
  return watchOrKeep(reg, id, { userOpHash: hash32(op?.userOpHash), txHash: hash32(op?.txHash), nonce: op?.nonce }, deps, hooks, o);
}
/** WatchDeps whose sender is resolved later (the trade layer's catch has no account in scope). */
export function lazyWatchDeps(make: Promise<WatchDeps | null>): WatchDeps {
  return {
    byHash: async (op) => (await make)?.byHash(op) ?? null,
    nonceUsed: async (op) => (await make)?.nonceUsed(op),
    byNonce: async (op) => (await make)?.byNonce?.(op) ?? null,
  };
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
