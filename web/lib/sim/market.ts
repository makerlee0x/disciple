/**
 * Local market: the Launchpad bonding curve (float mirror of contracts/src/libraries/CurveMath.sol)
 * and, after graduation, a v4-style pool seeded at the curve-end price (Migration.sol: "initialize pool at
 * curve-end sqrtPriceX96 (no jump)") with tramps & walls as concentrated range orders (./pool.ts).
 * No chain, no RPC.
 *
 * Curve: virtual reserves x (quote), y (tokens): x = x0·y0 / (y0 − sold), y = y0 − sold, spot = x / y.
 *   y0 = sCurve·√r / (√r − 1), r = M1/M0; x0 = (M0/S)·y0  → mcap(0) = $7,777, mcap(sCurve) = $33,333.
 * Buys pay 1% + anti-snipe (77.7% → 0 over 7 s) before the curve; sells pay 1% from the output.
 * Wallet cap: launch.walletCapBps (0 = none — the live Launchpad default, Constants.WALLET_CAP_BPS_DEFAULT).
 */
import type { SimConfig } from "./config";
import { Pool } from "./pool";

export interface Fill { ok: boolean; reason?: string; tokens: number; usd: number; /** gross $ per token (applyFill price) */ price: number; preMcap: number; postMcap: number; graduated?: boolean }

export class Market {
  S: number; sC: number; x0: number; y0: number; sold = 0;
  phase: "curve" | "pool" = "curve";
  pool: Pool | null = null;
  fee: number; poolFee: number; cap: number;
  gradAt: number | null = null;
  constructor(public cfg: SimConfig) {
    const L = cfg.launch;
    this.S = L.totalSupply; this.sC = L.totalSupply * L.curveSoldBps / 10_000;
    const r = L.graduationMcapUsd / L.startMcapUsd, sr = Math.sqrt(r);
    this.y0 = this.sC * sr / (sr - 1);
    this.x0 = (L.startMcapUsd / L.quotePriceUsd) / this.S * this.y0;
    this.fee = L.tradeFeeBps / 10_000; this.poolFee = L.poolFeeBps / 10_000;
    this.cap = L.walletCapBps > 0 ? L.totalSupply * L.walletCapBps / 10_000 : Infinity;
  }
  /** full-range pool reserves (0 before graduation) */
  get X() { return this.pool ? this.pool.X : 0; }
  get Y() { return this.pool ? this.pool.Y : 0; }
  price() { if (this.pool) return this.pool.price(); const y = this.y0 - this.sold; return (this.x0 * this.y0 / y) / y; }
  mcap() { return this.price() * this.S * this.cfg.launch.quotePriceUsd; }
  /** quote depth ($) — what a trade's size is measured against (pool: incl. range orders the price sits in) */
  depth() { return this.pool ? this.pool.depth() : this.x0 * this.y0 / (this.y0 - this.sold); }
  antiSnipe(t: number) { const L = this.cfg.launch; return t >= L.antiSnipeDurationS ? 0 : (L.antiSnipeStartBps / 10_000) * (1 - t / L.antiSnipeDurationS); }
  /** price ratio after a trade of usd (used for the engine's optimistic ghost + tier-bar maths).
   *  Pool phase: an exact dry run through the range orders (walls slow buys, tramps slow sells). */
  impact(usd: number, side: "buy" | "sell") {
    if (!(usd > 0)) return 1;
    if (this.pool) { const p0 = this.pool.price(), s1 = side === "buy" ? this.pool.quoteBuy(usd * (1 - this.poolFee)).s : this.pool.quoteSell(usd / p0).s; return (s1 * s1) / p0; }
    const d = this.depth(); if (!(d > 0)) return 1;
    return side === "buy" ? Math.pow(1 + usd * (1 - this.fee) / d, 2) : 1 / Math.pow(1 + usd / d, 2);
  }
  buy(usd: number, t: number, holding: number): Fill {
    const pre = this.mcap();
    if (!(usd > 0)) return { ok: false, reason: "zero", tokens: 0, usd: 0, price: 0, preMcap: pre, postMcap: pre };
    let net = usd * (1 - this.fee - (this.phase === "curve" ? this.antiSnipe(t) : 0));
    let tokens = 0, spent = usd, graduated = false;
    if (this.phase === "curve") {
      const y = this.y0 - this.sold, x = this.x0 * this.y0 / y;
      tokens = y * net / (x + net);
      const rem = this.sC - this.sold;
      if (tokens > rem) {   // fills the curve exactly; the unspent quote is refunded
        const need = x * rem / (y - rem); spent = usd * need / net; net = need; tokens = rem; }
      const room = Math.max(0, this.cap - holding);
      if (tokens > room) { if (room <= 1) return { ok: false, reason: "wallet cap", tokens: 0, usd: 0, price: 0, preMcap: pre, postMcap: pre };
        const nNet = x * room / (y - room); spent = spent * nNet / net; net = nNet; tokens = room; }
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
      const y = this.y0 - this.sold, x = this.x0 * this.y0 / y;
      gross = x * tokens / (y + tokens); this.sold -= tokens;
    } else gross = this.pool!.sell(tokens);
    // proceeds net = gross·(1−fee); applyFill(sell) books tokens·price gross and the fee separately
    return { ok: true, tokens, usd: gross, price: gross / tokens, preMcap: pre, postMcap: this.mcap() };
  }
  graduate(t: number) {
    const p = this.price(), Y = this.S - this.sC;
    this.phase = "pool"; this.pool = new Pool(p * Y, Y); this.gradAt = t;
  }
}
