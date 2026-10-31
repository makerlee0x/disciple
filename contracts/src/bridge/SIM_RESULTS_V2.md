# Disciple V2 simulation

This is a study. The hook that ships in this PR charges the progress slide, from 2% down to 0.3% as pool TVL reaches the live target. Dutch quotes, the 77-minute reversible graduation, and the 12% target are in the contract. The volume fee, the knob search, and the external LP inflow are study inputs.

The objective is days until pool TVL reaches graduation. On the fixed reference that target is $86,520, 12% of the $721,000 reference pool. Volume is not a goal. Variants are ranked by the first day status turns on, then by TVL on day 365.

The hard constraint is the outside searcher's profit. It has to stay strictly positive in every TVL bucket the pool occupies before graduation: $0–1k, $1–5k, $5–20k, $20–50k, and $50k through the moment status turns on. A bucket with any time in it and cumulative profit ≤ 0 is a failure. Empty buckets would not count; this grid has none. Profit per day is that cumulative profit times one day, divided by the seconds the pool spent in the bucket.

COMBO is shared-reset Dutch quotes, the progress slide, the volume fee charged on the full gap, and an LP boost the search is allowed to move. The search found one parameter set that meets the constraint at every k, and it is the same set at k = 0.25, 0.50, and 1:

| Knob | Value |
| --- | --- |
| Dutch drift | 5% of the anchor per hour |
| Size per gap | edge 0.10, so size = 0.10 / gap, capped at min($50, max(TVL/20, $1)) |
| Volume-fee red line | 0.25× TVL |
| Base fee slope | 3% at a tiny pool, 0.3% at the target |
| LP boost | 8× at a tiny pool, sliding to 1.2× at the target |

On the active, fixed-reference book that set reaches the target on day 86 at k = 0.25, day 46 at k = 0.50, and day 24 at k = 1. Searcher profit stays positive in all five buckets on every one of the 18 paths, including the dead book and the moving references, which were not part of the search. No k needed a fallback. The closest miss is in the coordinate pass below: the same knobs at 2% an hour match those graduation days and fail one bucket.

The other gap interaction, tightening the quote by the volume fee and charging nothing extra, is COMBO-alt. At these knobs it also keeps every bucket positive. It reaches the target one or two days later in the search (day 87, 48, and 25) and on the year grid, or it ties the day and ends with less TVL. Charging the fee on the full gap is the interaction that minimizes days to graduation. Both use the knobs above. The contract's own drift, boost, and fee are unchanged: 1% an hour, 5×→1.2×, and 2%→0.3%, with no volume fee.

## What was run

One searcher, OUT. The searcher pays the pool fee plus 0.5%. LOW (about 0.05% on top of the fee) is not in this grid.

The anchor mean-reverts around $1. The log-deviation half-life is 7 days, so there is no trend. Active volatility is 3% a day. Dead volatility is 0.1% a day. Every variant in a scene shares the anchor seed. Active paths end the year at 1.0173. Dead paths end at 1.0006.

Organic volume each day is `max(base, k × pool TVL)`. The active base is $1,000. The dead base is $150. k is 0.25, 0.5, or 1. The day is 24 equal clips, about an hour apart, so the 77-minute graduation window can elapse. Arb size is endogenous. The searcher looks at the quote that has been open since the previous clip, before retail trades.

The reference TVL is $721,000 in the main case, so the target stays $86,520. One path grows the reference linearly to $1,000,000 (target $120,000). One path shrinks it linearly to $500,000 (target $60,000). The last bucket is $50,000 through the moment status turns on. On the fixed reference that is $50k–$86.5k plus the 77-minute hold above the target. On the growing reference the hold finishes above $86.5k. On the shrinking reference the target can be under $86.5k when status flips, and the bucket still ends at status.

Graduation in the sim matches the contract. Status turns on after 77 continuous minutes at or above the target and turns off after 77 continuous minutes below it. The first observation does not flip status. The fee, the boost, and Dutch size use progress immediately. Morpho yield is credited only while status is on: 5% APR on the idle slice (at most half of USDG, above the 20% floor and the buffer). The yield is added to the book. Turning status off stops the yield. In this grid every profile that graduated was still graduated on day 365.

Searcher profit is mark-to-anchor minus the 0.5% cost. The Dutch searcher trades only when the rested gap clears the fee plus that cost, so a Dutch bucket at $0 is a bucket where the searcher stood aside. Curve books can still print a loss after a quote that cleared, because the fill walks the curve.

`test_simV2` produced the lines. It is skipped unless `SIM_V2=1`. The knob search uses at most 240 days. The grid is 365.

## The fee and the gap

**On top (COMBO).** The quote is the full Dutch gap. The fill also pays the volume fee: 0.3% when recent volume is quiet, rising with decayed volume up to the progress-slide cap, with a one-hour half-life. The searcher must clear gap > fee + 0.5%.

**Netted (COMBO-alt).** The quote is tightened by that same fee, and the fill pays 0. The searcher must clear the net gap against the full progress slide plus 0.5%.

Hourly clips reset the clock, so the rested gap is about one hour of drift. At 5% an hour the rested gap is 5.00% in every COMBO row. Decayed volume on these paths stays well under the 0.25× red line, so the volume fee sits near its 0.3% floor. The fee the searcher actually feels is the 3%→0.3% slide. A 5% gap clears a 3% launch fee plus 0.5% from the first hour, which is why the early buckets are positive. COMBO-alt gives the volume fee away inside the quote and still clears, because what remains of the 5% gap is larger than the slide plus 0.5%. It collects no fee into the book, so the same graduation day ends at a lower TVL.

## How the search chose the knobs

For each k the search runs on the active, fixed-reference book for 240 days. It tries 13 one-at-a-time departures from the contract defaults (1% an hour, edge 0.25, red line 0.5×, boost 5×, fee 2%→0.3%), then one coordinate pass: edge, red line, boost, launch fee, then drift again. A solvent set beats a violation. Fewer failing buckets is the closest violation. Within that, an earlier graduation day wins, then a higher TVL at the search horizon. The netted quote is scored once, at the winning knobs. Dead paths, and the growing and shrinking references, reuse that k's winner. They were not searched on their own. In this run the winner is the same at every k, so the whole grid uses one set.

TVL in the two tables below is the level at day 240, the search horizon. The year-grid TVL later in this file is the day-365 level. They are not the same number.

### One change at a time, from the defaults

Only 5% an hour and 10% an hour keep every bucket positive. 5% an hour has the earlier day at k = 1 (35 versus 36) and the higher horizon TVL at the other two k values, so it is the one-at-a-time winner. An 8× boost reaches the target much sooner (day 85, 46, and 24) and fails three buckets, so it is rejected on its own. A 2% drift, which won an earlier 30-day TVL search, fails one bucket here.

