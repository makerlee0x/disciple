---
title: Fees
slug: /docs/fees
section: Fees and safety
---
# Fees

## The 1% trade fee

Every BOOST and DUMP on a rocket pays 1%, before and after orbit. The split is fixed in the contracts and can't be changed.

On a $100 BOOST:

```tree
$1.00 fee | On a $100 trade · $99 buys coins | gold
Creator | $0.33 | gold
Locked LP | $0.33 | easy
Treasury | $0.33 | white
Community rewards | $0.01 | pink
```

```split
33 | Creator | 0.33% | gold
33 | Locked LP | 0.33% | easy
33 | Treasury | 0.33% | white
1 | Community rewards | 0.01% | pink
```

- **Creator:** builds up for the creator, or goes to the locked pool or a burn if they picked that. See [Creator fees](/docs/launch/creator-fees).
- **Locked LP:** after orbit it's added to the locked pool. On the curve the rocket holds it: into the LP at orbit if orbit lands within 12 days, otherwise to community rewards.
- After orbit the fee sits in the pool's hook until anyone triggers the payout. It can only ever go to these four.

## Everything you can pay

| Fee | When | Size |
|---|---|---|
| Trade fee | Every rocket trade | 1% |
| Creator tax | Rocket trades on the curve, if set | 0–7% |
| Sniper tax | BOOSTs in a rocket's first 7s | 99% → 0% |
| Crew tip | Easy, winning sell over 0.5% of mcap | 3.3% (fixed per rocket at launch) |
| Network fee | Trades, launches, cash outs, claims, Market buys | In USDG, shown in $ first |
| Card or Apple Pay | Add cash by card | The card provider's fee, shown first |
| Turbo | Every Turbo order | 1.1 bp round trip |
| Relay | Cash ⇄ Turbo cash | About 4¢ on $10 |
| Market | Skin sales | 7% |

No launch fee. No ETH, ever.

## Community rewards

A Safe that gets the 0.01% slice of every trade, plus the sniper tax and the curve LP share from rockets that don't reach orbit within 12 days. Payouts are made by the Team, and every payout is a public transfer.
