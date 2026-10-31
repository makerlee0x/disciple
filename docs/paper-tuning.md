# Paper Trading — bot tuning v2 (Oct 31, 2026)

Spec: `paper-trading-spec-v0.2.pdf` Sec. 6 (targets) / Sec. 11 (personas). Code: `web/lib/sim/paper.ts` (`TUNE`, `SIZE_SCALE`),
`web/lib/sim/paperRound.ts` (`PERSONA_TUNE`, `personaAct`). Harness: `web/scripts/paper-tune.mts`
(`npx tsx scripts/paper-tune.mts [N] [lobby|all] [personas] [seed0]`, overrides via `PAPER_TUNE='{json}'`).
Guard: `npm run test:paper-sim` ("win-rate bands", seeds 7000–7029, deterministic).

## Results (60 seeds each, seeds 7000–7059 and 9000–9059 averaged; rounds run the full 600 s)

| Lobby | Persona | Win before → after | Top-10 before → after | Ascend before → after | Spec target (decent) |
|---|---|---|---|---|---|
| Easy | decent | 0% → 7% | 3% → 46% | 13% → 0% | 15–25% / 50–60% |
| Easy | strong | 0% → 5% | 10% → 81% | 23% → 0% | |
| Easy | novice | 0% → 1% | 0% → 3% | 17% → 0% | |
| Medium | decent | 0% → 4% | 3% → 42% | 77% → 69% | 5–10% / 30–35% |
| Medium | strong | 20% → 43% | 67% → 92% | 83% → 66% | |
| Medium | novice | 3% → 3% | 30% → 13% | 73% → 72% | |
| Hard | decent | 0% → 0% | 0% → 6% | 90% → 89% | 0–3% / 10–15% |
| Hard | strong | 57% → 17% | 90% → 96% | 87% → 92% | 10–20% (lee) |
| Hard | novice | 3% → 1% | 10% → 7% | 90% → 91% | |

"Before" = 30 seeds (1000–1029), v1 personas, v1 bots.

Average bot PnL per tier ($, decent runs; E / M / H): Easy lobby 0.7 / −42.7 / 160.1 → −7.6 / 16.2 / 18.3;
Medium lobby 208.8 / −69.6 / 117.9 → 92.7 / 5.6 / 5.9; Hard lobby 2.2 / −255.6 / 134.7 → 67.0 / −83.0 / 64.7.

## Decent persona (was it realistic?)
v1 was not: it bought ≤ the $100 preset (10% of a Hard stack, 20% of Medium), sold 100% by +50%, and reacted to single ticks
in a market that swings ±50% in seconds, so it could never reach a top-10 that sits at +50–200%. v2:
- sizes 70% of cash per entry (custom amount), capped so the buy moves price ≤ 6% (what the HUD's price-move line shows);
- reads a 6 s average (the candle a human looks at), not the last tick; entries need +4%/10 s and, after 30 s, a +6.5%/30 s trend;
  it may take the opening push from t = 3 s;
- −16% stop before the first take-profit, 1/3 off at +40%, half the rest at +100%, trails the last part at −39% from the peak;
  20 s cool-down between entries.
Strong and novice personas are unchanged.

## Parameter changes vs the spec table (every deviation)
| Knob | Spec / v1 | v2 | Why |
|---|---|---|---|
| Easy momentum window | 2 s | 6 s | 140 bots on one 2 s signal stampeded together (±50% second-scale whipsaw) |
| Easy cool-down | 3 s | 6.8 s | same |
| Medium cool-down | 4 s | 6.3 s | less churn; gas was bleeding Medium |
| Medium min trade | $5 | $2.4 | (at $500 × 0.15 scale) |
| Hard cool-down | 5 s | 10 s | Hard bots herded on each other |
| Hard buy threshold | 0.35 | 0.26 | with longer cool-down they still enter |
| Hard min trade | $12 | $5.4 | at the smaller scaled stack |
| SIZE_SCALE E/M/H (ASSUMPTION #224) | 1 / 0.13 / 0.11 | 0.87 / 0.15 / 0.15 | Hard bots were too small vs the strong player |
| Per-bot size multiplier (new) | — | lognormal σ 0.68 / 0.79 / 1.2, mean 1 | a few whales, many small bettors |
| Backdrop mood bias per lobby (new) | — | −0.04 / −0.09 / +0.12 | demand regime per lobby |
| Price-impact cap (new) | — | off (0) | available knob, not used |
All other per-tier/archetype behaviour values are the spec's (with the existing ±12% per-bot jitter).

## Caveats / misses
- **Easy lobby no longer ascends (0%, target 25–50%; was 13%).** The lobby holds only ~$20K, and graduation needs ~$6.45K held at once;
  calm Easy bots that take profit at +15% stall at 95–99% of the curve. v1's ascents came from the 2 s stampedes that also made the
  lobby unwinnable. Moving it needs a spec decision (bigger Easy stacks, lower Easy-lobby graduation, or hold-through-ascend Easy bots).
- Decent misses narrowly: Easy wins 7% (15–25%), Medium 4% (5–10%) with top-10 42% (30–35%), Hard top-10 6% (10–15%).
- Tier order: Hard > Easy in the Easy lobby and (narrowly) the Hard lobby; in the Medium lobby Easy diamond-hands riding the ascent
  still beat Hard (as in v1). Medium bots still lose in the Hard lobby (−8% of stack). The test only asserts Easy and Hard lobbies.
- Strong still wins 43% on Medium.
- Rounds keep trading after ASCEND (full 600 s), as in SimDriver.
- 30–60 seeds ⇒ ±5–7 pp noise on each percentage; small knob roundings moved Hard strong win 28% → 35% at the same scale.
- Money/token conservation is checked on the curve and after ASCEND (pool + floor) in test:paper-sim.