| Change | k = 0.25 | k = 0.50 | k = 1 |
| --- | --- | --- | --- |
| Default (1%/h, edge 0.25, red 0.5×, boost 5×, fee 2%) | day 130, 3 fail, $161.1k | day 76, 3 fail, $1.36M | day 36, 3 fail, $1.35B |
| Drift 0.5%/h | day 131, 5 fail, $150.3k | day 76, 5 fail, $1.21M | day 38, 5 fail, $1.21B |
| Drift 2%/h | day 130, 1 fail, $160.9k | day 76, 1 fail, $1.34M | day 35, 1 fail, $1.38B |
| Edge 0.10 | day 130, 2 fail, $161.5k | day 76, 2 fail, $1.33M | day 36, 3 fail, $1.35B |
| Edge 0.50 | day 128, 4 fail, $165.5k | day 67, 4 fail, $1.42M | day 36, 4 fail, $1.39B |
| Red line 0.25× | day 130, 3 fail, $160.0k | day 76, 3 fail, $1.35M | day 37, 4 fail, $1.31B |
| Red line 1× | day 129, 3 fail, $161.9k | day 67, 3 fail, $1.37M | day 35, 3 fail, $1.41B |
| Boost 3× | day 207, 3 fail, $99.5k | day 103, 3 fail, $758.8k | day 54, 3 fail, $605.29M |
| Boost 8× | day 85, 3 fail, $232.3k | day 46, 3 fail, $1.86M | day 24, 3 fail, $2.40B |
| Launch fee 1% | day 129, 3 fail, $162.0k | day 67, 3 fail, $1.37M | day 35, 3 fail, $1.42B |
| Launch fee 3% | day 130, 3 fail, $160.6k | day 76, 3 fail, $1.35M | day 37, 4 fail, $1.31B |
| Drift 5%/h | day 130, solvent, $159.5k | day 76, solvent, $1.31M | day 35, solvent, $1.35B |
| Drift 10%/h | day 130, solvent, $159.0k | day 76, solvent, $1.31M | day 36, solvent, $1.34B |

### Coordinate pass

Starting from 5% an hour, the pass keeps a smaller edge and a tighter red line because they stay solvent and win a TVL tie at the same graduation day. Neither one moves the day. The 8× boost, which failed on the default book, stays solvent once the drift is 5% an hour and the edge is 0.10, and it is what pulls the day forward: day 130→86 at k = 0.25, day 76→48 at k = 0.50, day 35→24 at k = 1, still at the 2% launch fee. Raising that launch fee to 3% then moves k = 0.50 from day 48 to day 46 and wins a small TVL tie at the other two k values, where the day does not change. Edge and the red line were chosen before the boost moved, and the pass does not go back to them. This is one pass, not the full Cartesian product.

Drift, rechecked at the final other knobs (edge 0.10, red line 0.25×, boost 8×, launch fee 3%):

| Drift | k = 0.25 | k = 0.50 | k = 1 |
| --- | --- | --- | --- |
| 0.5%/h | day 87, 5 fail, $214.6k | day 48, 5 fail, $1.75M | day 25, 5 fail, $2.22B |
| 1%/h | day 86, 3 fail, $224.6k | day 48, 3 fail, $1.80M | day 24, 3 fail, $2.38B |
| 2%/h | day 86, 1 fail, $222.2k | day 46, 1 fail, $1.79M | day 24, 1 fail, $2.44B |
| 5%/h | day 86, solvent, $219.4k | day 46, solvent, $1.78M | day 24, solvent, $2.44B |
| 10%/h | day 86, solvent, $218.8k | day 48, solvent, $1.78M | day 24, solvent, $2.43B |

2% an hour matches the winning graduation day and fails one bucket. That is the closest set that misses the constraint. 10% an hour is also solvent. At k = 0.50 it graduates two days later, and where the day matches, its horizon TVL is lower. 5% an hour is solvent and earliest.

Boost, at 5% an hour, edge 0.10, red line 0.25×, launch fee still 2%:

| Boost | k = 0.25 | k = 0.50 | k = 1 |
| --- | --- | --- | --- |
| 3× | day 207, solvent, $98.9k | day 105, solvent, $715.1k | day 53, solvent, $656.65M |
| 5× | day 130, solvent, $161.1k | day 76, solvent, $1.32M | day 35, solvent, $1.37B |
| 8× | day 86, solvent, $219.3k | day 48, solvent, $1.78M | day 24, solvent, $2.42B |

The day moves with the boost. The inflow that implements it is `budget × (boost − 1) / 25`. At 8× that is 28% of the day's organic budget. At 5× it is 16%. At the 1.2× end it is 0.8%. It arrives as coin while spot is under the anchor, and as USDG otherwise. Every variant gets the formula. Only COMBO and COMBO-alt use the 8× start. BASE, REV, DUTCH, DRIP, and DUTCH+BASE stay at 5×. The Dutch slice at these knobs is about $2 (`0.10 / 0.05`), about $48 a day across the 24 clips. The boost is what brings the target forward. A 5× book at 5% an hour is solvent and graduates on day 130, 76, and 35, which is later than DUTCH+BASE on the active fixed paths below.

Netted, scored at the winning knobs over the same 240 days: solvent, day 87 / 48 / 25, horizon TVL $195.0k / $1.36M / $1.35B. On top is earlier at every k.

## Shape of the searcher's profit

On the winning book, searcher profit is lowest while the pool is under $1,000 and then sits near $2 a day through graduation. On the active, k = 0.50, fixed path the five rates are $1.41, $1.93, $1.99, $1.89, and $1.97 per day. Across all 18 COMBO paths the rate stays between $1.38 and $2.13 per day, and every bucket is positive.

The slice is inside the size cap from the $77 seed onward (TVL/20 is already above $2), and the rested gap stays near 5% because each clip resets a 5%-per-hour clock. The slide falls from 3% to 0.3% while that gap stays put, so the surplus inside the gap gets a little larger as the pool grows. A profit that tapers toward the target would need the gap or the fee to tighten with TVL. This search's drift is a constant percent per hour, and the objective it maximized was an earlier graduation day among sets that stay positive. The sign constraint holds. The decline does not appear.

## How to read the grid

COMBO is rank 1 in every cell. The rank is days to graduation, then day-365 TVL.

DUTCH+BASE is the same shared-reset quote and the same progress slide, with no volume fee, at the contract's 1% an hour and the contract's 5× boost. DUTCH keeps an independent clock on each side, charges the volume fee, and also drifts at 1% an hour. BASE is the slide on the curve, with the spot/anchor ratio preserved when the anchor moves. REV is that curve with the volume fee. DRIP is REV plus the fee-funded surplus sale. Those five are not retuned.

