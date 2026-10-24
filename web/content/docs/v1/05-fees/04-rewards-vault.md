---
title: Rewards vault
slug: /docs/fees/rewards-vault
section: Fees and rewards
---
# Rewards vault

The RewardsVault is the community rewards vault. It gets the snipe fee of rockets that never graduate, to be shared out later (how is still being decided).

## What's in it

The anti-snipe fee (the extra fee on BOOSTs in a rocket's first 77 seconds) is held in escrow by each rocket's curve. If the rocket graduates, the escrow goes into its locked liquidity (LP), not the vault. If the rocket hasn't graduated 30 days after launch, anyone can send the escrow to the RewardsVault. Nothing else goes in. It's held in each rocket's base coin.

## How it's shared

Not decided yet. There are no on-chain distribution rules today. Payouts are made by the vault's owner, and every payout is recorded on-chain. [CONFIRM: FLOW + lee — distribution rules and timing before this page goes live.]

## Check it yourself

The vault is a public contract. Its lifetime total per asset and every payout are visible on-chain. See [Contract addresses](/docs/reference/contracts).
