/**
 * Post-trade read floor (SITE #140). The relay gets our receipt straight from the RH sequencer
 * (eth_sendRawTransactionSync, ~160 ms send → receipt), but the public RPC behind the same URL can serve that block
 * 0.6–0.8 s later. A quote / balance read sent at "latest" right after our own fill can therefore describe the
 * PRE-trade state (stale minOut, "no tokens" on the next sell).
 *
 * Fix: after our own receipt we raise a floor to the receipt's block for a short window. While it is up, every
 * state read through the app's public client (eth_call / eth_getBalance / eth_getCode at "latest") is pinned to
 * the receipt block instead of "latest". A node that doesn't have that block yet answers "header not found"
 * (or similar); we retry briefly (every ~80 ms, ≤ ~1.6 s), so a read either reflects the trade or fails — it never returns
 * pre-trade state. Outside the window reads go to "latest" untouched.
 */
import { custom, toHex, type EIP1193RequestFn, type Hex, type Transport } from "viem";

export type ReceiptLog = { blockNumber?: Hex | bigint | number | string | null };
/** Highest block number carried by a receipt's logs (raw RPC hex or viem bigint); undefined when none carry one. */
export function receiptBlock(logs: readonly unknown[] | undefined | null): bigint | undefined {
  let best: bigint | undefined;
  for (const l of logs ?? []) {
    const v = (l as ReceiptLog | null)?.blockNumber;
    if (v === undefined || v === null || v === "") continue;
    try { const b = BigInt(v as string | number | bigint); if (best === undefined || b > best) best = b; } catch { /* malformed */ }
  }
  return best;
}

/** Stamp the receipt's block (hex) on each log that lacks one, so it reaches lib/protocol-viem through lib/wallet.execCalls. */
export function withBlock<L extends object>(logs: L[], block: bigint | Hex | number | string | null | undefined): (L & { blockNumber?: Hex })[] {
  let b: Hex | undefined;
  try { b = block === undefined || block === null || block === "" ? undefined : toHex(BigInt(block as string | number | bigint)); } catch { b = undefined; }
  return logs.map((l) => {
    const own = (l as ReceiptLog).blockNumber;
    if (own !== undefined && own !== null && own !== "") { try { return { ...l, blockNumber: toHex(BigInt(own as string | number | bigint)) }; } catch { /* */ } }
    return b ? { ...l, blockNumber: b } : (l as L & { blockNumber?: Hex });
  });
}

export class ReadFloor {
  private block?: bigint; private until = 0; private since = 0; private sent?: number;
  private ts?: { block: bigint; p: Promise<bigint | undefined> };
  /** chain clock − our clock, seconds: bounds learned from our own receipts (see execTime). */
  private lo = -Infinity; private hi = Infinity;
  constructor(private clock: () => number = Date.now, public windowMs = 3000) {}
  /**
   * Our own receipt landed in `block`: pin "latest" reads to ≥ block for windowMs (a newer own trade only raises it).
   * `sentAt` (our clock, ms) = when that tx was handed to the relay: its block was produced after it.
   */
  raise(block: bigint | undefined, sentAt?: number) {
    if (block === undefined) return;
    const live = this.block !== undefined && this.clock() <= this.until;
    if (!live || block > this.block!) { this.block = block; this.since = this.clock(); this.sent = sentAt; }
    this.until = this.clock() + this.windowMs;
  }
  /** Block to pin "latest" reads to, or undefined (no own trade in the window). */
  pin(): bigint | undefined { return this.block !== undefined && this.clock() <= this.until ? this.block : undefined; }
  clear() { this.block = undefined; this.until = 0; this.ts = undefined; }
  /**
   * Block timestamp to evaluate a pinned eth_call at: our estimate of the second the NEXT tx executes in (now +
   * EXEC_SEND_MS on the chain clock), never below the pinned block's own timestamp. The chain clock offset is bounded by
   * each pinned receipt: its block (timestamp ts, whole seconds) was produced after we sent it and before we got the
   * receipt ⇒ ts − recv ≤ offset < ts + 1 − sent. `header` reads the pinned block's timestamp once per pin; undefined ⇒
   * no override (plain pinned read, the old behaviour).
   */
  async execTime(block: bigint, header: (b: bigint) => Promise<bigint | undefined>): Promise<bigint | undefined> {
    if (this.ts?.block !== block) {
      const since = this.since, sent = this.sent, mine = block === this.block;
      const p = header(block).catch(() => undefined).then((v) => {
        if (v === undefined) { if (this.ts?.p === p) this.ts = undefined; return v; }   // failed: re-read next time
        if (mine) this.learn(Number(v), since / 1000, sent === undefined ? undefined : sent / 1000);
        return v;
      });
      this.ts = { block, p };
    }
    const t = await this.ts.p;
    if (t === undefined || this.lo === -Infinity) return t;
    // midpoint of the bounds; a loose upper bound (slow send / prep) is capped at lo + 0.5 s (≈ the second's midpoint)
    const off = this.lo + Math.min(0.5, (this.hi - this.lo) / 2);
    const est = BigInt(Math.floor((this.clock() + EXEC_SEND_MS) / 1000 + off));
    return est > t ? est : t;
  }
  private learn(ts: number, recv: number, sent?: number) {
    const lo = ts - recv, hi = sent === undefined ? Infinity : ts + 1 - sent;
    const nlo = Math.max(this.lo, lo), nhi = Math.min(this.hi, hi);
    if (nlo > nhi) { this.lo = lo; this.hi = hi; } else { this.lo = nlo; this.hi = nhi; }   // inconsistent (clock jump): restart
  }
}
/**
 * Our clock → the block our next tx lands in: quote returns, the op is signed and sent, the relay's sync send lands it
 * (~0.2–0.3 s on RH). Time-dependent views — the sniper tax (BondingCurve.currentSnipeFeeBps = table[block.timestamp −
 * launchTime]: 99% · 25% · 3% … per second) — are then quoted for the execution second, not the receipt block's: the
 * session policy re-quotes at execution and refuses a minOut quoted at an earlier second's tax (MinOutTooLow).
 */
