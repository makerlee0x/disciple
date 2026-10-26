/**
 * Post-trade balances booked from OUR fill's receipt, not from a public-RPC re-read (SITE, PR #137).
 *
 * Why: FLOW measured 160 ms send → receipt through the relay (RH sequencer, eth_sendRawTransactionSync) while the public
 * RH RPC served the same receipt 643–745 ms later. Any "refresh once after a fill" that re-reads the public RPC at
 * `latest` can land on a node that is still behind and show the PRE-fill balance for ~0.7 s (or, after a buy, the
 * old lower coin balance over the one the receipt already proved).
 *
 * How:
 *  - The fill is booked from what the trade path already returned: the receipt logs (ERC-20 Transfer deltas, exact raw)
 *    when the hand-off carries them, else the decoded fill TradeBridge emits as 'disciple:fillreceipt' {txHash, side,
 *    usd, tokens, source} (decoded from the receipt logs: lib/flight/fills). USDG is booked only when the $ is the
 *    router's real USDG (source "usdg"), never a quote-value estimate. No optimistic booking: nothing is booked before
 *    a successful receipt exists.
 *  - The receipt's block comes from the relay path itself: lib/aa/mav2 puts `blockNumber` (read off the returned
 *    receipt / its logs) on the 'disciple:op' {phase:"confirmed"} event, or the fillreceipt detail carries it.
 *  - Reads after a fill are pinned at or after that block (readAtOrAfter): `latest` from getBlockNumber, raised to the
 *    floor; a node that does not have the block yet errors ⇒ brief retry. A read below the receipt block (or one we
 *    cannot place) never replaces the booked value: the booked delta is applied on top of it / the booked value is
 *    kept until a read at ≥ the receipt block (or one that already shows the fill) arrives, or the entry expires.
 *
 * Pure core (FillBook, transferDeltas, blockOf, readAtOrAfter) is node-testable: scripts/test-fill-book.mts.
 */

export type BlockLike = bigint | number | string | null | undefined;
export interface ReceiptLogLike { address: string; topics: readonly string[]; data: string; blockNumber?: BlockLike }

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const lc = (s: string | null | undefined) => String(s || "").toLowerCase();
const topicAddr = (t: string | undefined) => (t ? "0x" + lc(t).slice(-40) : "");

/** Block number from a bigint / number / hex or decimal string; undefined when absent or unparsable. */
export function blockOf(v: BlockLike): bigint | undefined {
  try {
    if (v === null || v === undefined || v === "") return undefined;
    if (typeof v === "bigint") return v >= BigInt(0) ? v : undefined;
    if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? BigInt(Math.floor(v)) : undefined;
    const s = String(v).trim();
    return /^(0x[0-9a-f]+|[0-9]+)$/i.test(s) ? BigInt(s) : undefined;
  } catch { return undefined; }
}
/** The receipt's block from its logs (every log of one receipt carries the same blockNumber). */
export function blockOfLogs(logs: readonly { blockNumber?: BlockLike }[] | null | undefined): bigint | undefined {
  if (!Array.isArray(logs)) return undefined;
  for (const l of logs) { const b = blockOf(l?.blockNumber); if (b !== undefined) return b; }
  return undefined;
}

/** Net ERC-20 raw delta per token for `holder` from a receipt's Transfer logs (in − out). Exact; no RPC. */
export function transferDeltas(logs: readonly ReceiptLogLike[], holder: string): Map<string, bigint> {
  const me = lc(holder), out = new Map<string, bigint>();
  for (const l of logs || []) {
    if (lc(l.topics?.[0]) !== TRANSFER_TOPIC || (l.topics?.length ?? 0) < 3) continue;
    const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
    if (from !== me && to !== me) continue;
    const h = lc(l.data).replace(/^0x/, "");
    if (h.length < 64) continue;
    const v = BigInt("0x" + h.slice(0, 64)), k = lc(l.address);
    let d = out.get(k) ?? BigInt(0);
    if (to === me) d += v;
    if (from === me) d -= v;
    out.set(k, d);
  }
  return out;
}
/** raw → display units without losing precision on big values (same rule as lib/flight/fills units). */
export function rawUnits(raw: bigint, decimals: number): number {
  const neg = raw < BigInt(0), a = neg ? -raw : raw, d = BigInt(10) ** BigInt(decimals);
  const v = Number(a / d) + Number(a % d) / Number(d);
  return neg ? -v : v;
}

/* ---------------- the book ---------------- */

export interface Pending { tx: string; delta: number; block?: bigint; at: number; after?: number }
export interface Read { value: number; block?: bigint; at: number }
/** How long a booked fill may hold back reads it cannot place (no block info) before any read is accepted. */
export const BOOK_TTL_MS = 20_000;
const EPS = 1e-9;

/** floor() key for "the page's own last receipt", whichever account sent it */
export const ANY_HOLDER = "*";
const key = (holder: string, token: string) => `${lc(holder)}|${lc(token)}`;

/**
 * Per (holder, token): the last read (value + the block it was read at) and the fills booked on top of it that no read
 * has shown yet. display() = what to show; observe() records a read and retires fills it already includes.
 */
