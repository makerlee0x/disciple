/**
 * Local market: the Launchpad bonding curve (float mirror of contracts/src/libraries/CurveMath.sol, steep curve #1)
 * and, after graduation, a v4-style pool seeded at the curve-end price (Migration.sol: "initialize pool at
 * curve-end sqrtPriceX96 (no jump)") with tramps & walls as concentrated range orders (./pool.ts) and the
 * graduation floor: 16 locked USDG-only bands below spot (LockedLP._seedFloor / FloorBands.sol).
 * No chain, no RPC.
 *
 * Curve #1 in g = sold / sCurve:  m(g) = M0 / (1 − a·g)² + T·g³⁰   (mcap, $)
 *   CP part: a = 1 − 1/√(MID/M0)  (M0 = $3,333 → MID = $15,000 at g = 1);  steep tail: T = M1 − MID ($18,333).
 *   → mcap(0) = $3,333, mcap(sCurve) = $33,333, 84.24% of supply sold. Reserve (cumulative net quote):
 *   R(g) = f·M0·g / (1 − a·g) + f·T·g³¹ / 31,  f = sCurve / S  (dR/dg = f·m(g));  R(1) ≈ $6,454.55.
 * Buys pay 1% + sniper tax (per-second table from launch config = FeeMath.snipeBps: 99 · 25 · 3 · 1 · 0.3 · 0.1 · 0.03 %
 *   in seconds 0–6, 0 from 7s, buys only) before the curve; sells pay 1% from the output.
 * Graduation (Migration + LockedLP.seedV4Position): full-range pairing = spot × (S − sCurve) ≈ $5,253 USDG with
 * 157,600 tokens; the curve reserve's leftover (R(1) − pairing ≈ $1,201) seeds the floor bands.
 * Wallet cap: launch.walletCapBps (0 = none — the live Launchpad default, Constants.WALLET_CAP_BPS_DEFAULT).
 */
import type { SimConfig } from "./config";
import { Pool, floorBandRanges } from "./pool";

export interface Fill { ok: boolean; reason?: string; tokens: number; usd: number; /** gross $ per token (applyFill price) */ price: number; preMcap: number; postMcap: number; graduated?: boolean }

