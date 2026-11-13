---
title: Reaching orbit
slug: /docs/curve/graduation
section: The starting price path
---
# Reaching orbit

A rocket reaches orbit when about 84% of it has been bought on its starting price path and its value reaches $33,333. That is the Outer Space tier. Reaching orbit means that path is finished and the rocket moves to the open market on Uniswap. People also call the starting path a bonding curve, which means each buy costs a little more than the last.

## What happens

The BOOST that crosses the line makes the rocket reach orbit in the same trade. There's no pause and no gap. [CONFIRM: FLOW — how the crossing BOOST is filled when it overshoots, e.g. partial fill and refund.]

1. **A Uniswap v4 pool opens** for the rocket and its base, at the curve's last price. No jump.
2. **Liquidity goes into the pool**: the remaining 15.76% of supply plus the base the curve raised, as one full-range position.
3. **The position is locked forever** in the LockedLP contract. See [Locked liquidity](/docs/curve/locked-liquidity).
4. **DISCIPLE's fee contract is attached** to the pool. It charges the same 1% fee, split the same way.

## Before orbit and after

| | Before orbit | After orbit |
|---|---|---|
| Price | Set by the starting price path | Set by what people have put into the Uniswap pool |
| You trade with | The starting price path | The open market on Uniswap |
| Value | $3,333 → $33,333 | $33,333 and up |
| Supply | about 84% sells on the starting price path | The remaining 15.76% is locked forever in the Uniswap v4 LP |
| Liquidity | The base builds up on the starting price path | Locked forever in the Uniswap v4 LP |
| Fee | 1% + optional creator tax | 1% |
| Sniper tax | First 7 seconds | None |
| Wallet cap | If set at launch | None |
| Tramps and walls | No | Yes |

## After orbit

- The Uniswap pool charges no extra fee of its own. The 1% fee still applies. The total fee stays 1%.
- 33% of every fee still goes to the locked liquidity, added to the position as it builds up.
- The rocket keeps climbing through the named tiers. Altitude is how high its value has climbed. See [Altitude and tiers](/docs/game/tiers).
- The pool is a normal Uniswap v4 pool, so other apps can trade it too. Those trades still pay the 1% fee.
