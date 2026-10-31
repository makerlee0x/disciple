/**
 * SimRun — deterministic local market + bot traders (seeded). Pure TS, no DOM: the /sim page drives it on
 * a timer (speed 1×/2×/4×) and the headless test (scripts/test-sim.mjs) drives it as fast as it can.
 * The player's trades go through the same market and the same PnL ledger rules (lib/pnl.ts) as the bots.
 *
 * Determinism: the run is a pure function of (config, difficulty, seed, player-input log). Time advances in whole
 * 100 ms blocks (t = blk × blockS, independent of how the caller chunks step()), every player action is recorded
 * with the block it happened after (`inputs`), and SimRun.replay() re-applies a log to reproduce a run exactly.
 *
 * Tramps & walls (post-graduation, ./pool.ts): anyone (you or a bot) can place them; they are liquidity in the
 * pool, so a TRAMP below the price absorbs sells and a WALL above it absorbs buys. Once the price crosses a whole
 * range the order is filled and the KEEPER bot pulls it after a short delay for the 0.1% tip (TrampWallManager.pull);
 * if the price comes back first, the pull waits (the order is partly un-filled again).
 *
 * Bots vs you: bots only read the public tape — your confirmed trades and your placed orders — each after its own
 * reaction delay (difficulty.adapt.reactS), and reaction trades are capped per minute (budgetPerMin) and per read
 * (maxReactors). Nothing reads your pending trades, your intent or the RNG.
 */
