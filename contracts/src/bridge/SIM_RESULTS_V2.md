# Disciple V2 simulation

This is a study. The hook that ships in this PR charges only the progress slide, from 2% down to 0.3% as pool TVL reaches the live target. It does not charge the volume fee below. Dutch quotes, the 77-minute reversible graduation, and the 12% target are in the contract. The volume fee, the knob search, and the external LP inflow are not.

COMBO is the combination that was scored: shared-reset Dutch quotes, the progress slide, the volume fee charged on top of the full gap, and the 5×→1.2× LP boost. The search below kept the default edge, red line, boost, and fee slope, and raised the Dutch drift from 1% an hour to 2% an hour. On the active, k = 0.5, fixed-reference path that set reaches the graduation target on day 76, ends the year at $9.31M, and keeps searcher profit positive in every progress bucket.

The other way to combine the volume fee with the gap, subtracting it from the quote and charging nothing extra, is COMBO-alt. On that same path it reaches the target on day 77, ends at $5.96M, and earns no searcher profit in the first two progress buckets. Charging the fee on the full gap is the version that grows TVL to graduation. Both use the same knobs.

## What was run

One searcher, OUT. The searcher pays the pool fee plus 0.5%. That is the binding cost. LOW (about 0.05% on top of the fee) is not in this grid.

The anchor mean-reverts around $1. The log-deviation half-life is 7 days, so there is no trend. Active volatility is 3% a day. Dead volatility is 0.1% a day. Every variant in a scene shares the anchor seed. Active paths end the year at 1.0173. Dead paths end at 1.0006.

Organic volume each day is `max(base, k × pool TVL)`. The active base is $1,000. The dead base is $150. k is 0.25, 0.5, or 1. The day is 24 equal clips, about an hour apart, so the 77-minute graduation window can elapse. Arb size is endogenous.

The reference TVL is $721,000 in the main case, so the target stays $86,520. One path grows the reference linearly to $1,000,000 (target $120,000). One path shrinks it linearly to $500,000 (target $60,000). Progress is pool TVL divided by the live target. Buckets are 0–10%, 10–30%, 30–60%, and 60–100% of that target.

Graduation in the sim matches the contract. Status turns on after 77 continuous minutes at or above the target and turns off after 77 continuous minutes below it. The first observation does not flip status. The fee, the boost, and Dutch size use progress immediately. Morpho yield is credited only while status is on: 5% APR on the idle slice (at most half of USDG, above the 20% floor and the buffer). The yield is added to the book. Turning status off stops the yield. In this grid every profile that graduated was still graduated on day 365, including the path whose target rises to $120,000. TVL did not spend 77 minutes back under the moving target.

Rank is days to the first day status turns on, then TVL on day 365. A bucket is flagged when the pool spent at least a day there and cumulative searcher profit in that bucket is ≤ 0. Searcher profit is mark-to-anchor minus the 0.5% cost.

`test_simV2` produced the lines. It is skipped unless `SIM_V2=1`.

## The fee and the gap

Two interactions were scored at the knobs the search kept.

**On top (COMBO).** The quote is the full Dutch gap. The fill also pays the volume fee: 0.3% when recent volume is quiet, rising with decayed volume up to the progress-slide cap, with a one-hour half-life. The red line is 0.5× TVL. The searcher must clear gap > fee + 0.5%.

**Netted (COMBO-alt).** The quote is tightened by that same fee, and the fill pays 0. The fee is not charged twice. The searcher must clear the net gap against the full progress slide plus 0.5%.

Hourly clips reset the clock, so the rested gap is about one hour of drift. At 2% an hour the rested gap is about 2%. The volume fee on these paths stays near its 0.3% floor, because decayed volume stays well under half of TVL, so 2% clears fee + 0.5% from the start. The netted quote gives that 2% away to the fee and then still asks the searcher to beat the full slide. Early on, that slide is near 2%, so the netted quote does not clear and those buckets earn nothing.

## Knobs

The search is one change at a time, on the on-top book, for 30 active days at k = 0.5 and a fixed reference. A set is kept only when every progress bucket that was occupied for at least a day has searcher profit above zero. Among those, the higher 30-day TVL wins. None of the 30-day runs reached the target, so TVL is the growth measure inside the search. The winner and the netted book were then rerun for the full year at the winning knobs. That year is what named COMBO.

| Change | 30-day TVL | Buckets solvent |
| --- | ---: | --- |
| Default (1%/hour, edge 0.25, red line 0.5, boost 5×, fee 2%→0.3%) | $11.5k | no |
| Drift 0.5%/hour | $10.0k | no |
| Drift 2%/hour | $11.7k | yes |
| Edge 0.10 | $11.4k | no |
| Edge 0.50 | $12.3k | no |
| Red line 0.25× TVL | $10.3k | no |
| Red line 1× TVL | $12.4k | no |
| Boost 3× | $4.2k | no |
| Boost 8× | $39.2k | no |
| Launch fee 1% | $12.5k | no |
| Launch fee 3% | $10.9k | no |
| Drift 5%/hour | $11.3k | yes |
| Drift 10%/hour (contract maximum) | $11.2k | yes |

Only 2%, 5%, and 10% an hour keep the active searcher solvent for those 30 days. 2% an hour has the highest TVL of the three, so that is the set. Full year at those knobs: on top graduates on day 76 at $9.31M and stays solvent; netted graduates on day 77 at $5.96M and does not.

The 8× boost grows 30-day TVL to $39.2k and fails the profit check, so it was not used. The grid's COMBO uses the same 5× start as the other variants. A wider edge, a quieter red line, and a 1% launch fee also grow the 30-day TVL and fail the same check.

The contract's default drift remains 1% an hour. This study does not change it.

## How to read the grid