export const EXEC_SEND_MS = 250;
export const READ_FLOOR = new ReadFloor();

/** State reads whose block tag sits at params[i]. */
const BLOCK_PARAM: Record<string, number> = { eth_call: 1, eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2 };
/** "This node doesn't have that block yet" (geth / nitro / reth / erigon wordings). */
export const BEHIND = /header not found|unsupported block number|unknown block|block not found|not found.*block|block.*not (?:found|available)|missing trie node|no state available|after last accepted block|requested block .* (?:is )?(?:greater|ahead|in the future)/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a transport's request fn with the floor. `retryMs` × `tries` bounds the wait for a lagging node (~1.6 s).
 * Only "latest"/"pending"/missing tags are rewritten; an explicit block number or hash from the caller is kept.
 */
export function flooredRequest(inner: (a: { method: string; params?: unknown }) => Promise<unknown>, floor: ReadFloor = READ_FLOOR, o: { retryMs?: number; tries?: number; sleep?: (ms: number) => Promise<unknown>; execTime?: boolean } = {}) {
  const retryMs = o.retryMs ?? 80, tries = o.tries ?? 20, wait = o.sleep ?? sleep;
  // the pinned block's timestamp (null ⇒ this node doesn't have it yet: retry like the read itself)
  const header = async (b: bigint): Promise<bigint | undefined> => {
    for (let n = 0; n < tries; n++) {
      const h = await inner({ method: "eth_getBlockByNumber", params: [toHex(b), false] }) as { timestamp?: string } | null;
      if (h && typeof h === "object" && h.timestamp) return BigInt(h.timestamp);
      await wait(retryMs);
    }
    return undefined;
  };
  return async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const i = BLOCK_PARAM[method];
    const pin = i === undefined ? undefined : floor.pin();
    if (pin === undefined || !Array.isArray(params)) return inner({ method, params });
    const tag = params[i];
    if (tag !== undefined && tag !== "latest" && tag !== "pending" && tag !== null) return inner({ method, params });
    const p = [...params]; while (p.length < i) p.push(undefined); p[i] = toHex(pin);
    // eth_call(tx, block, stateOverride, blockOverrides): pinned STATE, evaluated at the execution second (ReadFloor.execTime)
    if (o.execTime && method === "eth_call" && p.length <= 3 && p[3] === undefined) {
      const t = await floor.execTime(pin, header);
      if (t !== undefined) { p[2] = p[2] ?? {}; p[3] = { time: toHex(t) }; }
    }
    for (let n = 0; ; n++) {
      try { return await inner({ method, params: p }); }
      catch (e) {
        if (n + 1 >= tries || !BEHIND.test(errText(e))) throw e;
        await wait(retryMs);
      }
    }
  };
}
function errText(e: unknown): string {
  const x = e as { details?: string; shortMessage?: string; message?: string; cause?: unknown };
  return [x?.details, x?.shortMessage, x?.message, (x?.cause as { message?: string } | undefined)?.message].filter(Boolean).join(" | ") || String(e);
}

/** viem transport: `base` (e.g. http()) with the post-trade floor applied to state reads. */
export function flooredTransport(base: Transport, floor: ReadFloor = READ_FLOOR, o: { retryCount?: number; execTime?: boolean } = {}): Transport {
  return (cfg) => {
    const inner = base({ ...cfg, retryCount: cfg.retryCount ?? 0 });
    const req = flooredRequest((a) => (inner.request as EIP1193RequestFn)(a as never), floor, { execTime: o.execTime });
    return custom({ request: req as never }, { key: "floored", name: "Floored", retryCount: o.retryCount ?? cfg.retryCount })(cfg);
  };
}
