---
title: The bonding curve
slug: /docs/curve
section: Bonding curve and graduation
---
# The bonding curve

Every rocket starts on its own bonding curve. The curve is the market: you BOOST and DUMP against it, and a formula sets the price.

## In one paragraph

The rocket starts at a **$7,777** market cap. Each coin sold costs a little more than the last. When **72%** of supply has sold, the market cap is exactly **$33,333** and the rocket graduates to Uniswap v4. DUMPs move it back down the same curve.

## The numbers

| | |
|---|---|
| Total supply | 1,000,000 (fixed, 18 decimals) |
| Sold on the curve | 72% (720,000) |
| Start market cap | $7,777 |
| Graduation market cap | $33,333 |
| Kept for the Uniswap pool | 28% (280,000) |

## How the price moves

| Share of supply sold | Market cap | Base raised (net of fees) |
|---|---|---|
| 0% | $7,777 | $0 |
| 10% | ≈ $9,027 | ≈ $838 |
| 25% | ≈ $11,552 | ≈ $2,370 |
| 50% | ≈ $18,928 | ≈ $6,066 |
| 72% | $33,333 | ≈ $11,592 |

Values assume a $1 base (USDG). With another base, the same shape applies in that base, converted at launch. Gross BOOSTs to graduate are higher once fees are included.

## The formula

The curve is a constant-product market with virtual reserves, like pump.fun's.

- Reserves: base `x`, rocket `y`, with `x · y = k`, starting at `x₀ · y₀`.
- Spot price after `s` coins sold: `p(s) = x₀·y₀ / (y₀ − s)²`
- Market cap: `M(s) = M₀ · (y₀ / (y₀ − s))²`, with `M₀ = $7,777`.
- `y₀` is fitted so `M` reaches `$33,333` at exactly `s = 72%` of supply: `y₀ = s_curve · √r / (√r − 1)`, with `r = 33,333/7,777`.
- A BOOST of `dx` base returns `dy = y · dx / (x + dx)` coins. A DUMP of `dy` coins returns `dx = x · dy / (y + dy)` base. Both round against the trader.

## Quotes are exact

The app's quote for a curve trade is exact for the current block, including fees and the anti-snipe fee. Your minimum amount out protects you if the price moves first.
