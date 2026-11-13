---
title: Locked liquidity
slug: /docs/curve/locked-liquidity
section: The starting price path
---
# Locked liquidity

When a rocket reaches orbit, its liquidity is locked forever in the Uniswap v4 LP. That position is owned by the LockedLP contract, which has no way to remove it. Reaching orbit means the starting price path is finished and the rocket moves to the open market on Uniswap.

## What's locked

- The 15.76% of supply kept back for the pool.
- The base the curve raised.
- The liquidity share of fees paid before orbit (33% of each fee), if the rocket reaches orbit within 12 days of launch. Like the sniper tax, it's added to the locked position over time.
- Every liquidity share of the trade fee after orbit (33% of each fee), added to the position as it builds up.

The base coin is locked forever in the Uniswap v4 LP when the rocket reaches orbit.

## How it's locked

- **No way out.** LockedLP has no function to withdraw the position. Any attempt to remove liquidity is refused.
- **Every price covered.** The position covers every price, so the pool can always trade.
- **Only two contracts can add liquidity** to DISCIPLE pools: LockedLP and the tramps-and-walls manager. Anyone else's add is rejected.
- **Non-upgradeable.** The contracts can't be swapped out for new code.

## Batched adds

The LP share of each fee is set aside on every trade and added to the locked position as it builds up, in batches. Until a batch is added, it's held for the pool. [CONFIRM: FLOW — batching ships with the PR #75 redeploy; on the current deploy the LP share is escrowed per trade.]

## Admin controls

Admin controls are held by the team. Some LockedLP settings (its links to the pool manager, migration, fee router, hook and treasury) can be changed by the owner, with no timelock. They can't remove the locked position. Balances waiting to be added could be redirected by those settings (tracked as SEC-04). The plan is to move ownership to a multisig with a timelock. See [Admin controls](/docs/safety/admin).
