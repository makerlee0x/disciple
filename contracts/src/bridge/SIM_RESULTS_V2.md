# Disciple V2 simulation

This is a study. The hook charges the progress slide, from 2% down to 0.3% as pool TVL reaches the live target, and its Dutch drift stays at 1% of the anchor per hour with an edge of 0.25. Graduated status latches after 77 continuous minutes at or above that target. The volume fee, the knob search, and the external LP inflow below are study inputs. They are not a change to the hook.

The objective is days until pool TVL reaches 12% of the live reference TVL. Volume is not a goal. Variants are ranked by the first day status turns on, then by TVL on day 365.

The target moves with the reference. The main runs hold the reference at $721,000, so the target stays $86,520. One path grows the reference linearly to $1,000,000 over the year (the target ends at $120,000). One path shrinks it linearly to $500,000 (the target ends at $60,000). Progress is pool TVL divided by that live target. A larger reference lowers progress. A smaller reference raises it.

The hard constraint is the outside searcher's profit. It has to stay strictly positive in every progress bucket the pool occupies before status latches: 0–10%, 10–30%, 30–60%, and 60–100% of the live target. The last bucket includes time above the target during the 77-minute hold. A bucket with any time in it and cumulative profit ≤ 0 is a failure. Empty buckets would not count; this grid has none before graduation. Profit per day is that cumulative profit times one day, divided by the seconds the pool spent in the bucket. Buckets stop when status turns on. Fee, boost, and Dutch size keep using the live target after the latch, and that later movement is outside these columns.

The search found a solvent set at every k on the active fixed book. The sets are not the same:

| Knob | k = 0.25 | k = 0.50 | k = 1 |
| --- | --- | --- | --- |
| Dutch drift | 2% of the anchor per hour | 2% per hour | 10% per hour |
| Size per gap | edge 0.10 | edge 0.25 | edge 0.25 |
| Volume-fee red line at 100% progress | 0.25× TVL | 0.25× TVL | 0.25× TVL |
| Base fee slope | 3% → 0.3% | 3% → 0.3% | 3% → 0.3% |
| LP boost | 8× → 1.2× | 8× → 1.2× | 8× → 1.2× |
| Quote | on top | on top | on top |
| Graduation day, active, reference fixed | 85 | 46 | 24 |
| Day-365 TVL, that path | $461.0k | $12.62M | $767.36B |

On those three fixed paths every progress bucket is positive. No k needed a fallback. The growing and shrinking references, and the dead book, reuse the same knobs and were not searched. Four reused COMBO paths miss the constraint, all in the 0–10% bucket. The active book at k = 0.50 with a reference that grows to $1M finishes that bucket about −$0.001 a day. Each dead k = 0.50 path finishes it about −$0.19 a day. The other reused COMBO paths stay positive.

Charging the volume fee on the full gap wins at every k. The netted quote, scored once at these knobs, fails three buckets at k = 0.25 and k = 0.50. At k = 1 it is solvent and graduates one day later, at a lower horizon TVL.

## What was run

One searcher, OUT. The searcher pays the pool fee plus 0.5%. LOW is not in this grid.

The anchor mean-reverts around $1. The log-deviation half-life is 7 days, so there is no trend. Active volatility is 3% a day. Dead volatility is 0.1% a day. Every variant in a scene shares the anchor seed. Active paths end the year near 1.0173. Dead paths end near 1.0006.

Organic volume each day is `max(base, k × pool TVL)`. The active base is $1,000. The dead base is $150. k is 0.25, 0.5, or 1. The day is 24 equal clips, about an hour apart, so the 77-minute window can elapse. Arb size is endogenous. On Dutch-family modes the searcher looks at the quote that has been open since the previous clip, before retail trades.

Reference TVL is read as the sim's stand-in for the smoothed anchor path. Fixed stays at $721,000. Grow and shrink move linearly with the day count, from $721,000 to $1,000,000 or $500,000. The contract smooths the raw reading with a 30-minute half-life after the first snap, on the same read as the price (lzRead, the v3 30-minute TWAP, or a v4 consult or sample). The sim applies the path level directly. It does not add a second flash-deposit game on top of that smooth.

Graduation matches the contract. The first observation at or above the live target starts `aboveSince` and does not flip status. Status turns on when a later clip is still over the line and 77 minutes have passed. Crossing back under the line before that clears the window. Once status is on it stays on, including when the reference later grows through the pool. In this grid every profile that graduated was still graduated on day 365.

