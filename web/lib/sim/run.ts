/**
 * SimRun — deterministic local market + bot traders (seeded). Pure TS, no DOM: the /sim page drives it on
 * a timer (speed 1×/2×/4×) and the headless test (scripts/test-sim.mjs) drives it as fast as it can.
 * The player's trades go through the same market and the same PnL ledger rules (lib/pnl.ts) as the bots.
 */
import { applyFill, emptyPosition, view, type Position } from "../pnl";
import { tierOf, TIERS, SIM_ACHIEVEMENTS, type ArchetypeId, type DifficultyId, type SimConfig } from "./config";
import { Market, type Fill } from "./market";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const seedOf = (s: string | number) => { if (typeof s === "number") return s >>> 0; let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

export interface Bot { id: number; name: string; wallet: string; arch: ArchetypeId; cash: number; cash0: number; pos: Position; cluster?: number;
  joinT: number; nextT: number; holdUntil?: number; active: boolean; buys: number; sells: number; volume: number }
export interface SimTrade { t: number; side: "buy" | "sell"; usd: number; tokens: number; mcap: number; preMcap: number; trader: string; arch: ArchetypeId | "you"; mine: boolean }
export interface SimEvent { t: number; kind: "launch" | "graduate" | "rug" | "cto" | "whale" | "tier"; text: string; mcap: number }

export class SimRun {
  rng: () => number; m: Market; t = 0; bots: Bot[] = []; trades: SimTrade[] = []; events: SimEvent[] = [];
  player: { cash: number; cash0: number; pos: Position; buys: number; sells: number; volume: number; firstBuyT: number | null; tokens: number };
  emaF: number; emaS: number; hist: number[] = []; histT = 0; peak: number; peakT = 0; peakTier = 0;
  lastPlayerBigBuy = -1e9; rugged: { t: number; peakBefore: number } | null = null; ctoAt: number | null = null; ctoActive = false;
  rugPlan: { at: number; minMcap: number } | null = null; ctoPlan: boolean; hype = 1; nextId = 1; listeners = new Set<(e: { trade?: SimTrade; event?: SimEvent }) => void>();
  constructor(public cfg: SimConfig, public difficulty: DifficultyId, public seed: number, opts: { balance?: number } = {}) {
    this.rng = mulberry32(seed);
    this.m = new Market(cfg);
    const p0 = this.m.price(); this.emaF = this.emaS = p0; this.peak = this.m.mcap();
    const bal = opts.balance ?? cfg.player.startBalanceUsd;
    this.player = { cash: bal, cash0: bal, pos: emptyPosition(), buys: 0, sells: 0, volume: 0, firstBuyT: null, tokens: 0 };
    const D = this.diff();
    this.hype = Math.exp(this.normal() * D.hypeSigma);
    const rug = D.rug;
    this.rugPlan = rug && this.rng() < rug.chance ? { at: rug.earliestS + this.rng() * (rug.latestS - rug.earliestS), minMcap: cfg.launch.startMcapUsd * rug.minMcap * (0.8 + this.rng() * 0.8) } : null;
    this.ctoPlan = !!rug && this.rng() < rug.ctoChance;
    let cluster = 0;
    for (const [a, n] of Object.entries(D.initial) as [ArchetypeId, number][]) for (let i = 0; i < n; i++) this.spawn(a, 0, a === "bundler" ? (cluster || (cluster = 1)) : undefined);
    this.emitEvent("launch", `LAUNCH · ${D.label} · seed ${seed}`);
  }
  diff() { return this.cfg.difficulties[this.difficulty]; }
  r(a: number, b: number) { return a + (b - a) * this.rng(); }
  normal() { return Math.sqrt(-2 * Math.log(this.rng() + 1e-12)) * Math.cos(6.283185307 * this.rng()); }
  spawn(arch: ArchetypeId, t: number, cluster?: number) {
    const A = this.cfg.archetypes[arch], id = this.nextId++;
    const cash = A.cash * Math.exp(this.normal() * A.cashSigma) * this.diff().size * Math.sqrt(this.hype);
    const nm = A.names[Math.floor(this.rng() * A.names.length)];
    let wallet = "0x"; for (let i = 0; i < 40; i++) wallet += Math.floor(this.rng() * 16).toString(16);
    if (cluster) wallet = "0xb0b" + (wallet.slice(5, 38)) + "c" + cluster.toString(16);   // clustered wallets share a visible prefix/suffix
    const name = arch === "bundler" ? `Bundle#${cluster}·${nm}` : arch === "rugger" ? "DEV" : arch === "cto" ? "CTO Council" : `${A.label.split(" ")[0]}·${nm}${id}`;
    const launchy = arch === "sniper" || arch === "bundler" || arch === "rugger";
    const b: Bot = { id, name, wallet, arch, cash, cash0: cash, pos: emptyPosition(), cluster, joinT: t, active: arch !== "cto",
      nextT: launchy && t === 0 ? this.cfg.launch.antiSnipeDurationS + this.r(0.2, arch === "rugger" ? 0.6 : 4) : t + this.r(0.5, t === 0 ? 8 : 60 / Math.max(0.1, A.rate)), buys: 0, sells: 0, volume: 0 };
    this.bots.push(b); return b;
  }
  on(f: (e: { trade?: SimTrade; event?: SimEvent }) => void) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emitEvent(kind: SimEvent["kind"], text: string) { const e = { t: this.t, kind, text, mcap: this.m.mcap() }; this.events.push(e); this.listeners.forEach((f) => f({ event: e })); }
  /** momentum, support/resistance (what bots see) */
  feat() {
    const p = this.m.price(), mom = this.emaF / this.emaS - 1;
    let lo = p, hi = p; for (const h of this.hist) { if (h < lo) lo = h; if (h > hi) hi = h; }
    const n = this.cfg.market.nearSR;
    return { p, mom, sup: lo, res: hi, nearSup: p <= lo * (1 + n), nearRes: p >= hi * (1 - n), playerHot: this.t - this.lastPlayerBigBuy < this.cfg.market.playerAttentionS };
  }
  private exec(side: "buy" | "sell", who: Bot | null, usdOrTokens: number): Fill {
    const pre = this.m.mcap(), wasCurve = this.m.phase === "curve";
    const holding = who ? who.pos.size : this.player.pos.size;
    const f = side === "buy" ? this.m.buy(usdOrTokens, this.t, holding) : this.m.sell(usdOrTokens);
    if (!f.ok) return f;
    const at = this.t * 1000, gas = who ? 0 : this.cfg.player.gasUsd;
    if (who) { who.pos = applyFill(who.pos, side, f.usd, f.price, 0, at); who.cash += side === "buy" ? -f.usd : f.usd * (1 - this.m.fee); who[side === "buy" ? "buys" : "sells"]++; who.volume += f.usd; }
    else { const P = this.player; P.pos = applyFill(P.pos, side, f.usd, f.price, gas, at); P.cash += (side === "buy" ? -f.usd : f.usd * (1 - this.m.fee)) - gas; P[side === "buy" ? "buys" : "sells"]++; P.volume += f.usd;
      if (side === "buy" && P.firstBuyT == null) P.firstBuyT = this.t; }
    const tr: SimTrade = { t: this.t, side, usd: f.usd, tokens: f.tokens, mcap: f.postMcap, preMcap: pre, trader: who ? who.name : "you", arch: who ? who.arch : "you", mine: !who };
    this.trades.push(tr); if (this.trades.length > 4000) this.trades.splice(0, 1000);
    this.listeners.forEach((l) => l({ trade: tr }));
    if (wasCurve && this.m.phase === "pool") this.emitEvent("graduate", `GRADUATED → pool at ${fmt(this.m.mcap())}`);
    if (who && f.usd > Math.max(3000, this.m.depth() * 0.25) && side === "buy") this.emitEvent("whale", `${who.name} apes ${fmt(f.usd)}`);
    return f;
  }
  /** Player trade (paper, local). sell: usd notional at spot, or frac of the bag. */
  playerTrade(side: "buy" | "sell", usd: number, o?: { frac?: number }): Fill & { mcap: number } {
    const P = this.player;
    if (side === "buy") {
      if (usd > P.cash + 1e-9) return { ok: false, reason: "insufficient sim balance", tokens: 0, usd: 0, price: 0, preMcap: this.m.mcap(), postMcap: this.m.mcap(), mcap: this.m.mcap() };
      const f = this.exec("buy", null, usd);
      if (f.ok && (f.usd >= this.cfg.market.playerBigBuyUsd || f.usd >= this.m.depth() * 0.02)) this.lastPlayerBigBuy = this.t;
      return { ...f, mcap: f.price * this.m.S };
    }
    if (P.pos.size <= 0) return { ok: false, reason: "no tokens to sell", tokens: 0, usd: 0, price: 0, preMcap: this.m.mcap(), postMcap: this.m.mcap(), mcap: this.m.mcap() };
    const tokens = o?.frac ? P.pos.size * Math.min(1, o.frac) : Math.min(P.pos.size, usd / this.m.price());
    const f = this.exec("sell", null, tokens);
    return { ...f, mcap: f.price * this.m.S };
  }
  private botBuy(b: Bot, frac: number) { const usd = Math.min(b.cash, b.cash * frac); if (usd >= 1) this.exec("buy", b, usd); }
  private botSell(b: Bot, frac: number) { let tk = b.pos.size * Math.min(1, frac); if (tk * this.m.price() < 1) tk = b.pos.size; if (tk > 0 && tk * this.m.price() >= 0.5) this.exec("sell", b, tk); }   // no dust sells
  private decide(b: Bot, F: ReturnType<SimRun["feat"]>) {
    const A = this.cfg.archetypes[b.arch], R = () => this.rng();
    const u = b.pos.size > 0 ? F.p / (b.pos.costBasis / b.pos.size) - 1 : 0, has = b.pos.size > 0, bf = () => this.r(A.buyFrac[0], A.buyFrac[1]), sf = () => this.r(A.sellFrac[0], A.sellFrac[1]);
    const age = this.t - b.joinT;
    switch (b.arch) {
      case "rugger": {   // dev: buys at launch (after anti-snipe), then waits for the rug plan
        if (!b.buys) return this.botBuy(b, bf());
        const rp = this.rugPlan; if (rp && !this.rugged && this.t >= rp.at && this.m.mcap() >= rp.minMcap) this.rug(b);
        return;
      }
      case "bundler": {
        if (!b.buys) return this.botBuy(b, bf());
        if (has && u > A.tp && R() < 0.35) return this.botSell(b, sf());   // drip distribution
        return;
      }
      case "sniper": {
        if (!b.buys && age < 30) return this.botBuy(b, bf());
        if (has && (u > A.tp * this.r(0.8, 1.6) || u < A.sl || (age > 120 && R() < 0.15))) return this.botSell(b, sf());
        if (!has && F.mom > 0.05 && R() < 0.15) return this.botBuy(b, 0.3);
        return;
      }
      case "cto": {
        if (has && u > A.tp && F.nearRes && R() < 0.3) return this.botSell(b, sf());
        if (b.cash > 1 && (F.nearSup || F.mom < 0.02 || R() < 0.5)) return this.botBuy(b, bf());
        return;
      }
    }
    // generic traders (crew, scalper, whale, momentum, paperhand, diamond)
    if (has && u >= A.tp && (A.resist === 0 || F.nearRes || R() < 0.5)) return this.botSell(b, sf());
    if (has && u <= A.sl) return this.botSell(b, 1);
    if (has && F.nearRes && A.resist > 0 && u > 0.15 && R() < A.resist * 0.35) return this.botSell(b, A.sellFrac[0]);
    if (has && b.arch === "momentum" && F.mom < -0.02 && R() < 0.6) return this.botSell(b, sf());
    if (has && (b.arch === "whale" || b.arch === "scalper") && F.playerHot && u > 0.1 && R() < 0.4) return this.botSell(b, sf());   // PvP: sell into the player's pump
    let w = 0.25 + A.dip * (F.nearSup ? 1 : F.mom < 0 ? 0.4 : 0) + A.chase * Math.max(-0.5, Math.min(2, F.mom * 25)) + (F.playerHot ? A.followPlayer : 0);
    if (b.arch === "scalper" && has) w = 0;
    if (b.arch === "crew" && F.nearRes) w *= 0.5;
    if (this.rugged && !this.ctoActive) w *= 0.25;
    if (b.cash >= 1 && R() < Math.min(0.95, w * 0.6)) return this.botBuy(b, bf());
  }
  private rug(dev: Bot) {
    this.rugged = { t: this.t, peakBefore: this.peak };
    this.botSell(dev, 1);
    for (const b of this.bots) if (b.arch === "bundler" && b.pos.size > 0) this.botSell(b, 1);
    this.emitEvent("rug", `RUG · dev + bundle dumped · ${fmt(this.m.mcap())}`);
    // panic: paper hands and momentum dump too
    for (const b of this.bots) if ((b.arch === "paperhand" || b.arch === "momentum") && b.pos.size > 0 && this.rng() < 0.7) this.botSell(b, 1);
    const D = this.diff().rug!;
    if (this.ctoPlan) this.ctoAt = this.t + this.r(D.ctoDelayS[0], D.ctoDelayS[1]);
  }
  /** advance the simulation by dt seconds (internally in 100 ms blocks) */
  step(dt: number) {
    const B = this.cfg.market.blockS;
    for (let left = dt; left > 1e-9; left -= B) this.block(Math.min(B, left));
  }
  private block(dt: number) {
    this.t += dt;
    const D = this.diff(), M = this.cfg.market;
    if (this.ctoAt != null && !this.ctoActive && this.t >= this.ctoAt) {
      this.ctoActive = true; const c = this.bots.find((b) => b.arch === "cto") || this.spawn("cto", this.t); c.active = true; c.nextT = this.t;
      this.emitEvent("cto", `CTO · community takeover at ${fmt(this.m.mcap())}`);
    }
    const F = this.feat();
    for (const b of this.bots) {
      if (!b.active || this.t < b.nextT) continue;
      const A = this.cfg.archetypes[b.arch];
      b.nextT = this.t + (60 / Math.max(0.05, A.rate * D.activity)) * (-Math.log(this.rng() + 1e-12));
      this.decide(b, F);
    }
    // arrivals: attention follows momentum and altitude; a rug kills it until a CTO
    const att = Math.max(0.2, 1 + 6 * Math.max(-0.1, F.mom)) * (this.rugged && !this.ctoActive ? 0.15 : 1) * (this.ctoActive ? D.rug?.ctoArrivalBoost ?? 1 : 1);
    if (this.bots.length < D.maxBots && this.rng() < D.arrivalsPerMin * this.hype / 60 * att * dt) {
      const mix = Object.entries(D.mix) as [ArchetypeId, number][]; let x = this.rng() * mix.reduce((s, [, w]) => s + w, 0);
      for (const [a, w] of mix) { if ((x -= w) <= 0) { this.spawn(this.ctoActive && this.rng() < 0.5 ? "crew" : a, this.t); break; } }
    }
    // market reading
    const p = this.m.price(), kF = 1 - Math.exp(-dt / M.emaFastS), kS = 1 - Math.exp(-dt / M.emaSlowS);
    this.emaF += (p - this.emaF) * kF; this.emaS += (p - this.emaS) * kS;
    if (this.t - this.histT >= 1) { this.histT = this.t; this.hist.push(p); if (this.hist.length > M.srWindowS) this.hist.shift(); }
    const mc = this.m.mcap(); if (mc > this.peak) { this.peak = mc; this.peakT = this.t; }
    const ti = tierOf(this.peak); if (ti > this.peakTier) { this.peakTier = ti; if (ti >= 4) this.emitEvent("tier", `${TIERS[ti].name} reached`); }
  }
  /** PnL for anyone, marked at the current price (uPnL = size × (mark − avgEntry); realized = closed uPnL; fees separate) */
  pnlOf(pos: Position) { const v = view(pos, this.m.price(), this.m.S, this.t * 1000); return { uPnl: v.uPnl, realized: v.realized, fees: v.fees, total: v.uPnl + v.realized - v.fees }; }
  leaderboard() {
    const rows = this.bots.filter((b) => b.buys > 0).map((b) => ({ name: b.name, arch: b.arch as ArchetypeId | "you", wallet: b.wallet, ...this.pnlOf(b.pos), volume: b.volume }));
    rows.push({ name: "you", arch: "you", wallet: "you", ...this.pnlOf(this.player.pos), volume: this.player.volume });
    return rows.sort((a, b) => b.total - a.total);
  }
  summary() {
    const lb = this.leaderboard(), rank = lb.findIndex((r) => r.arch === "you") + 1, me = this.pnlOf(this.player.pos), P = this.cfg.points;
    const ach = new Set<string>();
    if (this.m.gradAt != null) ach.add("graduate");
    if (this.peak >= 100_000) ach.add("angels");
    if (this.peak >= 1_200_000) ach.add("million");
    if (me.total > 0.005) ach.add("green");
    if (rank > 0 && rank <= 3 && this.player.buys > 0) ach.add("top3");
    if (this.rugged && me.total > 0.005) ach.add("survivor");
    if (this.ctoActive) ach.add("cto");
    if (this.player.firstBuyT != null && this.player.firstBuyT <= 30) ach.add("early");
    const achievements = SIM_ACHIEVEMENTS.filter((a) => ach.has(a.id));
    const points = Math.round(this.peakTier * P.perTier + (this.m.gradAt != null ? P.graduation : 0) + Math.max(0, me.total) * P.perPnlUsd
      + (this.player.buys > 0 && rank >= 1 && rank <= P.rankBonus.length ? P.rankBonus[rank - 1] : 0) + achievements.length * P.achievement);
    const arch: Record<string, number> = {}; for (const b of this.bots) arch[b.arch] = (arch[b.arch] || 0) + 1;
    return {
      mode: "SIMULATOR", difficulty: this.difficulty, seed: this.seed, simSeconds: +this.t.toFixed(1), hype: +this.hype.toFixed(2),
      peakMcap: Math.round(this.peak), peakTier: TIERS[this.peakTier].name, peakTierIndex: this.peakTier, peakAtS: +this.peakT.toFixed(1),
      finalMcap: Math.round(this.m.mcap()), graduatedAtS: this.m.gradAt != null ? +this.m.gradAt.toFixed(1) : null,
      rug: this.rugged ? { atS: +this.rugged.t.toFixed(1), peakBefore: Math.round(this.rugged.peakBefore) } : null,
      cto: this.ctoActive && this.ctoAt != null ? { atS: +this.ctoAt.toFixed(1) } : null,
      bots: this.bots.length, botsByArchetype: arch, trades: this.trades.length,
      you: { cash: +this.player.cash.toFixed(2), startBalance: this.player.cash0, ...round(me), buys: this.player.buys, sells: this.player.sells, rank, of: lb.length },
      points, achievements: achievements.map((a) => a.title),
      events: this.events.map((e) => ({ t: +e.t.toFixed(1), kind: e.kind, text: e.text })),
      top: lb.slice(0, 10).map((r) => ({ name: r.name, arch: r.arch, total: +r.total.toFixed(2) })),
    };
  }
}
const round = <T extends Record<string, number>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)])) as T;
export const fmt = (v: number) => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + v.toFixed(0);
