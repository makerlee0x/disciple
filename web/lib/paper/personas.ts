/** Scripted player personas for the tuning suite (spec Sec. 11): Novice, Decent, Strong. They act only through
 *  PaperRound.intent() — the same validated, rate-limited path as a human — and see only public state. */
import type { PaperRound } from "./engine";

export type Persona = "novice" | "decent" | "strong";
export interface PersonaState { peak: number; entry: number; ladder: number; last: number }

/** called once per simulated second */
export function personaAct(r: PaperRound, who: Persona, s: PersonaState) {
  const p = r.player, m = r.mcap, path = r.path, k = path.length - 1, back = (sec: number) => path[Math.max(0, k - sec * 4)];
  const value = p.tokens * r.price, mom = m / back(10) - 1;
  if (p.tokens > 0) s.peak = Math.max(s.peak, m);
  const preset = [10, 25, 50, 100].filter((x) => x <= p.cash - r.cfg.gasFeeFlat);
  const size = (f: number) => { const v = r.cfg.startCash * f; return preset.length ? preset.reduce((a, x) => (Math.abs(x - v) < Math.abs(a - v) ? x : a)) : 0; };
  if (who === "novice") {
    if (mom > 0.05 && Math.random() < 0.3 && p.cash > 11) r.intent({ kind: "buy", amountUsd: size(0.25) });
    else if (p.tokens > 0 && Math.random() < 0.02) r.intent({ kind: "sell", pct: 100 });
    return;
  }
  if (who === "decent") {
    if (p.tokens === 0 && mom > 0.04 && r.t > 8 && p.cash > 11) { r.intent({ kind: "buy", amountUsd: Math.min(p.cash * 0.4, size(0.4)) }); s.entry = m; s.ladder = 0; return; }
    if (p.tokens > 0) {
      const g = m / s.entry - 1;
      if (g < -0.15) { r.intent({ kind: "sell", pct: 100 }); return; }
      if (s.ladder === 0 && g > 0.25) { s.ladder = 1; r.intent({ kind: "sell", pct: 50 }); return; }
      if (s.ladder === 1 && g > 0.5) { s.ladder = 2; r.intent({ kind: "sell", pct: 100 }); }
    }
    return;
  }
  // strong: dip buys vs 60s high, trailing stop, scales out near graduation
  let hi = m; for (let i = 1; i <= 60; i += 5) hi = Math.max(hi, back(i));
  if (r.t > 8 && m < hi * 0.9 && p.cash > 11 && value < r.cfg.startCash * 0.6 && r.t - s.last > 10) { r.intent({ kind: "buy", amountUsd: size(0.2) }); s.last = r.t; return; }
  if (p.tokens > 0 && m < s.peak * 0.9) { r.intent({ kind: "sell", pct: 100 }); s.peak = 0; return; }
  if (p.tokens > 0 && r.pctSold > 70) r.intent({ kind: "sell", pct: 25 });
}
