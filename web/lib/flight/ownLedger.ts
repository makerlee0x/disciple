/**
 * GAME trade speed — own balances from the SYNC RECEIPT, not a public-RPC re-read.
 * FLOW measured send → receipt ≈ 160 ms via the sequencer, but the public RPC lags another ~0.65–0.75 s: a balanceOf read at
 * confirm returns the PRE-trade balance and rolls the HUD (position, uPnL, cash) back. So at confirm the token + USDG
 * Transfer deltas from the returned logs are applied to the cached balances right away; the public RPC only RECONCILES later
 * (≥ 1 s after the fill), with a read pinned to a block, accepted only when that block is ≥ the fill's block (a stale read
 * never overwrites a fill). Pure (no viem / DOM): components/TradeBridge.tsx wires it; scripts/test-trade-speed.mjs tests it.
 */
import type { LogLike } from "./fills";

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const RECONCILE_MIN_MS = 1000;      // no public-RPC reconcile read sooner than this after a fill
export const FLOOR_GIVE_UP_MS = 30_000;    // the RPC never showed the fill's receipt ⇒ stop waiting for its block
const lc = (s: unknown) => String(s ?? "").toLowerCase();
const topicAddr = (t: string | undefined) => (t ? "0x" + lc(t).slice(-40) : "");
const key = (token: string, owner: string) => lc(token) + "|" + lc(owner);

/** Net ERC-20 Transfer delta per token for `owner` (received − sent), only for the listed tokens. Tokens with no Transfer
 *  touching `owner` are absent (⇒ untouched). */
export function transferDeltas(logs: readonly LogLike[], owner: string, tokens: readonly string[]): Map<string, bigint> {
  const want = new Set(tokens.map(lc)), me = lc(owner), out = new Map<string, bigint>();
  for (const l of logs || []) {
    try {
      const a = lc(l.address);
      if (!want.has(a) || lc(l.topics?.[0]) !== TRANSFER_TOPIC || (l.topics?.length ?? 0) < 3) continue;
      const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]);
      if (from !== me && to !== me) continue;
      const v = BigInt(l.data && l.data !== "0x" ? l.data.slice(0, 66) : "0x0");
      const d = (to === me ? v : BigInt(0)) - (from === me ? v : BigInt(0));
      out.set(a, (out.get(a) ?? BigInt(0)) + d);
    } catch { /* malformed log: skip */ }
  }
  return out;
}

export interface LedgerEntry { value: bigint; readBlock?: bigint; fillTx?: string; fillAt?: number }