COMBO is listed first. The rank column is days-to-graduation, then day-365 TVL.

DUTCHBASE is the same shared-reset quote and the same progress slide, with no volume fee, at the contract's 1% an hour drift. DUTCH keeps an independent clock on each side, charges the volume fee, and also drifts at 1% an hour. BASE is the slide on the curve, with the spot/anchor ratio preserved when the anchor moves. REV is that curve with the volume fee. DRIP is REV plus the fee-funded surplus sale. BASE, REV, DUTCH, DRIP, and DUTCHBASE are not retuned.

Dutch-family books in this file are parked on the anchor after each quote and on each anchor move, so the gap is only the time quote. The shipped hook returns the curve to its pre-trade spot, and a zero gap leaves the 0.67× launch discount on the curve.

The searcher looks at the quote that has been open since the previous clip, before retail trades. A shared-reset fill parks both quotes. Retail then trades whatever is left, which is the anchor if the searcher just took the quote.

There is an external LP inflow so the boost can move TVL. Fee-split weight alone cannot, because both sides compound in the same book. Inflow is `budget × (boost − 1) / 25`. At 5× that is 16% of the day's organic budget. At the 1.2× end it is 0.8%. It arrives as coin while spot is under the anchor, and as USDG otherwise. Every variant gets it. Once daily volume scales with TVL, this inflow compounds. At k = 1 the day-365 TVL is the compound of that assumption after the pool is already large. Graduation day is the comparison that stays readable there. The Dutch slice does not scale with it: at a 2% gap the offered size is about $12.50 (`$0.25 / gap`), so COMBO's arb notional stays near $300 a day in every cell.

Bucket cells are cumulative searcher profit while the pool was in that band, and how many days it spent there. `≤0` means the band was occupied for at least a day and profit was not positive.

## Active, fixed reference, k = 0.5

This is the path the search was fit to.

| Rank | Variant | Grad day | On | TVL 7 | TVL 30 | TVL 90 | TVL 365 | Arb/day | Profit/day | Fees/day | Eff bps | Gap | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | COMBO | 76 | yes | $1.5k | $11.7k | $119.7k | $9.31M | $299 | $3 | $2.3k | 30 | 2.00% | $22 / 26d | $43 / 14d | $41 / 12d | $1.0k / 313d |
| 4 | COMBO-alt | 77 | yes | $1.3k | $9.5k | $111.1k | $5.96M | $258 | $3 | $0 | 0 | 2.00% | $0 / 29d ≤0 | $0 / 14d ≤0 | $14 / 12d | $1.0k / 310d |
| 5 | BASE | 83 | yes | $1.3k | $10.2k | $93.7k | $438.5k | $7.7k | -$3 | $308 | 32 | 0.53% | -$93 / 28d ≤0 | -$146 / 14d ≤0 | -$224 / 14d ≤0 | -$591 / 309d ≤0 |
| 6 | REV | 87 | yes | $1.2k | $8.2k | $88.8k | $417.8k | $7.3k | -$2 | $272 | 30 | 0.48% | $13 / 30d | -$106 / 17d ≤0 | -$197 / 14d ≤0 | -$477 / 304d ≤0 |
| 3 | DUTCH | 76 | yes | $1.4k | $10.6k | $116.2k | $8.73M | $1.2k | $0.98 | $2.2k | 30 | 1.02% | -$149 / 27d ≤0 | -$10 / 14d ≤0 | $12 / 13d | $505 / 311d |
| 7 | DRIP | 90 | yes | $1.2k | $8.0k | $87.0k | $1.43M | $9.8k | -$75 | $543 | 30 | 0.48% | $20 / 31d | -$92 / 16d ≤0 | -$189 / 14d ≤0 | -$27.1k / 304d ≤0 |
| 1 | DUTCH+BASE | 67 | yes | $1.4k | $11.5k | $121.1k | $9.48M | $499 | $0.39 | $2.4k | 30 | 1.00% | $0 / 26d ≤0 | $0 / 13d ≤0 | $0 / 12d ≤0 | $141 / 314d |

COMBO is the only book on this path whose searcher profit stays positive in every bucket. DUTCH+BASE reaches the target nine days sooner and ends slightly larger, and the searcher earns nothing until the pool is already in the last bucket: a 1% hourly gap does not clear the early 2% slide plus 0.5%. BASE and REV pay the searcher a loss in most buckets. The mean-reverting anchor does not open a curve gap wide enough to cover OUT's cost. DRIP graduates last on this path.

COMBO's effective fee for the year is 30 bps. COMBO-alt's effective fee is 0 because the concession is in the quote. Both still show about $3 a day of searcher profit over the year. COMBO-alt's early buckets are the ones that fail.

## Where the constraint holds

On every active cell (nine paths: three k values, three reference paths) COMBO's four buckets are positive. That is the set the search was asked to find, and it survives the active k values and the moving reference that it was not fit to.

On every dead cell the same set loses money in the 0–10% bucket. The book stays small for longer, the Dutch slice is a larger fraction of it, and the mark does not cover the 0.5% cost. Profit turns positive from 10% on. No knob set was re-searched on the dead book. This grid does not contain a COMBO that keeps searcher profit positive all the way to graduation when the coin is dead. The closest result is this one: COMBO still graduates first or tied on eight of the nine dead cells, and the loss is confined to the first bucket.

DUTCH+BASE's early buckets are $0 of profit on every cell, active and dead. The hours are occupied. The searcher does not take the 1% quote until the slide has fallen. That fails the same test.

## Graduation day

COMBO graduates first, or ties and then leads on day-365 TVL, in 11 of the 18 cells. DUTCH+BASE graduates first in the other seven, all of them active paths at k = 0.25 or k = 0.5, plus the dead k = 0.25 path whose reference grows (same day as COMBO, slightly higher year-end TVL).

