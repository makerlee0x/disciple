/**
 * PAPER TRADING round engine: one seeded, deterministic, in-memory lobby (1 player + N bots, one simulated coin).
 * Pure TS, no DOM / network — runs in the browser (or a Worker) today and can run unchanged in a game server later.
 *
 * Real mechanics, imported (not copied):
 *   lib/sim/market Market  — float mirror of CurveMath.sol steep curve #1 ($3,333 → $33,333, 84.24% sold, graduation
 *                            into the v4-style pool) incl. the 1% fee and the per-second sniper tax table (FeeMath.snipeBps);
 *   lib/sim/config LAUNCH  — the launch constants (lib/config CURVE + lib/curveMath = Constants.sol);
 *   lib/modeRules          — per-wallet holding cap (BondingCurve.netCapNow: linear in mcap $3,333 → $33,333);
 *   crew tip               — BondingCurve._crewTip / _pveOnSell (Easy coins): 0.777% of net sell proceeds when realized
 *                            profit > crewTipThresholdBps × pre-sale mcap, shared over the other holders' NET.
 * Paper-only additions (spec): $0.25 sample gas per trade (out of cash, never into the curve), rounds, scoring.
 */
import { cloneConfig, LAUNCH } from "../sim/config";
import { Market } from "../sim/market";
import { mulberry32 } from "../sim/run";
import { CAP_MCAP_END_USD, CAP_MCAP_START_USD, HOLDING_CAP_BPS, MODE } from "../modeRules";
import {
  NOISE_TRADE_SHARE, SIZE_SCALE, brainFor, LOBBY_MIX, NAME_A, NAME_B, PHASES, RATING_BAND, TIER_ARCHETYPES, matchConfig,
  type Archetype, type BrainParams, type Difficulty, type MatchConfig, type Tier,
} from "./config";

/** Constants.PVE_CREW_TIP_PPM */
export const CREW_TIP_PPM = 7770;
export const PLAYER_ID = 0;

export interface Wallet {
  id: number; kind: "human" | "bot"; displayName: string; tier?: Tier; archetype?: Archetype; paperRating?: number;
  cash: number; tokens: number; /** net quote basis on the curve (BondingCurve _acct.cost) */ cost: number;
  realizedPnl: number; feesPaid: number; gasPaid: number; snipeTaxPaid: number; tipsPaid: number; tipsReceived: number;
  trades: number; buys: number; sells: number; frozen?: boolean;
}
export interface Trade {
  id: number; walletId: number; side: "buy" | "sell"; cashAmount: number; tokenAmount: number; price: number;
  fee: number; gasFee: number; snipeTax: number; crewTip: number; capped: boolean; tick: number; t: number; mcapAfter: number;
  /** realized PnL of a sell (net proceeds − cost basis); 0 for buys */
  pnl: number;
}
export interface Standing {
  rank: number; walletId: number; displayName: string; kind: "human" | "bot"; tier?: Tier; archetype?: Archetype; paperRating?: number;
  finalNetWorth: number; cash: number; holdingsMarked: number; exitCost: number; realizedPnl: number; feesPaid: number; gasPaid: number;
}
export type EndReason = "timer" | "graduation" | "player_ended";
export type Intent = { kind: "buy"; amountUsd: number } | { kind: "sell"; pct: number };

interface Bot extends Wallet { p: BrainParams; phase: number; react: number; activeAt: number; peak: number; pos0: number; ladderHit: number; entryT: number; lastPrice: number; lastTradeT: number }

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

export class PaperRound {
  cfg: MatchConfig; seed: number; m: Market; rng: () => number;
  wallets: Wallet[] = []; trades: Trade[] = [];
  tick = 0; ticks: number; ended: EndReason | null = null; gradT: number | null = null;
  /** mcap after each tick (index = tick) */
  path: number[] = [];
  phaseLog: { id: string; t: number; mood: number; vol: number }[] = [];
  phaseIdx = -1; mood = 0; vol = 1;
  private q: Intent[] = []; private intentTimes: number[] = [];
  private vwapNum = 0; private vwapDen = 0;
  totals = { fees: 0, gas: 0, snipeTax: 0, crewTips: 0, snipeHits: 0, rejected: 0, capped: 0 };
  leaderLog: { t: number; walletId: number }[] = [];
  startMoney: number;