Dutch-family books in this file are parked on the anchor after each quote and on each anchor move, so the gap is only the time quote. The shipped hook returns the curve to its pre-trade spot, and a zero gap leaves the 0.67× launch discount on the curve.

The external LP inflow keeps arriving when the searcher stands aside. DUTCH+BASE still reaches the target in the model while its early buckets are $0. Under the constraint those hours are a failure: the searcher is not being paid, and a searcher who stops would not be what carries the pool. The graduation days are still reported. The knob search refuses that shape for COMBO.

Once daily volume scales with TVL, the inflow compounds. At k = 1 the day-365 TVL is the compound of that assumption after the pool is already large. Graduation day is the comparison that stays readable there.

Bucket cells are searcher profit per day, and how long the pool spent there before graduation. `≤0` means the bucket was occupied and profit was not positive.

## Active, fixed reference, k = 0.5

This is the middle path. The search was fit to it, along with the other two k values on the same reference.

### Active, k = 0.50, reference fixed at $721k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 46 | $2.2k | $39.7k | $163.4k | $12.46M | $1.41/d · 2.0d | $1.93/d · 11d | $1.99/d · 10d | $1.89/d · 9.3d | $1.97/d · 15d |
| 2 | COMBO-alt | 48 | $2.1k | $38.0k | $152.4k | $8.01M | $1.40/d · 2.0d | $1.91/d · 11d | $1.98/d · 10.0d | $1.90/d · 10.0d | $1.98/d · 15d |
| 3 | DUTCH+BASE | 67 | $1.4k | $11.5k | $121.1k | $9.48M | $0/d · 4.0d ≤0 | $0/d · 16d ≤0 | $0/d · 16d ≤0 | $0/d · 14d ≤0 | $0.41/d · 25d |
| 4 | DUTCH | 76 | $1.4k | $10.6k | $116.2k | $8.73M | -$2.52/d · 4.0d ≤0 | -$7.01/d · 16d ≤0 | -$2.08/d · 18d ≤0 | $0.87/d · 15d | $1.92/d · 23d |
| 5 | BASE | 83 | $1.3k | $10.2k | $93.7k | $438.5k | $7.82/d · 5.0d | -$4.22/d · 16d ≤0 | -$9.51/d · 17d ≤0 | -$14.9/d · 16d ≤0 | -$13.0/d · 28d ≤0 |
| 6 | REV | 87 | $1.2k | $8.2k | $88.8k | $417.8k | $11.2/d · 5.0d | -$1.39/d · 18d ≤0 | -$4.32/d · 19d ≤0 | -$12.7/d · 18d ≤0 | -$6.66/d · 27d ≤0 |
| 7 | DRIP | 90 | $1.2k | $8.0k | $87.0k | $1.43M | $11.2/d · 5.0d | -$1.02/d · 18d ≤0 | -$4.02/d · 20d ≤0 | -$12.2/d · 17d ≤0 | -$6.94/d · 29d ≤0 |

COMBO reaches the target on day 46 and ends the year at $12.46M. Arb notional is $48 a day. Searcher profit is $1.98 a day. Fees are $3,078 a day, an effective 30 bps, on a 5.00% gap. Morpho credits $33.9k over the year. COMBO-alt matches the profit shape, collects no fee, and ends at $8.01M on day 48. DUTCH+BASE reaches the target on day 67 and the searcher earns $0 until the last bucket: a 1% hourly gap does not clear the early 2% slide plus 0.5%. BASE and REV pay the searcher a loss in four of the five buckets. The mean-reverting anchor does not open a curve gap wide enough to cover OUT's cost after the first few days.

## Graduation day

COMBO is first in all 18 cells. Where COMBO-alt ties the day, COMBO ends with the higher TVL because the fee compounds into the book.

| Scene | k | Reference | COMBO | COMBO-alt | DUTCH+BASE | DUTCH | BASE | DRIP | REV |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Active | 0.25 | Fixed | 86 | 87 | 128 | 130 | 138 | 162 | 163 |
| Active | 0.25 | Grows | 88 | 91 | 130 | 137 | 139 | 169 | 167 |
| Active | 0.25 | Shrinks | 84 | 86 | 124 | 128 | 131 | 151 | 139 |
| Active | 0.50 | Fixed | 46 | 48 | 67 | 76 | 83 | 90 | 87 |
| Active | 0.50 | Grows | 48 | 49 | 76 | 76 | 84 | 93 | 90 |
| Active | 0.50 | Shrinks | 45 | 48 | 65 | 76 | 81 | 87 | 86 |
| Active | 1 | Fixed | 24 | 25 | 35 | 36 | 46 | 50 | 50 |
| Active | 1 | Grows | 24 | 25 | 36 | 37 | 49 | 51 | 50 |
| Active | 1 | Shrinks | 24 | 24 | 35 | 36 | 45 | 50 | 50 |
| Dead | 0.25 | Fixed | 114 | 117 | 174 | 176 | 192 | 207 | 209 |
| Dead | 0.25 | Grows | 117 | 120 | 179 | 182 | 203 | 211 | 224 |
| Dead | 0.25 | Shrinks | 112 | 114 | 168 | 170 | 182 | 196 | 199 |
| Dead | 0.50 | Fixed | 59 | 60 | 87 | 88 | 103 | 113 | 113 |
| Dead | 0.50 | Grows | 60 | 61 | 88 | 90 | 106 | 116 | 116 |
| Dead | 0.50 | Shrinks | 58 | 60 | 86 | 87 | 100 | 110 | 110 |
| Dead | 1 | Fixed | 30 | 30 | 43 | 44 | 55 | 60 | 60 |
| Dead | 1 | Grows | 30 | 30 | 44 | 44 | 55 | 61 | 61 |
| Dead | 1 | Shrinks | 30 | 30 | 43 | 43 | 54 | 59 | 59 |

A higher k brings the target forward because organic volume, and the LP inflow that scales with it, arrive sooner. A shrinking reference lowers the target and graduation moves a few days earlier. A growing reference does the opposite. Ranks 1 through 5 are COMBO, COMBO-alt, DUTCH+BASE, DUTCH, and BASE in every cell. DRIP and REV trade the last two places.

Day-365 TVL at k = 0.25 stays in the hundreds of thousands. At k = 0.5 COMBO ends at $12.46M on the active fixed path and DUTCH+BASE at $9.48M, while BASE and REV end near $400k. At k = 1 the Dutch books with an 8× early boost end in the hundreds of billions. That gap opens after graduation, when inflow is a fraction of daily volume and daily volume is a fraction of TVL. It is the inflow assumption showing up.

## Full grid

Anchor at day 365 is 1.0173 on every active row and 1.0006 on every dead row.

## Active

