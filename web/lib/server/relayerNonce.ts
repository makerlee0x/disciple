/**
 * Relayer EOA nonce cursor + send classification (feat/rapid-tap, FLOW). Pure (no server-only, no RPC): the pending
 * count is injected, so scripts/test-relayer-nonce.mts covers every branch.
 *
 * One cursor per relayer key per process. Concurrent sends take consecutive nonces synchronously after warm-up (no
 * getTransactionCount per op). Rules for what happens to a taken nonce when its send fails:
 *  - definite NONCE rejection (too low / too high / already used / replacement underpriced): the tx was not accepted
 *    ⇒ resync from the pending count and re-sign (bounded retries). "nonce too high" is a resync trigger: it means a
 *    lower nonce we handed out never landed (a gap).
 *  - definitive NON-nonce rejection — an ALLOWLIST only (AUDIT L2): insufficient funds, intrinsic gas too low, fee cap
 *    below base fee / underpriced, exceeds block gas limit, oversized / malformed / bad signature / unsupported tx
 *    type, JSON-RPC -32602 / -32601 (params / method rejected at parse), or a local signing failure before any send.
 *    The tx was not accepted ⇒ RELEASE the nonce: roll the cursor back when no later nonce was handed out
 *    (next === n + 1), else resync from the pending count on the next take.
 *  - UNCLEAR = EVERYTHING ELSE (already known, timeout, network, unreadable, -32603 internal error, -32000 context
 *    canceled, any unknown code or message, receipt wait timed out): the tx may be in ⇒ never re-sign, never release;
 *    the caller waits on / looks up the SAME txHash. The cursor stays advanced (the nonce stays reserved): if the tx
 *    really was lost, the next send sees "nonce too high" and resyncs.
 *
 * Cross-instance (fix/relayer-nonce-source): a per-process cursor is only safe for ONE writer. The single relayer EOA
 * is written by every Vercel instance (fast path, self-bundler, drip/test-cash when faucet == relayer, the poke-pricer
 * cron, the pve attest relay), so two instances that each read pending = N both sign N ⇒ "nonce too low" for the loser
 * (and stale pending reads from a lagging RPC node burn every resync). SharedNonceCursor below hands nonces out from ONE
 * atomic KV counter (lib/server/kv.nonceAlloc) seeded with max(counter, chain pending, the node's "state: N" hint).
 */

export type SendClass = "nonce" | "unclear" | "definitive";

const msgOf = (e: unknown): string => {
  const parts: string[] = [];
  for (let x = e as { message?: unknown; details?: unknown; shortMessage?: unknown; cause?: unknown } | undefined, i = 0; x && i < 6; x = x.cause as typeof x, i++) {
    for (const k of ["message", "details", "shortMessage"] as const) if (typeof x[k] === "string") parts.push(x[k] as string);
  }
  return parts.length ? parts.join(" | ") : String(e);
};
/** First numeric JSON-RPC code on the error or its cause chain (viem wraps node errors). */
const codeOf = (e: unknown): number | undefined => {
  for (let x = e as { code?: unknown; cause?: unknown } | undefined, i = 0; x && i < 6; x = x.cause as typeof x, i++) if (typeof x.code === "number") return x.code;
  return undefined;
};

/** Node said "this nonce is wrong" ⇒ not accepted, safe to resync + re-sign. Never matches "already known". */
export const DEFINITE_NONCE = /nonce (provided for the transaction is lower|too low|too high|has already been used)|invalid nonce|nonce gap|replacement transaction underpriced/i;
export const ALREADY_KNOWN = /already known|known transaction|already imported/i;
/**
 * AUDIT L2: the ONLY non-nonce node answers that mean "this tx was never accepted". Anything not listed is UNCLEAR.
 * (geth / op-geth / reth wording; viem keeps the node text in `details` / the cause chain, which msgOf reads.)
 */
export const DEFINITE_REJECT = /insufficient funds|intrinsic gas too low|fee cap (less than|lower than|too low)|max fee per gas less than block base fee|maxFeePerGas less than|transaction underpriced|exceeds block gas limit|oversized data|invalid sender|invalid signature|transaction type not supported|tx type not supported|rlp: |invalid transaction v, r, s/i;
/** JSON-RPC: params rejected at parse / method missing — nothing was accepted. */
export const NOT_ACCEPTED_CODES = new Set([-32602, -32601]);

export function classifySendError(e: unknown): SendClass {
  const m = msgOf(e), code = codeOf(e);
  const flags = e as { unclear?: unknown; pending?: unknown; definitive?: unknown } | undefined;
  if (ALREADY_KNOWN.test(m)) return "unclear";          // checked first: "already known" is NOT a nonce error
  if (flags?.unclear || flags?.pending) return "unclear";
  if (code === 6 || DEFINITE_NONCE.test(m)) return "nonce";
  // `definitive` is only ever set for an allowlisted rejection (syncSend / plainSend) or a local signing failure
  if (flags?.definitive) return "definitive";
  if ((code !== undefined && NOT_ACCEPTED_CODES.has(code)) || DEFINITE_REJECT.test(m)) return "definitive";
  return "unclear";   // allowlist: -32603 / -32000 / unknown code / timeout / network / no answer ⇒ may be in
}