| Scene | k | Reference | COMBO day | DUTCH+BASE day | COMBO-alt day | BASE day | REV day | DUTCH day | DRIP day |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Active | 0.25 | Fixed | 130 | 128 | 137 | 138 | 163 | 130 | 162 |
| Active | 0.25 | Grows | 136 | 130 | 138 | 139 | 167 | 137 | 169 |
| Active | 0.25 | Shrinks | 126 | 124 | 131 | 131 | 139 | 128 | 151 |
| Active | 0.50 | Fixed | 76 | 67 | 77 | 83 | 87 | 76 | 90 |
| Active | 0.50 | Grows | 76 | 76 | 78 | 84 | 90 | 76 | 93 |
| Active | 0.50 | Shrinks | 67 | 65 | 76 | 81 | 86 | 76 | 87 |
| Active | 1.00 | Fixed | 35 | 35 | 38 | 46 | 50 | 36 | 50 |
| Active | 1.00 | Grows | 36 | 36 | 39 | 49 | 50 | 37 | 51 |
| Active | 1.00 | Shrinks | 35 | 35 | 38 | 45 | 50 | 36 | 50 |
| Dead | 0.25 | Fixed | 173 | 174 | 192 | 192 | 209 | 176 | 207 |
| Dead | 0.25 | Grows | 179 | 179 | 200 | 203 | 224 | 182 | 211 |
| Dead | 0.25 | Shrinks | 167 | 168 | 185 | 182 | 199 | 170 | 196 |
| Dead | 0.50 | Fixed | 85 | 87 | 95 | 103 | 113 | 88 | 113 |
| Dead | 0.50 | Grows | 86 | 88 | 97 | 106 | 116 | 90 | 116 |
| Dead | 0.50 | Shrinks | 84 | 86 | 94 | 100 | 110 | 87 | 110 |
| Dead | 1.00 | Fixed | 42 | 43 | 47 | 55 | 60 | 44 | 60 |
| Dead | 1.00 | Grows | 42 | 44 | 47 | 55 | 61 | 44 | 61 |
| Dead | 1.00 | Shrinks | 42 | 43 | 46 | 54 | 59 | 43 | 59 |

A higher k brings the target forward because organic volume, and the LP inflow that scales with it, arrive sooner. A shrinking reference lowers the target and graduation moves a few days earlier. A growing reference does the opposite. The ordering of the variants barely changes.

Day-365 TVL at k = 0.25 stays in the hundreds of thousands. At k = 0.5 the Dutch books end in the millions and BASE and REV end near $400k on the active fixed path. At k = 1 the Dutch books end in the hundreds of billions and BASE ends near $3M. That gap opens after graduation, when inflow is a fraction of daily volume and daily volume is a fraction of TVL. A book that is larger on day 90 compounds away from one that is smaller. It is the inflow assumption showing up, and it should not be read as a forecast of pool size.

## Full grid

Anchor at day 365 is 1.0173 on every active row and 1.0006 on every dead row. Morpho is the year's credited yield. "On" is status at day 365.

### Active

#### k = 0.25, reference fixed

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | COMBO | 130 | yes | $325.2k | $3 | $96 | 30 | 2.00% | $1.8k | $49 / 38d | $97 / 31d | $89 / 25d | $951 / 270d |
| 4 | COMBO-alt | 137 | yes | $267.1k | $3 | $0 | 0 | 2.00% | $1.5k | $0 / 42d ≤0 | $0 / 34d ≤0 | $27 / 22d | $942 / 267d |
| 5 | BASE | 138 | yes | $161.8k | -$2 | $88 | 39 | 0.56% | $831 | -$58 / 39d ≤0 | -$152 / 31d ≤0 | -$159 / 25d ≤0 | -$511 / 269d ≤0 |
| 7 | REV | 163 | yes | $157.3k | -$2 | $65 | 30 | 0.45% | $813 | $18 / 43d | -$92 / 34d ≤0 | -$108 / 25d ≤0 | -$467 / 262d ≤0 |
| 3 | DUTCH | 130 | yes | $324.5k | $0.92 | $98 | 30 | 1.02% | $1.6k | -$221 / 39d ≤0 | -$16 / 34d ≤0 | $32 / 23d | $541 / 269d |
| 6 | DRIP | 162 | yes | $240.2k | -$1 | $77 | 30 | 0.42% | $2.0k | $25 / 44d | -$80 / 33d ≤0 | -$110 / 28d ≤0 | -$310 / 260d ≤0 |
| 1 | DUTCH+BASE | 128 | yes | $347.5k | $0.70 | $119 | 34 | 1.00% | $1.9k | $0 / 38d ≤0 | $0 / 28d ≤0 | $0 / 25d ≤0 | $254 / 274d |

TVL on the way: COMBO $1.5k / $5.9k / $47.5k at days 7 / 30 / 90. DUTCH+BASE $1.4k / $5.9k / $51.0k. BASE $1.3k / $5.7k / $46.1k.