Morpho yield is 5% APR on the idle slice while status is on (at most half of USDG, above the 20% floor and the buffer). The yield is added to the book. The latch means a later dip does not stop it.

Searcher profit is mark-to-anchor minus the 0.5% cost, attributed to the bucket the pool was in before the fill. The Dutch searcher trades only when the rested gap clears the fee plus that cost, so a Dutch bucket at $0 is a bucket where the searcher stood aside. Curve books can print a loss after a quote that cleared, because the fill walks the curve.

`test_simV2` produced the lines. It is skipped unless `SIM_V2=1`. The knob search uses at most 240 days. The grid is 365. TVL in the search tables is the level at that 240-day horizon. TVL in the year grid is day 365. They are different numbers.

## The fee and the gap

**On top (COMBO).** The quote is the full Dutch gap. The fill also pays the volume fee: 0.3% when recent volume is quiet, rising with decayed volume up to the progress-slide cap, with a one-hour half-life. The red line that defines "enough volume" is the searched knob at 100% progress and a quarter of that knob at 0% progress, linear in between. A larger reference lowers progress, which tightens the line and raises the cap together. The searcher must clear gap > fee + 0.5%.

**Netted (COMBO-alt).** The quote is tightened by that same fee, and the fill pays 0. The searcher must clear the net gap against the full progress slide plus 0.5%.

Dutch size is `min(edge / gap, dutch cap)`. The cap is the safety cap `min($50, max(TVL/20, $1))`, then multiplied by progress from 100% at a new pool down to 20% at the live target. A larger reference lowers progress and reopens that cap. The contract uses the same cap with its fixed edge of 0.25.

Hourly clips reset the clock after a fill. A quote that does not clear keeps drifting. At 2% an hour a gap that is taken every clip is about 2%. At 10% an hour it is about 10%. With edge 0.10 a 2% gap offers $5. With edge 0.25 a 2% gap offers $12.50, and a 10% gap offers $2.50. The safety cap falls to $10 at the target only after TVL is above $1,000. The $5 and $2.50 quotes stay inside that floor for the whole climb, so the progress scale does not cut them. The $12.50 quote is cut only in the last stretch of progress, once the scaled cap drops under $12.50 (past about 94% of the target). That stretch sits inside the 60–100% bucket.

## How the search chose the knobs

For each k the search runs on the active, fixed-reference book for 240 days. It tries 13 one-at-a-time departures from the contract defaults, then one coordinate pass: edge, red line, boost, launch fee, then drift again. A solvent set beats a violation. Fewer failing buckets is the closest violation. Within that, an earlier graduation day wins, then a higher TVL at the search horizon. The netted quote is scored once, at the winning knobs.

### One change at a time, from the defaults

2% an hour is solvent at k = 0.25 and k = 0.50 and fails one bucket at k = 1. 5% and 10% an hour are solvent at all three k. Among the drifts that are solvent at a given k, 2% an hour has the earlier day at k = 0.25 (129 versus 130) and the higher horizon TVL at k = 0.50. At k = 1 the one-at-a-time winner is 5% an hour, which ties 10% on the day and has the higher horizon TVL. An 8× boost reaches the target much sooner and fails two buckets, so it is rejected on its own.

| Change | k = 0.25 | k = 0.50 | k = 1 |
| --- | --- | --- | --- |
| Default (1%/h, edge 0.25, red 0.5×, boost 5×, fee 2%) | day 130, 2 fail, $156.4k | day 76, 2 fail, $1.32M | day 37, 3 fail, $1.31B |
| Drift 0.5%/h | day 131, 4 fail, $156.3k | day 76, 4 fail, $1.28M | day 37, 4 fail, $1.26B |
| Drift 2%/h | day 129, solvent, $160.6k | day 76, solvent, $1.34M | day 35, 1 fail, $1.40B |
| Edge 0.10 | day 130, 1 fail, $161.2k | day 76, 2 fail, $1.33M | day 36, 2 fail, $1.34B |
| Edge 0.50 | day 130, 2 fail, $155.8k | day 76, 2 fail, $1.33M | day 37, 3 fail, $1.32B |
| Red line 0.25× | day 131, 2 fail, $155.4k | day 76, 3 fail, $1.33M | day 36, 3 fail, $1.31B |
| Red line 1× | day 130, 2 fail, $156.9k | day 76, 2 fail, $1.33M | day 37, 2 fail, $1.30B |
| Boost 3× | day 218, 2 fail, $96.3k | day 111, 2 fail, $656.6k | day 58, 2 fail, $548.05M |
| Boost 8× | day 86, 2 fail, $225.5k | day 48, 2 fail, $1.83M | day 25, 2 fail, $2.33B |
| Launch fee 1% | day 130, 2 fail, $157.3k | day 76, 2 fail, $1.33M | day 37, 2 fail, $1.30B |
| Launch fee 3% | day 131, 2 fail, $155.6k | day 76, 2 fail, $1.32M | day 37, 3 fail, $1.31B |
| Drift 5%/h | day 130, solvent, $160.1k | day 76, solvent, $1.32M | day 35, solvent, $1.38B |
| Drift 10%/h | day 130, solvent, $159.6k | day 76, solvent, $1.31M | day 35, solvent, $1.37B |

