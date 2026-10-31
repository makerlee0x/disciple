// PAPER TRADING tuning harness: every lobby × persona over N fixed seeds; wins / top-10 / ascend / avg PnL per tier.
// Run: npx tsx scripts/paper-tune.mts [N=30] [lobby=all] [personas=decent,strong,novice] [seed0=1000]
import { SimRun } from "../lib/sim/run";
import { paperLobby, PAPER_DIFFS, SIZE_SCALE, START_CASH, TUNE, type PaperDifficulty } from "../lib/sim/paper";
// optional overrides: PAPER_TUNE='{"aggSigma":{"hard":1},"sizeScale":{"hard":0.2},"tier":{"medium":{"minTradeUsd":10}}}'
if (process.env.PAPER_TUNE) { const o = JSON.parse(process.env.PAPER_TUNE); for (const k of ["aggSigma", "moodBias", "maxImpact"] as const) Object.assign(TUNE[k], o[k] ?? {}); Object.assign(SIZE_SCALE, o.sizeScale ?? {}); Object.assign(PERSONA_TUNE, o.persona ?? {}); Object.assign(START_CASH, o.startCash ?? {}); Object.assign(TUNE.lobby, o.lobby ?? {});
  for (const k of ["tier", "arch"] as const) for (const [t, v] of Object.entries(o[k] ?? {})) (TUNE[k] as Record<string, object>)[t] = { ...((TUNE[k] as Record<string, object>)[t] ?? {}), ...(v as object) }; }
import { personaAct, newPersonaState, roundSummary, standings, PERSONA_TUNE, type Persona } from "../lib/sim/paperRound";
const N = +(process.argv[2] || 30), only = process.argv[3] && process.argv[3] !== "all" ? [process.argv[3] as PaperDifficulty] : PAPER_DIFFS;
const who = (process.argv[4] || "decent,strong,novice").split(",") as Persona[], seed0 = +(process.argv[5] || 1000);
export function playRound(d: PaperDifficulty, seed: number, p: Persona) {
  let sr = seed; const rand = () => ((sr = (sr * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const L = paperLobby(d), run = new SimRun(L.cfg, L.difficulty, seed, { brain: L.brain }), st = newPersonaState();
  let next = 0; while (run.t < L.minutes * 60 - 1e-9) { if (run.t >= next) { personaAct(run, L.brain, p, st, rand); next += 1; } run.step(run.cfg.market.blockS); }
  return { run, brain: L.brain };
}
for (const d of only) for (const p of who) {
  let win = 0, top10 = 0, grad = 0; const tier: Record<string, number> = {}, top: number[] = [], t10: number[] = [], rk: number[] = [];
  for (let i = 0; i < N; i++) {
    const { run, brain } = playRound(d, seed0 + i, p), s = roundSummary(run, brain), st = standings(run, brain);
    if (s.graduated) grad++; rk.push(s.player.rank); if (s.player.rank === 1) win++; if (s.player.rank <= 10) top10++;
    for (const [k, v] of Object.entries(s.byTier)) tier[k] = (tier[k] ?? 0) + v.avgPnl / N;
    top.push(st[0].pnl / s.startCash); t10.push(st[9].pnl / s.startCash);
  }
  const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  console.log(`${d.padEnd(6)} ${p.padEnd(6)} win ${(win / N * 100).toFixed(0).padStart(3)}% top10 ${(top10 / N * 100).toFixed(0).padStart(3)}% ascend ${(grad / N * 100).toFixed(0).padStart(3)}% | PnL E ${tier.easy.toFixed(1)} M ${tier.medium.toFixed(1)} H ${tier.hard.toFixed(1)} you ${tier.player.toFixed(1)} | med #1 ${(med(top) * 100).toFixed(0)}% #10 ${(med(t10) * 100).toFixed(0)}% | med rank ${med(rk)}`);
}