export class OwnLedger {
  private m = new Map<string, LedgerEntry>();
  private txBlock = new Map<string, bigint>();
  get(token: string, owner: string) { return this.m.get(key(token, owner))?.value; }
  entry(token: string, owner: string): Readonly<LedgerEntry> | undefined { return this.m.get(key(token, owner)); }
  /** Apply a fill's Transfer deltas at confirm. base(token) = the cached balance before it (used when the ledger has none).
   *  Returns the tokens whose balance changed. */
  applyFill(owner: string, tokens: readonly string[], logs: readonly LogLike[], txHash: string, base: (token: string) => bigint | undefined, now: number) {
    const ds = transferDeltas(logs, owner, tokens), changed: { token: string; value: bigint; delta: bigint }[] = [];
    for (const [t, d] of ds) {
      const k = key(t, owner), e = this.m.get(k), b = e?.value ?? base(t);
      if (b === undefined && d < BigInt(0)) continue;   // unknown base for a debit: leave it to the reconcile read
      const value = (b ?? BigInt(0)) + d > BigInt(0) ? (b ?? BigInt(0)) + d : BigInt(0);
      this.m.set(k, { value, readBlock: e?.readBlock, fillTx: lc(txHash), fillAt: now });
      changed.push({ token: t, value, delta: d });
    }
    return changed;
  }
  /** The fill block of a tx, once known (polled receipt or the RPC's receipt during reconcile). */
  noteTxBlock(txHash: string, block: bigint) { this.txBlock.set(lc(txHash), block); if (this.txBlock.size > 64) this.txBlock.delete(this.txBlock.keys().next().value as string); }
  txBlockOf(txHash: string | undefined) { return txHash ? this.txBlock.get(lc(txHash)) : undefined; }
  /** A fill applied and not reconciled yet. */
  pending(token: string, owner: string) { return !!this.m.get(key(token, owner))?.fillTx; }
  /** < RECONCILE_MIN_MS since the fill ⇒ serve the ledger, no RPC. */
  tooSoon(token: string, owner: string, now: number) { const e = this.m.get(key(token, owner)); return !!e?.fillTx && now - (e.fillAt ?? 0) < RECONCILE_MIN_MS; }
  /** Offer a public-RPC read (block = the block it was read at, if pinned). Accepted ⇒ it becomes the value. Rejected when
   *  it is older than the last accepted read, or a fill is pending and the read isn't provably at / past the fill block. */
  offerRead(token: string, owner: string, value: bigint, block: bigint | undefined, now: number): boolean {
    const k = key(token, owner), e = this.m.get(k);
    if (e && block !== undefined && e.readBlock !== undefined && block < e.readBlock) return false;   // out-of-order older read
    if (e?.fillTx) {
      const fb = this.txBlock.get(e.fillTx);
      const ok = (fb !== undefined && block !== undefined && block >= fb) || (fb === undefined && block !== undefined && now - (e.fillAt ?? 0) >= FLOOR_GIVE_UP_MS);
      if (!ok) return false;
    }
    this.m.set(k, { value, readBlock: block ?? e?.readBlock });
    return true;
  }
}

/** The one ledger for this tab (TradeBridge's trade, holdings and cash effects share it). */
export const OWN = new OwnLedger();

/** Minimal public client surface (viem PublicClient fits). */
export interface ReadClient {
  getBlockNumber(a?: { cacheTime?: number }): Promise<bigint>;
  getTransactionReceipt(a: { hash: `0x${string}` }): Promise<{ blockNumber: bigint }>;
  readContract(a: { address: `0x${string}`; abi: readonly unknown[]; functionName: "balanceOf"; args: readonly [`0x${string}`]; blockNumber?: bigint }): Promise<unknown>;
}
const BALANCE_OF_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

/**
 * Own-balance read for the HUD / cash / sell sizing. No fill pending ⇒ `plain()` (the existing cached / hinted read), offered
 * to the ledger. Fill pending ⇒ the ledger value until RECONCILE_MIN_MS, then a reconcile read PINNED to the RPC's head block,
 * accepted only once that block is ≥ the fill's block (its receipt, looked up once on the same RPC). Never rolls back a fill.
 */
export async function ownRead(L: OwnLedger, pc: ReadClient, token: `0x${string}`, owner: `0x${string}`, plain: () => Promise<bigint>,
  now: () => number = Date.now): Promise<bigint> {
  const e = L.entry(token, owner);
  if (!e?.fillTx) {
    const v = await plain();
    L.offerRead(token, owner, v, undefined, now());
    return L.get(token, owner) ?? v;
  }
  if (now() - (e.fillAt ?? 0) < RECONCILE_MIN_MS) return e.value;
  try {
    if (L.txBlockOf(e.fillTx) === undefined) {
      const rc = await pc.getTransactionReceipt({ hash: e.fillTx as `0x${string}` }).catch(() => null);
      if (rc && typeof rc.blockNumber === "bigint") L.noteTxBlock(e.fillTx, rc.blockNumber);
      else if (now() - (e.fillAt ?? 0) < FLOOR_GIVE_UP_MS) return L.get(token, owner) ?? e.value;   // RPC hasn't seen the fill yet
    }
    const n = await pc.getBlockNumber({ cacheTime: 0 });
    const b = await pc.readContract({ address: token, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [owner], blockNumber: n });
    if (typeof b === "bigint") L.offerRead(token, owner, b, n, now());
  } catch { /* keep the fill-derived value */ }
  return L.get(token, owner) ?? e.value;
}