### Coordinate pass

Each k starts from its one-at-a-time winner and walks one knob at a time.

At k = 0.25 the walk keeps edge 0.10 and red line 0.25× because both stay solvent and raise horizon TVL at the same day. The 8× boost, which failed on the default book, stays solvent on the 2% drift and pulls the day from 129 to 86. The 3% launch fee then moves that day to 85. Drift, rechecked at edge 0.10, red line 0.25×, boost 8×, and a 3% launch fee:

| Drift | k = 0.25 |
| --- | --- |
| 0.5%/h | day 86, 4 fail, $217.1k |
| 1%/h | day 86, 2 fail, $224.8k |
| 2%/h | day 85, solvent, $222.6k |
| 5%/h | day 85, solvent, $220.0k |
| 10%/h | day 85, solvent, $219.4k |

2% an hour wins. 5% and 10% tie the day and finish lower. 1% an hour is the closest miss: one day later, two failing buckets.

At k = 0.50 edge 0.10 lowers horizon TVL, so edge stays 0.25. Edge 0.50 graduates on day 67 and fails one bucket, so it is rejected. Red line 0.25× stays solvent at the same day. The 8× boost pulls the day from 76 to 46. The 3% launch fee wins the TVL tie at that day. Drift, rechecked at edge 0.25, red line 0.25×, boost 8×, and a 3% launch fee:

| Drift | k = 0.50 |
| --- | --- |
| 0.5%/h | day 48, 4 fail, $1.76M |
| 1%/h | day 48, 3 fail, $1.82M |
| 2%/h | day 46, solvent, $1.81M |
| 5%/h | day 46, solvent, $1.79M |
| 10%/h | day 46, solvent, $1.78M |

2% an hour wins on horizon TVL. The closest miss at these other knobs is 1% an hour: day 48, three failing buckets.

At k = 1 the walk keeps edge 0.25. Red line 0.25× moves the day from 35 to 34 while staying solvent. The 8× boost then moves it to 24, and the 3% launch fee wins the TVL tie at that day. Drift, rechecked at edge 0.25, red line 0.25×, boost 8×, and a 3% launch fee:

| Drift | k = 1 |
| --- | --- |
| 0.5%/h | day 24, 4 fail, $2.29B |
| 1%/h | day 24, 3 fail, $2.33B |
| 2%/h | day 24, 1 fail, $2.43B |
| 5%/h | day 24, solvent, $2.47B |
| 10%/h | day 24, solvent, $2.47B |

5% and 10% an hour tie at the reported precision. The raw horizon TVL is about $2.473B at 5% and $2.474B at 10%, so 10% an hour wins. The closest miss is 2% an hour: the same day, one failing bucket.

The netted quote at the winning knobs:

| k | Netted result |
| --- | --- |
| 0.25 | day 87, 3 fail, $197.3k |
| 0.50 | day 49, 3 fail, $1.36M |
| 1 | day 25, solvent, $1.34B |

On top is the winner at every k. At k = 1 the netted book is solvent and one day slower.

## Shape of the searcher's profit

Profit per day on the winning COMBO book, active scene. A star in the prose below is the sign of the raw sum. Rounded figures under a cent are shown to four decimals so the flag stays visible.

| Path | 0–10% | 10–30% | 30–60% | 60–100% |
| --- | --- | --- | --- | --- |
| k = 0.25, fixed | $0.51 | $1.08 | $1.28 | $1.45 |
| k = 0.25, grows to $1M | $0.53 | $1.09 | $1.29 | $1.45 |
| k = 0.25, shrinks to $500k | $0.51 | $1.08 | $1.29 | $1.45 |
| k = 0.50, fixed | $0.0020 | $1.94 | $2.80 | $3.33 |
| k = 0.50, grows to $1M | −$0.0012 ≤0 | $1.93 | $2.78 | $3.29 |
| k = 0.50, shrinks to $500k | $0.0038 | $1.95 | $2.81 | $3.33 |
| k = 1, fixed | $4.68 | $5.71 | $5.65 | $5.52 |
| k = 1, grows to $1M | $4.68 | $5.70 | $5.65 | $5.50 |
| k = 1, shrinks to $500k | $4.68 | $5.71 | $5.66 | $5.53 |

