// PAPER TRADING tuning suite (spec Sec. 11): N seeded matches per difficulty with a scripted persona as the player.
// Prints graduation rate, time-to-graduation, persona win / top-10 rate, average net worth by bot tier, fees, and the
// drama metric (1st place changed in the final minute). Run: npx tsx scripts/paper-suite.mts [N=30] [persona=decent]
import { PaperRound } from "../lib/paper/engine";
import { roundSummary } from "../lib/paper/export";
import { personaAct, type Persona } from "../lib/paper/personas";
const N = +(process.argv[2] || 30), who = (process.argv[3] || "decent") as Persona;
let seedRand = 12345; Math.random = () => ((seedRand = (seedRand * 1103515245 + 12345) % 2 ** 31) / 2 ** 31); // novice randomness, reproducible
for (const d of ["easy", "medium", "hard"] as const) {
  let grad = 0, gradT = 0, win = 0, top10 = 0, drama = 0, fees = 0, gas = 0, snipe = 0, trades = 0;
  const tier: Record<string, number[]> = {};
  for (let i = 0; i < N; i++) {
    const r = new PaperRound(d, 1000 + i), st = { peak: 0, entry: 0, ladder: 0, last: -1e9 };
    while (!r.ended) { if (r.tick % 4 === 0) personaAct(r, who, st); r.step(); }
    const s = roundSummary(r);
    if (s.graduated) { grad++; gradT += s.graduationSec!; }
    if (s.player.rank === 1) win++; if (s.player.rank <= 10) top10++; if (s.leaderChangedInFinalMinute) drama++;
    fees += s.fees; gas += s.gas; snipe += s.sniperTax; trades += s.trades;
    for (const [k, v] of Object.entries(s.byTier)) (tier[k] ??= []).push(v.avgNetWorth);
  }
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`${d.padEnd(6)} grad ${(grad / N * 100).toFixed(0)}%${grad ? ` @${(gradT / grad).toFixed(0)}s` : ""} · ${who} win ${(win / N * 100).toFixed(0)}% top10 ${(top10 / N * 100).toFixed(0)}% · tiers ${["easy", "medium", "hard", "player"].map((k) => `${k} ${tier[k] ? avg(tier[k]).toFixed(1) : "-"}`).join(" / ")} · fees $${(fees / N).toFixed(0)} gas $${(gas / N).toFixed(0)} snipe $${(snipe / N).toFixed(2)} · trades ${(trades / N).toFixed(0)} · drama ${(drama / N * 100).toFixed(0)}%`);
}