#### k = 0.25, reference grows to $1M

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | COMBO | 136 | yes | $358.0k | $3 | $105 | 30 | 2.00% | $1.9k | $51 / 39d | $109 / 34d | $83 / 23d | $945 / 268d |
| 4 | COMBO-alt | 138 | yes | $298.8k | $3 | $0 | 0 | 2.00% | $1.6k | $0 / 43d ≤0 | $0 / 34d ≤0 | $22 / 23d | $935 / 265d |
| 5 | BASE | 139 | yes | $184.9k | -$3 | $100 | 39 | 0.60% | $911 | -$58 / 40d ≤0 | -$174 / 33d ≤0 | -$283 / 24d ≤0 | -$491 / 268d ≤0 |
| 6 | REV | 167 | yes | $179.1k | -$2 | $73 | 30 | 0.47% | $875 | $15 / 45d | -$80 / 35d ≤0 | -$110 / 27d ≤0 | -$453 / 259d ≤0 |
| 3 | DUTCH | 137 | yes | $359.2k | $0.94 | $107 | 30 | 1.02% | $1.8k | -$222 / 40d ≤0 | -$13 / 35d ≤0 | $32 / 22d | $545 / 268d |
| 7 | DRIP | 169 | yes | $275.2k | -$1 | $87 | 30 | 0.43% | $2.2k | $24 / 45d | -$100 / 34d ≤0 | -$136 / 30d ≤0 | -$257 / 256d ≤0 |
| 1 | DUTCH+BASE | 130 | yes | $382.2k | $0.69 | $130 | 34 | 1.00% | $2.1k | $0 / 39d ≤0 | $0 / 31d ≤0 | $0 / 25d ≤0 | $253 / 271d |

#### k = 0.25, reference shrinks to $500k

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | COMBO | 126 | yes | $300.2k | $3 | $89 | 30 | 2.00% | $1.6k | $48 / 38d | $90 / 29d | $86 / 25d | $965 / 274d |
| 4 | COMBO-alt | 131 | yes | $244.9k | $3 | $0 | 0 | 2.00% | $1.4k | $0 / 41d ≤0 | $0 / 34d ≤0 | $32 / 22d | $944 / 268d |
| 5 | BASE | 131 | yes | $146.3k | -$2 | $80 | 39 | 0.55% | $785 | -$58 / 38d ≤0 | -$121 / 29d ≤0 | -$158 / 26d ≤0 | -$531 / 271d ≤0 |
| 6 | REV | 139 | yes | $140.7k | -$2 | $59 | 30 | 0.45% | $731 | $20 / 42d | -$77 / 34d ≤0 | -$82 / 24d ≤0 | -$496 / 265d ≤0 |
| 3 | DUTCH | 128 | yes | $298.6k | $0.90 | $91 | 30 | 1.02% | $1.5k | -$221 / 39d ≤0 | -$20 / 31d ≤0 | $32 / 24d | $538 / 270d |
| 7 | DRIP | 151 | yes | $210.3k | -$1 | $68 | 30 | 0.42% | $1.8k | $26 / 43d | -$69 / 33d ≤0 | -$77 / 26d ≤0 | -$339 / 263d ≤0 |
| 1 | DUTCH+BASE | 124 | yes | $320.7k | $0.72 | $110 | 34 | 1.00% | $1.7k | $0 / 38d ≤0 | $0 / 27d ≤0 | $0 / 24d ≤0 | $261 / 276d |

#### k = 0.5, reference fixed

Shown in full above. Days 7 / 30 / 90 TVL: COMBO $1.5k / $11.7k / $119.7k, COMBO-alt $1.3k / $9.5k / $111.1k, DUTCH+BASE $1.4k / $11.5k / $121.1k, BASE $1.3k / $10.2k / $93.7k.

#### k = 0.5, reference grows to $1M

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | COMBO | 76 | yes | $9.88M | $3 | $2.4k | 30 | 2.00% | $26.9k | $22 / 26d | $43 / 14d | $44 / 13d | $1.0k / 312d |
| 4 | COMBO-alt | 78 | yes | $6.32M | $3 | $0 | 0 | 2.00% | $18.5k | $0 / 29d ≤0 | $0 / 15d ≤0 | $16 / 13d | $1.0k / 308d |
| 5 | BASE | 84 | yes | $471.6k | -$3 | $330 | 32 | 0.54% | $2.1k | -$70 / 28d ≤0 | -$238 / 15d ≤0 | -$320 / 14d ≤0 | -$343 / 308d ≤0 |
| 6 | REV | 90 | yes | $448.1k | -$2 | $292 | 30 | 0.49% | $2.1k | $12 / 31d | -$110 / 17d ≤0 | -$189 / 14d ≤0 | -$385 / 303d ≤0 |
| 3 | DUTCH | 76 | yes | $9.26M | $0.99 | $2.3k | 30 | 1.02% | $25.3k | -$151 / 28d ≤0 | -$7 / 14d ≤0 | $12 / 12d | $505 / 311d |
| 7 | DRIP | 93 | yes | $1.53M | -$85 | $579 | 30 | 0.48% | $8.6k | $20 / 31d | -$108 / 17d ≤0 | -$191 / 14d ≤0 | -$30.9k / 303d ≤0 |
| 1 | DUTCH+BASE | 76 | yes | $10.08M | $0.38 | $2.5k | 30 | 1.00% | $27.4k | $0 / 27d ≤0 | $0 / 13d ≤0 | $0 / 12d ≤0 | $139 / 313d |

#### k = 0.5, reference shrinks to $500k

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | COMBO | 67 | yes | $8.85M | $3 | $2.2k | 30 | 2.00% | $24.1k | $20 / 25d | $41 / 14d | $41 / 12d | $1.0k / 314d |
| 4 | COMBO-alt | 76 | yes | $5.67M | $3 | $0 | 0 | 2.00% | $16.6k | $0 / 28d ≤0 | $0 / 14d ≤0 | $12 / 12d | $1.0k / 311d |
| 5 | BASE | 81 | yes | $413.9k | -$3 | $290 | 32 | 0.53% | $1.9k | -$93 / 28d ≤0 | -$146 / 14d ≤0 | -$199 / 13d ≤0 | -$560 / 310d ≤0 |
| 6 | REV | 86 | yes | $393.1k | -$3 | $256 | 30 | 0.48% | $1.8k | $13 / 30d | -$107 / 17d ≤0 | -$186 / 13d ≤0 | -$664 / 305d ≤0 |
| 3 | DUTCH | 76 | yes | $8.29M | $0.98 | $2.1k | 30 | 1.02% | $22.6k | -$149 / 27d ≤0 | -$10 / 14d ≤0 | $12 / 12d | $504 / 312d |
| 7 | DRIP | 87 | yes | $1.40M | -$90 | $530 | 30 | 0.48% | $7.9k | $21 / 30d | -$105 / 17d ≤0 | -$180 / 14d ≤0 | -$32.7k / 304d ≤0 |
| 1 | DUTCH+BASE | 65 | yes | $9.01M | $0.39 | $2.2k | 30 | 1.00% | $24.5k | $0 / 26d ≤0 | $0 / 13d ≤0 | $0 / 12d ≤0 | $143 / 314d |