The measured profit rises into the last bucket at k = 0.25 and k = 0.50, and at k = 1 it peaks in the 10–30% bucket and eases by about $0.18 a day. The progress scale on Dutch size is in the cap, and these quotes sit inside that cap for almost the whole climb, so the profit follows the fee. The launch fee is 3%. The early red line is a quarter of 0.25× TVL. While progress is low the volume fee sits above its 0.3% floor, and a 2% gap clears it only after the gap has drifted far enough or the slide has fallen. That is why k = 0.50 spends about 17 days in the 0–10% bucket and collects about $0.03 there on the fixed reference. Growing the reference keeps progress, and the fee, a notch higher. The same bucket finishes $0.02 underwater (−$0.0012 a day). Shrinking the reference makes that bucket $0.0038 a day and moves graduation from day 46 to day 45.

At k = 0.25 the 2% drift with edge 0.10 still clears often enough to pay about $0.51 a day in the first bucket, over about 23 days, and the pay rises to $1.45 a day in the last bucket. Growing the reference moves graduation from day 85 to day 87 and lifts each bucket by about a cent. Shrinking it moves graduation to day 84.

At k = 1 the 10% drift clears the early fee easily. Profit stays near $5 a day in every bucket. Graduation stays on day 24 on all three reference paths. Day-365 TVL moves with the reference: $780.79B when it grows, $767.36B when it is fixed, $756.65B when it shrinks. That spread is the inflow compound described below. It is not a forecast of a pool.

The contract's own reopen is outside these columns, because the columns stop when status latches. `test_graduationLatchesAndReferenceGrowthReopensIncentives` is the check that a reference which grows after the latch leaves status on, raises the progress fee, and increases the Dutch slice.

## How to read the grid

Rank is graduation day, then day-365 TVL. The failing-bucket column is the constraint. COMBO is the only variant whose knobs were searched to satisfy it. The other rows use the contract defaults: 1% an hour, edge 0.25, red line 0.5× at 100% progress (a quarter of that at 0%), boost 5×→1.2×, fee 2%→0.3%. COMBO-alt uses the winning knobs with the netted quote.

LP inflow is modeling. It is not in the contract. Each day adds `budget × (boost − 1) / 25` of inventory: coin while spot is under the anchor, USDG otherwise. At 5× that is 16% of the day's organic budget. At 8× it is 28%. COMBO's year-end lead over BASE is partly that higher boost. At k = 1 the day-365 TVL is the compound of this inflow. Read the graduation day. Treat the dollar level as the model's accumulation, not a market forecast.

A Dutch row at $0.00 ≤0 means the searcher stood aside for the whole bucket. The cumulative profit is zero, which fails the strict inequality.

## Graduation day

Active book, ranked by graduation day. Day-365 TVL is in parentheses. An asterisk is a path with at least one failing bucket.

| Rank | k = 0.25, fixed | k = 0.50, fixed | k = 1, fixed |
| --- | --- | --- | --- |
| 1 | COMBO, day 85 ($461.0k) | COMBO, day 46 ($12.62M) | COMBO, day 24 ($767.36B) |
| 2 | COMBO-alt, day 87 ($376.3k) * | COMBO-alt, day 49 ($7.98M) * | COMBO-alt, day 25 ($299.68B) |
| 3 | DUTCH+BASE, day 128 ($347.2k) * | DUTCH+BASE, day 67 ($9.37M) * | DUTCH+BASE, day 35 ($421.64B) * |
| 4 | DUTCH, day 131 ($321.3k) * | DUTCH, day 76 ($8.79M) * | DUTCH, day 36 ($377.45B) * |
| 5 | BASE, day 138 ($161.6k) * | BASE, day 83 ($438.5k) * | BASE, day 46 ($3.06M) * |
| 6 | DRIP, day 162 ($241.1k) * | REV, day 87 ($419.8k) * | DRIP, day 50 ($21.05M) * |
| 7 | REV, day 163 ($155.9k) * | DRIP, day 90 ($1.45M) * | REV, day 50 ($2.97M) * |

Reference path, COMBO only, active book:

| Reference | k = 0.25 | k = 0.50 | k = 1 |
| --- | --- | --- | --- |
| Fixed at $721k | day 85, $461.0k, 0 fail | day 46, $12.62M, 0 fail | day 24, $767.36B, 0 fail |
| Grows to $1M | day 87, $493.9k, 0 fail | day 48, $13.16M, 1 fail | day 24, $780.79B, 0 fail |
| Shrinks to $500k | day 84, $435.9k, 0 fail | day 45, $12.23M, 0 fail | day 24, $756.65B, 0 fail |

Dead COMBO, same knobs, not searched: k = 0.25 graduates on day 113, 116, and 110 and stays solvent. k = 0.50 graduates on day 59, 59, and 58 and fails the 0–10% bucket on every reference path (about −$0.19 a day for 29 days). k = 1 graduates on day 29, 30, and 29 and stays solvent, with profit near $4.50 to $5.17 a day.

## Active

### Active, k = 0.25, reference fixed at $721k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 85 | $461.0k | $0.51 | $1.08 | $1.28 | $1.45 | 0 |
| COMBO-alt | 87 | $376.3k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $1.27 | 3 |
| BASE | 138 | $161.6k | -$1.49 ≤0 | -$4.88 ≤0 | -$6.27 ≤0 | -$3.12 ≤0 | 4 |
| REV | 163 | $155.9k | $0.77 | -$0.88 ≤0 | -$2.38 ≤0 | -$2.15 ≤0 | 3 |
| DUTCH | 131 | $321.3k | -$0.74 ≤0 | -$1.14 ≤0 | $1.22 | $1.37 | 2 |
| DRIP | 162 | $241.1k | $1.33 | -$0.0478 ≤0 | -$2.85 ≤0 | -$2.59 ≤0 | 3 |
| DUTCH+BASE | 128 | $347.2k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.08 | 3 |

### Active, k = 0.25, reference grows to $1M

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 87 | $493.9k | $0.53 | $1.09 | $1.29 | $1.45 | 0 |
| COMBO-alt | 91 | $404.8k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $1.30 | 3 |
| BASE | 139 | $185.5k | -$1.45 ≤0 | -$5.27 ≤0 | -$11.79 ≤0 | -$3.90 ≤0 | 4 |
| REV | 167 | $178.1k | $0.76 | -$0.67 ≤0 | -$2.75 ≤0 | -$1.79 ≤0 | 3 |
| DUTCH | 137 | $357.9k | -$0.71 ≤0 | -$1.20 ≤0 | $1.26 | $1.39 | 2 |
| DRIP | 169 | $273.3k | $1.36 | -$0.27 ≤0 | -$2.41 ≤0 | -$2.12 ≤0 | 3 |
| DUTCH+BASE | 130 | $382.3k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.08 | 3 |

### Active, k = 0.25, reference shrinks to $500k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 84 | $435.9k | $0.51 | $1.08 | $1.29 | $1.45 | 0 |
| COMBO-alt | 86 | $355.0k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $1.25 | 3 |
| BASE | 131 | $146.2k | -$1.51 ≤0 | -$4.10 ≤0 | -$6.08 ≤0 | -$4.40 ≤0 | 4 |
| REV | 139 | $140.6k | $0.79 | -$0.78 ≤0 | -$3.68 ≤0 | -$2.65 ≤0 | 3 |
| DUTCH | 129 | $293.9k | -$0.73 ≤0 | -$1.01 ≤0 | $1.19 | $1.33 | 2 |
| DRIP | 151 | $209.4k | $1.35 | -$0.11 ≤0 | -$2.60 ≤0 | -$2.30 ≤0 | 3 |
| DUTCH+BASE | 124 | $320.0k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.08 | 3 |

### Active, k = 0.50, reference fixed at $721k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 46 | $12.62M | $0.0020 | $1.94 | $2.80 | $3.33 | 0 |
| COMBO-alt | 49 | $7.98M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $2.79 | 3 |
| BASE | 83 | $438.5k | -$3.33 ≤0 | -$10.45 ≤0 | -$16.13 ≤0 | -$12.63 ≤0 | 4 |
| REV | 87 | $419.8k | $1.15 | -$0.19 ≤0 | -$6.63 ≤0 | -$6.78 ≤0 | 3 |
| DUTCH | 76 | $8.79M | $0.41 | -$0.36 ≤0 | $0.60 | $1.26 | 1 |
| DRIP | 90 | $1.45M | $1.79 | $0.97 | -$6.30 ≤0 | -$7.85 ≤0 | 2 |
| DUTCH+BASE | 67 | $9.37M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.11 | 3 |

