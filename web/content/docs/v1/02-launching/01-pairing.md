---
title: Pairing and base coins
slug: /docs/launch/pairing
section: Launching
---
# Pairing and base coins

Every rocket has a **base**: the coin it's paired with.

## What pairing means

Your rocket is priced and traded in its base coin.

- **BOOST** a rocket and you pay in the base.
- **DUMP** it and you're paid in the base.
- **When the rocket reaches orbit**, the base is locked forever in the Uniswap v4 LP, alongside the rocket. Reaching orbit means the starting price path is finished and the rocket moves to the open market on Uniswap.

That's the whole relationship. A rocket follows its base on the chart because it's priced in it. DISCIPLE makes no other claim about what a rocket does for its base.

## Which coins can be a base

Pick a supported base: STRATEGY by default, USDG always. Other coins work once they have an on-chain USDG price pool.

| Base | Status |
|---|---|
| **STRATEGY** | The default. Used when you don't pick one. |
| **USDG** | Always available. Priced at $1. |
| **Any other ERC-20** | Works once the team has registered an on-chain base/USDG price pool for it. Without one, the launch reverts. |

[CONFIRM: FLOW — how a creator requests a new base, and whether the /create picker lists only registered bases.]

## How the dollar price is set

Rocket targets are in dollars ($3,333 at the start, $33,333 when the rocket reaches orbit). Your base may not be a dollar coin, so DISCIPLE converts once, at launch:

- It reads the base's USD price from its registered base/USDG pool, using a time-weighted average so a single-block price spike can't skew it. [CONFIRM: FLOW — the TWAP pricer is fixed in source (PR #44); confirm it's live on the current testnet deploy.]
- That price is fixed into your rocket's curve. The curve then works in base units.

So if your base's dollar price moves after launch, the rocket's price path doesn't change in base terms. Its dollar value moves with the base. Value here is the same number altitude is drawn from.

## The default can change

The default base is set by the team (STRATEGY on Robinhood Chain today). A change only affects new launches.
