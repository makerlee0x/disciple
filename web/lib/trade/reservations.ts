/**
 * In-flight trade reservations (SITE rapid-tap, lee-approved spec #4/#5/#6/#9). The ONE registry for what pending
 * trades will spend, so rapid taps can't overspend or race the balance:
 *  - GAME's client ledger (TradeBridge / HUD) calls reserve(pressId, …) on a press and release(pressId, …) when the
 *    press resolves, and reads spendable cash (liveCash − reservedCash()) and DUMP % (fresh − reservedTokens(coin)).
 *  - The trade layer (lib/protocol-viem) reserves the SAME id (TradeParams.reservationId; an auto id otherwise) with the
 *    exact raw amounts before it quotes, checks `have − reserved by others ≥ amountIn` before sending, and releases on
 *    fill / error / timeout as a backstop. reserve() and release() are idempotent per id: a second reserve of an id
 *    MERGES its fields (never double counts), a second release is a no-op.
 *  - Reservations live here, never in BALANCES: a balance poll can't wipe them, and displayed balances stay real
 *    (no optimistic or fake fills: the balance changes only from a receipt or a fresh read).
 * Pure and synchronous: no RPC, no sleeps. A forgotten reservation expires after `ttlMs` (released as "timeout").
 *
 * AUDIT (#141 review) — 'pending_unknown': a receipt / relay timeout does NOT release the press. The trade layer marks it
 * unknown (markUnknown: event "unknown"), the hold stays counted, the TTL never expires it and release() refuses it;
 * only the background watcher ends it (resolveUnknown: event "resolved" with outcome "filled" | "error", then "release").
 *
 * USDG decimals (18 on today's testnet, 6 after the redeploy) are never hard-coded: $ ⇄ raw USDG conversions here use
 * `usdgDecimals()` (lib/usdg: the chain's decimals() once read, else config) or the constructor's `decimals` source.
 */
import { usdgDecimals as activeUsdgDecimals, usdToUsdgRaw, usdgRawToUsd } from "../usdg";

export type ReserveSide = "boost" | "dump";
export type ReleaseReason = "filled" | "error" | "timeout" | "cancel";
export type ReserveInput = {
  side: ReserveSide;
  /** Coin address (any case). */
  coin: string;
  /** BOOST: cash ($, USDG 1:1) this press spends. */
  usd?: number;
  /** DUMP: raw coin amount (18 dec) this press sells. */
  tokenAmt?: bigint;
  /** Gas cap for this op in raw USDG (USDG gas, #141 maxTokenCost); counted as cash. Default: the gas reserve source. */
  gasReserve?: bigint;
};
/** Trade-layer detail on a reservation (exact raw spend, quote route). Not needed by GAME. */
export type ReserveSpend = { asset: string; raw: bigint; route?: string };
/** A press whose op was sent but whose fate is unknown (receipt / relay timeout): ids the watcher looks up. */
export type UnknownInfo = { userOpHash?: string; txHash?: string; nonce?: bigint; since: number };
export type Reservation = ReserveInput & { id: string; at: number; spend?: ReserveSpend; unknown?: UnknownInfo };
/**
 * "reserve" / "release" as before; "unknown" when a press goes pending_unknown (ids on `unknown`); "resolved" when the
 * watcher settles it (outcome "filled" ⇒ booked from the receipt logs, txHash / amountOut set; "error" ⇒ dropped or
 * reverted), always followed by its "release" (reason = outcome).
 */
export type ReservationEvent = {
  type: "reserve" | "release" | "unknown" | "resolved"; id: string; reason?: ReleaseReason; r: Reservation;
  unknown?: UnknownInfo; outcome?: "filled" | "error"; txHash?: string; amountOut?: bigint;
};

const B0 = BigInt(0);
const lc = (s: string) => s.toLowerCase();

export class Reservations {
  private m = new Map<string, Reservation>();
  private subs = new Set<(e: ReservationEvent) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private gasSource: () => bigint | undefined = () => undefined;
  constructor(private clock: () => number = Date.now, public ttlMs = 60_000, private useTimers = true, private decimals: () => number = () => activeUsdgDecimals()) {}
  /** USDG decimals used for $ ⇄ raw (tests inject 18 / 6; the app uses lib/usdg usdgDecimals()). */
  usdgDec(): number { return this.decimals(); }

