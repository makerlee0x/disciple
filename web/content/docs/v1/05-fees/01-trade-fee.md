---
title: Trade fee
slug: /docs/fees
section: Fees and rewards
---
# Trade fee

Every BOOST and DUMP pays a 1% fee: 33% creator, 33% locked liquidity (added to the locked position as it builds up), 33% treasury, 1% referrer. After the rocket reaches orbit, the Uniswap pool charges no extra fee on top of that. Reaching orbit means the starting price path is finished and the rocket moves to the open market on Uniswap.

## The split

| Share of the 1% fee | Goes to | How |
|---|---|---|
| **33%** | Creator | Builds up on-chain. Claim anytime from the FeeRouter. Claiming from the app is coming soon. |
| **33%** | Locked liquidity | Set aside on every trade. Added to the locked position as it builds up. |
| **33%** | Treasury | Credited to the DISCIPLE treasury on every trade, then claimed. |
| **1%** | Referrer | Goes to the launcher's referrer first, if the launcher has one. Otherwise the trader's referrer. With no referrer, the treasury. |

Percentages are shares of the 1% fee, not of your trade.

On testnet, referrals don't lock yet, so the referrer share goes to the treasury for now. See [Referrals](/docs/fees/referrals).

## Example

A $100 BOOST pays a $1.00 fee:

| | |
|---|---|
| Creator | $0.33 |
| Locked liquidity | $0.33 |
| Treasury | $0.33 |
| Referrer | $0.01 |

## Everything you might pay

| Fee | When | Size | Goes to |
|---|---|---|---|
| Trade fee | Every BOOST and DUMP, both phases | 1% | Split above |
| Creator tax | BOOSTs and DUMPs on the curve only | 0–7%, set at launch | Creator |
| Sniper tax | BOOSTs in the first 7 seconds (First BOOST exempt) | 99% at launch, 25% at 1s, 3% at 2s, 0 from 7s | Locked liquidity when the rocket reaches orbit; the rewards vault if it has not reached orbit in 30 days |
| Profit tax (PvE, coming) | DUMPs above 1.77× your average cost | 0.777% of proceeds | Other holders |
| Keeper tip | Closing a filled tramp or wall | 0.1% (max 1%) | Whoever closes it |
| Gas | Every transaction | Network | Robinhood Chain |

After the rocket reaches orbit, the Uniswap pool charges no extra fee of its own. The 1% fee is the only trading fee.

## Which coin fees are paid in

While the rocket is on its starting price path, fees are paid in the base coin. After the rocket reaches orbit, a fee can be paid in the rocket itself on some BOOSTs, and that fee is valued in the base coin. [CONFIRM: FLOW — how token-side fees are held and claimed for creators and the treasury.]
