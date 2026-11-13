/**
 * Scripted pilots for Free play difficulty bands (test:sim-bands). Three skill levels that only use what a real
 * player sees: the price, their own position and the run feed (tells, dumps, rugs). They never read bot state or
 * the RNG. Each one is seeded separately from the run, so a pilot's own choices don't shift the market's seed.
 *
 *   Newbie: waits until the hype shows, buys a green candle with most of its cash, panics at −20…30%, holds out
 *           for the moon (4–8×), otherwise holds to the end.
 *   Casual: buys early with half its cash, sells all at +50…90% or stops out at −25…35%, and FOMOs back in once
 *           if the chart makes a new high above where it sold.
 *   Reader: buys early (never into a spike or while a warning is out), leaves on a tell (a holder peeling off, linked wallets, the dev wallet), banks a slice at
 *           2× and 3×, buys back once a dump has bounced (sooner when buyers board again), and is out before the clock runs down. It acts on a
 *           feed line 0.7–1.1 s after it appears (a human's reaction time). Reading tells
 *           is what should separate it from Casual.
 *
 * Target green rates (finish with total PnL > 0), 200 seeds per level — see DIFFICULTY_BANDS.
 */
import { mulberry32, type SimRun, type SimEvent } from "./run";
import type { DifficultyId } from "./config";

export type PilotId = "newbie" | "casual" | "reader";
export interface Pilot { tick(): void }

/** green-rate targets per difficulty and pilot (fraction of runs that finish green); the build fails > 5 points off */
export const DIFFICULTY_BANDS: Record<DifficultyId, Record<PilotId, number>> = {
  pve: { newbie: 0.65, casual: 0.85, reader: 0.95 },
  pvp: { newbie: 0.35, casual: 0.55, reader: 0.75 },
  trench: { newbie: 0.20, casual: 0.35, reader: 0.55 },
};
export const BAND_TOLERANCE = 0.05;

export function makePilot(id: PilotId, r: SimRun, seconds: number, seed: number): Pilot {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0), R = (a: number, b: number) => a + (b - a) * rng();
  const feed: SimEvent[] = []; r.on(({ event }) => { if (event) feed.push(event); });
  const price = () => r.m.price(), has = () => r.player.pos.size > 0, cash = () => r.player.cash;
  const entry = () => (r.player.pos.size > 0 ? r.player.pos.costBasis / r.player.pos.size : 0);
  const buy = (usd: number) => { if (usd >= 1 && usd <= cash() + 1e-9) r.playerTrade("buy", Math.min(usd, cash())); };
  const sell = (frac: number) => { if (has()) r.playerTrade("sell", 0, { frac }); };
  let seen = 0; const fresh = () => { const out = feed.slice(seen); seen = feed.length; return out; };

  if (id === "newbie") {   // chases a green candle once the hype is visible, panics on a deep red, else holds
    const from = R(10, 75), size = R(0.7, 1), panic = R(0.2, 0.3), moon = R(4, 8); let done = false, bought = false; const seen8: number[] = [];
    return { tick() { fresh(); if (done) return; const p = price();
      if (r.blk % 10 === 0) { seen8.push(p); if (seen8.length > 20) seen8.shift(); }
      // FOMO: it buys once the chart is visibly running (+40% in 20 s), or gives in after a while
      if (!bought && r.t >= from && (p >= seen8[0] * 1.4 || r.t >= from + 60)) { buy(cash() * size); bought = true; return; }
      if (bought && has()) { const u = p / entry(); if (u <= 1 - panic || u >= moon) { sell(1); done = true; } }
    } };
  }
  if (id === "casual") {   // early in, sells "when it feels like a lot", stops out, and FOMOs back in on a new high
    const at = R(6, 25), tp = R(0.5, 0.9), stop = R(0.25, 0.35); let state = 0, exitP = 0, reentries = 0;
    return { tick() { fresh(); const p = price();
      if (state === 0) { if (r.t >= at) { buy(cash() * 0.5); state = 1; } return; }
      if (state === 1) { if (!has()) { state = 2; return; } const u = p / entry() - 1;
        if (u >= tp) { sell(1); state = 2; exitP = p; } else if (u <= -stop) { sell(1); state = 3; } return; }
      if (state === 2 && reentries < 1 && p > exitP * 1.1 && seconds - r.t > 25) { buy(cash() * 0.6); reentries++; state = 1; }
    } };
  }
  // reader: rides the climb, leaves on a tell (a big holder peeling off, linked wallets, the dev wallet), banks on
  // strength, buys back once a dump has landed and bounced, and is out before the clock runs down
  const at = R(5, 15), exitLeft = R(8, 16), stop = R(0.3, 0.38), reactS = R(0.7, 1.1); let lo = Infinity, outT = -1e9, entered = false, out = false, banked = 0, hi = 0, lastTell = -1e9, boarded = -1e9, reentries = 0; const ago: number[] = [];
  const queue: SimEvent[] = [];   // a human sees the feed line, then takes reactS to act on it
  return { tick() { const p = price(); queue.push(...fresh()); let k = 0; while (k < queue.length && queue[k].t <= r.t - reactS) k++; const evs = queue.splice(0, k);
    const tell = evs.some((e) => e.kind === "tell"), rug = evs.some((e) => e.kind === "rug" || (e.kind === "tell" && !/peeling/.test(e.text)));
    if (r.t >= seconds - exitLeft) { if (has()) sell(1); return; }
    if (r.blk % 10 === 0) { ago.push(p); if (ago.length > 10) ago.shift(); }
    if (tell) lastTell = r.t;
    // entry: not into a spike (+30% in 10 s) and not while a warning is out; then it waits for the dump to bounce
    if (!entered) { if (r.t >= at && p < ago[0] * 1.3 && r.t - lastTell > 4) { buy(cash() * 0.6); entered = true; hi = p; } return; }
    if (has()) { if (p > hi) hi = p;
      if (rug || (tell && p > entry() * 0.95)) { sell(rug ? 1 : 0.8); out = true; outT = r.t; lo = p; return; }
      if (banked < 2 && p >= entry() * (banked ? 3 : 2)) { sell(0.35); banked++; return; }
      if (p <= hi * (1 - stop)) { sell(1); out = true; outT = r.t; lo = p; }
      return; }
    if (out) { if (p < lo) lo = p;
      if (evs.some((e) => e.kind === "pump" || e.kind === "whale")) boarded = r.t;
      // back in once the dump has bounced (sooner when buyers board again: a crowd, a whale); at most three times
      if (reentries < 3 && !tell && r.t - outT > 5 && (p >= lo * 1.06 || (boarded > outT + 3 && p >= lo * 1.03)) && seconds - r.t > 35) { buy(cash() * 0.5); out = false; hi = p; banked = 0; reentries++; } }
  } };
}

/** run one pilot through one seeded run of `seconds`; returns the run */
export function flyPilot(run: SimRun, id: PilotId, seconds: number, seed: number) {
  const p = makePilot(id, run, seconds, seed), N = Math.round(seconds / run.cfg.market.blockS);
  while (run.blk < N) { p.tick(); run.step(run.cfg.market.blockS); }
  return run;
}