/**
 * The chain's next nonce when the node said it: geth / nitro "nonce too low: address 0x…, tx: 18730 state: 18732",
 * newer geth "nonce too low: next nonce 18732, tx nonce 18730". Lets a resync skip a lagging pending read.
 */
export function chainNonceHint(e: unknown): number | undefined {
  const m = /state:?\s*(\d+)|next nonce:?\s*(\d+)/i.exec(msgOf(e));
  if (!m) return undefined;
  const n = Number(m[1] ?? m[2]);
  return Number.isSafeInteger(n) ? n : undefined;
}
const TOO_HIGH = /nonce too high|nonce gap/i;

/** What sendWithCursor needs from a cursor (per-process RelayerNonceCursor or the cross-instance SharedNonceCursor). */
export interface NonceCursor {
  take(): Promise<number>;
  warm(): Promise<void>;
  invalidate(): void;
  release(n: number): unknown;
  /**
   * After a definite nonce rejection of `n`. Resolves to the nonce the retry must sign with (undefined ⇒ take a fresh
   * one). `final` ⇒ no retry follows (clean up only).
   */
  recover(e: unknown, n: number, final: boolean): Promise<number | undefined>;
}

export class RelayerNonceCursor implements NonceCursor {
  private next: number | undefined;
  private sync: Promise<number> | undefined;
  /** counters for tests / logs */
  readonly stats = { resyncs: 0, rollbacks: 0, releasesBehind: 0 };
  constructor(private pendingCount: () => Promise<number>) {}

  get peek(): number | undefined { return this.next; }
  /** Drop the local view and read the pending count (deduped across concurrent callers). */
  resync(): Promise<number> {
    this.next = undefined;
    this.stats.resyncs++;
    return (this.sync ??= this.pendingCount().then((n) => { this.next = n; return n; }).finally(() => { this.sync = undefined; }));
  }
  /** Warm-up: sync only when there's no local view yet. */
  async warm(): Promise<void> { if (this.next === undefined) await (this.sync ?? this.resync()); }
  /** Synchronous after warm-up: concurrent takers get consecutive nonces with no RPC. */
  async take(): Promise<number> {
    while (this.next === undefined) await (this.sync ?? this.resync());
    return this.next++;
  }
  /** Forget the local view: the next take resyncs from the pending count. */
  invalidate(): void { this.next = undefined; }
  /**
   * Nonce `n` was taken but its tx was definitively NOT accepted (non-nonce rejection). Roll back when nothing later was
   * handed out; otherwise force a resync on the next take (never hand out n twice while later nonces are in flight).
   */
  release(n: number): "rollback" | "resync" {
    if (this.next === n + 1) { this.next = n; this.stats.rollbacks++; return "rollback"; }
    this.next = undefined; this.stats.releasesBehind++;
    return "resync";
  }
  /** Resync from pending; a higher "state: N" from the node wins over a lagging pending read. */
  async recover(e: unknown, _n: number, final: boolean): Promise<undefined> {
    if (final) return undefined;
    const p = await this.resync(), hint = chainNonceHint(e);
    if (hint !== undefined && hint > p && this.next !== undefined && this.next < hint) this.next = hint;
    return undefined;
  }
}

/** The atomic KV ops SharedNonceCursor needs (lib/server/kv in production; in-memory in tests). */
export interface NonceStore {
  alloc(floor: number): Promise<number>;
  /** n handed out but never accepted (see Kv.nonceRelease): 1 rolled back, 2 kept as a hole for the next alloc, 0 no-op */
  release(n: number): Promise<number>;
  /** SET NX with a TTL: one instance wins a one-off job (filling a gap). */
  claim(tag: string, ttlSec: number): Promise<boolean>;
}
export type SharedCursorOpts = { kvTimeoutMs?: number; floorMaxAgeMs?: number; degradedMs?: number; gapWaitMs?: number; sleep?: (ms: number) => Promise<unknown>; now?: () => number; log?: (m: string) => void };

/**
 * Cross-instance cursor for ONE relayer EOA: every take is one atomic KV alloc (max(counter, floor) or a released hole),
 * so concurrent requests on any number of instances never share a nonce. `floor` = the highest chain nonce this instance
 * has seen (pending count, refreshed in the background every floorMaxAgeMs, or a node "state: N" hint) — it pulls the
 * counter forward past txs from writers outside the allocator, and after the counter's TTL lapses.
 *
 * Failure rules on top of sendWithCursor's:
 *  - nonce too low / already used / replacement underpriced (the node's state is ahead): floor = max(floor, hint,
 *    pending), take a FRESH nonce (n was used by someone else: it's not ours to reuse).
 *  - nonce too high (a lower nonce never landed): retry the SAME n after gapWaitMs (an in-flight lower nonce from another
 *    instance usually lands meanwhile). On the last attempt the gap is treated as lost: n goes back to the store, and the
 *    node's next nonce (hint) is released as a hole by ONE instance (claim) so the next alloc fills it — otherwise one lost
 *    unclear tx would wedge the shared counter for good.
 *  - definitive non-nonce rejection: release(n) (rollback or hole), same as the local cursor.
 *  - KV unreachable / slower than kvTimeoutMs: fall back to the per-process cursor for degradedMs (old behaviour, logged).
 */