export class FillBook {
  private reads = new Map<string, Read>();
  private pend = new Map<string, Pending[]>();
  private txs = new Set<string>();
  private floors = new Map<string, { block: bigint; at: number }>();
  constructor(private now: () => number = () => Date.now(), private ttlMs = BOOK_TTL_MS) {}

  /** Has this tx already been booked (for any token)? */
  booked(tx: string) { return this.txs.has(lc(tx)); }

  /**
   * Book one fill's delta for (holder, token). Idempotent per tx+token. `block` = the receipt's block when known.
   * A read already taken at ≥ that block includes the fill ⇒ nothing is added (no double count).
   */
  book(holder: string, token: string, tx: string, delta: number, block?: bigint): boolean {
    if (!tx || !Number.isFinite(delta) || delta === 0) return false;
    const k = key(holder, token), id = `${lc(tx)}|${lc(token)}`;
    if (this.txs.has(id)) return false;
    this.txs.add(id); this.txs.add(lc(tx));
    if (block !== undefined) this.raiseFloor(holder, block);
    const r = this.reads.get(k);
    if (r && r.block !== undefined && block !== undefined && r.block >= block) return false;
    const before = r ? this.display(holder, token, r) : undefined;
    const list = this.pend.get(k) ?? [];
    list.push({ tx: lc(tx), delta, block, at: this.now(), after: before === undefined ? undefined : before + delta });
    this.pend.set(k, list);
    return true;
  }

  /** Remember the receipt block for a holder (from 'disciple:op' confirmed) even before the amounts are known. */
  raiseFloor(holder: string, block: bigint) {
    const k = lc(holder), f = this.floors.get(k);
    if (!f || block > f.block) this.floors.set(k, { block, at: this.now() });
  }
  /**
   * Lowest block a read for `holder` may be taken at right now: the latest own receipt block for that holder or for any
   * own op (ANY_HOLDER, from 'disciple:op' confirmed, which does not name the account), within the TTL.
   */
  floor(holder: string): bigint | undefined {
    let out: bigint | undefined;
    for (const k of [lc(holder), ANY_HOLDER]) {
      const f = this.floors.get(k);
      if (!f) continue;
      if (this.now() - f.at > this.ttlMs) { this.floors.delete(k); continue; }
      if (out === undefined || f.block > out) out = f.block;
    }
    return out;
  }

  private live(k: string): Pending[] {
    const t = this.now(), list = (this.pend.get(k) ?? []).filter((p) => t - p.at <= this.ttlMs);
    if (list.length) this.pend.set(k, list); else this.pend.delete(k);
    return list;
  }
  /** Does read `r` already include fill `p`? */
  private includes(r: Read, p: Pending): boolean {
    if (r.block !== undefined && p.block !== undefined) return r.block >= p.block;
    if (r.at < p.at) return false;               // read started before the fill was booked: it is the pre-fill state
    if (p.after === undefined) return true;      // nothing booked to compare with: the read wins
    // placed after the booking, block unknown: a read still on the pre-fill side of the booked value is stale
    return (r.value - p.after) * Math.sign(p.delta) >= -EPS * Math.max(1, Math.abs(p.after));
  }

  /** What to show for a read of (holder, token): the read plus every booked fill it does not include yet. Pure. */
  display(holder: string, token: string, r: Read | undefined = this.reads.get(key(holder, token))): number | undefined {
    const k = key(holder, token), list = this.live(k);
    if (!r) {
      // no read yet: only an absolute value from a booking with a known pre-fill value can be shown
      const last = list[list.length - 1];
      return last?.after;
    }
    let v = r.value;
    for (const p of list) if (!this.includes(r, p)) v = r.block === undefined && r.at >= p.at && p.after !== undefined ? p.after : v + p.delta;
    return v;
  }

  /** Record a read (value at block, or block unknown) and return what to show. Fills the read includes are retired. */
  observe(holder: string, token: string, value: number, block?: bigint, startedAt?: number): number {
    const k = key(holder, token), r: Read = { value, block, at: startedAt ?? this.now() };
    const prev = this.reads.get(k);
    // never let an older-block read replace a newer one
    if (prev && prev.block !== undefined && block !== undefined && block < prev.block) return this.display(holder, token, prev) ?? prev.value;
    const shown = this.display(holder, token, r) ?? value;
    const keep = this.live(k).filter((p) => this.includes(r, p) !== true);
    if (keep.length) {
      // the read is taken on a pre-fill block: carry the booked deltas forward on top of it
      this.pend.set(k, keep.map((p) => ({ ...p, after: shown })));
    } else this.pend.delete(k);
    this.reads.set(k, r);
    return shown;
  }

  /** Tokens with fills not yet shown by a read (e.g. a first buy the indexer does not list yet). */
  pendingTokens(holder: string): string[] {
    const h = lc(holder) + "|", out: string[] = [];
    for (const k of this.pend.keys()) if (k.startsWith(h) && this.live(k).length) out.push(k.slice(h.length));
    return out;
  }
  clear() { this.reads.clear(); this.pend.clear(); this.txs.clear(); this.floors.clear(); }
}

