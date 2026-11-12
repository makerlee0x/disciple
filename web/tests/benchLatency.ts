/**
 * RELAY_BENCH latency model with one independently seeded stream per (stage, trial, occurrence).
 * Each draw seeds a fresh mulberry32 from hash(stage, trial, nth call of that stage in the trial), so adding or
 * removing a stage (e.g. a privy or rpc hop) cannot shift any other stage's draws. Distribution per stage is the
 * same formula and RANGES as before: with prob tp a tail draw in [hi, th], else uniform [lo, hi].
 * Also records the planned delays of the current trial so the report can separate planned path from JS slop.
 */
export type Ranges = Record<string, [number, number, number?, number?]>;
const mulberry = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const fnv = (s: string) => { let x = 0x811c9dc5; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); } return x >>> 0; };
export function stageLatency(ranges: Ranges, baseSeed = 20261109) {
  let trial = -1, seen: Record<string, number> = {}, draws: [string, number][] = [];
  return {
    /** Start trial i (call once per trial, before the request). */
    trial(i: number) { trial = i; seen = {}; draws = []; },
    /** Same distribution as before; stream keyed by stage name, trial index and occurrence. */
    wait(k: string): Promise<void> {
      const [lo, hi, tp, th] = ranges[k];
      const n = (seen[k] = (seen[k] ?? 0) + 1) - 1;
      const r = mulberry(fnv(`${baseSeed}|${k}|${trial}|${n}`));
      const ms = tp && r() < tp ? hi + r() * ((th ?? hi) - hi) : lo + r() * (hi - lo);
      draws.push([k, ms]);
      return new Promise(res => setTimeout(res, ms));
    },
    /** Planned delays for this trial. `path` is max(sim, kvGate, privy) + max(kvIncr) + send.
     *  Background/non-blocking rpc (cached base-fee refresh) is recorded but not added to `path`. */
    snapshot() {
      const all = (k: string) => draws.filter(d => d[0] === k).map(d => d[1]);
      const mx = (k: string) => Math.max(0, ...all(k));
      const admission = Math.max(mx("sim"), mx("kvGate"), mx("privy"));
      return { path: admission + mx("kvIncr") + mx("send"), sim: mx("sim"), kvGate: mx("kvGate"), privy: mx("privy"),
        rpc: mx("rpc"), kvIncr: mx("kvIncr"), send: mx("send") };
    },
  };
}
