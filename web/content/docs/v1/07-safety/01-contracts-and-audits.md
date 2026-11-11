---
title: Contracts and audits
slug: /docs/safety
section: Safety and trust
---
# Contracts and audits

## Audit status

Not yet. The contracts have had internal security reviews only, no third-party audit. A professional audit is required before mainnet.

## What the internal reviews covered

The latest internal review (Oct 15, 2026) covered every core contract: the bonding curve, Launchpad, fee router, hook, router, LockedLP, migration, pricer, rewards vault, tramps-and-walls manager and the pseudonymous launcher. It used manual review, fuzz and invariant tests, static analysis and a fork test against the live testnet.

Findings and fixes are tracked openly in the repository. [CONFIRM: FLOW — link the public security-review page, and whether the findings table is published as-is.]

## How the contracts are built

| Contract | Job |
|---|---|
| **Launchpad** | Creates rockets and their curves. Holds launch settings. |
| **BondingCurve** | One per rocket. The market before the rocket reaches orbit. |
| **Migration** | Moves a rocket to the open market on Uniswap when it reaches orbit, in the same trade. |
| **DiscipleHook** | Sits on every rocket that has reached orbit. Charges the 1% fee and reports trades and altitude, which is how high the rocket's value has climbed. |
| **DiscipleRouter** | The app's path for trades after the rocket reaches orbit. It checks that the price did not move too far. |
| **LockedLP** | Owns the liquidity after orbit. Nobody can remove it. Liquidity is locked forever in the Uniswap v4 LP. |
| **FeeRouter** | Splits every fee 33 / 33 / 33 / 1. Holds claimable balances. The anti-snipe fee doesn't pass through it: the curve escrows it. |
| **ReferralRegistry** | Records who referred whom. |
| **RewardsVault** | Gets the early-launch fee of rockets that have not reached orbit 30 days after launch. |
| **QuotePricer** | Prices a base in dollars at launch. |
| **QuoteProbe** | Checks a base before launch. |
| **TrampWallManager** | Tramps and walls on rockets that have reached orbit. |
| **AntiSnipe** | Legacy launch fee schedule. The curve now applies the 7-second sniper tax itself. |
| **AnonLauncher** | Pseudonymous launches. |
| **MarketLens** | Read-only market data. |

Addresses: [Contract addresses](/docs/reference/contracts).

## Properties you can check

- **Fixed supply.** 1M per rocket, no mint after launch.
- **Name and call sign are locked.**
- **No pause.** Curves and pools are always live.
- **Liquidity after orbit has no way to be removed.** Tested by fuzzing: it can never be taken out. Liquidity is locked forever in the Uniswap v4 LP.
- **Fees always add up.** Tested: the fee router always holds at least what it owes creators and referrers.
- **Non-upgradeable.** Deployed code can't be replaced.

## Found a bug?

Tell us first, privately. See [Security](/security) for how to report it and what happens next.