### Active, k = 0.50, reference grows to $1M

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 48 | $13.16M | -$0.0012 ≤0 | $1.93 | $2.78 | $3.29 | 1 |
| COMBO-alt | 50 | $8.32M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $2.68 | 3 |
| BASE | 84 | $471.6k | -$2.48 ≤0 | -$15.88 ≤0 | -$23.04 ≤0 | -$10.89 ≤0 | 4 |
| REV | 90 | $448.4k | $1.16 | -$0.14 ≤0 | -$5.75 ≤0 | -$7.78 ≤0 | 3 |
| DUTCH | 76 | $9.33M | $0.45 | -$0.40 ≤0 | $0.64 | $1.31 | 1 |
| DRIP | 93 | $1.57M | $1.80 | $1.12 | -$6.86 ≤0 | -$5.14 ≤0 | 2 |
| DUTCH+BASE | 76 | $9.98M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.19 | 3 |

### Active, k = 0.50, reference shrinks to $500k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 45 | $12.23M | $0.0038 | $1.95 | $2.81 | $3.33 | 0 |
| COMBO-alt | 48 | $7.71M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $2.85 | 3 |
| BASE | 81 | $413.8k | -$3.34 ≤0 | -$10.44 ≤0 | -$15.27 ≤0 | -$11.02 ≤0 | 4 |
| REV | 85 | $396.0k | $1.22 | -$0.73 ≤0 | -$7.11 ≤0 | -$10.38 ≤0 | 3 |
| DUTCH | 76 | $8.35M | $0.41 | -$0.42 ≤0 | $0.58 | $1.22 | 1 |
| DRIP | 87 | $1.41M | $1.82 | -$0.23 ≤0 | -$8.08 ≤0 | -$13.00 ≤0 | 3 |
| DUTCH+BASE | 65 | $8.90M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.08 | 3 |

### Active, k = 1, reference fixed at $721k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 24 | $767.36B | $4.68 | $5.71 | $5.65 | $5.52 | 0 |
| COMBO-alt | 25 | $299.68B | $4.70 | $5.75 | $5.45 | $5.42 | 0 |
| BASE | 46 | $3.06M | -$6.39 ≤0 | -$35.65 ≤0 | -$44.75 ≤0 | -$11.99 ≤0 | 4 |
| REV | 50 | $2.98M | $0.24 | $1.69 | -$14.55 ≤0 | -$9.81 ≤0 | 2 |
| DUTCH | 36 | $377.45B | -$0.0351 ≤0 | $1.67 | -$0.0412 ≤0 | $1.18 | 2 |
| DRIP | 50 | $21.05M | $0.56 | $3.27 | -$12.37 ≤0 | -$10.36 ≤0 | 2 |
| DUTCH+BASE | 35 | $421.63B | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.09 | 3 |

### Active, k = 1, reference grows to $1M

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 24 | $780.79B | $4.68 | $5.70 | $5.65 | $5.50 | 0 |
| COMBO-alt | 25 | $304.47B | $4.70 | $5.68 | $5.48 | $5.41 | 0 |
| BASE | 49 | $3.18M | -$6.61 ≤0 | -$35.72 ≤0 | -$45.43 ≤0 | -$11.03 ≤0 | 4 |
| REV | 50 | $3.12M | $0.25 | $1.32 | -$10.83 ≤0 | -$7.50 ≤0 | 2 |
| DUTCH | 37 | $385.66B | -$0.0359 ≤0 | $1.50 | $0.0150 | $1.17 | 1 |
| DRIP | 50 | $21.63M | $0.57 | $2.13 | -$10.21 ≤0 | -$10.10 ≤0 | 2 |
| DUTCH+BASE | 36 | $431.36B | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.09 | 3 |

### Active, k = 1, reference shrinks to $500k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 24 | $756.65B | $4.68 | $5.71 | $5.65 | $5.53 | 0 |
| COMBO-alt | 24 | $296.00B | $4.70 | $5.65 | $5.57 | $5.43 | 0 |
| BASE | 45 | $2.94M | -$6.39 ≤0 | -$35.66 ≤0 | -$44.20 ≤0 | -$11.83 ≤0 | 4 |
| REV | 50 | $2.88M | $0.24 | -$0.20 ≤0 | $0.10 | -$10.19 ≤0 | 2 |
| DUTCH | 36 | $370.99B | -$0.0343 ≤0 | $1.65 | -$0.05 ≤0 | $1.18 | 2 |
| DRIP | 49 | $20.63M | $0.55 | $3.14 | -$9.49 ≤0 | -$8.07 ≤0 | 2 |
| DUTCH+BASE | 35 | $413.97B | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.07 | 3 |

