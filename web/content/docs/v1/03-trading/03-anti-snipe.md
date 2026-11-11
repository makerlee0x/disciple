---
title: Anti-snipe
slug: /docs/trading/anti-snipe
section: Trading
---
# Anti-snipe

For the first 7 seconds after launch, BOOSTs pay a sniper tax: 99% at launch, 25% at 1s, 3% at 2s, 0 from 7s. After that, only the 1% fee (plus any creator tax) remains.

| Seconds after launch | Sniper tax on BOOSTs |
|---|---|
| 0 | 99% |
| 1 | 25% |
| 2 | 3% |
| 3 | 1% |
| 4 | 0.3% |
| 5 | 0.1% |
| 6 | 0.03% |
| 7 and after | 0% |

The tax steps down once per second, counted in whole seconds from the launch block: a BOOST 1.5 seconds after launch pays 25%. It's taken off the BOOST first; the 1% trade fee (plus any creator tax) is charged on the rest.

## What it applies to

- **BOOSTs only.** DUMPs never pay it.
- **The starting price path only.** There is no anti-snipe after the rocket reaches orbit.
- **Not the creator's First BOOST.** That pays only the 1% fee (plus the creator's own tax).

## Where it goes

The tax is held aside, outside the price. When the rocket reaches orbit, it goes into the rocket's locked liquidity. It is added to that locked position over time. It is not part of the liquidity locked at the moment the rocket reaches orbit. If the rocket has not reached orbit 30 days after launch, anyone can send it to the community rewards vault. See [Rewards vault](/docs/fees/rewards-vault).

## Why it exists

Bots that buy in the first block take supply before people can react. The anti-snipe fee makes that expensive, and puts what it collects back into the rocket's pool or the community rewards vault.
