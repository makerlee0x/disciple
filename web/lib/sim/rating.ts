/**
 * PAPER TRADING v4: adaptive, Elo-style bots (lee, Oct 31 12:51 PM CT: "think about this like chess elo").
 *
 * 1. RATING. After each round the player's behaviour is scored s ∈ [0, 1] from their own trades:
 *    entry quality (buying dips vs chasing the last 10 s pump) and exit discipline (sells per buy: cutting / laddering vs
 *    bag-holding). Rating R = 800 + 1200·s, carried across rounds as an EMA (Elo-scale, 1400 ≈ a "decent" player).
 *    Results (wins) never move R, so winning a lot does not make you look "novice"; R only reads HOW you trade.
 * 2. TARGET. R picks the target band (BANDS) by interpolating between the novice / decent / strong anchors.
 * 3. HANDICAP. Two integral controllers per lobby, carried across rounds, steer the bots toward that target:
 *    botCashK (every bot's bankroll) tracks the top-10 target, eliteK (the 5 most aggressive bots' bankroll) tracks the
 *    win target. They move the bots only; the player and the market rules are untouched.
 */
import type { SimRun } from "./run";
import type { PaperBrain, PaperDifficulty } from "./paper";

export type Skill = "novice" | "decent" | "strong";
/** win / top-10 target bands (fractions). decent = spec v0.2 Sec. 6; novice + strong DERIVED (monotone; see docs/paper-tuning.md v4) */
export const BANDS: Record<Skill, Record<PaperDifficulty, { win: [number, number]; top10: [number, number] }>> = {
  strong: { easy: { win: [0.30, 0.45], top10: [0.70, 0.90] }, medium: { win: [0.15, 0.25], top10: [0.55, 0.75] }, hard: { win: [0.10, 0.20], top10: [0.35, 0.55] } },
  decent: { easy: { win: [0.15, 0.25], top10: [0.50, 0.60] }, medium: { win: [0.05, 0.10], top10: [0.30, 0.35] }, hard: { win: [0.00, 0.03], top10: [0.10, 0.15] } },
  novice: { easy: { win: [0.03, 0.10], top10: [0.20, 0.35] }, medium: { win: [0.00, 0.04], top10: [0.10, 0.20] }, hard: { win: [0.00, 0.02], top10: [0.02, 0.08] } },
};
/** rating anchors (R of the scripted personas' behaviour, measured) */
export const ANCHOR_R: Record<Skill, number> = { novice: 950, decent: 1500, strong: 1940 };
/** within ±PLATEAU of an anchor the target is that tier's band exactly */
export const PLATEAU = 200;
export const RATING = { ema: 0.35, eta: 0.25, couple: 1.5, clamp: 4, kMin: 0.05, kMax: 8, start: 1500 };

export interface PlayerRating { R: number; n: number; /** log handicaps per lobby (integral state) */ logK: Record<PaperDifficulty, number>; logE: Record<PaperDifficulty, number> }
export const newRating = (): PlayerRating => ({ R: RATING.start, n: 0, logK: { easy: 0, medium: 0, hard: 0 }, logE: { easy: 0, medium: 0, hard: 0 } });

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const mid = (b: [number, number]) => (b[0] + b[1]) / 2;
/** target (centre of band) for rating R in lobby d: piecewise-linear between the anchors */
export function targetFor(d: PaperDifficulty, R: number) {
  const pts: [number, Skill][] = [[ANCHOR_R.novice, "novice"], [ANCHOR_R.decent, "decent"], [ANCHOR_R.strong, "strong"]];
  for (const [r0] of pts) if (Math.abs(R - r0) <= PLATEAU) R = r0;
  const at = (k: Skill) => ({ win: mid(BANDS[k][d].win), top10: mid(BANDS[k][d].top10) });
  if (R <= pts[0][0]) return at("novice"); if (R >= pts[2][0]) return at("strong");
  const i = R < pts[1][0] ? 0 : 1, [r0, a] = pts[i], [r1, b] = pts[i + 1], f = (R - r0) / (r1 - r0), A = at(a), B = at(b);
  return { win: A.win + (B.win - A.win) * f, top10: A.top10 + (B.top10 - A.top10) * f };
}
/** skill tier nearest to R (for display / tests) */
export const tierOf = (R: number): Skill => (R < (ANCHOR_R.novice + ANCHOR_R.decent) / 2 ? "novice" : R < (ANCHOR_R.decent + ANCHOR_R.strong) / 2 ? "decent" : "strong");

