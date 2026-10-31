---
title: The bonding curve
slug: /docs/curve
section: Bonding curve and ascension
---
# The bonding curve

Every rocket starts on its own bonding curve. The curve is the market: you BOOST and DUMP against it, and a formula sets the price.

## In one paragraph

The rocket starts at a **$3,333** market cap. Each coin sold costs a little more than the last. When **84%** of supply has sold, the market cap is exactly **$33,333** and the rocket ascends to Uniswap v4. DUMPs move it back down the same curve.

## The numbers

| | |
|---|---|
| Total supply | 1,000,000 (fixed, 18 decimals) |
| Sold on the curve | 84.24% (842,400) |
| Start market cap | $3,333 |
| Ascension market cap | $33,333 |
| Kept for the Uniswap pool | 15.76% (157,600) |

## How the price moves

| Share of supply sold | Market cap | Base raised (net of fees) |
|---|---|---|
| 0% | $3,333 | $0 |
| 10% | ≈ $3,794 | ≈ $356 |
| 25% | ≈ $4,689 | ≈ $988 |
| 50% | ≈ $7,078 | ≈ $2,428 |
| 75% | ≈ $12,456 | ≈ $4,736 |
| 84.24% | $33,333 | ≈ $6,455 |

Values assume a $1 base (USDG). With another base, the same shape applies in that base, converted at launch. Gross BOOSTs to ascend are higher once fees are included.

## The formula

The curve is a constant-product market with virtual reserves, like pump.fun's, plus a steep finish near ascension.

- Reserves: base `x`, rocket `y`, with `x · y = k`, starting at `x₀ · y₀`.
- Share of the curve sold: `g = s / s_curve`, with `s_curve = 84.24%` of supply.
- Market cap: `M(s) = M₀ · (y₀ / (y₀ − s))² + T · g³⁰`, with `M₀ = $3,333` and `T = $18,333`.
- `y₀` is fitted so the constant-product part reaches `$15,000` at `s = s_curve`: `y₀ = s_curve · √r / (√r − 1)`, with `r = 15,000/3,333`. The `T · g³⁰` term adds the last `$18,333`, so `M` reaches exactly `$33,333` at ascension.
- Spot price: `p(s) = M(s) / 1,000,000`.
- A BOOST of `dx` base returns the most coins whose cost on the curve is at most `dx`. A DUMP of `dy` coins returns their cost on the curve. Both round against the trader.

## Quotes are exact

The app's quote for a curve trade is exact for the current block, including fees and the anti-snipe fee. Your minimum amount out protects you if the price moves first.
