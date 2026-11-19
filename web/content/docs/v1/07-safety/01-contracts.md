---
title: Contracts and admin
slug: /docs/safety
section: Fees and safety
---
# Contracts and admin

Everything about a rocket runs in contracts on Robinhood Chain. None of them can be upgraded.

## Checkable on-chain

- Fixed 1M supply per rocket, no mint.
- Name, ticker, difficulty, creator tax and fee choice locked at launch.
- No pause. Curves and pools are always live.
- Locked LP has no remove function, and its owner role is renounced.
- The 1% fee split is a constant.
- The fee router always holds at least what it owes (fuzz tested).

## The contracts

| Contract | Job |
|---|---|
| Launchpad | Launches rockets and their curves |
| BondingCurve | One per rocket, until orbit |
| Migration | Moves a rocket to Uniswap v4 at orbit, same trade |
| DiscipleHook | On every orbit pool. Takes the 1% fee |
| DiscipleRouter | Carries app trades, with min-out and deadline checks |
| LockedLP | Holds every orbit LP. No way out |
| FeeRouter | Splits and holds fees after orbit |
| CurveFeeVault | Holds curve fees until claimed |
| CreatorFeeHarvest | Sends pool and burn creator fees, and anon launches |
| RewardsVault | Community rewards |
| QuotePricer | Prices a pair coin in dollars at launch |

Addresses: [Contracts](/docs/reference/contracts).

## What the team can change

Owner roles sit with a 2-of-3 multisig. There is no timelock.

| Can | Can't |
|---|---|
| Settings for new launches (default pair coin, pricer, sniper-tax window, lower the Expert Ticket cap) | Touch a locked LP |
| The pair coin list | Mint more of any rocket |
| The treasury address | Change a launched rocket's rules, tax or fee choice |
| Community rewards payouts | Change the fee split |
| | Pause trading or upgrade code |

## Found a bug?

Tell us privately first. See [Security](/security).