#### k = 1, reference fixed

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 35 | yes | $429.26B | $3 | $69.76M | 30 | 2.00% | $375.10M | $4 / 16d | $19 / 6d | $18 / 6d | $996 / 337d |
| 4 | COMBO-alt | 38 | yes | $161.13B | $3 | $0 | 0 | 2.00% | $148.72M | $0 / 18d ≤0 | $0 / 6d ≤0 | $3 / 6d | $991 / 335d |
| 5 | BASE | 46 | yes | $3.06M | $132 | $2.5k | 30 | 0.59% | $8.5k | -$115 / 18d ≤0 | -$249 / 7d ≤0 | -$313 / 7d ≤0 | $48.8k / 333d |
| 7 | REV | 50 | yes | $2.94M | $125 | $2.4k | 30 | 0.57% | $8.2k | $44 / 20d | -$127 / 8d ≤0 | -$212 / 7d ≤0 | $45.9k / 330d |
| 3 | DUTCH | 36 | yes | $374.40B | $0.49 | $61.15M | 30 | 1.02% | $328.82M | -$63 / 17d ≤0 | -$7 / 6d ≤0 | $3 / 6d | $244 / 336d |
| 6 | DRIP | 50 | yes | $20.70M | $187 | $10.2k | 30 | 0.64% | $68.1k | $47 / 20d | -$110 / 8d ≤0 | -$224 / 7d ≤0 | $68.6k / 330d |
| 2 | DUTCH+BASE | 35 | yes | $423.81B | -$0.40 | $68.88M | 30 | 1.00% | $370.33M | $0 / 17d ≤0 | $0 / 6d ≤0 | $0 / 5d ≤0 | -$146 / 337d ≤0 |

Days 7 / 30 / 90: COMBO $1.6k / $62.5k / $1.02M, BASE $1.3k / $42.0k / $145.0k. COMBO's year-end profit is still about $3 a day. The billions are the LP inflow compounding on a larger day-90 book. DUTCH+BASE ties the graduation day and then loses money in the last bucket as well as earning nothing before it. BASE's year-average profit turns positive here, and the first three buckets are still losses.

#### k = 1, reference grows to $1M

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 36 | yes | $438.15B | $3 | $71.21M | 30 | 2.00% | $382.87M | $4 / 16d | $21 / 7d | $17 / 5d | $996 / 337d |
| 4 | COMBO-alt | 39 | yes | $165.49B | $3 | $0 | 0 | 2.00% | $152.75M | $0 / 18d ≤0 | $0 / 7d ≤0 | $3 / 5d | $991 / 335d |
| 5 | BASE | 49 | yes | $3.18M | $140 | $2.6k | 30 | 0.59% | $8.8k | -$119 / 18d ≤0 | -$250 / 7d ≤0 | -$318 / 7d ≤0 | $51.8k / 333d |
| 6 | REV | 50 | yes | $3.08M | $134 | $2.5k | 30 | 0.57% | $8.6k | $44 / 20d | -$125 / 8d ≤0 | -$181 / 7d ≤0 | $49.2k / 329d |
| 3 | DUTCH | 37 | yes | $382.40B | $0.49 | $62.45M | 30 | 1.02% | $335.84M | -$63 / 17d ≤0 | -$8 / 7d ≤0 | $4 / 5d | $244 / 336d |
| 7 | DRIP | 51 | yes | $21.13M | $212 | $10.4k | 30 | 0.64% | $69.4k | $47 / 20d | -$122 / 8d ≤0 | -$178 / 8d ≤0 | $77.5k / 329d |
| 2 | DUTCH+BASE | 36 | yes | $433.37B | -$0.40 | $70.43M | 30 | 1.00% | $378.69M | $0 / 17d ≤0 | $0 / 6d ≤0 | $0 / 5d ≤0 | -$147 / 336d ≤0 |

#### k = 1, reference shrinks to $500k

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 35 | yes | $422.08B | $3 | $68.60M | 30 | 2.00% | $368.82M | $4 / 16d | $18 / 6d | $19 / 6d | $996 / 337d |
| 4 | COMBO-alt | 38 | yes | $157.83B | $3 | $0 | 0 | 2.00% | $145.68M | $0 / 18d ≤0 | $0 / 6d ≤0 | $4 / 6d | $991 / 335d |
| 5 | BASE | 45 | yes | $2.94M | $123 | $2.4k | 30 | 0.59% | $8.2k | -$115 / 18d ≤0 | -$250 / 7d ≤0 | -$309 / 7d ≤0 | $45.5k / 333d |
| 7 | REV | 50 | yes | $2.86M | $119 | $2.3k | 30 | 0.57% | $8.0k | $43 / 20d | -$115 / 8d ≤0 | -$183 / 7d ≤0 | $43.7k / 330d |
| 3 | DUTCH | 36 | yes | $368.27B | $0.49 | $60.14M | 30 | 1.02% | $323.43M | -$63 / 17d ≤0 | -$8 / 6d ≤0 | $4 / 6d | $244 / 336d |
| 6 | DRIP | 50 | yes | $20.04M | $164 | $9.9k | 30 | 0.63% | $66.0k | $46 / 20d | -$123 / 8d ≤0 | -$230 / 7d ≤0 | $60.1k / 330d |
| 2 | DUTCH+BASE | 35 | yes | $417.10B | -$0.40 | $67.79M | 30 | 1.00% | $364.47M | $0 / 17d ≤0 | $0 / 6d ≤0 | $0 / 5d ≤0 | -$146 / 337d ≤0 |

