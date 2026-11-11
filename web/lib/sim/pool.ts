/**
 * Post-graduation pool for the SIMULATOR: a full-range constant-product position (the LockedLP seed) plus
 * single-sided concentrated range orders, i.e. tramps and walls (contracts/src/TrampWallManager.sol).
 *
 * Uniswap v3/v4 math in √price space (price = quote per token, s = √price). With active liquidity L:
 *   Δquote = L·Δs,  Δtoken = L·Δ(1/s).   Full range: X = L0·s, Y = L0/s.
 * A range order [a, b] (a < b, √prices) adds L to the active liquidity while a ≤ s < b (moving up) /
 * a < s ≤ b (moving down), so swaps that cross it move the price less:
 *   TRAMP = quote-only, placed fully BELOW the price (needs s ≥ b). Sells push the price down into it and it BUYS
 *           the dip (quote → token). It absorbs SELLS. Filled once s ≤ a (all token).
 *   WALL  = token-only, placed fully ABOVE the price (needs s < a). Buys push the price up into it and it SELLS
 *           into the pump (token → quote). It absorbs BUYS. Filled once s ≥ b (all quote).
 * Like the contract: no LP yield (pure limit orders), the owner may cancel any time (gets whatever mix is left),
 * and a filled order may be `pull`ed by anyone, who earns a keeper tip (KEEPER_TIP_BPS of each asset paid out).
 * If the price comes back into the range before the pull, the order is partly un-filled again (isFilled false).
 *
 * FLOOR (LockedLP graduation floor, contracts/src/libraries/FloorBands.sol): 16 USDG-only bands seeded below spot at
 * graduation from the curve reserve's leftover (~$1,201). Same math as a tramp, but locked forever: never cancelled,
 * never pulled, never compounded. Sells fall into them and are absorbed (USDG → tokens); buys walk back up through
 * them and re-arm them (tokens → USDG). Layer A: 4 flat bands × 7.5% over spot → 0.75× (48 spacings = $25K mcap);
 * layer B: 12 bands × 32 spacings (equal log width) holding 70% over spot → 0.1× (~$3,326), weight rising 4× toward
 * the bottom. Live values: LockedLP.floorBands(token); the sim has no chain reads, so it rebuilds the same shape.
 */

/** TrampWallManager.keeperTipBps default (10 = 0.1%). */
export const KEEPER_TIP_BPS = 10;

export type OrderKind = "tramp" | "wall";
export type OrderStatus = "active" | "filled" | "cancelled";
export interface RangeOrder {
  id: number; owner: string; kind: OrderKind;
  /** √price bounds */
  a: number; b: number; L: number;
  status: OrderStatus;
  /** deposit: quote (tramp) or tokens (wall); sizeUsd = $ notional at placement */
  deposit: number; sizeUsd: number;
  /** cost basis in $ of the deposit (tramp: the quote; wall: the tokens' share of the owner's cost basis) */
  basis: number;
  placedT: number; placedBlk: number;
  /** time the range was first seen fully crossed (keeper schedules a pull); null while not filled */
  crossedT: number | null; pullAt: number | null;
  closedT?: number; closedBy?: string;
  /** owner's net amounts when closed (after the keeper tip on a pull) */
  outQuote?: number; outTokens?: number;
}

export interface SwapResult { out: number; s: number }

// ── Graduation floor geometry (Constants.sol + FloorBands.sol, steep-curve PR #127) ─────────────────────────────
export const FLOOR = {
  maxBands: 16, flatBands: 4, flatSpacings: 48, bottomSpacings: 384, flatBps: 3_000,
  /** FloorBands.BOTTOM_BPS_PACKED, j = 0 (top) .. 11 (bottom); sums to 7000 with the flat 3000 */
  bottomBps: [266, 301, 342, 388, 440, 499, 566, 642, 728, 826, 937, 1065],
  /** pool tick spacing (FloorBands.SPACING); 1 tick = ×1.0001 in price */
  tickSpacing: 60,
} as const;
export interface FloorBandRange { i: number; a: number; b: number; bps: number }
/** FloorBands.band(i) + ticks(): √price ranges below `s` (the base is the first spacing-aligned tick at/below spot,
 *  like FloorBands.baseTick for token = currency0, in the sim's own $/token tick domain). */
export function floorBandRanges(s: number): FloorBandRange[] {
  const F = FLOOR, ln = Math.log(1.0001), cur = Math.floor(2 * Math.log(s) / ln), base = Math.floor(cur / F.tickSpacing) * F.tickSpacing;
  const sAt = (tick: number) => Math.exp(tick * ln / 2), out: FloorBandRange[] = [];
  for (let i = 0; i < F.maxBands; i++) {
    let lo: number, hi: number, bps: number;
    if (i < F.flatBands) { const w = F.flatSpacings / F.flatBands; lo = w * i; hi = w * (i + 1); bps = F.flatBps / F.flatBands; }
    else { const j = i - F.flatBands, w = F.bottomSpacings / (F.maxBands - F.flatBands); lo = w * j; hi = w * (j + 1); bps = F.bottomBps[j]; }
    out.push({ i, a: sAt(base - hi * F.tickSpacing), b: Math.min(s, sAt(base - lo * F.tickSpacing)), bps });
  }
  return out;
}

