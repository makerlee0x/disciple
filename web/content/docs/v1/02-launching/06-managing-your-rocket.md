---
title: Managing your rocket
slug: /docs/launch/manage
section: Launching
---
# Managing your rocket

## What you can change

| Field | After launch |
|---|---|
| Image | Can change |
| Description | Can change |
| Socials and website | Can change |
| Name | Locked |
| Call sign | Locked |
| Creator tax | Locked |
| Launch mode | Locked |

## Claim your earnings

Creator fees build up on-chain. Claiming from the app is coming soon. Until then, call `claimCreatorFees(token)` on the FeeRouter. See [Creator earnings](/docs/fees/creators).

## Hand off a rocket

You can transfer a rocket to another wallet, anytime, as many times as you like. The whole pack goes with it: metadata rights, the fee claim and creator tax rights.

## What you can't do

- Mint more supply. Supply is fixed at 1M.
- Pause trading. The starting price path and the open market on Uniswap are always live.
- Remove liquidity after orbit. It is locked forever in the Uniswap v4 LP.

As a holder, you can still sell your own coins, like anyone else.
