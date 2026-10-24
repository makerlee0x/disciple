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
  private block?: bigint; private until = 0;
  constructor(private clock: () => number = Date.now, public windowMs = 3000) {}
  /** Our own receipt landed in `block`: pin "latest" reads to ≥ block for windowMs (a newer own trade only raises it). */
  raise(block: bigint | undefined) {
    if (block === undefined) return;
    const live = this.block !== undefined && this.clock() <= this.until;
    if (!live || block > this.block!) this.block = block;
    this.until = this.clock() + this.windowMs;
  }
  /** Block to pin "latest" reads to, or undefined (no own trade in the window). */
  pin(): bigint | undefined { return this.block !== undefined && this.clock() <= this.until ? this.block : undefined; }
  clear() { this.block = undefined; this.until = 0; }
}
export const READ_FLOOR = new ReadFloor();

/** State reads whose block tag sits at params[i]. */
const BLOCK_PARAM: Record<string, number> = { eth_call: 1, eth_getBalance: 1, eth_getCode: 1, eth_getTransactionCount: 1, eth_getStorageAt: 2 };
/** "This node doesn't have that block yet" (geth / nitro / reth / erigon wordings). */
export const BEHIND = /header not found|unknown block|block not found|not found.*block|block.*not (?:found|available)|missing trie node|no state available|after last accepted block|requested block .* (?:is )?(?:greater|ahead|in the future)/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a transport's request fn with the floor. `retryMs` × `tries` bounds the wait for a lagging node (~1.6 s).
 * Only "latest"/"pending"/missing tags are rewritten; an explicit block number or hash from the caller is kept.
 */
export function flooredRequest(inner: (a: { method: string; params?: unknown }) => Promise<unknown>, floor: ReadFloor = READ_FLOOR, o: { retryMs?: number; tries?: number; sleep?: (ms: number) => Promise<unknown> } = {}) {
  const retryMs = o.retryMs ?? 80, tries = o.tries ?? 20, wait = o.sleep ?? sleep;
  return async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const i = BLOCK_PARAM[method];
    const pin = i === undefined ? undefined : floor.pin();
    if (pin === undefined || !Array.isArray(params)) return inner({ method, params });
    const tag = params[i];
    if (tag !== undefined && tag !== "latest" && tag !== "pending" && tag !== null) return inner({ method, params });
    const p = [...params]; while (p.length < i) p.push(undefined); p[i] = toHex(pin);
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
export function flooredTransport(base: Transport, floor: ReadFloor = READ_FLOOR): Transport {
  return (cfg) => {
    const inner = base({ ...cfg, retryCount: cfg.retryCount ?? 0 });
    const req = flooredRequest((a) => (inner.request as EIP1193RequestFn)(a as never), floor);
    return custom({ request: req as never }, { key: "floored", name: "Floored", retryCount: cfg.retryCount })(cfg);
  };
}