## Dead

### Dead, k = 0.25, reference fixed at $721k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 113 | $362.4k | $0.19 | $1.12 | $1.34 | $1.45 | 0 |
| COMBO-alt | 117 | $299.0k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $1.25 | 3 |
| BASE | 192 | $139.3k | -$1.28 ≤0 | -$5.56 ≤0 | -$6.94 ≤0 | -$1.89 ≤0 | 4 |
| REV | 208 | $132.9k | -$0.09 ≤0 | -$0.75 ≤0 | -$2.83 ≤0 | -$1.80 ≤0 | 4 |
| DUTCH | 180 | $245.3k | -$1.53 ≤0 | -$1.25 ≤0 | $1.04 | $1.34 | 2 |
| DRIP | 207 | $190.3k | $0.06 | -$0.44 ≤0 | -$2.19 ≤0 | -$2.55 ≤0 | 3 |
| DUTCH+BASE | 174 | $256.0k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.11 | 3 |

### Dead, k = 0.25, reference grows to $1M

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 116 | $396.7k | $0.20 | $1.13 | $1.34 | $1.45 | 0 |
| COMBO-alt | 121 | $328.9k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $1.26 | 3 |
| BASE | 203 | $163.4k | -$1.26 ≤0 | -$5.42 ≤0 | -$7.12 ≤0 | -$1.82 ≤0 | 4 |
| REV | 224 | $157.9k | -$0.08 ≤0 | -$0.81 ≤0 | -$2.27 ≤0 | -$1.79 ≤0 | 4 |
| DUTCH | 187 | $282.1k | -$1.52 ≤0 | -$1.00 ≤0 | $1.18 | $1.36 | 2 |
| DRIP | 210 | $224.7k | $0.07 | -$0.33 ≤0 | -$2.37 ≤0 | -$2.18 ≤0 | 3 |
| DUTCH+BASE | 179 | $294.4k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.11 | 3 |

### Dead, k = 0.25, reference shrinks to $500k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 110 | $336.2k | $0.17 | $1.11 | $1.34 | $1.45 | 0 |
| COMBO-alt | 115 | $276.4k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $1.25 | 3 |
| BASE | 182 | $121.5k | -$1.13 ≤0 | -$5.55 ≤0 | -$6.84 ≤0 | -$2.72 ≤0 | 4 |
| REV | 198 | $114.5k | -$0.09 ≤0 | -$0.83 ≤0 | -$2.49 ≤0 | -$2.41 ≤0 | 4 |
| DUTCH | 174 | $217.2k | -$1.52 ≤0 | -$1.43 ≤0 | $0.89 | $1.32 | 2 |
| DRIP | 197 | $159.7k | $0.05 | -$0.44 ≤0 | -$2.57 ≤0 | -$3.03 ≤0 | 3 |
| DUTCH+BASE | 168 | $227.7k | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.10 | 3 |

### Dead, k = 0.50, reference fixed at $721k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 59 | $8.70M | -$0.19 ≤0 | $1.96 | $2.92 | $3.35 | 1 |
| COMBO-alt | 61 | $5.51M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $2.68 | 3 |
| BASE | 103 | $365.1k | -$2.46 ≤0 | -$16.82 ≤0 | -$16.91 ≤0 | -$8.53 ≤0 | 4 |
| REV | 111 | $348.1k | $0.11 | -$1.99 ≤0 | -$6.18 ≤0 | -$7.03 ≤0 | 3 |
| DUTCH | 88 | $5.81M | -$1.37 ≤0 | -$0.66 ≤0 | $0.72 | $1.29 | 2 |
| DRIP | 111 | $1.07M | $0.41 | -$0.97 ≤0 | -$6.62 ≤0 | -$13.01 ≤0 | 3 |
| DUTCH+BASE | 87 | $6.12M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.09 | 3 |

### Dead, k = 0.50, reference grows to $1M

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 59 | $9.14M | -$0.19 ≤0 | $1.94 | $2.93 | $3.35 | 1 |
| COMBO-alt | 61 | $5.80M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $2.92 | 3 |
| BASE | 106 | $398.2k | -$2.64 ≤0 | -$16.12 ≤0 | -$16.90 ≤0 | -$8.19 ≤0 | 4 |
| REV | 115 | $382.5k | $0.12 | -$2.76 ≤0 | -$4.54 ≤0 | -$5.67 ≤0 | 3 |
| DUTCH | 90 | $6.22M | -$1.33 ≤0 | -$0.69 ≤0 | $0.78 | $1.31 | 2 |
| DRIP | 115 | $1.19M | $0.42 | -$1.69 ≤0 | -$4.63 ≤0 | -$5.99 ≤0 | 3 |
| DUTCH+BASE | 88 | $6.53M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.10 | 3 |

