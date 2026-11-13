---
title: Admin controls
slug: /docs/safety/admin
section: Safety and trust
---
# Admin controls

The contracts can't be upgraded. The team holds the admin controls.

We list them here so you know exactly what the team can and can't do.

## What the team can change

| Area | Settings |
|---|---|
| Launch settings | Default base, base pricer and probe, curve deployer, Trench First BOOST cap (7.77%, and it can only be lowered), protocol wallet cap, sniper-tax window (12 days, can be set from 1 to 365 days). **New rockets only.** |
| Fee routing | Treasury address, community rewards address, where the 1% share goes, which contracts may route fees |
| Ascended pools | Which routers the hook trusts, the hook's pricer |
| LockedLP wiring | Links to the pool manager, migration, fee router, hook and treasury |
| Router | Max price impact per swap (between 1% and 1,000%, default 50%) |
| Tramps and walls | Keeper tip (up to 1%) |
| Pseudonymous launches | Launch fee (up to $5) and its treasury |
| Community rewards | Payouts |

There is no timelock on these today.

## What the team can't do

- Remove the locked liquidity of a rocket that has reached orbit.
- Mint more of any rocket.
- Change a rocket's name, call sign, creator tax or launch mode.
- Change the curve of a rocket that's already launched.
- Pause trading.
- Replace contract code.

## The risk, plainly

Some wiring settings could redirect fees or break trading if misused. This is tracked as an open item (SEC-04).

## Before mainnet

The plan for mainnet: every owner role moves to a multisig (suggested 3-of-5, signers on hardware wallets, at least two people or orgs), the treasury moves to a separate multisig, and parameter changes go through a 24–48 hour timelock.