/** behaviour score s ∈ [0, 1] from the player's trades this round (null if they never bought) */
export function behaviourScore(run: SimRun, brain: PaperBrain): number | null {
  const B = run.cfg.market.blockS, h = brain.hist, my = brain.log.filter((x) => x.mine);
  const buys = my.filter((x) => x.side === "buy"), sells = my.filter((x) => x.side === "sell");
  if (!buys.length) return null;
  let mom = 0; for (const x of buys) { const k = Math.round(x.t / B), p = h[Math.max(0, k - Math.round(10 / B))] ?? x.preMcap; mom += x.preMcap / p - 1; }
  mom /= buys.length;
  const entry = clamp(1 - mom / 0.3, 0, 1), exit = clamp(sells.length / buys.length, 0, 1);
  return 0.5 * entry + 0.5 * exit;
}

/** the handicap for the next round in lobby d */
export function handicapFor(r: PlayerRating, d: PaperDifficulty) {
  const E = Math.exp(BASE_LOGE[d](r.R) + r.logE[d]);
  return { botCashK: clamp(Math.exp(BASE_LOGK[d](r.R) + r.logK[d]), RATING.kMin, RATING.kMax), eliteK: E };
}
/** starting bankroll multiple per lobby by rating (rough calibration, v4); the controllers correct from here */
const lerp3 = (n: number, dd: number, s: number) => (R: number) => R <= ANCHOR_R.decent ? Math.log(n) + (Math.log(dd) - Math.log(n)) * clamp((R - ANCHOR_R.novice) / (ANCHOR_R.decent - ANCHOR_R.novice), 0, 1)
  : Math.log(dd) + (Math.log(s) - Math.log(dd)) * clamp((R - ANCHOR_R.decent) / (ANCHOR_R.strong - ANCHOR_R.decent), 0, 1);
/** starting elite multiple by rating (Hard novice starts with richer elites so an early lucky round is rarer) */
export const BASE_LOGE: Record<PaperDifficulty, (R: number) => number> = { easy: lerp3(1, 1, 1), medium: lerp3(1, 1, 1), hard: lerp3(3, 1, 1) };
export const BASE_LOGK: Record<PaperDifficulty, (R: number) => number> = { easy: lerp3(0.65, 1.2, 0.6), medium: lerp3(1, 1, 0.55), hard: lerp3(1, 0.85, 0.6) };

/** set the handicap on a fresh brain (before SimRun init) */
export function applyHandicap(brain: PaperBrain, r: PlayerRating) { const h = handicapFor(r, brain.difficulty); brain.botCashK = h.botCashK; brain.eliteK = h.eliteK; return h; }

/** after a round: update R from behaviour, then the two controllers from the result vs the target */
export function updateRating(r: PlayerRating, d: PaperDifficulty, res: { rank: number; s: number | null }): PlayerRating {
  const o: PlayerRating = { R: r.R, n: r.n + 1, logK: { ...r.logK }, logE: { ...r.logE } };
  if (res.s != null) { const Rs = 800 + 1200 * res.s; o.R = r.n === 0 ? Rs : r.R + RATING.ema * (Rs - r.R); }
  const t = targetFor(d, o.R), win = res.rank === 1 ? 1 : 0, top10 = res.rank <= 10 ? 1 : 0;
  // novice side (wN: 1 at novice → 0 at decent): bankroll can't push a buy-and-hold novice down under PnL ranking (richer bots ⇒ the coin ascends ⇒
  // the holder profits), so there the elite count/stack (E) steers top-10 too and K stays at its base
  const wN = clamp((ANCHOR_R.decent - o.R) / (ANCHOR_R.decent - ANCHOR_R.novice), 0, 1);
  const sW = clamp((o.R - ANCHOR_R.decent) / (ANCHOR_R.strong - ANCHOR_R.decent), 0, 1);
  const dK = RATING.eta * ((top10 - t.top10) + RATING.couple * sW * (win - t.win));   // player too high → richer (bigger-sizing) bots
  o.logK[d] = clamp(o.logK[d] + dK, -RATING.clamp, RATING.clamp);
  o.logE[d] = clamp(o.logE[d] + RATING.eta * (2 * (win - t.win) + 3 * wN * (top10 - t.top10)), -RATING.clamp, RATING.clamp);
  return o;
}
