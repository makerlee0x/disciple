/**
 * Browser driver for a SimRun: ticks it on a timer at 1×/2×/4×, and exposes window.__discipleSim, the
 * bridge the flight engine's SimBridgeSource (?source=sim) talks to. Paper only: no wallet, no RPC.
 * The sim ledger is authoritative for the player's position (tramp/wall fills and wall escrow move tokens
 * without a swap), so every change is pushed to the PnL HUD on SIM_POS_EVENT.
 */
import { SimRun, type SimBrain, type SimEvent, type SimTrade } from "./run";
import type { DifficultyId, SimConfig } from "./config";

type Emit = (e: Record<string, unknown>) => void;
export interface SimBridge {
  supply: number; balance(): number;
  attach(emit: Emit): () => void;
  impact(usd: number, side: "buy" | "sell"): number;
  trade(side: "buy" | "sell", usd: number, o?: { frac?: number }): Record<string, unknown>;
}
declare global { interface Window { __discipleSim?: SimBridge } }
export const SIM_POS_EVENT = "disciple:simpos";

export class SimDriver {
  run: SimRun; speed = 1; paused = false; ended = false; iv = 0; block = 1; emit: Emit | null = null;
  listeners = new Set<() => void>(); eventSubs = new Set<(e: SimEvent) => void>();
  /** PAPER TRADING (opts.brain): trades carry the bot's wallet as trader (named via 'disciple:feednames') and a unique
   *  tx id; absent ⇒ the SIMULATOR's exact behaviour */
  private paper: boolean; private nTrades = 0;
  constructor(cfg: SimConfig, public difficulty: DifficultyId, public seed: number, public minutes: number, opts: { brain?: SimBrain } = {}) {
    this.paper = !!opts.brain;
    this.run = new SimRun(cfg, difficulty, seed, opts.brain ? { brain: opts.brain } : {});
    this.run.on(({ trade, event, player }) => { if (trade) this.toEngine(trade); if (event) this.eventSubs.forEach((f) => f(event)); if (player) this.syncPos(); });
  }
  /** push the authoritative sim position to the HUD */
  syncPos() { if (typeof window !== "undefined") dispatchEvent(new CustomEvent(SIM_POS_EVENT, { detail: { pos: this.run.player.pos, supply: this.run.m.S } })); }
  private toEngine(tr: SimTrade) {
    if (!this.emit) return;
    const S = this.run.m.S, n = ++this.nTrades;
    this.emit({ t: "swap", block: this.block, ts: Date.now(), txHash: "sim:" + (this.paper ? n : this.run.trades.length), side: tr.side, usd: tr.usd, mcap: tr.mcap, price: tr.mcap / S,
      prePrice: tr.preMcap / S, postPrice: tr.mcap / S, impactPct: (tr.mcap / tr.preMcap - 1) * 100, trader: tr.mine ? undefined : this.paper && tr.wallet ? tr.wallet : tr.trader, mine: tr.mine });
  }
  start() {
    const tick = () => {
      if (this.paused || this.ended) return;
      const dt = 0.1 * this.speed; this.run.step(dt); this.block++;
      this.emit?.({ t: "block", block: this.block, ts: Date.now() });
      if (this.run.t >= this.minutes * 60) { this.ended = true; }
      this.listeners.forEach((f) => f());
    };
    this.iv = window.setInterval(tick, 100);
    const self = this;   // eslint-disable-line @typescript-eslint/no-this-alias
    window.__discipleSim = {
      supply: this.run.m.S,
      balance: () => self.run.player.cash,
      // the engine calls attach() while its script is still initialising (source.start at top level); a synchronous swap
      // reaches chartTick before `const CHART_STYLE` exists (TDZ) and aborts the whole engine, so the launch print is deferred
      attach(emit) { self.emit = emit; window.setTimeout(() => { if (self.emit === emit) emit({ t: "swap", block: self.block, ts: Date.now(), txHash: "(launch)", side: "buy", usd: 0, mcap: self.run.m.mcap(), price: self.run.m.price() }); }, 0); return () => { self.emit = null; }; },
      impact: (usd, side) => self.run.m.impact(usd, side),
      trade(side, usd, o) {
        if (self.ended) return { ok: false, reason: "run ended" };
        const f = self.run.playerTrade(side, usd, o);
        return f.ok ? { ok: true, sim: true, hash: "sim:" + self.run.trades.length, usd: f.usd, fillMcap: f.price * self.run.m.S, gas: self.run.cfg.player.gasUsd, balance: self.run.player.cash, at: self.run.t * 1000 }
          : { ok: false, reason: f.reason };
      },
    };
  }
  stop() { clearInterval(this.iv); if (window.__discipleSim) delete window.__discipleSim; }
  onTick(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  onEvent(f: (e: SimEvent) => void) { this.eventSubs.add(f); return () => { this.eventSubs.delete(f); }; }
}
