---
title: Admin controls
slug: /docs/safety/admin
section: Safety and trust
---
# Admin controls

Contracts are non-upgradeable; admin controls are held by the team during testnet.

We list them here so you know exactly what the team can and can't do.

## What the team can change

| Area | Settings |
|---|---|
| Launch settings | Default base, base pricer and probe, curve deployer, creator-buy cap (up to 7%), protocol wallet cap. **New rockets only.** |
| Fee routing | Treasury address, rewards vault address, which contracts may route fees |
| Graduated pools | Which routers the hook trusts, the hook's pricer |
| LockedLP wiring | Links to the pool manager, migration, fee router, hook and treasury |
| Router | Max price impact per swap (between 1% and 1,000%, default 50%) |
| Tramps and walls | Keeper tip (up to 1%) |
| Pseudonymous launches | Launch fee (up to $5) and its treasury |
| Rewards vault | Payouts |

There is no timelock on these today.

## What the team can't do

- Remove graduated liquidity.
- Mint more of any rocket.
- Change a rocket's name, call sign, creator tax or launch mode.
- Change the curve of a rocket that's already launched.
- Pause trading.
- Replace contract code.

## The risk, plainly

Some wiring settings could redirect fees or break trading if misused. This is tracked as an open item (SEC-04).

## Before mainnet

The plan for mainnet: every owner role moves to a multisig (suggested 3-of-5, signers on hardware wallets, at least two people or orgs), the treasury moves to a separate multisig, and parameter changes go through a 24–48 hour timelock. [CONFIRM: FLOW — final multisig and timelock setup.]
