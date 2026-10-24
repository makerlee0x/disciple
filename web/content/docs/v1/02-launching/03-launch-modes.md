---
title: Launch modes
slug: /docs/launch/modes
section: Launching
---
# Launch modes

> **Coming with the next testnet redeploy** (mode rules v2, approved 2026-10-23). Built but not deployed. [CONFIRM: FLOW + lee — release timing.]

A launch mode sets the rules on the bonding curve. The creator picks it at launch, and it can't be changed. Modes apply **only on the curve**: after graduation every rocket trades the same way.

| | **Easy** (PvE) | **Hard** (PvP) | **Trench Warfare** |
|---|---|---|---|
| Per-wallet holding cap | 1% of supply at $3,333, rising with market cap to 3.33% at $33,333 | 3.33% at $3,333, rising to 7.77% at $33,333 | None by default |
| BOOST over your cap | Fills up to your cap, the rest is refunded | Same | Same (if a cap is set) |
| Max single BOOST / DUMP | No limit | No limit | No limit |
| Sign-in required to BOOST | Yes | No | No |
| Crew tip | 0.777% of a DUMP's proceeds, only when your profit on it is above 0.5% of the market cap; goes to the other holders | None | None |
| Creator's First BOOST | Up to 1.2% of supply, locked until graduation | Up to 3.33% | Up to 0.77% |
| Sniper tax (all modes) | 99% falling to 0 over the first 77 seconds | Same | Same |

Launches without a mode are Trench Warfare.

## Sniper tax: every mode

For the first 77 seconds after launch, BOOSTs pay a sniper tax that starts at 99% and falls to 0 in a straight line. The creator's First BOOST is exempt. The tax is held in escrow by the curve, outside the price. At graduation it goes into the rocket's locked liquidity (LP). If the rocket hasn't graduated 30 days after launch, anyone can send it to the RewardsVault.

## Easy: crew first

- **Holding cap that grows.** A wallet can hold 1% of supply from the curve at launch, rising to 3.33% as the market cap climbs to $33,333. The cap follows transfers, so moving coins to a fresh wallet doesn't get around it. A BOOST over your cap fills up to the cap and refunds the rest.
- **Signed-in buyers only.** To BOOST, a wallet needs a verified login. Selling never needs one, so holders can always exit.
- **Crew tip.** When you DUMP at a profit above 0.5% of the market cap, 0.777% of the proceeds goes to the other holders on the curve. You don't share in your own tip. Holders can claim their share, also after graduation.
- **Creator lock.** The creator's First BOOST (max 1.2%) stays locked until graduation. Anything the creator buys later is free to sell.

## Hard: dog eat dog

Bigger positions, bigger swings. The holding cap grows from 3.33% to 7.77% as the market cap climbs. No sign-in, no max BOOST, no crew tip. The creator's First BOOST can be up to 3.33%.

## Trench Warfare: no guardrails

No mode caps, only the sniper tax. A protocol-wide wallet cap can apply, but it defaults to none. See [Wallet cap and trade limits](/docs/trading/limits).

## Practice first

The [Simulator](/docs/game/simulator) uses the same names as difficulty levels. There, the name sets who you're trading against (the bots), not the curve's rules. The Simulator doesn't apply the Easy or Hard caps or the crew tip. It's free paper trading with no wallet.
