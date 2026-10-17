---
title: Anti-snipe
slug: /docs/trading/anti-snipe
section: Trading
---
# Anti-snipe

For the first 7 seconds after launch, BOOSTs pay an extra fee. It starts at 77.7% and falls to 0%. After that, only the 1% fee remains.

| Seconds after launch | Anti-snipe fee on BOOSTs |
|---|---|
| 0 | 77.7% |
| 1 | 66.6% |
| 2 | 55.5% |
| 3 | 44.4% |
| 4 | 33.3% |
| 5 | 22.2% |
| 6 | 11.1% |
| 7 and after | 0% |

The fee falls in a straight line, in whole seconds. It's charged on top of the 1% trade fee. [CONFIRM: FLOW — confirm "on top of the 1%" vs the constitution's "portion above the 1% protocol fee" wording.]

## What it applies to

- **BOOSTs only.** DUMPs never pay it.
- **The bonding curve only.** There is no anti-snipe after graduation.
- **Not the creator's launch buy.** That pays only the 1% fee (plus the creator's own tax).

## Where it goes

70% of the snipe fee goes to a community rewards vault, to be shared out later (how is still being decided). 30% goes to the treasury. See [Rewards vault](/docs/fees/rewards-vault).

## Why it exists

Bots that buy in the first block take supply before people can react. The anti-snipe fee makes that expensive, and sends most of what it collects back to the community.