### Active, k = 0.25, reference fixed at $721k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 86 | $2.2k | $12.6k | $90.7k | $455.3k | $1.41/d · 2.0d | $1.97/d · 14d | $1.94/d · 21d | $1.98/d · 20d | $2.13/d · 29d |
| 2 | COMBO-alt | 87 | $2.1k | $12.3k | $89.0k | $374.5k | $1.40/d · 2.0d | $1.96/d · 15d | $1.95/d · 21d | $1.99/d · 19d | $2.12/d · 31d |
| 3 | DUTCH+BASE | 128 | $1.4k | $5.9k | $51.0k | $347.5k | $0/d · 4.0d ≤0 | $0/d · 21d ≤0 | $0/d · 35d ≤0 | $0/d · 29d ≤0 | $0.13/d · 38d |
| 4 | DUTCH | 130 | $1.4k | $5.7k | $45.2k | $324.5k | -$2.52/d · 4.0d ≤0 | -$7.07/d · 22d ≤0 | -$2.17/d · 36d ≤0 | $1.13/d · 33d | $1.80/d · 39d |
| 5 | BASE | 138 | $1.3k | $5.7k | $46.1k | $161.8k | $7.82/d · 5.0d | -$3.07/d · 22d ≤0 | -$2.81/d · 34d ≤0 | -$7.42/d · 33d ≤0 | -$2.92/d · 56d ≤0 |
| 6 | DRIP | 162 | $1.2k | $5.0k | $36.6k | $240.2k | $11.2/d · 5.0d | -$0.76/d · 25d ≤0 | -$1.68/d · 39d ≤0 | -$3.53/d · 34d ≤0 | -$2.72/d · 59d ≤0 |
| 7 | REV | 163 | $1.2k | $5.1k | $37.3k | $157.3k | $11.2/d · 5.0d | -$1.03/d · 24d ≤0 | -$1.86/d · 39d ≤0 | -$4.26/d · 33d ≤0 | -$2.44/d · 62d ≤0 |

### Active, k = 0.25, reference grows to $1M

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 88 | $2.2k | $12.6k | $97.0k | $488.4k | $1.41/d · 2.0d | $1.97/d · 14d | $1.94/d · 21d | $1.98/d · 19d | $2.13/d · 34d |
| 2 | COMBO-alt | 91 | $2.1k | $12.3k | $95.4k | $403.1k | $1.40/d · 2.0d | $1.96/d · 15d | $1.95/d · 21d | $1.98/d · 19d | $2.12/d · 36d |
| 3 | DUTCH+BASE | 130 | $1.4k | $5.9k | $52.8k | $382.2k | $0/d · 4.0d ≤0 | $0/d · 21d ≤0 | $0/d · 35d ≤0 | $0/d · 28d ≤0 | $0.16/d · 45d |
| 4 | DUTCH | 137 | $1.4k | $5.7k | $46.4k | $359.2k | -$2.52/d · 4.0d ≤0 | -$7.04/d · 22d ≤0 | -$2.16/d · 36d ≤0 | $1.11/d · 32d | $1.86/d · 48d |
| 5 | BASE | 139 | $1.3k | $5.7k | $48.1k | $184.9k | $7.82/d · 5.0d | -$3.08/d · 22d ≤0 | -$2.83/d · 34d ≤0 | -$9.48/d · 30d ≤0 | -$4.40/d · 70d ≤0 |
| 6 | REV | 167 | $1.2k | $5.1k | $38.4k | $179.1k | $11.2/d · 5.0d | -$1.06/d · 24d ≤0 | -$1.62/d · 38d ≤0 | -$3.96/d · 32d ≤0 | -$2.49/d · 76d ≤0 |
| 7 | DRIP | 169 | $1.2k | $5.0k | $37.5k | $275.2k | $11.2/d · 5.0d | -$0.75/d · 25d ≤0 | -$1.52/d · 38d ≤0 | -$4.49/d · 33d ≤0 | -$2.22/d · 68d ≤0 |

### Active, k = 0.25, reference shrinks to $500k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 84 | $2.2k | $12.6k | $85.8k | $430.1k | $1.41/d · 2.0d | $1.97/d · 14d | $1.94/d · 21d | $1.99/d · 20d | $2.13/d · 26d |
| 2 | COMBO-alt | 86 | $2.1k | $12.3k | $84.1k | $353.0k | $1.40/d · 2.0d | $1.96/d · 15d | $1.95/d · 21d | $2.00/d · 21d | $2.12/d · 27d |
| 3 | DUTCH+BASE | 124 | $1.4k | $5.9k | $49.5k | $320.7k | $0/d · 4.0d ≤0 | $0/d · 21d ≤0 | $0/d · 35d ≤0 | $0/d · 31d ≤0 | $0.11/d · 33d |
| 4 | DUTCH | 128 | $1.4k | $5.7k | $44.0k | $298.6k | -$2.52/d · 4.0d ≤0 | -$7.07/d · 22d ≤0 | -$2.17/d · 36d ≤0 | $1.15/d · 34d | $1.76/d · 34d |
| 5 | BASE | 131 | $1.3k | $5.7k | $44.8k | $146.3k | $7.82/d · 5.0d | -$3.07/d · 22d ≤0 | -$2.75/d · 35d ≤0 | -$7.24/d · 33d ≤0 | -$3.50/d · 41d ≤0 |
| 6 | REV | 139 | $1.2k | $5.1k | $36.5k | $140.7k | $11.2/d · 5.0d | -$1.03/d · 24d ≤0 | -$2.02/d · 39d ≤0 | -$3.05/d · 34d ≤0 | -$2.42/d · 56d ≤0 |
| 7 | DRIP | 151 | $1.2k | $5.0k | $35.7k | $210.3k | $11.2/d · 5.0d | -$0.76/d · 25d ≤0 | -$1.87/d · 39d ≤0 | -$2.75/d · 36d ≤0 | -$2.15/d · 45d ≤0 |

### Active, k = 0.50, reference fixed at $721k

Printed in full above.

