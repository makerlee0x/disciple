// Adaptive (Elo-style) bots: every skill × lobby cell lands in its band, with orderings, on test seeds 7000+.
// Tuning used held-out seeds 30000–30119; these seeds are separate. Band edges allow ±2 rounds of 120 (binomial SE at n=120 is 2–4.5 pts) for noise.
import test from "node:test";
import assert from "node:assert/strict";
import { SimRun } from "../lib/sim/run";
import { paperLobby, type PaperDifficulty } from "../lib/sim/paper";
import { personaAct, newPersonaState, roundSummary, type Persona } from "../lib/sim/paperRound";
import { newRating, applyHandicap, behaviourScore, updateRating, BANDS, tierOf } from "../lib/sim/rating";
const N = 120, S0 = 7000, TOL = 2 / N + 1e-9;
function cell(d: PaperDifficulty, who: Persona) {
  let r = newRating(), win = 0, top10 = 0;
  for (let i = 0; i < N; i++) { const seed = S0 + i; let sr = seed; const rand = () => ((sr = (sr * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const L = paperLobby(d); applyHandicap(L.brain, r); const run = new SimRun(L.cfg, L.difficulty, seed, { brain: L.brain, endOnGraduate: true }), st = newPersonaState(); let next = 0;
    while (run.t < 600 && run.endedAt == null) { if (run.t >= next) { personaAct(run, L.brain, who, st, rand); next += 1; } run.step(run.cfg.market.blockS); }
    const S = roundSummary(run, L.brain); if (S.player.rank === 1) win++; if (S.player.rank <= 10) top10++;
    r = updateRating(r, d, { rank: S.player.rank, s: behaviourScore(run, L.brain), ascended: S.graduated }); }
  return { win: win / N, top10: top10 / N, R: r.R };
}
const P: Persona[] = ["novice", "decent", "strong"], D: PaperDifficulty[] = ["easy", "medium", "hard"];
const res: Record<string, ReturnType<typeof cell>> = {};
for (const d of D) for (const p of P) test(`${d} ${p} in band`, () => {
  const c = (res[d + p] = cell(d, p)), b = BANDS[p][d];
  assert.equal(tierOf(c.R), p, `rating tier R=${c.R}`);
  assert.ok(c.win >= b.win[0] - TOL && c.win <= b.win[1] + TOL, `win ${c.win} vs ${b.win}`);
  assert.ok(c.top10 >= b.top10[0] - TOL && c.top10 <= b.top10[1] + TOL, `top10 ${c.top10} vs ${b.top10}`);
});
test("orderings: strong > decent > novice and Easy > Medium > Hard", () => {
  for (const d of D) { assert.ok(res[d + "strong"].top10 > res[d + "decent"].top10 && res[d + "decent"].top10 > res[d + "novice"].top10, d);
    assert.ok(res[d + "strong"].win > res[d + "decent"].win, d);
    // Hard decent vs novice wins are both ~0–2 of 120 (bands 0–3% vs 0–2%): only non-inversion within 2 rounds is testable
    assert.ok(res[d + "decent"].win >= res[d + "novice"].win - (d === "hard" ? TOL : 0), d); }
  for (const p of P) { assert.ok(res["easy" + p].top10 > res["medium" + p].top10 && res["medium" + p].top10 > res["hard" + p].top10, p);
    assert.ok(res["easy" + p].win >= res["medium" + p].win && res["medium" + p].win >= res["hard" + p].win, p); }
});
