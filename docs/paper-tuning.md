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

## v2.1 — Easy lobby stacks $100 → $135 (Oct 31, 6:15 AM CT, lee's decision)
Fixes "Easy never ascends". Graduation amount unchanged ($6.45K net raise); Medium and Hard untouched (identical results on the same seeds).
- `START_CASH.easy` 100 → **135** for the player and every bot tier (Easy, Medium, Hard bots in the Easy lobby all start equal).
- `SIZE_SCALE.easy` 0.87 → **0.7** (Easy-lobby only), so per-trade bets stay ≈ $95 × size like before; the extra cash is dry powder.
- Sweep (30 seeds, decent): $110 → 0% ascend, $120 → 33%, $130 → 73%, $150+ → ~100%. The ascend rate is a steep step, so small changes swing it.

Easy lobby, 120 seeds (60 from 7000 + 60 from 9000), round runs 600 s:
| Persona | Win % | Top-10 % | Ascend % | Avg PnL $ E / M / H tier |
|---|---|---|---|---|
| decent | 21.5 | 52 | 58.5 | −0.7 / 25.1 / 69.8 |
| strong | 3.5 | 79 | 67.5 | −0.2 / 23.9 / 55.8 |
| novice | 0 | 1 | 70.5 | −1.4 / 25.8 / 72.8 |
Spec decent targets 15–25% / 50–60%: both met. Ascend ≈ 58–70% (target 40–70%).
Caveats: strong only wins ~3.5% on Easy (top-10 79%) — its dip buys are $25 presets (≈20% of stack), so bigger bots out-ride the pump; Hard-tier bots
beat Easy bots in the Easy lobby (+70 vs −1 $). Bot size presets ($10/25/50/100) unchanged.
`test:paper-sim` asserts Easy ascend 40–85% and decent win 10–40% / top-10 40–70% on seeds 7000–7029.

## v2.2 — Medium lobby bot knobs (Oct 31, lee 6:17 AM CT: Medium + Hard to spec bands)
New `TUNE.lobby[d][tier]` (per-lobby, per-tier overrides) so one lobby can be tuned without moving the others.
Medium lobby only: `SIZE_SCALE.medium` 0.15 → 0.237, `aggSigma.medium` 0.79 → 1.45, `moodBias.medium` −0.09 → −0.19, and in that lobby
Easy bots buyTh 0.25 → 0.505, cooldown 6.8 → 9.1 s, stop 0.35 → 0.17, maxPos 0.8 → 0.69; Medium bots buyTh 0.3 → 0.37, cooldown 6.3 → 6.7 s,
stop 0.12 → 0.32, maxPos 0.5 → 0.55; Hard bots buyTh 0.26 → 0.49, cooldown 10 → 5.9 s, stop 0.08 → 0.22, maxPos 0.35 → 0.77.
Hard lobby: unchanged from v2 — ~500 searched configs (2 rounds × 2 lobbies, incl. 2-seed-set scoring) never beat it out of sample.

All lobbies, 120 seeds (60 from 7000 + 60 from 9000):
| Lobby | Persona | Win % | Top-10 % | Ascend % | Target (decent) |
|---|---|---|---|---|---|
| Easy | decent | 21.5 | 52 | 58.5 | 15–25 / 50–60 ✔ |
| Easy | strong | 3.5 | 79 | 67.5 | |
| Easy | novice | 0 | 1 | 70.5 | |
| Medium | decent | 0 | 28.5 | 91 | 5–10 ✘ / 30–35 (just under) |
| Medium | strong | 16 | 86 | 96 | (was 42) |
| Medium | novice | 1 | 11 | 91.5 | |
| Hard | decent | 0 | 6 | 89 | 0–3 ✔ / 10–15 ✘ |
| Hard | strong | 17 | 96 | 91.5 | 10–20 ✔ |
| Hard | novice | 1 | 7 | 91 | |

Bands that can't be hit with bot knobs alone (why):
- **Medium decent wins 5–10%** with top-10 30–35%: the decent persona's per-round returns are too narrow (it ladders out at +40/+100% with a
  −16% stop) to finish #1 while the #1 bot makes +400%; every config that raised its wins also pushed top-10 to 50–70%. Out-of-sample best was ~1–3%.
- **Hard decent top-10 10–15%**: decent loses money in the Hard lobby (stopped out by fast Hard bots); best out-of-sample 5–6%, while the novice
  (small dip buys) places top-10 more often. Hitting it needs a Hard-aware decent persona, not bot knobs (persona was kept the same everywhere).
