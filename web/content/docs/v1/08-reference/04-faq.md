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

**Is it live?**
DISCIPLE runs on Robinhood Chain Testnet today, with test tokens. Mainnet isn't live yet, and there's no date.

**What do I need to start?**
Sign in with X, email or a wallet. Then get test funds and a little test ETH for gas. See [Quick start](/docs/quick-start).

## Pairing

**What coins can I pair with?**
Pick a supported base: STRATEGY by default, USDG always. Other coins work once they have an on-chain USDG price pool.

**What does pairing do for my coin?**
Your rocket is priced and traded in its base. At graduation, the base is locked permanently in the rocket's Uniswap v4 LP.

## Curve and graduation

**When does a rocket graduate?**
At a $33,333 market cap, when 72% of supply has sold on the bonding curve. It moves to Uniswap v4 in the same transaction.

**Is the liquidity really locked?**
Yes. At graduation, the liquidity is locked forever in a full-range Uniswap v4 position owned by the LockedLP contract, which has no function to remove it. Contracts are non-upgradeable; admin controls are held by the team during testnet.

**Can a creator rug?**
There's no further mint, the name and call sign are locked at launch, and graduated liquidity has no withdraw function. Creators can still sell their own coins, like anyone else. [CONFIRM: lee — keep this question?]

## Fees

**What are the fees?**
1% on every BOOST and DUMP: 33% creator, 33% locked liquidity, 33% treasury, 1% referrer. Creators can add a 0–7% tax on bonding-curve trades, set at launch. An anti-snipe fee applies only in the first 7 seconds. See [Trade fee](/docs/fees).

**Why did my first-second BOOST cost so much?**
The anti-snipe fee. It starts at 77.7% at launch and reaches 0% after 7 seconds. See [Anti-snipe](/docs/trading/anti-snipe).

**How do referrals work?**
When a wallet opens your link and deposits $10+ in USDG, it's yours for life. You earn 1% of the protocol fee on its trades, plus 2% of the creator's share on rockets it launches. On testnet, referrals don't lock yet. See [Referrals](/docs/fees/referrals).

## Game

**What's a bomb?**
Every DUMP drops one. Its size is set by price impact, from PUFF (under 2%) to ATOM (50%+). See [Bombs](/docs/trading/bombs).

**Do upgrades or tiers change my trades?**
No. Rocket upgrades, tiers, bombs and points are cosmetic or display only. They never change price, fills or odds.

**What is the Simulator?**
Free paper trading against bots on a private market, with no wallet and no transactions. Pick PvE, PvP or Trench Warfare. Open it at `/flight/sim`. See [Simulator](/docs/game/simulator).

## Safety

**Is DISCIPLE audited?**
Not yet. The contracts have had internal security reviews only, no third-party audit. A professional audit is required before mainnet.

**Can the team pause trading?**
No. There's no pause. Curves and graduated pools are always live.

**What can the team change?**
Some settings for new launches, fee routing addresses and router limits. See [Admin controls](/docs/safety/admin).