### Active, k = 0.50, reference grows to $1M

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 48 | $2.2k | $40.1k | $170.1k | $12.98M | $1.41/d · 2.0d | $1.93/d · 11d | $1.99/d · 10d | $1.89/d · 9.0d | $1.97/d · 15d |
| 2 | COMBO-alt | 49 | $2.1k | $38.3k | $158.9k | $8.36M | $1.40/d · 2.0d | $1.91/d · 11d | $1.98/d · 10.0d | $1.89/d · 10.0d | $1.98/d · 15d |
| 3 | DUTCH+BASE | 76 | $1.4k | $11.5k | $128.7k | $10.08M | $0/d · 4.0d ≤0 | $0/d · 16d ≤0 | $0/d · 16d ≤0 | $0/d · 14d ≤0 | $0.34/d · 26d |
| 4 | DUTCH | 76 | $1.4k | $10.6k | $123.1k | $9.26M | -$2.52/d · 4.0d ≤0 | -$6.98/d · 16d ≤0 | -$2.07/d · 18d ≤0 | $0.88/d · 15d | $1.92/d · 23d |
| 5 | BASE | 84 | $1.3k | $10.2k | $100.2k | $471.6k | $7.82/d · 5.0d | -$4.21/d · 16d ≤0 | -$11.3/d · 17d ≤0 | -$21.1/d · 16d ≤0 | -$12.3/d · 29d ≤0 |
| 6 | REV | 90 | $1.2k | $8.2k | $95.5k | $448.1k | $11.2/d · 5.0d | -$1.38/d · 18d ≤0 | -$4.26/d · 19d ≤0 | -$10.8/d · 18d ≤0 | -$7.88/d · 31d ≤0 |
| 7 | DRIP | 93 | $1.2k | $8.1k | $93.5k | $1.53M | $11.2/d · 5.0d | -$1.01/d · 18d ≤0 | -$4.01/d · 20d ≤0 | -$11.2/d · 17d ≤0 | -$8.13/d · 33d ≤0 |

### Active, k = 0.50, reference shrinks to $500k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 45 | $2.2k | $39.5k | $158.3k | $12.06M | $1.41/d · 2.0d | $1.93/d · 11d | $1.99/d · 10d | $1.89/d · 10.0d | $1.98/d · 12d |
| 2 | COMBO-alt | 48 | $2.1k | $37.8k | $147.4k | $7.74M | $1.40/d · 2.0d | $1.91/d · 11d | $1.98/d · 10.0d | $1.90/d · 10.0d | $1.98/d · 14d |
| 3 | DUTCH+BASE | 65 | $1.4k | $11.5k | $115.0k | $9.01M | $0/d · 4.0d ≤0 | $0/d · 16d ≤0 | $0/d · 17d ≤0 | $0/d · 14d ≤0 | $0.40/d · 20d |
| 4 | DUTCH | 76 | $1.4k | $10.6k | $110.5k | $8.29M | -$2.52/d · 4.0d ≤0 | -$7.01/d · 16d ≤0 | -$2.09/d · 18d ≤0 | $0.89/d · 15d | $1.91/d · 22d |
| 5 | BASE | 81 | $1.3k | $10.2k | $88.2k | $413.9k | $7.82/d · 5.0d | -$4.22/d · 16d ≤0 | -$10.7/d · 17d ≤0 | -$13.5/d · 17d ≤0 | -$10.7/d · 26d ≤0 |
| 6 | REV | 86 | $1.2k | $8.2k | $83.7k | $393.1k | $11.2/d · 5.0d | -$1.41/d · 18d ≤0 | -$4.37/d · 19d ≤0 | -$12.2/d · 19d ≤0 | -$9.28/d · 25d ≤0 |
| 7 | DRIP | 87 | $1.2k | $8.0k | $81.9k | $1.40M | $11.2/d · 5.0d | -$1.02/d · 18d ≤0 | -$4.30/d · 20d ≤0 | -$12.5/d · 18d ≤0 | -$8.84/d · 26d ≤0 |

### Active, k = 1, reference fixed at $721k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 24 | $3.0k | $119.0k | $1.79M | $755.44B | $1.41/d · 2.0d | $1.84/d · 6.1d | $1.97/d · 5.9d | $1.98/d · 4.0d | $1.99/d · 5.4d |
| 2 | COMBO-alt | 25 | $2.9k | $113.8k | $1.46M | $301.38B | $1.40/d · 2.0d | $1.83/d · 7.0d | $1.97/d · 5.0d | $2.00/d · 4.2d | $1.95/d · 5.8d |
| 3 | DUTCH+BASE | 35 | $1.4k | $61.3k | $1.01M | $423.81B | $0/d · 4.0d ≤0 | $0/d · 10.0d ≤0 | $0/d · 7.0d ≤0 | $0/d · 7.0d ≤0 | $0.16/d · 6.9d |
| 4 | DUTCH | 36 | $1.4k | $56.3k | $944.3k | $374.40B | -$2.52/d · 4.0d ≤0 | -$4.05/d · 10.0d ≤0 | -$2.45/d · 8.0d ≤0 | $0.48/d · 7.0d | $1.73/d · 6.7d |
| 5 | BASE | 46 | $1.3k | $42.0k | $145.0k | $3.06M | $7.82/d · 5.0d | -$7.25/d · 10.0d ≤0 | -$34.7/d · 8.0d ≤0 | -$41.5/d · 8.8d ≤0 | -$12.0/d · 15d ≤0 |
| 6 | DRIP | 50 | $1.2k | $30.8k | $167.5k | $20.70M | $11.2/d · 5.0d | $0.01/d · 11d | -$8.73/d · 10.0d ≤0 | -$28.5/d · 9.0d ≤0 | -$8.65/d · 14d ≤0 |
| 7 | REV | 50 | $1.2k | $30.9k | $139.8k | $2.94M | $11.2/d · 5.0d | -$0.21/d · 11d ≤0 | -$9.07/d · 10.0d ≤0 | -$28.6/d · 9.0d ≤0 | -$8.51/d · 15d ≤0 |

### Active, k = 1, reference grows to $1M

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 24 | $3.0k | $121.0k | $1.82M | $767.64B | $1.41/d · 2.0d | $1.84/d · 6.1d | $1.97/d · 5.9d | $1.98/d · 4.0d | $1.98/d · 5.7d |
| 2 | COMBO-alt | 25 | $2.9k | $115.6k | $1.48M | $306.03B | $1.40/d · 2.0d | $1.83/d · 7.0d | $1.97/d · 5.0d | $1.98/d · 4.1d | $1.97/d · 5.9d |
| 3 | DUTCH+BASE | 36 | $1.4k | $62.0k | $1.03M | $433.37B | $0/d · 4.0d ≤0 | $0/d · 10.0d ≤0 | $0/d · 7.0d ≤0 | $0/d · 7.0d ≤0 | $0.15/d · 7.1d |
| 4 | DUTCH | 37 | $1.4k | $56.9k | $964.5k | $382.40B | -$2.52/d · 4.0d ≤0 | -$4.05/d · 10.0d ≤0 | -$2.45/d · 8.0d ≤0 | $0.48/d · 6.9d | $1.71/d · 7.2d |
| 5 | BASE | 49 | $1.3k | $42.5k | $151.0k | $3.18M | $7.82/d · 5.0d | -$8.07/d · 10.0d ≤0 | -$34.4/d · 8.0d ≤0 | -$39.5/d · 8.4d ≤0 | -$12.6/d · 17d ≤0 |
| 6 | REV | 50 | $1.2k | $31.1k | $145.8k | $3.08M | $11.2/d · 5.0d | -$0.20/d · 11d ≤0 | -$8.89/d · 10.0d ≤0 | -$22.5/d · 8.8d ≤0 | -$15.4/d · 15d ≤0 |
| 7 | DRIP | 51 | $1.2k | $31.0k | $171.9k | $21.13M | $11.2/d · 5.0d | $0.03/d · 11d | -$8.70/d · 10.0d ≤0 | -$21.7/d · 9.0d ≤0 | -$13.6/d · 15d ≤0 |