- **Strong ordering Easy > Medium > Hard**: strong wins only ~3.5% on Easy (its dip buys are $25 presets, ≈20% of its $135 stack, so it can't
  out-ride the pump), so it cannot sit above Medium (16%) or Hard (17%) there; Medium vs Hard strong are tied.
- Searches overfit badly to their seed set (in-sample 5%/33% → out-of-sample 1%/30%); results also move a lot with knob rounding.

## v2.3 (Oct 31) — Medium/Hard via bot mechanics only (approach A)

The decent/strong/novice personas are unchanged from v2.2 (PERSONA_TUNE untouched); no price manipulation. Only bot behaviour changed, via `TUNE.lobby.medium` / `TUNE.lobby.hard` plus per-lobby sizeScale / moodBias / aggSigma:
- every tier in Medium and Hard lobbies takes profit with a 2-step ladder (e.g. sell ~25–57% at +57–87%, more at +128–233%), and `neverSell` is off (Diamond hands scale out too);
- late entries curbed: `activeFrom` ends at ~250–380 s;
- Hard-lobby Hard bots pile onto momentum less (wMom 0.43); Easy/Medium tiers there are pickier (buyTh 0.54–0.59, maxPos 0.28–0.38);
- sizeScale medium 0.225 / hard 0.171, moodBias 0.038 / −0.049, aggSigma 1.226 / 0.804.
Easy lobby: no change. Found by random search (seeds 3000/5000), validated on held-out seeds 7000–7059 + 9000–9059 (120 rounds):

| lobby | persona | win % | top-10 % | ascend % | target |
|---|---|---|---|---|---|
| easy | decent | 21.5 | 52 | 58.5 | 10–40 / 40–70 (unchanged) |
| easy | strong | 3.5 | 79 | 67.5 | |
| easy | novice | 0 | 1 | 70.5 | |
| medium | decent | 1 | 29 | 77 | 5–10 / 30–35 |
| medium | strong | 14 | 95 | 73.5 | |
| medium | novice | 1.5 | 20.5 | 83 | |
| hard | decent | 2.5 | 14 | 2.5 | 0–3 / 10–15 ✓ |
| hard | strong | 14 | 50 | 1 | 10–20 ✓ |
| hard | novice | 3 | 9 | 4.5 | rare |

Misses: Medium decent wins ≈1% (target 5–10%) and top-10 29% (just under 30). #1 in Medium is usually a bot or strong riding the ASCEND run; decent's fixed stop/trail exits before that. Every bot config that made the winner's gain small enough for decent to win pushed decent's top-10 above 35%. Alternative (search candidate #4 Medium): 1.5% / 36.5%, strong 22%.
Caveats: Hard lobby now rarely ascends (~2%); Easy/Medium-tier bots lose money in Hard; Medium novice top-10 ≈20%; strong wins Easy 3.5 < Medium 14 ≈ Hard 14; test bands use 30 seeds (7000–7029), so Hard decent top-10 band is 5–25% and the Hard top-10 order check allows 7 pts noise; graduated-round adapter check now uses the Medium lobby.

## v3 (Oct 31, #225) — round ends at ascension + practice ascension bonus pool

**Round end.** When the curve ascends, the round stops (`SimRun` `endOnGraduate`, `endedAt`): standings freeze, rank is by net worth, and the results card shows. Trades after that fail with "round over".

