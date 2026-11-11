---
title: Launch modes
slug: /docs/launch/modes
section: Launching
---
# Launch modes

> **Coming with the next testnet redeploy** (mode rules v2, approved 2026-10-23). Built but not deployed. [CONFIRM: FLOW + lee — release timing.]

A launch mode sets the rules on the starting price path. People also call this a bonding curve. The creator picks it at launch, and it can't be changed. The rules apply only before orbit. After the rocket reaches orbit, every rocket trades the same way on the open market on Uniswap.

| | **Easy** (PvE) | **Hard** (PvP) | **Trench Warfare** |
|---|---|---|---|
| Per-wallet holding cap | 1% of supply at $3,333, rising with the rocket's value to 3.33% at $33,333 | 3.33% at $3,333, rising to 7.77% at $33,333 | None by default |
| BOOST over your cap | Fills up to your cap, the rest is refunded | Same | Same (if a cap is set) |
| Max single BOOST / DUMP | No limit | No limit | No limit |
| Sign-in required to BOOST | Yes | No | No |
| Crew tip | 0.777% of a DUMP's proceeds, only when your profit on it is above 0.5% of the rocket's value; goes to the other holders | None | None |
| Creator's First BOOST | Up to 1.2% of supply, locked until the rocket reaches orbit | Up to 3.33% | Up to 0.77% |
| Sniper tax (all modes) | 99% at launch, 25% at 1s, 3% at 2s, 0 from 7s | Same | Same |

Launches without a mode are Trench Warfare.

## Sniper tax: every mode

For the first 7 seconds after launch, BOOSTs pay a sniper tax: 99% at launch, 25% at 1s, 3% at 2s, 0 from 7s. The creator's First BOOST is exempt. The tax is held aside, outside the price. When the rocket reaches orbit, it goes into the rocket's locked liquidity. It is added to that locked position over time. It is not part of the liquidity locked at the moment the rocket reaches orbit. If the rocket has not reached orbit after 30 days, anyone can send it to the community rewards vault.

## Easy: crew first

- **Holding cap that grows.** A wallet can hold 1% of supply at launch, rising to 3.33% as the rocket's value climbs to $33,333. The cap follows transfers, so moving the rocket to a fresh wallet doesn't get around it. A BOOST over your cap fills up to the cap and refunds the rest.
- **Signed-in buyers only.** To BOOST, a wallet needs a verified login. Selling never needs one, so holders can always exit.
- **Crew tip.** When you DUMP at a profit above 0.5% of the rocket's value, 0.777% of the proceeds goes to the other holders still on the starting price path. You don't share in your own tip. Holders can claim their share after the rocket reaches orbit too.
- **Creator lock.** The creator's First BOOST (max 1.2%) stays locked until the rocket reaches orbit. Anything the creator buys later is free to sell.

## Hard: dog eat dog

Bigger positions, bigger swings. The holding cap grows from 3.33% to 7.77% as the rocket's value climbs. No sign-in, no max BOOST, no crew tip. The creator's First BOOST can be up to 3.33%.

## Trench Warfare: no guardrails

No mode caps, only the sniper tax. A protocol-wide wallet cap can apply, but it defaults to none. See [Wallet cap and trade limits](/docs/trading/limits).

## Practice first

The [Simulator](/docs/game/simulator) uses the same names as difficulty levels. There, the name sets who you're trading against (the bots), not the curve's rules. The Simulator doesn't apply the Easy or Hard caps or the crew tip. It's free paper trading with no wallet.
