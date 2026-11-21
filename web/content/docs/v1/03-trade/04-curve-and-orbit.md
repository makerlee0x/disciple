---
title: Bonding curve and orbit
slug: /docs/curve
section: Trade rockets
---
# Bonding curve and orbit

Every rocket starts on its own bonding curve. Each buy costs a bit more than the last. Sells walk it back down.

```stats
$3,333 | Start mcap
$33,333 | Orbit | gold
```

## Where the 1M coins go

```split
84.24 | Sold on the curve | 84.24% | gold
15.76 | Kept for the LP | 15.76% | easy
```

## Orbit

The buy that crosses $33,333 sends the rocket to orbit in the same trade. No pause, no gap. If that buy is bigger than what's left on the curve, it fills to the line and the rest of your dollars come straight back.

```flow
Curve sells out | $33,333 | gold
Uniswap v4 pool opens | Same price, no jump | white
LP locked | Forever | easy
```

In that one trade, the 15.76% kept back plus everything the curve raised go into a Uniswap v4 pool, locked forever.

## Before vs after

| | Bonding curve | After orbit |
|---|---|---|
| Market | The curve | Uniswap v4 |
| Fee | 1% + creator tax | 1% |
| Max bag | Easy / Hard | None |
| Sniper tax | First 7s | None |

After orbit the pool is a normal Uniswap v4 pool. Other apps can trade it, and those trades still pay the 1%. The rocket keeps climbing through the [altitude tiers](/docs/game/flight#altitude).