**Practice ascension pool** (paper mode only; the real game has no such bonus). Constants are in `lib/sim/paper.ts`:
- `ASCENSION_POOL` = Easy $135, Medium $500, Hard $1,000 (1× the stack; at 2× a wash trader beat its fees in Medium).
- `ASCENSION_TOP` = 3, `ASCENSION_VOLUME_CREDIT` = 0.10, and `ASCENSION_SPLIT` = `"prorata"`, which can be swapped to `[0.5, 0.3, 0.2]`.
- score = max(0, heldTokens × avgEntry) + 0.10 × traded volume $. A sell removes avgEntry × tokens sold, not the proceeds. Only a score above 0 qualifies, and ties go to the earlier first buy.
- The top 3 split the pool. Fewer than 3 qualifiers split all of it. It is paid as USDG cash at ascension and nothing is paid if the coin doesn't ascend. There is no cap and no vesting.
- Bots see the live top-3 race through the `poolG`, `poolHold`, `wPool` and `poolPosK` params (defaults are off/neutral; the tuned lobbies don't use them, see misses).

**Tuning.** Only `SIZE_SCALE` changed, from 0.7 / 0.225 / 0.171 to 0.5 / 0.18 / 0.23. Personas and stacks are unchanged.

Validated on 120 held-out seeds (7000 and 9000, 60 each):

| lobby | player | win | top-10 | top-3 bonus | ascend | avg bonus |
|---|---|---|---|---|---|---|
| Easy | decent | 17% | 42% | 1% | 13% | $0.4 |
| Easy | strong | 0% | 18% | 0% | 14% | $0 |
| Easy | novice | 0% | 1% | 6% | 15% | $2.7 |
| Medium | decent | 5% | 41% | 0% | 41% | $0 |
| Medium | strong | 12.5% | 75% | 14.5% | 40% | $23 |
| Medium | novice | 13% | 66% | 53.5% | 55% | $125 |
| Hard | decent | 1.5% | 9% | 0% | 34.5% | $0 |
| Hard | strong | 0% | 21% | 3% | 33% | $8 |
| Hard | novice | 13.5% | 44% | 45% | 47.5% | $189 |

**Wash trader** (buys and sells a slice of the stack every 2 s; 20 seeds per lobby; cost = fees + gas + slippage):

| lobby | slice | bonus | cost |
|---|---|---|---|
| Easy | 3% | $0 | $1,522 |
| Easy | 10% | $126 | $1,937 |
| Easy | 20% | $194 | $2,462 |
| Medium | 3% | $0 | $1,987 |
| Medium | 10% | $768 | $2,860 |
| Medium | 20% | $469 | $3,561 |
| Hard | 3% | $901 | $2,231 |
| Hard | 10% | $0 | $3,990 |
| Hard | 20% | $776 | $6,764 |

It loses money everywhere.

**Misses.**
- Easy decent top-10 is 42% (target 50–60%).
- Hard decent top-10 is 9% (target 10–15%).
- Strong wins are not Easy > Medium > Hard (0 / 12.5 / 0%), and Hard strong is 0% (target 10–20%).
- The novice wins about 13% in Medium and Hard.
- Cause: with the round ending at ascension, buy-and-hold rides the curve to the finish. In ascended rounds the novice's early momentum buys win and the strong player's profit ladder exits too early. Pool-aware bot knobs (holding near ascension, sizing up for the race) all pushed Hard ascension to 100% without stopping the novice. Raising Hard bot cash would put the player out of the top 10 by net worth.
- The difficulty test now asserts Hard > Easy bot PnL only in the Hard lobby; Easy diamond-hands also win the Easy lobby.
- The band test uses seeds 7000–7059, which overlap the validation set.

## v4 — adaptive (Elo-style) bots

**Goal (lee, Oct 31):** hit the spec v0.2 §6 rates for each skill level, with the bots adapting to the player the way chess Elo does. Only the bot mechanics changed. The test personas are untouched.

**Bands.** Decent comes from spec v0.2 §6. Strong and novice are *derived* so that strong > decent > novice and Easy > Medium > Hard hold for each.

| tier | Easy win / top-10 | Medium | Hard |
|---|---|---|---|
| strong (derived) | 30–45 / 70–90 | 15–25 / 55–75 | 10–20 / 35–55 |
| decent (spec) | 15–25 / 50–60 | 5–10 / 30–35 | 0–3 / 10–15 |
| novice (derived) | 3–10 / 20–35 | 0–4 / 10–20 | 0–2 / 2–8 |

**Rating (lib/sim/rating.ts).**
- The behaviour score is s = ½·entry + ½·exit.
  - entry = 1 − (average 10 s momentum at each buy) / 0.3. A buyer who chases pumps scores low.
  - exit = sells / buys.
- R = 800 + 1200·s, smoothed as an EMA (0.35) across rounds. Anchors: novice 950, decent 1500, strong 1940.
- The target is the centre of a band. Within ±200 of an anchor the target snaps to that tier's band; between anchors it interpolates linearly.

**Controllers (one pair per lobby, carried across rounds).**
- **logK** sets the bot bankroll multiple, clamped to 0.5–4×. It is driven by (top-10 − target). It also takes a term proportional to strong-weight × (win − target).
- **logE** sets the elite multiple and is driven by (win − target).
  - E > 1 gives the 5 most aggressive bots extra cash.
  - E < 1 narrows the dispersion of bot aggression, and the current top-10 bots by worth trim 30% of a position 15% of the time.
- Starting multiples come from R (BASE_LOGK, BASE_LOGE).

**Ranking.** Players are ranked by worth = cash (the bonus is already in cash) + tokens × final price + open orders. Bot P&L = worth − starting cash, so taking profit ranks the same as holding at the same value.

**Results.** Held-out seeds 30000–30119, 120 sequential rounds per cell, rating carried across rounds. Values are win / top-10 / ascend / avg bonus.

| | novice | decent | strong |
|---|---|---|---|
| Easy | 5.8 / 20.8 / 0 / $0 | 20.0 / 53.3 / 15.8 / $0.7 | 39.2 / 75.8 / 0 / $0 |
| Medium | 3.3 / 15.0 / 20 / $31.5 | 6.7 / 33.3 / 52.5 / $6.8 | 19.2 / 70.0 / 37.5 / $54.2 |
| Hard | 0.0 / 5.8 / 40.8 / $153 | 1.7 / 11.7 / 29.2 / $0 | 12.5 / 50.0 / 24.2 / $57 |

**Tests.** `npm run test:paper-elo` uses seeds 7000–7119, which are separate from the tuning seeds. It checks every band with a ±2-round tolerance and all orderings. Hard decent and novice wins are both 0–2 of 120 rounds, so that one ordering is checked only within the same tolerance.

## v5 (Oct 31, #225) — rank by PnL everywhere

**Ranking.** Leaderboard, results rank, wins, top-10 and the round result all rank by **PnL = worth − that wallet's own starting stack** (the ascension bonus is included). Ties go to higher worth, then higher realized, then fewer fees. The ascension-pool top-3 is unchanged (cost basis + 10% of volume).

**Why v4 broke.** Under PnL, a wallet with PnL ≈ 0 ranks near #1 whenever most bots lose. A holder also profits whenever richer bots pump the coin to ascension. So the v4 levers (bankroll K, the elite stack E) moved the novice the wrong way.

**Controller changes (bots only; the personas are untouched):**
- **Bot sizing:** bots size off their own stack (`cash0`), so K scales their PnL as well as their impact.
- **Sharps replace the elites.** `round(5·E)` sharps (at most 40) buy 1.5× the starting cash in the block the launch anti-snipe tax ends. They sell everything at +15% or −30% versus their entry, then sit out. They are the profitable bots a passive or lucky player has to beat, so E caps the wins.
- **Rating:** the entry score is now judged against the round's own mean 10 s swing (× `chase` = 1), not a fixed 30%. Before this, a calm, handicapped market made a pump-chaser look disciplined: the Easy novice drifted to R ≈ 1350 and got a decent-tier target.
- **Integrators:** K tracks top-10, with a win term only on the strong side. E tracks wins, plus 3× the novice-weighted top-10 term (except in Easy).
- **Easy novice is pinned:** K base 0.45 and backdrop mood +0.5·wN, with both integrators gated by (1 − wN). Under PnL, the Easy novice result is knife-edge in K:
  - K ≲ 0.08: the coin is dead and the novice never buys (no ≥ 5% momentum), so PnL 0 ranks #1 in 100% of rounds.
  - K 0.1–0.13: 0–2% top-10.
  - K ≳ 0.7: ≤ 11% top-10.
  - A free integrator settles on the degenerate idle-#1 rounds, so the novice is pinned in the narrow live band (fixed-K sweep: K 0.45–0.5 with mood +0.9 gives roughly 3–11% wins / 20–29% top-10).
- **Ascension controller:** a per-lobby backdrop-mood offset steers toward 50% ascension, clamped to ±0.4.
- **Other constants:** Hard decent K base 0.3; the log clamp is ±4, with K limits of 0.05–8.

**Results (120 held-out seeds 30000–30119, rating carried; wins / top-10 / ascend %):**

| Lobby | Novice | Decent | Strong |
|---|---|---|---|
| Easy | 6.7 / 20.0 / 0.8 | 22.5 / 50.8 / 1.7 | 37.5 / 80.0 / 0.8 |
| Medium | 0 / 17.5 / 89 | 7.5 / 33.3 / 55 | 18.3 / 71.7 / 70 |
| Hard | 0 / 5.0 / 99 | 1.7 / 11.7 / 0 | 14.2 / 46.7 / 27 |

All 9 cells are in band, and the orders hold. test:paper-elo (seeds 7000–7119, ±2 rounds tolerance) passes 10/10.

**Caveats:**
- **Easy novice sits on its band edges** (20.0% top-10 exactly on the held-out seeds; 10.8% wins on the test seeds, inside the ±2-round tolerance). The cell is pinned, not adaptive.
- **The ascension target (30–70%) is not met in most cells, and it conflicts with the win bands.** Ascension is set by total bot buy volume (K). The mood offset saturates at ±0.4 with almost no effect: Easy stays at about 1% even at mood +0.9.
  - Easy decent and Easy strong need small bots for their win rates.
  - Hard decent needs K ≈ 0.3–0.8, and at K 1.0 its top-10 falls to 8%.
  - Medium and Hard novice need rich bots (89–99% ascension).
  - Hitting 30–70% everywhere would push at least Easy decent/novice and Hard decent out of band.
