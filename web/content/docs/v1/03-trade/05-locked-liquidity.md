---
title: Locked liquidity
slug: /docs/curve/locked-liquidity
section: Trade rockets
---
# Locked liquidity

At orbit the LP goes to a contract with no withdraw function and no owner. Nobody can pull it. Not the creator, not the team.

## What keeps going in

```flow
At orbit | 15.76% + base raised | gold
Every trade after | 0.33% of the trade | easy
Curve LP share | If orbit within 12 days | white
Sniper tax | If orbit within 12 days | white
```

The LP share builds up and gets added in batches, about every minute. Anyone can trigger the add.

## Why it can't be pulled

- No remove function exists.
- Only the LP contract can add liquidity to DISCIPLE pools.
- The contracts can't be upgraded, and the LP contract's owner role is renounced.

Holders, the creator included, can still sell their own coins.
