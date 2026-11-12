---
title: The starting price path
slug: /docs/curve
section: The starting price path
---
# The starting price path

Every rocket starts on its own price path. People also call this a bonding curve. You buy with BOOST and sell with DUMP against that path, and a formula sets the price.

## In one paragraph

The rocket starts at a value of **$3,333**. Each bit you buy costs a little more than the last. When **about 84%** of it has been bought, the value is **$33,333** and the rocket reaches orbit. That means the starting price path is finished and the rocket moves to the open market on Uniswap. A DUMP moves it back down the same path.

![The starting price path: the value starts at $3,333, climbs slowly at first, then steeply near the end, and reaches orbit at $33,333 when about 84% of the rocket has been bought.](/illustrations/docs/price-path.svg)

## The numbers

| | |
|---|---|
| Total supply | 1,000,000 (fixed, 18 decimals) |
| Sold on the curve | 84.24% (842,400) |
| Value at the start | $3,333 |
| Value when the rocket reaches orbit | $33,333 |
| Kept for the Uniswap pool | 15.76% (157,600) |

## How the price moves

| Share of supply sold | Value | Base raised (net of fees) |
|---|---|---|
| 0% | $3,333 | $0 |
| 10% | ≈ $3,794 | ≈ $356 |
| 25% | ≈ $4,689 | ≈ $988 |
| 50% | ≈ $7,078 | ≈ $2,428 |
| 75% | ≈ $12,456 | ≈ $4,736 |
| 84.24% | $33,333 | ≈ $6,455 |

Values assume a $1 base (USDG). With another base, the same shape applies in that base, converted at launch. The amount you pay to reach orbit is higher once fees are included.

## For the curious: the formula

You don't need this to play. It's here so anyone can check the math. The path works like pump.fun's, with a steeper finish near orbit.

- Reserves: base `x`, rocket `y`, with `x · y = k`, starting at `x₀ · y₀`.
- Share of the curve sold: `g = s / s_curve`, with `s_curve = 84.24%` of supply.
- Value: `M(s) = M₀ · (y₀ / (y₀ − s))² + T · g³⁰`, with `M₀ = $3,333` and `T = $18,333`.
- `y₀` is fitted so the constant-product part reaches `$15,000` at `s = s_curve`: `y₀ = s_curve · √r / (√r − 1)`, with `r = 15,000/3,333`. The `T · g³⁰` term adds the last `$18,333`, so `M` reaches exactly `$33,333` when the rocket reaches orbit.
- Spot price: `p(s) = M(s) / 1,000,000`.
- A BOOST of `dx` base returns the most of the rocket whose cost on this path is at most `dx`. A DUMP of `dy` of the rocket returns what that amount costs on this path. Both round against the trader.

## Quotes are exact

The app's quote for a curve trade is exact for the current block, including fees and the anti-snipe fee. Your minimum amount out protects you if the price moves first.
