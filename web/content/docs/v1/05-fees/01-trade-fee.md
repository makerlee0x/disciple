---
title: Trade fee
slug: /docs/fees
section: Fees and rewards
---
# Trade fee

Every BOOST and DUMP pays a 1% fee. That one fee is split four ways: 33% to the rocket's creator, 33% to the rocket's locked liquidity, 33% to the DISCIPLE treasury, and 1% to referrals. After a rocket reaches orbit, the Uniswap pool adds no extra fee of its own, so it's still 1%.

![The 1% trade fee, split: 33% to the creator, 33% to locked liquidity, 33% to the treasury, 1% to referrals.](/illustrations/docs/fee-split.svg)

## The split

| Share of the 1% fee | Goes to | How |
|---|---|---|
| **33%** | The creator | Builds up for the creator on every trade. See [Creator earnings](/docs/fees/creators). |
| **33%** | Locked liquidity | Set aside on every trade and added to the rocket's locked pool as it builds up. |
| **33%** | Treasury | Goes to the DISCIPLE treasury. |
| **1%** | Referrals | Today this goes to the community rewards wallet. Referral earnings are worked out from it and paid by hand. See [Referrals](/docs/fees/referrals). |

Percentages are shares of the 1% fee, not of your trade.

## Example

A $100 BOOST pays a $1.00 fee:

| | |
|---|---|
| Creator | $0.33 |
| Locked liquidity | $0.33 |
| Treasury | $0.33 |
| Referrals | $0.01 |

## Everything you might pay

| Fee | When | Size | Goes to |
|---|---|---|---|
| Trade fee | Every BOOST and DUMP, before and after orbit | 1% | The split above |
| Creator tax | BOOSTs and DUMPs before orbit only | 0–7%, set at launch | The creator |
| Sniper tax | BOOSTs in a rocket's first 7 seconds (not the creator's First BOOST) | 99% at launch, 25% at 1 second, 3% at 2 seconds, nothing from 7 seconds | Locked liquidity when the rocket reaches orbit, or the community rewards wallet if it hasn't after 30 days |
| Crew tip | A DUMP on an Easy rocket, before orbit, at a profit above 0.5% of the rocket's value | 0.777% of what you get | The other holders |
| Keeper tip | Closing a filled tramp or wall | 0.1% (up to 1%) | Whoever closes it |
| Network fee | Withdrawals and claims | Shown in dollars before you confirm | The network |

Trades have no separate gas cost. The network cost of a BOOST or DUMP is covered by the 1% trade fee.

## Which coin fees are paid in

While the rocket is on its starting price path, fees are paid in the base coin. After the rocket reaches orbit, a fee can sometimes be paid in the rocket itself, and it's counted at its value in the base coin.
