---
title: Anti-snipe
slug: /docs/trading/anti-snipe
section: Trading
---
# Anti-snipe

For the first 77 seconds after launch, BOOSTs pay an extra fee. It starts at 99% and falls to 0%. After that, only the 1% fee remains.

| Seconds after launch | Anti-snipe fee on BOOSTs |
|---|---|
| 0 | 99% |
| 11 | ≈ 84.9% |
| 22 | ≈ 70.7% |
| 33 | ≈ 56.6% |
| 44 | ≈ 42.4% |
| 55 | ≈ 28.3% |
| 66 | ≈ 14.2% |
| 77 and after | 0% |

The fee falls in a straight line, in whole seconds. It's charged on top of the 1% trade fee. [CONFIRM: FLOW — confirm "on top of the 1%" vs the constitution's "portion above the 1% protocol fee" wording.]

## What it applies to

- **BOOSTs only.** DUMPs never pay it.
- **The bonding curve only.** There is no anti-snipe after graduation.
- **Not the creator's launch buy.** That pays only the 1% fee (plus the creator's own tax).

## Where it goes

The snipe fee is held in escrow by the rocket's bonding curve, outside the price. When the rocket graduates, the escrow is added to its locked liquidity (LP) in the same transaction. If the rocket hasn't graduated 30 days after launch, anyone can send the escrow to the RewardsVault. None of it goes to the treasury. See [Rewards vault](/docs/fees/rewards-vault).

## Why it exists

Bots that buy in the first block take supply before people can react. The anti-snipe fee makes that expensive, and puts what it collects back into the rocket's pool or the community rewards vault.