/* ---------------- 'disciple:fillreceipt' → book ---------------- */

/** TradeBridge's 'disciple:fillreceipt' detail (+ the optional fields #138's logs hand-off can add). */
export interface FillReceiptDetail {
  txHash?: string; side?: "buy" | "sell"; usd?: number; tokens?: number; feeUsd?: number; source?: "usdg" | "curve" | "hook";
  /** optional: the receipt's block (from the returned receipt / logs) */
  blockNumber?: BlockLike;
  /** optional: the returned receipt logs (exact Transfer deltas) */
  logs?: readonly ReceiptLogLike[];
  /** optional: coin + trading account the fill was decoded for */
  token?: string; trader?: string;
}
export interface BookCtx { holder: string; coin?: string | null; usdg: string; usdgDecimals: number; coinDecimals?: number; decimals?: (token: string) => number | undefined; block?: bigint }

/**
 * Book a fill for `ctx.holder`. Logs present ⇒ every Transfer delta of the holder (exact). Otherwise the decoded fill:
 * coin ±tokens (exact token amount from the logs), USDG ∓usd only when source = "usdg" (the router's real USDG).
 * Returns the tokens booked.
 */
export function bookFill(book: FillBook, d: FillReceiptDetail | null | undefined, ctx: BookCtx): string[] {
  if (!d || !d.txHash || !ctx.holder) return [];
  if (d.trader && lc(d.trader) !== lc(ctx.holder)) return [];
  const block = blockOf(d.blockNumber) ?? blockOfLogs(d.logs) ?? ctx.block;
  const done: string[] = [];
  if (Array.isArray(d.logs) && d.logs.length) {
    for (const [token, raw] of transferDeltas(d.logs, ctx.holder)) {
      const dec = lc(token) === lc(ctx.usdg) ? ctx.usdgDecimals : ctx.decimals?.(token) ?? (ctx.coin && lc(token) === lc(ctx.coin) ? ctx.coinDecimals ?? 18 : undefined);
      if (dec === undefined) continue;
      if (book.book(ctx.holder, token, d.txHash, rawUnits(raw, dec), block)) done.push(lc(token));
    }
    if (block !== undefined) book.raiseFloor(ctx.holder, block);
    return done;
  }
  const coin = d.token || ctx.coin;
  const sign = d.side === "buy" ? 1 : d.side === "sell" ? -1 : 0;
  if (!sign) return [];
  if (coin && Number.isFinite(d.tokens) && (d.tokens as number) > 0 && book.book(ctx.holder, coin, d.txHash, sign * (d.tokens as number), block)) done.push(lc(coin));
  if (d.source === "usdg" && Number.isFinite(d.usd) && (d.usd as number) > 0 && book.book(ctx.holder, ctx.usdg, d.txHash, -sign * (d.usd as number), block)) done.push(lc(ctx.usdg));
  if (block !== undefined) book.raiseFloor(ctx.holder, block);
  return done;
}

/* ---------------- reads at or after the receipt block ---------------- */

export interface BlockSource { getBlockNumber: () => Promise<bigint> }
/**
 * Read at max(latest, floor). A node that is behind the floor errors on that block ⇒ retry briefly (tries × delayMs);
 * every failed attempt re-reads latest first. Returns the value and the block it is valid at.
 */
export async function readAtOrAfter<T>(pc: BlockSource, floor: bigint | undefined, read: (blockNumber: bigint) => Promise<T>, o: { tries?: number; delayMs?: number } = {}): Promise<{ value: T; block: bigint }> {
  const tries = Math.max(1, o.tries ?? 6), delay = o.delayMs ?? 150;
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const head = await pc.getBlockNumber();
      const b = floor !== undefined && floor > head ? floor : head;
      return { value: await read(b), block: b };
    } catch (e) { err = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, delay)); }
  }
  throw err;
}

/* ---------------- browser wiring ---------------- */

/** The page's one book (module state: survives client-side navigation, e.g. coin page → profile). */
export const fillBook = new FillBook();
/** Receipt block per tx from the relay path ('disciple:op' confirmed {txHash, blockNumber}). Last 64 kept. */
const txBlocks = new Map<string, bigint>();
export function txBlock(tx: string | undefined): bigint | undefined { return tx ? txBlocks.get(lc(tx)) : undefined; }
export function noteTxBlock(tx: string | undefined, b: BlockLike) {
  const v = blockOf(b); if (!tx || v === undefined) return;
  txBlocks.set(lc(tx), v); while (txBlocks.size > 64) txBlocks.delete(txBlocks.keys().next().value as string);
}
export const BOOKED_EVENT = "disciple:booked";
if (typeof window !== "undefined") {
  window.addEventListener("disciple:op", (e) => {
    const d = (e as CustomEvent<{ phase?: string; txHash?: string; blockNumber?: BlockLike }>).detail;
    if (d?.phase !== "confirmed") return;
    noteTxBlock(d.txHash, d.blockNumber);
    const b = blockOf(d.blockNumber);
    if (b !== undefined) fillBook.raiseFloor(ANY_HOLDER, b);
  });
}
