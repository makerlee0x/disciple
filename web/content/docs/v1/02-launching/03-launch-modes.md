---
title: Launch modes
slug: /docs/launch/modes
section: Launching
---
# Launch modes

> **Coming with the next testnet redeploy.** Launch modes are built (PR #75) but not deployed. Numbers below are the current defaults and may change before release. [CONFIRM: FLOW + lee — final values and release timing.]

A launch mode sets the rules on the bonding curve. The creator picks it at launch, and it can't be changed. Modes apply **only on the curve**: after graduation every rocket trades the same way.

| | **PvE** (easy) | **PvP** (medium) | **Trench Warfare** (hard) |
|---|---|---|---|
| Per-wallet holding cap | 1% of supply | 4% at launch, rising to 12% at graduation | None by default |
| Max single BOOST | 0.25% of supply for the first 7 minutes | 3.33% of supply | No limit |
| Max single DUMP | 0.5% of supply | No limit | No limit |
| Sign-in required to BOOST | Yes | No | No |
| Launch-block buys | Only the creator's launch buy | Allowed | Allowed |
| Profit tax | 0.777% on sells above 1.77× your average cost, paid to other holders | None | None |

Trench Warfare is today's behaviour. Launches without a mode are Trench Warfare.

## PvE: crew first

PvE is built for a crew to climb together.

- **Holding cap.** No wallet can hold more than 1% of supply from the curve. The cap follows transfers, so moving coins to a fresh wallet doesn't get around it.
- **Slow start.** For the first 7 minutes, each BOOST is capped at 0.25% of supply.
- **No launch-block snipes.** Nobody but the creator can buy in the launch block.
- **Signed-in buyers only.** To BOOST, a wallet needs a verified login. Selling never needs one, so holders can always exit.
- **Profit tax to the crew.** If you DUMP above 1.77× your average cost, 0.777% of your proceeds goes to the other holders on the curve. You don't share in your own tax. Holders can claim their share, also after graduation. Claiming from the app is coming soon.

## PvP: dog eat dog

Bigger positions, bigger swings. The holding cap grows from 4% to 12% as the curve fills. A single BOOST is capped at 3.33% of supply. No sign-in needed.

## Trench Warfare: no guardrails

No mode caps. Snipers, bundles and whales are all possible. A protocol-wide wallet cap can apply, but it defaults to none. See [Wallet cap and trade limits](/docs/trading/limits).

## Practice first

The [Simulator](/docs/game/simulator) uses the same three names as difficulty levels. There, the name sets who you're trading against (the bots), not the curve's rules. The Simulator doesn't apply the PvE or PvP caps or the profit tax. It's free paper trading with no wallet.