### Active, k = 1, reference shrinks to $500k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 24 | $3.0k | $117.4k | $1.77M | $745.66B | $1.41/d · 2.0d | $1.84/d · 6.1d | $1.97/d · 5.9d | $1.98/d · 4.0d | $1.99/d · 5.4d |
| 2 | COMBO-alt | 24 | $2.9k | $112.4k | $1.44M | $297.67B | $1.40/d · 2.0d | $1.83/d · 7.0d | $1.97/d · 5.0d | $1.97/d · 4.3d | $1.99/d · 5.6d |
| 3 | DUTCH+BASE | 35 | $1.4k | $60.7k | $992.2k | $417.10B | $0/d · 4.0d ≤0 | $0/d · 10.0d ≤0 | $0/d · 7.0d ≤0 | $0/d · 7.0d ≤0 | $0.13/d · 6.5d |
| 4 | DUTCH | 36 | $1.4k | $55.8k | $928.9k | $368.27B | -$2.52/d · 4.0d ≤0 | -$4.05/d · 10.0d ≤0 | -$2.45/d · 8.0d ≤0 | $0.48/d · 7.0d | $1.72/d · 6.5d |
| 5 | BASE | 45 | $1.3k | $41.7k | $140.1k | $2.94M | $7.82/d · 5.0d | -$7.26/d · 10.0d ≤0 | -$34.8/d · 8.0d ≤0 | -$40.3/d · 9.0d ≤0 | -$11.1/d · 14d ≤0 |
| 6 | DRIP | 50 | $1.2k | $30.7k | $162.0k | $20.04M | $11.2/d · 5.0d | $0/d · 11d | -$9.46/d · 10.0d ≤0 | -$29.7/d · 9.0d ≤0 | -$12.0/d · 14d ≤0 |
| 7 | REV | 50 | $1.2k | $30.7k | $135.8k | $2.86M | $11.2/d · 5.0d | -$0.22/d · 11d ≤0 | -$9.14/d · 10.0d ≤0 | -$24.1/d · 9.0d ≤0 | -$13.8/d · 14d ≤0 |

## Dead

### Dead, k = 0.25, reference fixed at $721k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 114 | $399 | $2.1k | $60.7k | $362.5k | $1.59/d · 19d | $1.88/d · 23d | $1.96/d · 22d | $2.10/d · 19d | $2.13/d · 31d |
| 2 | COMBO-alt | 117 | $393 | $2.1k | $58.4k | $302.4k | $1.56/d · 19d | $1.88/d · 23d | $1.96/d · 22d | $2.10/d · 21d | $2.12/d · 31d |
| 3 | DUTCH+BASE | 174 | $290 | $989 | $12.4k | $252.7k | $0/d · 30d ≤0 | $0/d · 37d ≤0 | $0/d · 35d ≤0 | $0/d · 30d ≤0 | $0.18/d · 41d |
| 4 | DUTCH | 176 | $338 | $1.2k | $14.0k | $251.8k | -$6.70/d · 26d ≤0 | -$9.00/d · 37d ≤0 | -$1.40/d · 37d ≤0 | $0.82/d · 31d | $1.86/d · 44d |
| 5 | BASE | 192 | $266 | $964 | $12.3k | $139.3k | -$0.32/d · 30d ≤0 | -$1.11/d · 37d ≤0 | -$4.37/d · 35d ≤0 | -$7.59/d · 33d ≤0 | -$1.82/d · 56d ≤0 |
| 6 | DRIP | 207 | $247 | $847 | $8.6k | $186.3k | $0.02/d · 34d | -$0.43/d · 41d ≤0 | -$1.71/d · 39d ≤0 | -$2.97/d · 36d ≤0 | -$2.42/d · 57d ≤0 |
| 7 | REV | 209 | $247 | $848 | $8.6k | $132.5k | $0.02/d · 34d | -$0.48/d · 41d ≤0 | -$1.74/d · 39d ≤0 | -$3.30/d · 35d ≤0 | -$2.42/d · 60d ≤0 |

### Dead, k = 0.25, reference grows to $1M

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 117 | $399 | $2.1k | $63.7k | $396.2k | $1.59/d · 19d | $1.88/d · 23d | $1.95/d · 21d | $2.10/d · 19d | $2.12/d · 35d |
| 2 | COMBO-alt | 120 | $393 | $2.1k | $61.2k | $331.3k | $1.56/d · 19d | $1.88/d · 23d | $1.96/d · 22d | $2.09/d · 20d | $2.09/d · 36d |
| 3 | DUTCH+BASE | 179 | $290 | $990 | $12.5k | $290.5k | $0/d · 30d ≤0 | $0/d · 37d ≤0 | $0/d · 35d ≤0 | $0/d · 27d ≤0 | $0.15/d · 50d |
| 4 | DUTCH | 182 | $338 | $1.2k | $14.1k | $290.1k | -$6.76/d · 26d ≤0 | -$8.90/d · 37d ≤0 | -$1.44/d · 36d ≤0 | $0.77/d · 30d | $1.88/d · 53d |
| 5 | BASE | 203 | $266 | $964 | $12.4k | $163.4k | -$0.32/d · 30d ≤0 | -$1.11/d · 37d ≤0 | -$3.43/d · 35d ≤0 | -$9.66/d · 30d ≤0 | -$1.61/d · 71d ≤0 |
| 6 | DRIP | 211 | $247 | $847 | $8.7k | $217.9k | $0.02/d · 34d | -$0.43/d · 41d ≤0 | -$1.78/d · 38d ≤0 | -$2.60/d · 34d ≤0 | -$1.85/d · 64d ≤0 |
| 7 | REV | 224 | $247 | $848 | $8.7k | $157.6k | $0.02/d · 34d | -$0.47/d · 41d ≤0 | -$2.13/d · 38d ≤0 | -$2.94/d · 33d ≤0 | -$2.19/d · 78d ≤0 |

