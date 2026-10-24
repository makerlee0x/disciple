---
title: Graduation
slug: /docs/curve/graduation
section: Bonding curve and graduation
---
# Graduation

A rocket graduates when 72% of supply has sold on the curve and its market cap reaches $33,333. That's the Outer Space tier.

## What happens

The BOOST that crosses the line triggers graduation in the same transaction. There's no pause and no gap. [CONFIRM: FLOW — how the crossing BOOST is filled when it overshoots, e.g. partial fill and refund.]

1. **A Uniswap v4 pool opens** for the rocket and its base, at the curve's last price. No jump.
2. **Liquidity goes into the pool**: the remaining 28% of supply plus the base the curve raised, as one full-range position.
3. **The position is locked forever** in the LockedLP contract. See [Locked liquidity](/docs/curve/locked-liquidity).
4. **The DISCIPLE hook is attached** to the pool. It charges the same 1% fee, split the same way.

## Bonding curve vs Uniswap v4

| | Phase 1: Bonding curve | Phase 2: Uniswap v4 |
|---|---|---|
| Price | Set by the curve's formula | Set by the pool's reserves |
| You trade with | The bonding curve | The Uniswap v4 pool |
| Market cap | $7,777 → $33,333 | $33,333 and up |
| Supply | 72% sells on the curve | The remaining 28% is locked forever in the Uniswap v4 LP |
| Liquidity | Base builds up in the curve | Full-range, owned by LockedLP, locked forever |
| Fee | 1% + optional creator tax | 1%, via the DISCIPLE hook |
| Anti-snipe | First 7 seconds | None |
| Wallet cap | If set at launch | None |
| Tramps and walls | No | Yes |

## After graduation

- The pool's own LP fee is **0**. The DISCIPLE hook charges the 1%. Total fee stays 1%.
- 33% of every fee still goes to the locked liquidity, added to the position as it builds up.
- The rocket keeps climbing through the altitude tiers. See [Altitude and tiers](/docs/game/tiers).
- The pool is a normal Uniswap v4 pool, so other routers can trade it too. Those swaps still pay the hook's 1%.