  /** Reserve (or merge into) `id`. Returns the stored reservation. */
  reserve(id: string, r: ReserveInput & { spend?: ReserveSpend }): Reservation {
    const cur = this.m.get(id);
    const gas = r.gasReserve ?? cur?.gasReserve ?? (r.side === "boost" ? this.gasSource() : undefined);
    const next: Reservation = {
      ...(cur ?? {}), ...stripUndef(r), side: r.side ?? cur?.side, coin: lc(r.coin ?? cur?.coin ?? ""), id, at: cur?.at ?? this.clock(),
      ...(gas !== undefined && gas > B0 ? { gasReserve: gas } : {}),
      ...(r.spend || cur?.spend ? { spend: { ...(cur?.spend ?? {}), ...(r.spend ?? {}), asset: lc((r.spend ?? cur!.spend!).asset) } as ReserveSpend } : {}),
    };
    this.m.set(id, next);
    if (!cur) this.arm(id);
    this.emit({ type: "reserve", id, r: next });
    return next;
  }
  /**
   * Release `id` (idempotent). true when something was released. A pending_unknown press is NOT released here (GAME's
   * backstop or the TTL must not free money that may still be spent): only resolveUnknown ends it; `force` = logout.
   */
  release(id: string, reason: ReleaseReason, o: { force?: boolean } = {}): boolean {
    const r = this.m.get(id); if (!r) return false;
    if (r.unknown && !o.force) {
      if (typeof console !== "undefined") console.warn("[disciple] release ignored: trade still confirming", { id, reason, userOpHash: r.unknown.userOpHash, nonce: r.unknown.nonce?.toString() });
      return false;
    }
    this.m.delete(id);
    const t = this.timers.get(id); if (t) { clearTimeout(t); this.timers.delete(id); }
    this.emit({ type: "release", id, reason, r });
    return true;
  }
  /**
   * The press's op was sent but its fate is unknown: keep it held (TTL off) until resolveUnknown. Emits "unknown".
   * false when `id` isn't held (nothing to keep).
   */
  markUnknown(id: string, info: Omit<UnknownInfo, "since">): boolean {
    const cur = this.m.get(id); if (!cur) return false;
    const t = this.timers.get(id); if (t) { clearTimeout(t); this.timers.delete(id); }
    const unknown: UnknownInfo = { ...stripUndef(info), since: cur.unknown?.since ?? this.clock() } as UnknownInfo;
    const next = { ...cur, unknown };
    this.m.set(id, next);
    this.emit({ type: "unknown", id, r: next, unknown });
    return true;
  }
  /** The watcher settled an unknown press: emits "resolved" then "release" (reason = outcome). */
  resolveUnknown(id: string, outcome: "filled" | "error", d: { txHash?: string; amountOut?: bigint } = {}): boolean {
    const r = this.m.get(id); if (!r) return false;
    this.emit({ type: "resolved", id, r, unknown: r.unknown, outcome, ...stripUndef(d) });
    return this.release(id, outcome, { force: true });
  }
  isUnknown(id: string): boolean { return !!this.m.get(id)?.unknown; }
  unknownCount(): number { let n = 0; for (const r of this.m.values()) if (r.unknown) n++; return n; }
  has(id: string) { this.sweep(); return this.m.has(id); }
  get(id: string): Reservation | undefined { this.sweep(); return this.m.get(id); }
  list(): Reservation[] { this.sweep(); return [...this.m.values()]; }
  /** Pending presses (optionally one side). */
  count(side?: ReserveSide): number { return this.list().filter((r) => !side || r.side === side).length; }
  /** Cash held by pending BOOSTs in $ (USDG 1:1): Σ usd + Σ gas caps (raw USDG → $ at the chain's USDG decimals). */
  reservedCash(): number {
    const dec = this.decimals();
    let usd = 0, gas = B0;
    for (const r of this.list()) { if (r.side === "boost") usd += r.usd ?? (r.spend && isUsdgRaw(r) ? usdgRawToUsd(r.spend.raw, dec) : 0); if (r.gasReserve) gas += r.gasReserve; }
    return usd + usdgRawToUsd(gas, dec);
  }
  /** Raw coin held by pending DUMPs of `coin`. */
  reservedTokens(coin: string): bigint {
    const c = lc(coin); let t = B0;
    for (const r of this.list()) if (r.side === "dump" && r.coin === c) t += r.spend?.raw ?? r.tokenAmt ?? B0;
    return t;
  }
  /**
   * Raw `asset` held by pending trades, except `exceptId` (the trade asking). `usdg` = the USDG address: BOOSTs
   * GAME reserved in $ before the trade layer saw them count as USDG, and every gas cap counts as USDG.
   */
  reservedRaw(asset: string, o: { exceptId?: string; usdg?: string } = {}): bigint {
    const a = lc(asset), usdg = o.usdg ? lc(o.usdg) : undefined, dec = this.decimals(); let t = B0;
    for (const r of this.list()) {
      if (r.id === o.exceptId) continue;
      if (r.spend) { if (r.spend.asset === a) t += r.spend.raw; }
      else if (r.side === "boost" && usdg === a && r.usd) t += usdToUsdgRaw(r.usd, dec);
      else if (r.side === "dump" && r.coin === a && r.tokenAmt) t += r.tokenAmt;
      if (usdg === a && r.gasReserve) t += r.gasReserve;
    }
    return t;
  }
  /** Raw amountIn in flight on a quote route (same side), except `exceptId`: the marginal-quote base. */
  routePending(route: string, exceptId?: string): bigint {
    const k = lc(route); let t = B0;
    for (const r of this.list()) if (r.id !== exceptId && r.spend?.route && lc(r.spend.route) === k) t += r.spend.raw;
    return t;
  }
  /** Pending net for a coin: BOOST $ in, DUMP raw coin out (display / ghost projection; quotes stay worst-case per side). */
  pendingNet(coin: string): { buys: number; buyUsd: number; sells: number; sellTokens: bigint } {
    const c = lc(coin); let buys = 0, sells = 0, buyUsd = 0, sellTokens = B0;
    for (const r of this.list()) {
      if (r.coin !== c) continue;
      if (r.side === "boost") { buys++; buyUsd += r.usd ?? 0; } else { sells++; sellTokens += r.spend?.raw ?? r.tokenAmt ?? B0; }
    }
    return { buys, buyUsd, sells, sellTokens };
  }
  subscribe(cb: (e: ReservationEvent) => void): () => void { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  /** FLOW (#141): per-op gas cap in raw USDG (wallet.gasReservePerOp / DisciplePaymaster maxTokenCost); 0 / undefined when gas isn't paid in USDG. */
  setGasReserveSource(f: () => bigint | undefined) { this.gasSource = f; }
  clear() { for (const id of [...this.m.keys()]) this.release(id, "cancel", { force: true }); }

  private arm(id: string) {
    if (!this.useTimers || typeof setTimeout === "undefined") return;
    const t = setTimeout(() => { this.timers.delete(id); if (!this.m.get(id)?.unknown) this.release(id, "timeout"); }, this.ttlMs);
    (t as { unref?: () => void }).unref?.();
    this.timers.set(id, t);
  }
  /** Lazy expiry (also covers a test clock / suspended tab). */
  private sweep() { const now = this.clock(); for (const [id, r] of this.m) if (!r.unknown && now - r.at > this.ttlMs) this.release(id, "timeout"); }
  private emit(e: ReservationEvent) { for (const f of [...this.subs]) { try { f(e); } catch (err) { if (typeof console !== "undefined") console.warn("[disciple] reservation listener failed", err); } } }
}
function stripUndef<T extends object>(o: T): Partial<T> { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>; }
function isUsdgRaw(r: Reservation) { return !!r.spend && r.spend.route?.startsWith("usdgroute|") === true; }

/** The app-wide registry. */
export const RESERVATIONS = new Reservations();

/* ---- the exported API GAME's TradeBridge / HUD call (thin wrappers over RESERVATIONS) ---- */
export const reserve = (id: string, r: ReserveInput): Reservation => RESERVATIONS.reserve(id, r);
export const release = (id: string, reason: ReleaseReason): boolean => RESERVATIONS.release(id, reason);
export const reservedCash = (): number => RESERVATIONS.reservedCash();
export const reservedTokens = (coin: string): bigint => RESERVATIONS.reservedTokens(coin);
export const inflightCount = (side?: ReserveSide): number => RESERVATIONS.count(side);
export const pendingNet = (coin: string) => RESERVATIONS.pendingNet(coin);
export const subscribe = (cb: (e: ReservationEvent) => void): (() => void) => RESERVATIONS.subscribe(cb);
/** FLOW: per-op gas cap in RAW USDG base units (whatever the chain's USDG decimals are: 18 today, 6 after the redeploy). */
export const setGasReserveSource = (f: () => bigint | undefined) => RESERVATIONS.setGasReserveSource(f);
/** GAME: is this press pending_unknown (sent, still confirming)? Don't resend it; wait for its "resolved" event. */
export const isPendingUnknown = (id: string): boolean => RESERVATIONS.isUnknown(id);
export const unknownCount = (): number => RESERVATIONS.unknownCount();

let auto = 0;
/** Trade-layer id when the caller passed no reservationId. */
export const autoReservationId = () => `trade:${++auto}`;

/**
 * Pre-send cash / holdings check against what other pending trades hold. `have` is the real balance (hint or fresh
 * read). ok=false ⇒ the trade is refused before sending (no RPC is added: the caller already has `have`).
 */
export function spendable(have: bigint, reservedByOthers: bigint): bigint { const v = have - reservedByOthers; return v > B0 ? v : B0; }

/* ---- session spend cap (spec #9): in-flight session spend counts against the player's / policy's on-chain cap ---- */
/**
 * Raw quote spend of session-signed ops still in flight, per quote token. Reserved synchronously right after the
 * headroom check (no await between them, so two concurrent taps can't both pass on the same headroom), refunded on
 * failure, and moved into the cached `spent` on success.
 */
export class PendingSpend {
  private m = new Map<string, Record<string, bigint>>();
  private seq = 0;
  /** Sum per token (lowercase). */
  total(): Record<string, bigint> {
    const t: Record<string, bigint> = {};
    for (const d of this.m.values()) for (const [k, v] of Object.entries(d)) t[k] = (t[k] ?? B0) + v;
    return t;
  }
  hold(delta: Record<string, bigint>): string {
    const id = `s${++this.seq}`, d: Record<string, bigint> = {};
    for (const [k, v] of Object.entries(delta)) if (v > B0) d[lc(k)] = v;
    this.m.set(id, d); return id;
  }
  drop(id: string) { this.m.delete(id); }
  get size() { return this.m.size; }
}
export const SESSION_PENDING = new PendingSpend();
