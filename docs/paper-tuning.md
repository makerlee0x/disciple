# Paper Trading — bot tuning v2 (Oct 31, 2026)

Code: `web/lib/sim/paper.ts` (`TUNE`, `SIZE_SCALE`), `web/lib/sim/paperRound.ts` (`PERSONA_TUNE`, decent persona).
Harness: `npx tsx web/scripts/paper-tune.mts [N] [lobby|all] [personas] [seed0]` (`PAPER_TUNE='{...}'` env overrides).
Regression: `npm run test:paper-sim` asserts win-rate bands on seeds 7000–7029 (deterministic).
Method: hand diagnosis, then ~560 random-search configs (20 seeds each) scored against spec Sec. 6, best confirmed on 2×60 fresh seeds.

## Results (60 seeds × 2 seed sets, 7000.. / 9000..; round runs the full 600 s)

| Lobby | Persona | Win % before → after | Top-10 % before → after | Ascend % before → after | Spec Sec. 6 (decent) |
|---|---|---|---|---|---|
| Easy | decent | 0 → 7 | 3 → 46 | 13 → 0 | 15–25 / 50–60 |
| Easy | strong | 0 → 5 | 10 → 81 | 23 → 0 | |
| Easy | novice | 0 → 1 | 0 → 3 | 17 → 0 | |
| Medium | decent | 0 → 3.5 | 3 → 41 | 77 → 68 | 5–10 / 30–35 |
| Medium | strong | 20 → 42 | 67 → 91 | 83 → 66 | |
| Medium | novice | 3 → 2.5 | 30 → 12 | 73 → 71 | |
| Hard | decent | 0 → 0 | 0 → 6 | 90 → 89 | 0–3 / 10–15 |
| Hard | strong | 57 → 17 | 90 → 96 | 87 → 91 | target 10–20 |
| Hard | novice | 3 → 1 | 10 → 7 | 90 → 91 | |

Avg bot PnL per tier, $ (decent runs), Easy / Medium / Hard tier:
Easy lobby 0.7 / −42.7 / 160.1 → −7.6 / 16.2 / 18.3 · Medium lobby 208.8 / −69.6 / 117.9 → 92.7 / 5.6 / 5.9 · Hard lobby 2.2 / −255.6 / 134.7 → 67.0 / −83.0 / 64.7.
Before = 30 seeds from 1000 (committed code); after = mean of the two 60-seed sets.

## Decent persona (spec Sec. 11 "momentum entries, −15% stop, ladders out") — why it changed
v1 sized to the nearest $10–100 preset at 40% of cash (= 10% of a Hard stack), stopped out on single ticks in a market that
whipsaws ±30–50% in seconds, and sold 100% by +50%, so it could never reach a top-10 bar of +60–200%. v2 still does the
spec behaviours but like a competent human: types a custom amount (~70% of cash) capped so the buy moves price ≤ 6% (the
HUD shows this), reads a 6 s average not the last tick, needs a 30 s trend > +6.5% (or the opening push after t > 3 s),
stop −16% before the first ladder, sells 1/3 at +40%, half the rest at +100%, trails the remainder −39% from the peak,
20 s cooldown. Knobs: `PERSONA_TUNE`. Strong and novice are unchanged.

## Parameter changes vs the spec table (every deviation)
| Param | Spec / v1 | v2 | Why |
|---|---|---|---|
| Easy `windows` | [2] s | [6] s | 140 bots on one 2 s signal → second-scale stampedes |
| Easy `cooldownS` | 3 | 6.8 | same |
| Medium `cooldownS` / `minTradeUsd` | 4 / $5 | 6.3 / $2.4 | gas churn bled Medium |
| Hard `cooldownS` / `buyTh` / `minTradeUsd` | 5 / 0.35 / $12 | 10 / 0.26 / $5.4 | less herding, more but smaller entries |
| `SIZE_SCALE` E/M/H | 1 / 0.13 / 0.11 (#224 assumption) | 0.87 / 0.15 / 0.15 | Hard bots bet too little, strong farmed them |
| per-bot size `aggSigma` E/M/H (new) | — | 0.68 / 0.79 / 1.2 | lognormal, mean 1: a few whales, many minnows |
| `moodBias` E/M/H (new) | 0 | −0.04 / −0.09 / +0.12 | demand regime per lobby |
| `maxImpact` (new) | — | 0 (off) | searched, not helpful |
Spec ranges for reaction times, noise, stops, ladders, archetype mix and lobby mix are untouched.

## Caveats / misses
- **Easy lobby no longer ascends (13% → 0%).** It peaks at g ≈ 0.95–0.99: the $20K lobby must hold $6.45K at once and
  Easy bots take profit at +15%. v1 only graduated via the stampedes removed here. Raising mood, size, maxPos, ladders or
  active window did not get it over (tested); needs a spec call (smaller grad target for Easy, or bigger stacks).
- Decent is a bit under band: Easy win 7% (15–25), Medium win 3.5% (5–10, top-10 41% vs 30–35), Hard top-10 6% (10–15).
- Tier order: Hard > Easy holds in the Easy lobby and roughly ties in the Hard lobby; in the Medium lobby Easy diamond
  hands ride the ascent and beat Hard (true before too). Medium-tier bots still lose in the Hard lobby. Test asserts Easy + Hard lobbies only.
- Novice wins ≤ ~3% everywhere. Strong still wins 42% on Medium.
- 30–60 seed estimates have ±5–7 pt noise; results are sensitive to small knob changes (rng draws shift).
- Rounds run the full 600 s after ASCEND (not ended at graduation), as before.
