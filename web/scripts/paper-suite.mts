// PAPER TRADING tuning suite (spec Sec. 11) on the sim market: N seeded rounds per difficulty with a scripted persona.
// Run: npx tsx scripts/paper-suite.mts [N=30] [persona=decent]
import { SimRun } from "../lib/sim/run";
import { paperLobby, PAPER_DIFFS } from "../lib/sim/paper";
import { personaAct, newPersonaState, roundSummary, type Persona } from "../lib/sim/paperRound";
const N = +(process.argv[2] || 30), who = (process.argv[3] || "decent") as Persona;
let sr = 12345; const rand = () => ((sr = (sr * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (const d of PAPER_DIFFS) {
  let grad = 0, gradT = 0, win = 0, top10 = 0, fees = 0, trades = 0; const tier: Record<string, number[]> = {}; const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const L = paperLobby(d), run = new SimRun(L.cfg, L.difficulty, 1000 + i, { brain: L.brain, endOnGraduate: true }), st = newPersonaState();
    let next = 0; while (run.t < L.minutes * 60 - 1e-9 && run.endedAt == null) { if (run.t >= next) { personaAct(run, L.brain, who, st, rand); next += 1; } run.step(run.cfg.market.blockS); }
    const s = roundSummary(run, L.brain);
    if (s.graduated) { grad++; gradT += s.graduationSec!; }
    if (s.player.rank === 1) win++; if (s.player.rank <= 10) top10++; fees += s.fees; trades += s.trades;
    for (const [k, v] of Object.entries(s.byTier)) (tier[k] ??= []).push(v.avgPnl);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`${d.padEnd(6)} grad ${(grad / N * 100).toFixed(0)}%${grad ? ` @${(gradT / grad).toFixed(0)}s` : ""} · ${who} win ${(win / N * 100).toFixed(0)}% top10 ${(top10 / N * 100).toFixed(0)}% · avg PnL ${["easy", "medium", "hard", "player"].map((k) => `${k} ${tier[k] ? avg(tier[k]).toFixed(1) : "-"}`).join(" / ")} · fees $${(fees / N).toFixed(0)} · trades ${(trades / N).toFixed(0)} · ${((Date.now() - t0) / N).toFixed(0)}ms/round`);
}
