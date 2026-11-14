---
title: Pairing and base coins
slug: /docs/launch/pairing
section: Launching
---
# Pairing and base coins

Every rocket has a **base**: the coin it's paired with.

## What pairing means

Your rocket is priced and traded in its base coin.

- **BOOST** a rocket and you pay in dollars (USDG). The trade swaps your dollars into the base for you, then buys the rocket.
- **DUMP** it and the same happens in reverse: you get dollars back.
- **When the rocket reaches orbit**, the base is locked forever in the Uniswap v4 LP, alongside the rocket. Reaching orbit means the starting price path is finished and the rocket moves to the open market on Uniswap.

That's the whole relationship. A rocket follows its base on the chart because it's priced in it. DISCIPLE makes no other claim about what a rocket does for its base.

## Which coins can be a base

The launch form offers 12 pair coins: STRATEGY, AI, SCHIFFY, BONER, MEME, MOO, PONS, ORBIO, HOOKR, CASHCAT, PRIORS and SPACEHOOD. **STRATEGY** is picked for you. Pick another under **More options** on the launch form.

Every pair coin needs a registered dollar price, which the team sets up before a coin joins the list.

## How the dollar price is set

Rocket targets are in dollars ($3,333 at the start, $33,333 when the rocket reaches orbit). Your base may not be a dollar coin, so DISCIPLE converts once, at launch:

- It reads the base's dollar price from a trading pool of that coin and USDG. It uses an average over a short time, so one sudden price spike can't skew it. The average runs over 30 minutes.
- That price is fixed into your rocket at launch. From then on, the rocket's starting price path is counted in the base coin.

So if your base's dollar price moves after launch, the rocket's price path doesn't change in base terms, but its dollar value moves with the base. Altitude is drawn from that dollar value.

## The default can change

The default base is set by the team (STRATEGY on Robinhood Chain today). A change only affects new launches.
