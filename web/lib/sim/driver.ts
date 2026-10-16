/**
 * Browser driver for a SimRun: ticks it on a timer at 1×/2×/4×, and exposes window.__discipleSim, the
 * bridge the flight engine's SimBridgeSource (?source=sim) talks to. Paper only: no wallet, no RPC.
 */
import { SimRun, type SimEvent, type SimTrade } from "./run";
import type { DifficultyId, SimConfig } from "./config";

type Emit = (e: Record<string, unknown>) => void;
export interface SimBridge {
  supply: number; balance(): number;
  attach(emit: Emit): () => void;
  impact(usd: number, side: "buy" | "sell"): number;
  trade(side: "buy" | "sell", usd: number, o?: { frac?: number }): Record<string, unknown>;
}
declare global { interface Window { __discipleSim?: SimBridge } }

export class SimDriver {
  run: SimRun; speed = 1; paused = false; ended = false; iv = 0; block = 1; emit: Emit | null = null;
  listeners = new Set<() => void>(); eventSubs = new Set<(e: SimEvent) => void>();
  constructor(cfg: SimConfig, public difficulty: DifficultyId, public seed: number, public minutes: number) {
    this.run = new SimRun(cfg, difficulty, seed);
    this.run.on(({ trade, event }) => { if (trade) this.toEngine(trade); if (event) this.eventSubs.forEach((f) => f(event)); });
  }
  private toEngine(tr: SimTrade) {
    if (!this.emit) return;
    const S = this.run.m.S;
    this.emit({ t: "swap", block: this.block, ts: Date.now(), txHash: "sim:" + this.run.trades.length, side: tr.side, usd: tr.usd, mcap: tr.mcap, price: tr.mcap / S,
      prePrice: tr.preMcap / S, postPrice: tr.mcap / S, impactPct: (tr.mcap / tr.preMcap - 1) * 100, trader: tr.mine ? undefined : tr.trader, mine: tr.mine });
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
      attach(emit) { self.emit = emit; emit({ t: "swap", block: self.block, ts: Date.now(), txHash: "(launch)", side: "buy", usd: 0, mcap: self.run.m.mcap(), price: self.run.m.price() }); return () => { self.emit = null; }; },
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
