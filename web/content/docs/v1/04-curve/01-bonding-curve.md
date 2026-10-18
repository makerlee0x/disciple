---
title: The bonding curve
slug: /docs/curve
section: Bonding curve and graduation
---
# The bonding curve

Every rocket starts on its own bonding curve. The curve is the market: you BOOST and DUMP against it, and a formula sets the price.

## In one paragraph

The rocket starts at a **$7K** market cap. Each coin sold costs a little more than the last. When **72%** of supply has sold, the market cap is exactly **$33K** and the rocket graduates to Uniswap v4. DUMPs move it back down the same curve.

## The numbers

| | |
|---|---|
| Total supply | 7,000,000,000 (fixed, 18 decimals) |
| Sold on the curve | 72% (5.04B) |
| Start market cap | $7,000 |
| Graduation market cap | $33,000 |
| Kept for the Uniswap pool | 28% (1.96B) |

## How the price moves

| Share of supply sold | Market cap | Base raised (net of fees) |
|---|---|---|
| 0% | $7,000 | $0 |
| 10% | ≈ $8,180 | ≈ $757 |
| 25% | ≈ $10,598 | ≈ $2,153 |
| 50% | ≈ $17,897 | ≈ $5,596 |
| 72% | $33,000 | ≈ $10,943 |

Values assume a $1 base (USDG). With another base, the same shape applies in that base, converted at launch. Gross BOOSTs to graduate are higher once fees are included.

## The formula

The curve is a constant-product market with virtual reserves, like pump.fun's.

- Reserves: base `x`, rocket `y`, with `x · y = k`, starting at `x₀ · y₀`.
- Spot price after `s` coins sold: `p(s) = x₀·y₀ / (y₀ − s)²`
- Market cap: `M(s) = M₀ · (y₀ / (y₀ − s))²`, with `M₀ = $7K`.
- `y₀` is fitted so `M` reaches `$33K` at exactly `s = 72%` of supply: `y₀ = s_curve · √r / (√r − 1)`, with `r = 33/7`.
- A BOOST of `dx` base returns `dy = y · dx / (x + dx)` coins. A DUMP of `dy` coins returns `dx = x · dy / (y + dy)` base. Both round against the trader.

## Quotes are exact

The app's quote for a curve trade is exact for the current block, including fees and the anti-snipe fee. Your minimum amount out protects you if the price moves first.