export class Pool {
  L0: number; s: number; orders: RangeOrder[] = []; active: RangeOrder[] = [];
  /** locked graduation floor bands (USDG-only range liquidity that can never be removed) */
  floor: RangeOrder[] = [];
  constructor(X: number, Y: number) { this.L0 = Math.sqrt(X * Y); this.s = Math.sqrt(X / Y); }
  price() { return this.s * this.s; }
  /** full-range quote reserve (the locked LP) */
  get X() { return this.L0 * this.s; }
  get Y() { return this.L0 / this.s; }
  /** quote liquidity a trade meets around the price: full range + range orders the price is inside */
  depth() { return (this.L0 + this.liqUp(this.s)) * this.s; }
  private liqUp(s: number) { let L = 0; for (const o of this.active) if (o.a <= s && s < o.b) L += o.L; for (const o of this.floor) if (o.a <= s && s < o.b) L += o.L; return L; }
  private liqDown(s: number) { let L = 0; for (const o of this.active) if (o.a < s && s <= o.b) L += o.L; for (const o of this.floor) if (o.a < s && s <= o.b) L += o.L; return L; }
  private nextUp(s: number) { let n = Infinity; for (const l of [this.active, this.floor]) for (const o of l) { if (o.a > s && o.a < n) n = o.a; if (o.b > s && o.b < n) n = o.b; } return n; }
  private nextDown(s: number) { let n = 0; for (const l of [this.active, this.floor]) for (const o of l) { if (o.a < s && o.a > n) n = o.a; if (o.b < s && o.b > n) n = o.b; } return n; }
  /** LockedLP._seedFloor: budget × bps per band, USDG-only below spot (rounding dust stays out, like the bucket) */
  seedFloor(ranges: FloorBandRange[], budget: number) {
    if (!(budget > 0)) return;
    for (const r of ranges) { const amt = budget * r.bps / 10_000; if (!(amt > 0 && r.b > r.a && r.b <= this.s)) continue;
      this.floor.push({ id: -1 - r.i, owner: "FLOOR", kind: "tramp", a: r.a, b: r.b, L: amt / (r.b - r.a), status: "active", deposit: amt, sizeUsd: amt, basis: amt,
        placedT: 0, placedBlk: 0, crossedT: null, pullAt: null }); }
  }
  /** LockedLP.floorBands(token) mirror: USDG still resting and tokens bought, per band and in total */
  floorState() {
    const bands = this.floor.map((o) => ({ ...this.amounts(o), seeded: o.deposit, lo: o.a * o.a, hi: o.b * o.b }));
    const quote = bands.reduce((t, b) => t + b.quote, 0), tokens = bands.reduce((t, b) => t + b.tokens, 0), seeded = bands.reduce((t, b) => t + b.seeded, 0);
    return { bands, quote, tokens, seeded, absorbed: seeded - quote };
  }
  /** quote in (after fees) → tokens out; moves s up through any walls above */
  quoteBuy(quoteIn: number): SwapResult {
    let s = this.s, left = quoteIn, out = 0;
    for (let guard = 0; left > 1e-12 && guard < 512; guard++) {
      const L = this.L0 + this.liqUp(s), nb = this.nextUp(s), need = L * (nb - s);
      if (left <= need) { const s1 = s + left / L; out += L * (1 / s - 1 / s1); s = s1; left = 0; }
      else { out += L * (1 / s - 1 / nb); left -= need; s = nb; }
    }
    return { out, s };
  }
  /** tokens in → quote out (before fees); moves s down through any tramps below */
  quoteSell(tokensIn: number): SwapResult {
    let s = this.s, left = tokensIn, out = 0;
    for (let guard = 0; left > 1e-12 && guard < 512; guard++) {
      const L = this.L0 + this.liqDown(s), nb = this.nextDown(s), need = nb > 0 ? L * (1 / nb - 1 / s) : Infinity;
      if (left <= need) { const s1 = 1 / (1 / s + left / L); out += L * (s - s1); s = s1; left = 0; }
      else { out += L * (s - nb); left -= need; s = nb; }
    }
    return { out, s };
  }
  buy(quoteIn: number) { const r = this.quoteBuy(quoteIn); this.s = r.s; return r.out; }
  sell(tokensIn: number) { const r = this.quoteSell(tokensIn); this.s = r.s; return r.out; }
  /** what an order holds right now */
  amounts(o: RangeOrder, s = this.s) { const c = Math.min(Math.max(s, o.a), o.b); return { quote: o.L * (c - o.a), tokens: o.L * (1 / c - 1 / o.b) }; }
  /** TrampWallManager.isFilled: the price has crossed the whole range */
  isFilled(o: RangeOrder) { return o.status === "active" && (o.kind === "tramp" ? this.s <= o.a : this.s >= o.b); }
  /** placement rule of TrampWallManager._place (strictly single-sided) */
  canPlace(kind: OrderKind, a: number, b: number): string | null {
    if (!(a > 0 && b > a)) return "bad range";
    if (kind === "tramp" && this.s < b) return "Tramp must sit fully BELOW the current price";
    if (kind === "wall" && this.s >= a) return "Wall must sit fully ABOVE the current price";
    return null;
  }
  /** add a range order; deposit = quote (tramp) or tokens (wall) */
  place(o: Omit<RangeOrder, "L" | "status" | "crossedT" | "pullAt">): RangeOrder | string {
    const why = this.canPlace(o.kind, o.a, o.b); if (why) return why;
    if (!(o.deposit > 0)) return "zero amount";
    const L = o.kind === "tramp" ? o.deposit / (o.b - o.a) : o.deposit / (1 / o.a - 1 / o.b);
    const r: RangeOrder = { ...o, L, status: "active", crossedT: null, pullAt: null };
    this.orders.push(r); this.active.push(r); return r;
  }
  /** remove liquidity (cancel or pull): returns the gross amounts and the keeper's tip */
  remove(o: RangeOrder, tipBps: number) {
    const g = this.amounts(o), f = tipBps / 10_000;
    this.active = this.active.filter((x) => x !== o);
    return { quote: g.quote * (1 - f), tokens: g.tokens * (1 - f), tipQuote: g.quote * f, tipTokens: g.tokens * f };
  }
}