  constructor(difficulty: Difficulty, seed: number, over: Partial<MatchConfig> = {}) {
    this.cfg = matchConfig(difficulty, over); this.seed = seed >>> 0; this.rng = mulberry32(this.seed);
    this.m = new Market(cloneConfig());
    this.ticks = Math.round(this.cfg.durationSec * 1000 / this.cfg.tickMs);
    this.wallets.push(this.newWallet(PLAYER_ID, "human", "YOU"));
    this.spawnBots();
    this.startMoney = this.wallets.length * this.cfg.startCash;
    this.buildPhases();
    this.path.push(this.m.mcap());
  }

  get t() { return this.tick * this.cfg.tickMs / 1000; }
  get player() { return this.wallets[PLAYER_ID]; }
  get price() { return this.m.price(); }
  get mcap() { return this.m.mcap(); }
  get pctSold() { return this.m.sold / this.m.S * 100; }
  get toGraduation() { return Math.max(0, this.m.reserveAt(1) - this.m.reserveAt(this.m.g)); }
  get graduated() { return this.m.phase === "pool"; }
  get curveReserve() { return this.m.reserveAt(this.graduated ? 1 : this.m.g); }

  private newWallet(id: number, kind: "human" | "bot", displayName: string): Wallet {
    return { id, kind, displayName, cash: this.cfg.startCash, tokens: 0, cost: 0, realizedPnl: 0, feesPaid: 0, gasPaid: 0,
      snipeTaxPaid: 0, tipsPaid: 0, tipsReceived: 0, trades: 0, buys: 0, sells: 0 };
  }

