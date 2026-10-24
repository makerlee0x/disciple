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

export class RelayerNonceCursor {
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
}

/**
 * Take a nonce, send, apply the rules above. `send` must sign with the given nonce and either resolve (accepted or
 * pending on the same txHash) or throw. Unclear errors are rethrown untouched (caller waits on its txHash; NO re-sign).
 */
export async function sendWithCursor<T>(cursor: RelayerNonceCursor, send: (nonce: number) => Promise<T>, retries = 2, canSign?: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const nonce = await cursor.take();
    // pool lease lapsed (AUDIT Info): another instance may own this EOA now ⇒ never sign; nothing was sent
    if (canSign && !canSign()) { cursor.invalidate(); throw Object.assign(new Error("relayer lease lost before signing"), { definitive: true }); }
    try { return await send(nonce); }
    catch (e) {
      const k = classifySendError(e);
      if (k === "nonce") { if (attempt < retries) { await cursor.resync(); continue; } cursor.invalidate(); throw e; }
      if (k === "definitive") cursor.release(nonce);
      throw e;   // unclear: the cursor stays advanced, never re-signed
    }
  }
}