export class Market {
  S: number; sC: number; sold = 0;
  /** curve #1 shape: m(g) = M0/(1 − a·g)² + T·g³⁰ ($ mcap), f = sCurve/S */
  M0: number; a: number; T: number; f: number;
  /** CP-part virtual reserves (CurveMath.makeParams x0, y0 in token / quote units; quote = $ here) */
  x0: number; y0: number;
  phase: "curve" | "pool" = "curve";
  pool: Pool | null = null;
  fee: number; poolFee: number; cap: number;
  gradAt: number | null = null;
  constructor(public cfg: SimConfig) {
    const L = cfg.launch;
    this.S = L.totalSupply; this.sC = L.totalSupply * L.curveSoldBps / 10_000;
    const M0 = L.startMcapUsd / L.quotePriceUsd, sr = Math.sqrt(L.curveMidMcapUsd / L.startMcapUsd);
    this.M0 = M0; this.f = this.sC / this.S; this.a = 1 - 1 / sr;
    this.T = L.graduationMcapUsd / L.quotePriceUsd - M0 * sr * sr;   // CurveMath.makeParams: tail = M1 − cpMcap(sCurve)
    this.y0 = this.sC * sr / (sr - 1);
    this.x0 = M0 / this.S * this.y0;
    this.fee = L.tradeFeeBps / 10_000; this.poolFee = L.poolFeeBps / 10_000;
    this.cap = L.walletCapBps > 0 ? L.totalSupply * L.walletCapBps / 10_000 : Infinity;
  }
  /** full-range pool reserves (0 before graduation) */
  get X() { return this.pool ? this.pool.X : 0; }
  get Y() { return this.pool ? this.pool.Y : 0; }
  /** curve mcap ($) at g */
  mcapAt(g: number) { return this.M0 / (1 - this.a * g) ** 2 + (g > 0 ? this.T * g ** 30 : 0); }
  /** curve reserve ($ net quote paid in) at g: ∫ price ds */
  reserveAt(g: number) { return this.f * this.M0 * g / (1 - this.a * g) + (g > 0 ? this.f * this.T * g ** 31 / 31 : 0); }
  /** g reached from g0 by `net` quote in (Newton on the convex reserve, clamped to the curve end) */
  gAfterQuote(g0: number, net: number) {
    const target = this.reserveAt(g0) + net; if (target >= this.reserveAt(1)) return 1;
    let lo = g0, hi = 1, g = Math.min(1, g0 + net / (this.f * this.mcapAt(g0)));
    for (let i = 0; i < 100; i++) {
      const r = this.reserveAt(g) - target; if (Math.abs(r) <= 1e-12 * Math.max(1, target)) break;
      if (r > 0) hi = g; else lo = g;
      let n = g - r / (this.f * this.mcapAt(g)); if (!(n > lo && n < hi)) n = (lo + hi) / 2; g = n;
    }
    return g;
  }
  get g() { return this.sold / this.sC; }
  price() { if (this.pool) return this.pool.price(); return this.mcapAt(this.g) / this.S; }
  mcap() { return this.price() * this.S * this.cfg.launch.quotePriceUsd; }
  /** quote depth ($) — what a trade's size is measured against (pool: incl. range orders the price sits in) */
  /** curve: the CP-equivalent local depth 2·m²·f / m′(g) (= the virtual quote reserve x on a pure CP curve; the
   *  steep tail makes it shallower near graduation, so the same $ moves the price more there) */
  depth() {
    if (this.pool) return this.pool.depth();
    const g = this.g, d = 1 - this.a * g, dm = 2 * this.a * this.M0 / d ** 3 + (g > 0 ? 30 * this.T * g ** 29 : 0), m = this.mcapAt(g);
    return 2 * m * m * this.f / dm;
  }
  antiSnipe(t: number) { const L = this.cfg.launch, e = Math.floor(t); return e >= L.antiSnipeDurationS ? 0 : (L.antiSnipeBpsBySec[e] ?? 0) / 10_000; } // = FeeMath.snipeBps
  /** price ratio after a trade of usd (used for the engine's optimistic ghost + tier-bar maths).
   *  Pool phase: an exact dry run through the range orders (walls slow buys, tramps slow sells). */
  impact(usd: number, side: "buy" | "sell") {
    if (!(usd > 0)) return 1;
    if (this.pool) { const p0 = this.pool.price(), s1 = side === "buy" ? this.pool.quoteBuy(usd * (1 - this.poolFee)).s : this.pool.quoteSell(usd / p0).s; return (s1 * s1) / p0; }
    const g0 = this.g, m0 = this.mcapAt(g0);
    if (side === "buy") return this.mcapAt(this.gAfterQuote(g0, usd * (1 - this.fee))) / m0;
    const tk = Math.min(this.sold, usd / this.price()); return this.mcapAt((this.sold - tk) / this.sC) / m0;
  }
  buy(usd: number, t: number, holding: number): Fill {
    const pre = this.mcap();
    if (!(usd > 0)) return { ok: false, reason: "zero", tokens: 0, usd: 0, price: 0, preMcap: pre, postMcap: pre };
    let net = usd * (1 - this.fee - (this.phase === "curve" ? this.antiSnipe(t) : 0));
    let tokens = 0, spent = usd, graduated = false;
    if (this.phase === "curve") {
      const g0 = this.g, r0 = this.reserveAt(g0), g1 = this.gAfterQuote(g0, net);
      tokens = g1 >= 1 ? this.sC - this.sold : (g1 - g0) * this.sC;
      if (g1 >= 1) {   // fills the curve exactly; the unspent quote is refunded
        const need = this.reserveAt(1) - r0; if (need < net) { spent = usd * need / net; net = need; } }
      const room = Math.max(0, this.cap - holding);
      if (tokens > room) { if (room <= 1) return { ok: false, reason: "wallet cap", tokens: 0, usd: 0, price: 0, preMcap: pre, postMcap: pre };
        const nNet = this.reserveAt(g0 + room / this.sC) - r0; spent = spent * nNet / net; net = nNet; tokens = room; }
      this.sold += tokens;
      if (this.sold >= this.sC - 1e-6) { this.graduate(t); graduated = true; }
    } else {
      net = usd * (1 - this.poolFee);
      tokens = this.pool!.buy(net);
    }
    // applyFill(buy) books tokens = usd·(1−FEE)/price → choose price so the ledger holds exactly `tokens`
    return { ok: true, tokens, usd: spent, price: spent * (1 - this.fee) / tokens, preMcap: pre, postMcap: this.mcap(), graduated };
  }
  sell(tokens: number): Fill {
    const pre = this.mcap();
    if (!(tokens > 0)) return { ok: false, reason: "zero", tokens: 0, usd: 0, price: 0, preMcap: pre, postMcap: pre };
    let gross: number;
    if (this.phase === "curve") {
      tokens = Math.min(tokens, this.sold);
      const g0 = this.g, g1 = (this.sold - tokens) / this.sC;
      gross = this.reserveAt(g0) - this.reserveAt(g1); this.sold -= tokens; if (this.sold < 1e-9) this.sold = 0;
    } else gross = this.pool!.sell(tokens);
    // proceeds net = gross·(1−fee); applyFill(sell) books tokens·price gross and the fee separately
    return { ok: true, tokens, usd: gross, price: gross / tokens, preMcap: pre, postMcap: this.mcap() };
  }
  /** Migration + LockedLP.seedV4Position: full-range pairing at the curve-end price, then the curve reserve's
   *  leftover seeds the 16 locked USDG-only floor bands (never removable; sells fill them, buys re-arm them). */
  graduate(t: number) {
    this.sold = this.sC;
    const p = this.price(), Y = this.S - this.sC, pairing = p * Y;
    this.phase = "pool"; this.pool = new Pool(pairing, Y); this.gradAt = t;
    this.floorBudget = Math.max(0, this.reserveAt(1) - pairing);
    this.pool.seedFloor(floorBandRanges(this.pool.s), this.floorBudget);
  }
  /** USDG the graduation floor was seeded with (curve reserve − full-range pairing) */
  floorBudget = 0;
}
