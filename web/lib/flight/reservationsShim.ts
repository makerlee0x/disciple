/**
 * GAME-side SHIM of SITE's in-flight reservation registry: a VERBATIM copy of the registry API in
 * web/lib/trade/reservations.ts on site/rapid-tap (#144, head 341cda6b), minus SITE's trade-layer-only helpers
 * (spendable / PendingSpend / SESSION_PENDING), so GAME codes against the exact signatures and semantics.
 * TODO(site/rapid-tap #144): once #144 is in this stack, replace this whole file with ONE line:
 *   export * from "@/lib/trade/reservations";
 * GAME rules (agreed with SITE): same press id as TradeParams.reservationId (else the trade layer reserves `trade:N` and
 * the press is counted twice); reservedCash() is $ (USDG 1:1, gas caps raw USDG 6-dec → $); reservedTokens(coin) raw.
 * Pure + synchronous (no RPC, no await): it runs in the trade path before aaSend (#140 asTrade takes a sync global).
 */
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
export type Reservation = ReserveInput & { id: string; at: number; spend?: ReserveSpend };
export type ReservationEvent = { type: "reserve" | "release"; id: string; reason?: ReleaseReason; r: Reservation };

const B0 = BigInt(0);
const lc = (s: string) => s.toLowerCase();

export class Reservations {
  private m = new Map<string, Reservation>();
  private subs = new Set<(e: ReservationEvent) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private gasSource: () => bigint | undefined = () => undefined;
  constructor(private clock: () => number = Date.now, public ttlMs = 60_000, private useTimers = true) {}

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
  /** Release `id` (idempotent). true when something was released. */
  release(id: string, reason: ReleaseReason): boolean {
    const r = this.m.get(id); if (!r) return false;
    this.m.delete(id);
    const t = this.timers.get(id); if (t) { clearTimeout(t); this.timers.delete(id); }
    this.emit({ type: "release", id, reason, r });
    return true;
  }
  has(id: string) { this.sweep(); return this.m.has(id); }
  get(id: string): Reservation | undefined { this.sweep(); return this.m.get(id); }
  list(): Reservation[] { this.sweep(); return [...this.m.values()]; }
  /** Pending presses (optionally one side). */
  count(side?: ReserveSide): number { return this.list().filter((r) => !side || r.side === side).length; }
  /** Cash held by pending BOOSTs in $ (USDG 1:1): Σ usd + Σ gas caps (raw USDG → $, 6 dec). */
  reservedCash(): number {
    let usd = 0, gas = B0;
    for (const r of this.list()) { if (r.side === "boost") usd += r.usd ?? (r.spend && isUsdgRaw(r) ? Number(r.spend.raw) / 1e6 : 0); if (r.gasReserve) gas += r.gasReserve; }
    return usd + Number(gas) / 1e6;
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
    const a = lc(asset), usdg = o.usdg ? lc(o.usdg) : undefined; let t = B0;
    for (const r of this.list()) {
      if (r.id === o.exceptId) continue;
      if (r.spend) { if (r.spend.asset === a) t += r.spend.raw; }
      else if (r.side === "boost" && usdg === a && r.usd) t += BigInt(Math.round(r.usd * 1e6));
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
  clear() { for (const id of [...this.m.keys()]) this.release(id, "cancel"); }

  private arm(id: string) {
    if (!this.useTimers || typeof setTimeout === "undefined") return;
    const t = setTimeout(() => { this.timers.delete(id); this.release(id, "timeout"); }, this.ttlMs);
    (t as { unref?: () => void }).unref?.();
    this.timers.set(id, t);
  }
  /** Lazy expiry (also covers a test clock / suspended tab). */
  private sweep() { const now = this.clock(); for (const [id, r] of this.m) if (now - r.at > this.ttlMs) this.release(id, "timeout"); }
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
export const setGasReserveSource = (f: () => bigint | undefined) => RESERVATIONS.setGasReserveSource(f);

let auto = 0;
/** Trade-layer id when the caller passed no reservationId. */
export const autoReservationId = () => `trade:${++auto}`;