### Dead

The dead base is $150 a day and the anchor moves 0.1% a day. COMBO's 0–10% bucket is negative on every dead row.

#### k = 0.25, reference fixed

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 173 | yes | $252.8k | $2 | $72 | 30 | 2.00% | $1.4k | -$151 / 75d ≤0 | $94 / 30d | $87 / 26d | $817 / 234d |
| 4 | COMBO-alt | 192 | yes | $196.8k | $2 | $0 | 0 | 2.00% | $1.1k | $0 / 91d ≤0 | $0 / 32d ≤0 | $37 / 26d | $752 / 216d |
| 5 | BASE | 192 | yes | $139.3k | -$2 | $75 | 41 | 0.61% | $613 | -$104 / 81d ≤0 | -$161 / 29d ≤0 | -$187 / 27d ≤0 | -$419 / 228d ≤0 |
| 7 | REV | 209 | yes | $132.5k | -$2 | $50 | 30 | 0.44% | $559 | -$35 / 90d ≤0 | -$70 / 32d ≤0 | -$97 / 30d ≤0 | -$432 / 213d ≤0 |
| 3 | DUTCH | 176 | yes | $251.8k | -$0.25 | $74 | 30 | 1.05% | $1.3k | -$547 / 77d ≤0 | -$9 / 31d ≤0 | $25 / 25d | $439 / 232d |
| 6 | DRIP | 207 | yes | $186.3k | -$1 | $56 | 30 | 0.41% | $1.4k | -$32 / 90d ≤0 | -$74 / 33d ≤0 | -$84 / 29d ≤0 | -$259 / 213d ≤0 |
| 2 | DUTCH+BASE | 174 | yes | $252.7k | $0.57 | $89 | 37 | 1.00% | $1.3k | $0 / 81d ≤0 | $0 / 28d ≤0 | $0 / 24d ≤0 | $209 / 232d |

#### k = 0.25, reference grows to $1M

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | COMBO | 179 | yes | $288.7k | $2 | $82 | 30 | 2.00% | $1.5k | -$146 / 77d ≤0 | $98 / 31d | $91 / 27d | $805 / 231d |
| 4 | COMBO-alt | 200 | yes | $229.1k | $2 | $0 | 0 | 2.00% | $1.2k | $0 / 94d ≤0 | $0 / 32d ≤0 | $39 / 28d | $733 / 211d |
| 5 | BASE | 203 | yes | $163.4k | -$2 | $86 | 41 | 0.63% | $665 | -$104 / 83d ≤0 | -$164 / 30d ≤0 | -$192 / 27d ≤0 | -$373 / 225d ≤0 |
| 7 | REV | 224 | yes | $157.6k | -$2 | $58 | 30 | 0.45% | $610 | -$49 / 92d ≤0 | -$86 / 34d ≤0 | -$89 / 30d ≤0 | -$365 / 209d ≤0 |
| 3 | DUTCH | 182 | yes | $290.1k | -$0.24 | $83 | 30 | 1.05% | $1.5k | -$547 / 79d ≤0 | -$5 / 31d ≤0 | $32 / 27d | $432 / 228d |
| 6 | DRIP | 211 | yes | $217.9k | -$1 | $64 | 30 | 0.42% | $1.5k | -$43 / 92d ≤0 | -$73 / 34d ≤0 | -$81 / 30d ≤0 | -$199 / 209d ≤0 |
| 1 | DUTCH+BASE | 179 | yes | $290.5k | $0.55 | $101 | 37 | 1.00% | $1.5k | $0 / 83d ≤0 | $0 / 29d ≤0 | $0 / 25d ≤0 | $201 / 228d |

#### k = 0.25, reference shrinks to $500k

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 167 | yes | $224.7k | $2 | $65 | 30 | 2.00% | $1.2k | -$155 / 73d ≤0 | $92 / 29d | $80 / 24d | $833 / 238d |
| 5 | COMBO-alt | 185 | yes | $172.4k | $2 | $0 | 0 | 2.00% | $943 | $0 / 89d ≤0 | $0 / 31d ≤0 | $35 / 26d | $766 / 219d |
| 4 | BASE | 182 | yes | $121.5k | -$3 | $66 | 41 | 0.60% | $554 | -$89 / 79d ≤0 | -$161 / 29d ≤0 | -$171 / 25d ≤0 | -$506 / 232d ≤0 |
| 7 | REV | 199 | yes | $114.2k | -$2 | $44 | 30 | 0.42% | $503 | -$33 / 88d ≤0 | -$61 / 32d ≤0 | -$116 / 27d ≤0 | -$444 / 217d ≤0 |
| 3 | DUTCH | 170 | yes | $223.8k | -$0.27 | $66 | 30 | 1.05% | $1.1k | -$543 / 75d ≤0 | -$13 / 30d ≤0 | $21 / 25d | $437 / 235d |
| 6 | DRIP | 196 | yes | $162.3k | -$5 | $49 | 30 | 0.41% | $1.2k | -$30 / 88d ≤0 | -$61 / 32d ≤0 | -$110 / 28d ≤0 | -$1.5k / 217d ≤0 |
| 2 | DUTCH+BASE | 168 | yes | $224.8k | $0.58 | $79 | 36 | 1.00% | $1.2k | $0 / 79d ≤0 | $0 / 28d ≤0 | $0 / 23d ≤0 | $211 / 235d |

