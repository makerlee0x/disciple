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
| **BondingCurve** | One per rocket. The pre-ascension market. |
| **Migration** | Moves an ascending rocket to Uniswap v4, in the same transaction. |
| **DiscipleHook** | Uniswap v4 hook on every ascended pool. Charges the 1% fee and reports trades and altitude. |
| **DiscipleRouter** | The app's router for ascended trades. Adds slippage and price-impact checks. |
| **LockedLP** | Owns every ascended liquidity position. No remove function. |
| **FeeRouter** | Splits every fee 33 / 33 / 33 / 1. Holds claimable balances. The anti-snipe fee doesn't pass through it: the curve escrows it. |
| **ReferralRegistry** | Records who referred whom. |
| **RewardsVault** | Gets the escrowed anti-snipe fee of rockets that haven't ascended 30 days after launch. |
| **QuotePricer** | Prices a base in dollars at launch. |
| **QuoteProbe** | Checks a base before launch. |
| **TrampWallManager** | Tramps and walls on ascended pools. |
| **AntiSnipe** | Legacy launch fee schedule. The curve now applies the 7-second sniper tax itself. |
| **AnonLauncher** | Pseudonymous launches. |
| **MarketLens** | Read-only market data. |

Addresses: [Contract addresses](/docs/reference/contracts).

## Properties you can check

- **Fixed supply.** 1M per rocket, no mint after launch.
- **Name and call sign are locked.**
- **No pause.** Curves and pools are always live.
- **Ascended liquidity has no remove function.** Tested by fuzzing: locked liquidity can never be removed.
- **Fees always add up.** Tested: the fee router always holds at least what it owes creators and referrers.
- **Non-upgradeable.** Deployed code can't be replaced.

## Found a bug?

Tell us first, privately. See [Security](/security) for how to report it and what happens next.