import { applyFill, emptyPosition, view, type Position } from "../pnl";
import { pointsFor } from "../trampwalls/adapter";
import { tierOf, TIERS, SIM_ACHIEVEMENTS, type ArchetypeId, type DifficultyId, type SimConfig, DIFFICULTIES } from "./config";
import { Market, type Fill } from "./market";
import type { OrderKind, RangeOrder } from "./pool";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const seedOf = (s: string | number) => { if (typeof s === "number") return s >>> 0; let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

/** owner id of the player's orders and trades */
export const YOU = "you";
export type ReactKind = "ride" | "dumpOn" | "takeProfit" | "pile" | "rebuy" | "dipBuy" | "exitInto" | "undercut" | "frontrun" | "stack";
export interface Bot { id: number; name: string; wallet: string; arch: ArchetypeId; cash: number; cash0: number; pos: Position; cluster?: number;
  joinT: number; nextT: number; holdUntil?: number; active: boolean; buys: number; sells: number; volume: number;
  /** reaction delay, s: this bot sees your trades / orders this late */
  react: number;
  /** riding your pump: take profit at +tp */
  ride?: { tp: number; since: number } | null;
  /** sold into your dump: buys back at/below this price */
  rebuy?: { below: number; until: number } | null }
export interface SimTrade { t: number; side: "buy" | "sell"; usd: number; tokens: number; mcap: number; preMcap: number; trader: string; arch: ArchetypeId | "you"; mine: boolean; react?: ReactKind;
  /** the trader's wallet ("you" for the player) — PAPER TRADING names bots from it (lib/defaultUsername) */
  wallet?: string; /** gas charged on this trade ($, out of cash) */ gas?: number }
/** PAPER TRADING (lib/sim/paper.ts): an optional bot brain that replaces the archetype switch for every bot. Absent (the
 *  /flight/sim SIMULATOR) ⇒ SimRun behaves exactly as before. It uses the run's own RNG, so runs stay deterministic. */
export interface SimBrain {
  init(run: SimRun): void;
  decide(run: SimRun, b: Bot): void;
  afterBlock?(run: SimRun): void;
  /** called once, right after the trade that ASCENDS the curve (paper: score the round, pay the ascension pool) */
  onGraduate?(run: SimRun): void;
}
export interface SimEvent { t: number; kind: "launch" | "graduate" | "rug" | "cto" | "whale" | "tier" | "react" | "tw"; text: string; mcap: number; mine?: boolean }
export type PlayerInput =
  | { blk: number; op: "trade"; side: "buy" | "sell"; usd: number; frac?: number }
  | { blk: number; op: "place"; kind: OrderKind; mcapUsd: number; widthPct: number; sizeUsd: number }
  | { blk: number; op: "cancel"; id: number };
type Acct = { name: string; cash: number; pos: Position };
type Read = { state: "pump" | "dump" | "calm"; net: number; recentBuy: boolean };

const REACT_TEXT: Record<ReactKind, string> = {
  ride: "rides your pump", dumpOn: "sells into your buys", takeProfit: "takes profit on your pump", pile: "piles into your dump", rebuy: "buys back below your dump",
  dipBuy: "buys your dip", exitInto: "dumps into your tramp", undercut: "undercuts your wall", frontrun: "front-runs your tramp", stack: "stacks a tramp with yours",
};

export class SimRun {
  rng: () => number; m: Market; t = 0; blk = 0; acc = 0; bots: Bot[] = []; trades: SimTrade[] = []; events: SimEvent[] = [];
  player: Acct & { cash0: number; buys: number; sells: number; volume: number; firstBuyT: number | null; tokens: number };
  emaF: number; emaS: number; hist: number[] = []; histT = 0; peak: number; peakT = 0; peakTier = 0;
  lastPlayerBigBuy = -1e9; rugged: { t: number; peakBefore: number } | null = null; ctoAt: number | null = null; ctoActive = false;
  rugPlan: { at: number; minMcap: number } | null = null; waveAt = Infinity; waveUntil = -1; waves = 0; ctoPlan: boolean; hype = 1; nextId = 1; nextOrderId = 1;
  listeners = new Set<(e: { trade?: SimTrade; event?: SimEvent; player?: boolean; orders?: boolean; order?: RangeOrder }) => void>();
  /** every player action, with the block it happened after (replay log) */
  inputs: PlayerInput[] = [];
  /** public tape of YOUR confirmed trades (dp = $ / quote depth at the time) — what bots read, with their delay */
  tape: { t: number; side: "buy" | "sell"; dp: number }[] = [];
  reactLog: { t: number; usd: number }[] = []; reacts: Record<ReactKind, number> = { ride: 0, dumpOn: 0, takeProfit: 0, pile: 0, rebuy: 0, dipBuy: 0, exitInto: 0, undercut: 0, frontrun: 0, stack: 0 };
  lastReactEvT = -1e9;
  /** realized PnL bots booked on sells they made in reaction to you (ride → take profit, sell into your buys, …) */
  reactPnl = 0; reactPnlBy: Partial<Record<ReactKind, number>> = {};
  keeper = { tips: 0, pulls: 0 };
  tw = { placed: { you: 0, bots: 0 }, filled: { you: 0, bots: 0 }, cancelled: 0, youPoints: 0 };
  private byWallet = new Map<string, Bot>();
  brain: SimBrain | null;
  /** PAPER (spec Sec. 2 'End condition'): with opts.endOnGraduate the round ends at ASCEND — time stops at `endedAt` and every
   *  later trade fails. Off (the SIMULATOR) ⇒ unchanged. */
  endOnGraduate: boolean; endedAt: number | null = null;
  constructor(public cfg: SimConfig, public difficulty: DifficultyId, public seed: number, opts: { balance?: number; brain?: SimBrain; endOnGraduate?: boolean } = {}) {
    this.brain = opts.brain ?? null; this.endOnGraduate = !!opts.endOnGraduate;
    this.rng = mulberry32(seed);
    this.m = new Market(cfg);
    const p0 = this.m.price(); this.emaF = this.emaS = p0; this.peak = this.m.mcap();
    const bal = opts.balance ?? cfg.player.startBalanceUsd;
    this.player = { name: YOU, cash: bal, cash0: bal, pos: emptyPosition(), buys: 0, sells: 0, volume: 0, firstBuyT: null, tokens: 0 };
    const D = this.diff();
    this.hype = Math.exp(this.normal() * D.hypeSigma);
    const rug = D.rug;
    this.rugPlan = rug && this.rng() < rug.chance ? { at: rug.earliestS + this.rng() * (rug.latestS - rug.earliestS), minMcap: cfg.launch.startMcapUsd * rug.minMcap * (0.8 + this.rng() * 0.8) } : null;
    this.ctoPlan = !!rug && this.rng() < rug.ctoChance;
    if (D.waves) this.waveAt = this.r(D.waves.everyS[0], D.waves.everyS[1]);
    let cluster = 0;
    for (const [a, n] of Object.entries(D.initial) as [ArchetypeId, number][]) for (let i = 0; i < n; i++) this.spawn(a, 0, a === "bundler" ? (cluster || (cluster = 1)) : undefined);
    this.brain?.init(this);
    this.emitEvent("launch", `LAUNCH · ${D.label} · seed ${seed}`);
  }
  /** difficulty with defaults filled in (a stale saved tune may lack newer knobs) */
  diff() { const d = this.cfg.difficulties[this.difficulty], base = DIFFICULTIES[this.difficulty];
    return d.adapt && d.orders ? d : { ...base, ...d, adapt: { ...base.adapt, ...d.adapt }, orders: { ...base.orders, ...d.orders } }; }
  r(a: number, b: number) { return a + (b - a) * this.rng(); }
  normal() { return Math.sqrt(-2 * Math.log(this.rng() + 1e-12)) * Math.cos(6.283185307 * this.rng()); }
  spawn(arch: ArchetypeId, t: number, cluster?: number) {
    const A = this.cfg.archetypes[arch], id = this.nextId++, D = this.diff();
    const cash = A.cash * Math.exp(this.normal() * A.cashSigma) * D.size * Math.sqrt(this.hype);
    const nm = A.names[Math.floor(this.rng() * A.names.length)];
    let wallet = "0x"; for (let i = 0; i < 40; i++) wallet += Math.floor(this.rng() * 16).toString(16);
    if (cluster) wallet = "0xb0b" + (wallet.slice(5, 38)) + "c" + cluster.toString(16);   // clustered wallets share a visible prefix/suffix
    const name = arch === "bundler" ? `Bundle#${cluster}·${nm}` : arch === "rugger" ? "DEV" : arch === "cto" ? "CTO Council" : `${A.label.split(" ")[0]}·${nm}${id}`;
    const launchy = arch === "sniper" || arch === "bundler" || arch === "rugger";
    // launch wallets act in the first blocks after the sniper tax reaches 0 (antiSnipeDurationS = 7 s: 7.2–11 s; the dev 7.2–7.6 s)
    const b: Bot = { id, name, wallet, arch, cash, cash0: cash, pos: emptyPosition(), cluster, joinT: t, active: arch !== "cto",
      nextT: launchy && t === 0 ? this.cfg.launch.antiSnipeDurationS + this.r(0.2, arch === "rugger" ? 0.6 : 4)
        : t === 0 ? this.r(...(D.startS ?? [0.5, 8]) as [number, number]) : t + this.r(0.5, 60 / Math.max(0.1, A.rate)), buys: 0, sells: 0, volume: 0,
      react: this.r(D.adapt.reactS[0], D.adapt.reactS[1]), ride: null, rebuy: null };
    this.bots.push(b); this.byWallet.set(wallet, b); return b;
  }
  on(f: (e: { trade?: SimTrade; event?: SimEvent; player?: boolean; orders?: boolean; order?: RangeOrder }) => void) { this.listeners.add(f); return () => this.listeners.delete(f); }
  private notify(e: { trade?: SimTrade; event?: SimEvent; player?: boolean; orders?: boolean; order?: RangeOrder }) { this.listeners.forEach((f) => f(e)); }
  emitEvent(kind: SimEvent["kind"], text: string, mine?: boolean) { const e: SimEvent = { t: this.t, kind, text, mcap: this.m.mcap(), mine }; this.events.push(e); if (this.events.length > 600) this.events.splice(1, 100); this.notify({ event: e }); }
  /** momentum, support/resistance (what bots see) */
  feat() {
    const p = this.m.price(), mom = this.emaF / this.emaS - 1;
    let lo = p, hi = p; for (const h of this.hist) { if (h < lo) lo = h; if (h > hi) hi = h; }
    const n = this.cfg.market.nearSR;
    return { p, mom, sup: lo, res: hi, nearSup: p <= lo * (1 + n), nearRes: p >= hi * (1 - n), playerHot: this.t - this.lastPlayerBigBuy < this.cfg.market.playerAttentionS };
  }
  private acct(owner: string): Acct | undefined { return owner === YOU ? this.player : this.byWallet.get(owner); }
  private exec(side: "buy" | "sell", who: Bot | null, usdOrTokens: number, react?: ReactKind): Fill {
    if (this.endedAt != null) return this.fail("round over");
    const pre = this.m.mcap(), wasCurve = this.m.phase === "curve", depth0 = this.m.depth();
    const holding = who ? who.pos.size : this.player.pos.size;
    const f = side === "buy" ? this.m.buy(usdOrTokens, this.t, holding) : this.m.sell(usdOrTokens);
    if (!f.ok) return f;
    const at = this.t * 1000, gas = who ? this.cfg.player.botGasUsd ?? 0 : this.cfg.player.gasUsd;
    if (who) { const r0 = who.pos.realized; who.pos = applyFill(who.pos, side, f.usd, f.price, gas, at); who.cash -= gas; if (react && side === "sell") { const d = who.pos.realized - r0; this.reactPnl += d; this.reactPnlBy[react] = (this.reactPnlBy[react] || 0) + d; } who.cash += side === "buy" ? -f.usd : f.usd * (1 - this.m.fee); who[side === "buy" ? "buys" : "sells"]++; who.volume += f.usd; }
    else { const P = this.player; P.pos = applyFill(P.pos, side, f.usd, f.price, gas, at); P.cash += (side === "buy" ? -f.usd : f.usd * (1 - this.m.fee)) - gas; P[side === "buy" ? "buys" : "sells"]++; P.volume += f.usd;
      if (side === "buy" && P.firstBuyT == null) P.firstBuyT = this.t;
      this.tape.push({ t: this.t, side, dp: f.usd / Math.max(1, depth0) }); if (this.tape.length > 400) this.tape.splice(0, 100); }
    const tr: SimTrade = { t: this.t, side, usd: f.usd, tokens: f.tokens, mcap: f.postMcap, preMcap: pre, trader: who ? who.name : "you", arch: who ? who.arch : "you", mine: !who, react, wallet: who ? who.wallet : YOU, gas };
    this.trades.push(tr); if (this.trades.length > 4000) this.trades.splice(0, 1000);
    this.notify({ trade: tr, player: !who });
    if (react && who) { this.reactLog.push({ t: this.t, usd: f.usd }); this.noteReact(react, who); }
    if (wasCurve && this.m.phase === "pool") { this.emitEvent("graduate", `ASCENDED → pool at ${fmt(this.m.mcap())}`);
      if (this.endOnGraduate) { this.endedAt = this.t; this.brain?.onGraduate?.(this); } }
    if (who && f.usd > Math.max(3000, this.m.depth() * 0.25) && side === "buy") this.emitEvent("whale", `${who.name} apes ${fmt(f.usd)}`);
    return f;
  }
  /** a brain's bot trade (buy: $ in, sell: tokens) through the same exec path as every other trade */
  botTrade(b: Bot, side: "buy" | "sell", usdOrTokens: number): Fill { return this.exec(side, b, usdOrTokens); }
  private noteReact(k: ReactKind, b: Bot) { this.reacts[k]++; if (this.t - this.lastReactEvT >= 3) { this.lastReactEvT = this.t; this.emitEvent("react", `${b.name} ${REACT_TEXT[k]}`); } }
  private fail(reason: string) { const m = this.m.mcap(); return { ok: false, reason, tokens: 0, usd: 0, price: 0, preMcap: m, postMcap: m, mcap: m }; }

  // ── player API (every call is recorded in `inputs`) ──────────────────────────────────────────────────
  /** Player trade (paper, local). sell: usd notional at spot, or frac of the bag. */
  playerTrade(side: "buy" | "sell", usd: number, o?: { frac?: number }): Fill & { mcap: number } {
    this.inputs.push(o?.frac ? { blk: this.blk, op: "trade", side, usd, frac: o.frac } : { blk: this.blk, op: "trade", side, usd });
    const P = this.player;
    if (side === "buy") {
      if (usd > P.cash + 1e-9) return this.fail("insufficient sim balance");
      const f = this.exec("buy", null, usd);
      if (f.ok && (f.usd >= this.cfg.market.playerBigBuyUsd || f.usd >= this.m.depth() * 0.02)) this.lastPlayerBigBuy = this.t;
      return { ...f, mcap: f.price * this.m.S };
    }
    if (P.pos.size <= 0) return this.fail("NO TOKENS IN WALLET");
    const tokens = o?.frac ? P.pos.size * Math.min(1, o.frac) : Math.min(P.pos.size, usd / this.m.price());
    const f = this.exec("sell", null, tokens);
    return { ...f, mcap: f.price * this.m.S };
  }
  /** Player tramp/wall: center mcap, range width % (like the panel), size $. Tramp pays quote; wall moves tokens. */
  playerPlace(kind: OrderKind, mcapUsd: number, widthPct: number, sizeUsd: number): { ok: boolean; id?: number; reason?: string } {
    this.inputs.push({ blk: this.blk, op: "place", kind, mcapUsd, widthPct, sizeUsd });
    const S = this.m.S, w = Math.max(0.5, widthPct || 2) / 100, lo = mcapUsd * (1 - w / 2) / S, hi = mcapUsd * (1 + w / 2) / S;
    const deposit = kind === "tramp" ? sizeUsd : sizeUsd / (mcapUsd / S);
    const r = this.place(YOU, kind, Math.sqrt(lo), Math.sqrt(hi), deposit, sizeUsd);
    return typeof r === "string" ? { ok: false, reason: r } : { ok: true, id: r.id };
  }
  playerCancel(id: number): { ok: boolean; reason?: string } {
    this.inputs.push({ blk: this.blk, op: "cancel", id });
    const o = this.m.pool?.active.find((x) => x.id === id && x.owner === YOU);
    if (!o) return { ok: false, reason: "Not active" };
    this.close(o, "cancel", YOU); return { ok: true };
  }
  /** re-run a recorded player log: identical (cfg, difficulty, seed, inputs) ⇒ identical run */
  static replay(cfg: SimConfig, difficulty: DifficultyId, seed: number, inputs: PlayerInput[], seconds: number, opts: { balance?: number; brain?: SimBrain; endOnGraduate?: boolean } = {}) {
    const r = new SimRun(cfg, difficulty, seed, opts), N = Math.round(seconds / cfg.market.blockS); let i = 0;
    for (;;) {
      while (i < inputs.length && inputs[i].blk === r.blk) r.apply(inputs[i++]);
      if (r.blk >= N || r.endedAt != null) break; r.step(cfg.market.blockS);
    }
    return r;
  }
  apply(x: PlayerInput) {
    if (x.op === "trade") this.playerTrade(x.side, x.usd, x.frac ? { frac: x.frac } : undefined);
    else if (x.op === "place") this.playerPlace(x.kind, x.mcapUsd, x.widthPct, x.sizeUsd);
    else this.playerCancel(x.id);
  }

  // ── tramps & walls (TrampWallManager semantics, ./pool.ts) ────────────────────────────────────────────
  /** place a range order for owner; tramp deposit = quote, wall deposit = tokens (moved out of the bag at cost) */
  place(owner: string, kind: OrderKind, a: number, b: number, deposit: number, sizeUsd: number): RangeOrder | string {
    const pool = this.m.pool, who = this.acct(owner);
    if (!pool) return "Tramps & walls open after graduation";
    if (!who) return "unknown owner";
    const why = pool.canPlace(kind, a, b); if (why) return why;
    if (!(deposit > 0)) return "Enter an amount";
    let basis: number;
    if (kind === "tramp") { if (deposit > who.cash + 1e-9) return "insufficient sim balance"; basis = deposit; }
    else { if (deposit > who.pos.size * (1 + 1e-9)) return "not enough tokens for this wall"; deposit = Math.min(deposit, who.pos.size); basis = who.pos.size > 0 ? who.pos.costBasis * deposit / who.pos.size : 0; }
    const o = pool.place({ id: this.nextOrderId++, owner, kind, a, b, deposit, sizeUsd, basis, placedT: this.t, placedBlk: this.blk });
    if (typeof o === "string") return o;
    if (kind === "tramp") who.cash -= deposit;
    else { const p = { ...who.pos }; p.size -= deposit; p.costBasis -= basis; if (p.size <= 1e-9) { p.size = 0; p.costBasis = 0; p.holdStart = 0; p.sellScale = 1; } who.pos = p; }
    if (owner === YOU) { this.tw.placed.you++; this.emitEvent("tw", `you placed a ${kind === "tramp" ? "TRAMP" : "WALL"} ${fmt(sizeUsd)} @ ${fmt(((a + b) / 2) ** 2 * this.m.S)}`, true); }
    else this.tw.placed.bots++;
    this.notify({ orders: true, order: o, player: owner === YOU });
    return o;
  }
  /** cancel (owner, no tip) or keeper pull (filled; tip to the keeper) — owner gets the order's current mix */
  close(o: RangeOrder, how: "cancel" | "pull", by: string) {
    const pool = this.m.pool!, who = this.acct(o.owner)!, g = pool.amounts(o);
    const r = pool.remove(o, how === "pull" ? this.cfg.launch.keeperTipBps : 0), price = pool.price();
    o.status = how === "pull" ? "filled" : "cancelled"; o.closedT = this.t; o.closedBy = by; o.outQuote = r.quote; o.outTokens = r.tokens;
    // cost basis follows the deposit asset still in the order; the converted part is realized
    const depLeft = o.kind === "tramp" ? g.quote : g.tokens, keepFrac = o.deposit > 0 ? Math.min(1, depLeft / o.deposit) : 0, basisKept = o.basis * keepFrac;
    const p = { ...who.pos };
    if (o.kind === "tramp") {   // quote back = the unconverted deposit; tokens = what the tramp bought (cost = the quote it spent)
      who.cash += r.quote; p.realized += r.quote - basisKept;
      if (r.tokens > 0) { if (p.size <= 0) { p.holdStart = this.t * 1000; p.sellScale = 1; } p.size += r.tokens; p.costBasis += o.basis - basisKept; }
    } else {                    // tokens back at their basis; quote = what the wall sold
      if (r.tokens > 0) { if (p.size <= 0) { p.holdStart = this.t * 1000; p.sellScale = 1; } p.size += r.tokens; p.costBasis += basisKept; }
      who.cash += r.quote; p.realized += r.quote - (o.basis - basisKept);
    }
    who.pos = p;
    if (how === "pull") { this.keeper.pulls++; this.keeper.tips += r.tipQuote + r.tipTokens * price;
      if (o.owner === YOU) { this.tw.filled.you++; const pts = pointsFor(o.sizeUsd); /* filled (keeper close after a full cross) → floor($ × TRAMP_WALL_POINTS_PER_USD) */ this.tw.youPoints += pts;
        this.emitEvent("tw", `KEEPER closed your filled ${o.kind === "tramp" ? `TRAMP: +${fmtTok(r.tokens)} tokens` : `WALL: +${fmt(r.quote)}`} · +${pts} pts`, true); }
      else this.tw.filled.bots++; }
    else { this.tw.cancelled++; if (o.owner === YOU) this.emitEvent("tw", `you cancelled a ${o.kind === "tramp" ? "TRAMP" : "WALL"}`, true); }
    this.notify({ orders: true, order: o, player: o.owner === YOU });
  }
  private keeperStep() {
    const pool = this.m.pool; if (!pool) return;
    const K = this.diff().orders.keeperS;
    for (const o of [...pool.active]) {
      if (pool.isFilled(o)) {
        if (o.crossedT == null) { o.crossedT = this.t; o.pullAt = this.t + this.r(K[0], K[1]); }
        else if (this.t >= (o.pullAt ?? Infinity)) this.close(o, "pull", "KEEPER");
      } else if (o.crossedT != null) { o.crossedT = null; o.pullAt = null; }   // price came back: pull would revert (NotFilled)
    }
  }

  // ── bots ─────────────────────────────────────────────────────────────────────────────────────────────
  inWave() { return this.t < this.waveUntil; }
  private botBuy(b: Bot, frac: number, react?: ReactKind) {
    // launch bots wait out the sniper tax (buys only, 99% at 0s … 0.03% at 6s, 0 from 7s); everyone else nibbles through it, full size after
    const as = b.arch === "sniper" || b.arch === "bundler" || b.arch === "rugger" ? 0 : this.m.antiSnipe(this.t);
    if (as > 0) frac *= Math.max(0.04, 1 - as) ** 2;
    const usd = Math.min(b.cash, b.cash * frac); if (usd >= 1) this.exec("buy", b, usd, react); }
  private botSell(b: Bot, frac: number, react?: ReactKind) { let tk = b.pos.size * Math.min(1, frac); if (tk * this.m.price() < 1) tk = b.pos.size; if (tk > 0 && tk * this.m.price() >= 0.5) this.exec("sell", b, tk, react); }   // no dust sells
  /** what a bot reads of YOU off the public tape, `lag` seconds late */
  read(lag: number): Read {
    const A = this.diff().adapt, now = this.t - lag, from = now - A.windowS; let net = 0, lastBuy = -1e9;
    for (let i = this.tape.length - 1; i >= 0; i--) { const e = this.tape[i]; if (e.t > now) continue; if (e.t < from) break;
      net += e.side === "buy" ? e.dp : -e.dp; if (e.side === "buy" && e.t > lastBuy) lastBuy = e.t; }
    return { state: net >= A.pumpFrac ? "pump" : net <= -A.dumpFrac ? "dump" : "calm", net, recentBuy: now - lastBuy < 4 };
  }
  /** per-difficulty caps on reactions: $ moved per minute (vs depth) and bots per ~2 s read */
  private canReact() {
    const A = this.diff().adapt; let usd = 0, n = 0;
    for (let i = this.reactLog.length - 1; i >= 0; i--) { const e = this.reactLog[i]; if (e.t < this.t - 60) { this.reactLog.splice(0, i + 1); break; } usd += e.usd; if (e.t >= this.t - 2) n++; }
    return usd < A.budgetPerMin * this.m.depth() && n < A.maxReactors;
  }
  private yourOrders(lag: number) { const p = this.m.pool; return p ? p.active.filter((o) => o.owner === YOU && o.placedT <= this.t - lag) : []; }
  /** adaptive play vs you: returns true if the bot acted */
  private adapt(b: Bot, F: ReturnType<SimRun["feat"]>, u: number): boolean {
    const A = this.cfg.archetypes[b.arch], AD = this.diff().adapt, O = this.diff().orders, R = () => this.rng(), has = b.pos.size > 0;
    if (b.ride) {   // a rider takes its profit — sooner when your pump stalls
      const rd = this.read(b.react);
      if (has && (u >= b.ride.tp || (rd.state !== "pump" && u > 0.01))) { b.ride = null; this.botSell(b, this.r(0.6, 1), "takeProfit"); return true; }
      if (!has || u < -0.08 || this.t - b.ride.since > 120) b.ride = null;
    }
    if (A.style === "support") {
      if (b.cash < 1) return false;
      const rd = this.read(b.react);
      if (rd.state === "dump" && R() < AD.dipBuy && this.canReact()) { this.botBuy(b, this.r(A.buyFrac[0], A.buyFrac[1]), "dipBuy"); return true; }
      return false;
    }
    if (b.arch !== "sniper" && A.style !== "compete") return false;
    if (b.rebuy) {   // sold into your dump: buy back lower (or give up)
      if (F.p <= b.rebuy.below && b.cash >= 1 && this.canReact()) { b.rebuy = null; this.botBuy(b, this.r(0.3, 0.6), "rebuy"); return true; }
      if (this.t > b.rebuy.until) b.rebuy = null;
    }
    const rd = this.read(b.react);
    if (has && u > 0.03 && rd.recentBuy && rd.net > 0 && R() < AD.dumpOn * (rd.state === "pump" ? 1 : 0.4) && this.canReact()) { this.botSell(b, this.r(0.3, 0.7), "dumpOn"); return true; }   // your buy = their exit
    // ride: on a pump — or, competitive enough, on the first buys of one (front-running the continuation, not your tx)
    if (!b.ride && b.cash >= 1 && rd.recentBuy && (rd.state === "pump" || rd.net >= AD.pumpFrac * (1 - AD.ride)) && R() < AD.ride && this.canReact()) {
      b.ride = { tp: AD.tpRide * this.r(0.8, 1.3), since: this.t }; this.botBuy(b, this.r(0.2, 0.45), "ride"); return true; }
    if (rd.state === "dump" && has && u > -0.03 && R() < AD.pile && this.canReact()) {   // get out ahead of the rest of your dump, plan to buy back lower
      b.rebuy = { below: F.p * this.r(0.88, 0.95), until: this.t + 90 }; this.botSell(b, this.r(0.4, 1), "pile"); return true; }
    // your tramp is an exit: dump into it when the price nears it (only in profit)
    if (has && u > 0 && O.exitInto > 0 && this.m.pool) { const p = this.m.pool.price();
      for (const o of this.yourOrders(b.react)) if (o.kind === "tramp" && o.b * o.b >= p * 0.95 && R() < O.exitInto && this.canReact()) { this.botSell(b, this.r(0.4, 0.9), "exitInto"); return true; } }
    return false;
  }
  /** tramps & walls for a bot (post-graduation): cancel stale, answer yours, place its own */
  private orderPlay(b: Bot, F: ReturnType<SimRun["feat"]>, u: number): boolean {
    const pool = this.m.pool; if (!pool) return false;
    const O = this.diff().orders, A = this.cfg.archetypes[b.arch], R = () => this.rng(), p = pool.price(), s = pool.s;
    const mine = pool.active.filter((o) => o.owner === b.wallet);
    for (const o of mine) { const mid = o.a * o.b; if (Math.abs(mid / p - 1) > 0.35 && R() < 0.3) { this.close(o, "cancel", b.name); return true; } }
    if (mine.length >= O.maxPerBot || pool.active.filter((o) => o.owner !== YOU).length >= O.maxTotal) return false;
    const sz = () => this.r(O.sizeFrac[0], O.sizeFrac[1]), band = (lo: number, hi: number) => [Math.sqrt(lo), Math.sqrt(hi)] as const;
    const tramp = (lo: number, hi: number, k?: ReactKind) => { const q = b.cash * sz(); if (q < 2) return false; const [a, bb] = band(lo, hi);
      const r = this.place(b.wallet, "tramp", a, bb, q, q); if (typeof r === "string") return false; if (k) this.noteReact(k, b); return true; };
    const wall = (lo: number, hi: number, k?: ReactKind) => { const tk = b.pos.size * sz(); if (tk * p < 2) return false; const [a, bb] = band(lo, hi);
      const r = this.place(b.wallet, "wall", a, bb, tk, tk * p); if (typeof r === "string") return false; if (k) this.noteReact(k, b); return true; };
    const yours = this.yourOrders(b.react);
    if (A.style !== "support") {
      const yw = yours.find((o) => o.kind === "wall"), yt = yours.find((o) => o.kind === "tramp");
      if (yw && b.pos.size > 0 && R() < O.undercut) { const hi = yw.a * yw.a * 0.998, lo = hi / 1.012;   // sell just below your ask
        if (lo > p * 1.001 ? wall(lo, hi, "undercut") : u > 0 && (this.botSell(b, this.r(0.2, 0.5), "undercut"), true)) return true; }
      if (yt && b.cash >= 2 && R() < O.undercut) { const lo = yt.b * yt.b * 1.002, hi = lo * 1.012;      // bid just above yours
        if (hi <= p && tramp(lo, hi, "frontrun")) return true; }
    } else if (b.cash >= 2) {
      const yt = yours.find((o) => o.kind === "tramp");
      if (yt && R() < O.stack && yt.b <= s && tramp(yt.a * yt.a, yt.b * yt.b, "stack")) return true;
    }
    // its own play
    if (A.style === "support" && b.cash >= 2) { const d = this.r(0.04, 0.12), w = this.r(0.02, 0.04); return tramp(p * (1 - d - w / 2), p * (1 - d + w / 2)); }
    if (b.pos.size > 0 && (u > 0.05 || A.style === "insider")) { const d = this.r(0.06, 0.15), w = this.r(0.02, 0.05); return wall(p * (1 + d - w / 2), p * (1 + d + w / 2)); }   // take-profit / distribution limit
    if (A.style === "compete" && b.cash >= 2 && R() < 0.4) { const d = this.r(0.06, 0.15), w = this.r(0.02, 0.04); return tramp(p * (1 - d - w / 2), p * (1 - d + w / 2)); }   // buy the dip cheaper
    return false;
  }
  private decide(b: Bot, F: ReturnType<SimRun["feat"]>) {
    if (this.brain) return this.brain.decide(this, b);
    const A = this.cfg.archetypes[b.arch], R = () => this.rng(), D = this.diff();
    const u = b.pos.size > 0 ? F.p / (b.pos.costBasis / b.pos.size) - 1 : 0, has = b.pos.size > 0, ts = D.tradeScale ?? 1, bf = () => this.r(A.buyFrac[0], A.buyFrac[1]) * ts, sf = () => this.r(A.sellFrac[0], A.sellFrac[1]);
    const age = this.t - b.joinT;
    switch (b.arch) {
      case "rugger": {   // dev: buys at launch (after anti-snipe), then waits for the rug plan
        if (!b.buys) return this.botBuy(b, bf());
        const rp = this.rugPlan; if (rp && !this.rugged && this.t >= rp.at && this.m.mcap() >= rp.minMcap) this.rug(b);
        return;
      }
      case "bundler": {
        if (!b.buys) return this.botBuy(b, bf());
        if (has && this.m.pool && R() < D.orders.rate && this.orderPlay(b, F, u)) return;   // distribution walls
        if (has && u > A.tp && R() < 0.35) return this.botSell(b, sf());   // drip distribution
        return;
      }
      case "sniper": {
        if (!b.buys && age < this.cfg.launch.antiSnipeDurationS + 20) return this.botBuy(b, bf());   // first block after the sniper tax hits 0 (7 s table), not into it; a sniper that misses that ~20 s launch window doesn't buy late as a "sniper"
        if (this.adapt(b, F, u)) return;
        if (has && (u > A.tp * this.r(0.8, 1.6) || u < A.sl || (age > 120 && R() < 0.15))) return this.botSell(b, sf());
        if (!has && F.mom > 0.05 && R() < 0.15) return this.botBuy(b, 0.3);
        return;
      }
      case "cto": {
        if (this.m.pool && R() < D.orders.rate && this.orderPlay(b, F, u)) return;
        if (has && u > A.tp && F.nearRes && R() < 0.3) return this.botSell(b, sf());
        if (b.cash > 1 && (F.nearSup || F.mom < 0.02 || R() < 0.5)) return this.botBuy(b, bf());
        return;
      }
    }
    if (this.adapt(b, F, u)) return;
    if (this.m.pool && R() < D.orders.rate && this.orderPlay(b, F, u)) return;
    // generic traders (crew, scalper, whale, momentum, paperhand, diamond)
    const wave = this.inWave() && D.waves;
    if (has && wave && u > -0.08 && R() < wave.sellBoost * (A.resist > 0 ? 1 : 0.4)) return this.botSell(b, this.r(0.25, 0.55));   // pullback wave: holders take real profit
    if (has && D.takeProfit && u > 0.04 && R() < D.takeProfit * (A.tp > 5 ? 0.3 : 1)) return this.botSell(b, sf() * 0.6);         // steady profit-taking
    if (has && u >= A.tp && (A.resist === 0 || F.nearRes || R() < 0.5) && R() < (D.tradeScale ?? 1)) return this.botSell(b, sf());
    if (has && u <= A.sl) return this.botSell(b, 1);
    if (has && F.nearRes && A.resist > 0 && u > 0.15 && R() < A.resist * 0.35) return this.botSell(b, A.sellFrac[0]);
    if (has && b.arch === "momentum" && F.mom < -0.02 && R() < 0.6) return this.botSell(b, sf());
    if (has && (b.arch === "whale" || b.arch === "scalper") && F.playerHot && u > 0.1 && R() < 0.4) return this.botSell(b, sf());   // PvP: sell into the player's pump
    let w = 0.25 + A.dip * (F.nearSup ? 1 : F.mom < 0 ? 0.4 : 0) + A.chase * Math.max(-0.5, Math.min(2, F.mom * 25)) + (F.playerHot ? A.followPlayer : 0);
    if (b.arch === "scalper" && has) w = 0;
    if (b.arch === "crew" && F.nearRes) w *= 0.5;
    if (this.rugged && !this.ctoActive) w *= 0.25;
    if (wave) w *= wave.buyCut;
    if (b.cash >= 1 && R() < Math.min(0.95, w * 0.6)) return this.botBuy(b, bf());
  }
  private rug(dev: Bot) {
    this.rugged = { t: this.t, peakBefore: this.peak };
    if (this.m.pool) for (const o of [...this.m.pool.active]) if (o.owner === dev.wallet || this.byWallet.get(o.owner)?.arch === "bundler") this.close(o, "cancel", "DEV");
    this.botSell(dev, 1);
    for (const b of this.bots) if (b.arch === "bundler" && b.pos.size > 0) this.botSell(b, 1);
    this.emitEvent("rug", `RUG · dev + bundle dumped · ${fmt(this.m.mcap())}`);
    // panic: paper hands and momentum dump too
    for (const b of this.bots) if ((b.arch === "paperhand" || b.arch === "momentum") && b.pos.size > 0 && this.rng() < 0.7) this.botSell(b, 1);
    const D = this.diff().rug!;
    if (this.ctoPlan) this.ctoAt = this.t + this.r(D.ctoDelayS[0], D.ctoDelayS[1]);
  }
  /** advance the simulation by dt seconds, in whole 100 ms blocks (a remainder carries to the next call) */
  step(dt: number) {
    const B = this.cfg.market.blockS; this.acc += dt;
    const n = Math.floor((this.acc + 1e-9) / B); this.acc = Math.max(0, this.acc - n * B);
    for (let i = 0; i < n && this.endedAt == null; i++) this.block(B);
  }
  private block(dt: number) {
    this.blk++; this.t = this.blk * this.cfg.market.blockS;
    const D = this.diff(), M = this.cfg.market;
    if (this.ctoAt != null && !this.ctoActive && this.t >= this.ctoAt) {
      this.ctoActive = true; const c = this.bots.find((b) => b.arch === "cto") || this.spawn("cto", this.t); c.active = true; c.nextT = this.t;
      this.emitEvent("cto", `CTO · community takeover at ${fmt(this.m.mcap())}`);
    }
    if (D.waves && this.t >= this.waveAt) { const W = D.waves; this.waves++;
      this.waveUntil = this.t + this.r(W.durS[0], W.durS[1]); this.waveAt = this.waveUntil + this.r(W.everyS[0], W.everyS[1]); }
    const F = this.feat();
    for (const b of this.bots) {
      if (this.endedAt != null) return;
      if (!b.active || this.t < b.nextT) continue;
      const A = this.cfg.archetypes[b.arch];
      b.nextT = this.t + (60 / Math.max(0.05, A.rate * D.activity)) * (-Math.log(this.rng() + 1e-12));
      this.decide(b, F);
    }
    this.keeperStep();
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
    this.brain?.afterBlock?.(this);
    const mc = this.m.mcap(); if (mc > this.peak) { this.peak = mc; this.peakT = this.t; }
    const ti = tierOf(this.peak); if (ti > this.peakTier) { this.peakTier = ti; if (ti >= 4) this.emitEvent("tier", `${TIERS[ti].name} reached`); }
  }
  /** open orders of an owner, marked at the current price: value − basis (counted as unrealized PnL) */
  ordersOf(owner: string) { return this.m.pool ? this.m.pool.active.filter((o) => o.owner === owner) : []; }
  /** PnL for an owner, marked at the current price (uPnL = size × (mark − avgEntry) + open orders' mark − basis;
   *  realized = closed uPnL; fees separate) */
  pnlOf(posOrOwner: Position | string) {
    const owner = typeof posOrOwner === "string" ? posOrOwner : null, pos = owner ? this.acct(owner)?.pos ?? emptyPosition() : posOrOwner as Position;
    const v = view(pos, this.m.price(), this.m.S, this.t * 1000); let ou = 0;
    if (owner && this.m.pool) { const pr = this.m.pool.price(); for (const o of this.ordersOf(owner)) { const g = this.m.pool.amounts(o); ou += g.quote + g.tokens * pr - o.basis; } }
    return { uPnl: v.uPnl + ou, realized: v.realized, fees: v.fees, total: v.uPnl + ou + v.realized - v.fees };
  }
  leaderboard() {
    const rows = this.bots.filter((b) => b.buys > 0).map((b) => ({ name: b.name, arch: b.arch as ArchetypeId | "you", wallet: b.wallet, ...this.pnlOf(b.wallet), volume: b.volume }));
    rows.push({ name: "you", arch: "you", wallet: "you", ...this.pnlOf(YOU), volume: this.player.volume });
    return rows.sort((a, b) => b.total - a.total);
  }
  /** all bots' total PnL (for difficulty / adaptation tests) */
  botsPnl() { let s = 0; for (const b of this.bots) s += this.pnlOf(b.wallet).total; return s; }
  summary() {
    const lb = this.leaderboard(), rank = lb.findIndex((r) => r.arch === "you") + 1, me = this.pnlOf(YOU), P = this.cfg.points;
    const ach = new Set<string>();
    if (this.m.gradAt != null) ach.add("graduate");
    if (this.peak >= 100_000) ach.add("angels");
    if (this.peak >= 1_200_000) ach.add("million");
    if (me.total > 0.005) ach.add("green");
    if (rank > 0 && rank <= 3 && this.player.buys > 0) ach.add("top3");
    if (this.rugged && me.total > 0.005) ach.add("survivor");
    if (this.ctoActive) ach.add("cto");
    if (this.player.firstBuyT != null && this.player.firstBuyT <= 30) ach.add("early");
    if (this.tw.filled.you > 0) ach.add("filled");
    const achievements = SIM_ACHIEVEMENTS.filter((a) => ach.has(a.id));
    const points = Math.round(this.peakTier * P.perTier + (this.m.gradAt != null ? P.graduation : 0) + Math.max(0, me.total) * P.perPnlUsd
      + (this.player.buys > 0 && rank >= 1 && rank <= P.rankBonus.length ? P.rankBonus[rank - 1] : 0) + achievements.length * P.achievement + this.tw.youPoints);
    const arch: Record<string, number> = {}; for (const b of this.bots) arch[b.arch] = (arch[b.arch] || 0) + 1;
    return {
      mode: "SIMULATOR", difficulty: this.difficulty, seed: this.seed, simSeconds: +this.t.toFixed(1), hype: +this.hype.toFixed(2),
      peakMcap: Math.round(this.peak), peakTier: TIERS[this.peakTier].name, peakTierIndex: this.peakTier, peakAtS: +this.peakT.toFixed(1),
      finalMcap: Math.round(this.m.mcap()), graduatedAtS: this.m.gradAt != null ? +this.m.gradAt.toFixed(1) : null,
      rug: this.rugged ? { atS: +this.rugged.t.toFixed(1), peakBefore: Math.round(this.rugged.peakBefore) } : null,
      cto: this.ctoActive && this.ctoAt != null ? { atS: +this.ctoAt.toFixed(1) } : null,
      bots: this.bots.length, botsByArchetype: arch, trades: this.trades.length,
      you: { cash: +this.player.cash.toFixed(2), startBalance: this.player.cash0, ...round(me), buys: this.player.buys, sells: this.player.sells, rank, of: lb.length },
      tw: { ...this.tw, open: this.m.pool ? this.m.pool.active.length : 0, keeperTips: +this.keeper.tips.toFixed(4), keeperPulls: this.keeper.pulls },
      reacts: { ...this.reacts }, reactPnl: +this.reactPnl.toFixed(2),
      points, achievements: achievements.map((a) => a.title),
      events: this.events.map((e) => ({ t: +e.t.toFixed(1), kind: e.kind, text: e.text })),
      top: lb.slice(0, 10).map((r) => ({ name: r.name, arch: r.arch, total: +r.total.toFixed(2) })),
    };
  }
}
const round = <T extends Record<string, number>>(o: T) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(2)])) as T;
export const fmt = (v: number) => v >= 1e9 ? "$" + (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + v.toFixed(0);
const fmtTok = (v: number) => v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : v.toFixed(0);