#### k = 0.5, reference fixed

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 85 | yes | $6.34M | $3 | $1.6k | 30 | 2.00% | $17.9k | -$123 / 41d ≤0 | $43 / 14d | $42 / 12d | $980 / 298d |
| 4 | COMBO-alt | 95 | yes | $3.65M | $3 | $0 | 0 | 2.00% | $11.2k | $0 / 50d ≤0 | $0 / 15d ≤0 | $15 / 13d | $941 / 287d |
| 5 | BASE | 103 | yes | $365.1k | -$3 | $260 | 32 | 0.54% | $1.6k | -$116 / 47d ≤0 | -$252 / 15d ≤0 | -$220 / 13d ≤0 | -$644 / 290d ≤0 |
| 7 | REV | 113 | yes | $345.9k | -$2 | $226 | 30 | 0.47% | $1.5k | -$41 / 52d ≤0 | -$101 / 17d ≤0 | -$139 / 14d ≤0 | -$574 / 282d ≤0 |
| 3 | DUTCH | 88 | yes | $5.75M | $0.52 | $1.5k | 30 | 1.04% | $16.4k | -$272 / 44d ≤0 | -$9 / 14d ≤0 | $15 / 13d | $455 / 294d |
| 6 | DRIP | 113 | yes | $1.07M | -$77 | $407 | 30 | 0.47% | $6.0k | -$38 / 52d ≤0 | -$95 / 17d ≤0 | -$147 / 14d ≤0 | -$27.8k / 282d ≤0 |
| 2 | DUTCH+BASE | 87 | yes | $6.16M | $0.30 | $1.6k | 30 | 1.00% | $17.4k | $0 / 45d ≤0 | $0 / 14d ≤0 | $0 / 11d ≤0 | $111 / 295d |

#### k = 0.5, reference grows to $1M

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 86 | yes | $6.76M | $3 | $1.7k | 30 | 2.00% | $19.1k | -$123 / 41d ≤0 | $47 / 15d | $42 / 12d | $977 / 297d |
| 4 | COMBO-alt | 97 | yes | $3.92M | $3 | $0 | 0 | 2.00% | $12.0k | $0 / 51d ≤0 | $0 / 15d ≤0 | $15 / 13d | $938 / 286d |
| 5 | BASE | 106 | yes | $398.2k | -$3 | $283 | 32 | 0.54% | $1.8k | -$126 / 48d ≤0 | -$244 / 15d ≤0 | -$220 / 13d ≤0 | -$526 / 289d ≤0 |
| 7 | REV | 116 | yes | $380.5k | -$2 | $248 | 30 | 0.47% | $1.7k | -$40 / 53d ≤0 | -$109 / 17d ≤0 | -$174 / 15d ≤0 | -$526 / 280d ≤0 |
| 3 | DUTCH | 90 | yes | $6.15M | $0.52 | $1.6k | 30 | 1.04% | $17.5k | -$272 / 44d ≤0 | -$9 / 15d ≤0 | $16 / 13d | $455 / 293d |
| 6 | DRIP | 116 | yes | $1.17M | -$78 | $442 | 30 | 0.47% | $6.5k | -$38 / 53d ≤0 | -$126 / 17d ≤0 | -$168 / 15d ≤0 | -$28.1k / 280d ≤0 |
| 2 | DUTCH+BASE | 88 | yes | $6.57M | $0.30 | $1.7k | 30 | 1.00% | $18.6k | $0 / 46d ≤0 | $0 / 13d ≤0 | $0 / 12d ≤0 | $110 / 294d |

#### k = 0.5, reference shrinks to $500k

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 84 | yes | $6.01M | $3 | $1.5k | 30 | 2.00% | $17.0k | -$126 / 40d ≤0 | $43 / 14d | $42 / 12d | $984 / 299d |
| 4 | COMBO-alt | 94 | yes | $3.44M | $3 | $0 | 0 | 2.00% | $10.6k | $0 / 50d ≤0 | $0 / 14d ≤0 | $14 / 13d | $945 / 288d |
| 5 | BASE | 100 | yes | $339.7k | -$4 | $242 | 32 | 0.53% | $1.5k | -$116 / 47d ≤0 | -$218 / 14d ≤0 | -$263 / 13d ≤0 | -$781 / 291d ≤0 |
| 7 | REV | 110 | yes | $319.9k | -$3 | $210 | 30 | 0.47% | $1.4k | -$42 / 52d ≤0 | -$87 / 16d ≤0 | -$155 / 14d ≤0 | -$831 / 283d ≤0 |
| 3 | DUTCH | 87 | yes | $5.44M | $0.50 | $1.4k | 30 | 1.04% | $15.5k | -$274 / 43d ≤0 | -$12 / 15d ≤0 | $13 / 12d | $455 / 295d |
| 6 | DRIP | 110 | yes | $979.8k | -$68 | $372 | 30 | 0.46% | $5.5k | -$38 / 52d ≤0 | -$86 / 16d ≤0 | -$149 / 14d ≤0 | -$24.5k / 283d ≤0 |
| 2 | DUTCH+BASE | 86 | yes | $5.84M | $0.30 | $1.5k | 30 | 1.00% | $16.5k | $0 / 45d ≤0 | $0 / 13d ≤0 | $0 / 11d ≤0 | $111 / 296d |

