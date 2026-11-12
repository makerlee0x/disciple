import { describe, expect, it } from "vitest";
import { stageLatency, type Ranges } from "./benchLatency";
const R: Ranges = { sim: [102, 125, 0.17, 195], send: [159, 305], kvIncr: [10, 40], privy: [98, 125, 0.15, 160], kvGate: [8, 16], rpc: [98, 125, 0.15, 160] };
const run = (stages: string[], trial = 7) => {
  const s = stageLatency(R); s.trial(trial);
  const out: Record<string, number[]> = {};
  // invoke wait but skip the timer: peek snapshot after scheduling by hijacking... just call wait and snapshot after microtask won't have finished timers.
  // We only need the planned draws, which are recorded synchronously before setTimeout.
  for (const k of stages) { void s.wait(k); out[k] = out[k] ?? []; /* filled below */ }
  const snap = s.snapshot();
  return snap;
};
describe("RELAY_BENCH independent stage streams", () => {
  it("the same stage at the same trial always draws the same delay, even if other stages are added or reordered", () => {
    const a = run(["sim", "kvGate", "kvIncr", "kvIncr", "send"]);
    const b = run(["privy", "rpc", "sim", "kvGate", "kvIncr", "kvIncr", "send"]); // extra hops first
    const c = run(["send", "kvIncr", "kvIncr", "kvGate", "sim"]); // reversed
    expect(a.sim).toBe(b.sim); expect(a.sim).toBe(c.sim);
    expect(a.send).toBe(b.send); expect(a.send).toBe(c.send);
    expect(a.kvGate).toBe(b.kvGate);
    expect(a.kvIncr).toBe(b.kvIncr); // max of the two incrs; occurrence 0 and 1 are stable
    expect(a.privy).toBe(0); expect(b.privy).toBeGreaterThan(0);
  });
  it("a different trial index gets an independent draw for the same stage", () => {
    const s = stageLatency(R); s.trial(3); void s.wait("send"); const x = s.snapshot().send;
    s.trial(4); void s.wait("send"); const y = s.snapshot().send;
    expect(x).not.toBe(y);
  });
});