  private spawnBots() {
    const n = this.cfg.botCount, mix = LOBBY_MIX[this.cfg.difficulty];
    const tiers: Tier[] = ["easy", "medium", "hard"];
    const counts = tiers.map((t) => Math.round(mix[t] * n / 200)); counts[1] += n - counts.reduce((a, b) => a + b, 0);
    const used = new Set<string>(); let id = 1;
    tiers.forEach((tier, ti) => {
      const arch = TIER_ARCHETYPES[tier];
      for (let k = 0; k < counts[ti]; k++) {
        let r = this.rng(), a: Archetype = arch[arch.length - 1][0];
        for (const [aa, w] of arch) { if (r < w) { a = aa; break; } r -= w; }
        const base = brainFor(tier, a), p = this.jitter(base);
        let name = ""; do { name = `${NAME_A[Math.floor(this.rng() * NAME_A.length)]}${NAME_B[Math.floor(this.rng() * NAME_B.length)]}${10 + Math.floor(this.rng() * 90)}`; } while (used.has(name));
        used.add(name);
        const [r0, r1] = RATING_BAND[tier];
        const w = this.newWallet(id++, "bot", name) as Bot;
        Object.assign(w, { tier, archetype: a, paperRating: Math.round(r0 + this.rng() * (r1 - r0)), p,
          phase: Math.floor(this.rng() * Math.max(1, Math.round(p.intervalS * 1000 / this.cfg.tickMs))),
          react: Math.round((p.reactMs[0] + this.rng() * (p.reactMs[1] - p.reactMs[0])) / this.cfg.tickMs),
          activeAt: p.activeFrom[0] + this.rng() * (p.activeFrom[1] - p.activeFrom[0]),
          peak: 0, pos0: 0, ladderHit: 0, entryT: 0, lastPrice: 0, lastTradeT: -1e9 });
        this.wallets.push(w);
      }
    });
  }
  /** ±12% per numeric parameter, seeded (spec Sec. 6) */
  private jitter(b: BrainParams): BrainParams {
    const j = (x: number) => x * (1 + (this.rng() * 2 - 1) * 0.12);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === "number" && k !== "noise") out[k] = j(v);
      else if (Array.isArray(v) && typeof v[0] === "number") out[k] = (v as number[]).map(j);
      else if (Array.isArray(v)) out[k] = (v as [number, number][]).map(([g, f]) => [j(g), f]);
      else out[k] = v;
    }
    out.noise = b.noise * (1 + (this.rng() * 2 - 1) * 0.12);
    return out as unknown as BrainParams;
  }
  private phases: { id: string; start: number; mood: number; vol: number }[] = [];
  private buildPhases() {
    this.phases = PHASES.map((ph, i) => ({ id: ph.id, start: i === 0 ? 0 : ph.start + (this.rng() * 30 - 15),
      mood: ph.mood[0] + this.rng() * (ph.mood[1] - ph.mood[0]), vol: ph.vol }));
  }

  /* ---------------- ledger / execution: ONE path for human and bot trades ---------------- */
  capTokensNow(): number {
    const c = HOLDING_CAP_BPS[this.cfg.coinMode];
    if (!c || this.graduated) return Infinity;
    const mc = this.m.mcap(), S = this.m.S;
    if (mc <= CAP_MCAP_START_USD) return S * c.start / 10_000;
    if (mc >= CAP_MCAP_END_USD) return S * c.end / 10_000;
    return S * c.start / 10_000 + S * (c.end - c.start) / 10_000 * (mc - CAP_MCAP_START_USD) / (CAP_MCAP_END_USD - CAP_MCAP_START_USD);
  }
  buy(w: Wallet, usd: number): Trade | null {
    const gas = this.cfg.gasFeeFlat;
    usd = Math.min(usd, w.cash - gas);
    if (this.ended || w.frozen || !(usd >= 0.01)) { this.totals.rejected++; return null; }
    const pre = { cap: this.m.cap };
    const cap = this.capTokensNow(); this.m.cap = cap;
    const snipe = this.m.phase === "curve" ? this.m.antiSnipe(this.t) : 0;
    const f = this.m.buy(usd, this.t, w.tokens);
    this.m.cap = pre.cap;
    if (!f.ok || !(f.tokens > 0)) { this.totals.rejected++; return null; }
    const spent = f.usd, fee = spent * this.m.fee, tax = spent * snipe, net = spent - fee - tax;
    w.cash -= spent + gas; if (w.cash < 0 && w.cash > -1e-9) w.cash = 0;
    w.tokens += f.tokens; w.cost += net;
    if (w.kind === "bot") { const b = w as Bot; if (b.ladderHit === 0) b.pos0 = w.tokens; b.peak = Math.max(b.peak, this.m.price()); } w.feesPaid += fee; w.gasPaid += gas; w.snipeTaxPaid += tax; w.trades++; w.buys++;
    this.totals.fees += fee; this.totals.gas += gas; this.totals.snipeTax += tax; if (tax > 0) this.totals.snipeHits++;
    const capped = spent < usd - 1e-9 && !f.graduated; if (capped) this.totals.capped++;
    this.vwapNum += net; this.vwapDen += f.tokens;
    return this.log(w, "buy", spent, f.tokens, fee, gas, tax, 0, capped, 0, !!f.graduated);
  }
  sell(w: Wallet, tokens: number): Trade | null {
    const gas = this.cfg.gasFeeFlat;
    tokens = Math.min(tokens, w.tokens);
    if (this.ended || w.frozen || !(tokens > 1e-9)) { this.totals.rejected++; return null; }
    const preMcap = this.m.mcap();
    const gross = this.quoteSellGross(tokens), fee = gross * this.m.fee, netOut = gross - fee;
    const costPortion = tokens >= w.tokens - 1e-12 ? w.cost : w.cost * tokens / w.tokens;
    let tip = 0;
    if (this.cfg.coinMode === MODE.EASY && !this.graduated && netOut - costPortion > preMcap * this.cfg.crewTipThresholdBps / 10_000)
      tip = netOut * CREW_TIP_PPM / 1e6;
    if (w.cash + netOut - tip < gas) { this.totals.rejected++; return null; }   // never negative cash
    const f = this.m.sell(tokens);
    if (!f.ok) { this.totals.rejected++; return null; }
    w.tokens -= tokens; if (w.tokens < 1e-9) w.tokens = 0; w.cost -= costPortion;
    if (w.tokens === 0) { w.cost = 0; if (w.kind === "bot") { const b = w as Bot; b.ladderHit = 0; b.peak = 0; b.pos0 = 0; } }
    w.cash += netOut - tip - gas; w.feesPaid += fee; w.gasPaid += gas; w.tipsPaid += tip; w.trades++; w.sells++;
    const pnl = netOut - tip - costPortion; w.realizedPnl += pnl;
    this.totals.fees += fee; this.totals.gas += gas; this.totals.crewTips += tip;
    if (tip > 0) this.shareTip(w, tip);
    this.vwapNum -= costPortion; this.vwapDen -= tokens;
    return this.log(w, "sell", gross, tokens, fee, gas, 0, tip, false, pnl, false);
  }
  /** _distributeTax: tip × theirNet / othersNet, paid to every other holder (ASSUMPTION: auto-claimed into cash).
   *  Nobody else holding → treasury (audit L6), i.e. it leaves the lobby. */
  private shareTip(seller: Wallet, tip: number) {
    let others = 0; for (const w of this.wallets) if (w !== seller) others += w.tokens;
    if (others <= 0) return;
    for (const w of this.wallets) if (w !== seller && w.tokens > 0) { const s = tip * w.tokens / others; w.cash += s; w.tipsReceived += s; }
    this.totals.crewTips -= tip;   // stayed inside the lobby
  }
  private quoteSellGross(tokens: number) {
    if (this.m.pool) return this.m.pool.quoteSell(tokens).out;
    const g0 = this.m.g, g1 = Math.max(0, (this.m.sold - tokens) / this.m.sC);
    return this.m.reserveAt(g0) - this.m.reserveAt(g1);
  }
  private log(w: Wallet, side: "buy" | "sell", cash: number, tok: number, fee: number, gas: number, tax: number, tip: number, capped: boolean, pnl: number, grad: boolean): Trade {
    const tr: Trade = { id: this.trades.length, walletId: w.id, side, cashAmount: cash, tokenAmount: tok, price: cash / tok, fee, gasFee: gas,
      snipeTax: tax, crewTip: tip, capped, tick: this.tick, t: this.t, mcapAfter: this.m.mcap(), pnl };
    this.trades.push(tr);
    if (grad && this.gradT == null) { this.gradT = this.t; this.ended = "graduation"; }
    return tr;
  }

  /* ---------------- player intents (validated, rate-limited; applied in tick order like any trade) ---------------- */
  intent(i: Intent): boolean {
    if (this.ended || this.player.frozen) return false;
    const now = this.t; this.intentTimes = this.intentTimes.filter((x) => now - x < 1);
    if (this.intentTimes.length >= this.cfg.maxIntentsPerSec) return false;
    if (i.kind === "buy" && !(i.amountUsd > 0)) return false;
    if (i.kind === "sell" && !(i.pct > 0 && i.pct <= 100)) return false;
    this.intentTimes.push(now); this.q.push(i); return true;
  }
  /** Quit and Leave: wallet frozen, lobby runs on, still scored */
  leave() { this.player.frozen = true; this.q = []; }
  /** Quit and End Session: standings freeze now */
  endSession() { if (!this.ended) this.ended = "player_ended"; }

  /* ---------------- tick ---------------- */
  step() {
    if (this.ended) return;
    this.tick++;
    const t = this.t;
    let pi = this.phaseIdx; while (pi + 1 < this.phases.length && t >= this.phases[pi + 1].start) pi++;
    if (pi !== this.phaseIdx) { this.phaseIdx = pi; const ph = this.phases[pi]; this.mood = ph.mood; this.vol = ph.vol; this.phaseLog.push({ id: ph.id, t, mood: ph.mood, vol: ph.vol }); }
    // collect due actions: bots whose stagger slot is this tick + queued player intents; shuffle (seeded) so the player
    // is not systematically first or last
    const acts: (() => void)[] = [];
    for (let i = 1; i < this.wallets.length; i++) {
      const b = this.wallets[i] as Bot, every = Math.max(1, Math.round(b.p.intervalS * 1000 / this.cfg.tickMs));
      if (t >= b.activeAt && (this.tick + b.phase) % every === 0) acts.push(() => this.decide(b));
    }
    for (const i of this.q) acts.push(() => this.applyIntent(i));
    this.q = [];
    for (let i = acts.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [acts[i], acts[j]] = [acts[j], acts[i]]; }
    for (const a of acts) { if (this.ended) break; a(); }
    this.path.push(this.m.mcap());
    if (this.tick % 4 === 0) { const s = this.standings(); const lead = s[0].walletId; if (!this.leaderLog.length || this.leaderLog[this.leaderLog.length - 1].walletId !== lead) this.leaderLog.push({ t, walletId: lead }); }
    if (!this.ended && this.tick >= this.ticks) this.ended = "timer";
  }
  private applyIntent(i: Intent) {
    const p = this.player;
    if (i.kind === "buy") this.buy(p, i.amountUsd); else this.sell(p, p.tokens * i.pct / 100);
  }
  run() { while (!this.ended) this.step(); return this; }

  /* ---------------- the ONE bot brain ---------------- */
  /** mcap as the bot sees it: `react` ticks stale (reaction delay), never the future */
  private seen(b: Bot, backS = 0) { const k = this.path.length - 1 - b.react - Math.round(backS * 1000 / this.cfg.tickMs); return this.path[Math.max(0, k)]; }
  private decide(b: Bot) {
    const p = b.p, now = this.seen(b), price = now / this.m.S;
    const value = b.tokens * price;
    if (b.tokens > 0) b.peak = Math.max(b.peak, price);
    if (this.t - b.lastTradeT < p.cooldownS) return;
    const n0 = this.trades.length;
    this.decideInner(b, now, price, value);
    if (this.trades.length > n0) b.lastTradeT = this.t;
  }
  private decideInner(b: Bot, now: number, price: number, value: number) {
    const p = b.p, r = this.rng;
    // noise injection (Decide + Size)
    if (r() < p.noise * NOISE_TRADE_SHARE * this.vol) {
      if (b.tokens > 0 && r() < 0.4 && !p.neverSell) this.sell(b, b.tokens * (0.25 + r() * 0.75));
      else if (b.cash > 1) this.buy(b, this.sizeBuy(b, 0.3 + r() * 0.7));
      return;
    }
    // risk rules first
    if (b.tokens > 0 && !p.neverSell) {
      const gain = b.cost > 0 ? (value * (1 - this.m.fee)) / b.cost - 1 : 0;
      const stopHit = p.stop === "panic" || p.stop === "fixed" ? gain < -p.stopPct : p.stop === "trail" ? price < b.peak * (1 - p.stopPct) && gain > -0.5 : false;
      if (stopHit && !(p.stop === "panic" && b.archetype === "fomo")) { this.exitAll(b); return; }
      if (p.firstRed && now < this.seen(b, 0.5) * 0.997) { this.exitAll(b); return; }
      if (b.ladderHit < p.ladder.length && gain > p.ladder[b.ladderHit][0]) {
        const frac = p.ladder[b.ladderHit][1]; b.ladderHit++;
        this.sell(b, Math.min(b.tokens, frac >= 0.999 ? b.tokens : b.pos0 * frac)); return;
      }
      if (p.maxHoldS > 0 && this.t - b.entryT > p.maxHoldS) { this.exitAll(b); return; }
      if (p.scaleOutNearGrad && this.m.g > 0.8 && now < this.seen(b, 3) && r() < 0.5) { this.sell(b, b.tokens / 3); return; }
    }
    const s = this.score(b, now);
    if (s > p.buyTh && b.cash > p.minTradeUsd + this.cfg.gasFeeFlat) {
      if (p.curveAware >= 1 && this.t < LAUNCH.antiSnipeDurationS + 1) return;        // knows the sniper tax
      if (p.curveAware >= 2 && this.m.g > 0.9) return;                                 // no fresh entries at the top
      const usd = this.sizeBuy(b, Math.min(1, (s - p.buyTh) / (1 - p.buyTh) + 0.3));
      if (usd >= Math.max(1, p.minTradeUsd)) this.buy(b, usd);
    } else if (s < p.sellTh && b.tokens > 0 && !p.neverSell) {
      this.sell(b, p.curveAware >= 2 ? b.tokens / 2 : b.tokens);
    }
  }
  private exitAll(b: Bot) { this.sell(b, b.tokens); }
  private score(b: Bot, now: number) {
    const p = b.p;
    let mom = 0; for (const w of p.windows) mom += clamp((now / this.seen(b, w) - 1) / 0.05);
    mom /= p.windows.length;
    let rev = 0;
    if (p.vwap && this.vwapDen > 0) { const vw = this.vwapNum / this.vwapDen * this.m.S; rev = clamp((vw / now - 1) / Math.max(0.02, p.dipPct * 2)); }
    else if (p.dipPct > 0) { let hi = now; for (let k = 1; k <= 30; k += 2) hi = Math.max(hi, this.seen(b, k)); rev = now < hi * (1 - p.dipPct) ? 1 : 0; }
    const g = this.m.g;
    // Medium: % sold only (prefers early curve). Hard: reads flow too — rides a curve that is being bought toward ASCEND,
    // backs off at the very top where a full-bag exit would eat pool slippage.
    const flow = clamp((now / this.seen(b, 10) - 1) / 0.05);
    const curve = p.curveAware === 1 ? clamp(0.5 - g) : p.curveAware === 2 ? (g < 0.85 ? 0.6 * flow : -0.6) : 0;
    const jitter = (this.rng() * 2 - 1) * 0.15 * this.vol;
    return p.wMom * mom + p.wRev * rev + p.wCurve * curve + p.wMood * this.mood + jitter;
  }
  private sizeBuy(b: Bot, conviction: number) {
    const p = b.p, price = this.m.price();
    const room = Math.max(0, p.maxPos * p.maxEntries * this.cfg.startCash - b.tokens * price);
    const capRoom = Math.max(0, this.capTokensNow() - b.tokens) * price * 0.98;   // reads its own cap like the HUD rules line
    const k = SIZE_SCALE[this.cfg.difficulty];
    let usd = Math.min(b.cash - this.cfg.gasFeeFlat, room, capRoom, this.cfg.startCash * k * (p.size[0] + (p.size[1] - p.size[0]) * conviction));
    if (p.roundAmounts) { const lim = Math.min(b.cash - this.cfg.gasFeeFlat, capRoom), presets = [10, 25, 50, 100].filter((x) => x <= lim); usd = presets.length ? presets.reduce((a, x) => (Math.abs(x - usd) < Math.abs(a - usd) ? x : a)) : 0; }
    if (usd > 0 && b.tokens === 0) { b.ladderHit = 0; b.entryT = this.t; }
    return Math.max(0, usd);
  }

  /* ---------------- scoring (spec Sec. 2) ---------------- */
  /** net worth = cash + tokens × final price − exit cost (fee + gas + slippage to dump the whole bag at end state)
   *  = cash + (gross sell quote − fee − gas), floored at cash */
  netWorth(w: Wallet) {
    if (w.tokens <= 0) return { nw: w.cash, marked: 0, exit: 0 };
    const marked = w.tokens * this.m.price(), gross = this.quoteSellGross(w.tokens), net = gross * (1 - this.m.fee) - this.cfg.gasFeeFlat;
    const exit = marked - Math.max(0, net);
    return { nw: w.cash + marked - exit, marked, exit };
  }
  standings(): Standing[] {
    const rows = this.wallets.map((w) => { const n = this.netWorth(w); return { w, ...n }; });
    rows.sort((a, b) => {
      const ca = Math.round(a.nw * 100), cb = Math.round(b.nw * 100);
      if (cb !== ca) return cb - ca;
      if (b.w.realizedPnl !== a.w.realizedPnl) return b.w.realizedPnl - a.w.realizedPnl;   // tie: realized PnL
      const fa = a.w.feesPaid + a.w.gasPaid, fb = b.w.feesPaid + b.w.gasPaid;
      return fa - fb || a.w.id - b.w.id;                                                     // then fewer fees
    });
    return rows.map((r, i) => ({ rank: i + 1, walletId: r.w.id, displayName: r.w.displayName, kind: r.w.kind, tier: r.w.tier,
      archetype: r.w.archetype, paperRating: r.w.paperRating, finalNetWorth: r.nw, cash: r.w.cash, holdingsMarked: r.marked,
      exitCost: r.exit, realizedPnl: r.w.realizedPnl, feesPaid: r.w.feesPaid, gasPaid: r.w.gasPaid }));
  }
  /** money conservation: wallets' cash + curve reserve + fees + gas + sniper tax + tips that left the lobby = start */
  moneyCheck() {
    const cash = this.wallets.reduce((a, w) => a + w.cash, 0);
    const pool = this.graduated ? this.m.reserveAt(1) : this.m.reserveAt(this.m.g);
    return { start: this.startMoney, accounted: cash + pool + this.totals.fees + this.totals.gas + this.totals.snipeTax + this.totals.crewTips };
  }
  tokenCheck() { return { held: this.wallets.reduce((a, w) => a + w.tokens, 0), sold: this.m.sold }; }
}