#### k = 1, reference fixed

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 42 | yes | $247.41B | $3 | $41.22M | 30 | 2.00% | $223.52M | -$76 / 22d ≤0 | $21 / 7d | $16 / 5d | $988 / 331d |
| 4 | COMBO-alt | 47 | yes | $85.32B | $3 | $0 | 0 | 2.00% | $81.32M | $0 / 26d ≤0 | $0 / 7d ≤0 | $4 / 6d | $962 / 326d |
| 5 | BASE | 55 | yes | $2.70M | $111 | $2.2k | 30 | 0.59% | $7.7k | -$171 / 26d ≤0 | -$359 / 8d ≤0 | -$400 / 7d ≤0 | $41.6k / 324d |
| 7 | REV | 60 | yes | $2.55M | $104 | $2.1k | 30 | 0.57% | $7.3k | $2 / 29d | -$110 / 9d ≤0 | -$87 / 7d ≤0 | $38.0k / 320d |
| 3 | DUTCH | 44 | yes | $211.77B | $0.21 | $35.44M | 30 | 1.03% | $192.24M | -$148 / 23d ≤0 | -$8 / 7d ≤0 | $5 / 6d | $227 / 329d |
| 6 | DRIP | 60 | yes | $16.78M | $62 | $8.3k | 30 | 0.62% | $54.8k | $7 / 29d | -$105 / 9d ≤0 | -$83 / 7d ≤0 | $22.7k / 320d |
| 2 | DUTCH+BASE | 43 | yes | $230.77B | -$0.41 | $38.45M | 30 | 1.00% | $208.49M | $0 / 24d ≤0 | $0 / 7d ≤0 | $0 / 5d ≤0 | -$150 / 329d ≤0 |

#### k = 1, reference grows to $1M

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 42 | yes | $255.08B | $3 | $42.50M | 30 | 2.00% | $230.46M | -$76 / 22d ≤0 | $21 / 7d | $16 / 5d | $988 / 331d |
| 4 | COMBO-alt | 47 | yes | $88.07B | $3 | $0 | 0 | 2.00% | $83.93M | $0 / 27d ≤0 | $0 / 7d ≤0 | $5 / 5d | $960 / 325d |
| 5 | BASE | 55 | yes | $2.82M | $119 | $2.3k | 30 | 0.59% | $8.1k | -$199 / 27d ≤0 | -$332 / 7d ≤0 | -$309 / 7d ≤0 | $44.3k / 324d |
| 7 | REV | 61 | yes | $2.68M | $113 | $2.2k | 30 | 0.57% | $7.7k | $5 / 30d | -$109 / 8d ≤0 | -$71 / 7d ≤0 | $41.4k / 320d |
| 3 | DUTCH | 44 | yes | $218.45B | $0.22 | $36.56M | 30 | 1.03% | $198.30M | -$147 / 24d ≤0 | -$6 / 7d ≤0 | $4 / 5d | $228 / 329d |
| 6 | DRIP | 61 | yes | $17.95M | $118 | $8.9k | 30 | 0.63% | $59.0k | $5 / 30d | -$101 / 8d ≤0 | -$67 / 7d ≤0 | $43.3k / 320d |
| 2 | DUTCH+BASE | 44 | yes | $238.42B | -$0.41 | $39.72M | 30 | 1.00% | $215.40M | $0 / 24d ≤0 | $0 / 7d ≤0 | $0 / 5d ≤0 | -$150 / 329d ≤0 |

#### k = 1, reference shrinks to $500k

| Rank | Variant | Grad day | On | TVL 365 | Profit/day | Fees/day | Eff bps | Gap | Morpho | 0–10% | 10–30% | 30–60% | 60–100% |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | COMBO | 42 | yes | $241.15B | $3 | $40.17M | 30 | 2.00% | $217.87M | -$76 / 22d ≤0 | $20 / 7d | $17 / 5d | $988 / 331d |
| 4 | COMBO-alt | 46 | yes | $82.79B | $3 | $0 | 0 | 2.00% | $78.91M | $0 / 26d ≤0 | $0 / 7d ≤0 | $7 / 6d | $962 / 326d |
| 5 | BASE | 54 | yes | $2.60M | $105 | $2.2k | 30 | 0.59% | $7.4k | -$165 / 26d ≤0 | -$364 / 8d ≤0 | -$346 / 6d ≤0 | $39.1k / 325d |
| 7 | REV | 59 | yes | $2.45M | $97 | $2.0k | 30 | 0.57% | $7.0k | $2 / 29d | -$95 / 8d ≤0 | -$97 / 8d ≤0 | $35.5k / 320d |
| 3 | DUTCH | 43 | yes | $206.48B | $0.21 | $34.56M | 30 | 1.03% | $187.43M | -$147 / 23d ≤0 | -$9 / 7d ≤0 | $5 / 6d | $227 / 329d |
| 6 | DRIP | 59 | yes | $16.15M | $21 | $8.0k | 30 | 0.62% | $52.8k | $6 / 29d | -$108 / 9d ≤0 | -$76 / 7d ≤0 | $7.7k / 320d |
| 2 | DUTCH+BASE | 43 | yes | $224.52B | -$0.41 | $37.40M | 30 | 1.00% | $202.84M | $0 / 24d ≤0 | $0 / 7d ≤0 | $0 / 5d ≤0 | -$149 / 329d ≤0 |

## What this does not change

The hook's swap fee is still `BridgeFee.baseFeeBps`. The simulator can override that bps through `quoteFeeSet` on the curve context. Production leaves the flag unset, and the progress slide applies. Runtime size after that override: DiscipleHook 16,168 bytes (margin 8,408), DiscipleLpFacet 22,006 (margin 2,570), DiscipleAdminFacet 15,087 (margin 9,489), DiscipleSwapFacet 13,742 (margin 10,834), DiscipleEngine 13,666 (margin 10,910), V4SlotReader 635 (margin 23,941). `test_runtimeFitsEip170` passed.

Nothing here is deployed. The testnet command is in `contracts/script/bridge/README.md`. It has not been run.
