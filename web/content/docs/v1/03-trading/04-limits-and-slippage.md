---
title: Wallet cap and trade limits
slug: /docs/trading/limits
section: Trading
---
# Wallet cap and trade limits

## Holding limit (before orbit)

While a rocket is on its starting price path, there can be a limit on how much of it one wallet can hold.

- **Easy and Hard rockets** have a holding limit that grows as the rocket's value climbs. See [Launch modes](/docs/launch/modes).
- **Expert rockets** have no holding limit.
- **After orbit** there's no holding limit on any rocket.
- A BOOST that would take you over your limit fills up to the limit, and the rest of your money comes back.

The app shows the limit only when a rocket has one. The team also has a setting for a limit on every new rocket, but it is off today.

## Slippage

Slippage is how far the price is allowed to move against you before a trade is refused. Every trade sets a minimum amount you must receive. If the price moves past that before the trade lands, the trade is refused and you keep your money. Set it in **Swap settings** (the gear next to the sell sizes).

- **Default: Auto (1%).**
- **Custom:** any value up to 50%.
- **One-tap trading:** trades also stay within **Max price move per trade** in Settings: 5%, 15%, 30% or 50%. The default is 15%.

## Deadline

Every trade also has a deadline. A trade that lands too late reverts.

Together, these two checks protect you from being front-run by bots.

## Max price impact (after orbit)

After the rocket reaches orbit, a trade through the DISCIPLE router is refused if that one trade would move the pool price by more than **50%**. Split a very large trade into smaller ones.

## Always live

There is no pause. A rocket can be traded the whole way, before and after it reaches orbit.
