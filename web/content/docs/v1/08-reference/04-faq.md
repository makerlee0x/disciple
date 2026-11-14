---
title: FAQ
slug: /docs/faq
section: Reference
---
# FAQ

## The basics

**What is DISCIPLE?**
A launchpad and a rocket game on Robinhood Chain. Every coin is a rocket, paired with a base coin you believe in. BOOST to buy, DUMP to sell. See [What is DISCIPLE](/docs).

**What's a rocket?**
A coin launched on DISCIPLE. 1M fixed supply, priced and traded in its base.

**What does BOOST mean? DUMP?**
BOOST is buy. DUMP is sell.

**What do I need to start?**
Sign in with email, Google, X or a wallet. Then add cash from the cash button at the top. You don't need ETH for gas. See [Quick start](/docs/quick-start).

## Pairing

**What coins can I pair with?**
Any of the 12 on the launch form: STRATEGY, AI, SCHIFFY, BONER, MEME, MOO, PONS, ORBIO, HOOKR, CASHCAT, PRIORS and SPACEHOOD. STRATEGY is the default. See [Pairing](/docs/launch/pairing).

**What does pairing do for my coin?**
Your rocket is priced and traded in its base coin. When the rocket reaches orbit, the base is locked forever in the Uniswap v4 LP. Reaching orbit means the starting price path is finished and the rocket moves to the open market on Uniswap.

## Reaching orbit

**When does a rocket reach orbit?**
When its value reaches $33,333 and about 84% of it has been bought on the starting price path. People also call that path a bonding curve, which means each buy costs a little more than the last. The rocket moves to the open market on Uniswap in that same trade. That moment is the Outer Space tier.

**Is the liquidity really locked?**
Yes. When the rocket reaches orbit, its liquidity is locked forever in the Uniswap v4 LP. The contract that holds it has no way to remove it, and the contracts can't be swapped for new code. The team holds some admin settings. See [Admin controls](/docs/safety/admin).

**Can a creator rug?**
There's no further mint, the name and call sign are locked at launch, and once the rocket reaches orbit its liquidity is locked forever in the Uniswap v4 LP. Creators can still sell their own rockets, like anyone else.

## Fees

**What are the fees?**
1% on every BOOST and DUMP: 33% to the creator, 33% to locked liquidity, 33% to the treasury, and the remaining 1% is a separate share. Creators can add a 0–7% tax on trades before orbit, set at launch. A sniper tax applies only in a rocket's first 7 seconds. There's no separate gas to pay on trades. See [Trade fee](/docs/fees).

**Why did my first-second BOOST cost so much?**
The sniper tax. It's 99% at launch, 25% at 1 second, 3% at 2 seconds, and nothing from 7 seconds on. See [Anti-snipe](/docs/trading/anti-snipe).

## Game

**What's a bomb?**
Every DUMP drops one. Its size is set by price impact, from PUFF (under 2%) to ATOM (50%+). See [Bombs](/docs/trading/bombs).

**Do upgrades or tiers change my trades?**
No. Rocket looks, tiers, bombs and XP are cosmetic or display only. A tier is a named step for how high a rocket's value has climbed. They never change the price, the trade, or the odds.

**What is Free play?**
It's the game with practice cash, flown against bots. You don't need a wallet, and nothing is sent onchain. Fly the daily flight or practice on Easy, Hard or Expert. Open it at `/flight/sim`. See [Free play](/docs/game/simulator).

## Safety

**Is DISCIPLE audited?**
Not yet. The contracts have had internal security reviews only, no third-party audit. A professional audit is required before mainnet.

**Can the team pause trading?**
No. There's no pause. The starting price path and the open market on Uniswap are always live.

**What can the team change?**
Some settings for new launches, fee routing addresses and router limits. See [Admin controls](/docs/safety/admin).