### Dead, k = 0.25, reference shrinks to $500k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 112 | $399 | $2.1k | $58.3k | $336.4k | $1.59/d · 19d | $1.88/d · 23d | $1.96/d · 22d | $2.10/d · 20d | $2.13/d · 27d |
| 2 | COMBO-alt | 114 | $393 | $2.1k | $56.1k | $280.2k | $1.56/d · 19d | $1.88/d · 23d | $1.97/d · 23d | $2.10/d · 21d | $2.12/d · 28d |
| 3 | DUTCH+BASE | 168 | $290 | $989 | $12.3k | $224.8k | $0/d · 30d ≤0 | $0/d · 37d ≤0 | $0/d · 35d ≤0 | $0/d · 32d ≤0 | $0.19/d · 33d |
| 4 | DUTCH | 170 | $338 | $1.2k | $13.8k | $223.8k | -$6.70/d · 26d ≤0 | -$8.97/d · 37d ≤0 | -$1.40/d · 37d ≤0 | $0.87/d · 34d | $1.86/d · 35d |
| 5 | BASE | 182 | $266 | $964 | $12.3k | $121.5k | -$0.32/d · 30d ≤0 | -$1.12/d · 37d ≤0 | -$4.80/d · 36d ≤0 | -$6.47/d · 35d ≤0 | -$2.37/d · 43d ≤0 |
| 6 | DRIP | 196 | $247 | $847 | $8.6k | $162.3k | $0.02/d · 34d | -$0.43/d · 41d ≤0 | -$1.76/d · 40d ≤0 | -$2.95/d · 38d ≤0 | -$32.4/d · 42d ≤0 |
| 7 | REV | 199 | $247 | $848 | $8.6k | $114.2k | $0.02/d · 34d | -$0.47/d · 41d ≤0 | -$1.70/d · 39d ≤0 | -$3.19/d · 39d ≤0 | -$1.89/d · 45d ≤0 |

### Dead, k = 0.50, reference fixed at $721k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 59 | $411 | $9.9k | $133.6k | $8.58M | $1.53/d · 13d | $1.85/d · 11d | $1.83/d · 11d | $1.97/d · 10.0d | $2.03/d · 13d |
| 2 | COMBO-alt | 60 | $403 | $9.3k | $126.0k | $5.54M | $1.49/d · 13d | $1.84/d · 12d | $1.85/d · 11d | $1.99/d · 9.0d | $2.03/d · 15d |
| 3 | DUTCH+BASE | 87 | $290 | $2.2k | $92.4k | $6.16M | $0/d · 20d ≤0 | $0/d · 19d ≤0 | $0/d · 16d ≤0 | $0/d · 14d ≤0 | $0.15/d · 17d |
| 4 | DUTCH | 88 | $339 | $2.7k | $89.9k | $5.75M | -$5.74/d · 18d ≤0 | -$7.76/d · 19d ≤0 | -$1.82/d · 18d ≤0 | $0.92/d · 15d | $1.82/d · 18d |
| 5 | BASE | 103 | $266 | $2.0k | $76.5k | $365.1k | -$0.70/d · 21d ≤0 | -$2.59/d · 19d ≤0 | -$9.73/d · 18d ≤0 | -$21.8/d · 16d ≤0 | -$8.23/d · 28d ≤0 |
| 6 | DRIP | 113 | $247 | $1.5k | $63.0k | $1.07M | $0.15/d · 24d | -$1.01/d · 21d ≤0 | -$3.63/d · 20d ≤0 | -$11.2/d · 17d ≤0 | -$6.54/d · 30d ≤0 |
| 7 | REV | 113 | $247 | $1.5k | $63.2k | $345.9k | $0.14/d · 24d | -$1.06/d · 21d ≤0 | -$3.83/d · 19d ≤0 | -$10.5/d · 18d ≤0 | -$5.50/d · 30d ≤0 |

### Dead, k = 0.50, reference grows to $1M

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 60 | $411 | $9.9k | $140.2k | $9.02M | $1.53/d · 13d | $1.85/d · 11d | $1.83/d · 11d | $1.99/d · 9.2d | $2.02/d · 15d |
| 2 | COMBO-alt | 61 | $403 | $9.3k | $132.6k | $5.83M | $1.49/d · 13d | $1.84/d · 12d | $1.85/d · 11d | $1.98/d · 9.0d | $2.04/d · 15d |
| 3 | DUTCH+BASE | 88 | $290 | $2.2k | $98.6k | $6.57M | $0/d · 20d ≤0 | $0/d · 19d ≤0 | $0/d · 16d ≤0 | $0/d · 14d ≤0 | $0.15/d · 19d |
| 4 | DUTCH | 90 | $339 | $2.7k | $96.0k | $6.15M | -$5.73/d · 18d ≤0 | -$7.77/d · 19d ≤0 | -$1.89/d · 17d ≤0 | $0.84/d · 15d | $1.82/d · 20d |
| 5 | BASE | 106 | $266 | $2.0k | $81.4k | $398.2k | -$0.70/d · 21d ≤0 | -$2.58/d · 19d ≤0 | -$9.75/d · 18d ≤0 | -$22.1/d · 16d ≤0 | -$7.64/d · 31d ≤0 |
| 6 | DRIP | 116 | $247 | $1.5k | $66.3k | $1.17M | $0.16/d · 24d | -$0.96/d · 21d ≤0 | -$4.49/d · 19d ≤0 | -$11.9/d · 17d ≤0 | -$6.34/d · 34d ≤0 |
| 7 | REV | 116 | $247 | $1.5k | $66.5k | $380.5k | $0.14/d · 24d | -$1.01/d · 21d ≤0 | -$3.57/d · 19d ≤0 | -$12.3/d · 17d ≤0 | -$6.68/d · 34d ≤0 |

### Dead, k = 0.50, reference shrinks to $500k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 58 | $411 | $9.9k | $128.4k | $8.25M | $1.53/d · 13d | $1.85/d · 11d | $1.83/d · 11d | $1.97/d · 10.0d | $2.02/d · 12d |
| 2 | COMBO-alt | 60 | $403 | $9.3k | $120.9k | $5.31M | $1.49/d · 13d | $1.84/d · 12d | $1.85/d · 11d | $1.97/d · 10.0d | $2.05/d · 13d |
| 3 | DUTCH+BASE | 86 | $290 | $2.2k | $87.5k | $5.84M | $0/d · 20d ≤0 | $0/d · 19d ≤0 | $0/d · 16d ≤0 | $0/d · 15d ≤0 | $0.17/d · 15d |
| 4 | DUTCH | 87 | $339 | $2.7k | $85.2k | $5.44M | -$5.74/d · 18d ≤0 | -$8.06/d · 19d ≤0 | -$1.77/d · 18d ≤0 | $0.94/d · 15d | $1.82/d · 16d |
| 5 | BASE | 100 | $266 | $2.0k | $72.3k | $339.7k | -$0.70/d · 21d ≤0 | -$2.59/d · 19d ≤0 | -$9.69/d · 18d ≤0 | -$21.1/d · 17d ≤0 | -$8.24/d · 24d ≤0 |
| 6 | DRIP | 110 | $247 | $1.5k | $60.3k | $979.8k | $0.15/d · 24d | -$0.97/d · 21d ≤0 | -$3.92/d · 20d ≤0 | -$9.87/d · 18d ≤0 | -$8.15/d · 26d ≤0 |
| 7 | REV | 110 | $247 | $1.5k | $60.5k | $319.9k | $0.14/d · 24d | -$1.10/d · 21d ≤0 | -$3.93/d · 20d ≤0 | -$10.3/d · 18d ≤0 | -$8.23/d · 26d ≤0 |

