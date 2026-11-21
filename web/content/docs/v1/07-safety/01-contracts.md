---
title: Contracts and admin
slug: /docs/safety
section: Fees and safety
---
# Contracts and admin

Everything about a rocket runs in contracts on Robinhood Chain. None of them can be upgraded.

## How a trade moves

```flow
You | BOOST or DUMP | gold
DiscipleRouter | Price and deadline checks | white
Bonding curve | Before orbit | gold
Uniswap v4 + hook | After orbit, takes the 1% | champagne
LockedLP | Holds every orbit LP | easy
```

## Checkable on-chain

- Fixed 1M supply per rocket, no mint.
- Name, ticker, difficulty, creator tax and fee choice locked at launch.
- No pause. Curves and pools are always live.
- Locked LP has no remove function, and nobody holds admin keys on it.
- The 1% fee split is a constant.

Every address: [Contracts](/docs/reference/contracts).

## What the Team can change

The Team's settings sit with a 2-of-3 Safe. There is no timelock.

| Can | Can't |
|---|---|
| Settings for new launches: default pair coin, launch pricer, sniper-tax window, crew tip (0–12%), Expert Ticket cap | Touch a locked LP |
| The pair coin list | Mint more of any rocket |
| The trade network fee, never over 25¢ | Change a launched rocket's rules, tax or fee choice |
| Community rewards payouts | Change the fee split |
| | Pause trading or upgrade code |

## Found a bug?

Tell us privately first. See [Security](/security).
