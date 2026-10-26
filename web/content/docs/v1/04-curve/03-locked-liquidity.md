---
title: Locked liquidity
slug: /docs/curve/locked-liquidity
section: Bonding curve and graduation
---
# Locked liquidity

At graduation, the liquidity is locked forever in a full-range Uniswap v4 position owned by the LockedLP contract, which has no function to remove it.

## What's locked

- The 15.76% of supply kept back for the pool.
- The base the curve raised.
- Every later LP share of the trade fee (33% of each fee), added to the position as it builds up.

The base is locked permanently in the Uniswap v4 LP at graduation.

## How it's locked

- **No remove path.** LockedLP has no function to withdraw the position. Its remove-liquidity function always reverts.
- **Full range.** The position covers every price, so the pool can always trade.
- **Only two contracts can add liquidity** to DISCIPLE pools: LockedLP and the tramps-and-walls manager. Anyone else's add is rejected.
- **Non-upgradeable.** The contracts can't be swapped out for new code.

## Batched adds

The LP share of each fee is set aside on every trade and added to the locked position as it builds up, in batches. Until a batch is added, it's held for the pool. [CONFIRM: FLOW — batching ships with the PR #75 redeploy; on the current deploy the LP share is escrowed per trade.]

## Admin controls on testnet

Admin controls are held by the team during testnet. Some LockedLP settings (its links to the pool manager, migration, fee router, hook and treasury) can be changed by the owner, with no timelock. They can't remove the locked position. Balances waiting to be added could be redirected by those settings (tracked as SEC-04). The mainnet plan moves ownership to a multisig with a timelock. See [Admin controls](/docs/safety/admin).
