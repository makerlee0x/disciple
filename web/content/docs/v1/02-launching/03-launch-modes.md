---
title: Launch modes
slug: /docs/launch/modes
section: Launching
---
# Launch modes

A launch mode sets the rules while a rocket is on its starting price path. People also call this path a bonding curve. The creator picks the mode at launch, and it can't be changed. The rules only apply before orbit. After a rocket reaches orbit, every rocket trades the same way on the open market on Uniswap.

There are three modes: **Easy**, **Hard** and **Trench**. Easy is picked for you on the launch form.

![Holding caps by mode. On Easy, one wallet can hold 1% of a rocket at $3,333, rising to 3.33% at $33,333. On Hard, 3.33% rising to 7.77%. Trench has no cap.](/illustrations/docs/holding-caps.svg)

| | **Easy** | **Hard** | **Trench** |
|---|---|---|---|
| Most one wallet can hold | 1% of the rocket at $3,333, rising to 3.33% at $33,333 | 3.33%, rising to 7.77% | No limit |
| A BOOST over your limit | Fills up to your limit, and the rest of your money comes back | Same | No limit to hit |
| Sign-in needed to BOOST | Yes | No | No |
| Crew tip | Yes (see below) | No | No |
| Most the creator can buy at launch | 1.2%, locked until orbit | 3.33% | 7.77% |
| Sniper tax in the first 7 seconds | Yes | Yes | Yes |

## Easy: crew first

- **A holding limit that grows.** One wallet can hold 1% of the rocket at launch. That rises to 3.33% as the rocket's value climbs to $33,333. The limit follows the coins, so moving them to a fresh wallet doesn't get around it. A BOOST over your limit fills up to it and sends the rest of your money back.
- **Signed-in buyers only.** To BOOST, you need to be signed in with a verified email, Google or X account. Selling never needs a sign-in, so holders can always get out.
- **Crew tip.** When you DUMP at a profit bigger than 0.5% of the rocket's value, 0.777% of what you get goes to the other holders. You don't share in your own tip. Each holder's share stays saved for them, even after the rocket reaches orbit.
- **The creator's coins are locked.** The creator's First BOOST (up to 1.2%) stays locked until the rocket reaches orbit. Anything the creator buys later can be sold like anyone else's.

## Hard: dog eat dog

Bigger positions and bigger swings. The holding limit grows from 3.33% to 7.77% as the rocket's value climbs. No sign-in check, no crew tip. The creator's First BOOST can be up to 3.33%.

## Trench: no guardrails

No holding limit and no sign-in check. Only the sniper tax applies. A private launch always uses Trench.

## Sniper tax: every mode

For the first 7 seconds after launch, BOOSTs pay a sniper tax: 99% at launch, 25% at 1 second, 3% at 2 seconds, and nothing from 7 seconds on. The creator's First BOOST doesn't pay it. The tax is held aside and doesn't move the price. If the rocket reaches orbit within 12 days of launch, the tax is added to the rocket's locked liquidity over time. If it hasn't reached orbit 12 days after launch, the tax goes to community rewards instead. See [Anti-snipe](/docs/trading/anti-snipe).

## Practice first

The [Simulator](/docs/game/simulator) has difficulty levels with similar names: PvE, PvP and Trench Warfare. There, the level sets who you're trading against (the bots), not the rocket's rules. The Simulator doesn't use the Easy or Hard limits or the crew tip. It's free practice with no wallet.
