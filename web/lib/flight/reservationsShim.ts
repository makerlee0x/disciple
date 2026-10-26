/**
 * GAME-side SHIM of SITE's in-flight reservation registry: a VERBATIM copy of the registry in
 * web/lib/trade/reservations.ts on site/rapid-tap (#144, head 01b27d97), from `ReserveSide` through `autoReservationId`,
 * minus SITE's trade-layer-only helpers (spendable / PendingSpend / SESSION_PENDING).
 * TODO(site/rapid-tap #144): once #144 is in this stack, replace this whole file with ONE line:
 *   export * from "@/lib/trade/reservations";
 * GAME rules (agreed with SITE): same press id as TradeParams.reservationId (else counted twice); a pending_unknown press
 * is never released by GAME (release() refuses it); its outcome arrives as "resolved" then "release".
 * Pure + synchronous (no RPC, no await): it runs in the trade path before aaSend (#140 asTrade takes a sync global).
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
  /** Gas cap for this op (BOOST or DUMP) in raw USDG (USDG gas, #141 maxTokenCost); counted as cash. Default: the gas reserve source. */
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
    // BOOSTs and DUMPs both pay gas (USDG gas): every op holds its gas cap, always from CASH (USDG), never from tokens
    const gas = r.gasReserve ?? cur?.gasReserve ?? this.gasSource();
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
  /** Cash held by pending trades in $ (USDG 1:1): Σ BOOST usd + Σ gas caps of BOOSTs AND DUMPs (raw USDG → $ at the chain's USDG decimals). */
  reservedCash(): number {
    const dec = this.decimals();
    let usd = 0, gas = B0;
    for (const r of this.list()) { if (r.side === "boost") usd += r.usd ?? (r.spend && isUsdgRaw(r) ? usdgRawToUsd(r.spend.raw, dec) : 0); if (r.gasReserve) gas += r.gasReserve; }
    return usd + usdgRawToUsd(gas, dec);
  }
  /** Raw coin held by pending DUMPs of `coin` (their gas caps are cash: reservedCash / reservedRaw(usdg), not here). */
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
