---
title: Tramps and walls
slug: /docs/trading/tramps-and-walls
section: Trading
---
# Tramps and walls

> **Graduated rockets only.** [CONFIRM: SITE + FLOW — the app's tramp/wall panel runs on a mock adapter today; confirm when it goes live on-chain.]

Tramps and walls are limit orders on a graduated rocket's Uniswap v4 pool.

| | **Tramp** | **Wall** |
|---|---|---|
| What it is | A buy order below the price | A sell order above the price |
| You deposit | Base only | Rocket only |
| Placed | Fully below the current price | Fully above the current price |
| Filled when | The price falls through it | The price rises through it |
| On the chart | Support: a trampoline the rocket bounces off | Resistance |

## Rules

- **Pure limit orders.** Tramps and walls earn no trading fees or yield.
- **Cancel anytime.** You get back what's left: unfilled funds plus anything already filled. No minimum hold.
- **Auto-close.** Once fully crossed, anyone can close a filled order. You get the proceeds minus a keeper tip of 0.1% (the team can set it up to 1%), paid to whoever closes it. Close it yourself and the tip comes back to you.
- **One-sided only.** An order that touches the current price reverts.

## Points

Filled tramps and walls earn rHALO points: 1 point per $1 of filled size. Points are off-chain. See [Achievements and points](/docs/game/achievements).

## Good to know

A large trader can push the price through your range to fill it. You still get your range's price.