export class SharedNonceCursor implements NonceCursor {
  private floor = 0;
  private floorAt = 0;
  private sync: Promise<number> | undefined;
  private degradedUntil = 0;
  private readonly local: RelayerNonceCursor;
  private readonly o: Required<SharedCursorOpts>;
  readonly stats = { allocs: 0, fallbacks: 0, holes: 0, gapFills: 0, resyncs: 0 };
  constructor(private store: NonceStore, private pendingCount: () => Promise<number>, opts: SharedCursorOpts = {}) {
    this.local = new RelayerNonceCursor(pendingCount);
    this.o = { kvTimeoutMs: 1500, floorMaxAgeMs: 30_000, degradedMs: 30_000, gapWaitMs: 250, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, log: (m) => console.warn(m), ...opts };
  }
  get peekFloor(): number { return this.floor; }
  private refresh(): Promise<number> {
    this.stats.resyncs++;
    return (this.sync ??= this.pendingCount().then((n) => { this.floor = Math.max(this.floor, n); this.floorAt = this.o.now(); return this.floor; }).finally(() => { this.sync = undefined; }));
  }
  private kvOp<T>(p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("kv timeout")), this.o.kvTimeoutMs); })]).finally(() => clearTimeout(t));
  }
  private degraded(): boolean { return this.o.now() < this.degradedUntil; }
  async warm(): Promise<void> { if (!this.floorAt) await (this.sync ?? this.refresh()); }
  async take(): Promise<number> {
    if (this.degraded()) return this.local.take();
    if (!this.floorAt) await (this.sync ?? this.refresh());
    else if (this.o.now() - this.floorAt > this.o.floorMaxAgeMs) void this.refresh().catch(() => undefined);   // off the hot path
    try { const n = await this.kvOp(this.store.alloc(this.floor)); this.stats.allocs++; return n; }
    catch (e) {
      this.stats.fallbacks++; this.degradedUntil = this.o.now() + this.o.degradedMs; this.local.invalidate();
      this.o.log(`[relayer-nonce] shared allocator unavailable (${(e as Error).message}); per-instance cursor for ${this.o.degradedMs} ms`);
      return this.local.take();
    }
  }
  invalidate(): void { this.floorAt = 0; this.local.invalidate(); }
  release(n: number): void {
    if (this.degraded()) { this.local.release(n); return; }
    void this.kvOp(this.store.release(n)).then((r) => { if (r === 2) this.stats.holes++; }).catch(() => this.local.invalidate());
  }
  async recover(e: unknown, n: number, final: boolean): Promise<number | undefined> {
    if (this.degraded()) return this.local.recover(e, n, final);
    const hint = chainNonceHint(e);
    if (TOO_HIGH.test(msgOf(e)) && (hint === undefined || hint < n)) {
      if (!final) { await this.o.sleep(this.o.gapWaitMs); return n; }   // same nonce: an in-flight lower one may land
      // the gap is lost: give n back and let ONE instance turn the node's next nonce into a hole the next alloc fills
      await this.kvOp(this.store.release(n)).catch(() => 0);
      if (hint !== undefined && (await this.kvOp(this.store.claim(`gap:${hint}`, 30)).catch(() => false))) {
        if ((await this.kvOp(this.store.release(hint)).catch(() => 0)) === 2) this.stats.gapFills++;
      }
      return undefined;
    }
    if (hint !== undefined) this.floor = Math.max(this.floor, hint);
    if (!final) await this.refresh().catch(() => undefined);
    return undefined;
  }
}

/**
 * Take a nonce, send, apply the rules above. `send` must sign with the given nonce and either resolve (accepted or
 * pending on the same txHash) or throw. Unclear errors are rethrown untouched (caller waits on its txHash; NO re-sign).
 */
export async function sendWithCursor<T>(cursor: NonceCursor, send: (nonce: number) => Promise<T>, retries = 2, canSign?: () => boolean): Promise<T> {
  let forced: number | undefined;
  for (let attempt = 0; ; attempt++) {
    const nonce = forced ?? await cursor.take();
    forced = undefined;
    // pool lease lapsed (AUDIT Info): another instance may own this EOA now ⇒ never sign; nothing was sent
    if (canSign && !canSign()) { cursor.invalidate(); throw Object.assign(new Error("relayer lease lost before signing"), { definitive: true }); }
    try { return await send(nonce); }
    catch (e) {
      const k = classifySendError(e);
      if (k === "nonce") {
        if (attempt < retries) { forced = await cursor.recover(e, nonce, false); continue; }
        await cursor.recover(e, nonce, true); cursor.invalidate(); throw e;
      }
      if (k === "definitive") cursor.release(nonce);
      throw e;   // unclear: the cursor stays advanced, never re-signed
    }
  }
}