### Dead, k = 1, reference fixed at $721k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 30 | $696 | $90.3k | $1.26M | $398.96B | $1.38/d · 8.0d | $1.92/d · 6.0d | $1.87/d · 5.0d | $1.84/d · 5.0d | $1.92/d · 5.1d |
| 2 | COMBO-alt | 30 | $671 | $87.5k | $1.03M | $162.24B | $1.34/d · 8.0d | $1.90/d · 6.0d | $1.88/d · 5.6d | $1.84/d · 4.4d | $1.92/d · 5.7d |
| 3 | DUTCH+BASE | 43 | $366 | $22.0k | $730.3k | $230.77B | $0/d · 12d ≤0 | $0/d · 9.0d ≤0 | $0/d · 8.0d ≤0 | $0/d · 6.7d ≤0 | $0.17/d · 7.2d |
| 4 | DUTCH | 44 | $449 | $23.4k | $709.0k | $211.77B | -$5.61/d · 11d ≤0 | -$8.29/d · 9.0d ≤0 | -$2.20/d · 8.9d ≤0 | $0.58/d · 6.5d | $1.75/d · 7.7d |
| 5 | BASE | 55 | $305 | $14.0k | $129.2k | $2.70M | -$1.27/d · 14d ≤0 | -$8.79/d · 9.4d ≤0 | -$34.9/d · 9.0d ≤0 | -$61.7/d · 8.0d ≤0 | -$13.8/d · 14d ≤0 |
| 6 | DRIP | 60 | $273 | $8.9k | $132.2k | $16.78M | -$0.56/d · 15d ≤0 | $1.64/d · 11d | -$7.44/d · 10.0d ≤0 | -$12.9/d · 9.0d ≤0 | -$15.1/d · 14d ≤0 |
| 7 | REV | 60 | $274 | $8.9k | $122.1k | $2.55M | -$0.66/d · 15d ≤0 | $1.43/d · 11d | -$7.89/d · 10.0d ≤0 | -$12.8/d · 8.3d ≤0 | -$15.2/d · 15d ≤0 |

### Dead, k = 1, reference grows to $1M

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 30 | $696 | $92.3k | $1.28M | $407.35B | $1.38/d · 8.0d | $1.92/d · 6.0d | $1.87/d · 5.0d | $1.84/d · 5.0d | $1.92/d · 5.2d |
| 2 | COMBO-alt | 30 | $671 | $89.4k | $1.06M | $166.01B | $1.34/d · 8.0d | $1.90/d · 6.0d | $1.88/d · 5.5d | $1.84/d · 4.5d | $1.92/d · 6.0d |
| 3 | DUTCH+BASE | 44 | $366 | $22.1k | $754.5k | $238.42B | $0/d · 12d ≤0 | $0/d · 9.0d ≤0 | $0/d · 8.0d ≤0 | $0/d · 6.3d ≤0 | $0.15/d · 7.7d |
| 4 | DUTCH | 44 | $449 | $23.5k | $731.3k | $218.45B | -$5.61/d · 11d ≤0 | -$7.95/d · 9.0d ≤0 | -$2.23/d · 8.8d ≤0 | $0.52/d · 6.2d | $1.72/d · 8.2d |
| 5 | BASE | 55 | $305 | $14.0k | $135.3k | $2.82M | -$1.27/d · 14d ≤0 | -$8.82/d · 9.4d ≤0 | -$34.9/d · 9.0d ≤0 | -$53.1/d · 8.0d ≤0 | -$13.1/d · 14d ≤0 |
| 6 | DRIP | 61 | $273 | $8.9k | $142.3k | $17.95M | -$0.64/d · 15d ≤0 | $1.68/d · 11d | -$7.28/d · 10.0d ≤0 | -$11.2/d · 8.0d ≤0 | -$13.2/d · 16d ≤0 |
| 7 | REV | 61 | $274 | $8.9k | $128.4k | $2.68M | -$0.66/d · 15d ≤0 | $1.54/d · 11d | -$6.64/d · 9.5d ≤0 | -$12.6/d · 8.6d ≤0 | -$13.5/d · 16d ≤0 |

### Dead, k = 1, reference shrinks to $500k

| Rank | Variant | Grad day | TVL 7 | TVL 30 | TVL 90 | TVL 365 | $0–1k | $1–5k | $5–20k | $20–50k | $50k–grad |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 30 | $696 | $88.7k | $1.24M | $392.26B | $1.38/d · 8.0d | $1.92/d · 6.0d | $1.87/d · 5.0d | $1.84/d · 5.0d | $1.92/d · 5.1d |
| 2 | COMBO-alt | 30 | $671 | $86.0k | $1.01M | $159.36B | $1.34/d · 8.0d | $1.90/d · 6.0d | $1.88/d · 5.7d | $1.84/d · 4.3d | $1.93/d · 5.5d |
| 3 | DUTCH+BASE | 43 | $366 | $21.9k | $710.6k | $224.52B | $0/d · 12d ≤0 | $0/d · 9.0d ≤0 | $0/d · 8.0d ≤0 | $0/d · 6.9d ≤0 | $0.18/d · 6.7d |
| 4 | DUTCH | 43 | $449 | $23.3k | $691.3k | $206.48B | -$5.61/d · 11d ≤0 | -$8.29/d · 9.0d ≤0 | -$2.20/d · 9.0d ≤0 | $0.62/d · 6.7d | $1.77/d · 7.2d |
| 5 | BASE | 54 | $305 | $13.9k | $124.5k | $2.60M | -$1.27/d · 14d ≤0 | -$8.80/d · 9.4d ≤0 | -$35.0/d · 9.0d ≤0 | -$57.5/d · 8.0d ≤0 | -$14.9/d · 13d ≤0 |
| 6 | DRIP | 59 | $273 | $8.9k | $125.9k | $16.15M | -$0.56/d · 15d ≤0 | $1.61/d · 11d | -$7.68/d · 10.0d ≤0 | -$12.2/d · 9.0d ≤0 | -$18.1/d · 13d ≤0 |
| 7 | REV | 59 | $274 | $8.9k | $117.1k | $2.45M | -$0.66/d · 15d ≤0 | $1.46/d · 11d | -$8.11/d · 10.0d ≤0 | -$12.7/d · 9.0d ≤0 | -$18.1/d · 13d ≤0 |