### Dead, k = 0.50, reference shrinks to $500k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 58 | $8.36M | -$0.20 ≤0 | $1.85 | $2.91 | $3.35 | 1 |
| COMBO-alt | 60 | $5.28M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $2.88 | 3 |
| BASE | 100 | $339.7k | -$2.48 ≤0 | -$15.27 ≤0 | -$20.27 ≤0 | -$7.92 ≤0 | 4 |
| REV | 109 | $321.9k | $0.10 | -$1.93 ≤0 | -$5.96 ≤0 | -$6.87 ≤0 | 3 |
| DUTCH | 87 | $5.49M | -$1.40 ≤0 | -$0.68 ≤0 | $0.61 | $1.29 | 2 |
| DRIP | 109 | $1.03M | $0.39 | -$0.94 ≤0 | -$6.17 ≤0 | -$7.52 ≤0 | 3 |
| DUTCH+BASE | 86 | $5.79M | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.09 | 3 |

### Dead, k = 1, reference fixed at $721k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 29 | $405.87B | $4.49 | $4.95 | $5.05 | $5.16 | 0 |
| COMBO-alt | 31 | $160.32B | $4.34 | $4.95 | $5.01 | $5.19 | 0 |
| BASE | 55 | $2.70M | -$6.57 ≤0 | -$45.08 ≤0 | -$57.17 ≤0 | -$13.16 ≤0 | 4 |
| REV | 58 | $2.59M | -$0.95 ≤0 | -$3.44 ≤0 | -$4.25 ≤0 | -$10.92 ≤0 | 4 |
| DUTCH | 44 | $208.17B | -$1.34 ≤0 | $1.50 | $0.08 | $1.20 | 1 |
| DRIP | 58 | $17.85M | -$0.68 ≤0 | -$1.93 ≤0 | -$2.09 ≤0 | -$9.39 ≤0 | 4 |
| DUTCH+BASE | 43 | $231.08B | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.10 | 3 |

### Dead, k = 1, reference grows to $1M

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 30 | $414.27B | $4.49 | $4.95 | $5.04 | $5.15 | 0 |
| COMBO-alt | 31 | $164.35B | $4.35 | $4.91 | $5.00 | $5.19 | 0 |
| BASE | 55 | $2.82M | -$7.36 ≤0 | -$47.38 ≤0 | -$44.11 ≤0 | -$14.06 ≤0 | 4 |
| REV | 59 | $2.72M | -$0.95 ≤0 | -$3.88 ≤0 | -$2.84 ≤0 | -$10.30 ≤0 | 4 |
| DUTCH | 44 | $215.16B | -$1.35 ≤0 | $1.60 | $0.15 | $1.22 | 1 |
| DRIP | 59 | $18.35M | -$0.68 ≤0 | -$1.85 ≤0 | -$1.15 ≤0 | -$10.69 ≤0 | 4 |
| DUTCH+BASE | 44 | $238.83B | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.09 | 3 |

### Dead, k = 1, reference shrinks to $500k

| Variant | Day | Day-365 TVL | 0–10% | 10–30% | 30–60% | 60–100% | Failing buckets |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMBO | 29 | $399.31B | $4.49 | $4.95 | $5.05 | $5.17 | 0 |
| COMBO-alt | 30 | $157.32B | $4.34 | $4.95 | $5.07 | $5.14 | 0 |
| BASE | 54 | $2.60M | -$6.35 ≤0 | -$45.54 ≤0 | -$57.62 ≤0 | -$14.85 ≤0 | 4 |
| REV | 58 | $2.49M | -$0.96 ≤0 | -$3.61 ≤0 | -$4.87 ≤0 | -$12.87 ≤0 | 4 |
| DUTCH | 44 | $203.10B | -$1.34 ≤0 | $1.44 | $0.07 | $1.19 | 1 |
| DRIP | 58 | $16.60M | -$0.69 ≤0 | -$1.78 ≤0 | -$3.23 ≤0 | -$13.52 ≤0 | 4 |
| DUTCH+BASE | 43 | $225.14B | $0.0000 ≤0 | $0.0000 ≤0 | $0.0000 ≤0 | $0.10 | 3 |


