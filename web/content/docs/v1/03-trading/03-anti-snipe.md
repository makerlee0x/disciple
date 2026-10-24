---
title: Anti-snipe
slug: /docs/trading/anti-snipe
section: Trading
---
# Anti-snipe

For the first 77 seconds after launch, BOOSTs pay a sniper tax. It starts at 99% and falls to 0%. After that, only the 1% fee (plus any creator tax) remains.

| Seconds after launch | Sniper tax on BOOSTs |
|---|---|
| 0 | 99% |
| 15 | 79.72% |
| 30 | 60.43% |
| 45 | 41.15% |
| 60 | 21.86% |
| 76 | 1.29% |
| 77 and after | 0% |

The tax falls in a straight line, in whole seconds (`99% × (1 − t/77)`). It's charged on top of the 1% trade fee. [CONFIRM: FLOW — confirm "on top of the 1%" vs the constitution's "portion above the 1% protocol fee" wording.]

## What it applies to

- **BOOSTs only.** DUMPs never pay it.
- **The bonding curve only.** There is no anti-snipe after graduation.
- **Not the creator's First BOOST.** That pays only the 1% fee (plus the creator's own tax).

## Where it goes

The tax is held by the curve, outside the price. At graduation it goes into the rocket's locked liquidity (LockedLP's compound bucket, which is added to the locked position over time; it is not part of the graduation floor). If the rocket hasn't graduated 30 days after launch, anyone can send it to the community rewards vault. See [Rewards vault](/docs/fees/rewards-vault).

## Why it exists

Bots that buy in the first block take supply before people can react. The anti-snipe fee makes that expensive, and what it collects stays locked in the rocket's liquidity.
