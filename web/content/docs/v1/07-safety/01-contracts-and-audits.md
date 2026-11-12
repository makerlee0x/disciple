---
title: Contracts and audits
slug: /docs/safety
section: Safety and trust
---
# Contracts and audits

## Audit status

Not yet. The contracts have had internal security reviews only, no third-party audit. A professional audit is required before mainnet.

## What the internal reviews covered

The latest internal review (Oct 15, 2026) covered every core contract: the bonding curve, Launchpad, fee router, hook, router, LockedLP, migration, pricer, rewards vault, tramps-and-walls manager and the pseudonymous launcher. It used manual review, fuzz and invariant tests, static analysis and a fork test against the live contracts.

Findings and fixes are tracked openly in the repository. [CONFIRM: FLOW — link the public security-review page, and whether the findings table is published as-is.]

## How the contracts are built

| Contract | Job |
|---|---|
| **Launchpad** | Creates rockets and their curves. Holds launch settings. |
| **BondingCurve** | One per rocket. The starting price path, before orbit. |
| **Migration** | Moves a rocket to Uniswap v4 when it reaches orbit, in the same trade. |
| **AscensionHook** | Attached to every rocket's Uniswap pool after orbit. Charges the 1% fee and reports trades and altitude. |
| **DiscipleRouter** | Carries the app's trades, including one-tap trades paid in USDG. Adds slippage and price-impact checks. |
| **LockedLP** | Owns the locked liquidity of every rocket that has reached orbit. It has no way to remove it. |
| **FeeRouter** | Splits every fee 33 / 33 / 33 / 1 after orbit and holds what's owed from those fees until it's claimed. The sniper tax doesn't pass through it: each rocket holds its own. |
| **CurveFeeVault** | The fee vault. Holds every share of the fees paid before orbit, except the liquidity share, until it's claimed. |
| **RewardsVault** | The community rewards vault. Holds the sniper tax and the liquidity share of fees from rockets that didn't reach orbit within 12 days. See [Community rewards](/docs/fees/rewards-vault). |
| **QuotePricer** | Prices a base in dollars at launch. |
| **QuoteProbe** | Checks a base before launch. |
| **TrampWallManager** | Tramps and walls on rockets that have reached orbit. |
| **AnonLauncher** | Private launches. |
| **MarketLens** | Read-only market data. |

Addresses: [Contract addresses](/docs/reference/contracts).

## Properties you can check

- **Fixed supply.** 1M per rocket, no mint after launch.
- **Name and call sign are locked.**
- **No pause.** Curves and pools are always live.
- **Locked liquidity has no remove function.** Tested with large numbers of random inputs: locked liquidity can never be removed.
- **Fees always add up.** Tested: the fee router always holds at least what it owes.
- **Non-upgradeable.** Deployed code can't be replaced.

## Found a bug?

Tell us first, privately. See [Security](/security) for how to report it and what happens next.
